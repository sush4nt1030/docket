import { useMemo, useRef, useEffect, useState } from 'react';
import { LuSearch, LuX, LuInbox, LuArchiveRestore, LuTrash2, LuArchive, LuPlus } from 'react-icons/lu';
import { useStore, patchActivity, deleteActivity, toast } from '../store.js';
import { ActivityRow } from './ActivityRow.jsx';
import { EmptyState, confirmDialog, CategoryTag } from './ui.jsx';
import { useRoute, replaceParams, occurrencesBetween, overlapMap, searchText, todayStr, addDays, zonedToUtc, weekStartOf, relDayLabel, formatDateStr, catOf, navigate, cx } from '../lib.js';
import { STATUSES, STATUS_LABELS, PRIORITIES, PRIORITY_LABELS } from '../../shared/model.js';
import { isDateStr } from '../../shared/time.js';

const RANGES = [
  { v: 'upcoming', l: 'Upcoming (next 12 months)' }, { v: 'today', l: 'Today' }, { v: 'week', l: 'This week' }, { v: 'next30', l: 'Next 30 days' },
  { v: 'month', l: 'This month' }, { v: 'past', l: 'Past (last 12 months)' }, { v: 'all', l: 'Everything (±12 months)' }, { v: 'custom', l: 'Custom dates…' },
];
const SORTS = [{ v: 'date', l: 'Date (soonest first)' }, { v: 'date-desc', l: 'Date (latest first)' }, { v: 'priority', l: 'Priority' }, { v: 'title', l: 'Title A–Z' }, { v: 'updated', l: 'Recently updated' }];
const PRI_RANK = { high: 0, medium: 1, low: 2 };

export function Agenda() {
  const { params } = useRoute();
  const activities = useStore((s) => s.activities);
  const settings = useStore((s) => s.settings);
  const categories = useStore((s) => s.categories);
  const searchRef = useRef(null);
  const [limit, setLimit] = useState(150);
  const tz = settings.timezone; const today = todayStr(tz); const now = Date.now();
  const q = params.q || ''; const cat = params.cat || ''; const pri = params.pri || ''; const status = params.status || ''; const kind = params.kind || '';
  const rangeV = params.range || 'upcoming'; const sort = params.sort || (rangeV === 'past' ? 'date-desc' : 'date');
  const onlyOverlaps = params.overlaps === '1';

  useEffect(() => {
    const k = (e) => { if (e.key === '/' && !e.target.closest('input,textarea,select')) { e.preventDefault(); searchRef.current && searchRef.current.focus(); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);

  const [from, to] = useMemo(() => {
    const d0 = (d) => zonedToUtc(d, '00:00', tz);
    switch (rangeV) {
      case 'today': return [d0(today), d0(addDays(today, 1)) - 1];
      case 'week': { const ws = weekStartOf(today, settings.weekStart); return [d0(ws), d0(addDays(ws, 7)) - 1]; }
      case 'next30': return [now, d0(addDays(today, 31))];
      case 'month': { const m = today.slice(0, 8) + '01'; const n = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 1)).toISOString().slice(0, 10); return [d0(m), d0(n) - 1]; }
      case 'past': return [d0(addDays(today, -365)), now];
      case 'all': return [d0(addDays(today, -365)), d0(addDays(today, 366))];
      case 'custom': return [d0(isDateStr(params.from || '') ? params.from : today), d0(addDays(isDateStr(params.to || '') ? params.to : addDays(today, 30), 1)) - 1];
      default: return [now - 3600000, d0(addDays(today, 366))];
    }
  }, [rangeV, today, params.from, params.to, settings.weekStart, Math.floor(now / 60000)]);

  const filterA = (a) => {
    if (cat && (cat === 'none' ? a.category_id : a.category_id !== cat)) return false;
    if (pri && a.priority !== pri) return false;
    if (status && a.status !== status) return false;
    if (kind && a.kind !== kind) return false;
    if (q && !searchText(a, categories).includes(q.toLowerCase())) return false;
    return true;
  };
  const { list, tbd, overlaps, total } = useMemo(() => {
    const all = occurrencesBetween(activities, from, to, settings, {});
    const overlaps = overlapMap(all);
    let list = all.filter(({ a }) => filterA(a));
    if (rangeV === 'upcoming') list = list.filter(({ occ }) => occ.end >= now || occ.start >= now);
    if (onlyOverlaps) list = list.filter(({ occ }) => overlaps.has(occ.key));
    const cmp = {
      date: (x, y) => x.occ.start - y.occ.start, 'date-desc': (x, y) => y.occ.start - x.occ.start,
      priority: (x, y) => PRI_RANK[x.a.priority] - PRI_RANK[y.a.priority] || x.occ.start - y.occ.start,
      title: (x, y) => x.a.title.localeCompare(y.a.title) || x.occ.start - y.occ.start,
      updated: (x, y) => (y.a.updated_at || 0) - (x.a.updated_at || 0) || x.occ.start - y.occ.start,
    }[sort] || ((x, y) => x.occ.start - y.occ.start);
    list.sort(cmp);
    const tbd = ['upcoming', 'all'].includes(rangeV) && !onlyOverlaps ? Object.values(activities).filter((a) => !a.archived && a.schedule === 'tbd' && filterA(a)) : [];
    return { list, tbd, overlaps, total: list.length };
  }, [activities, from, to, settings, q, cat, pri, status, kind, sort, onlyOverlaps, categories]);

  const grouped = sort.startsWith('date');
  const shown = list.slice(0, limit);
  const groups = [];
  if (grouped) for (const it of shown) { const g = groups[groups.length - 1]; if (g && g.date === it.occ.date) g.items.push(it); else groups.push({ date: it.occ.date, items: [it] }); }
  const activeFilters = [q, cat, pri, status, kind, onlyOverlaps].filter(Boolean).length;

  return (
    <div className="agenda">
      <header className="page-head"><div><h1>Agenda</h1><p className="muted">{total} occurrence{total === 1 ? '' : 's'}{tbd.length ? ` · ${tbd.length} awaiting date` : ''}</p></div></header>
      <div className="filters card">
        <div className="search-box">
          <LuSearch aria-hidden="true" />
          <input ref={searchRef} className="input" type="search" placeholder="Search title, notes, location, people…  ( / )" aria-label="Search activities" value={q} onChange={(e) => replaceParams({ q: e.target.value })} />
        </div>
        <div className="filter-row">
          <select className="input" aria-label="Date range" value={rangeV} onChange={(e) => replaceParams({ range: e.target.value, sort: '' })}>{RANGES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}</select>
          {rangeV === 'custom' && <>
            <input type="date" className="input" aria-label="From date" value={params.from || today} onChange={(e) => replaceParams({ from: e.target.value })} />
            <input type="date" className="input" aria-label="To date" value={params.to || addDays(today, 30)} onChange={(e) => replaceParams({ to: e.target.value })} />
          </>}
          <select className="input" aria-label="Category" value={cat} onChange={(e) => replaceParams({ cat: e.target.value })}><option value="">All categories</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}<option value="none">Uncategorized</option></select>
          <select className="input" aria-label="Priority" value={pri} onChange={(e) => replaceParams({ pri: e.target.value })}><option value="">Any priority</option>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}</select>
          <select className="input" aria-label="Status" value={status} onChange={(e) => replaceParams({ status: e.target.value })}><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}</select>
          <select className="input" aria-label="Type" value={kind} onChange={(e) => replaceParams({ kind: e.target.value })}><option value="">Events & deadlines</option><option value="event">Events only</option><option value="deadline">Deadlines only</option></select>
          <select className="input" aria-label="Sort by" value={sort} onChange={(e) => replaceParams({ sort: e.target.value })}>{SORTS.map((s) => <option key={s.v} value={s.v}>Sort: {s.l}</option>)}</select>
          <label className="check-inline"><input type="checkbox" checked={onlyOverlaps} onChange={(e) => replaceParams({ overlaps: e.target.checked ? '1' : '' })} /> Overlaps only</label>
          {activeFilters > 0 && <button className="btn btn-sm" onClick={() => replaceParams({ q: '', cat: '', pri: '', status: '', kind: '', overlaps: '' })}><LuX /> Clear filters</button>}
        </div>
      </div>

      {tbd.length > 0 && (
        <section className="agenda-group">
          <h2 className="group-head tbd-head">Date/time to be confirmed</h2>
          <div className="list">{tbd.map((a) => <ActivityRow key={a.id} a={a} />)}</div>
        </section>
      )}
      {list.length === 0 && tbd.length === 0 ? (
        <EmptyState icon={<LuInbox />} title={activeFilters ? 'No activities match these filters' : 'Nothing in this date range'}>
          {activeFilters ? 'Try clearing a filter or widening the date range.' : 'Choose a different range, or add a new activity.'}
        </EmptyState>
      ) : grouped ? groups.map((g) => (
        <section key={g.date} className="agenda-group" aria-label={formatDateStr(g.date, settings, { weekday: true })}>
          <h2 className={cx('group-head', g.date === today && 'is-today')}>{relDayLabel(g.date, today, settings)}{relDayLabel(g.date, today, settings) !== formatDateStr(g.date, settings, { weekday: true }) && <span className="muted"> · {formatDateStr(g.date, settings, { weekday: true })}</span>}</h2>
          <div className="list">{g.items.map(({ a, occ }) => <ActivityRow key={occ.key} a={a} occ={occ} overlap={overlaps.has(occ.key)} />)}</div>
        </section>
      )) : <div className="list">{shown.map(({ a, occ }) => <ActivityRow key={occ.key} a={a} occ={occ} showDate overlap={overlaps.has(occ.key)} />)}</div>}
      {list.length > limit && <button className="btn mt" onClick={() => setLimit(limit + 150)}>Show more ({list.length - limit} remaining)</button>}
    </div>
  );
}

export function PendingView({ onNew }) {
  const activities = useStore((s) => s.activities);
  const settings = useStore((s) => s.settings);
  const today = todayStr(settings.timezone);
  const list = Object.values(activities).filter((a) => !a.archived && a.schedule === 'tbd').sort((x, y) => (x.status === 'cancelled') - (y.status === 'cancelled') || (x.follow_up_date || '9999').localeCompare(y.follow_up_date || '9999') || x.created_at - y.created_at);
  return (
    <div>
      <header className="page-head"><div><h1>Awaiting confirmation</h1><p className="muted">Activities you know about but whose date or time isn’t confirmed yet. Follow up so nothing slips.</p></div>
        <button className="btn btn-primary" onClick={() => onNew({ schedule: 'tbd' })}><LuPlus /> Add unconfirmed activity</button></header>
      {list.length === 0 ? <EmptyState icon={<LuInbox />} title="Nothing waiting for a date">When you hear about an interview or event without a confirmed time, add it here so you remember to follow up.</EmptyState> :
        <div className="list">{list.map((a) => (
          <ActivityRow key={a.id} a={a} extra={<>
            {a.start_date && <span className="meta-item">Expected {formatDateStr(a.start_date, settings)}</span>}
            {a.follow_up_date && <span className={cx('meta-item', a.follow_up_date <= today && 'text-danger')}>Follow up {relDayLabel(a.follow_up_date, today, settings)}</span>}
            {a.tbd_note && <span className="meta-item note">“{a.tbd_note}”</span>}
          </>} />
        ))}</div>}
    </div>
  );
}

export function ArchiveView() {
  const activities = useStore((s) => s.activities);
  const categories = useStore((s) => s.categories);
  const settings = useStore((s) => s.settings);
  const list = Object.values(activities).filter((a) => a.archived).sort((x, y) => (y.updated_at || 0) - (x.updated_at || 0));
  return (
    <div>
      <header className="page-head"><div><h1>Archive</h1><p className="muted">Archived activities are hidden from the dashboard, calendar and reminders, but kept for reference.</p></div></header>
      {list.length === 0 ? <EmptyState icon={<LuArchive />} title="The archive is empty">Archive finished or irrelevant activities to declutter without deleting them.</EmptyState> :
        <div className="list">{list.map((a) => (
          <div key={a.id} className="archive-row">
            <button className="link-btn grow left" onClick={() => navigate(`/activity/${a.id}`)}><strong>{a.title}</strong> <span className="muted small">{a.start_date ? formatDateStr(a.start_date, settings) : 'No date'}</span></button>
            <CategoryTag cat={catOf(categories, a.category_id)} small />
            <button className="btn btn-sm" onClick={() => { patchActivity(a.id, { archived: false }); toast('Restored'); }}><LuArchiveRestore /> Unarchive</button>
            <button className="btn btn-sm btn-danger-ghost" onClick={async () => { if (await confirmDialog({ title: 'Delete permanently?', message: `“${a.title}” will be permanently deleted. This cannot be undone.`, confirmLabel: 'Delete', danger: true })) { deleteActivity(a.id).catch((e) => toast(e.message, { kind: 'error' })); toast('Deleted'); } }}><LuTrash2 /> Delete</button>
          </div>
        ))}</div>}
    </div>
  );
}
