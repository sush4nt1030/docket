import { useEffect, useRef, useState } from 'react';
import { LuLayoutDashboard, LuCalendarDays, LuList, LuHourglass, LuListChecks, LuBell, LuArchive, LuSettings, LuPlus, LuMenu, LuCalendarClock, LuWifiOff, LuTriangleAlert, LuSearch, LuEllipsis, LuRefreshCw } from 'react-icons/lu';
import { useStore, bootstrap, retryNow, resolveConflict, unlockAudio, ls, logout } from '../store.js';
import { useRoute, navigate, cx, formatDateTime, todayStr, taskDueMs, isActiveStatus, useNow } from '../lib.js';
import { AuthScreen, SessionExpiredModal } from './Auth.jsx';
import { ConfirmHost, Toasts, SaveIndicator, Modal, Spinner } from './ui.jsx';
import { Dashboard } from './Dashboard.jsx';
import { CalendarView } from './Calendar.jsx';
import { Agenda, PendingView, ArchiveView } from './Agenda.jsx';
import { TasksView } from './Tasks.jsx';
import { NotificationsView } from './Notifications.jsx';
import { SettingsView } from './Settings.jsx';
import { Editor } from './Editor.jsx';
import { ActivityDetail } from './ActivityDetail.jsx';

export function App() {
  const phase = useStore((s) => s.phase);
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => { bootstrap(); }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'system' ? '' : theme;
    ls.set('docket:theme', theme);
  }, [theme]);
  useEffect(() => { const u = () => unlockAudio(); window.addEventListener('pointerdown', u, { once: true }); window.addEventListener('keydown', u, { once: true }); }, []);

  if (phase === 'loading') return <div className="boot"><Spinner label="Loading your schedule" /></div>;
  if (phase === 'auth') return <><AuthScreen /><Toasts /></>;
  if (phase === 'unreachable') return <Unreachable />;
  return <Shell />;
}

function Unreachable() {
  const err = useStore((s) => s.loadError);
  return (
    <div className="boot">
      <div className="card unreachable">
        <LuWifiOff aria-hidden="true" className="big-icon" />
        <h1>Can’t reach Docket</h1>
        <p className="muted">{err || 'The server is not responding.'} No data has been lost — everything is stored on the server. Retrying automatically…</p>
        <button className="btn btn-primary" onClick={() => retryNow()}><LuRefreshCw /> Try again now</button>
      </div>
    </div>
  );
}

const NAV = [
  { path: '/', label: 'Dashboard', icon: <LuLayoutDashboard /> },
  { path: '/calendar', label: 'Calendar', icon: <LuCalendarDays /> },
  { path: '/agenda', label: 'Agenda', icon: <LuList /> },
  { path: '/pending', label: 'Awaiting date', icon: <LuHourglass />, badge: 'tbd' },
  { path: '/tasks', label: 'Preparation', icon: <LuListChecks />, badge: 'overdue' },
  { path: '/notifications', label: 'Notifications', icon: <LuBell />, badge: 'unread' },
  { path: '/archive', label: 'Archive', icon: <LuArchive /> },
  { path: '/settings', label: 'Settings', icon: <LuSettings /> },
];

function useCounts() {
  const activities = useStore((s) => s.activities);
  const notifications = useStore((s) => s.notifications);
  const settings = useStore((s) => s.settings);
  const now = useNow(60000);
  const vals = Object.values(activities);
  let overdue = 0;
  for (const a of vals) if (!a.archived && isActiveStatus(a.status)) for (const t of a.checklist || []) { if (!t.done) { const d = taskDueMs(a, t, settings); if (d && d < now) overdue++; } }
  return {
    tbd: vals.filter((a) => !a.archived && a.schedule === 'tbd' && a.status !== 'cancelled').length,
    overdue,
    unread: notifications.filter((n) => !n.read_at && !n.dismissed_at).length,
  };
}

function Shell() {
  const route = useRoute();
  const user = useStore((s) => s.user);
  const fromCache = useStore((s) => s.fromCache);
  const online = useStore((s) => s.online);
  const live = useStore((s) => s.live);
  const cacheSavedAt = useStore((s) => s.cacheSavedAt);
  const settings = useStore((s) => s.settings);
  const conflicts = useStore((s) => s.conflicts);
  const counts = useCounts();
  const [editor, setEditor] = useState(null);
  const [drawer, setDrawer] = useState(false);
  const [showConflicts, setShowConflicts] = useState(false);
  const lastMain = useRef('/');
  const mainRef = useRef(null);

  const isActivity = route.path.startsWith('/activity/');
  if (!isActivity && route.path !== '/new') lastMain.current = route.raw;
  const mainPath = isActivity || route.path === '/new' ? lastMain.current.split('?')[0] : route.path;

  const openNew = (preset) => setEditor({ id: null, preset: preset || {} });
  const openEdit = (id, opts = {}) => setEditor({ id, focus: opts.focus });

  useEffect(() => { if (route.path === '/new') { openNew(route.params.tbd ? { schedule: 'tbd' } : {}); history.replaceState(null, '', `#${lastMain.current}`); } }, [route.path]);
  useEffect(() => { setDrawer(false); if (!isActivity && mainRef.current) mainRef.current.focus({ preventScroll: true }); }, [route.path]);
  useEffect(() => {
    const k = (e) => {
      if (e.target.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal')) return;
      if (e.key === 'n') { e.preventDefault(); openNew(); }
      if (e.key === '/' && !route.path.startsWith('/agenda')) { e.preventDefault(); navigate('/agenda'); setTimeout(() => { const el = document.querySelector('.search-box input'); el && el.focus(); }, 50); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [route.path]);

  const closeDetail = () => { if (history.length > 1 && lastMain.current) navigate(lastMain.current.split('?')[0], Object.fromEntries(new URLSearchParams(lastMain.current.split('?')[1] || ''))); else navigate('/'); };
  const activityId = isActivity ? decodeURIComponent(route.path.slice('/activity/'.length)) : null;

  let page;
  if (mainPath === '/calendar') page = <CalendarView onNew={openNew} />;
  else if (mainPath === '/agenda') page = <Agenda />;
  else if (mainPath === '/pending') page = <PendingView onNew={openNew} />;
  else if (mainPath === '/tasks') page = <TasksView />;
  else if (mainPath === '/notifications') page = <NotificationsView />;
  else if (mainPath === '/archive') page = <ArchiveView />;
  else if (mainPath.startsWith('/settings')) page = <SettingsView />;
  else page = <Dashboard onNew={openNew} />;

  const navItem = (n, mobile) => {
    const active = n.path === '/' ? mainPath === '/' : mainPath.startsWith(n.path);
    const badge = n.badge ? counts[n.badge] : 0;
    return (
      <a key={n.path} href={`#${n.path}`} className={cx('nav-item', active && 'active')} aria-current={active ? 'page' : undefined}>
        <span className="nav-icon" aria-hidden="true">{n.icon}</span><span className="nav-label">{mobile && n.short ? n.short : n.label}</span>
        {badge > 0 && <span className={cx('nav-badge', n.badge === 'overdue' && 'danger')} aria-label={`${badge} ${n.badge}`}>{badge}</span>}
      </a>
    );
  };

  return (
    <div className="app">
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); mainRef.current && mainRef.current.focus(); }}>Skip to content</a>
      <aside className={cx('sidebar', drawer && 'open')} aria-label="Main navigation">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><LuCalendarClock /></span> Docket</div>
        <button className="btn btn-primary btn-block new-btn" onClick={() => openNew()}><LuPlus /> New activity <kbd>N</kbd></button>
        <nav className="nav">{NAV.map((n) => navItem(n))}</nav>
        <div className="sidebar-foot">
          <div className="user-chip" title={user.email}><span className="avatar" aria-hidden="true">{(user.name || user.email)[0].toUpperCase()}</span><span className="user-text"><span>{user.name || 'Signed in'}</span><small>{user.email}</small></span></div>
          <button className="link-btn small" onClick={logout}>Sign out</button>
        </div>
      </aside>
      {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}
      <div className="main-col">
        <header className="topbar">
          <button className="icon-btn mobile-only" aria-label="Open menu" aria-expanded={drawer} onClick={() => setDrawer(true)}><LuMenu /></button>
          <div className="brand mobile-only"><span className="brand-mark sm" aria-hidden="true"><LuCalendarClock /></span> Docket</div>
          <button className="search-trigger desktop-only" onClick={() => { navigate('/agenda'); setTimeout(() => { const el = document.querySelector('.search-box input'); el && el.focus(); }, 50); }}><LuSearch aria-hidden="true" /> Search activities <kbd>/</kbd></button>
          <div className="grow" />
          <span className={cx('live-dot', live === 'live' && online ? 'on' : 'off')} title={live === 'live' && online ? 'Live sync connected' : 'Live sync disconnected — reconnecting'}><span className="sr-only">{live === 'live' && online ? 'Live sync connected' : 'Live sync disconnected'}</span></span>
          <SaveIndicator />
          <button className="icon-btn notif-btn" aria-label={`Notifications${counts.unread ? `, ${counts.unread} unread` : ''}`} onClick={() => navigate('/notifications')}><LuBell />{counts.unread > 0 && <span className="dot-badge">{counts.unread > 9 ? '9+' : counts.unread}</span>}</button>
        </header>
        {(fromCache || !online) && (
          <div className="banner banner-warn" role="status"><LuWifiOff aria-hidden="true" />
            <span>{fromCache ? `You’re offline. Showing the copy saved on this device${cacheSavedAt ? ` at ${formatDateTime(cacheSavedAt, settings.timezone, settings)}` : ''}.` : 'Connection lost.'} Changes you make are kept on this device and sync automatically when you’re back online.</span>
            <button className="btn btn-sm" onClick={retryNow}>Retry now</button>
          </div>
        )}
        {conflicts.length > 0 && (
          <div className="banner banner-err" role="alert"><LuTriangleAlert aria-hidden="true" />
            <span>{conflicts.length} change{conflicts.length > 1 ? 's' : ''} conflict with a newer version saved on another device or tab.</span>
            <button className="btn btn-sm" onClick={() => setShowConflicts(true)}>Review</button>
          </div>
        )}
        <main id="main" className="main" ref={mainRef} tabIndex={-1}>{page}</main>
        <nav className="bottom-nav" aria-label="Quick navigation">
          {[NAV[0], { ...NAV[1] }, { ...NAV[2] }].map((n) => navItem(n, true))}
          <button className="fab" aria-label="New activity" onClick={() => openNew()}><LuPlus /></button>
          {navItem({ ...NAV[5], short: 'Alerts' }, true)}
          <button className="nav-item" onClick={() => setDrawer(true)} aria-label="More"><span className="nav-icon" aria-hidden="true"><LuEllipsis /></span><span className="nav-label">More</span>{(counts.tbd + counts.overdue) > 0 && <span className="nav-badge">{counts.tbd + counts.overdue}</span>}</button>
        </nav>
      </div>

      {activityId && !editor && <ActivityDetail id={activityId} onDate={route.params.on} onClose={closeDetail} onEdit={openEdit} />}
      {editor && <Editor key={editor.id || 'new'} id={editor.id} preset={editor.preset} focus={editor.focus} onClose={() => setEditor(null)} />}
      {showConflicts && <ConflictModal conflicts={conflicts} onClose={() => setShowConflicts(false)} />}
      <SessionExpiredModal />
      <ConfirmHost />
      <Toasts />
    </div>
  );
}

function ConflictModal({ conflicts, onClose }) {
  useEffect(() => { if (!conflicts.length) onClose(); }, [conflicts.length]);
  return (
    <Modal open title="Resolve conflicting changes" onClose={onClose} size="md">
      <p className="muted">These items were changed somewhere else while your edits were waiting to save. Choose which version to keep.</p>
      {conflicts.map((c, i) => (
        <div key={i} className="conflict">
          <div className="strong">{(c.mine && (c.mine.title || c.mine.name)) || 'Item'}</div>
          <div className="small muted">{c.theirs ? `Newer version saved elsewhere: “${c.theirs.title || c.theirs.name}”${c.theirs.start_date ? ` on ${c.theirs.start_date} ${c.theirs.start_time || ''}` : ''}` : 'This item was deleted on another device.'}</div>
          <div className="small">Your version: {c.mine.start_date ? `${c.mine.start_date} ${c.mine.start_time || ''}` : ''} {c.mine.status || ''}</div>
          <div className="row gap mt-sm">
            <button className="btn btn-sm btn-primary" onClick={() => resolveConflict(c, 'mine')}>{c.theirs ? 'Keep my version' : 'Restore with my changes'}</button>
            <button className="btn btn-sm" onClick={() => resolveConflict(c, 'theirs')}>{c.theirs ? 'Keep the other version' : 'Leave it deleted'}</button>
          </div>
        </div>
      ))}
    </Modal>
  );
}
