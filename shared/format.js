// Display formatting shared by server (notification text) and client.
import { zonedParts, parseDate, zonedToUtc } from './time.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export { MONTHS, MONTHS_LONG, DAYS, DAYS_LONG };
const pad = (n) => String(n).padStart(2, '0');

export function formatYMD(y, m, d, fmt = 'DD MMM YYYY') {
  switch (fmt) {
    case 'MMM DD, YYYY': return `${MONTHS[m - 1]} ${d}, ${y}`;
    case 'YYYY-MM-DD': return `${y}-${pad(m)}-${pad(d)}`;
    case 'DD/MM/YYYY': return `${pad(d)}/${pad(m)}/${y}`;
    case 'MM/DD/YYYY': return `${pad(m)}/${pad(d)}/${y}`;
    default: return `${d} ${MONTHS[m - 1]} ${y}`;
  }
}

/** Format a YYYY-MM-DD string. opts.weekday prefixes the short weekday. */
export function formatDateStr(s, settings = {}, opts = {}) {
  if (!s) return '';
  const { y, m, d } = parseDate(s);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const base = formatYMD(y, m, d, settings.dateFormat);
  return opts.weekday ? `${DAYS[wd]}, ${base}` : base;
}

export function formatHM(h, mi, timeFormat = '12h') {
  if (timeFormat === '24h') return `${pad(h)}:${pad(mi)}`;
  const ap = h < 12 ? 'AM' : 'PM'; const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${pad(mi)} ${ap}`;
}
export function formatTimeStr(t, settings = {}) {
  if (!t) return '';
  const [h, mi] = t.split(':').map(Number); return formatHM(h, mi, settings.timeFormat);
}
export function formatTime(ms, tz, settings = {}) { const z = zonedParts(ms, tz); return formatHM(z.hour, z.minute, settings.timeFormat); }
export function formatDate(ms, tz, settings = {}, opts = {}) {
  const z = zonedParts(ms, tz); const base = formatYMD(z.year, z.month, z.day, settings.dateFormat);
  return opts.weekday ? `${DAYS[z.weekday]}, ${base}` : base;
}
export function formatDateTime(ms, tz, settings = {}, opts = {}) { return `${formatDate(ms, tz, settings, opts)}, ${formatTime(ms, tz, settings)}`; }

export function tzAbbrev(tz, ms = Date.now()) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(ms));
    return (p.find((x) => x.type === 'timeZoneName') || {}).value || tz;
  } catch { return tz; }
}

export function formatDuration(ms) {
  const neg = ms < 0; ms = Math.abs(ms);
  const m = Math.round(ms / 60000);
  let out;
  if (m < 1) out = 'less than a minute';
  else if (m < 60) out = `${m} min`;
  else if (m < 1440) { const h = Math.floor(m / 60), r = m % 60; out = r ? `${h} h ${r} min` : `${h} h`; }
  else { const d = Math.floor(m / 1440), h = Math.round((m % 1440) / 60); out = h ? `${d} day${d > 1 ? 's' : ''} ${h} h` : `${d} day${d > 1 ? 's' : ''}`; }
  return neg ? `${out} ago` : out;
}

/** Human readable "when" text for an occurrence of an activity, in viewer tz with original tz note. */
export function describeOccurrence(a, occ, settings) {
  const tz = settings.timezone;
  if (occ.allDay) {
    const d1 = formatDateStr(occ.date, settings, { weekday: true });
    if (occ.endDate && occ.endDate !== occ.date) return `${d1} – ${formatDateStr(occ.endDate, settings, { weekday: true })} (all day)`;
    return `${d1} (${a.kind === 'deadline' ? 'due, all day' : 'all day'})`;
  }
  let s = `${formatDate(occ.start, tz, settings, { weekday: true })}, ${formatTime(occ.start, tz, settings)}`;
  if (occ.hasEnd) {
    const sameDay = formatDate(occ.start, tz, settings) === formatDate(occ.end, tz, settings);
    s += ` – ${sameDay ? '' : formatDate(occ.end, tz, settings) + ', '}${formatTime(occ.end, tz, settings)}`;
  }
  if (a.timezone && a.timezone !== tz) {
    s += ` (${formatTime(occ.start, a.timezone, settings)} ${tzAbbrev(a.timezone, occ.start)} local)`;
  }
  return s;
}

export function taskDueMs(a, t, settings) {
  if (!t.due_date) return null;
  return zonedToUtc(t.due_date, t.due_time || '23:59', a.timezone || settings.timezone);
}
