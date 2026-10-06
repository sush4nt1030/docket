import { useEffect, useMemo, useRef, useState } from 'react';
import { LuPlus, LuTrash2, LuX, LuTriangleAlert, LuPaperclip, LuDownload, LuBellRing, LuInfo, LuRepeat, LuMapPin, LuListChecks, LuStickyNote, LuLink, LuUndo2 } from 'react-icons/lu';
import { useStore, getState, saveActivity, api, setState, toast, ls, retryNow } from '../store.js';
import { Modal, Field, Segmented, Toggle, confirmDialog } from './ui.jsx';
import { cx, TIMEZONES, occurrencesBetween, todayStr, addDays, formatDateTime, tzAbbrev, fileSize, navigate, zonedToUtc, relDayLabel, timeLabel, formatDateStr } from '../lib.js';
import { newId, normalizeActivity, STATUSES, STATUS_LABELS, PRIORITIES, PRIORITY_LABELS, reminderLabel } from '../../shared/model.js';
import { expandOccurrences, findOverlaps, dayOfWeek, isDateStr } from '../../shared/time.js';
import { DAYS } from '../../shared/format.js';

const REMINDER_PRESETS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
const TASK_REMIND = [{ v: '', l: 'No reminder' }, { v: 0, l: 'At due time' }, { v: 15, l: '15 min before' }, { v: 60, l: '1 hour before' }, { v: 180, l: '3 hours before' }, { v: 1440, l: '1 day before' }];

function strip(a) { const { version, attachments, created_at, updated_at, is_sample, ...rest } = a; return rest; }
function blank(settings, preset = {}) {
  return {
    id: newId('a'), title: '', kind: 'event', category_id: null, description: '', notes: '', schedule: 'scheduled', tbd_note: '', follow_up_date: '',
    all_day: false, timezone: settings.timezone, start_date: '', start_time: '', end_date: '', end_time: '', location: '', meeting_url: '',
    organizer: { name: '', email: '', phone: '' }, links: [], priority: 'medium', status: 'confirmed', checklist: [],
    reminders: settings.defaultReminders.map((m) => ({ minutes: m })), recurrence: { freq: 'none', interval: 1, byweekday: [], until: '', count: null, exdates: [] }, archived: false,
    ...preset,
  };
}
const draftKey = (id, isNew) => (isNew ? 'docket:draft:new' : `docket:draft:${id}`);

export function Editor({ id, preset, onClose, focus }) {
  const settings = useStore((s) => s.settings);
  const categories = useStore((s) => s.categories);
  const activities = useStore((s) => s.activities);
  const online = useStore((s) => s.online);
  const globalSave = useStore((s) => s.save);
  const queue = useStore((s) => s.queue);
  const stored = id ? activities[id] : null;
  const [isNew, setIsNew] = useState(!id);
  const [form, setForm] = useState(() => (stored ? strip(stored) : blank(settings, preset)));
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState({ state: 'idle', message: '' });
  const [draft, setDraft] = useState(() => { const d = ls.get(draftKey(id, !id)); return d && d.form && (!stored || JSON.stringify(d.form) !== JSON.stringify(strip(stored))) ? d : null; });
  const [remoteChanged, setRemoteChanged] = useState(false);
  const lastSaved = useRef(stored ? JSON.stringify(strip(stored)) : null);
  const seenVersion = useRef(stored ? stored.version : 0);
  const timer = useRef(null);
  const [jobs, setJobs] = useState(null);
  const titleRef = useRef(null);
  const dirty = JSON.stringify(form) !== lastSaved.current;

  // remote updates while the editor is open
  useEffect(() => {
    if (!stored || isNew) return;
    if (stored.version > seenVersion.current) {
      const incoming = JSON.stringify(strip(stored));
      if (incoming === JSON.stringify(form)) { seenVersion.current = stored.version; lastSaved.current = incoming; return; }
      if (!dirty) { setForm(strip(stored)); lastSaved.current = incoming; seenVersion.current = stored.version; }
      else if (status.state !== 'saving') setRemoteChanged(true);
    }
  }, [stored && stored.version]);
  useEffect(() => { if (id && !stored && !isNew && getState().phase === 'ready') setRemoteChanged('deleted'); }, [stored]);

  const loadJobs = () => { if (!isNew && form.id && online) api('GET', `/api/activities/${form.id}/reminders`).then((d) => setJobs(d.jobs)).catch(() => {}); };
  useEffect(loadJobs, [isNew, stored && stored.version]);

  function update(patch) {
    setForm((f) => {
      const next = typeof patch === 'function' ? patch(f) : { ...f, ...patch };
      ls.set(draftKey(next.id, isNew), { at: Date.now(), form: next, id: next.id });
      if (!isNew) schedule(next);
      return next;
    });
  }
  function schedule(next) { clearTimeout(timer.current); timer.current = setTimeout(() => persist(next), 900); }

  function persist(next = form, { closing } = {}) {
    clearTimeout(timer.current);
    const { errors: errs } = normalizeActivity(next, { defaultTimezone: settings.timezone });
    setErrors(errs || {});
    if (errs && Object.keys(errs).length) { setStatus({ state: 'invalid', message: 'Not saved — fix the highlighted fields' }); return false; }
    const snapshot = JSON.stringify(next);
    setStatus({ state: 'saving', message: '' });
    const { promise } = saveActivity(next, { isNew });
    promise.then((res) => {
      if (res) seenVersion.current = res.version;
      lastSaved.current = snapshot;
      setStatus({ state: 'saved', message: '' });
      if (JSON.stringify(getFormRef.current()) === snapshot) ls.del(draftKey(next.id, false));
      ls.del('docket:draft:new');
    }).catch((err) => {
      if (err.status === 409 || err.status === 404) setStatus({ state: 'error', message: err.message });
      else if (err.fields) { setErrors(err.fields); setStatus({ state: 'invalid', message: err.message }); }
      else setStatus({ state: 'error', message: `Failed to save: ${err.message}. Your input is kept — retry when ready.` });
    });
    if (!getState().online) setStatus({ state: 'queued', message: 'Offline — saved on this device and will sync when you reconnect' });
    return true;
  }
  const getFormRef = useRef(() => form); getFormRef.current = () => form;

  function create(e) {
    e && e.preventDefault();
    const { errors: errs } = normalizeActivity(form, { defaultTimezone: settings.timezone });
    setErrors(errs);
    if (Object.keys(errs).length) {
      setStatus({ state: 'invalid', message: 'Please fix the highlighted fields' });
      setTimeout(() => { const el = document.querySelector('.editor .has-error input, .editor .has-error select, .editor .has-error textarea'); el && el.focus(); }, 30);
      return;
    }
    const { promise } = saveActivity(form, { isNew: true });
    ls.set(draftKey(form.id, false), { at: Date.now(), form, id: form.id });
    ls.del('docket:draft:new');
    const newIdv = form.id;
    promise.then(() => ls.del(draftKey(newIdv, false))).catch((err) => toast(`“${form.title}” could not be saved: ${err.message}`, { kind: 'error', timeout: 0, action: { label: 'Open', onClick: () => navigate(`/activity/${newIdv}`) } }));
    toast(getState().online ? `“${form.title}” saved` : `“${form.title}” saved offline — it will sync when you reconnect`, { kind: 'success', action: { label: 'View', onClick: () => navigate(`/activity/${newIdv}`) } });
    onClose(newIdv);
  }

  function close() {
    if (isNew) {
      if (form.title || form.start_date) {
        confirmDialog({ title: 'Discard this new activity?', message: 'It has not been saved yet. Your draft is kept on this device, so you can restore it next time you add an activity.', confirmLabel: 'Close', cancelLabel: 'Keep editing' })
          .then((ok) => ok && onClose());
      } else onClose();
      return;
    }
    if (dirty) { const ok = persist(form, { closing: true }); if (!ok) { confirmDialog({ title: 'Some changes are not saved', message: 'Some fields are invalid, so the latest changes could not be saved. They stay as a draft on this device.', confirmLabel: 'Close anyway', cancelLabel: 'Fix fields' }).then((y) => y && onClose()); return; } }
    onClose();
  }

  // ---- derived: overlaps & local preview ----
  const preview = useMemo(() => {
    const { value, errors: errs } = normalizeActivity(form, { defaultTimezone: settings.timezone });
    if (Object.keys(errs).length || value.schedule !== 'scheduled') return { occs: [], overlaps: [] };
    const now = Date.now();
    const occs = expandOccurrences(value, now - 86400000, now + 120 * 86400000, settings.timezone, 200);
    if (!occs.length || value.all_day) return { occs, overlaps: [] };
    const others = occurrencesBetween(activities, occs[0].start - 86400000, occs[occs.length - 1].end + 86400000, settings, { filter: (a) => a.id !== value.id && a.status !== 'cancelled' && a.status !== 'missed' });
    const map = findOverlaps([...occs, ...others.map((x) => x.occ)]);
    const res = [];
    for (const o of occs) for (const k of map.get(o.key) || []) { const other = others.find((x) => x.occ.key === k); if (other) res.push({ o, other }); }
    return { occs, overlaps: res.slice(0, 4) };
  }, [form, activities, settings]);

  const err = (k) => errors[k];
  const differentTz = form.timezone !== settings.timezone;
  const isDeadline = form.kind === 'deadline';
  const recurring = form.recurrence.freq !== 'none';

  const footer = (
    <div className="editor-foot">
      <div className={cx('editor-status', !isNew && queue.some((o) => o.kind === 'activity' && o.id === form.id) && (globalSave.state === 'error' || !online) ? (online ? 'error' : 'queued') : status.state)} role="status" aria-live="polite">
        {!isNew && queue.some((o) => o.kind === 'activity' && o.id === form.id) && (globalSave.state === 'error' || !online) ? (
          <>{!online ? 'Offline — your changes are kept on this device and will sync when you reconnect.' : `Failed to save: ${globalSave.message} Your input is kept.`} {online && <button type="button" className="link-btn" onClick={retryNow}>Retry</button>}</>
        ) : isNew ? (status.state === 'invalid' ? status.message : 'Not saved yet') :
          status.state === 'saving' ? 'Saving…' : status.state === 'saved' ? 'Saved' : status.state === 'queued' ? status.message : status.state === 'invalid' || status.state === 'error' ? status.message : dirty ? 'Unsaved changes…' : 'All changes saved automatically'}
        {status.state === 'error' && <button className="link-btn" onClick={() => persist(form)}>Retry</button>}
      </div>
      <div className="row gap">
        {isNew ? <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn btn-primary" onClick={create}>Save activity</button>
        </> : <button className="btn btn-primary" onClick={close}>Done</button>}
      </div>
    </div>
  );

  return (
    <Modal open onClose={close} title={isNew ? 'New activity' : 'Edit activity'} size="lg" className="editor" footer={footer} initialFocus={focus === 'when' ? '#ed-sd, [aria-label="Schedule"] button' : '#ed-title'}>
      <form onSubmit={(e) => { e.preventDefault(); isNew ? create() : persist(); }} noValidate>
        {draft && (
          <div className="alert alert-info row between">
            <span>You have unsaved input from {formatDateTime(draft.at, settings.timezone, settings)}.</span>
            <span className="row gap">
              <button type="button" className="btn btn-sm" onClick={() => { update(isNew ? { ...draft.form, id: form.id } : draft.form); setDraft(null); }}><LuUndo2 /> Restore</button>
              <button type="button" className="btn btn-sm" onClick={() => { ls.del(draftKey(id, isNew)); setDraft(null); }}>Discard</button>
            </span>
          </div>
        )}
        {remoteChanged && (
          <div className="alert alert-warn" role="alert">
            {remoteChanged === 'deleted' ? 'This activity was deleted on another device or tab. Your edits are kept here; saving will ask whether to restore it.' : 'This activity was changed on another device or tab.'}
            {remoteChanged !== 'deleted' && <span className="row gap" style={{ marginTop: 6 }}>
              <button type="button" className="btn btn-sm" onClick={() => { setForm(strip(stored)); lastSaved.current = JSON.stringify(strip(stored)); seenVersion.current = stored.version; setRemoteChanged(false); }}>Load their version</button>
              <button type="button" className="btn btn-sm" onClick={() => setRemoteChanged(false)}>Keep mine (you’ll be asked when saving)</button>
            </span>}
          </div>
        )}

        <Field label="Title" htmlFor="ed-title" error={err('title')} required>
          <input id="ed-title" ref={titleRef} className="input input-lg" value={form.title} onChange={(e) => update({ title: e.target.value })} placeholder="e.g. Interview with Himalayan Tech" maxLength={200} aria-invalid={!!err('title')} />
        </Field>

        <div className="grid-2">
          <Field label="Type">
            <Segmented label="Type" value={form.kind} onChange={(v) => update({ kind: v })} options={[{ value: 'event', label: 'Event / meeting' }, { value: 'deadline', label: 'Deadline' }]} />
          </Field>
          <Field label="Category" htmlFor="ed-cat">
            <select id="ed-cat" className="input" value={form.category_id || ''} onChange={(e) => update({ category_id: e.target.value || null })}>
              <option value="">Uncategorized</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <Segmented label="Priority" value={form.priority} onChange={(v) => update({ priority: v })} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))} />
          </Field>
          <Field label="Status" htmlFor="ed-status">
            <select id="ed-status" className="input" value={form.status} onChange={(e) => update({ status: e.target.value })}>
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </Field>
        </div>

        <fieldset className="section">
          <legend>When</legend>
          <Segmented label="Schedule" value={form.schedule} onChange={(v) => update({ schedule: v })} options={[{ value: 'scheduled', label: 'Date & time known' }, { value: 'tbd', label: 'Date/time to be confirmed' }]} />
          {form.schedule === 'tbd' ? (
            <div className="grid-2 mt">
              <Field label="Known date (optional)" htmlFor="ed-tbd-date" hint="Leave empty if the date is unknown" error={err('start_date')}>
                <input id="ed-tbd-date" type="date" className="input" value={form.start_date} onChange={(e) => update({ start_date: e.target.value })} />
              </Field>
              <Field label="Follow-up reminder date" htmlFor="ed-fu" hint={`You’ll get a reminder at ${settings.allDayReminderTime} that day to chase confirmation`} error={err('follow_up_date')}>
                <input id="ed-fu" type="date" className="input" value={form.follow_up_date} onChange={(e) => update({ follow_up_date: e.target.value })} />
              </Field>
              <Field label="What you know so far" htmlFor="ed-tbdn" className="span-2" hint="e.g. “HR will email the time by Friday”">
                <input id="ed-tbdn" className="input" value={form.tbd_note} onChange={(e) => update({ tbd_note: e.target.value })} maxLength={500} />
              </Field>
            </div>
          ) : (
            <>
              <div className="row gap wrap mt">
                <Toggle id="ed-allday" checked={form.all_day} onChange={(v) => update({ all_day: v })} label={isDeadline ? 'No specific time (due any time that day)' : 'All-day'} />
              </div>
              <div className="grid-3 mt">
                <Field label={isDeadline ? 'Due date' : 'Start date'} htmlFor="ed-sd" error={err('start_date')} required>
                  <input id="ed-sd" type="date" className="input" value={form.start_date} onChange={(e) => update({ start_date: e.target.value })} aria-invalid={!!err('start_date')} />
                </Field>
                {!form.all_day && (
                  <Field label={isDeadline ? 'Due time' : 'Start time'} htmlFor="ed-st" error={err('start_time')} required>
                    <input id="ed-st" type="time" className="input" value={form.start_time} onChange={(e) => update({ start_time: e.target.value })} aria-invalid={!!err('start_time')} />
                  </Field>
                )}
                {!form.all_day && !isDeadline && (
                  <Field label="End time" htmlFor="ed-et" error={err('end_time')} hint="Optional">
                    <input id="ed-et" type="time" className="input" value={form.end_time} onChange={(e) => update({ end_time: e.target.value })} aria-invalid={!!err('end_time')} />
                  </Field>
                )}
                {!isDeadline && (
                  <Field label={form.all_day ? 'Last day (optional)' : 'End date (if different)'} htmlFor="ed-ed" error={err('end_date')}>
                    <input id="ed-ed" type="date" className="input" value={form.end_date} min={form.start_date || undefined} onChange={(e) => update({ end_date: e.target.value })} />
                  </Field>
                )}
                {!form.all_day && (
                  <Field label="Timezone" htmlFor="ed-tz" error={err('timezone')} hint={differentTz ? 'Different from your default timezone' : undefined}>
                    <input id="ed-tz" className="input" list="tz-list" value={form.timezone} onChange={(e) => update({ timezone: e.target.value })} />
                  </Field>
                )}
              </div>
              {preview.occs[0] && !form.all_day && differentTz && (
                <p className="hint-box"><LuInfo aria-hidden="true" /> {form.start_time} in {form.timezone} is <strong>{formatDateTime(preview.occs[0].start, settings.timezone, settings, { weekday: true })}</strong> in your timezone ({tzAbbrev(settings.timezone)}).</p>
              )}
              {preview.overlaps.length > 0 && (
                <div className="alert alert-warn" role="alert">
                  <strong><LuTriangleAlert aria-hidden="true" /> Overlaps with:</strong>
                  <ul>{preview.overlaps.map(({ o, other }, i) => <li key={i}>{other.a.title} — {relDayLabel(other.occ.date && !other.occ.allDay ? other.occ.date : other.occ.date, todayStr(settings.timezone), settings)}, {timeLabel(other.a, other.occ, settings)}</li>)}</ul>
                </div>
              )}
            </>
          )}
        </fieldset>

        {form.schedule === 'scheduled' && (
          <details className="section" open={recurring}>
            <summary><LuRepeat aria-hidden="true" /> Repeat {recurring && <span className="muted">· {describeRecurrence(form.recurrence)}</span>}</summary>
            <div className="grid-3 mt">
              <Field label="Repeats" htmlFor="ed-freq" error={err('recurrence.freq')}>
                <select id="ed-freq" className="input" value={form.recurrence.freq} onChange={(e) => update((f) => withDraft({ ...f, recurrence: { ...f.recurrence, freq: e.target.value, byweekday: e.target.value === 'weekly' && !f.recurrence.byweekday.length && isDateStr(f.start_date) ? [dayOfWeek(f.start_date)] : f.recurrence.byweekday } }))}>
                  <option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly (same date)</option><option value="yearly">Yearly</option>
                </select>
              </Field>
              {recurring && (
                <Field label={`Every … ${({ daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)', yearly: 'year(s)' })[form.recurrence.freq]}`} htmlFor="ed-int" error={err('recurrence.interval')}>
                  <input id="ed-int" type="number" min="1" max="365" className="input" value={form.recurrence.interval} onChange={(e) => update((f) => withDraft({ ...f, recurrence: { ...f.recurrence, interval: e.target.value } }))} />
                </Field>
              )}
              {recurring && (
                <Field label="Ends" htmlFor="ed-ends" error={err('recurrence.until') || err('recurrence.count')}>
                  <div className="row gap">
                    <select id="ed-ends" className="input" value={form.recurrence.until ? 'until' : form.recurrence.count ? 'count' : 'never'} onChange={(e) => update((f) => withDraft({ ...f, recurrence: { ...f.recurrence, until: e.target.value === 'until' ? addDays(f.start_date || todayStr(settings.timezone), 90) : '', count: e.target.value === 'count' ? 10 : null } }))}>
                      <option value="never">Never</option><option value="until">On date</option><option value="count">After N times</option>
                    </select>
                    {form.recurrence.until !== '' && form.recurrence.until !== undefined && form.recurrence.until !== null && <input aria-label="Repeat until" type="date" className="input" value={form.recurrence.until} onChange={(e) => update((f) => withDraft({ ...f, recurrence: { ...f.recurrence, until: e.target.value } }))} />}
                    {!!form.recurrence.count && <input aria-label="Number of times" type="number" min="1" max="1000" className="input w-80" value={form.recurrence.count} onChange={(e) => update((f) => withDraft({ ...f, recurrence: { ...f.recurrence, count: e.target.value } }))} />}
                  </div>
                </Field>
              )}
            </div>
            {form.recurrence.freq === 'weekly' && (
              <div className="weekday-pick" role="group" aria-label="Repeat on">
                {DAYS.map((d, i) => {
                  const on = form.recurrence.byweekday.includes(i);
                  return <button type="button" key={d} aria-pressed={on} className={cx('chip-toggle', on && 'on')} onClick={() => update((f) => withDraft({ ...f, recurrence: { ...f.recurrence, byweekday: on ? f.recurrence.byweekday.filter((x) => x !== i) : [...f.recurrence.byweekday, i] } }))}>{d}</button>;
                })}
              </div>
            )}
            {recurring && form.recurrence.exdates.length > 0 && (
              <p className="field-hint">Skipped dates: {form.recurrence.exdates.map((d) => <button type="button" key={d} className="chip" onClick={() => update((f) => withDraft({ ...f, recurrence: { ...f.recurrence, exdates: f.recurrence.exdates.filter((x) => x !== d) } }))} aria-label={`Restore ${d}`}>{formatDateStr(d, settings)} <LuX /></button>)}</p>
            )}
          </details>
        )}

        <details className="section" open>
          <summary><LuBellRing aria-hidden="true" /> Reminders <span className="muted">· {form.reminders.length ? form.reminders.map((r) => reminderLabel(r.minutes)).join(', ') : 'none'}</span></summary>
          <ReminderEditor reminders={form.reminders} onChange={(r) => update({ reminders: r })} error={err('reminders')} allDay={form.all_day} settings={settings} isDeadline={isDeadline} />
          {form.schedule === 'tbd' && <p className="field-hint">Reminders start working once the date and time are confirmed.</p>}
          {!isNew && jobs && (
            <div className="sched-jobs">
              <div className="muted small">Scheduled on the server{jobs.length ? '' : ': none'}{['completed', 'missed', 'cancelled'].includes(form.status) ? ` (reminders stop when an activity is ${form.status})` : ''}</div>
              {jobs.slice(0, 5).map((j) => <div key={j.id} className="small">• {formatDateTime(j.fire_at, settings.timezone, settings, { weekday: true })} — {j.kind === 'task' ? 'preparation task' : j.kind === 'followup' ? 'follow-up' : j.kind === 'snooze' ? 'snoozed' : reminderLabel(j.offset_min)}</div>)}
              {jobs.length > 5 && <div className="small muted">+ {jobs.length - 5} more</div>}
            </div>
          )}
        </details>

        <details className="section" open={!!(form.location || form.meeting_url || form.organizer.name || form.organizer.email || form.organizer.phone)}>
          <summary><LuMapPin aria-hidden="true" /> Location & contact</summary>
          <div className="grid-2 mt">
            <Field label="Location / address" htmlFor="ed-loc"><input id="ed-loc" className="input" value={form.location} onChange={(e) => update({ location: e.target.value })} maxLength={300} /></Field>
            <Field label="Online meeting link" htmlFor="ed-url" error={err('meeting_url')}><input id="ed-url" type="url" className="input" placeholder="https://" value={form.meeting_url} onChange={(e) => update({ meeting_url: e.target.value })} /></Field>
            <Field label="Organizer / contact name" htmlFor="ed-on"><input id="ed-on" className="input" value={form.organizer.name} onChange={(e) => update((f) => withDraft({ ...f, organizer: { ...f.organizer, name: e.target.value } }))} /></Field>
            <Field label="Contact email" htmlFor="ed-oe" error={err('organizer.email')}><input id="ed-oe" type="email" className="input" value={form.organizer.email} onChange={(e) => update((f) => withDraft({ ...f, organizer: { ...f.organizer, email: e.target.value } }))} /></Field>
            <Field label="Contact phone" htmlFor="ed-op"><input id="ed-op" type="tel" className="input" value={form.organizer.phone} onChange={(e) => update((f) => withDraft({ ...f, organizer: { ...f.organizer, phone: e.target.value } }))} /></Field>
          </div>
        </details>

        <details className="section" open={!!(form.description || form.notes)}>
          <summary><LuStickyNote aria-hidden="true" /> Description & important notes</summary>
          <Field label="Description" htmlFor="ed-desc" className="mt"><textarea id="ed-desc" className="input" rows={3} value={form.description} onChange={(e) => update({ description: e.target.value })} maxLength={5000} /></Field>
          <Field label="Important notes" htmlFor="ed-notes" hint="Shown prominently on the activity (e.g. documents to bring, dress code)"><textarea id="ed-notes" className="input" rows={2} value={form.notes} onChange={(e) => update({ notes: e.target.value })} maxLength={5000} /></Field>
        </details>

        <details className="section" open={form.checklist.length > 0}>
          <summary><LuListChecks aria-hidden="true" /> Preparation checklist <span className="muted">· {form.checklist.filter((t) => t.done).length}/{form.checklist.length}</span></summary>
          <ChecklistEditor items={form.checklist} onChange={(c) => update({ checklist: c })} errors={errors} settings={settings} defaultDate={form.start_date} />
        </details>

        <details className="section" open={form.links.length > 0 || (stored && stored.attachments && stored.attachments.length > 0)}>
          <summary><LuLink aria-hidden="true" /> Links & attachments</summary>
          <LinksEditor links={form.links} onChange={(l) => update({ links: l })} errors={errors} />
          <Attachments activity={stored} isNew={isNew} />
        </details>
        <datalist id="tz-list">{TIMEZONES.map((t) => <option key={t} value={t} />)}</datalist>
        <button type="submit" hidden>Save</button>
      </form>
    </Modal>
  );

  function withDraft(next) { return next; }
}

export function describeRecurrence(r) {
  if (!r || r.freq === 'none') return '';
  const n = Number(r.interval) || 1;
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.freq];
  let s = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (r.freq === 'weekly' && r.byweekday && r.byweekday.length) s += ` on ${[...r.byweekday].sort().map((d) => DAYS[d]).join(', ')}`;
  if (r.until) s += ` until ${r.until}`;
  if (r.count) s += `, ${r.count} times`;
  return s;
}

function ReminderEditor({ reminders, onChange, error, allDay, settings, isDeadline }) {
  const [custom, setCustom] = useState({ n: '', unit: 60 });
  const has = new Set(reminders.map((r) => r.minutes));
  const add = (m) => { if (!has.has(m) && m >= 0) onChange([...reminders, { minutes: m }].sort((a, b) => b.minutes - a.minutes)); };
  return (
    <div className="mt">
      <div className="chips" aria-label="Current reminders">
        {reminders.length === 0 && <span className="muted small">No reminders for this activity.</span>}
        {reminders.map((r) => (
          <span key={r.minutes} className="chip chip-solid">{reminderLabel(r.minutes)}{allDay && r.minutes % 1440 === 0 ? ` (at ${settings.allDayReminderTime})` : ''}
            <button type="button" className="chip-x" aria-label={`Remove reminder ${reminderLabel(r.minutes)}`} onClick={() => onChange(reminders.filter((x) => x.minutes !== r.minutes))}><LuX /></button>
          </span>
        ))}
      </div>
      <div className="row gap wrap mt-sm">
        <select className="input w-auto" aria-label="Add a reminder" value="" onChange={(e) => e.target.value !== '' && add(Number(e.target.value))}>
          <option value="">+ Add reminder…</option>
          {REMINDER_PRESETS.filter((m) => !has.has(m)).map((m) => <option key={m} value={m}>{reminderLabel(m)}</option>)}
        </select>
        <span className="row gap-sm">
          <input className="input w-80" type="number" min="1" placeholder="Custom" aria-label="Custom reminder amount" value={custom.n} onChange={(e) => setCustom({ ...custom, n: e.target.value })} />
          <select className="input w-auto" aria-label="Custom reminder unit" value={custom.unit} onChange={(e) => setCustom({ ...custom, unit: Number(e.target.value) })}>
            <option value={1}>minutes</option><option value={60}>hours</option><option value={1440}>days</option><option value={10080}>weeks</option>
          </select>
          <button type="button" className="btn btn-sm" disabled={!(Number(custom.n) > 0)} onClick={() => { add(Math.round(Number(custom.n) * custom.unit)); setCustom({ ...custom, n: '' }); }}>Add</button>
        </span>
      </div>
      {allDay && <p className="field-hint">For all-day {isDeadline ? 'deadlines' : 'events'}, reminders are measured from {settings.allDayReminderTime} on the day (change this in Settings).</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}

function ChecklistEditor({ items, onChange, errors, settings, defaultDate }) {
  const [text, setText] = useState('');
  const add = () => { const t = text.trim(); if (!t) return; onChange([...items, { id: newId('t'), text: t, done: false, due_date: '', due_time: '', remind_minutes: null }]); setText(''); };
  const set = (i, patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="mt">
      <ul className="check-edit">
        {items.map((t, i) => (
          <li key={t.id} className={cx(errors[`checklist.${i}`] && 'has-error')}>
            <input type="checkbox" checked={t.done} aria-label={`Done: ${t.text}`} onChange={(e) => set(i, { done: e.target.checked, done_at: e.target.checked ? Date.now() : null })} />
            <input className="input grow" value={t.text} aria-label="Task" onChange={(e) => set(i, { text: e.target.value })} />
            <input type="date" className="input w-date" aria-label="Due date" value={t.due_date} onChange={(e) => set(i, { due_date: e.target.value, remind_minutes: !t.due_date && t.remind_minutes == null && settings.defaultTaskReminder != null ? (t.due_time ? settings.defaultTaskReminder : 0) : t.remind_minutes })} />
            <input type="time" className="input w-time" aria-label="Due time" value={t.due_time} onChange={(e) => set(i, { due_time: e.target.value })} />
            <select className="input w-auto" aria-label="Task reminder" value={t.remind_minutes ?? ''} disabled={!t.due_date} onChange={(e) => set(i, { remind_minutes: e.target.value === '' ? null : Number(e.target.value) })}>
              {(t.due_time ? TASK_REMIND : [TASK_REMIND[0], { v: 0, l: `On the day (${settings.allDayReminderTime})` }]).map((o) => <option key={o.l} value={o.v}>{o.l}</option>)}
            </select>
            <button type="button" className="icon-btn" aria-label={`Remove task ${t.text}`} onClick={() => onChange(items.filter((_, j) => j !== i))}><LuTrash2 /></button>
            {errors[`checklist.${i}`] && <p className="field-error w-full">{errors[`checklist.${i}`]}</p>}
          </li>
        ))}
      </ul>
      <div className="row gap">
        <input className="input grow" placeholder="Add a preparation task and press Enter" aria-label="New preparation task" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="btn" onClick={add} disabled={!text.trim()}><LuPlus /> Add</button>
      </div>
      <p className="field-hint">Give a task a due date to see it in “Pending preparation” and get a separate reminder.</p>
    </div>
  );
}

function LinksEditor({ links, onChange, errors }) {
  const set = (i, patch) => onChange(links.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="mt">
      {links.map((l, i) => (
        <div key={l.id} className={cx('row gap link-row', errors[`links.${i}`] && 'has-error')}>
          <input className="input w-label" placeholder="Label" aria-label="Link label" value={l.label} onChange={(e) => set(i, { label: e.target.value })} />
          <input className="input grow" type="url" placeholder="https://" aria-label="Link URL" value={l.url} onChange={(e) => set(i, { url: e.target.value })} aria-invalid={!!errors[`links.${i}`]} />
          <button type="button" className="icon-btn" aria-label="Remove link" onClick={() => onChange(links.filter((_, j) => j !== i))}><LuTrash2 /></button>
          {errors[`links.${i}`] && <p className="field-error w-full">{errors[`links.${i}`]}</p>}
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => onChange([...links, { id: newId('l'), label: '', url: '' }])}><LuPlus /> Add link</button>
    </div>
  );
}

export function Attachments({ activity, isNew, readOnly }) {
  const online = useStore((s) => s.online);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  if (isNew || !activity) return <p className="field-hint mt">Attachments can be added after the activity is saved.</p>;
  const list = activity.attachments || [];
  const pending = activity.version === 0;
  async function upload(files) {
    setError('');
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) { setError(`“${f.name}” is larger than 10 MB`); continue; }
      setBusy(true);
      try {
        const d = await api('POST', `/api/activities/${activity.id}/attachments`, f, { raw: true, headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) }, timeout: 120000 });
        setState((s) => ({ activities: { ...s.activities, [activity.id]: { ...s.activities[activity.id], attachments: d.activity.attachments } } }));
      } catch (err) { setError(`Upload failed: ${err.message}`); }
      finally { setBusy(false); }
    }
  }
  async function remove(att) {
    if (!(await confirmDialog({ title: 'Delete attachment?', message: `“${att.filename}” will be permanently deleted from the server.`, confirmLabel: 'Delete', danger: true }))) return;
    try { const d = await api('DELETE', `/api/attachments/${att.id}`); if (d.activity) setState((s) => ({ activities: { ...s.activities, [activity.id]: { ...s.activities[activity.id], attachments: d.activity.attachments } } })); }
    catch (err) { setError(err.message); }
  }
  return (
    <div className="attachments mt">
      {list.map((a) => (
        <div key={a.id} className="att-row">
          <LuPaperclip aria-hidden="true" />
          <a href={`/api/attachments/${a.id}`} className="grow" download>{a.filename}</a>
          <span className="muted small">{fileSize(a.size)}</span>
          <a className="icon-btn" href={`/api/attachments/${a.id}`} download aria-label={`Download ${a.filename}`}><LuDownload /></a>
          {!readOnly && <button type="button" className="icon-btn" aria-label={`Delete ${a.filename}`} onClick={() => remove(a)}><LuTrash2 /></button>}
        </div>
      ))}
      {!readOnly && <>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
        <button type="button" className="btn btn-sm" disabled={busy || !online || pending} onClick={() => fileRef.current.click()}><LuPaperclip /> {busy ? 'Uploading…' : 'Attach files'}</button>
        {(!online || pending) && <span className="muted small"> {pending ? 'Available once this activity has synced.' : 'Uploading needs a connection.'}</span>}
        <span className="muted small"> Max 10 MB per file.</span>
      </>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}
