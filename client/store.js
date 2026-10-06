// Client state, API access, offline queue and real-time sync.
// The server is the source of truth. localStorage is only used for:
//   - a read-only cache of the last loaded data (fast start / offline viewing)
//   - the queue of changes waiting to sync, and unsaved form drafts.
import { useSyncExternalStore } from 'react';
import { newId, normalizeActivity, DEFAULT_SETTINGS } from '../shared/model.js';

export const CLIENT_ID = newId('k');
const TAB_ID = (() => {
  try { let t = sessionStorage.getItem('docket:tab'); if (!t) { t = newId('tab'); sessionStorage.setItem('docket:tab', t); } return t; } catch { return newId('tab'); }
})();

const ls = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
  keys() { try { return Object.keys(localStorage); } catch { return []; } },
};
export { ls };

let state = {
  phase: 'loading', // loading | auth | ready | unreachable
  user: null, settings: DEFAULT_SETTINGS, settingsVersion: 0,
  categories: [], activities: {}, notifications: [], status: null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  live: 'connecting', // connecting | live | offline
  fromCache: false,
  save: { state: 'idle', message: '', at: 0 },
  queue: [], conflicts: [], toasts: [], sessionExpired: false,
  serverOffset: 0,
};
const listeners = new Set();
export const getState = () => state;
export function setState(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
export function useStore(selector) { return useSyncExternalStore(subscribe, () => selector(state)); }

// ---------- toasts ----------
export function toast(message, opts = {}) {
  const t = { id: newId('t'), message, kind: opts.kind || 'info', action: opts.action, notification: opts.notification, timeout: opts.timeout ?? (opts.notification ? 120000 : 4500) };
  setState((s) => ({ toasts: [...s.toasts, t].slice(-5) }));
  if (t.timeout) setTimeout(() => dismissToast(t.id), t.timeout);
  return t.id;
}
export const dismissToast = (id) => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
  get retryable() { return this.status === 0 || this.status >= 500 || this.status === 429; }
}
export async function api(method, url, body, { raw = false, headers = {}, timeout = 20000 } = {}) {
  let res;
  const h = { 'X-Docket': '1', 'X-Client-Id': CLIENT_ID, ...headers };
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  try {
    res = await fetch(url, { method, headers: h, credentials: 'same-origin', body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout ? AbortSignal.timeout(timeout) : undefined });
  } catch (err) {
    markOffline();
    throw new ApiError(0, 'network', err && err.name === 'TimeoutError' ? 'The server took too long to respond.' : 'Can’t reach the server. Check your internet connection.');
  }
  markOnline();
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const e = (data && data.error) || {};
    if (res.status === 401 && state.user) setState({ sessionExpired: true });
    throw new ApiError(res.status, e.code || 'http', e.message || `Request failed (HTTP ${res.status})`, e);
  }
  return data;
}
function markOffline() { if (state.online) setState({ online: false }); }
function markOnline() { if (!state.online) { setState({ online: true }); setTimeout(flush, 50); } }

// ---------- cache ----------
let cacheTimer = null;
function cacheKey() { return state.user ? `docket:cache:${state.user.id}` : null; }
function scheduleCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    const k = cacheKey(); if (!k) return;
    ls.set(k, { savedAt: Date.now(), user: state.user, settings: state.settings, settingsVersion: state.settingsVersion, categories: state.categories, activities: state.activities, notifications: state.notifications.slice(0, 100), status: state.status });
    ls.set('docket:lastUser', state.user.id);
  }, 400);
}
listeners.add(() => { if (state.phase === 'ready' && !state.fromCache) scheduleCache(); });

// ---------- bootstrap ----------
export async function bootstrap({ silent = false } = {}) {
  try {
    const d = await api('GET', '/api/bootstrap');
    const activities = {};
    for (const a of d.activities) activities[a.id] = a;
    const lastUser = ls.get('docket:lastUser');
    if (lastUser && lastUser !== d.user.id) { clearLocalData(lastUser); }
    setState({ phase: 'ready', fromCache: false, user: d.user, settings: d.settings, settingsVersion: d.settingsVersion, categories: d.categories, notifications: d.notifications, status: d.status, sessionExpired: false, serverOffset: d.serverTime - Date.now() });
    loadQueue();
    // apply optimistic state of anything still waiting to sync on top of server data
    const acts = { ...activities };
    for (const op of state.queue) if (op.kind === 'activity') { if (op.action === 'delete') delete acts[op.id]; else acts[op.id] = { ...(acts[op.id] || {}), ...op.body, version: acts[op.id] ? acts[op.id].version : 0, attachments: acts[op.id] ? acts[op.id].attachments : [] }; }
    setState({ activities: acts });
    connectEvents();
    flush();
    return true;
  } catch (err) {
    if (err.status === 401) { setState({ phase: 'auth', user: null, sessionExpired: false }); return false; }
    if (!silent) {
      const lastUser = ls.get('docket:lastUser');
      const cached = lastUser && ls.get(`docket:cache:${lastUser}`);
      if (cached && state.phase !== 'ready') {
        setState({ phase: 'ready', fromCache: true, user: cached.user, settings: cached.settings, settingsVersion: cached.settingsVersion, categories: cached.categories, activities: cached.activities, notifications: cached.notifications, status: cached.status, cacheSavedAt: cached.savedAt });
        loadQueue();
      } else if (state.phase !== 'ready') setState({ phase: 'unreachable', loadError: err.message });
    }
    scheduleRetry();
    return false;
  }
}

function clearLocalData(userId) {
  for (const k of ls.keys()) if (k.startsWith(`docket:cache:${userId}`) || k.startsWith(`docket:queue:${userId}`) || k.startsWith('docket:draft:')) ls.del(k);
}

// ---------- auth ----------
export async function login(email, password) { await api('POST', '/api/auth/login', { email, password }); await bootstrap(); }
export async function register(email, password, name) { await api('POST', '/api/auth/register', { email, password, name }); await bootstrap(); }
export async function logout() {
  if (state.queue.length && !confirm(`${state.queue.length} change(s) have not synced yet and will be lost if you sign out. Sign out anyway?`)) return;
  try { await api('POST', '/api/auth/logout'); } catch {}
  const uid = state.user && state.user.id;
  if (uid) clearLocalData(uid);
  ls.del('docket:lastUser');
  disconnectEvents();
  try { if (window.DocketAndroid) window.DocketAndroid.onSignedOut(); } catch {}
  setState({ phase: 'auth', user: null, activities: {}, categories: [], notifications: [], queue: [], conflicts: [] });
}
export async function relogin(email, password) {
  await api('POST', '/api/auth/login', { email, password });
  setState({ sessionExpired: false });
  await bootstrap({ silent: true });
}

// ---------- offline-safe change queue ----------
// Each tab owns a queue key (so tabs never overwrite each other's pending changes);
// queues left behind by closed tabs are adopted by the next tab that starts.
const qKey = () => `docket:queue:${state.user.id}:${TAB_ID}`;
const hbKey = (tab) => `docket:hb:${tab}`;
let inflight = null;
const resolvers = new Map();

function persistQueue() { if (state.user) { if (state.queue.length) ls.set(qKey(), state.queue); else ls.del(qKey()); } }
function loadQueue() {
  if (!state.user) return;
  let q = ls.get(qKey()) || [];
  const prefix = `docket:queue:${state.user.id}:`;
  for (const k of ls.keys()) {
    if (!k.startsWith(prefix) || k === qKey()) continue;
    const tab = k.slice(prefix.length); const hb = ls.get(hbKey(tab));
    if (!hb || Date.now() - hb > 15000) { q = q.concat(ls.get(k) || []); ls.del(k); ls.del(hbKey(tab)); }
  }
  setState({ queue: q }); persistQueue();
}
setInterval(() => ls.set(hbKey(TAB_ID), Date.now()), 4000);
ls.set(hbKey(TAB_ID), Date.now());
window.addEventListener('pagehide', () => { if (!state.queue.length) ls.del(hbKey(TAB_ID)); });

function enqueue(op) {
  op.opId = newId('o'); op.at = Date.now();
  let q = [...state.queue];
  const idx = q.findIndex((o) => o.kind === op.kind && o.id === op.id && o.opId !== (inflight && inflight.opId));
  let mergedInto = null;
  if (idx >= 0) {
    const ex = q[idx];
    if (op.action === 'update' && (ex.action === 'create' || ex.action === 'update')) { q[idx] = { ...ex, body: op.body }; mergedInto = ex.opId; }
    else if (op.action === 'delete' && ex.action === 'create') { q.splice(idx, 1); mergedInto = 'dropped'; resolveOp(ex.opId, null); }
    else if (op.action === 'delete' && ex.action === 'update') { q[idx] = { ...op, opId: ex.opId }; mergedInto = ex.opId; }
  }
  if (!mergedInto) q.push(op);
  setState({ queue: q }); persistQueue();
  setTimeout(flush, 0);
  const id = mergedInto && mergedInto !== 'dropped' ? mergedInto : op.opId;
  if (mergedInto === 'dropped') return Promise.resolve(null);
  return new Promise((resolve, reject) => { if (!resolvers.has(id)) resolvers.set(id, []); resolvers.get(id).push({ resolve, reject }); });
}
function resolveOp(opId, value, error) {
  const rs = resolvers.get(opId); if (!rs) return; resolvers.delete(opId);
  rs.forEach((r) => (error ? r.reject(error) : r.resolve(value)));
}

let retryTimer = null; let retryDelay = 2000;
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { if (state.phase === 'ready' && !state.fromCache) flush(); else bootstrap({ silent: true }); }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
}
export function retryNow() { retryDelay = 2000; if (state.fromCache || state.phase !== 'ready') bootstrap(); else flush(); }

const lockFlush = (fn) => (navigator.locks ? navigator.locks.request(`docket-flush-${TAB_ID}`, fn) : fn());

export async function flush() {
  if (inflight || !state.user || state.sessionExpired || state.fromCache) return;
  if (!state.queue.length) return;
  await lockFlush(async () => {
    while (state.queue.length && !state.sessionExpired) {
      const op = state.queue[0]; inflight = op;
      setState({ save: { state: 'saving', message: '', at: Date.now() } });
      try {
        const result = await runOp(op);
        inflight = null;
        afterSuccess(op, result);
        retryDelay = 2000;
      } catch (err) {
        inflight = null;
        if (err.retryable) {
          setState({ save: { state: 'error', message: err.message, at: Date.now() } });
          scheduleRetry(); return;
        }
        if (err.status === 401) { setState({ save: { state: 'error', message: 'Session expired — sign in again to save your changes', at: Date.now() } }); return; }
        handleRejected(op, err);
      }
    }
    if (!state.queue.length) setState({ save: { state: 'saved', message: '', at: Date.now() } });
  });
}

async function runOp(op) {
  const enc = encodeURIComponent(op.id);
  if (op.kind === 'activity') {
    if (op.action === 'create') return (await api('POST', '/api/activities', op.body)).activity;
    if (op.action === 'update') return (await api('PUT', `/api/activities/${enc}`, { ...op.body, version: op.baseVersion })).activity;
    if (op.action === 'delete') { await api('DELETE', `/api/activities/${enc}`); return null; }
  }
  if (op.kind === 'category') {
    if (op.action === 'create') return (await api('POST', '/api/categories', op.body)).category;
    if (op.action === 'update') return (await api('PUT', `/api/categories/${enc}`, { ...op.body, version: op.baseVersion })).category;
    if (op.action === 'delete') { await api('DELETE', `/api/categories/${enc}${op.reassign ? `?reassign=${encodeURIComponent(op.reassign)}` : ''}`); return null; }
  }
  if (op.kind === 'settings') return api('PUT', '/api/settings', { settings: op.body });
  throw new Error('Unknown operation');
}

function dropFirst(op) { const q = state.queue.filter((o) => o.opId !== op.opId); setState({ queue: q }); persistQueue(); }
function hasPending(kind, id) { return state.queue.some((o) => o.kind === kind && o.id === id); }

function afterSuccess(op, result) {
  dropFirst(op);
  if (op.kind === 'activity' && result) {
    // following queued updates for the same activity chain on the new server version
    setState((s) => ({ queue: s.queue.map((o) => (o.kind === 'activity' && o.id === op.id && o.action === 'update' ? { ...o, baseVersion: result.version } : o)) }));
    persistQueue();
    setState((s) => {
      const cur = s.activities[op.id];
      const next = hasPending('activity', op.id) && cur ? { ...cur, version: result.version, attachments: result.attachments } : result;
      return { activities: { ...s.activities, [op.id]: next } };
    });
  }
  if (op.kind === 'category' && result) {
    setState((s) => ({ queue: s.queue.map((o) => (o.kind === 'category' && o.id === op.id && o.action === 'update' ? { ...o, baseVersion: result.version } : o)), categories: upsertCat(s.categories, result) }));
    persistQueue();
  }
  if (op.kind === 'settings' && result) setState({ settings: result.settings, settingsVersion: result.version });
  resolveOp(op.opId, result);
}

function handleRejected(op, err) {
  dropFirst(op);
  if (err.status === 409 && err.code === 'version_conflict' && err.extra.current) {
    const theirs = err.extra.current;
    setState((s) => ({
      conflicts: [...s.conflicts.filter((c) => !(c.kind === op.kind && c.id === op.id)), { kind: op.kind, id: op.id, mine: op.body, theirs, at: Date.now() }],
      ...(op.kind === 'activity' ? { activities: { ...s.activities, [op.id]: theirs } } : { categories: upsertCat(s.categories, theirs) }),
    }));
    setState({ save: { state: 'conflict', message: 'A change conflicts with a newer version saved elsewhere', at: Date.now() } });
  } else if (err.status === 404 && op.action === 'update') {
    setState((s) => ({ conflicts: [...s.conflicts, { kind: op.kind, id: op.id, mine: op.body, theirs: null, at: Date.now() }] }));
    setState({ save: { state: 'conflict', message: 'An item you edited was deleted on another device', at: Date.now() } });
  } else {
    setState({ save: { state: 'error', message: err.message, at: Date.now() } });
    // revert optimistic state to what the server has
    resync();
  }
  resolveOp(op.opId, null, err);
}

export function resolveConflict(c, choice) {
  setState((s) => ({ conflicts: s.conflicts.filter((x) => x !== c) }));
  if (choice === 'theirs') { toast('Kept the version saved elsewhere'); return; }
  if (c.kind === 'activity') {
    if (c.theirs) { setState((s) => ({ activities: { ...s.activities, [c.id]: { ...s.activities[c.id], ...c.mine } } })); enqueue({ kind: 'activity', action: 'update', id: c.id, body: c.mine, baseVersion: c.theirs.version }); }
    else { setState((s) => ({ activities: { ...s.activities, [c.id]: { ...c.mine, version: 0, attachments: [] } } })); enqueue({ kind: 'activity', action: 'create', id: c.id, body: c.mine }); }
  } else if (c.kind === 'category' && c.theirs) enqueue({ kind: 'category', action: 'update', id: c.id, body: c.mine, baseVersion: c.theirs.version });
  toast('Your version will be saved');
}

const upsertCat = (cats, c) => { const i = cats.findIndex((x) => x.id === c.id); const n = [...cats]; if (i >= 0) n[i] = c; else n.push(c); return n.sort((a, b) => a.sort - b.sort); };

// ---------- mutations used by the UI ----------
/** Validate + optimistically apply + queue. Returns { errors } synchronously-ish via promise. */
export function saveActivity(input, { isNew } = {}) {
  const { value, errors } = normalizeActivity(input, { defaultTimezone: state.settings.timezone });
  if (Object.keys(errors).length) return { errors, promise: Promise.reject(Object.assign(new Error('Please fix the highlighted fields'), { fields: errors })) };
  const existing = state.activities[value.id];
  setState((s) => ({ activities: { ...s.activities, [value.id]: { ...(existing || { version: 0, attachments: [], created_at: Date.now(), is_sample: false }), ...value, updated_at: Date.now() } } }));
  const promise = enqueue(!existing ? { kind: 'activity', action: 'create', id: value.id, body: value } : { kind: 'activity', action: 'update', id: value.id, body: value, baseVersion: existing.version });
  return { errors: null, promise };
}
export function patchActivity(id, patch) {
  const a = state.activities[id]; if (!a) return null;
  const { version, attachments, created_at, updated_at, is_sample, ...rest } = a;
  return saveActivity({ ...rest, ...patch });
}
export function deleteActivity(id) {
  setState((s) => { const n = { ...s.activities }; delete n[id]; return { activities: n }; });
  return enqueue({ kind: 'activity', action: 'delete', id });
}
export function duplicateActivity(id) {
  const a = state.activities[id]; if (!a) return null;
  const { version, attachments, created_at, updated_at, is_sample, ics_uid, ...rest } = a;
  const copy = { ...rest, id: newId('a'), title: `${a.title} (copy)`.slice(0, 200), archived: false, ics_uid: '', checklist: (a.checklist || []).map((t) => ({ ...t, id: newId('t'), done: false, done_at: null })) };
  if (['completed', 'missed', 'cancelled'].includes(copy.status)) copy.status = 'tentative';
  const r = saveActivity(copy, { isNew: true });
  return r.errors ? null : copy.id;
}
export function saveCategory(c, { isNew } = {}) {
  const existing = state.categories.find((x) => x.id === c.id);
  setState((s) => ({ categories: upsertCat(s.categories, { ...(existing || { version: 0 }), ...c }) }));
  return enqueue(isNew || !existing ? { kind: 'category', action: 'create', id: c.id, body: c } : { kind: 'category', action: 'update', id: c.id, body: c, baseVersion: existing.version });
}
export function deleteCategory(id, reassign) {
  setState((s) => ({
    categories: s.categories.filter((c) => c.id !== id),
    activities: Object.fromEntries(Object.entries(s.activities).map(([k, a]) => [k, a.category_id === id ? { ...a, category_id: reassign || null } : a])),
  }));
  return enqueue({ kind: 'category', action: 'delete', id, reassign });
}
export function saveSettings(patch) {
  const next = { ...state.settings, ...patch };
  setState({ settings: next });
  return enqueue({ kind: 'settings', action: 'update', id: 'settings', body: next });
}

// ---------- real-time events ----------
let es = null; let everConnected = false; let esRetry = null;
export function connectEvents() {
  if (es || typeof EventSource === 'undefined') return;
  es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    setState({ live: 'live', serverOffset: d.serverTime - Date.now() });
    if (everConnected) bootstrap({ silent: true }); // catch anything missed while disconnected
    everConnected = true; markOnline(); flush();
  });
  es.onerror = () => {
    setState({ live: 'offline' });
    if (es && es.readyState === 2) { // closed permanently (e.g. 401): reconnect manually after checking session
      es.close(); es = null; clearTimeout(esRetry);
      esRetry = setTimeout(async () => { const ok = await bootstrap({ silent: true }); if (!ok && state.user && !state.sessionExpired) connectEvents(); }, 4000);
    }
  };
  const on = (type, fn) => es.addEventListener(type, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
  on('activity.upserted', ({ data }) => {
    if (hasPending('activity', data.id) || (inflight && inflight.kind === 'activity' && inflight.id === data.id)) return;
    setState((s) => { const cur = s.activities[data.id]; if (cur && cur.version > data.version) return {}; return { activities: { ...s.activities, [data.id]: data } }; });
  });
  on('activity.deleted', ({ data }) => setState((s) => { if (!s.activities[data.id]) return {}; const n = { ...s.activities }; delete n[data.id]; return { activities: n }; }));
  on('category.upserted', ({ data }) => { if (!hasPending('category', data.id)) setState((s) => ({ categories: upsertCat(s.categories, data) })); });
  on('category.deleted', ({ data }) => setState((s) => ({ categories: s.categories.filter((c) => c.id !== data.id) })));
  on('settings.updated', ({ data }) => { if (!hasPending('settings', 'settings')) setState({ settings: data.settings, settingsVersion: data.version }); });
  on('account.updated', ({ data }) => setState((s) => ({ user: { ...s.user, ...data } })));
  on('notification', ({ data }) => { upsertNotification(data); onNewNotification(data); });
  on('notification.updated', ({ data }) => upsertNotification(data));
  on('notifications.reload', () => api('GET', '/api/notifications').then((d) => setState({ notifications: d.notifications })).catch(() => {}));
  on('reload', () => bootstrap({ silent: true }));
  on('session.ended', () => { setState({ sessionExpired: true }); disconnectEvents(); });
}
export function disconnectEvents() { if (es) { es.close(); es = null; } everConnected = false; }
function upsertNotification(n) {
  setState((s) => { const i = s.notifications.findIndex((x) => x.id === n.id); const list = [...s.notifications]; if (i >= 0) list[i] = n; else list.unshift(n); return { notifications: list }; });
}

// ---------- notification side effects (toast, sound, local browser notification) ----------
let audioCtx = null;
export function unlockAudio() {
  try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch {}
}
export function playChime() {
  try {
    unlockAudio(); if (!audioCtx || audioCtx.state !== 'running') return false;
    const t0 = audioCtx.currentTime;
    [[880, 0], [1320, 0.18]].forEach(([f, d]) => {
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.25, t0 + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.5);
      o.start(t0 + d); o.stop(t0 + d + 0.55);
    });
    return true;
  } catch { return false; }
}
function onNewNotification(n) {
  toast(n.title, { notification: n });
  const s = state.settings;
  // only one tab plays the sound
  const mark = `docket:sound:${n.id}`;
  if (s.channels.sound && !window.DocketAndroid && !ls.get(mark)) { ls.set(mark, 1); setTimeout(() => ls.del(mark), 60000); playChime(); }
  // When push is not in use, show a system notification from an open tab (if permitted)
  if (!s.channels.push && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    const m2 = `docket:local:${n.id}`;
    if (!ls.get(m2)) { ls.set(m2, 1); navigator.serviceWorker && navigator.serviceWorker.ready.then((r) => r.showNotification(n.title, { body: n.body, tag: n.id, data: { url: n.activity_id ? `/#/activity/${n.activity_id}` : '/#/notifications', notificationId: n.id } })).catch(() => {}); }
  }
}

export async function notificationAction(id, action, body) {
  const d = await api('POST', `/api/notifications/${encodeURIComponent(id)}/${action}`, body || {});
  if (d.notification) upsertNotification(d.notification);
  return d;
}

// ---------- browser online/offline ----------
window.addEventListener('online', () => { setState({ online: true }); retryNow(); });
window.addEventListener('offline', () => setState({ online: false }));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.phase === 'ready' && state.live !== 'live') bootstrap({ silent: true }); });

export const now = () => Date.now();

// ---------- Android app bridge ----------
// When running inside the Docket Android app, tell it whenever saved data changes so it can
// re-download the reminder schedule and update its exact local alarms.
export const nativeApp = typeof window !== 'undefined' && window.DocketAndroid ? window.DocketAndroid : null;
if (nativeApp) {
  let lastActs = null; let lastSettings = null; let pendingNotify = false; let t = null;
  listeners.add(() => {
    if (state.phase !== 'ready' || state.fromCache) return;
    if (state.activities !== lastActs || state.settings !== lastSettings) { lastActs = state.activities; lastSettings = state.settings; pendingNotify = true; }
    if (pendingNotify && !state.queue.length && !inflight) {
      clearTimeout(t);
      t = setTimeout(() => { pendingNotify = false; try { nativeApp.onDataChanged(); } catch {} }, 1200);
    }
  });
}
