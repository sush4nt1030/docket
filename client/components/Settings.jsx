import { useEffect, useRef, useState } from 'react';
import { LuSun, LuMoon, LuMonitor, LuBell, LuMail, LuVolume2, LuSmartphone, LuDownload, LuUpload, LuTrash2, LuPlus, LuCopy, LuRefreshCw, LuLogOut, LuShield, LuPlug, LuCircleCheck, LuCircleAlert, LuInfo, LuX } from 'react-icons/lu';
import { useStore, saveSettings, saveCategory, deleteCategory, api, toast, logout, playChime, unlockAudio, setState, getState, nativeApp } from '../store.js';
import { Field, Segmented, Toggle, confirmDialog, Modal, EmptyState } from './ui.jsx';
import { useRoute, navigate, TIMEZONES, browserTz, formatDateStr, todayStr, cx, formatDateTime, downloadUrl } from '../lib.js';
import { DATE_FORMATS, reminderLabel, newId, DEFAULT_SETTINGS } from '../../shared/model.js';
import { isValidTimeZone } from '../../shared/time.js';
import { formatHM } from '../../shared/format.js';

const TABS = [
  { id: 'general', label: 'General' }, { id: 'notifications', label: 'Reminders & notifications' }, { id: 'categories', label: 'Categories' },
  { id: 'data', label: 'Data & calendar' }, { id: 'account', label: 'Account & privacy' }, { id: 'integrations', label: 'Integrations' },
];

export function SettingsView() {
  const { path } = useRoute();
  const tab = TABS.find((t) => path === `/settings/${t.id}`) ? path.split('/')[2] : 'general';
  return (
    <div className="settings">
      <header className="page-head"><div><h1>Settings</h1><p className="muted">Changes save automatically and sync to all your devices.</p></div></header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {TABS.map((t) => <button key={t.id} className={cx(tab === t.id && 'on')} aria-current={tab === t.id ? 'page' : undefined} onClick={() => navigate(`/settings/${t.id}`)}>{t.label}</button>)}
        </nav>
        <div className="settings-body">
          {tab === 'general' && <General />}
          {tab === 'notifications' && <NotificationSettings />}
          {tab === 'categories' && <Categories />}
          {tab === 'data' && <DataSettings />}
          {tab === 'account' && <Account />}
          {tab === 'integrations' && <Integrations />}
        </div>
      </div>
    </div>
  );
}

function General() {
  const s = useStore((x) => x.settings);
  const [tz, setTz] = useState(s.timezone);
  useEffect(() => setTz(s.timezone), [s.timezone]);
  const btz = browserTz();
  const today = todayStr(s.timezone);
  return (
    <section className="card">
      <h2 className="h2">Time & display</h2>
      <Field label="Default timezone" htmlFor="st-tz" hint="All times are shown in this timezone. Each activity can also have its own timezone (for international events)." error={tz && !isValidTimeZone(tz) ? 'Unknown timezone — pick one from the list' : undefined}>
        <div className="row gap wrap">
          <input id="st-tz" className="input grow" list="st-tz-list" value={tz} onChange={(e) => { setTz(e.target.value); if (isValidTimeZone(e.target.value)) saveSettings({ timezone: e.target.value }); }} />
          {btz !== s.timezone && <button className="btn btn-sm" onClick={() => saveSettings({ timezone: btz })}>Use this device’s ({btz})</button>}
        </div>
        <datalist id="st-tz-list">{TIMEZONES.map((t) => <option key={t} value={t} />)}</datalist>
      </Field>
      <div className="grid-2">
        <Field label="Date format" htmlFor="st-df">
          <select id="st-df" className="input" value={s.dateFormat} onChange={(e) => saveSettings({ dateFormat: e.target.value })}>
            {DATE_FORMATS.map((f) => <option key={f} value={f}>{formatDateStr(today, { dateFormat: f })} ({f})</option>)}
          </select>
        </Field>
        <Field label="Time format"><Segmented label="Time format" value={s.timeFormat} onChange={(v) => saveSettings({ timeFormat: v })} options={[{ value: '12h', label: formatHM(14, 30, '12h') }, { value: '24h', label: formatHM(14, 30, '24h') }]} /></Field>
        <Field label="Week starts on"><Segmented label="Week starts on" value={s.weekStart} onChange={(v) => saveSettings({ weekStart: v })} options={[{ value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' }]} /></Field>
        <Field label="Theme"><Segmented label="Theme" value={s.theme} onChange={(v) => saveSettings({ theme: v })} options={[{ value: 'light', label: 'Light', icon: <LuSun /> }, { value: 'dark', label: 'Dark', icon: <LuMoon /> }, { value: 'system', label: 'System', icon: <LuMonitor /> }]} /></Field>
      </div>
    </section>
  );
}

// ---------- notifications ----------
function b64ToU8(b64) { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
export async function devicePushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return { state: 'unsupported' };
  if (!window.isSecureContext) return { state: 'insecure' };
  if (Notification.permission === 'denied') return { state: 'denied' };
  try {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 3000))]);
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub && Notification.permission === 'granted') return { state: 'subscribed', sub };
  } catch {}
  return { state: Notification.permission === 'granted' ? 'granted' : 'default' };
}
export async function enablePush() {
  const st = getState();
  const key = st.status && st.status.push && st.status.push.publicKey;
  if (!key) throw new Error('Push is not available from the server right now');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.' : 'Permission was not granted');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const subscribe = () => reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key) });
  if (!sub) sub = await subscribe();
  try { await api('POST', '/api/push/subscribe', sub.toJSON()); }
  catch (e) { await sub.unsubscribe().catch(() => {}); sub = await subscribe(); await api('POST', '/api/push/subscribe', sub.toJSON()); }
  saveSettings({ channels: { ...getState().settings.channels, push: true } });
  const s = await api('GET', '/api/status'); setState({ status: s });
}
async function disablePushHere() {
  const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
  if (sub) { await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  const s = await api('GET', '/api/status'); setState({ status: s });
}

const PUSH_TEXT = {
  unsupported: ['This browser doesn’t support push notifications.', 'warn'],
  insecure: ['Push needs a secure (https://) connection. Ask whoever hosts Docket to enable HTTPS.', 'warn'],
  denied: ['Notifications are blocked for this site. Allow them in your browser’s site settings (lock icon in the address bar), then reload.', 'err'],
  default: ['Not enabled on this device yet.', 'muted'],
  granted: ['Permission granted, but this device isn’t subscribed yet.', 'muted'],
  subscribed: ['This device will receive reminders even when Docket is closed.', 'ok'],
};

export function ChannelStatus({ compact }) {
  const s = useStore((x) => x.settings);
  const status = useStore((x) => x.status);
  const online = useStore((x) => x.online);
  const [push, setPush] = useState({ state: 'checking' });
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const refresh = () => devicePushState().then(setPush);
  useEffect(() => { refresh(); }, []);
  const ch = s.channels;
  const setCh = (patch) => saveSettings({ channels: { ...ch, ...patch } });
  const devices = status && status.push ? status.push.devices : 0;
  const email = status && status.email;

  async function test() {
    setBusy('test'); setResult(null); unlockAudio();
    try { const d = await api('POST', '/api/notifications/test'); setResult(d.notification.deliveries); }
    catch (e) { toast(e.message, { kind: 'error' }); }
    setBusy('');
  }
  const pt = PUSH_TEXT[push.state] || ['Checking…', 'muted'];
  return (
    <section className={cx('card channels', compact && 'compact')} aria-labelledby="h-ch">
      <div className="row between wrap"><h2 id="h-ch" className="h2">Notification channels</h2>
        <button className="btn btn-primary btn-sm" disabled={!online || busy === 'test'} onClick={test}><LuBell /> {busy === 'test' ? 'Sending…' : 'Send test notification'}</button></div>
      {result && (
        <div className="alert alert-info" role="status">
          <strong>Test result:</strong>
          <ul className="plain">{Object.entries(result).map(([k, v]) => <li key={k}><span className={cx('dchip', `d-${v.status}`)}>{({ inapp: 'In-app', push: 'Push', email: 'Email', sound: 'Sound' })[k]}: {v.status}</span> {v.detail}</li>)}</ul>
          <button className="icon-btn sm" aria-label="Close result" onClick={() => setResult(null)}><LuX /></button>
        </div>
      )}
      <div className="channel-list">
        <div className="channel">
          <LuBell aria-hidden="true" />
          <div className="grow"><div className="strong">In-app notifications <span className="badge st-confirmed">Always on</span></div><div className="small muted">Pop-ups and history while Docket is open in any tab. Delivered by the server in real time.</div></div>
        </div>
        {nativeApp && <AndroidChannel />}
        {!nativeApp && <div className="channel">
          <LuSmartphone aria-hidden="true" />
          <div className="grow">
            <div className="strong">Browser / device push {ch.push ? <span className="badge st-confirmed">On</span> : <span className="badge">Off</span>}</div>
            <div className={cx('small', pt[1] === 'err' ? 'text-danger' : pt[1] === 'ok' ? 'text-ok' : 'muted')}>This device: {pt[0]}</div>
            <div className="small muted">{devices} device{devices === 1 ? '' : 's'} subscribed on your account. Delivery depends on the browser and operating system (e.g. battery saver, Do Not Disturb, or iPhone requiring Docket to be added to the Home Screen) and is not guaranteed like an alarm.</div>
          </div>
          <div className="channel-actions">
            {push.state !== 'subscribed' && push.state !== 'unsupported' && push.state !== 'insecure' && push.state !== 'denied' && <button className="btn btn-sm" disabled={!online || busy === 'push'} onClick={async () => { setBusy('push'); try { await enablePush(); toast('Push enabled on this device'); } catch (e) { toast(e.message, { kind: 'error', timeout: 8000 }); } setBusy(''); refresh(); }}>Enable on this device</button>}
            {push.state === 'subscribed' && <button className="btn btn-sm" disabled={busy === 'push'} onClick={async () => { setBusy('push'); try { await disablePushHere(); toast('This device will no longer receive push'); } catch (e) { toast(e.message, { kind: 'error' }); } setBusy(''); refresh(); }}>Remove this device</button>}
            <Toggle id="ch-push" checked={ch.push} onChange={(v) => setCh({ push: v })} label="Send push" />
          </div>
        </div>}
        <div className="channel">
          <LuMail aria-hidden="true" />
          <div className="grow">
            <div className="strong">Email reminders {email && email.configured ? (ch.email ? <span className="badge st-confirmed">On</span> : <span className="badge">Off</span>) : <span className="badge badge-warn">Needs server setup</span>}</div>
            <div className="small muted">{email ? email.detail : '…'}</div>
            {!compact && email && email.configured && <EmailAddress />}
          </div>
          <div className="channel-actions"><Toggle id="ch-email" checked={ch.email} disabled={!(email && email.configured)} onChange={(v) => setCh({ email: v })} label="Send email" /></div>
        </div>
        <div className="channel">
          <LuVolume2 aria-hidden="true" />
          <div className="grow"><div className="strong">Reminder sound</div><div className="small muted">Plays a chime in an open Docket tab. Browsers may block sound until you’ve clicked somewhere on the page; closed tabs can’t play sounds (push notifications use your device’s own sound settings).</div></div>
          <div className="channel-actions">
            <button className="btn btn-sm" onClick={() => { if (!playChime()) toast('Your browser blocked audio — click the page and try again', { kind: 'error' }); }}>Test sound</button>
            <Toggle id="ch-sound" checked={ch.sound} onChange={(v) => setCh({ sound: v })} label="Play sound" />
          </div>
        </div>
      </div>
    </section>
  );
}

function AndroidChannel() {
  const read = () => { try { return JSON.parse(nativeApp.notificationStatus()); } catch { return null; } };
  const [st, setSt] = useState(read);
  useEffect(() => {
    const t = setInterval(() => setSt(read()), 2000);
    const v = () => setSt(read()); document.addEventListener('visibilitychange', v);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', v); };
  }, []);
  if (!st) return null;
  const blocked = st.permission !== 'granted';
  return (
    <div className="channel">
      <LuSmartphone aria-hidden="true" />
      <div className="grow">
        <div className="strong">Android app notifications {blocked ? <span className="badge badge-warn">Not allowed</span> : <span className="badge st-confirmed">On</span>}</div>
        <div className={cx('small', blocked ? 'text-danger' : 'muted')}>{blocked ? 'Notifications are not allowed for the Docket app, so reminders cannot appear on this phone.' : `${st.scheduled} reminder${st.scheduled === 1 ? '' : 's'} scheduled on this phone as exact alarms — they fire even with no internet or with the app closed.`}</div>
        {!st.exactAlarms && <div className="small text-danger">Exact alarms are not allowed, so Android may deliver reminders a few minutes late.</div>}
        <div className="small muted">Last synced {st.lastSync ? formatDateTime(st.lastSync, getState().settings.timezone, getState().settings) : 'never'}{st.lastError ? ` · last error: ${st.lastError}` : ''}. Battery-saver modes on some phones can still delay notifications.</div>
      </div>
      <div className="channel-actions">
        {blocked && <button className="btn btn-sm btn-primary" onClick={() => nativeApp.requestNotificationPermission()}>Allow notifications</button>}
        {!st.exactAlarms && <button className="btn btn-sm" onClick={() => nativeApp.openExactAlarmSettings()}>Allow exact alarms</button>}
        <button className="btn btn-sm" onClick={() => { nativeApp.syncNow(); toast('Syncing reminders to this phone…'); }}>Sync now</button>
        <button className="btn btn-sm" onClick={() => nativeApp.openNotificationSettings()}>Android settings</button>
        <button className="btn btn-sm" onClick={() => nativeApp.changeServer()}>Change server…</button>
      </div>
    </div>
  );
}

function EmailAddress() {
  const s = useStore((x) => x.settings); const user = useStore((x) => x.user);
  const [v, setV] = useState(s.emailAddress || ''); const [err, setErr] = useState('');
  useEffect(() => setV(s.emailAddress || ''), [s.emailAddress]);
  return (
    <div className="row gap mt-sm">
      <input className="input" type="email" aria-label="Reminder email address" placeholder={user.email} value={v} onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { setErr('Enter a valid email'); return; } setErr(''); if (v !== s.emailAddress) saveSettings({ emailAddress: v }); }} />
      {err && <span className="field-error">{err}</span>}
    </div>
  );
}

function NotificationSettings() {
  const s = useStore((x) => x.settings);
  const [custom, setCustom] = useState('');
  const has = new Set(s.defaultReminders);
  return (
    <div className="stack">
      <ChannelStatus />
      <section className="card">
        <h2 className="h2">Default reminders</h2>
        <p className="small muted">Applied to new activities (you can change them per activity). Existing activities keep their own reminders.</p>
        <div className="chips">
          {s.defaultReminders.map((m) => <span key={m} className="chip chip-solid">{reminderLabel(m)}<button className="chip-x" aria-label={`Remove ${reminderLabel(m)}`} onClick={() => saveSettings({ defaultReminders: s.defaultReminders.filter((x) => x !== m) })}><LuX /></button></span>)}
          {!s.defaultReminders.length && <span className="muted small">None</span>}
        </div>
        <div className="row gap wrap mt-sm">
          <select className="input w-auto" aria-label="Add default reminder" value="" onChange={(e) => e.target.value && saveSettings({ defaultReminders: [...s.defaultReminders, Number(e.target.value)] })}>
            <option value="">+ Add…</option>{[0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080].filter((m) => !has.has(m)).map((m) => <option key={m} value={m}>{reminderLabel(m)}</option>)}
          </select>
          <input className="input w-80" type="number" min="1" placeholder="min" aria-label="Custom minutes before" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <button className="btn btn-sm" disabled={!(Number(custom) > 0)} onClick={() => { saveSettings({ defaultReminders: [...s.defaultReminders, Math.round(Number(custom))] }); setCustom(''); }}>Add custom (minutes)</button>
        </div>
        <div className="grid-2 mt">
          <Field label="Default preparation-task reminder" htmlFor="st-tr" hint="Used when you give a task a due date">
            <select id="st-tr" className="input" value={s.defaultTaskReminder ?? ''} onChange={(e) => saveSettings({ defaultTaskReminder: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">No reminder</option><option value={0}>At due time</option><option value={15}>15 minutes before</option><option value={60}>1 hour before</option><option value={180}>3 hours before</option><option value={1440}>1 day before</option>
            </select>
          </Field>
          <Field label="Reminder time for all-day items" htmlFor="st-adt" hint="All-day events, date-only tasks and follow-ups are reminded at this time">
            <input id="st-adt" type="time" className="input" value={s.allDayReminderTime} onChange={(e) => e.target.value && saveSettings({ allDayReminderTime: e.target.value })} />
          </Field>
        </div>
      </section>
    </div>
  );
}

// ---------- categories ----------
function Categories() {
  const cats = useStore((s) => s.categories);
  const activities = useStore((s) => s.activities);
  const [name, setName] = useState(''); const [color, setColor] = useState('#0891b2'); const [err, setErr] = useState('');
  const [deleting, setDeleting] = useState(null);
  const counts = {}; Object.values(activities).forEach((a) => { counts[a.category_id] = (counts[a.category_id] || 0) + 1; });
  const add = (e) => {
    e.preventDefault();
    const n = name.trim(); if (!n) { setErr('Enter a name'); return; }
    if (cats.some((c) => c.name.toLowerCase() === n.toLowerCase())) { setErr('A category with this name already exists'); return; }
    setErr(''); saveCategory({ id: newId('c'), name: n, color, sort: cats.length ? Math.max(...cats.map((c) => c.sort)) + 1 : 0 }, { isNew: true }).catch((e2) => toast(e2.message, { kind: 'error' }));
    setName('');
  };
  return (
    <section className="card">
      <h2 className="h2">Categories</h2>
      <p className="small muted">Colours help you scan the calendar; names are always shown too.</p>
      <ul className="cat-list">
        {cats.map((c) => <CatRow key={c.id} c={c} count={counts[c.id] || 0} onDelete={() => setDeleting(c)} all={cats} />)}
      </ul>
      <form className="row gap wrap mt" onSubmit={add}>
        <input type="color" className="color-input" aria-label="New category colour" value={color} onChange={(e) => setColor(e.target.value)} />
        <input className="input grow" placeholder="New category name" aria-label="New category name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-primary"><LuPlus /> Add category</button>
        {err && <p className="field-error w-full">{err}</p>}
      </form>
      {deleting && <DeleteCategory c={deleting} count={counts[deleting.id] || 0} cats={cats} onClose={() => setDeleting(null)} />}
    </section>
  );
}
function CatRow({ c, count, onDelete, all }) {
  const [name, setName] = useState(c.name); const [err, setErr] = useState('');
  useEffect(() => setName(c.name), [c.name]);
  const commit = (patch) => saveCategory({ id: c.id, name: c.name, color: c.color, sort: c.sort, ...patch }).catch((e) => toast(e.message, { kind: 'error' }));
  const idx = all.findIndex((x) => x.id === c.id);
  const move = (d) => { const o = all[idx + d]; if (!o) return; commit({ sort: o.sort }); saveCategory({ id: o.id, name: o.name, color: o.color, sort: c.sort }); };
  return (
    <li className="cat-row">
      <input type="color" className="color-input" aria-label={`Colour for ${c.name}`} value={c.color} onChange={(e) => commit({ color: e.target.value })} />
      <input className="input grow" aria-label="Category name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)}
        onBlur={() => { const n = name.trim(); if (!n) { setName(c.name); return; } if (all.some((x) => x.id !== c.id && x.name.toLowerCase() === n.toLowerCase())) { setErr('Name already used'); return; } setErr(''); if (n !== c.name) commit({ name: n }); }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      {err && <span className="field-error">{err}</span>}
      <span className="small muted nowrap">{count} item{count === 1 ? '' : 's'}</span>
      <button className="icon-btn" aria-label={`Move ${c.name} up`} disabled={idx === 0} onClick={() => move(-1)}>↑</button>
      <button className="icon-btn" aria-label={`Move ${c.name} down`} disabled={idx === all.length - 1} onClick={() => move(1)}>↓</button>
      <button className="icon-btn" aria-label={`Delete ${c.name}`} onClick={onDelete}><LuTrash2 /></button>
    </li>
  );
}
function DeleteCategory({ c, count, cats, onClose }) {
  const [target, setTarget] = useState('');
  return (
    <Modal open title={`Delete “${c.name}”?`} size="sm" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-danger" onClick={() => { deleteCategory(c.id, target || null).catch((e) => toast(e.message, { kind: 'error' })); toast('Category deleted'); onClose(); }}>Delete category</button>
    </>}>
      {count ? <>
        <p>{count} activit{count === 1 ? 'y uses' : 'ies use'} this category. Move {count === 1 ? 'it' : 'them'} to:</p>
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Move activities to">
          <option value="">Uncategorized</option>{cats.filter((x) => x.id !== c.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </> : <p>No activities use this category.</p>}
      <p className="small muted">Activities are never deleted when a category is removed.</p>
    </Modal>
  );
}

// ---------- data ----------
function DataSettings() {
  const activities = useStore((s) => s.activities);
  const categories = useStore((s) => s.categories);
  const online = useStore((s) => s.online);
  const [feed, setFeed] = useState(undefined);
  const [busy, setBusy] = useState('');
  const [icsCat, setIcsCat] = useState('');
  const [report, setReport] = useState(null);
  const jsonRef = useRef(null); const icsRef = useRef(null);
  const sampleCount = Object.values(activities).filter((a) => a.is_sample).length;
  useEffect(() => { api('GET', '/api/ics-token').then((d) => setFeed(d.token)).catch(() => setFeed(null)); }, []);
  const feedUrl = feed ? `${location.origin}/ics/${feed}.ics` : '';

  async function importFile(file, kind) {
    setReport(null);
    if (file.size > 10 * 1024 * 1024) { toast('File is too large (max 10 MB)', { kind: 'error' }); return; }
    const text = await file.text();
    setBusy(kind);
    try {
      let r;
      if (kind === 'json') { let data; try { data = JSON.parse(text); } catch { throw new Error('This file is not valid JSON'); } r = await api('POST', '/api/import', { data }, { timeout: 120000 }); }
      else r = await api('POST', '/api/import/ics', { text, category_id: icsCat || null }, { timeout: 120000 });
      setReport(r);
    } catch (e) { toast(`Import failed: ${e.message}`, { kind: 'error', timeout: 8000 }); }
    setBusy('');
  }
  return (
    <div className="stack">
      <section className="card">
        <h2 className="h2">Export</h2>
        <p className="small muted">Download a complete copy of your data any time.</p>
        <div className="row gap wrap">
          <button className="btn" disabled={!online} onClick={() => downloadUrl('/api/export')}><LuDownload /> Export everything (.json)</button>
          <button className="btn" disabled={!online} onClick={() => downloadUrl('/api/export.ics')}><LuDownload /> Export calendar (.ics)</button>
        </div>
        <p className="small muted mt-sm">The .json export includes activities, categories, checklists, reminders and settings (attachment files are listed but not included). The .ics file works with Google Calendar, Apple Calendar and Outlook; activities without a confirmed date are not included.</p>
      </section>
      <section className="card">
        <h2 className="h2">Import</h2>
        <div className="row gap wrap">
          <input ref={jsonRef} type="file" accept=".json,application/json" hidden onChange={(e) => { e.target.files[0] && importFile(e.target.files[0], 'json'); e.target.value = ''; }} />
          <button className="btn" disabled={!online || !!busy} onClick={() => jsonRef.current.click()}><LuUpload /> {busy === 'json' ? 'Importing…' : 'Import Docket backup (.json)'}</button>
        </div>
        <div className="row gap wrap mt-sm">
          <input ref={icsRef} type="file" accept=".ics,text/calendar" hidden onChange={(e) => { e.target.files[0] && importFile(e.target.files[0], 'ics'); e.target.value = ''; }} />
          <button className="btn" disabled={!online || !!busy} onClick={() => icsRef.current.click()}><LuUpload /> {busy === 'ics' ? 'Importing…' : 'Import calendar file (.ics)'}</button>
          <select className="input w-auto" aria-label="Category for imported events" value={icsCat} onChange={(e) => setIcsCat(e.target.value)}><option value="">…into: Uncategorized</option>{categories.map((c) => <option key={c.id} value={c.id}>…into: {c.name}</option>)}</select>
        </div>
        <p className="small muted mt-sm">Importing never overwrites: items that already exist (same id or calendar UID) are skipped, so importing the same file twice won’t create duplicates.</p>
        {report && <div className="alert alert-info mt-sm" role="status">
          Imported {report.activitiesAdded} activit{report.activitiesAdded === 1 ? 'y' : 'ies'}{report.categoriesAdded ? ` and ${report.categoriesAdded} categories` : ''}. {report.skippedExisting ? `${report.skippedExisting} already existed and were skipped.` : ''}
          {report.errors && report.errors.length > 0 && <><br /><strong>{report.errors.length} could not be imported:</strong><ul className="plain">{report.errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}</ul></>}
        </div>}
      </section>
      <section className="card">
        <h2 className="h2">Calendar subscription feed</h2>
        <p className="small muted">Subscribe to this private URL in Google Calendar (“From URL”), Apple Calendar or Outlook to see your Docket activities there. It is read-only, and those apps refresh it on their own schedule (often every few hours). Anyone with the link can read your schedule — regenerate it if it leaks.</p>
        {feed === undefined ? <p className="small muted">Loading…</p> : feed ? (
          <>
            <div className="row gap"><input className="input grow mono" readOnly value={feedUrl} aria-label="Feed URL" onFocus={(e) => e.target.select()} />
              <button className="btn" onClick={() => navigator.clipboard.writeText(feedUrl).then(() => toast('Copied'), () => toast('Copy failed — select the text instead', { kind: 'error' }))}><LuCopy /> Copy</button></div>
            <div className="row gap mt-sm">
              <button className="btn btn-sm" onClick={async () => { if (await confirmDialog({ title: 'Regenerate feed URL?', message: 'The old URL will stop working; you’ll need to re-subscribe with the new one.', confirmLabel: 'Regenerate' })) api('POST', '/api/ics-token').then((d) => setFeed(d.token)); }}><LuRefreshCw /> Regenerate</button>
              <button className="btn btn-sm" onClick={() => api('DELETE', '/api/ics-token').then(() => setFeed(null))}>Turn off feed</button>
            </div>
          </>
        ) : <button className="btn" disabled={!online} onClick={() => api('POST', '/api/ics-token').then((d) => setFeed(d.token)).catch((e) => toast(e.message, { kind: 'error' }))}>Create private feed URL</button>}
      </section>
      <section className="card">
        <h2 className="h2">Sample data</h2>
        <p className="small muted">Sample activities are clearly labelled and kept separate from your own; removing them never touches your data.</p>
        {sampleCount ? <button className="btn" disabled={!online} onClick={async () => { if (await confirmDialog({ title: 'Remove sample data?', message: `${sampleCount} sample activities will be deleted. Your own activities are not affected.`, confirmLabel: 'Remove', danger: true })) api('DELETE', '/api/sample-data').then((d) => toast(`Removed ${d.removed} sample activities`)).catch((e) => toast(e.message, { kind: 'error' })); }}><LuTrash2 /> Remove {sampleCount} sample activities</button>
          : <button className="btn" disabled={!online} onClick={() => api('POST', '/api/sample-data').then(() => toast('Sample data added')).catch((e) => toast(e.message, { kind: 'error' }))}>Load sample data</button>}
      </section>
    </div>
  );
}

// ---------- account ----------
function Account() {
  const user = useStore((s) => s.user);
  const online = useStore((s) => s.online);
  const [name, setName] = useState(user.name || '');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' }); const [pwErr, setPwErr] = useState({});
  const [sessions, setSessions] = useState(null);
  const loadSessions = () => api('GET', '/api/account/sessions').then((d) => setSessions(d.sessions)).catch(() => {});
  useEffect(() => { loadSessions(); }, []);
  async function changePw(e) {
    e.preventDefault(); const errs = {};
    if (!pw.current) errs.current = 'Enter your current password';
    if (pw.next.length < 8) errs.next = 'Use at least 8 characters';
    if (pw.next !== pw.confirm) errs.confirm = 'Passwords don’t match';
    setPwErr(errs); if (Object.keys(errs).length) return;
    try { await api('POST', '/api/account/password', { current: pw.current, next: pw.next }); setPw({ current: '', next: '', confirm: '' }); toast('Password changed. Other devices were signed out.', { kind: 'success' }); loadSessions(); }
    catch (er) { setPwErr(er.extra && er.extra.fields ? er.extra.fields : { current: er.message }); }
  }
  async function del() {
    const pass = await confirmDialog({ title: 'Delete your account?', message: 'This permanently deletes your account, all activities, reminders, attachments and settings from the server. Export your data first if you want a copy. This cannot be undone.', confirmLabel: 'Delete my account', danger: true, input: true, inputType: 'password', inputLabel: 'Enter your password to confirm' });
    if (!pass) return;
    try { await api('POST', '/api/account/delete', { password: pass }); toast('Account deleted'); setTimeout(() => location.reload(), 600); }
    catch (e) { toast(e.message, { kind: 'error' }); }
  }
  return (
    <div className="stack">
      <section className="card">
        <h2 className="h2">Profile</h2>
        <div className="grid-2">
          <Field label="Name" htmlFor="ac-name"><input id="ac-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={() => name !== user.name && api('PUT', '/api/account', { name }).then((d) => { setState((s) => ({ user: { ...s.user, name: d.name } })); toast('Name saved'); }).catch((e) => toast(e.message, { kind: 'error' }))} /></Field>
          <Field label="Email (sign-in)"><input className="input" value={user.email} readOnly /></Field>
        </div>
      </section>
      <section className="card">
        <h2 className="h2">Change password</h2>
        <form onSubmit={changePw} noValidate className="grid-3">
          <Field label="Current password" htmlFor="pw-c" error={pwErr.current}><input id="pw-c" type="password" className="input" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <Field label="New password" htmlFor="pw-n" error={pwErr.next}><input id="pw-n" type="password" className="input" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
          <Field label="Confirm new password" htmlFor="pw-cf" error={pwErr.confirm}><input id="pw-cf" type="password" className="input" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          <div><button className="btn btn-primary" disabled={!online}>Change password</button></div>
        </form>
      </section>
      <section className="card">
        <h2 className="h2">Signed-in devices</h2>
        {sessions ? <ul className="plain sessions">{sessions.map((s, i) => <li key={i}><strong>{s.current ? 'This device' : 'Other device'}</strong> <span className="small muted">{(s.user_agent || 'Unknown browser').slice(0, 90)} · last active {new Date(s.last_seen).toLocaleString()}</span></li>)}</ul> : <p className="small muted">…</p>}
        <div className="row gap wrap mt-sm">
          <button className="btn" disabled={!online} onClick={() => api('POST', '/api/auth/logout-others').then((d) => { toast(`Signed out ${d.ended} other session(s)`); loadSessions(); })}><LuShield /> Sign out all other devices</button>
          <button className="btn" onClick={logout}><LuLogOut /> Sign out</button>
        </div>
      </section>
      <section className="card">
        <h2 className="h2">Privacy</h2>
        <ul className="plain small">
          <li>Your data is stored only in this Docket server’s database and is visible only to your account.</li>
          <li>Passwords are hashed (scrypt); sessions use secure, HTTP-only cookies.</li>
          <li>This browser keeps a cached copy for fast and offline viewing; it is cleared when you sign out.</li>
          <li>Reminder emails and push messages contain the activity title and time.</li>
        </ul>
        <button className="btn btn-danger mt" disabled={!online} onClick={del}><LuTrash2 /> Delete account…</button>
      </section>
    </div>
  );
}

function Integrations() {
  const status = useStore((s) => s.status);
  const list = (status && status.integrations) || [];
  return (
    <section className="card">
      <h2 className="h2">Integrations</h2>
      <ul className="integ-list">
        {list.map((i) => (
          <li key={i.id}>
            <LuPlug aria-hidden="true" />
            <div className="grow"><div className="strong">{i.name} {i.status === 'available' ? <span className="badge st-confirmed">Available</span> : <span className="badge">Not included</span>}</div><div className="small muted">{i.detail}</div></div>
            {i.status === 'available' && <button className="btn btn-sm" onClick={() => navigate('/settings/data')}>Set up</button>}
          </li>
        ))}
        <li><LuMail aria-hidden="true" /><div className="grow"><div className="strong">Email delivery (SMTP) {status && status.email.configured ? <span className="badge st-confirmed">Configured</span> : <span className="badge badge-warn">Not configured</span>}</div><div className="small muted">{status ? status.email.detail : ''}. Configured by the server administrator with SMTP_* environment variables.</div></div></li>
        <li><LuSmartphone aria-hidden="true" /><div className="grow"><div className="strong">Web push (VAPID) <span className="badge st-confirmed">Configured</span></div><div className="small muted">Keys {status && status.push.keySource === 'environment' ? 'provided by the server environment' : 'generated automatically and stored on the server'}. Requires HTTPS in production.</div></div></li>
      </ul>
    </section>
  );
}
