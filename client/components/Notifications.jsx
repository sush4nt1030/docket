import { useEffect, useState } from 'react';
import { LuBell, LuBellOff, LuCheck, LuClock, LuTrash2 } from 'react-icons/lu';
import { useStore, notificationAction, api, toast } from '../store.js';
import { EmptyState, Segmented, Menu } from './ui.jsx';
import { formatDateTime, navigate, cx } from '../lib.js';
import { reminderLabel } from '../../shared/model.js';
import { ChannelStatus } from './Settings.jsx';

const DELIVERY_LABEL = { delivered: 'delivered', sent: 'sent', partial: 'partly sent', failed: 'failed', off: 'off', 'not-configured': 'not configured', 'no-devices': 'no devices', requested: 'on' };
const CH = { inapp: 'In-app', push: 'Push', email: 'Email', sound: 'Sound' };

export function NotificationsView() {
  const list = useStore((s) => s.notifications);
  const settings = useStore((s) => s.settings);
  const activities = useStore((s) => s.activities);
  const online = useStore((s) => s.online);
  const [filter, setFilter] = useState('all');
  const [jobs, setJobs] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('GET', '/api/reminders/upcoming').then((d) => setJobs(d.jobs)).catch(() => setJobs(null)); }, [activities]);
  const shown = list.filter((n) => filter === 'all' || (filter === 'unread' ? !n.read_at && !n.dismissed_at : n.kind === 'test'));
  const act = (n, action, body) => notificationAction(n.id, action, body).then(() => action === 'snooze' && toast(`Snoozed — reminder again in ${body.minutes >= 60 ? `${body.minutes / 60} h` : `${body.minutes} min`}`)).catch((e) => toast(e.message, { kind: 'error' }));

  return (
    <div className="notif-page">
      <header className="page-head">
        <div><h1>Notifications</h1><p className="muted">Reminder history and delivery status.</p></div>
        <div className="row gap wrap">
          <button className="btn" disabled={!online} onClick={() => api('POST', '/api/notifications/read-all').catch((e) => toast(e.message, { kind: 'error' }))}><LuCheck /> Mark all read</button>
          <button className="btn" disabled={!online || busy} onClick={async () => { setBusy(true); try { await api('POST', '/api/notifications/test'); } catch (e) { toast(e.message, { kind: 'error' }); } setBusy(false); }}><LuBell /> Send test notification</button>
        </div>
      </header>
      <ChannelStatus compact />
      <div className="notif-layout">
        <section aria-labelledby="h-hist">
          <div className="row between mb">
            <h2 id="h-hist" className="h2">History</h2>
            <div className="row gap">
              <Segmented size="sm" label="Filter" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }, { value: 'test', label: 'Tests' }]} />
              <button className="btn btn-sm" disabled={!online} onClick={() => api('POST', '/api/notifications/clear').catch((e) => toast(e.message, { kind: 'error' }))}><LuTrash2 /> Clear read</button>
            </div>
          </div>
          {shown.length === 0 ? <EmptyState icon={<LuBellOff />} title="No notifications yet">Reminders you receive will be listed here with their delivery status.</EmptyState> : (
            <ul className="notif-list">
              {shown.map((n) => (
                <li key={n.id} className={cx('notif', !n.read_at && !n.dismissed_at && 'unread', n.dismissed_at && 'dismissed')}>
                  <div className="notif-main">
                    <div className="notif-title">{n.title}</div>
                    <div className="notif-body">{n.body}</div>
                    <div className="notif-meta small muted">
                      {formatDateTime(n.created_at, settings.timezone, settings, { weekday: true })}
                      {n.fire_at && n.created_at - n.fire_at > 120000 && ' · delivered late (server was unavailable)'}
                      {n.snoozed_until && n.snoozed_until > Date.now() && ` · snoozed until ${formatDateTime(n.snoozed_until, settings.timezone, settings)}`}
                      {n.dismissed_at && ' · dismissed'}
                    </div>
                    <div className="deliveries">
                      {Object.entries(n.deliveries || {}).map(([k, v]) => <span key={k} className={cx('dchip', `d-${v.status}`)} title={v.detail}>{CH[k] || k}: {DELIVERY_LABEL[v.status] || v.status}</span>)}
                    </div>
                  </div>
                  <div className="notif-actions">
                    {n.activity_id && activities[n.activity_id] && <button className="btn btn-sm" onClick={() => { navigate(`/activity/${n.activity_id}`); if (!n.read_at) act(n, 'read'); }}>Open</button>}
                    {!n.dismissed_at && <Menu label="Snooze" icon={<LuClock />}>
                      {[5, 10, 30, 60, 180, 1440].map((m) => <button key={m} role="menuitem" onClick={() => act(n, 'snooze', { minutes: m })}>Snooze {m >= 60 ? `${m / 60} hour${m > 60 ? 's' : ''}` : `${m} minutes`}</button>)}
                    </Menu>}
                    {!n.dismissed_at && <button className="btn btn-sm" onClick={() => act(n, 'dismiss')}>Dismiss</button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <aside aria-labelledby="h-sched" className="card sched-card">
          <h2 id="h-sched" className="h2">Scheduled reminders</h2>
          <p className="small muted">Stored on the server — they are sent even when every Docket tab is closed.</p>
          {jobs === null ? <p className="small muted">{online ? 'Loading…' : 'Unavailable offline.'}</p> : jobs.length === 0 ? <p className="small muted">No reminders scheduled in the next 60 days.</p> : (
            <ul className="sched-list">{jobs.slice(0, 25).map((j) => { const a = activities[j.activity_id]; return (
              <li key={j.id}><span className="small strong">{formatDateTime(j.fire_at, settings.timezone, settings, { weekday: true })}</span>
                <button className="link-btn small left" onClick={() => a && navigate(`/activity/${a.id}`)}>{a ? a.title : 'Activity'}</button>
                <span className="small muted">{j.kind === 'task' ? 'preparation task' : j.kind === 'followup' ? 'follow-up' : j.kind === 'snooze' ? 'snoozed reminder' : reminderLabel(j.offset_min)}</span></li>); })}
            </ul>)}
        </aside>
      </div>
    </div>
  );
}
