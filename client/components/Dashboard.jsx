import { useMemo, useState, useEffect } from 'react';
import { LuCalendarDays, LuFlag, LuListChecks, LuHourglass, LuTriangleAlert, LuCircleAlert, LuPlus, LuSparkles, LuArrowRight, LuVideo, LuMapPin } from 'react-icons/lu';
import { useStore, patchActivity, api, toast } from '../store.js';
import { ActivityRow } from './ActivityRow.jsx';
import { EmptyState, CategoryTag } from './ui.jsx';
import { occurrencesBetween, overlapMap, todayStr, addDays, zonedToUtc, weekStartOf, navigate, formatDuration, formatDateStr, timeLabel, relDayLabel, catOf, isActiveStatus, taskDueMs, cx, describeOccurrence, useNow } from '../lib.js';
import { expandOccurrences } from '../../shared/time.js';

export function Dashboard({ onNew }) {
  const activities = useStore((s) => s.activities);
  const settings = useStore((s) => s.settings);
  const categories = useStore((s) => s.categories);
  const user = useStore((s) => s.user);
  const now = useNow(30000);
  const tz = settings.timezone;
  const today = todayStr(tz, now);
  const minuteKey = Math.floor(now / 60000);

  const d = useMemo(() => {
    const dayStart = zonedToUtc(today, '00:00', tz);
    const tomorrow = addDays(today, 1);
    const dayEnd = zonedToUtc(tomorrow, '00:00', tz) - 1;
    const weekEndDate = addDays(weekStartOf(today, settings.weekStart), 7);
    const weekEnd = zonedToUtc(weekEndDate, '00:00', tz) - 1;
    const horizon = zonedToUtc(addDays(today, 30), '00:00', tz);
    const items = occurrencesBetween(activities, dayStart - 864e5, horizon, settings, { includeInactive: true });
    const overlaps = overlapMap(items);
    const active = items.filter(({ a }) => isActiveStatus(a.status));
    const todayItems = items.filter(({ occ }) => occ.start <= dayEnd && occ.end >= dayStart && !(occ.allDay && occ.endDate < today));
    const next = active.find(({ occ }) => !occ.allDay && occ.start > now) || null;
    const ongoing = active.filter(({ occ }) => !occ.allDay && occ.start <= now && occ.end > now);
    const week = active.filter(({ occ }) => occ.start > dayEnd && occ.start <= weekEnd);
    const upcoming = active.filter(({ occ }) => occ.start > dayEnd && occ.start > weekEnd).slice(0, 8);
    const deadlines = active.filter(({ a, occ }) => a.kind === 'deadline' && occ.end >= now && occ.start <= zonedToUtc(addDays(today, 14), '00:00', tz)).slice(0, 8);
    const conflictCount = new Set([...overlaps.keys()].filter((k) => items.some(({ occ }) => occ.key === k && occ.start >= now))).size;

    // preparation tasks for activities that are still active
    const prep = []; const overdueTasks = [];
    for (const a of Object.values(activities)) {
      if (a.archived || !isActiveStatus(a.status)) continue;
      const nextOcc = a.schedule === 'scheduled' ? expandOccurrences(a, now, now + 400 * 864e5, tz, 1)[0] : null;
      for (const t of a.checklist || []) {
        if (t.done) continue;
        const due = taskDueMs(a, t, settings);
        const item = { a, t, due, eventAt: nextOcc ? nextOcc.start : null };
        if (due && due < now) overdueTasks.push(item);
        else if (due || nextOcc || a.schedule === 'tbd') prep.push(item);
      }
    }
    prep.sort((x, y) => (x.due ?? x.eventAt ?? Infinity) - (y.due ?? y.eventAt ?? Infinity));
    overdueTasks.sort((x, y) => x.due - y.due);

    // past activities still marked tentative/confirmed (non-repeating) => ask whether they happened; plus recently missed
    const attention = []; const missed = [];
    for (const a of Object.values(activities)) {
      if (a.archived || a.schedule !== 'scheduled') continue;
      const rec = a.recurrence && a.recurrence.freq !== 'none';
      if (rec) continue;
      const occ = expandOccurrences(a, 0, Infinity, tz, 1)[0];
      if (!occ) continue;
      const ended = (occ.hasEnd || occ.allDay ? occ.end : occ.start) < now;
      if (ended && isActiveStatus(a.status) && now - occ.start < 60 * 864e5) attention.push({ a, occ });
      if (a.status === 'missed' && now - occ.start < 30 * 864e5) missed.push({ a, occ });
    }
    attention.sort((x, y) => y.occ.start - x.occ.start);
    const tbd = Object.values(activities).filter((a) => !a.archived && a.schedule === 'tbd' && a.status !== 'cancelled').sort((x, y) => (x.follow_up_date || '9').localeCompare(y.follow_up_date || '9'));
    return { todayItems, next, ongoing, week, upcoming, deadlines, prep: prep.slice(0, 8), prepTotal: prep.length, overdueTasks, attention, missed, tbd, overlaps, conflictCount, weekEndDate };
  }, [activities, settings, today, minuteKey]);

  const empty = Object.keys(activities).length === 0;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  if (empty) return <Welcome onNew={onNew} name={user && user.name} />;

  const toggleTask = (a, t) => patchActivity(a.id, { checklist: a.checklist.map((x) => (x.id === t.id ? { ...x, done: !x.done, done_at: !x.done ? Date.now() : null } : x)) });

  return (
    <div className="dash">
      <header className="page-head">
        <div>
          <h1>{greet}{user && user.name ? `, ${user.name.split(' ')[0]}` : ''}</h1>
          <p className="muted">{formatDateStr(today, settings, { weekday: true })} · {tz}</p>
        </div>
        <button className="btn btn-primary" onClick={() => onNew()}><LuPlus /> New activity</button>
      </header>

      <div className="dash-grid">
        <NextUp next={d.next} ongoing={d.ongoing} settings={settings} categories={categories} overlaps={d.overlaps} />

        <section className="card stat-strip" aria-label="Summary">
          <Stat n={d.todayItems.filter(({ a }) => isActiveStatus(a.status)).length} label="today" onClick={() => navigate('/calendar', { view: 'day', date: today })} />
          <Stat n={d.week.length} label="later this week" onClick={() => navigate('/calendar', { view: 'week', date: today })} />
          <Stat n={d.deadlines.length} label="deadlines (14 days)" tone={d.deadlines.length ? 'warn' : ''} onClick={() => navigate('/agenda', { kind: 'deadline' })} />
          <Stat n={d.prepTotal} label="prep tasks open" onClick={() => navigate('/tasks')} />
          <Stat n={d.tbd.length} label="awaiting confirmation" tone={d.tbd.length ? 'info' : ''} onClick={() => navigate('/pending')} />
          <Stat n={d.conflictCount} label="overlapping" tone={d.conflictCount ? 'danger' : ''} onClick={() => navigate('/agenda', { overlaps: '1' })} />
        </section>

        <section className="card span-2" aria-labelledby="h-today">
          <div className="card-head"><h2 id="h-today"><LuCalendarDays aria-hidden="true" /> Today’s agenda</h2><button className="link-btn" onClick={() => navigate('/calendar', { view: 'day', date: today })}>Day view <LuArrowRight aria-hidden="true" /></button></div>
          {d.todayItems.length ? <div className="list">{d.todayItems.map(({ a, occ }) => <ActivityRow key={occ.key} a={a} occ={occ} overlap={d.overlaps.has(occ.key)} />)}</div>
            : <p className="empty-line">Nothing scheduled today. <button className="link-btn" onClick={() => onNew({ start_date: today })}>Add something</button></p>}
        </section>

        {(d.overdueTasks.length > 0 || d.attention.length > 0 || d.missed.length > 0) && (
          <section className="card card-alert" aria-labelledby="h-att">
            <div className="card-head"><h2 id="h-att"><LuCircleAlert aria-hidden="true" /> Needs attention</h2></div>
            {d.overdueTasks.length > 0 && <>
              <h3 className="sub">Overdue preparation tasks</h3>
              <ul className="task-list">{d.overdueTasks.slice(0, 6).map(({ a, t, due }) => (
                <li key={t.id}><label><input type="checkbox" checked={false} onChange={() => toggleTask(a, t)} /> <span>{t.text}</span></label>
                  <span className="small text-danger">due {formatDuration(due - now)}</span>
                  <button className="link-btn small" onClick={() => navigate(`/activity/${a.id}`)}>{a.title}</button></li>
              ))}</ul>
            </>}
            {d.attention.length > 0 && <>
              <h3 className="sub">Past — did these happen?</h3>
              <ul className="task-list">{d.attention.slice(0, 6).map(({ a, occ }) => (
                <li key={a.id}><button className="link-btn" onClick={() => navigate(`/activity/${a.id}`)}>{a.title}</button>
                  <span className="small muted">{relDayLabel(occ.date, today, settings)}, {timeLabel(a, occ, settings)}</span>
                  <span className="row gap-sm"><button className="btn btn-xs" onClick={() => { patchActivity(a.id, { status: 'completed' }); toast('Marked completed'); }}>Completed</button><button className="btn btn-xs" onClick={() => { patchActivity(a.id, { status: 'missed' }); toast('Marked missed'); }}>Missed</button></span></li>
              ))}</ul>
            </>}
            {d.missed.length > 0 && <>
              <h3 className="sub">Missed recently</h3>
              <ul className="task-list">{d.missed.slice(0, 5).map(({ a, occ }) => (
                <li key={a.id}><button className="link-btn" onClick={() => navigate(`/activity/${a.id}`)}>{a.title}</button><span className="small muted">{relDayLabel(occ.date, today, settings)}</span></li>
              ))}</ul>
            </>}
          </section>
        )}

        <section className="card" aria-labelledby="h-week">
          <div className="card-head"><h2 id="h-week">Rest of this week</h2><button className="link-btn" onClick={() => navigate('/calendar', { view: 'week', date: today })}>Week <LuArrowRight aria-hidden="true" /></button></div>
          {d.week.length ? <div className="list">{d.week.map(({ a, occ }) => <ActivityRow key={occ.key} a={a} occ={occ} showDate compact overlap={d.overlaps.has(occ.key)} />)}</div> : <p className="empty-line">Nothing else this week.</p>}
        </section>

        <section className="card" aria-labelledby="h-dl">
          <div className="card-head"><h2 id="h-dl"><LuFlag aria-hidden="true" /> Approaching deadlines</h2></div>
          {d.deadlines.length ? <div className="list">{d.deadlines.map(({ a, occ }) => <ActivityRow key={occ.key} a={a} occ={occ} showDate compact extra={<span className={cx('meta-item', occ.start - now < 2 * 864e5 && 'text-danger')}>{occ.start > now ? `in ${formatDuration(occ.start - now)}` : 'today'}</span>} />)}</div> : <p className="empty-line">No deadlines in the next 14 days.</p>}
        </section>

        <section className="card" aria-labelledby="h-prep">
          <div className="card-head"><h2 id="h-prep"><LuListChecks aria-hidden="true" /> Pending preparation</h2><button className="link-btn" onClick={() => navigate('/tasks')}>All tasks <LuArrowRight aria-hidden="true" /></button></div>
          {d.prep.length ? <ul className="task-list">{d.prep.map(({ a, t, due, eventAt }) => (
            <li key={t.id}><label><input type="checkbox" checked={false} onChange={() => toggleTask(a, t)} /> <span>{t.text}</span></label>
              <span className="small muted">{due ? `due ${formatDuration(due - now).replace(' ago', '')}${due < now ? ' ago' : ''}` : eventAt ? `event in ${formatDuration(eventAt - now)}` : 'date TBC'}</span>
              <button className="link-btn small" onClick={() => navigate(`/activity/${a.id}`)}>{a.title}</button></li>
          ))}</ul> : <p className="empty-line">No open preparation tasks.</p>}
        </section>

        <section className="card" aria-labelledby="h-tbd">
          <div className="card-head"><h2 id="h-tbd"><LuHourglass aria-hidden="true" /> Waiting for date/time</h2><button className="link-btn" onClick={() => navigate('/pending')}>View all <LuArrowRight aria-hidden="true" /></button></div>
          {d.tbd.length ? <div className="list">{d.tbd.slice(0, 5).map((a) => <ActivityRow key={a.id} a={a} compact extra={a.follow_up_date ? <span className="meta-item">Follow up {relDayLabel(a.follow_up_date, today, settings)}</span> : null} />)}</div> : <p className="empty-line">Nothing waiting for confirmation.</p>}
        </section>

        <section className="card span-2" aria-labelledby="h-up">
          <div className="card-head"><h2 id="h-up">Coming up next</h2><button className="link-btn" onClick={() => navigate('/agenda')}>Agenda <LuArrowRight aria-hidden="true" /></button></div>
          {d.upcoming.length ? <div className="list">{d.upcoming.map(({ a, occ }) => <ActivityRow key={occ.key} a={a} occ={occ} showDate overlap={d.overlaps.has(occ.key)} />)}</div> : <p className="empty-line">Nothing scheduled after this week (next 30 days).</p>}
        </section>
      </div>
    </div>
  );
}

function Stat({ n, label, onClick, tone }) {
  return <button className={cx('stat', tone && `tone-${tone}`)} onClick={onClick}><span className="stat-n">{n}</span><span className="stat-l">{label}</span></button>;
}

function NextUp({ next, ongoing, settings, categories, overlaps }) {
  const now = useNow(1000);
  if (!next && !ongoing.length) {
    return <section className="card next-card empty-next" aria-label="Next event"><div className="next-label">Next up</div><div className="next-title">No upcoming timed activities</div><p className="muted">Enjoy the free time — or plan something.</p></section>;
  }
  const showOngoing = ongoing.length > 0;
  const { a, occ } = showOngoing ? ongoing[0] : next;
  const cat = catOf(categories, a.category_id);
  const ms = showOngoing ? occ.end - now : occ.start - now;
  const parts = countdownParts(ms);
  return (
    <section className="card next-card" aria-label="Next event countdown" style={{ '--cat': cat ? cat.color : 'var(--accent)' }}>
      <div className="next-label">{showOngoing ? 'Happening now' : a.kind === 'deadline' ? 'Next deadline' : 'Next up'}</div>
      <button className="next-title link-like" onClick={() => navigate(`/activity/${a.id}`)}>{a.title}</button>
      <div className="next-when">{describeOccurrence(a, occ, settings)}</div>
      <div className="row gap wrap mt-sm">
        <CategoryTag cat={cat} small />
        {overlaps.has(occ.key) && <span className="badge badge-warn"><LuTriangleAlert aria-hidden="true" /> Overlaps</span>}
        {a.location && <span className="meta-item"><LuMapPin aria-hidden="true" />{a.location}</span>}
      </div>
      <div className="countdown" role="timer" aria-live="off" aria-label={`${showOngoing ? 'Ends' : 'Starts'} in ${formatDuration(ms)}`}>
        {parts.map(([v, l]) => <div key={l} className="cd-part"><span className="cd-v">{v}</span><span className="cd-l">{l}</span></div>)}
        <div className="cd-caption">{showOngoing ? 'until it ends' : a.kind === 'deadline' ? 'until due' : 'until it starts'}</div>
      </div>
      {a.meeting_url && <a className="btn btn-primary btn-sm mt-sm" href={a.meeting_url} target="_blank" rel="noopener noreferrer"><LuVideo /> Join meeting</a>}
      {showOngoing && next && <p className="small muted mt-sm">Then: {next.a.title} at {timeLabel(next.a, next.occ, settings)}</p>}
    </section>
  );
}
function countdownParts(ms) {
  ms = Math.max(0, ms);
  const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4), s = Math.floor(ms % 6e4 / 1e3);
  return d > 0 ? [[d, d === 1 ? 'day' : 'days'], [h, 'hrs'], [m, 'min']] : [[h, 'hrs'], [m, 'min'], [s, 'sec']];
}

function Welcome({ onNew, name }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="welcome">
      <EmptyState icon={<LuSparkles />} title={`Welcome${name ? `, ${name.split(' ')[0]}` : ''}! Let’s capture your first commitment.`} action={
        <div className="row gap wrap center">
          <button className="btn btn-primary" onClick={() => onNew()}><LuPlus /> Add an activity</button>
          <button className="btn" onClick={() => onNew({ schedule: 'tbd' })}>Add one with an unconfirmed date</button>
          <button className="btn btn-ghost" disabled={busy} onClick={async () => { setBusy(true); try { await api('POST', '/api/sample-data'); toast('Sample data loaded — remove it any time in Settings › Data'); } catch (e) { toast(e.message, { kind: 'error' }); } setBusy(false); }}>{busy ? 'Loading…' : 'Explore with sample data'}</button>
        </div>
      }>
        Interviews, college programs, club meetings, volunteering, appointments and deadlines — add them here and Docket will remind you before each one, on every device you sign in to.
      </EmptyState>
      <ol className="welcome-steps">
        <li><strong>Add activities</strong> — even if the date isn’t confirmed yet.</li>
        <li><strong>Turn on notifications</strong> in Settings so reminders reach you when Docket is closed.</li>
        <li><strong>Prepare</strong> with checklists, links and files for each activity.</li>
      </ol>
    </div>
  );
}
