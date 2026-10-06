// Timezone-safe date/time helpers shared by the server and the browser.
// Activities store wall-clock date + time + IANA timezone; UTC instants are
// derived on demand so daylight-saving transitions are handled per occurrence.

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export const DAY_MS = 86400000;

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function zonedParts(ms, tz) {
  const p = {};
  for (const x of dtf(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  let hour = +p.hour; if (hour === 24) hour = 0;
  return { year: +p.year, month: +p.month, day: +p.day, hour, minute: +p.minute, second: +p.second, weekday: WD[p.weekday] };
}

export function tzOffsetMs(ms, tz) {
  const z = zonedParts(ms, tz);
  const asUTC = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
export const dateStr = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
export function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; }
export function isDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parseDate(s); const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
export const isTimeStr = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function addDays(s, n) {
  const { y, m, d } = parseDate(s); const t = new Date(Date.UTC(y, m - 1, d + n));
  return dateStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export function diffDays(a, b) { // a - b in days
  const pa = parseDate(a), pb = parseDate(b);
  return Math.round((Date.UTC(pa.y, pa.m - 1, pa.d) - Date.UTC(pb.y, pb.m - 1, pb.d)) / DAY_MS);
}
export function dayOfWeek(s) { const { y, m, d } = parseDate(s); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
export function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
export function addMonths(s, n) { // clamps day
  const { y, m, d } = parseDate(s); const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12), nm = idx % 12 + 1;
  return dateStr(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** Convert a wall-clock date/time in `tz` to a UTC epoch ms. Non-existent times (DST gap) shift forward. */
export function zonedToUtc(date, time, tz) {
  const { y, m, d } = parseDate(date);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let t = wall - tzOffsetMs(wall, tz);
  const o2 = tzOffsetMs(t, tz);
  t = wall - o2;
  return t;
}

export function utcToDateStr(ms, tz) { const z = zonedParts(ms, tz); return dateStr(z.year, z.month, z.day); }
export function utcToTimeStr(ms, tz) { const z = zonedParts(ms, tz); return `${pad(z.hour)}:${pad(z.minute)}`; }
export function todayStr(tz, now = Date.now()) { return utcToDateStr(now, tz); }
export function startOfDayUtc(date, tz) { return zonedToUtc(date, '00:00', tz); }

/** Yield occurrence dates (YYYY-MM-DD, in the activity timezone) following RFC 5545-like rules. */
export function* occurrenceDates(a) {
  const start = a.start_date;
  const r = a.recurrence;
  if (!r || !r.freq || r.freq === 'none') { yield start; return; }
  const interval = Math.max(1, (r.interval | 0) || 1);
  const until = r.until || null;
  const maxCount = r.count || Infinity;
  const ex = new Set(r.exdates || []);
  let n = 0, guard = 0;
  const take = (d) => { n++; return !ex.has(d); };
  if (r.freq === 'daily') {
    let d = start;
    while (guard++ < 40000) {
      if (until && d > until) return; if (n >= maxCount) return;
      if (take(d)) yield d; d = addDays(d, interval);
    }
  } else if (r.freq === 'weekly') {
    const days = (r.byweekday && r.byweekday.length ? [...new Set(r.byweekday)] : [dayOfWeek(start)]).sort((x, y) => x - y);
    let weekStart = addDays(start, -dayOfWeek(start));
    while (guard++ < 10000) {
      for (const wd of days) {
        const d = addDays(weekStart, wd);
        if (d < start) continue;
        if (until && d > until) return; if (n >= maxCount) return;
        if (take(d)) yield d;
      }
      weekStart = addDays(weekStart, 7 * interval);
    }
  } else if (r.freq === 'monthly' || r.freq === 'yearly') {
    const { y, m, d: day } = parseDate(start);
    const step = r.freq === 'monthly' ? interval : 12 * interval;
    for (let k = 0; guard++ < 5000; k++) {
      const idx = y * 12 + (m - 1) + k * step;
      const ny = Math.floor(idx / 12), nm = idx % 12 + 1;
      if (day > daysInMonth(ny, nm)) continue; // e.g. 31st in a 30-day month: skipped (RFC 5545 behaviour)
      const d = dateStr(ny, nm, day);
      if (until && d > until) return; if (n >= maxCount) return;
      if (take(d)) yield d;
    }
  }
}

/** Build a concrete occurrence for a given date. All-day events are floating dates placed in `viewTz`. */
export function buildOccurrence(a, date, viewTz) {
  if (a.all_day || !a.start_time) {
    const span = a.end_date && a.end_date > a.start_date ? diffDays(a.end_date, a.start_date) : 0;
    const endDate = addDays(date, span);
    return {
      id: a.id, key: `${a.id}@${date}`, date, endDate, allDay: true, hasEnd: span > 0,
      start: zonedToUtc(date, '00:00', viewTz), end: zonedToUtc(addDays(endDate, 1), '00:00', viewTz),
    };
  }
  const start = zonedToUtc(date, a.start_time, a.timezone);
  let end = start, hasEnd = false;
  if (a.kind !== 'deadline' && a.end_time) {
    const span = a.end_date && a.end_date > a.start_date ? diffDays(a.end_date, a.start_date) : 0;
    end = zonedToUtc(addDays(date, span), a.end_time, a.timezone); hasEnd = true;
  }
  return { id: a.id, key: `${a.id}@${date}`, date, allDay: false, hasEnd, start, end };
}

/** Occurrences whose time span intersects [fromMs, toMs]. */
export function expandOccurrences(a, fromMs, toMs, viewTz, limit = 2000) {
  if (!a || a.schedule !== 'scheduled' || !a.start_date) return [];
  const out = [];
  for (const d of occurrenceDates(a)) {
    const occ = buildOccurrence(a, d, viewTz);
    if (occ.start > toMs) break;
    if (occ.end >= fromMs || occ.start >= fromMs) out.push(occ);
    if (out.length >= limit) break;
  }
  return out;
}

export function nextOccurrence(a, afterMs, viewTz) {
  const occ = expandOccurrences(a, afterMs, afterMs + 3660 * DAY_MS, viewTz, 1);
  return occ[0] || null;
}

/** Map of occurrence key -> array of overlapping occurrence keys (timed, non-cancelled only). */
export function findOverlaps(occs) {
  const timed = occs.filter((o) => !o.allDay).sort((x, y) => x.start - y.start);
  const res = new Map();
  for (let i = 0; i < timed.length; i++) {
    const a = timed[i]; const aEnd = Math.max(a.end, a.start + 60000);
    for (let j = i + 1; j < timed.length; j++) {
      const b = timed[j];
      if (b.start >= aEnd) break;
      if (a.id === b.id) continue;
      if (!res.has(a.key)) res.set(a.key, []);
      if (!res.has(b.key)) res.set(b.key, []);
      res.get(a.key).push(b.key); res.get(b.key).push(a.key);
    }
  }
  return res;
}
