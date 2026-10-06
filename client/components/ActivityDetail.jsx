import { useEffect, useMemo, useState } from 'react';
import { LuPencil, LuCopy, LuArchive, LuArchiveRestore, LuTrash2, LuDownload, LuMapPin, LuVideo, LuUser, LuMail, LuPhone, LuLink, LuRepeat, LuTriangleAlert, LuBellRing, LuCalendarX, LuExternalLink, LuStickyNote, LuClock, LuCalendarClock } from 'react-icons/lu';
import { useStore, patchActivity, deleteActivity, duplicateActivity, toast, api } from '../store.js';
import { Modal, CategoryTag, StatusBadge, PriorityBadge, confirmDialog, EmptyState } from './ui.jsx';
import { describeRecurrence, Attachments } from './Editor.jsx';
import { catOf, navigate, describeOccurrence, formatDuration, formatDateStr, formatDateTime, occurrencesBetween, useNow, cx, timeLabel, relDayLabel, todayStr, downloadUrl, taskDueMs } from '../lib.js';
import { STATUSES, STATUS_LABELS, reminderLabel } from '../../shared/model.js';
import { expandOccurrences, findOverlaps, isDateStr, zonedToUtc } from '../../shared/time.js';

export function ActivityDetail({ id, onDate, onClose, onEdit }) {
  const a = useStore((s) => s.activities[id]);
  const activities = useStore((s) => s.activities);
  const settings = useStore((s) => s.settings);
  const categories = useStore((s) => s.categories);
  const phase = useStore((s) => s.phase);
  const now = useNow(30000);
  const [jobs, setJobs] = useState(null);
  useEffect(() => { if (a && a.version > 0) api('GET', `/api/activities/${id}/reminders`).then((d) => setJobs(d.jobs)).catch(() => setJobs(null)); }, [a && a.version, a && a.status]);

  const info = useMemo(() => {
    if (!a || a.schedule !== 'scheduled') return {};
    let occ = null;
    if (onDate && isDateStr(onDate)) { const t = zonedToUtc(onDate, '00:00', settings.timezone); occ = expandOccurrences(a, t - 2 * 864e5, t + 3 * 864e5, settings.timezone, 20).find((o) => o.date === onDate) || null; }
    if (!occ) occ = expandOccurrences(a, now, now + 3650 * 864e5, settings.timezone, 1)[0] || null;
    let last = null;
    if (!occ) { const all = expandOccurrences(a, 0, now, settings.timezone, 5000); last = all[all.length - 1] || null; }
    const target = occ || last;
    let overlaps = [];
    if (target && !target.allDay) {
      const others = occurrencesBetween(activities, target.start - 864e5, target.end + 864e5, settings, { filter: (x) => x.id !== a.id && x.status !== 'cancelled' && x.status !== 'missed' });
      const m = findOverlaps([target, ...others.map((o) => o.occ)]);
      overlaps = (m.get(target.key) || []).map((k) => others.find((o) => o.occ.key === k)).filter(Boolean);
    }
    return { occ: target, past: !occ, overlaps };
  }, [a, onDate, now, settings, activities]);

  if (!a) {
    return (
      <Modal open onClose={onClose} title="Activity" size="md">
        {phase === 'ready' ? <EmptyState icon={<LuCalendarX />} title="This activity doesn’t exist">It may have been deleted on another device.</EmptyState> : <p>Loading…</p>}
      </Modal>
    );
  }
  const cat = catOf(categories, a.category_id);
  const recurring = a.recurrence && a.recurrence.freq !== 'none';
  const occ = info.occ;
  const setStatus = (status) => { const r = patchActivity(a.id, { status }); if (r && r.errors) toast(Object.values(r.errors)[0], { kind: 'error' }); else toast(`Marked as ${STATUS_LABELS[status].toLowerCase()}${status === 'cancelled' ? ' — its reminders are stopped' : ''}`); };
  const toggleTask = (t) => patchActivity(a.id, { checklist: a.checklist.map((x) => (x.id === t.id ? { ...x, done: !x.done, done_at: !x.done ? Date.now() : null } : x)) });

  async function remove() {
    const ok = await confirmDialog({ title: 'Delete this activity?', message: <>“{a.title}”{recurring ? ' and all of its repeats' : ''} will be permanently deleted, including its reminders{a.attachments && a.attachments.length ? ' and attachments' : ''}. This cannot be undone. Consider archiving instead.</>, confirmLabel: 'Delete permanently', danger: true });
    if (!ok) return;
    deleteActivity(a.id).catch((err) => toast(`Delete failed: ${err.message}`, { kind: 'error' }));
    toast(`Deleted “${a.title}”`);
    onClose();
  }
  async function skipOccurrence() {
    const ok = await confirmDialog({ title: 'Skip this occurrence?', message: `Only ${formatDateStr(occ.date, settings, { weekday: true })} will be removed from the series. Other dates stay as they are.`, confirmLabel: 'Skip date' });
    if (ok) { patchActivity(a.id, { recurrence: { ...a.recurrence, exdates: [...(a.recurrence.exdates || []), occ.date] } }); toast('Occurrence skipped'); onClose(); }
  }
  const archive = () => { patchActivity(a.id, { archived: !a.archived }); toast(a.archived ? 'Restored from archive' : 'Archived — find it under Archive', { action: a.archived ? undefined : { label: 'Undo', onClick: () => patchActivity(a.id, { archived: false }) } }); if (!a.archived) onClose(); };
  const dup = () => { const nid = duplicateActivity(a.id); if (nid) { toast('Duplicated'); navigate(`/activity/${nid}`); onEdit(nid); } };

  const delta = occ ? occ.start - now : 0;
  const footer = (
    <div className="detail-actions">
      <button className="btn btn-primary" onClick={() => onEdit(a.id)}><LuPencil /> Edit</button>
      <button className="btn" onClick={() => onEdit(a.id, { focus: 'when' })}><LuCalendarClock /> Reschedule</button>
      <button className="btn" onClick={dup}><LuCopy /> Duplicate</button>
      <button className="btn" onClick={archive}>{a.archived ? <><LuArchiveRestore /> Unarchive</> : <><LuArchive /> Archive</>}</button>
      {a.schedule === 'scheduled' && <button className="btn" onClick={() => downloadUrl(`/api/activities/${a.id}/ics`)} disabled={a.version === 0}><LuDownload /> .ics</button>}
      <button className="btn btn-danger-ghost" onClick={remove}><LuTrash2 /> Delete</button>
    </div>
  );

  return (
    <Modal open onClose={onClose} size="md" className="detail" footer={footer} labelledBy="detail-title">
      <div className="detail-head" style={{ '--cat': cat ? cat.color : 'var(--muted-2)' }}>
        <div className="row gap wrap">
          <CategoryTag cat={cat} />
          <StatusBadge status={a.status} />
          <PriorityBadge priority={a.priority} />
          {a.kind === 'deadline' && <span className="badge badge-deadline">Deadline</span>}
          {a.is_sample && <span className="badge badge-sample">Sample data</span>}
          {a.archived && <span className="badge">Archived</span>}
        </div>
        <h2 id="detail-title" className="detail-title">{a.title}</h2>
        <button className="icon-btn detail-close" onClick={onClose} aria-label="Close"><span aria-hidden="true">✕</span></button>
      </div>

      <div className="detail-when">
        <LuClock aria-hidden="true" />
        <div>
          {a.schedule === 'tbd' ? (
            <>
              <div className="strong">Date/time to be confirmed{a.start_date ? ` · expected ${formatDateStr(a.start_date, settings, { weekday: true })}` : ''}</div>
              {a.tbd_note && <div>{a.tbd_note}</div>}
              {a.follow_up_date && <div className="muted">Follow-up reminder: {formatDateStr(a.follow_up_date, settings, { weekday: true })} at {settings.allDayReminderTime}</div>}
              <button className="btn btn-sm mt-sm" onClick={() => onEdit(a.id, { focus: 'when' })}>Set date & time</button>
            </>
          ) : occ ? (
            <>
              <div className="strong">{describeOccurrence(a, occ, settings)}</div>
              {recurring && <div className="muted"><LuRepeat aria-hidden="true" /> {describeRecurrence(a.recurrence)}{onDate ? '' : ' · showing next occurrence'}</div>}
              {!info.past && !occ.allDay && <div className={cx('countdown-inline', delta < 3600000 && 'soon')}>{delta > 0 ? `${a.kind === 'deadline' ? 'Due' : 'Starts'} in ${formatDuration(delta)}` : occ.end > now ? 'Happening now' : `${formatDuration(delta)}`}</div>}
              {info.past && <div className="muted">This was in the past.{(a.status === 'confirmed' || a.status === 'tentative') ? ' Did it happen?' : ''}</div>}
              {info.past && (a.status === 'confirmed' || a.status === 'tentative') && (
                <div className="row gap mt-sm"><button className="btn btn-sm" onClick={() => setStatus('completed')}>Mark completed</button><button className="btn btn-sm" onClick={() => setStatus('missed')}>Mark missed</button></div>
              )}
            </>
          ) : <div className="muted">No upcoming dates (the repeat has ended).</div>}
        </div>
      </div>

      {info.overlaps && info.overlaps.length > 0 && (
        <div className="alert alert-warn" role="alert">
          <LuTriangleAlert aria-hidden="true" /> Overlaps with {info.overlaps.map((o, i) => <span key={o.occ.key}>{i > 0 && ', '}<button className="link-btn" onClick={() => navigate(`/activity/${o.a.id}`)}>{o.a.title}</button> ({timeLabel(o.a, o.occ, settings)})</span>)}
        </div>
      )}

      {a.notes && <div className="important-notes"><LuStickyNote aria-hidden="true" /><div><div className="strong">Important notes</div><div className="pre">{a.notes}</div></div></div>}

      <div className="status-row" role="group" aria-label="Change status">
        <span className="muted small">Status:</span>
        {STATUSES.map((s) => <button key={s} className={cx('chip-toggle', a.status === s && 'on', `st-${s}`)} aria-pressed={a.status === s} onClick={() => a.status !== s && setStatus(s)}>{STATUS_LABELS[s]}</button>)}
      </div>

      <dl className="detail-grid">
        {a.location && <><dt><LuMapPin aria-hidden="true" /> Location</dt><dd>{a.location} <a className="small" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.location)}`} target="_blank" rel="noopener noreferrer">Map <LuExternalLink aria-hidden="true" /></a></dd></>}
        {a.meeting_url && <><dt><LuVideo aria-hidden="true" /> Online</dt><dd><a className="btn btn-sm btn-primary" href={a.meeting_url} target="_blank" rel="noopener noreferrer">Join meeting <LuExternalLink aria-hidden="true" /></a> <span className="muted small break">{a.meeting_url}</span></dd></>}
        {(a.organizer && (a.organizer.name || a.organizer.email || a.organizer.phone)) && <><dt><LuUser aria-hidden="true" /> Contact</dt><dd>
          {a.organizer.name && <div>{a.organizer.name}</div>}
          {a.organizer.email && <div><LuMail aria-hidden="true" /> <a href={`mailto:${a.organizer.email}`}>{a.organizer.email}</a></div>}
          {a.organizer.phone && <div><LuPhone aria-hidden="true" /> <a href={`tel:${a.organizer.phone}`}>{a.organizer.phone}</a></div>}
        </dd></>}
        {a.timezone && a.timezone !== settings.timezone && a.schedule === 'scheduled' && !a.all_day && <><dt>Timezone</dt><dd>Scheduled in {a.timezone}; times shown in your timezone ({settings.timezone}).</dd></>}
        <dt><LuBellRing aria-hidden="true" /> Reminders</dt>
        <dd>
          {a.reminders.length ? a.reminders.map((r) => reminderLabel(r.minutes)).join(' · ') : <span className="muted">None</span>}
          {jobs && <div className="small muted">{jobs.length ? `Next: ${formatDateTime(jobs[0].fire_at, settings.timezone, settings, { weekday: true })}${jobs.length > 1 ? ` (+${jobs.length - 1} more scheduled)` : ''}` : (a.status === 'confirmed' || a.status === 'tentative') && a.schedule === 'scheduled' ? 'No upcoming reminders scheduled' : `No reminders while ${a.schedule === 'tbd' ? 'the date is unconfirmed' : `status is ${STATUS_LABELS[a.status].toLowerCase()}`}`}</div>}
        </dd>
      </dl>

      {a.description && <div className="detail-section"><h3>Description</h3><p className="pre">{a.description}</p></div>}

      <div className="detail-section">
        <h3>Preparation {a.checklist.length > 0 && <span className="muted">({a.checklist.filter((t) => t.done).length}/{a.checklist.length})</span>}</h3>
        {a.checklist.length ? (
          <ul className="checklist">
            {a.checklist.map((t) => {
              const due = taskDueMs(a, t, settings);
              const overdue = !t.done && due && due < now;
              return (
                <li key={t.id} className={cx(t.done && 'done')}>
                  <label><input type="checkbox" checked={t.done} onChange={() => toggleTask(t)} /> <span>{t.text}</span></label>
                  {t.due_date && <span className={cx('small', overdue ? 'text-danger' : 'muted')}>{overdue ? 'Overdue · ' : 'Due '}{formatDateStr(t.due_date, settings)}{t.due_time ? `, ${t.due_time}` : ''}</span>}
                </li>
              );
            })}
          </ul>
        ) : <p className="muted small">No preparation tasks. <button className="link-btn" onClick={() => onEdit(a.id)}>Add some</button></p>}
      </div>

      {(a.links.length > 0 || (a.attachments && a.attachments.length > 0)) && (
        <div className="detail-section">
          <h3>Links & files</h3>
          {a.links.map((l) => <div key={l.id}><LuLink aria-hidden="true" /> <a href={l.url} target="_blank" rel="noopener noreferrer">{l.label || l.url}</a></div>)}
          <Attachments activity={a} readOnly />
        </div>
      )}
      {recurring && occ && !info.past && <button className="link-btn small" onClick={skipOccurrence}>Skip only {formatDateStr(occ.date, settings, { weekday: true })}</button>}
    </Modal>
  );
}
