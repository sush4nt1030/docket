// End-to-end verification: real server + real browser (Playwright/Chromium) + fake SMTP + fake push service.
// Run: npm run test:e2e   (needs Playwright; set EXTRA_NODE_PATH if it is installed elsewhere)
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createApp } from '../server/app.js';
import { decryptPayload } from '../server/push.js';
import { todayStr, addDays, utcToTimeStr, utcToDateStr, zonedToUtc } from '../shared/time.js';

const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = createRequire(path.join(process.env.EXTRA_NODE_PATH || '/opt/npm-tools/node_modules', 'x.js'))('playwright'); }
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'docket-shots'); fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 15000, step = 250) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return null; }

// ---------- fake SMTP server ----------
const mails = [];
const smtp = net.createServer((sock) => {
  let data = false; let buf = ''; let msg = '';
  sock.write('220 test ESMTP\r\n');
  sock.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data) { if (line === '.') { data = false; mails.push(msg); msg = ''; sock.write('250 OK queued\r\n'); } else msg += line + '\n'; continue; }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') sock.write('250-test\r\n250 AUTH PLAIN\r\n');
      else if (cmd === 'AUTH') sock.write('235 ok\r\n');
      else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 OK\r\n');
    }
  });
});
await new Promise((r) => smtp.listen(0, r));

// ---------- fake push service ----------
const pushes = [];
const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const authSecret = crypto.randomBytes(16);
const pushSrv = http.createServer((req, res) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => { pushes.push({ headers: req.headers, body: Buffer.concat(ch) }); res.writeHead(201); res.end(); }); });
await new Promise((r) => pushSrv.listen(0, r));

// ---------- app ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-e2e-'));
const app = createApp({ dataDir, tickMs: 1000, log: { error: (...a) => console.error('[server]', ...a) }, env: {
  SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_FROM: 'Docket <reminders@docket.test>', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_ALLOW_INSECURE: 'true', SMTP_SECURE: 'false',
  DOCKET_ALLOW_HTTP_PUSH: 'true', VAPID_SUBJECT: 'mailto:admin@docket.test',
} });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${app.server.address().port}`;
const TZ = 'Asia/Kathmandu';
const today = todayStr(TZ); const tomorrow = addDays(today, 1);

const browser = await pw.chromium.launch();
const pageErrors = [];
const watch = (p, label) => { p.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`)); };
const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Docket': '1' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; }, [method, url, body]);

try {
  // ===== 1. sign up and create an activity through the UI =====
  const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: TZ });
  const p1 = await desk.newPage(); watch(p1, 'desk1');
  await p1.goto(BASE);
  await p1.getByRole('tab', { name: 'Create account' }).click();
  await p1.locator('#au-name').fill('Test User');
  await p1.locator('#au-email').fill('test@example.com');
  await p1.locator('#au-pass').fill('correct horse');
  await p1.getByRole('button', { name: 'Create account' }).click();
  await p1.getByText('Let’s capture your first commitment').waitFor();

  // validation keeps input
  await p1.getByRole('button', { name: 'Add an activity' }).click();
  await p1.locator('#ed-title').fill('Interview at ACME Corp');
  await p1.getByRole('button', { name: 'Save activity' }).click();
  const valMsg = await p1.locator('.field-error').first().textContent();
  check('Validation message shown and input preserved', /Start date is required/.test(valMsg) && (await p1.locator('#ed-title').inputValue()) === 'Interview at ACME Corp', valMsg);
  await p1.locator('#ed-cat').selectOption({ label: 'Job Interviews' });
  await p1.locator('#ed-sd').fill(tomorrow);
  await p1.locator('#ed-st').fill('10:00');
  await p1.locator('#ed-et').fill('11:00');
  await p1.locator('summary', { hasText: 'Location & contact' }).click();
  await p1.locator('#ed-loc').fill('ACME HQ, Kathmandu');
  await p1.locator('summary', { hasText: 'Description & important notes' }).click();
  await p1.locator('#ed-notes').fill('Bring printed CV');
  await p1.getByRole('button', { name: 'Save activity' }).click();
  await p1.getByText('“Interview at ACME Corp” saved').waitFor();
  await p1.locator('.save-ind', { hasText: /saved/i }).waitFor();
  const onDash = await p1.locator('.act-row', { hasText: 'Interview at ACME Corp' }).count();
  const nextCard = await p1.locator('.next-card').textContent();
  check('1a. Created activity appears on dashboard (list + next-up countdown)', onDash > 0 && nextCard.includes('Interview at ACME Corp'));
  await p1.goto(`${BASE}/#/calendar?view=month&date=${tomorrow}`);
  check('1b. Activity appears on the month calendar', await p1.locator('.cal-chip', { hasText: 'Interview at ACME' }).count() > 0);
  await p1.goto(`${BASE}/#/calendar?view=week&date=${tomorrow}`);
  check('1c. Activity appears on the week calendar', await p1.locator('.tg-event', { hasText: 'Interview at ACME' }).count() > 0);
  await p1.screenshot({ path: path.join(SHOTS, 'week.png') });

  const boot = await api(p1, 'GET', '/api/bootstrap');
  const acme = boot.json.activities.find((a) => a.title === 'Interview at ACME Corp');
  check('1d. Saved on the server with timezone-aware fields', acme && acme.start_date === tomorrow && acme.start_time === '10:00' && acme.timezone === TZ && acme.reminders.length === 3);

  // ===== 2. persistence after refresh and browser restart =====
  await p1.reload(); await p1.goto(`${BASE}/#/agenda`);
  await p1.locator('.act-row', { hasText: 'Interview at ACME Corp' }).first().waitFor({ timeout: 8000 });
  check('2a. Still there after page refresh', true);
  const storage = await desk.storageState();
  await desk.close();
  const desk2 = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: TZ, storageState: storage });
  const p2 = await desk2.newPage(); watch(p2, 'desk2');
  await p2.goto(`${BASE}/#/agenda`);
  check('2b. Still there after closing and reopening the browser (session restored)', await p2.locator('.act-row', { hasText: 'Interview at ACME Corp' }).first().waitFor({ timeout: 8000 }).then(() => true, () => false));

  // ===== 3. second tab and another device =====
  const p3 = await desk2.newPage(); watch(p3, 'tab2');
  await p3.goto(`${BASE}/#/agenda`);
  check('3a. Second tab shows the same data', await p3.locator('.act-row', { hasText: 'Interview at ACME Corp' }).first().waitFor({ timeout: 8000 }).then(() => true, () => false));
  const phone = await browser.newContext({ ...pw.devices['iPhone 13'], timezoneId: TZ });
  const m1 = await phone.newPage(); watch(m1, 'phone');
  await m1.goto(BASE);
  await m1.locator('#au-email').fill('test@example.com'); await m1.locator('#au-pass').fill('correct horse');
  await m1.getByRole('button', { name: 'Sign in' }).click();
  await m1.goto(`${BASE}/#/agenda`);
  check('3b. Signing in on another device (phone) loads the same activities', await m1.locator('.act-row', { hasText: 'Interview at ACME Corp' }).first().waitFor({ timeout: 8000 }).then(() => true, () => false));

  // ===== 4. edits sync in near real time =====
  await p2.locator('.act-row', { hasText: 'Interview at ACME Corp' }).first().click();
  await p2.getByRole('button', { name: 'Edit', exact: true }).click();
  await p2.locator('#ed-title').fill('Interview at ACME Corp — round 2');
  await p2.locator('.editor-status.saved').waitFor({ timeout: 8000 });
  await p2.getByRole('button', { name: 'Done' }).click();
  const t3 = await waitFor(() => p3.locator('.act-row', { hasText: 'round 2' }).count(), 6000);
  const tm = await waitFor(() => m1.locator('.act-row', { hasText: 'round 2' }).count(), 6000);
  check('4a. Edit autosaves and appears in the other tab without reload', !!t3);
  check('4b. Edit appears on the other device without reload', !!tm);
  // phone edits status -> desktop sees it
  await m1.locator('.act-row', { hasText: 'round 2' }).first().click();
  await m1.getByRole('button', { name: 'Tentative', exact: true }).click();
  const st = await waitFor(async () => (await p3.locator('.act-row', { hasText: 'round 2' }).first().textContent()).includes('Tentative'), 6000);
  check('4c. Status change on phone syncs to desktop', !!st);
  await m1.screenshot({ path: path.join(SHOTS, 'phone-detail.png') });
  await m1.keyboard.press('Escape');

  // concurrent-edit protection
  const cur = (await api(p2, 'GET', '/api/bootstrap')).json.activities.find((a) => a.id === acme.id);
  const stale = await api(p2, 'PUT', `/api/activities/${acme.id}`, { ...cur, version: cur.version - 1, title: 'stale overwrite' });
  check('4d. Stale write is rejected with a conflict instead of overwriting', stale.status === 409 && stale.json.error.current.title.includes('round 2'));
  const dupId = 'dupcheck123';
  const d1 = await api(p2, 'POST', '/api/activities', { id: dupId, title: 'Dup test', schedule: 'tbd' });
  const d2 = await api(p2, 'POST', '/api/activities', { id: dupId, title: 'Dup test', schedule: 'tbd' });
  const dupCount = (await api(p2, 'GET', '/api/bootstrap')).json.activities.filter((a) => a.id === dupId).length;
  check('4e. Retried create does not duplicate records', d1.status === 201 && d2.status === 200 && dupCount === 1);
  await api(p2, 'DELETE', `/api/activities/${dupId}`);

  // ===== 5. reminders delivered through configured channels =====
  // subscribe a (fake) push device and enable channels
  await api(p2, 'POST', '/api/push/subscribe', { endpoint: `http://127.0.0.1:${pushSrv.address().port}/push/abc`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } });
  await api(p2, 'PUT', '/api/settings', { settings: { channels: { inapp: true, push: true, email: true, sound: true } } });
  const test = await api(p2, 'POST', '/api/notifications/test');
  const td = test.json.notification.deliveries;
  check('5a. Test notification reports per-channel delivery', td.inapp.status === 'delivered' && td.push.status === 'sent' && td.email.status === 'sent', JSON.stringify(Object.fromEntries(Object.entries(td).map(([k, v]) => [k, v.status]))));
  // activity starting at the next minute boundary + 1 min, reminder 1 minute before => fires at the next minute boundary
  const now = Date.now(); const fireAt = Math.ceil((now + 5000) / 60000) * 60000; const start = fireAt + 60000;
  const rid = 'remindtest01';
  const mailsBefore = mails.length; const pushesBefore = pushes.length;
  await api(p2, 'POST', '/api/activities', { id: rid, title: 'Quick reminder test', start_date: utcToDateStr(start, TZ), start_time: utcToTimeStr(start, TZ), timezone: TZ, reminders: [{ minutes: 1 }, { minutes: 60 * 24 * 2 }] });
  const jobs = (await api(p2, 'GET', `/api/activities/${rid}/reminders`)).json.jobs;
  check('5b. Reminder job scheduled on the server at the right instant', jobs.length === 1 && jobs[0].fire_at === fireAt, `fires in ${Math.round((fireAt - Date.now()) / 1000)}s`);
  await p3.goto(`${BASE}/#/`);
  const toast = await p3.locator('.toast-notif', { hasText: 'Quick reminder test' }).waitFor({ timeout: 90000 }).then(() => true, () => false);
  check('5c. In-app notification pops up in an open tab', toast);
  await p3.screenshot({ path: path.join(SHOTS, 'reminder-toast.png') });
  const gotMail = await waitFor(() => mails.slice(mailsBefore).find((m) => /Subject: Quick reminder test/.test(m)), 10000);
  check('5d. Email reminder delivered via SMTP', !!gotMail);
  const gotPush = await waitFor(() => pushes.slice(pushesBefore).find((p) => { try { return JSON.parse(decryptPayload(p.body, ua, authSecret)).title === 'Quick reminder test'; } catch { return false; } }), 10000);
  check('5e. Push reminder sent with valid encryption and VAPID auth', !!gotPush && /^vapid t=.+, k=/.test(gotPush.headers.authorization));
  await sleep(3000);
  const hist = (await api(p2, 'GET', '/api/notifications')).json.notifications.filter((n) => n.title === 'Quick reminder test');
  check('5f. Delivered exactly once and recorded in history', hist.length === 1 && hist[0].deliveries.email.status === 'sent' && hist[0].deliveries.push.status === 'sent');
  // snooze
  const sn = await api(p2, 'POST', `/api/notifications/${hist[0].id}/snooze`, { minutes: 5 });
  const snJobs = (await api(p2, 'GET', '/api/reminders/upcoming')).json.jobs.filter((j) => j.kind === 'snooze');
  check('5g. Snooze schedules a follow-up reminder', sn.status === 200 && snJobs.length === 1);
  const ds = await api(p2, 'POST', `/api/notifications/${hist[0].id}/dismiss`);
  const snJobs2 = (await api(p2, 'GET', '/api/reminders/upcoming')).json.jobs.filter((j) => j.kind === 'snooze');
  check('5h. Dismiss cancels the snoozed reminder', ds.status === 200 && snJobs2.length === 0);

  // ===== 6. rescheduling and cancelling update reminders =====
  const a6 = (await api(p2, 'GET', '/api/bootstrap')).json.activities.find((a) => a.id === acme.id);
  const before = (await api(p2, 'GET', `/api/activities/${acme.id}/reminders`)).json.jobs.map((j) => j.fire_at);
  const newDate = addDays(today, 3);
  const r6 = await api(p2, 'PUT', `/api/activities/${acme.id}`, { ...a6, start_date: newDate, start_time: '15:00', end_time: '16:00' });
  const after = (await api(p2, 'GET', `/api/activities/${acme.id}/reminders`)).json.jobs.map((j) => j.fire_at);
  const expected = zonedToUtc(newDate, '15:00', TZ);
  check('6a. Rescheduling moves its reminders', r6.status === 200 && after.length === 3 && after.includes(expected - 3600000) && !after.some((f) => before.includes(f)));
  const r6b = await api(p2, 'PUT', `/api/activities/${acme.id}`, { ...r6.json.activity, status: 'cancelled' });
  const afterCancel = (await api(p2, 'GET', `/api/activities/${acme.id}/reminders`)).json.jobs;
  check('6b. Cancelling stops its reminders', r6b.status === 200 && afterCancel.length === 0);
  const r6c = await api(p2, 'PUT', `/api/activities/${acme.id}`, { ...r6b.json.activity, status: 'confirmed' });
  check('6c. Re-confirming restores reminders', (await api(p2, 'GET', `/api/activities/${acme.id}/reminders`)).json.jobs.length === 3);
  await api(p2, 'DELETE', `/api/activities/${rid}`);
  const delJobs = app.db.prepare('SELECT COUNT(*) n FROM reminder_jobs WHERE activity_id=?').get(rid).n;
  check('6d. Deleting removes its reminders', delJobs === 0);

  // ===== 7. unconfirmed date/time =====
  await p2.goto(`${BASE}/#/pending`);
  await p2.getByRole('button', { name: 'Add unconfirmed activity' }).click();
  await p2.locator('#ed-title').fill('Interview with Globex (date TBC)');
  await p2.locator('#ed-tbdn').fill('Recruiter will call back');
  await p2.locator('#ed-fu').fill(addDays(today, 2));
  await p2.getByRole('button', { name: 'Save activity' }).click();
  const inPending = await p2.locator('.act-row', { hasText: 'Globex' }).waitFor({ timeout: 5000 }).then(() => true, () => false);
  await p2.goto(`${BASE}/#/`);
  const onDashTbd = await p2.locator('.card', { hasText: 'Waiting for date/time' }).locator('.act-row', { hasText: 'Globex' }).count();
  const tbdA = (await api(p2, 'GET', '/api/bootstrap')).json.activities.find((a) => a.title.includes('Globex'));
  check('7a. Unconfirmed activity saved without inventing a date and shown for follow-up', inPending && onDashTbd > 0 && tbdA.schedule === 'tbd' && !tbdA.start_date && !tbdA.start_time);
  const fu = (await api(p2, 'GET', `/api/activities/${tbdA.id}/reminders`)).json.jobs;
  check('7b. Follow-up reminder scheduled for the unconfirmed activity', fu.length === 1 && fu[0].kind === 'followup');

  // ===== 8. overlaps =====
  await api(p2, 'POST', '/api/activities', { id: 'overlapaaa1', title: 'Club meeting A', start_date: addDays(today, 4), start_time: '09:00', end_time: '10:30', timezone: TZ });
  await api(p2, 'POST', '/api/activities', { id: 'overlapbbb1', title: 'Volunteer shift B', start_date: addDays(today, 4), start_time: '10:00', end_time: '12:00', timezone: TZ });
  await p2.goto(`${BASE}/#/agenda?overlaps=1`);
  await p2.locator('.act-row', { hasText: 'Club meeting A' }).waitFor({ timeout: 5000 });
  check('8a. Overlapping activities are flagged', (await p2.locator('.act-row', { hasText: 'Club meeting A' }).locator('.badge-warn').count()) > 0 && (await p2.locator('.act-row', { hasText: 'Volunteer shift B' }).locator('.badge-warn').count()) > 0);
  // international event / DST: London 18:00 shown in Kathmandu time
  await api(p2, 'POST', '/api/activities', { id: 'intl0000001', title: 'London webinar', start_date: '2026-10-23', start_time: '18:00', end_time: '19:00', timezone: 'Europe/London', recurrence: { freq: 'weekly' } });
  const intl = (await api(p2, 'GET', '/api/activities/intl0000001/reminders')).json.jobs;
  await p2.goto(`${BASE}/#/activity/intl0000001?on=2026-11-06`);
  const intlTxt = await p2.locator('.detail-when').textContent();
  check('8b. International event converts correctly across a DST change', /11:45 PM/.test(intlTxt) && /6:00 PM GMT local/.test(intlTxt), intlTxt.slice(0, 120));
  await p2.keyboard.press('Escape');

  // ===== 9. failed saves keep input =====
  await p2.goto(`${BASE}/#/agenda`);
  await p2.route('**/api/activities/**', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"down","message":"Service temporarily unavailable"}}' }) : route.continue()));
  await p2.locator('.act-row', { hasText: 'Club meeting A' }).first().click();
  await p2.getByRole('button', { name: 'Edit', exact: true }).click();
  await p2.locator('#ed-title').fill('Club meeting A (moved room)');
  const failShown = await p2.locator('.save-ind.err', { hasText: 'Failed to save' }).waitFor({ timeout: 8000 }).then(() => true, () => false) && await p2.locator('.editor-status.error', { hasText: 'Failed to save' }).waitFor({ timeout: 3000 }).then(() => true, () => false);
  await p2.screenshot({ path: path.join(SHOTS, 'failed-save.png') });
  const kept = await p2.locator('#ed-title').inputValue();
  check('9a. Failed save shows an error and keeps the input', failShown && kept === 'Club meeting A (moved room)');
  await p2.unroute('**/api/activities/**');
  await p2.locator('.editor-status').getByRole('button', { name: 'Retry' }).click();
  const saved = await waitFor(async () => (await api(p2, 'GET', '/api/bootstrap')).json.activities.find((a) => a.id === 'overlapaaa1').title === 'Club meeting A (moved room)', 10000);
  check('9b. Retry saves the preserved change', !!saved);
  await p2.getByRole('button', { name: 'Done' }).click();
  // offline queue
  await desk2.setOffline(true);
  await p2.evaluate(() => window.dispatchEvent(new Event('offline')));
  await p2.goto(`${BASE}/#/agenda`).catch(() => {});
  await p2.keyboard.press('n');
  await p2.locator('#ed-title').fill('Created while offline');
  await p2.locator('#ed-sd').fill(addDays(today, 5)); await p2.locator('#ed-st').fill('08:00');
  await p2.getByRole('button', { name: 'Save activity' }).click();
  const waiting = await p2.locator('.save-ind', { hasText: 'waiting to sync' }).waitFor({ timeout: 8000 }).then(() => true, () => false);
  await p2.screenshot({ path: path.join(SHOTS, 'offline.png') });
  check('9c. Offline change is queued and shown as waiting to sync', waiting);
  await desk2.setOffline(false);
  await p2.evaluate(() => window.dispatchEvent(new Event('online')));
  const synced = await waitFor(async () => (await api(p2, 'GET', '/api/bootstrap')).json.activities.some((a) => a.title === 'Created while offline'), 15000);
  const phoneSees = await waitFor(() => m1.locator('.act-row', { hasText: 'Created while offline' }).count().catch(() => 0), 8000);
  await m1.goto(`${BASE}/#/agenda`);
  check('9d. Queued change syncs when back online and reaches other devices', !!synced && (!!phoneSees || await m1.locator('.act-row', { hasText: 'Created while offline' }).count() > 0));

  // ===== 10. mobile + desktop layout =====
  for (const [label, pg] of [['phone', m1], ['desktop', p3]]) {
    for (const route of ['/', '/calendar?view=month', '/calendar?view=day', '/agenda', '/settings/notifications']) {
      await pg.goto(`${BASE}/#${route}`); await sleep(400);
      const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) check(`10. No horizontal overflow on ${label} ${route}`, false, `${overflow}px`);
      await pg.screenshot({ path: path.join(SHOTS, `${label}${route.replace(/[/?=]/g, '_')}.png`), fullPage: label === 'phone' });
    }
  }
  check('10. Layouts render without horizontal overflow on phone and desktop', !results.some((r) => r.name.startsWith('10. No horizontal') && !r.ok));
  await m1.goto(`${BASE}/#/`); await m1.locator('.fab').click();
  check('10b. Editor opens full-screen and usable on phone', await m1.locator('#ed-title').isVisible());
  await m1.screenshot({ path: path.join(SHOTS, 'phone-editor.png') });

  // ===== security =====
  const other = await browser.newContext(); const o1 = await other.newPage();
  await o1.goto(BASE);
  const reg = await o1.evaluate(async () => (await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Docket': '1' }, body: JSON.stringify({ email: 'other@example.com', password: 'another-pass' }) })).status);
  const peek = await api(o1, 'PUT', `/api/activities/${acme.id}`, { title: 'hijack' });
  const list = (await api(o1, 'GET', '/api/bootstrap')).json.activities.length;
  check('S1. Other users cannot read or modify my data', reg === 201 && peek.status === 404 && list === 0);
  const csrf = await o1.evaluate(async () => (await fetch('/api/activities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  check('S2. State-changing requests without the anti-CSRF header are refused', csrf === 403);
  const ics = await p3.evaluate(async () => (await fetch('/api/export.ics')).text());
  check('S3. ICS export contains activities with RRULE/VALARM', /BEGIN:VEVENT/.test(ics) && /RRULE:FREQ=WEEKLY/.test(ics) && /BEGIN:VALARM/.test(ics));

  // ===== Android app support =====
  const dev = await api(p3, 'GET', '/api/device/reminders');
  const devItem = dev.json.reminders.find((r) => r.activity_id === acme.id);
  check('A1. Device schedule endpoint returns ready-to-show reminders', dev.status === 200 && devItem && /round 2/.test(devItem.title) && /Starts in 1 h\b/.test(dev.json.reminders.find((r) => r.activity_id === acme.id && r.fire_at === zonedToUtc(addDays(today, 3), '15:00', TZ) - 3600000).body) && Array.isArray(dev.json.recentlySent));
  const andCtx = await browser.newContext({ ...pw.devices['Pixel 7'], timezoneId: TZ, storageState: await desk2.storageState() });
  await andCtx.addInitScript(() => {
    window.__bridgeCalls = [];
    window.DocketAndroid = {
      onDataChanged: () => window.__bridgeCalls.push('changed'), onSignedOut: () => window.__bridgeCalls.push('signedout'), syncNow: () => window.__bridgeCalls.push('sync'),
      notificationStatus: () => JSON.stringify({ permission: 'granted', exactAlarms: true, scheduled: 7, lastSync: Date.now(), lastError: null }),
      requestNotificationPermission() {}, openNotificationSettings() {}, openExactAlarmSettings() {}, changeServer() {},
    };
  });
  const ap = await andCtx.newPage(); watch(ap, 'android');
  await ap.goto(`${BASE}/#/settings/notifications`);
  const panel = await ap.getByText('Android app notifications').waitFor({ timeout: 8000 }).then(() => true, () => false);
  const noWebPush = (await ap.getByText('Browser / device push').count()) === 0;
  await ap.screenshot({ path: path.join(SHOTS, 'android-settings.png'), fullPage: true });
  await api(p3, 'POST', '/api/activities', { id: 'bridgetest01', title: 'Bridge test', schedule: 'tbd' });
  const called = await waitFor(() => ap.evaluate(() => window.__bridgeCalls.includes('changed')), 8000);
  check('A2. Inside the Android app, settings show native notification status and the app is told to resync after changes', panel && noWebPush && !!called);
  await andCtx.close();

  check('No uncaught JavaScript errors in any page', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  console.error(err); check('Test run completed without crashing', false, err.message);
} finally {
  await browser.close(); app.close(); smtp.close(); pushSrv.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
