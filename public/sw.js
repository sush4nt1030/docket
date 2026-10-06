// Docket service worker: push notifications + offline app shell. Never caches /api data.
const CACHE = 'docket-shell-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/icon.svg', '/manifest.webmanifest'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ics/')) return; // always network
  if (e.request.mode === 'navigate') {
    // network first so a new version is picked up; fall back to the cached shell offline
    e.respondWith(fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return res; }).catch(() => caches.match('/')));
    return;
  }
  // versioned static assets: cache first, then network
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && (url.searchParams.has('v') || /\.(svg|png|webmanifest)$/.test(url.pathname))) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  })));
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Docket reminder', body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'Docket reminder';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '', tag: data.tag || data.notificationId, icon: '/icon-192.png', badge: '/icon-192.png',
    renotify: true, requireInteraction: true, timestamp: Date.now(),
    data: { url: data.url || '/', notificationId: data.notificationId },
    actions: data.notificationId && data.notificationId !== 'test' ? [{ action: 'snooze', title: 'Snooze 10 min' }, { action: 'dismiss', title: 'Dismiss' }] : [],
  }));
});

self.addEventListener('notificationclick', (e) => {
  const n = e.notification; const d = n.data || {};
  n.close();
  const post = (path, body) => fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Docket': '1' }, body: JSON.stringify(body || {}) }).catch(() => {});
  if (e.action === 'snooze' && d.notificationId) { e.waitUntil(post(`/api/notifications/${d.notificationId}/snooze`, { minutes: 10 })); return; }
  if (e.action === 'dismiss' && d.notificationId) { e.waitUntil(post(`/api/notifications/${d.notificationId}/dismiss`)); return; }
  e.waitUntil((async () => {
    if (d.notificationId) post(`/api/notifications/${d.notificationId}/read`);
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if (new URL(c.url).origin === location.origin) { await c.focus(); c.postMessage({ type: 'navigate', url: d.url }); return; } }
    await self.clients.openWindow(d.url || '/');
  })());
});
