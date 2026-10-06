// iCalendar (RFC 5545) export and a pragmatic importer.
import { zonedToUtc, addDays, utcToDateStr, utcToTimeStr, isValidTimeZone, isDateStr } from '../shared/time.js';

const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const unesc = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function fold(line) {
  const bytes = Buffer.from(line);
  if (bytes.length <= 75) return line;
  const parts = []; let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (parts.length ? 74 : 75)) { parts.push(cur); cur = ''; }
    cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}
const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateVal = (d) => d.replace(/-/g, '');
const localVal = (d, t) => `${dateVal(d)}T${t.replace(':', '')}00`;

export function activitiesToIcs(activities, { categories = [], calName = 'Docket', now = Date.now() } = {}) {
  const catName = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Docket//Personal Scheduler//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(calName)}`];
  for (const a of activities) {
    if (a.schedule !== 'scheduled' || !a.start_date || a.archived) continue;
    const recurring = a.recurrence && a.recurrence.freq !== 'none';
    L.push('BEGIN:VEVENT', `UID:${a.ics_uid || `${a.id}@docket`}`, `DTSTAMP:${utcStamp(now)}`);
    if (a.all_day || !a.start_time) {
      L.push(`DTSTART;VALUE=DATE:${dateVal(a.start_date)}`);
      L.push(`DTEND;VALUE=DATE:${dateVal(addDays(a.end_date || a.start_date, 1))}`);
    } else if (recurring) {
      L.push(`DTSTART;TZID=${a.timezone}:${localVal(a.start_date, a.start_time)}`);
      if (a.end_time) L.push(`DTEND;TZID=${a.timezone}:${localVal(a.end_date || a.start_date, a.end_time)}`);
    } else {
      const s = zonedToUtc(a.start_date, a.start_time, a.timezone);
      L.push(`DTSTART:${utcStamp(s)}`);
      if (a.end_time) L.push(`DTEND:${utcStamp(zonedToUtc(a.end_date || a.start_date, a.end_time, a.timezone))}`);
    }
    if (recurring) {
      const r = a.recurrence; const parts = [`FREQ=${r.freq.toUpperCase()}`];
      if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
      if (r.freq === 'weekly' && r.byweekday.length) parts.push(`BYDAY=${r.byweekday.map((d) => BYDAY[d]).join(',')}`);
      if (r.until) parts.push(a.all_day || !a.start_time ? `UNTIL=${dateVal(r.until)}` : `UNTIL=${utcStamp(zonedToUtc(r.until, '23:59', a.timezone))}`);
      if (r.count) parts.push(`COUNT=${r.count}`);
      L.push(`RRULE:${parts.join(';')}`);
      for (const ex of r.exdates || []) {
        L.push(a.all_day || !a.start_time ? `EXDATE;VALUE=DATE:${dateVal(ex)}` : `EXDATE;TZID=${a.timezone}:${localVal(ex, a.start_time)}`);
      }
    }
    L.push(`SUMMARY:${esc((a.kind === 'deadline' ? 'Deadline: ' : '') + a.title)}`);
    const desc = [a.description, a.notes && `Notes: ${a.notes}`,
      a.organizer && (a.organizer.name || a.organizer.email || a.organizer.phone) && `Organizer: ${[a.organizer.name, a.organizer.email, a.organizer.phone].filter(Boolean).join(', ')}`,
      a.meeting_url && `Meeting link: ${a.meeting_url}`,
      ...(a.links || []).map((l) => `${l.label || 'Link'}: ${l.url}`),
      a.checklist && a.checklist.length && `Preparation:\n${a.checklist.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.text}`).join('\n')}`,
    ].filter(Boolean).join('\n\n');
    if (desc) L.push(`DESCRIPTION:${esc(desc)}`);
    if (a.location) L.push(`LOCATION:${esc(a.location)}`);
    if (a.meeting_url) L.push(`URL:${esc(a.meeting_url)}`);
    L.push(`STATUS:${a.status === 'cancelled' ? 'CANCELLED' : a.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED'}`);
    L.push(`PRIORITY:${a.priority === 'high' ? 1 : a.priority === 'low' ? 9 : 5}`);
    if (a.category_id && catName[a.category_id]) L.push(`CATEGORIES:${esc(catName[a.category_id])}`);
    if (a.status !== 'cancelled') {
      for (const r of a.reminders || []) {
        L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(a.title)}`, `TRIGGER:-PT${r.minutes}M`, 'END:VALARM');
      }
    }
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

function parseProps(text) {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  return lines.filter(Boolean).map((line) => {
    const i = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const head = i >= 0 ? line.slice(0, i) : line; const value = i >= 0 ? line.slice(i + 1) : '';
    const [name, ...ps] = head.split(';');
    const params = {};
    for (const p of ps) { const [k, v = ''] = p.split('='); params[k.toUpperCase()] = v.replace(/^"|"$/g, ''); }
    return { name: name.toUpperCase(), params, value };
  });
}

function parseDt(prop, fallbackTz) {
  const v = prop.value.trim();
  if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    const d = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    return isDateStr(d) ? { allDay: true, date: d } : null;
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`, time = `${m[4]}:${m[5]}`;
  if (m[7]) {
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    return { allDay: false, date: utcToDateStr(ms, fallbackTz), time: utcToTimeStr(ms, fallbackTz), tz: fallbackTz };
  }
  const tz = prop.params.TZID && isValidTimeZone(prop.params.TZID) ? prop.params.TZID : fallbackTz;
  return { allDay: false, date, time, tz };
}

/** Parse VEVENTs into activity-shaped objects (without ids). Unsupported details are preserved in notes. */
export function parseIcs(text, { timezone }) {
  const props = parseProps(text);
  const events = []; let cur = null; let inAlarm = false;
  for (const p of props) {
    if (p.name === 'BEGIN' && p.value === 'VEVENT') { cur = { props: [], alarms: [] }; continue; }
    if (p.name === 'END' && p.value === 'VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    if (p.name === 'BEGIN' && p.value === 'VALARM') { inAlarm = true; cur.alarms.push({}); continue; }
    if (p.name === 'END' && p.value === 'VALARM') { inAlarm = false; continue; }
    if (inAlarm) { if (p.name === 'TRIGGER') cur.alarms[cur.alarms.length - 1].trigger = p.value; continue; }
    cur.props.push(p);
  }
  const out = [];
  for (const ev of events) {
    const get = (n) => ev.props.find((p) => p.name === n);
    const ds = get('DTSTART'); if (!ds) continue;
    const s = parseDt(ds, timezone); if (!s) continue;
    const de = get('DTEND'); const e = de ? parseDt(de, s.tz || timezone) : null;
    const a = {
      title: unesc((get('SUMMARY') || {}).value || 'Untitled event').slice(0, 200),
      description: unesc((get('DESCRIPTION') || {}).value || ''),
      location: unesc((get('LOCATION') || {}).value || ''),
      schedule: 'scheduled', kind: 'event', priority: 'medium',
      status: ((get('STATUS') || {}).value || '').toUpperCase() === 'TENTATIVE' ? 'tentative' : ((get('STATUS') || {}).value || '').toUpperCase() === 'CANCELLED' ? 'cancelled' : 'confirmed',
      ics_uid: ((get('UID') || {}).value || '').slice(0, 300),
      all_day: s.allDay, start_date: s.date, start_time: s.allDay ? '' : s.time, timezone: s.tz || timezone,
      end_date: '', end_time: '', notes: '', reminders: [], checklist: [], links: [],
    };
    const url = (get('URL') || {}).value;
    if (url && /^https?:\/\//.test(url)) a.meeting_url = url;
    if (e) {
      if (s.allDay && e.allDay) { const last = addDays(e.date, -1); if (last > s.date) a.end_date = last; }
      else if (!s.allDay && !e.allDay) {
        // express the end in the start's timezone
        const endMs = zonedToUtc(e.date, e.time, e.tz);
        a.end_date = utcToDateStr(endMs, a.timezone); a.end_time = utcToTimeStr(endMs, a.timezone);
        if (a.end_date === a.start_date) a.end_date = '';
      }
    }
    const rr = get('RRULE');
    if (rr) {
      const kv = Object.fromEntries(rr.value.split(';').map((x) => x.split('=')));
      const freq = (kv.FREQ || '').toLowerCase();
      const supported = ['daily', 'weekly', 'monthly', 'yearly'].includes(freq) && !kv.BYMONTHDAY && !kv.BYSETPOS && !kv.BYMONTH && !(kv.BYDAY && /\d/.test(kv.BYDAY)) && !(kv.BYDAY && freq !== 'weekly');
      if (supported) {
        a.recurrence = { freq, interval: +kv.INTERVAL || 1, byweekday: kv.BYDAY ? kv.BYDAY.split(',').map((d) => BYDAY.indexOf(d)).filter((x) => x >= 0) : [], until: '', count: kv.COUNT ? +kv.COUNT : null, exdates: [] };
        if (kv.UNTIL) { const u = kv.UNTIL; a.recurrence.until = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`; }
        for (const ex of ev.props.filter((p) => p.name === 'EXDATE')) {
          for (const v of ex.value.split(',')) { const d = parseDt({ value: v, params: ex.params }, a.timezone); if (d) a.recurrence.exdates.push(d.date); }
        }
      } else {
        a.notes = `Imported repeat rule could not be fully represented and was not applied: RRULE:${rr.value}`;
      }
    }
    for (const al of ev.alarms) {
      const m = /^-P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(al.trigger || '');
      if (m) a.reminders.push({ minutes: (+m[1] || 0) * 10080 + (+m[2] || 0) * 1440 + (+m[3] || 0) * 60 + (+m[4] || 0) });
    }
    out.push(a);
  }
  return out;
}
