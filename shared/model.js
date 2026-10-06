// Shared data model: constants, defaults and validation used by both frontend and backend.
import { isDateStr, isTimeStr, isValidTimeZone, zonedToUtc } from './time.js';

export const STATUSES = ['tentative', 'confirmed', 'completed', 'missed', 'cancelled'];
export const STATUS_LABELS = { tentative: 'Tentative', confirmed: 'Confirmed', completed: 'Completed', missed: 'Missed', cancelled: 'Cancelled' };
export const PRIORITIES = ['low', 'medium', 'high'];
export const PRIORITY_LABELS = { low: 'Low', medium: 'Medium', high: 'High' };
export const KINDS = ['event', 'deadline'];
export const FREQS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
export const ACTIVE_STATUSES = ['tentative', 'confirmed'];

export const DEFAULT_CATEGORIES = [
  { key: 'interview', name: 'Job Interviews', color: '#7c3aed' },
  { key: 'college', name: 'College Programs', color: '#2563eb' },
  { key: 'club', name: 'Club Meetings', color: '#0d9488' },
  { key: 'volunteer', name: 'Volunteer Activities', color: '#16a34a' },
  { key: 'appointment', name: 'Personal Appointments', color: '#db2777' },
  { key: 'event', name: 'Events', color: '#ea580c' },
  { key: 'deadline', name: 'Deadlines', color: '#dc2626' },
];

export const DATE_FORMATS = ['DD MMM YYYY', 'MMM DD, YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'];

export const DEFAULT_SETTINGS = {
  timezone: 'Asia/Kathmandu',
  dateFormat: 'DD MMM YYYY',
  timeFormat: '12h',
  weekStart: 0,
  theme: 'system',
  defaultReminders: [1440, 60, 10],
  defaultTaskReminder: 60,
  allDayReminderTime: '09:00',
  channels: { inapp: true, push: false, email: false, sound: true },
  emailAddress: '',
};

const MAX_REMINDER_MIN = 60 * 24 * 60; // 60 days

export function normalizeSettings(input, base = DEFAULT_SETTINGS) {
  const errors = {};
  const s = { ...base, ...(input || {}) };
  const out = { ...DEFAULT_SETTINGS };
  if (isValidTimeZone(s.timezone)) out.timezone = s.timezone; else errors.timezone = 'Unknown timezone';
  out.dateFormat = DATE_FORMATS.includes(s.dateFormat) ? s.dateFormat : DEFAULT_SETTINGS.dateFormat;
  out.timeFormat = s.timeFormat === '24h' ? '24h' : '12h';
  out.weekStart = s.weekStart === 1 ? 1 : 0;
  out.theme = ['light', 'dark', 'system'].includes(s.theme) ? s.theme : 'system';
  const rems = Array.isArray(s.defaultReminders) ? s.defaultReminders : [];
  out.defaultReminders = [...new Set(rems.map((x) => Math.round(Number(x))).filter((x) => Number.isFinite(x) && x >= 0 && x <= MAX_REMINDER_MIN))].slice(0, 10).sort((a, b) => b - a);
  const tr = s.defaultTaskReminder;
  out.defaultTaskReminder = tr === null || tr === '' ? null : Math.min(MAX_REMINDER_MIN, Math.max(0, Math.round(Number(tr) || 0)));
  out.allDayReminderTime = isTimeStr(s.allDayReminderTime) ? s.allDayReminderTime : '09:00';
  const ch = s.channels || {};
  out.channels = { inapp: true, push: !!ch.push, email: !!ch.email, sound: ch.sound !== false };
  const em = String(s.emailAddress || '').trim();
  if (em && !EMAIL_RE.test(em)) errors.emailAddress = 'Enter a valid email address';
  out.emailAddress = em.slice(0, 200);
  return { value: out, errors };
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
export const isId = (s) => typeof s === 'string' && ID_RE.test(s);

function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function isUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

/**
 * Validate and normalize an activity payload.
 * Returns { value, errors } where errors maps field path -> message.
 */
export function normalizeActivity(input, { defaultTimezone = 'Asia/Kathmandu' } = {}) {
  const e = {};
  const a = input || {};
  const v = {};
  v.id = a.id;
  if (!isId(v.id)) e.id = 'Invalid id';
  v.title = str(a.title, 200);
  if (!v.title) e.title = 'Title is required';
  v.kind = KINDS.includes(a.kind) ? a.kind : 'event';
  v.category_id = a.category_id && isId(a.category_id) ? a.category_id : null;
  v.description = str(a.description, 5000);
  v.notes = str(a.notes, 5000);
  v.schedule = a.schedule === 'tbd' ? 'tbd' : 'scheduled';
  v.tbd_note = str(a.tbd_note, 500);
  v.follow_up_date = a.follow_up_date && isDateStr(a.follow_up_date) ? a.follow_up_date : '';
  if (a.follow_up_date && !isDateStr(a.follow_up_date)) e.follow_up_date = 'Enter a valid date';
  v.all_day = !!a.all_day;
  v.timezone = isValidTimeZone(a.timezone) ? a.timezone : defaultTimezone;
  if (a.timezone && !isValidTimeZone(a.timezone)) e.timezone = 'Unknown timezone';
  v.start_date = a.start_date || '';
  v.start_time = a.start_time || '';
  v.end_date = a.end_date || '';
  v.end_time = a.end_time || '';
  if (v.start_date && !isDateStr(v.start_date)) e.start_date = 'Enter a valid date';
  if (v.start_time && !isTimeStr(v.start_time)) e.start_time = 'Enter a valid time (HH:MM)';
  if (v.end_date && !isDateStr(v.end_date)) e.end_date = 'Enter a valid date';
  if (v.end_time && !isTimeStr(v.end_time)) e.end_time = 'Enter a valid time (HH:MM)';

  if (v.schedule === 'scheduled') {
    if (!v.start_date) e.start_date = v.kind === 'deadline' ? 'Due date is required (or mark the date as “to be confirmed”)' : 'Start date is required (or mark the date as “to be confirmed”)';
    if (!v.all_day && !v.start_time && !e.start_date) e.start_time = v.kind === 'deadline' ? 'Add a due time or mark it as all-day' : 'Add a start time or mark it as all-day';
  }
  if (v.all_day) { v.start_time = ''; v.end_time = ''; }
  if (v.kind === 'deadline') { v.end_time = ''; v.end_date = ''; }
  if (v.end_date && !v.start_date) v.end_date = '';
  if (v.end_date && v.start_date && v.end_date < v.start_date && !e.end_date) e.end_date = 'End date cannot be before the start date';
  if (!v.all_day && v.end_time && v.start_time && v.start_date && !e.end_time && !e.start_time && !e.end_date) {
    const s = zonedToUtc(v.start_date, v.start_time, v.timezone);
    const en = zonedToUtc(v.end_date || v.start_date, v.end_time, v.timezone);
    if (en <= s) e.end_time = v.end_date && v.end_date !== v.start_date ? 'End must be after the start' : 'End time must be after the start time (set an end date for events that run past midnight)';
  }
  if (v.end_date === v.start_date) v.end_date = '';

  v.location = str(a.location, 300);
  v.meeting_url = str(a.meeting_url, 1000);
  if (v.meeting_url && !isUrl(v.meeting_url)) e.meeting_url = 'Enter a full link starting with https://';
  const org = a.organizer || {};
  v.organizer = { name: str(org.name, 120), email: str(org.email, 200), phone: str(org.phone, 60) };
  if (v.organizer.email && !EMAIL_RE.test(v.organizer.email)) e['organizer.email'] = 'Enter a valid email address';

  v.links = [];
  (Array.isArray(a.links) ? a.links : []).slice(0, 30).forEach((l, i) => {
    const url = str(l && l.url, 1000); const label = str(l && l.label, 120);
    if (!url && !label) return;
    if (!isUrl(url)) e[`links.${i}`] = 'Enter a full link starting with https://';
    v.links.push({ id: isId(l.id) ? l.id : `l${i}${Date.now().toString(36)}`, label, url });
  });

  v.priority = PRIORITIES.includes(a.priority) ? a.priority : 'medium';
  v.status = STATUSES.includes(a.status) ? a.status : 'confirmed';

  v.checklist = [];
  (Array.isArray(a.checklist) ? a.checklist : []).slice(0, 100).forEach((t, i) => {
    const text = str(t && t.text, 300);
    if (!text) return;
    const item = { id: isId(t.id) ? t.id : `t${i}${Date.now().toString(36)}`, text, done: !!t.done, due_date: '', due_time: '', remind_minutes: null };
    if (t.due_date) { if (isDateStr(t.due_date)) item.due_date = t.due_date; else e[`checklist.${i}`] = 'Invalid due date'; }
    if (t.due_time) { if (isTimeStr(t.due_time)) item.due_time = t.due_time; else e[`checklist.${i}`] = 'Invalid due time'; }
    if (item.due_time && !item.due_date) e[`checklist.${i}`] = 'Add a due date for this task';
    if (t.remind_minutes !== null && t.remind_minutes !== undefined && t.remind_minutes !== '') {
      const m = Math.round(Number(t.remind_minutes));
      if (Number.isFinite(m) && m >= 0 && m <= MAX_REMINDER_MIN) item.remind_minutes = m; else e[`checklist.${i}`] = 'Invalid reminder';
    }
    item.done_at = item.done ? (t.done_at || null) : null;
    v.checklist.push(item);
  });

  const seen = new Set();
  v.reminders = [];
  (Array.isArray(a.reminders) ? a.reminders : []).forEach((r) => {
    const m = Math.round(Number(r && r.minutes !== undefined ? r.minutes : r));
    if (!Number.isFinite(m) || m < 0 || m > MAX_REMINDER_MIN) { e.reminders = 'Reminders must be between 0 minutes and 60 days before'; return; }
    if (seen.has(m)) return; seen.add(m);
    v.reminders.push({ minutes: m });
  });
  if (v.reminders.length > 10) e.reminders = 'At most 10 reminders per activity';
  v.reminders.sort((x, y) => y.minutes - x.minutes);

  const r = a.recurrence || {};
  const freq = FREQS.includes(r.freq) ? r.freq : 'none';
  v.recurrence = { freq, interval: 1, byweekday: [], until: '', count: null, exdates: [] };
  if (freq !== 'none') {
    const iv = Math.round(Number(r.interval) || 1);
    if (iv < 1 || iv > 365) e['recurrence.interval'] = 'Repeat interval must be between 1 and 365';
    v.recurrence.interval = Math.min(365, Math.max(1, iv));
    if (freq === 'weekly') v.recurrence.byweekday = [...new Set((r.byweekday || []).map(Number).filter((x) => x >= 0 && x <= 6))].sort();
    if (r.until) { if (isDateStr(r.until)) v.recurrence.until = r.until; else e['recurrence.until'] = 'Enter a valid end date'; }
    if (v.recurrence.until && v.start_date && v.recurrence.until < v.start_date) e['recurrence.until'] = 'Repeat end date is before the first occurrence';
    if (r.count !== null && r.count !== undefined && r.count !== '') {
      const c = Math.round(Number(r.count));
      if (c >= 1 && c <= 1000) v.recurrence.count = c; else e['recurrence.count'] = 'Number of times must be 1–1000';
    }
    v.recurrence.exdates = (r.exdates || []).filter(isDateStr).slice(0, 500);
    if (v.schedule === 'tbd') e['recurrence.freq'] = 'Repeating activities need a confirmed date';
  }
  v.archived = !!a.archived;
  v.ics_uid = str(a.ics_uid, 300);
  return { value: v, errors: e };
}

export function normalizeCategory(input) {
  const e = {}; const c = input || {};
  const v = { id: c.id, name: str(c.name, 40), color: /^#[0-9a-fA-F]{6}$/.test(c.color || '') ? c.color.toLowerCase() : '#64748b', sort: Number.isFinite(+c.sort) ? Math.round(+c.sort) : 0 };
  if (!isId(v.id)) e.id = 'Invalid id';
  if (!v.name) e.name = 'Category name is required';
  return { value: v, errors: e };
}

export function reminderLabel(min) {
  if (min === 0) return 'At the time';
  if (min % 10080 === 0) { const w = min / 10080; return `${w} week${w > 1 ? 's' : ''} before`; }
  if (min % 1440 === 0) { const d = min / 1440; return `${d} day${d > 1 ? 's' : ''} before`; }
  if (min % 60 === 0) { const h = min / 60; return `${h} hour${h > 1 ? 's' : ''} before`; }
  return `${min} minute${min > 1 ? 's' : ''} before`;
}

export function newId(prefix = '') {
  const c = globalThis.crypto;
  const raw = c && c.randomUUID ? c.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  return (prefix + raw).slice(0, 32);
}
