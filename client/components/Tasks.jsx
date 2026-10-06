import { useMemo, useState } from 'react';
import { LuListChecks } from 'react-icons/lu';
import { useStore, patchActivity } from '../store.js';
import { EmptyState, Segmented, CategoryTag } from './ui.jsx';
import { taskDueMs, formatDateStr, formatDuration, navigate, cx, catOf, isActiveStatus, useNow } from '../lib.js';
import { expandOccurrences } from '../../shared/time.js';

export function TasksView() {
  const activities = useStore((s) => s.activities);
  const settings = useStore((s) => s.settings);
  const categories = useStore((s) => s.categories);
  const now = useNow(60000);
  const [show, setShow] = useState('open');

  const groups = useMemo(() => {
    const g = { overdue: [], soon: [], later: [], nodate: [], done: [] };
    for (const a of Object.values(activities)) {
      if (a.archived) continue;
      const next = a.schedule === 'scheduled' ? expandOccurrences(a, now, now + 400 * 864e5, settings.timezone, 1)[0] : null;
      for (const t of a.checklist || []) {
        const due = taskDueMs(a, t, settings);
        const it = { a, t, due, eventAt: next ? next.start : null };
        if (t.done) g.done.push(it);
        else if (!isActiveStatus(a.status)) continue;
        else if (due && due < now) g.overdue.push(it);
        else if (due && due < now + 7 * 864e5) g.soon.push(it);
        else if (due) g.later.push(it);
        else g.nodate.push(it);
      }
    }
    const by = (x, y) => (x.due ?? x.eventAt ?? Infinity) - (y.due ?? y.eventAt ?? Infinity);
    Object.values(g).forEach((l) => l.sort(by));
    g.done.sort((x, y) => (y.t.done_at || 0) - (x.t.done_at || 0));
    return g;
  }, [activities, settings, Math.floor(now / 60000)]);

  const toggle = (a, t) => patchActivity(a.id, { checklist: a.checklist.map((x) => (x.id === t.id ? { ...x, done: !x.done, done_at: !x.done ? Date.now() : null } : x)) });
  const section = (key, title, items, tone) => items.length > 0 && (
    <section className="card" key={key} aria-labelledby={`tg-${key}`}>
      <h2 id={`tg-${key}`} className={cx('task-group-title', tone)}>{title} <span className="muted">({items.length})</span></h2>
      <ul className="task-list big">
        {items.map(({ a, t, due, eventAt }) => (
          <li key={t.id} className={cx(t.done && 'done')}>
            <label><input type="checkbox" checked={t.done} onChange={() => toggle(a, t)} /> <span>{t.text}</span></label>
            <span className={cx('small', key === 'overdue' ? 'text-danger' : 'muted')}>
              {due ? `${formatDateStr(t.due_date, settings, { weekday: true })}${t.due_time ? ` ${t.due_time}` : ''} · ${due < now ? `${formatDuration(due - now)}` : `in ${formatDuration(due - now)}`}` : eventAt ? `before event (${formatDuration(eventAt - now)})` : t.done ? 'done' : 'no due date'}
            </span>
            <button className="link-btn small" onClick={() => navigate(`/activity/${a.id}`)}>{a.title}</button>
            <CategoryTag cat={catOf(categories, a.category_id)} small />
          </li>
        ))}
      </ul>
    </section>
  );
  const openCount = groups.overdue.length + groups.soon.length + groups.later.length + groups.nodate.length;
  return (
    <div>
      <header className="page-head"><div><h1>Preparation tasks</h1><p className="muted">Checklist items from all your activities. Add tasks inside an activity.</p></div>
        <Segmented label="Show" value={show} onChange={setShow} options={[{ value: 'open', label: `Open (${openCount})` }, { value: 'done', label: `Done (${groups.done.length})` }]} /></header>
      {show === 'open' ? (openCount === 0 ? <EmptyState icon={<LuListChecks />} title="No open preparation tasks">Open an activity and add checklist items like “print CV” or “prepare questions”.</EmptyState> :
        <div className="stack">{section('overdue', 'Overdue', groups.overdue, 'text-danger')}{section('soon', 'Due in the next 7 days', groups.soon)}{section('later', 'Due later', groups.later)}{section('nodate', 'No due date', groups.nodate)}</div>)
        : (groups.done.length ? <div className="stack">{section('done', 'Completed', groups.done)}</div> : <EmptyState icon={<LuListChecks />} title="No completed tasks yet" />)}
    </div>
  );
}
