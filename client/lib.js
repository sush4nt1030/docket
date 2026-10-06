import { useEffect, useState, useSyncExternalStore, useMemo } from 'react';
import { expandOccurrences, todayStr, addDays, zonedToUtc, dayOfWeek, findOverlaps, utcToDateStr, nextOccurrence, diffDays } from '../shared/time.js';
import { formatDateStr, formatTime, formatDate, formatDateTime, describeOccurrence, formatDuration, tzAbbrev, taskDueMs, formatTimeStr } from '../shared/format.js';
export { formatDateStr, formatTime, formatDate, formatDateTime, describeOccurrence, formatDuration, tzAbbrev, taskDueMs, formatTimeStr, todayStr, addDays, zonedToUtc, dayOfWeek, utcToDateStr, nextOccurrence, diffDays };

export const cx = (...a) => a.filter(Boolean).join(' ');

// ---------- hash router ----------
function readHash() {
  const h = (location.hash || '#/').slice(1);
  const [p, q = ''] = h.split('?');
  return { path: p || '/', params: Object.fromEntries(new URLSearchParams(q)), raw: h };
}
let route = readHash();
const routeListeners = new Set();
window.addEventListener('hashchange', () => { route = readHash(); routeListeners.forEach((l) => l()); });
export function useRoute() { return useSyncExternalStore((l) => { routeListeners.add(l); return () => routeListeners.delete(l); }, () => route); }
export function navigate(path, params) {
  const q = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  location.hash = `#${path}${q ? `?${q}` : ''}`;
}
export function replaceParams(params) {
  const r = readHash();
  const q = new URLSearchParams(Object.entries({ ...r.params, ...params }).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  history.replaceState(null, '', `#${r.path}${q ? `?${q}` : ''}`);
  route = readHash(); routeListeners.forEach((l) => l());
}

export function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export const isActiveStatus = (s) => s === 'tentative' || s === 'confirmed';
export const catOf = (cats, id) => cats.find((c) => c.id === id) || null;

/** All occurrences of non-archived scheduled activities in [from, to]. */
export function occurrencesBetween(activities, from, to, settings, { includeInactive = true, includeArchived = false, filter } = {}) {
  const out = [];
  for (const a of Object.values(activities)) {
    if (!includeArchived && a.archived) continue;
    if (!includeInactive && !isActiveStatus(a.status)) continue;
    if (filter && !filter(a)) continue;
    for (const occ of expandOccurrences(a, from, to, settings.timezone, 1000)) out.push({ a, occ });
  }
  return out.sort((x, y) => x.occ.start - y.occ.start || (y.occ.allDay ? 1 : 0) - (x.occ.allDay ? 1 : 0) || x.a.title.localeCompare(y.a.title));
}

export function useOccurrences(activities, from, to, settings, opts) {
  return useMemo(() => occurrencesBetween(activities, from, to, settings, opts), [activities, from, to, settings.timezone, opts && opts.includeInactive, opts && opts.includeArchived]);
}

/** Overlap map limited to activities that are not cancelled/completed. */
export function overlapMap(items) {
  return findOverlaps(items.filter(({ a }) => a.status !== 'cancelled' && a.status !== 'missed' && !a.archived).map(({ occ }) => occ));
}

export function dayBounds(date, tz) { return [zonedToUtc(date, '00:00', tz), zonedToUtc(addDays(date, 1), '00:00', tz) - 1]; }
export function weekStartOf(date, weekStart) { const dow = dayOfWeek(date); return addDays(date, -((dow - weekStart + 7) % 7)); }

export function relDayLabel(date, today, settings) {
  const d = diffDays(date, today);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  return formatDateStr(date, settings, { weekday: true });
}

export function timeLabel(a, occ, settings) {
  if (occ.allDay) return a.kind === 'deadline' ? 'Due (all day)' : 'All day';
  const t = formatTime(occ.start, settings.timezone, settings);
  if (a.kind === 'deadline') return `Due ${t}`;
  return occ.hasEnd ? `${t} – ${formatTime(occ.end, settings.timezone, settings)}` : t;
}

export const TIMEZONES = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'Asia/Kathmandu']; } })();
export const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } };

export function fileSize(n) { if (n < 1024) return `${n} B`; if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`; return `${(n / 1048576).toFixed(1)} MB`; }

export function searchText(a, cats) {
  const c = catOf(cats, a.category_id);
  return [a.title, a.description, a.notes, a.location, a.tbd_note, a.organizer && a.organizer.name, a.organizer && a.organizer.email, c && c.name, ...(a.checklist || []).map((t) => t.text)].filter(Boolean).join(' ').toLowerCase();
}

export function useMediaQuery(q) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, [q]);
  return m;
}

export function downloadUrl(url) { const a = document.createElement('a'); a.href = url; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); }
