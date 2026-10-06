// Docket server: HTTP API, auth, static files, real-time sync and reminder scheduling.
// Zero third-party runtime dependencies (Node.js >= 22.13 with built-in node:sqlite).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createPushService } from './push.js';
import { createMailer, mailerConfigFromEnv } from './mailer.js';
import { createReminderService, publicNotification } from './reminders.js';
import { activitiesToIcs, parseIcs } from './ics.js';
import { normalizeActivity, normalizeCategory, normalizeSettings, DEFAULT_SETTINGS, DEFAULT_CATEGORIES, EMAIL_RE, isId, newId } from '../shared/model.js';
import { addDays, todayStr, dayOfWeek } from '../shared/time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const MAX_USER_STORAGE = 200 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

// ---------- password hashing (scrypt) ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [, N, r, p, salt, hash] = stored.split('$');
    const expected = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(expected, got);
  } catch { return false; }
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- real-time hub (Server-Sent Events) ----------
function createHub() {
  const conns = new Map();
  const hb = setInterval(() => { for (const set of conns.values()) for (const c of set) c.res.write(': ping\n\n'); }, 25000);
  return {
    add(userId, res, sessionHash) {
      if (!conns.has(userId)) conns.set(userId, new Set());
      const c = { res, sessionHash }; conns.get(userId).add(c);
      return () => { const s = conns.get(userId); if (s) { s.delete(c); if (!s.size) conns.delete(userId); } };
    },
    send(userId, event) {
      const set = conns.get(userId); if (!set) return;
      const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const c of set) c.res.write(payload);
    },
    endSessions(userId, exceptHash) {
      const set = conns.get(userId); if (!set) return;
      for (const c of set) if (c.sessionHash !== exceptHash) { c.res.write(`event: session.ended\ndata: {"type":"session.ended"}\n\n`); c.res.end(); }
    },
    count: () => [...conns.values()].reduce((n, s) => n + s.size, 0),
    close() { clearInterval(hb); for (const set of conns.values()) for (const c of set) c.res.end(); conns.clear(); },
  };
}

// ---------- small rate limiter ----------
function rateLimiter(limit, windowMs) {
  const m = new Map();
  return (key) => {
    const now = Date.now(); let e = m.get(key);
    if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; m.set(key, e); }
    e.n++; if (m.size > 10000) m.clear();
    return e.n <= limit;
  };
}

export function createApp({ dataDir = path.join(__dirname, '..', 'data'), env = process.env, tickMs = 10000, log = console } = {}) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const db = openDb(path.join(dataDir, 'docket.db'));
  const hub = createHub();
  const baseUrl = (env.BASE_URL || '').replace(/\/$/, '');
  const push = createPushService({ db, subject: env.VAPID_SUBJECT || (env.SMTP_FROM && EMAIL_RE.test(env.SMTP_FROM) ? `mailto:${env.SMTP_FROM}` : (baseUrl || 'mailto:admin@example.com')) });
  const mailer = createMailer(mailerConfigFromEnv(env));
  const allowRegistration = env.ALLOW_REGISTRATION !== 'false';
  const trustProxy = env.TRUST_PROXY === 'true';

  const settingsCache = new Map();
  function getSettings(userId) {
    if (settingsCache.has(userId)) return settingsCache.get(userId);
    const row = db.prepare('SELECT settings FROM users WHERE id=?').get(userId);
    const s = normalizeSettings(row ? JSON.parse(row.settings) : {}).value;
    settingsCache.set(userId, s); return s;
  }
  const reminders = createReminderService({ db, hub, push, mailer, getSettings, log, baseUrl });

  // ---------- helpers ----------
  const json = (res, status, obj, headers = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'too_large', `Request is too large (limit ${Math.round(limit / 1048576)} MB)`)); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function readJson(req, limit = 1024 * 1024) {
    const buf = await readBody(req, limit);
    if (!buf.length) return {};
    try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'bad_json', 'Request body is not valid JSON'); }
  }
  const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((x) => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const isHttps = (req) => (trustProxy && req.headers['x-forwarded-proto'] === 'https') || !!req.socket.encrypted || baseUrl.startsWith('https://');
  const clientIp = (req) => (trustProxy && req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress) || '?';
  const cookieFor = (req, token, maxAge) => `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}${isHttps(req) ? '; Secure' : ''}`;

  function createSession(req, userId) {
    const token = crypto.randomBytes(32).toString('base64url'); const now = Date.now();
    db.prepare('INSERT INTO sessions (token_hash,user_id,created_at,last_seen,expires_at,user_agent) VALUES (?,?,?,?,?,?)')
      .run(sha256(token), userId, now, now, now + SESSION_TTL, String(req.headers['user-agent'] || '').slice(0, 200));
    return token;
  }
  function authenticate(req) {
    const token = parseCookies(req.headers.cookie).sid; if (!token) return null;
    const h = sha256(token);
    const row = db.prepare('SELECT s.token_hash, s.user_id, s.expires_at, s.last_seen, u.email, u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(h);
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at < now) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(h); return null; }
    if (now - row.last_seen > 10 * 60000) db.prepare('UPDATE sessions SET last_seen=?, expires_at=? WHERE token_hash=?').run(now, now + SESSION_TTL, h);
    return { id: row.user_id, email: row.email, name: row.name, sessionHash: h };
  }

  const attachmentsFor = (activityId) => db.prepare('SELECT id, filename, mime, size, created_at FROM attachments WHERE activity_id=? ORDER BY created_at').all(activityId);
  function activityOut(row) {
    const a = JSON.parse(row.data);
    return { ...a, version: row.version, created_at: row.created_at, updated_at: row.updated_at, is_sample: !!row.is_sample, attachments: attachmentsFor(row.id) };
  }
  const getActivityRow = (userId, id) => db.prepare('SELECT * FROM activities WHERE id=? AND user_id=?').get(id, userId);
  const catOut = (r) => ({ id: r.id, name: r.name, color: r.color, sort: r.sort, version: r.version, updated_at: r.updated_at });
  const userCategories = (userId) => db.prepare('SELECT * FROM categories WHERE user_id=? ORDER BY sort, created_at').all(userId).map(catOut);

  function validationError(errors) {
    const first = Object.values(errors)[0];
    return new HttpError(422, 'validation', first || 'Some fields are invalid', { fields: errors });
  }

  function insertActivity(userId, input, { isSample = false } = {}) {
    const settings = getSettings(userId);
    const { value, errors } = normalizeActivity(input, { defaultTimezone: settings.timezone });
    if (Object.keys(errors).length) throw validationError(errors);
    if (value.category_id && !db.prepare('SELECT 1 FROM categories WHERE id=? AND user_id=?').get(value.category_id, userId)) value.category_id = null;
    const now = Date.now();
    db.prepare('INSERT INTO activities (id,user_id,data,version,is_sample,ics_uid,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(value.id, userId, JSON.stringify(value), 1, isSample ? 1 : 0, value.ics_uid || null, now, now);
    reminders.syncActivity(userId, value);
    return activityOut(getActivityRow(userId, value.id));
  }

  function broadcastActivity(userId, a, origin) { hub.send(userId, { type: 'activity.upserted', data: a, origin }); }

  function createDefaultCategories(userId) {
    const now = Date.now();
    DEFAULT_CATEGORIES.forEach((c, i) => db.prepare('INSERT INTO categories (id,user_id,name,color,sort,version,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)').run(newId('c'), userId, c.name, c.color, i, now, now));
  }

  function categoryIdByName(userId, name) {
    const r = db.prepare('SELECT id FROM categories WHERE user_id=? AND name=? COLLATE NOCASE').get(userId, name); return r ? r.id : null;
  }

  function sampleActivities(userId) {
    const s = getSettings(userId); const tz = s.timezone; const today = todayStr(tz);
    const cat = (n) => categoryIdByName(userId, n);
    const fri = addDays(today, ((5 - dayOfWeek(today)) + 7) % 7 || 7);
    const base = { timezone: tz, reminders: s.defaultReminders.map((m) => ({ minutes: m })), links: [], checklist: [], organizer: {} };
    return [
      { ...base, title: 'Frontend Developer interview (sample)', category_id: cat('Job Interviews'), priority: 'high', status: 'confirmed', start_date: addDays(today, 1), start_time: '11:00', end_time: '12:00', meeting_url: 'https://meet.example.com/sample-interview', organizer: { name: 'HR team (sample)', email: 'hr@example.com' }, description: 'Technical round with the engineering team.', checklist: [{ id: newId('t'), text: 'Research the company and role', done: false, due_date: today, due_time: '20:00', remind_minutes: 60 }, { id: newId('t'), text: 'Prepare two portfolio projects to discuss', done: false }] },
      { ...base, title: 'Project team sync (sample — overlaps the interview)', category_id: cat('College Programs'), priority: 'medium', status: 'tentative', start_date: addDays(today, 1), start_time: '11:30', end_time: '12:30', location: 'Room 204' },
      { ...base, title: 'IT club weekly meeting (sample)', category_id: cat('Club Meetings'), priority: 'medium', status: 'confirmed', start_date: fri, start_time: '16:00', end_time: '17:00', location: 'Seminar hall', recurrence: { freq: 'weekly', interval: 1, byweekday: [5] }, reminders: [{ minutes: 60 }] },
      { ...base, kind: 'deadline', title: 'Scholarship application (sample)', category_id: cat('Deadlines'), priority: 'high', status: 'confirmed', start_date: addDays(today, 5), start_time: '17:00', reminders: [{ minutes: 2880 }, { minutes: 1440 }, { minutes: 120 }], checklist: [{ id: newId('t'), text: 'Get recommendation letter', done: false, due_date: addDays(today, 3) , remind_minutes: 0 }, { id: newId('t'), text: 'Upload transcript', done: true }] },
      { ...base, title: 'Dentist appointment (sample)', category_id: cat('Personal Appointments'), priority: 'medium', status: 'confirmed', start_date: addDays(today, 3), start_time: '15:30', end_time: '16:00', location: 'City Dental Clinic' },
      { ...base, title: 'Tree plantation drive (sample)', category_id: cat('Volunteer Activities'), priority: 'low', status: 'tentative', start_date: addDays(today, 8), start_time: '07:00', end_time: '11:00', location: 'Community park' },
      { ...base, title: 'College orientation program (sample)', category_id: cat('College Programs'), priority: 'medium', status: 'confirmed', start_date: addDays(today, 10), all_day: true, reminders: [{ minutes: 1440 }] },
      { ...base, title: 'Interview with a second company (sample)', category_id: cat('Job Interviews'), priority: 'high', status: 'tentative', schedule: 'tbd', tbd_note: 'Recruiter said they will confirm the date next week.', follow_up_date: addDays(today, 3) },
    ].map((a) => ({ ...a, id: newId('a') }));
  }

  // ---------- routing ----------
  const routes = [];
  const route = (method, p, handler, opts = {}) => {
    const keys = []; const re = new RegExp('^' + p.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false });
  };
  const loginLimiter = rateLimiter(20, 15 * 60000);
  const registerLimiter = rateLimiter(10, 60 * 60000);

  // ----- auth -----
  route('POST', '/api/auth/register', async (req, res) => {
    if (!allowRegistration) throw new HttpError(403, 'registration_closed', 'Registration is disabled on this server');
    if (!registerLimiter(clientIp(req))) throw new HttpError(429, 'rate_limited', 'Too many sign-up attempts. Try again later.');
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase(); const password = String(b.password || ''); const name = String(b.name || '').trim().slice(0, 80);
    const fields = {};
    if (!EMAIL_RE.test(email)) fields.email = 'Enter a valid email address';
    if (password.length < 8) fields.password = 'Use at least 8 characters';
    if (password.length > 200) fields.password = 'Password is too long';
    if (Object.keys(fields).length) throw validationError(fields);
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'email_taken', 'An account with this email already exists. Sign in instead.', { fields: { email: 'An account with this email already exists' } });
    const id = newId('u'); const now = Date.now();
    const settings = { ...DEFAULT_SETTINGS, emailAddress: email };
    db.tx(() => {
      db.prepare('INSERT INTO users (id,email,name,password_hash,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, email, name, hashPassword(password), JSON.stringify(settings), now, now);
      createDefaultCategories(id);
    });
    const token = createSession(req, id);
    json(res, 201, { ok: true }, { 'Set-Cookie': cookieFor(req, token, SESSION_TTL) });
  }, { auth: false });

  route('POST', '/api/auth/login', async (req, res) => {
    if (!loginLimiter(clientIp(req))) throw new HttpError(429, 'rate_limited', 'Too many sign-in attempts. Wait a few minutes and try again.');
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase();
    const u = db.prepare('SELECT id, password_hash FROM users WHERE email=?').get(email);
    if (!u || !verifyPassword(String(b.password || ''), u.password_hash)) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
    const token = createSession(req, u.id);
    json(res, 200, { ok: true }, { 'Set-Cookie': cookieFor(req, token, SESSION_TTL) });
  }, { auth: false });

  route('POST', '/api/auth/logout', async (req, res, { user }) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.sessionHash);
    json(res, 200, { ok: true }, { 'Set-Cookie': cookieFor(req, '', 0) });
  });
  route('POST', '/api/auth/logout-others', async (req, res, { user }) => {
    const r = db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(user.id, user.sessionHash);
    hub.endSessions(user.id, user.sessionHash);
    json(res, 200, { ok: true, ended: r.changes });
  });

  // ----- bootstrap / status -----
  function statusInfo(userId) {
    return {
      email: { configured: mailer.configured, detail: mailer.describe() },
      push: { configured: true, publicKey: push.publicKey, keySource: push.source, devices: db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?').get(userId).n },
      integrations: [
        { id: 'ics-feed', name: 'Calendar subscription (ICS feed)', status: 'available', detail: 'Subscribe from Google Calendar, Apple Calendar or Outlook using your private feed URL (read-only, refreshed by those apps on their own schedule).' },
        { id: 'google', name: 'Google Calendar two-way sync', status: 'not-included', detail: 'Not implemented. Requires a Google Cloud OAuth client and verified consent screen; use the ICS feed or .ics export/import instead.' },
        { id: 'outlook', name: 'Microsoft Outlook two-way sync', status: 'not-included', detail: 'Not implemented. Requires an Azure app registration; use the ICS feed or .ics export/import instead.' },
      ],
      registrationOpen: allowRegistration,
    };
  }
  route('GET', '/api/bootstrap', async (req, res, { user }) => {
    const u = db.prepare('SELECT id,email,name,settings_version,ics_token,created_at FROM users WHERE id=?').get(user.id);
    const activities = db.prepare('SELECT * FROM activities WHERE user_id=? ORDER BY created_at').all(user.id).map(activityOut);
    const notifications = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(user.id).map(publicNotification);
    json(res, 200, {
      user: { id: u.id, email: u.email, name: u.name, created_at: u.created_at, hasIcsToken: !!u.ics_token },
      settings: getSettings(user.id), settingsVersion: u.settings_version,
      categories: userCategories(user.id), activities, notifications,
      status: statusInfo(user.id), serverTime: Date.now(),
    });
  });
  route('GET', '/api/status', async (req, res, { user }) => json(res, 200, statusInfo(user.id)));
  route('GET', '/api/health', async (req, res) => json(res, 200, { ok: true, time: Date.now() }), { auth: false });

  // ----- activities -----
  route('POST', '/api/activities', async (req, res, { user, origin }) => {
    const b = await readJson(req);
    if (!isId(b.id)) throw new HttpError(400, 'bad_id', 'Missing or invalid activity id');
    const existing = db.prepare('SELECT * FROM activities WHERE id=?').get(b.id);
    if (existing) {
      if (existing.user_id !== user.id) throw new HttpError(409, 'id_conflict', 'Activity id already in use');
      return json(res, 200, { activity: activityOut(existing), duplicate: true }); // idempotent retry
    }
    const a = insertActivity(user.id, b);
    broadcastActivity(user.id, a, origin);
    json(res, 201, { activity: a });
  });

  route('PUT', '/api/activities/:id', async (req, res, { user, params, origin }) => {
    const b = await readJson(req);
    const row = getActivityRow(user.id, params.id);
    if (!row) throw new HttpError(404, 'not_found', 'This activity no longer exists (it may have been deleted on another device)');
    if (b.version !== undefined && Number(b.version) !== row.version) {
      throw new HttpError(409, 'version_conflict', 'This activity was changed on another tab or device since you started editing', { current: activityOut(row) });
    }
    const settings = getSettings(user.id);
    const { value, errors } = normalizeActivity({ ...b, id: params.id }, { defaultTimezone: settings.timezone });
    if (Object.keys(errors).length) throw validationError(errors);
    if (value.category_id && !db.prepare('SELECT 1 FROM categories WHERE id=? AND user_id=?').get(value.category_id, user.id)) value.category_id = null;
    const old = JSON.parse(row.data);
    if (old.ics_uid && !value.ics_uid) value.ics_uid = old.ics_uid;
    const now = Date.now();
    const r = db.prepare('UPDATE activities SET data=?, version=version+1, updated_at=?, ics_uid=? WHERE id=? AND user_id=? AND version=?')
      .run(JSON.stringify(value), now, value.ics_uid || null, params.id, user.id, row.version);
    if (r.changes !== 1) throw new HttpError(409, 'version_conflict', 'This activity was changed elsewhere', { current: activityOut(getActivityRow(user.id, params.id)) });
    reminders.syncActivity(user.id, value);
    const a = activityOut(getActivityRow(user.id, params.id));
    broadcastActivity(user.id, a, origin);
    json(res, 200, { activity: a });
  });

  route('DELETE', '/api/activities/:id', async (req, res, { user, params, origin }) => {
    const row = getActivityRow(user.id, params.id);
    if (!row) return json(res, 200, { ok: true, alreadyDeleted: true });
    const files = db.prepare('SELECT stored_name FROM attachments WHERE activity_id=?').all(params.id);
    db.prepare('DELETE FROM activities WHERE id=? AND user_id=?').run(params.id, user.id); // cascades reminder jobs + attachments rows
    for (const f of files) fs.rm(path.join(dataDir, 'uploads', user.id, f.stored_name), { force: true }, () => {});
    hub.send(user.id, { type: 'activity.deleted', data: { id: params.id }, origin });
    json(res, 200, { ok: true });
  });

  route('GET', '/api/activities/:id/reminders', async (req, res, { user, params }) => {
    if (!getActivityRow(user.id, params.id)) throw new HttpError(404, 'not_found', 'Activity not found');
    json(res, 200, { jobs: reminders.upcomingJobs(user.id, params.id) });
  });
  route('GET', '/api/reminders/upcoming', async (req, res, { user }) => json(res, 200, { jobs: reminders.upcomingJobs(user.id) }));
  // Used by the Android app to schedule exact local alarms (works offline once synced).
  route('GET', '/api/device/reminders', async (req, res, { user }) => {
    // recentlySent lets a device that fires an alarm at the exact second confirm it is still valid
    // even if the server's own scheduler already processed that reminder a moment earlier.
    const recentlySent = db.prepare("SELECT dedupe_key FROM reminder_jobs WHERE user_id=? AND status='sent' AND fire_at > ?").all(user.id, Date.now() - 30 * 60000).map((r) => r.dedupe_key);
    json(res, 200, { serverTime: Date.now(), timezone: getSettings(user.id).timezone, reminders: reminders.deviceSchedule(user.id), recentlySent });
  });

  // ----- attachments -----
  route('POST', '/api/activities/:id/attachments', async (req, res, { user, params, origin }) => {
    if (!getActivityRow(user.id, params.id)) throw new HttpError(404, 'not_found', 'Activity not found');
    const used = db.prepare('SELECT COALESCE(SUM(size),0) s FROM attachments WHERE user_id=?').get(user.id).s;
    const buf = await readBody(req, MAX_ATTACHMENT);
    if (!buf.length) throw new HttpError(400, 'empty', 'The file is empty');
    if (used + buf.length > MAX_USER_STORAGE) throw new HttpError(413, 'quota', 'Attachment storage limit (200 MB) reached');
    let filename = 'file';
    try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'file')); } catch {}
    filename = filename.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200) || 'file';
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(req.headers['content-type'] || '') ? req.headers['content-type'] : 'application/octet-stream';
    const id = newId('f'); const stored = `${id}.bin`;
    fs.mkdirSync(path.join(dataDir, 'uploads', user.id), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'uploads', user.id, stored), buf);
    db.prepare('INSERT INTO attachments (id,user_id,activity_id,filename,mime,size,stored_name,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, user.id, params.id, filename, mime, buf.length, stored, Date.now());
    const a = activityOut(getActivityRow(user.id, params.id));
    broadcastActivity(user.id, a, origin);
    json(res, 201, { activity: a });
  });
  route('GET', '/api/attachments/:id', async (req, res, { user, params }) => {
    const f = db.prepare('SELECT * FROM attachments WHERE id=? AND user_id=?').get(params.id, user.id);
    if (!f) throw new HttpError(404, 'not_found', 'File not found');
    const p = path.join(dataDir, 'uploads', user.id, f.stored_name);
    if (!fs.existsSync(p)) throw new HttpError(404, 'not_found', 'File is missing on the server');
    res.writeHead(200, {
      'Content-Type': f.mime, 'Content-Length': f.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="${f.filename.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    fs.createReadStream(p).pipe(res);
  });
  route('DELETE', '/api/attachments/:id', async (req, res, { user, params, origin }) => {
    const f = db.prepare('SELECT * FROM attachments WHERE id=? AND user_id=?').get(params.id, user.id);
    if (!f) return json(res, 200, { ok: true });
    db.prepare('DELETE FROM attachments WHERE id=?').run(f.id);
    fs.rm(path.join(dataDir, 'uploads', user.id, f.stored_name), { force: true }, () => {});
    const row = getActivityRow(user.id, f.activity_id);
    if (row) { const a = activityOut(row); broadcastActivity(user.id, a, origin); return json(res, 200, { activity: a }); }
    json(res, 200, { ok: true });
  });

  // ----- categories -----
  route('POST', '/api/categories', async (req, res, { user, origin }) => {
    const b = await readJson(req);
    const { value, errors } = normalizeCategory(b);
    if (Object.keys(errors).length) throw validationError(errors);
    const ex = db.prepare('SELECT * FROM categories WHERE id=?').get(value.id);
    if (ex) { if (ex.user_id !== user.id) throw new HttpError(409, 'id_conflict', 'Id in use'); return json(res, 200, { category: catOut(ex), duplicate: true }); }
    const dupe = db.prepare('SELECT 1 FROM categories WHERE user_id=? AND name=? COLLATE NOCASE').get(user.id, value.name);
    if (dupe) throw validationError({ name: 'A category with this name already exists' });
    const now = Date.now();
    const sort = value.sort || (db.prepare('SELECT COALESCE(MAX(sort),0)+1 m FROM categories WHERE user_id=?').get(user.id).m);
    db.prepare('INSERT INTO categories (id,user_id,name,color,sort,version,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)').run(value.id, user.id, value.name, value.color, sort, now, now);
    const c = catOut(db.prepare('SELECT * FROM categories WHERE id=?').get(value.id));
    hub.send(user.id, { type: 'category.upserted', data: c, origin });
    json(res, 201, { category: c });
  });
  route('PUT', '/api/categories/:id', async (req, res, { user, params, origin }) => {
    const b = await readJson(req);
    const row = db.prepare('SELECT * FROM categories WHERE id=? AND user_id=?').get(params.id, user.id);
    if (!row) throw new HttpError(404, 'not_found', 'Category not found');
    if (b.version !== undefined && +b.version !== row.version) throw new HttpError(409, 'version_conflict', 'This category was changed elsewhere', { current: catOut(row) });
    const { value, errors } = normalizeCategory({ ...b, id: params.id, sort: b.sort ?? row.sort });
    if (Object.keys(errors).length) throw validationError(errors);
    if (db.prepare('SELECT 1 FROM categories WHERE user_id=? AND name=? COLLATE NOCASE AND id!=?').get(user.id, value.name, params.id)) throw validationError({ name: 'A category with this name already exists' });
    db.prepare('UPDATE categories SET name=?, color=?, sort=?, version=version+1, updated_at=? WHERE id=?').run(value.name, value.color, value.sort, Date.now(), params.id);
    const c = catOut(db.prepare('SELECT * FROM categories WHERE id=?').get(params.id));
    hub.send(user.id, { type: 'category.upserted', data: c, origin });
    json(res, 200, { category: c });
  });
  route('DELETE', '/api/categories/:id', async (req, res, { user, params, query, origin }) => {
    const row = db.prepare('SELECT * FROM categories WHERE id=? AND user_id=?').get(params.id, user.id);
    if (!row) return json(res, 200, { ok: true });
    const target = query.get('reassign') && db.prepare('SELECT id FROM categories WHERE id=? AND user_id=?').get(query.get('reassign'), user.id) ? query.get('reassign') : null;
    const changed = [];
    db.tx(() => {
      for (const r of db.prepare('SELECT * FROM activities WHERE user_id=?').all(user.id)) {
        const a = JSON.parse(r.data); if (a.category_id !== params.id) continue;
        a.category_id = target;
        db.prepare('UPDATE activities SET data=?, version=version+1, updated_at=? WHERE id=?').run(JSON.stringify(a), Date.now(), r.id);
        changed.push(r.id);
      }
      db.prepare('DELETE FROM categories WHERE id=?').run(params.id);
    });
    hub.send(user.id, { type: 'category.deleted', data: { id: params.id }, origin });
    for (const id of changed) broadcastActivity(user.id, activityOut(getActivityRow(user.id, id)), null);
    json(res, 200, { ok: true, reassigned: changed.length });
  });

  // ----- settings & account -----
  route('PUT', '/api/settings', async (req, res, { user, origin }) => {
    const b = await readJson(req);
    const cur = getSettings(user.id);
    const { value, errors } = normalizeSettings(b.settings || {}, cur);
    if (Object.keys(errors).length) throw validationError(errors);
    db.prepare('UPDATE users SET settings=?, settings_version=settings_version+1, updated_at=? WHERE id=?').run(JSON.stringify(value), Date.now(), user.id);
    settingsCache.delete(user.id);
    if (cur.timezone !== value.timezone || cur.allDayReminderTime !== value.allDayReminderTime) reminders.syncUser(user.id);
    const ver = db.prepare('SELECT settings_version v FROM users WHERE id=?').get(user.id).v;
    hub.send(user.id, { type: 'settings.updated', data: { settings: value, version: ver }, origin });
    json(res, 200, { settings: value, version: ver });
  });
  route('PUT', '/api/account', async (req, res, { user, origin }) => {
    const b = await readJson(req);
    const name = String(b.name || '').trim().slice(0, 80);
    db.prepare('UPDATE users SET name=?, updated_at=? WHERE id=?').run(name, Date.now(), user.id);
    hub.send(user.id, { type: 'account.updated', data: { name }, origin });
    json(res, 200, { ok: true, name });
  });
  route('POST', '/api/account/password', async (req, res, { user }) => {
    const b = await readJson(req);
    const u = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
    if (!verifyPassword(String(b.current || ''), u.password_hash)) throw validationError({ current: 'Current password is incorrect' });
    if (String(b.next || '').length < 8) throw validationError({ next: 'Use at least 8 characters' });
    db.prepare('UPDATE users SET password_hash=?, updated_at=? WHERE id=?').run(hashPassword(String(b.next)), Date.now(), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(user.id, user.sessionHash);
    hub.endSessions(user.id, user.sessionHash);
    json(res, 200, { ok: true });
  });
  route('POST', '/api/account/delete', async (req, res, { user }) => {
    const b = await readJson(req);
    const u = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
    if (!verifyPassword(String(b.password || ''), u.password_hash)) throw validationError({ password: 'Password is incorrect' });
    hub.endSessions(user.id, null);
    db.prepare('DELETE FROM users WHERE id=?').run(user.id);
    fs.rm(path.join(dataDir, 'uploads', user.id), { recursive: true, force: true }, () => {});
    settingsCache.delete(user.id);
    json(res, 200, { ok: true }, { 'Set-Cookie': cookieFor(req, '', 0) });
  });
  route('GET', '/api/account/sessions', async (req, res, { user }) => {
    const rows = db.prepare('SELECT token_hash, created_at, last_seen, user_agent FROM sessions WHERE user_id=? ORDER BY last_seen DESC').all(user.id);
    json(res, 200, { sessions: rows.map((r) => ({ current: r.token_hash === user.sessionHash, created_at: r.created_at, last_seen: r.last_seen, user_agent: r.user_agent })) });
  });

  // ----- notifications -----
  route('GET', '/api/notifications', async (req, res, { user }) => {
    json(res, 200, { notifications: db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(user.id).map(publicNotification) });
  });
  function updateNotif(user, id, sql, args, origin) {
    const r = db.prepare(`UPDATE notifications SET ${sql} WHERE id=? AND user_id=?`).run(...args, id, user.id);
    if (!r.changes) throw new HttpError(404, 'not_found', 'Notification not found');
    const n = publicNotification(db.prepare('SELECT * FROM notifications WHERE id=?').get(id));
    hub.send(user.id, { type: 'notification.updated', data: n, origin });
    return n;
  }
  route('POST', '/api/notifications/:id/read', async (req, res, { user, params, origin }) => json(res, 200, { notification: updateNotif(user, params.id, 'read_at=COALESCE(read_at, ?)', [Date.now()], origin) }));
  route('POST', '/api/notifications/:id/dismiss', async (req, res, { user, params, origin }) => {
    db.prepare("DELETE FROM reminder_jobs WHERE user_id=? AND source_notification_id=? AND status='pending'").run(user.id, params.id);
    json(res, 200, { notification: updateNotif(user, params.id, 'dismissed_at=?, read_at=COALESCE(read_at, ?), snoozed_until=NULL', [Date.now(), Date.now()], origin) });
  });
  route('POST', '/api/notifications/:id/snooze', async (req, res, { user, params, origin }) => {
    const b = await readJson(req);
    const minutes = Math.round(Number(b.minutes));
    if (!(minutes >= 1 && minutes <= 1440)) throw validationError({ minutes: 'Snooze must be between 1 minute and 24 hours' });
    const until = reminders.snooze(user.id, params.id, minutes);
    if (!until) throw new HttpError(404, 'not_found', 'Notification not found');
    const n = publicNotification(db.prepare('SELECT * FROM notifications WHERE id=?').get(params.id));
    hub.send(user.id, { type: 'notification.updated', data: n, origin });
    json(res, 200, { notification: n });
  });
  route('POST', '/api/notifications/read-all', async (req, res, { user, origin }) => {
    db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(Date.now(), user.id);
    hub.send(user.id, { type: 'notifications.reload', origin });
    json(res, 200, { ok: true });
  });
  route('POST', '/api/notifications/clear', async (req, res, { user, origin }) => {
    db.prepare('DELETE FROM notifications WHERE user_id=? AND (dismissed_at IS NOT NULL OR read_at IS NOT NULL)').run(user.id);
    hub.send(user.id, { type: 'notifications.reload', origin });
    json(res, 200, { ok: true });
  });
  route('POST', '/api/notifications/test', async (req, res, { user }) => json(res, 200, { notification: await reminders.sendTest(user.id) }));

  // ----- push subscriptions -----
  route('POST', '/api/push/subscribe', async (req, res, { user }) => {
    const b = await readJson(req);
    const endpoint = String(b.endpoint || ''); const keys = b.keys || {};
    let ok = false; try { const pr = new URL(endpoint).protocol; ok = pr === 'https:' || (env.DOCKET_ALLOW_HTTP_PUSH === 'true' && pr === 'http:'); } catch {}
    if (!ok || !/^[A-Za-z0-9_-]{40,200}$/.test(keys.p256dh || '') || !/^[A-Za-z0-9_-]{10,60}$/.test(keys.auth || '')) throw new HttpError(400, 'bad_subscription', 'Invalid push subscription');
    db.prepare(`INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,user_agent,created_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent, last_error=NULL`)
      .run(newId('p'), user.id, endpoint, keys.p256dh, keys.auth, String(req.headers['user-agent'] || '').slice(0, 200), Date.now());
    json(res, 200, { ok: true, devices: db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?').get(user.id).n });
  });
  route('POST', '/api/push/unsubscribe', async (req, res, { user }) => {
    const b = await readJson(req);
    db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(user.id, String(b.endpoint || ''));
    json(res, 200, { ok: true, devices: db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?').get(user.id).n });
  });
  route('GET', '/api/push/devices', async (req, res, { user }) => {
    json(res, 200, { devices: db.prepare('SELECT endpoint, user_agent, created_at, last_success_at, last_error, last_error_at FROM push_subscriptions WHERE user_id=?').all(user.id).map((d) => ({ ...d, endpoint: new URL(d.endpoint).host })) });
  });

  // ----- export / import -----
  route('GET', '/api/export', async (req, res, { user }) => {
    const u = db.prepare('SELECT email,name FROM users WHERE id=?').get(user.id);
    const data = {
      format: 'docket-export', formatVersion: 1, exported_at: new Date().toISOString(), account: u,
      settings: getSettings(user.id), categories: userCategories(user.id),
      activities: db.prepare('SELECT * FROM activities WHERE user_id=?').all(user.id).map((r) => { const a = activityOut(r); return { ...a, is_sample: a.is_sample }; }),
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="docket-export-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data, null, 2));
  });
  route('POST', '/api/import', async (req, res, { user }) => {
    const b = await readJson(req, 20 * 1024 * 1024);
    const d = b.data || b;
    if (d.format !== 'docket-export') throw new HttpError(400, 'bad_format', 'This file is not a Docket export (.json). For calendar files use “Import .ics”.');
    const result = { categoriesAdded: 0, activitiesAdded: 0, skippedExisting: 0, errors: [] };
    const catMap = {};
    db.tx(() => {
      for (const c of d.categories || []) {
        const byName = categoryIdByName(user.id, String(c.name || ''));
        if (byName) { catMap[c.id] = byName; continue; }
        const { value, errors } = normalizeCategory({ ...c, id: isId(c.id) && !db.prepare('SELECT 1 FROM categories WHERE id=?').get(c.id) ? c.id : newId('c') });
        if (Object.keys(errors).length) { result.errors.push(`Category “${c.name}”: ${Object.values(errors)[0]}`); continue; }
        db.prepare('INSERT INTO categories (id,user_id,name,color,sort,version,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)').run(value.id, user.id, value.name, value.color, value.sort, Date.now(), Date.now());
        catMap[c.id] = value.id; result.categoriesAdded++;
      }
      for (const a of d.activities || []) {
        const ex = isId(a.id) && db.prepare('SELECT user_id FROM activities WHERE id=?').get(a.id);
        if (ex && ex.user_id === user.id) { result.skippedExisting++; continue; }
        try {
          insertActivity(user.id, { ...a, id: ex ? newId('a') : a.id, category_id: catMap[a.category_id] || null }, { isSample: !!a.is_sample });
          result.activitiesAdded++;
        } catch (err) { result.errors.push(`“${a.title || 'Untitled'}”: ${err.message}`); }
      }
    });
    hub.send(user.id, { type: 'reload' });
    json(res, 200, result);
  });
  route('POST', '/api/import/ics', async (req, res, { user }) => {
    const b = await readJson(req, 10 * 1024 * 1024);
    const text = String(b.text || '');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new HttpError(400, 'bad_format', 'This does not look like an .ics calendar file');
    const settings = getSettings(user.id);
    const items = parseIcs(text, { timezone: settings.timezone });
    const result = { activitiesAdded: 0, skippedExisting: 0, errors: [] };
    const catId = b.category_id && db.prepare('SELECT 1 FROM categories WHERE id=? AND user_id=?').get(b.category_id, user.id) ? b.category_id : null;
    db.tx(() => {
      for (const it of items) {
        if (it.ics_uid && db.prepare('SELECT 1 FROM activities WHERE user_id=? AND ics_uid=?').get(user.id, it.ics_uid)) { result.skippedExisting++; continue; }
        try { insertActivity(user.id, { ...it, id: newId('a'), category_id: catId, reminders: it.reminders.length ? it.reminders : settings.defaultReminders.map((m) => ({ minutes: m })) }); result.activitiesAdded++; }
        catch (err) { result.errors.push(`“${it.title}”: ${err.message}`); }
      }
    });
    hub.send(user.id, { type: 'reload' });
    json(res, 200, { ...result, found: items.length });
  });
  function icsFor(userId) {
    const acts = db.prepare('SELECT data FROM activities WHERE user_id=?').all(userId).map((r) => JSON.parse(r.data));
    return activitiesToIcs(acts, { categories: userCategories(userId) });
  }
  route('GET', '/api/export.ics', async (req, res, { user }) => {
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="docket.ics"', 'Cache-Control': 'no-store' });
    res.end(icsFor(user.id));
  });
  route('GET', '/api/activities/:id/ics', async (req, res, { user, params }) => {
    const row = getActivityRow(user.id, params.id);
    if (!row) throw new HttpError(404, 'not_found', 'Activity not found');
    const a = JSON.parse(row.data);
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${a.title.replace(/[^\w -]/g, '').slice(0, 60) || 'activity'}.ics"`, 'Cache-Control': 'no-store' });
    res.end(activitiesToIcs([a], { categories: userCategories(user.id) }));
  });
  route('POST', '/api/ics-token', async (req, res, { user }) => {
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare('UPDATE users SET ics_token=? WHERE id=?').run(token, user.id);
    json(res, 200, { token });
  });
  route('GET', '/api/ics-token', async (req, res, { user }) => {
    json(res, 200, { token: db.prepare('SELECT ics_token FROM users WHERE id=?').get(user.id).ics_token });
  });
  route('DELETE', '/api/ics-token', async (req, res, { user }) => {
    db.prepare('UPDATE users SET ics_token=NULL WHERE id=?').run(user.id); json(res, 200, { ok: true });
  });

  // ----- sample data -----
  route('POST', '/api/sample-data', async (req, res, { user }) => {
    const n = db.prepare('SELECT COUNT(*) n FROM activities WHERE user_id=? AND is_sample=1').get(user.id).n;
    if (n) throw new HttpError(409, 'exists', 'Sample data is already loaded');
    const created = [];
    db.tx(() => { for (const a of sampleActivities(user.id)) created.push(insertActivity(user.id, a, { isSample: true })); });
    hub.send(user.id, { type: 'reload' });
    json(res, 201, { created: created.length });
  });
  route('DELETE', '/api/sample-data', async (req, res, { user }) => {
    const rows = db.prepare('SELECT id FROM activities WHERE user_id=? AND is_sample=1').all(user.id);
    db.prepare('DELETE FROM activities WHERE user_id=? AND is_sample=1').run(user.id);
    hub.send(user.id, { type: 'reload' });
    json(res, 200, { removed: rows.length });
  });

  // ----- real-time event stream -----
  route('GET', '/api/events', async (req, res, { user }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ type: 'hello', serverTime: Date.now() })}\n\n`);
    const remove = hub.add(user.id, res, user.sessionHash);
    req.on('close', remove);
  });

  // ---------- static files ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon', '.map': 'application/json' };
  function assetVersion() {
    try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'))).update(fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'))).digest('hex').slice(0, 10); } catch { return 'dev'; }
  }
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(400); return res.end(); }
    let target = file;
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) target = path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(target);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
    if (ext === '.html') {
      const html = fs.readFileSync(target, 'utf8').replaceAll('__V__', assetVersion());
      res.writeHead(200, { ...headers, 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' });
      return res.end(html);
    }
    if (path.basename(target) === 'sw.js') headers['Cache-Control'] = 'no-cache';
    else headers['Cache-Control'] = new URL(req.url, 'http://x').searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, headers);
    fs.createReadStream(target).pipe(res);
  }

  // ---------- request dispatch ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/ics/') && req.method === 'GET') {
        const token = pathname.slice(5).replace(/\.ics$/, '');
        const u = token.length > 20 && db.prepare('SELECT id FROM users WHERE ics_token=?').get(token);
        if (!u) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Calendar feed not found'); }
        res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(icsFor(u.id));
      }
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
        return serveStatic(req, res, pathname);
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
      if (!r) throw new HttpError(404, 'not_found', 'Unknown API endpoint');
      // CSRF defence: state-changing requests must carry a custom header (not settable cross-site without CORS)
      if (req.method !== 'GET' && req.headers['x-docket'] !== '1') throw new HttpError(403, 'csrf', 'Missing request header');
      const m = r.re.exec(pathname); const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      let user = null;
      if (r.auth) {
        user = authenticate(req);
        if (!user) throw new HttpError(401, 'unauthenticated', 'Your session has expired. Please sign in again.');
      }
      await r.handler(req, res, { user, params, query: url.searchParams, origin: String(req.headers['x-client-id'] || '').slice(0, 64) || null });
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) return json(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } });
      log.error(err);
      json(res, 500, { error: { code: 'server_error', message: 'Something went wrong on the server. Your change was not saved; please retry.' } });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 60000;
  server.headersTimeout = 30000;
  reminders.start({ tickMs });

  function close() { reminders.stop(); hub.close(); server.close(); db.close(); }
  return { server, db, reminders, hub, close, push, mailer };
}
