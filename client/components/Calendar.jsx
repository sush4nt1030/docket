import { useEffect, useMemo, useRef } from 'react';
import { LuChevronLeft, LuChevronRight, LuPlus, LuTriangleAlert, LuFlag, LuRepeat } from 'react-icons/lu';
import { useStore } from '../store.js';
import { Segmented } from './ui.jsx';
import { useRoute, replaceParams, navigate, todayStr, addDays, zonedToUtc, weekStartOf, occurrencesBetween, overlapMap, catOf, cx, formatTime, utcToDateStr, formatDateStr, timeLabel, useNow, useMediaQuery } from '../lib.js';
import { parseDate, dateStr, daysInMonth, isDateStr, diffDays, zonedParts } from '../../shared/time.js';
import { MONTHS_LONG, DAYS, formatHM } from '../../shared/format.js';

const HOUR_PX = 48;

export function CalendarView({ onNew }) {
  const route = useRoute();
  const settings = useStore((s) => s.settings);
  const activities = useStore((s) => s.activities);
  const categories = useStore((s) => s.categories);
  const narrow = useMediaQuery('(max-width: 700px)');
  const tz = settings.timezone;
  const today = todayStr(tz);
  const view = ['month', 'week', 'day'].includes(route.params.view) ? route.params.view : narrow ? 'day' : 'month';
  const cursor = isDateStr(route.params.date || '') ? route.params.date : today;
  const catFilter = route.params.cat || '';
  const ws = settings.weekStart;

  const range = useMemo(() => {
    if (view === 'month') {
      const { y, m } = parseDate(cursor); const first = dateStr(y, m, 1);
      const start = weekStartOf(first, ws); return { start, days: 42, first, y, m };
    }
    if (view === 'week') return { start: weekStartOf(cursor, ws), days: 7 };
    return { start: cursor, days: 1 };
  }, [view, cursor, ws]);
  const endDate = addDays(range.start, range.days);
  const fromMs = zonedToUtc(range.start, '00:00', tz); const toMs = zonedToUtc(endDate, '00:00', tz) - 1;

  const items = useMemo(() => occurrencesBetween(activities, fromMs, toMs, settings, { filter: catFilter ? (a) => a.category_id === catFilter : undefined }), [activities, fromMs, toMs, settings, catFilter]);
  const overlaps = useMemo(() => overlapMap(items), [items]);
  const tbdDated = useMemo(() => Object.values(activities).filter((a) => !a.archived && a.schedule === 'tbd' && a.start_date && a.start_date >= range.start && a.start_date < endDate && (!catFilter || a.category_id === catFilter)), [activities, range.start, endDate, catFilter]);

  const go = (dir) => {
    if (dir === 0) return replaceParams({ date: today });
    if (view === 'month') { const { y, m } = parseDate(cursor); const idx = y * 12 + m - 1 + dir; const ny = Math.floor(idx / 12), nm = idx % 12 + 1; return replaceParams({ date: dateStr(ny, nm, Math.min(parseDate(cursor).d, daysInMonth(ny, nm))) }); }
    replaceParams({ date: addDays(cursor, dir * (view === 'week' ? 7 : 1)) });
  };
  const title = view === 'month' ? `${MONTHS_LONG[range.m - 1]} ${range.y}`
    : view === 'week' ? `${formatDateStr(range.start, settings)} – ${formatDateStr(addDays(range.start, 6), settings)}`
      : formatDateStr(cursor, settings, { weekday: true });

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input,textarea,select,[role=dialog]')) return;
      if (e.key === 'ArrowLeft' && e.altKey) go(-1); if (e.key === 'ArrowRight' && e.altKey) go(1);
      if (e.key === 't' && !e.metaKey && !e.ctrlKey) go(0);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="calendar">
      <header className="cal-toolbar">
        <div className="row gap">
          <button className="btn" onClick={() => go(0)}>Today</button>
          <div className="btn-group">
            <button className="icon-btn" onClick={() => go(-1)} aria-label={`Previous ${view}`} title="Previous (Alt+←)"><LuChevronLeft /></button>
            <button className="icon-btn" onClick={() => go(1)} aria-label={`Next ${view}`} title="Next (Alt+→)"><LuChevronRight /></button>
          </div>
          <h1 className="cal-title" aria-live="polite">{title}</h1>
        </div>
        <div className="row gap wrap">
          <select className="input w-auto" aria-label="Filter by category" value={catFilter} onChange={(e) => replaceParams({ cat: e.target.value })}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Segmented label="Calendar view" value={view} onChange={(v) => replaceParams({ view: v })} options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }, { value: 'day', label: 'Day' }]} />
          <button className="btn btn-primary" onClick={() => onNew({ start_date: view === 'month' ? (cursor) : cursor })}><LuPlus /> New</button>
        </div>
      </header>
      {view === 'month'
        ? <MonthGrid range={range} items={items} tbd={tbdDated} overlaps={overlaps} settings={settings} categories={categories} today={today} onNew={onNew} />
        : <TimeGrid start={range.start} days={range.days} items={items} tbd={tbdDated} overlaps={overlaps} settings={settings} categories={categories} today={today} onNew={onNew} />}
      <p className="cal-legend muted small">Times shown in {tz}. <span className="legend-item"><LuTriangleAlert aria-hidden="true" /> overlapping</span> <span className="legend-item"><span className="legend-tbd" /> time to be confirmed</span> <span className="legend-item"><s>Cancelled</s></span></p>
    </div>
  );
}

function dayKeysFor(occ, tz, start, end) {
  if (occ.allDay) {
    const out = []; let d = occ.date < start ? start : occ.date; const last = occ.endDate || occ.date;
    while (d <= last && d < end) { out.push(d); d = addDays(d, 1); }
    return out;
  }
  const s = utcToDateStr(occ.start, tz); const e = utcToDateStr(Math.max(occ.start, occ.end - 1), tz);
  const out = []; let d = s < start ? start : s;
  while (d <= e && d < end) { out.push(d); d = addDays(d, 1); }
  return out;
}

function Chip({ a, occ, overlap, settings, categories, tbd }) {
  const cat = catOf(categories, a.category_id);
  const cancelled = a.status === 'cancelled';
  const label = tbd ? 'Time TBC' : occ.allDay ? (a.kind === 'deadline' ? 'Due' : '') : formatTime(occ.start, settings.timezone, settings);
  return (
    <button className={cx('cal-chip', occ && occ.allDay && 'allday', tbd && 'tbd', cancelled && 'cancelled', (a.status === 'completed' || a.status === 'missed') && 'faded', a.status === 'tentative' && 'tentative')}
      style={{ '--cat': cat ? cat.color : 'var(--muted-2)' }}
      onClick={(e) => { e.stopPropagation(); navigate(`/activity/${a.id}`, occ && a.recurrence && a.recurrence.freq !== 'none' ? { on: occ.date } : undefined); }}
      title={`${a.title} — ${tbd ? 'time to be confirmed' : timeLabel(a, occ, settings)}${cat ? ` · ${cat.name}` : ''}${overlap ? ' · overlaps another activity' : ''}`}>
      {overlap && <LuTriangleAlert className="chip-warn" aria-label="Overlap" />}
      {a.kind === 'deadline' && <LuFlag aria-label="Deadline" />}
      {label && <span className="chip-time">{label}</span>}
      <span className="chip-title">{a.title}</span>
    </button>
  );
}

function MonthGrid({ range, items, tbd, overlaps, settings, categories, today, onNew }) {
  const tz = settings.timezone;
  const end = addDays(range.start, 42);
  const byDay = useMemo(() => {
    const m = {};
    for (const it of items) for (const d of dayKeysFor(it.occ, tz, range.start, end)) (m[d] = m[d] || []).push(it);
    for (const a of tbd) (m[a.start_date] = m[a.start_date] || []).push({ a, occ: { key: `tbd-${a.id}`, date: a.start_date, allDay: true }, tbd: true });
    for (const k in m) m[k].sort((x, y) => (y.occ.allDay ? 1 : 0) - (x.occ.allDay ? 1 : 0) || (x.occ.start || 0) - (y.occ.start || 0));
    return m;
  }, [items, tbd, range.start]);
  const ws = settings.weekStart;
  const headers = Array.from({ length: 7 }, (_, i) => DAYS[(ws + i) % 7]);
  return (
    <div className="month" role="grid" aria-label="Month">
      <div className="month-head" role="row">{headers.map((h) => <div key={h} role="columnheader" className="month-hcell">{h}</div>)}</div>
      <div className="month-body">
        {Array.from({ length: 6 }, (_, w) => (
          <div className="month-row" role="row" key={w}>
            {Array.from({ length: 7 }, (_, i) => {
              const d = addDays(range.start, w * 7 + i);
              const list = byDay[d] || [];
              const outside = parseDate(d).m !== range.m;
              const max = 3;
              return (
                <div key={d} role="gridcell" className={cx('month-cell', outside && 'outside', d === today && 'today', d < today && 'past')} onDoubleClick={() => onNew({ start_date: d })}>
                  <div className="cell-head">
                    <button className="day-num" onClick={() => navigate('/calendar', { view: 'day', date: d })} aria-label={`${formatDateStr(d, settings, { weekday: true })}, ${list.length} item${list.length === 1 ? '' : 's'}`}>{parseDate(d).d}</button>
                    <button className="cell-add" onClick={() => onNew({ start_date: d })} aria-label={`Add activity on ${formatDateStr(d, settings)}`} tabIndex={-1}><LuPlus /></button>
                  </div>
                  <div className="cell-items">
                    {list.slice(0, max).map((it) => <Chip key={it.occ.key + d} a={it.a} occ={it.occ} tbd={it.tbd} overlap={overlaps.has(it.occ.key)} settings={settings} categories={categories} />)}
                    {list.length > max && <button className="more-link" onClick={() => navigate('/calendar', { view: 'day', date: d })}>+{list.length - max} more</button>}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function layoutDay(segs) {
  segs.sort((a, b) => a.top - b.top || b.height - a.height);
  const out = []; let cluster = []; let clusterEnd = -1;
  const flush = () => {
    const cols = [];
    for (const s of cluster) {
      let c = cols.findIndex((end) => end <= s.top);
      if (c < 0) { c = cols.length; cols.push(0); }
      cols[c] = s.top + s.height; s.col = c;
    }
    for (const s of cluster) { s.cols = cols.length; out.push(s); }
    cluster = []; clusterEnd = -1;
  };
  for (const s of segs) {
    if (cluster.length && s.top >= clusterEnd) flush();
    cluster.push(s); clusterEnd = Math.max(clusterEnd, s.top + s.height);
  }
  if (cluster.length) flush();
  return out;
}

function TimeGrid({ start, days, items, tbd, overlaps, settings, categories, today, onNew }) {
  const tz = settings.timezone;
  const scroller = useRef(null);
  const now = useNow(60000);
  const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
  const end = addDays(start, days);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX - 8; }, [start, days]);

  const { allDay, timed } = useMemo(() => {
    const allDay = {}; const timed = {};
    for (const it of items) {
      if (it.occ.allDay) { for (const d of dayKeysFor(it.occ, tz, start, end)) (allDay[d] = allDay[d] || []).push(it); continue; }
      for (const d of dayKeysFor(it.occ, tz, start, end)) {
        const ds = zonedToUtc(d, '00:00', tz); const de = zonedToUtc(addDays(d, 1), '00:00', tz);
        const s = Math.max(it.occ.start, ds); const e = it.occ.hasEnd ? Math.min(it.occ.end, de) : s + 30 * 60000;
        const top = (s - ds) / 60000 * HOUR_PX / 60;
        const height = Math.max(22, (e - s) / 60000 * HOUR_PX / 60);
        (timed[d] = timed[d] || []).push({ ...it, top, height, continues: it.occ.end > de, continued: it.occ.start < ds });
      }
    }
    for (const a of tbd) (allDay[a.start_date] = allDay[a.start_date] || []).push({ a, occ: { key: `tbd-${a.id}`, date: a.start_date, allDay: true }, tbd: true });
    for (const d in timed) timed[d] = layoutDay(timed[d]);
    return { allDay, timed };
  }, [items, tbd, start, days, tz]);

  const nowParts = zonedParts(now, tz);
  const nowTop = (nowParts.hour * 60 + nowParts.minute) * HOUR_PX / 60;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const clickSlot = (d, e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mins = Math.max(0, Math.min(23 * 60 + 30, Math.floor((e.clientY - rect.top) / HOUR_PX * 2) * 30));
    const hh = String(Math.floor(mins / 60)).padStart(2, '0'), mm = String(mins % 60).padStart(2, '0');
    const endM = Math.min(mins + 60, 23 * 60 + 59); const eh = String(Math.floor(endM / 60)).padStart(2, '0'), em = String(endM % 60).padStart(2, '0');
    onNew({ start_date: d, start_time: `${hh}:${mm}`, end_time: `${eh}:${em}` });
  };
  return (
    <div className={cx('timegrid', days === 1 && 'single')}>
      <div className="tg-head" style={{ '--days': days }}>
        <div className="tg-gutter" />
        {dates.map((d) => (
          <button key={d} className={cx('tg-dayhead', d === today && 'today')} onClick={() => navigate('/calendar', { view: 'day', date: d })}>
            <span className="tg-dow">{DAYS[new Date(d + 'T00:00:00Z').getUTCDay()]}</span><span className="tg-dnum">{parseDate(d).d}</span>
          </button>
        ))}
      </div>
      <div className="tg-allday" style={{ '--days': days }}>
        <div className="tg-gutter small muted">all-day</div>
        {dates.map((d) => <div key={d} className="tg-allday-cell">{(allDay[d] || []).map((it) => <Chip key={it.occ.key + d} a={it.a} occ={it.occ} tbd={it.tbd} overlap={false} settings={settings} categories={categories} />)}</div>)}
      </div>
      <div className="tg-scroll" ref={scroller}>
        <div className="tg-body" style={{ '--days': days, height: 24 * HOUR_PX }}>
          <div className="tg-gutter">{hours.map((h) => <div key={h} className="tg-hour-label" style={{ top: h * HOUR_PX }}>{h === 0 ? '' : formatHM(h, 0, settings.timeFormat).replace(':00', '')}</div>)}</div>
          {dates.map((d) => (
            <div key={d} className={cx('tg-col', d === today && 'today')} onClick={(e) => { if (e.target === e.currentTarget) clickSlot(d, e); }} aria-label={`${formatDateStr(d, settings, { weekday: true })} timeline`}>
              {hours.map((h) => <div key={h} className="tg-line" style={{ top: h * HOUR_PX }} aria-hidden="true" />)}
              {d === today && <div className="tg-now" style={{ top: nowTop }} aria-label="Current time" />}
              {(timed[d] || []).map((s) => {
                const cat = catOf(categories, s.a.category_id);
                const ov = overlaps.has(s.occ.key);
                return (
                  <button key={s.occ.key} className={cx('tg-event', s.a.status === 'cancelled' && 'cancelled', (s.a.status === 'completed' || s.a.status === 'missed') && 'faded', s.a.status === 'tentative' && 'tentative', ov && 'overlap', s.a.kind === 'deadline' && 'deadline', s.height < 40 && 'short')}
                    style={{ top: s.top, height: s.height, left: `calc(${(s.col / s.cols) * 100}% + 2px)`, width: `calc(${100 / s.cols}% - 4px)`, '--cat': cat ? cat.color : 'var(--muted-2)' }}
                    onClick={() => navigate(`/activity/${s.a.id}`, s.a.recurrence && s.a.recurrence.freq !== 'none' ? { on: s.occ.date } : undefined)}
                    title={`${s.a.title} — ${timeLabel(s.a, s.occ, settings)}${ov ? ' · overlaps another activity' : ''}`}>
                    <span className="ev-title">{ov && <LuTriangleAlert aria-label="Overlap" />}{s.a.kind === 'deadline' && <LuFlag aria-label="Deadline" />}{s.a.title}</span>
                    <span className="ev-time">{timeLabel(s.a, s.occ, settings)}{s.a.recurrence && s.a.recurrence.freq !== 'none' ? ' · ↻' : ''}</span>
                    {s.height > 60 && s.a.location && <span className="ev-loc">{s.a.location}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
