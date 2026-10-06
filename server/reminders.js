// Backend reminder scheduler. Reminder jobs are persisted in SQLite so they fire while
// every browser is closed. Each job has a unique dedupe key and is claimed atomically
// before delivery, so a reminder is never delivered twice.
import crypto from 'node:crypto';
import { expandOccurrences, zonedToUtc, DAY_MS } from '../shared/time.js';
import { describeOccurrence, formatDuration, formatDateStr, formatDateTime } from '../shared/format.js';

const HORIZON = 62 * DAY_MS;
const LATE_LIMIT = 6 * 3600 * 1000; // jobs more overdue than this (server was down) are expired, not sent

export function isActivityRemindable(a) {
  return a && !a.archived && a.schedule === 'scheduled' && (a.status === 'confirmed' || a.status === 'tentative');
}

export function createReminderService({ db, hub, push, mailer, getSettings, log = console, baseUrl = '' }) {
  const insertJob = db.prepare(`INSERT OR IGNORE INTO reminder_jobs
    (user_id, activity_id, kind, task_id, occurrence_start, offset_min, fire_at, status, dedupe_key, source_notification_id, created_at)
    VALUES (?,?,?,?,?,?,?, 'pending', ?, ?, ?)`);

  /** Recompute pending jobs for one activity (called on every create/update/reschedule/cancel/delete). */
  function syncActivity(userId, a, now = Date.now()) {
    const settings = getSettings(userId);
    if (!a) return;
    const remindable = isActivityRemindable(a);
    const alive = a && !a.archived && a.status !== 'cancelled';
    db.prepare("DELETE FROM reminder_jobs WHERE activity_id=? AND status='pending' AND kind!='snooze'").run(a.id);
    if (!alive || !remindable) {
      // snoozed reminders stop too when the activity is cancelled, archived, completed or missed
      db.prepare("DELETE FROM reminder_jobs WHERE activity_id=? AND status='pending' AND kind='snooze'").run(a.id);
    }
    const created = now;
    if (remindable && a.reminders.length) {
      const maxOff = Math.max(...a.reminders.map((r) => r.minutes)) * 60000;
      const occs = expandOccurrences(a, now, now + HORIZON + maxOff, settings.timezone, 500);
      for (const occ of occs) {
        const anchor = occ.allDay ? zonedToUtc(occ.date, settings.allDayReminderTime, settings.timezone) : occ.start;
        for (const r of a.reminders) {
          const fire = anchor - r.minutes * 60000;
          if (fire < now - 30000 || fire > now + HORIZON) continue;
          insertJob.run(userId, a.id, 'activity', null, occ.start, r.minutes, fire, `${userId}|a|${a.id}|${occ.start}|${r.minutes}`, null, created);
        }
      }
    }
    if (alive && a.status !== 'completed' && a.status !== 'missed') {
      for (const t of a.checklist) {
        if (t.done || !t.due_date || t.remind_minutes === null) continue;
        const tz = a.timezone || settings.timezone;
        const anchor = t.due_time ? zonedToUtc(t.due_date, t.due_time, tz) : zonedToUtc(t.due_date, settings.allDayReminderTime, settings.timezone);
        const fire = anchor - (t.due_time ? t.remind_minutes : 0) * 60000;
        if (fire < now - 30000 || fire > now + HORIZON) continue;
        insertJob.run(userId, a.id, 'task', t.id, anchor, t.remind_minutes, fire, `${userId}|t|${a.id}|${t.id}|${fire}`, null, created);
      }
      if (a.schedule === 'tbd' && a.follow_up_date) {
        const fire = zonedToUtc(a.follow_up_date, settings.allDayReminderTime, settings.timezone);
        if (fire >= now - 30000 && fire <= now + HORIZON) {
          insertJob.run(userId, a.id, 'followup', null, null, 0, fire, `${userId}|f|${a.id}|${fire}`, null, created);
        }
      }
    }
  }

  function syncUser(userId) {
    const rows = db.prepare('SELECT data FROM activities WHERE user_id=?').all(userId);
    for (const r of rows) syncActivity(userId, JSON.parse(r.data));
  }

  function refillAll() {
    const users = db.prepare('SELECT id FROM users').all();
    for (const u of users) { try { syncUser(u.id); } catch (err) { log.error('refill failed', u.id, err); } }
  }

  function loadActivity(userId, id) {
    const row = db.prepare('SELECT data FROM activities WHERE id=? AND user_id=?').get(id, userId);
    return row ? JSON.parse(row.data) : null;
  }

  /** Build notification text from the *current* activity data. Returns null if it should not be sent. */
  function compose(job, now) {
    const settings = getSettings(job.user_id);
    if (job.kind === 'snooze') {
      const src = db.prepare('SELECT * FROM notifications WHERE id=? AND user_id=?').get(job.source_notification_id, job.user_id);
      if (!src) return null;
      if (src.activity_id) {
        const a = loadActivity(job.user_id, src.activity_id);
        if (!a || a.archived || a.status === 'cancelled') return null;
      }
      return { title: src.title, body: `${src.body} (snoozed reminder)`, activityId: src.activity_id };
    }
    const a = loadActivity(job.user_id, job.activity_id);
    if (!a || a.archived || a.status === 'cancelled') return null;
    if (job.kind === 'activity') {
      if (!isActivityRemindable(a)) return null;
      const occs = expandOccurrences(a, job.occurrence_start - 1, job.occurrence_start + 1, settings.timezone, 5);
      const occ = occs.find((o) => o.start === job.occurrence_start);
      if (!occ) return null; // occurrence no longer exists (rescheduled / skipped)
      const delta = occ.start - now;
      const verb = a.kind === 'deadline' ? 'Due' : 'Starts';
      let rel;
      if (occ.allDay) rel = a.kind === 'deadline' ? 'Due' : 'All day';
      else if (Math.abs(delta) < 60000) rel = a.kind === 'deadline' ? 'Due now' : 'Starting now';
      else rel = delta > 0 ? `${verb} in ${formatDuration(delta)}` : `${verb === 'Due' ? 'Was due' : 'Started'} ${formatDuration(delta)}`;
      const where = [a.location, a.meeting_url ? 'Online meeting' : ''].filter(Boolean).join(' · ');
      return {
        title: `${a.kind === 'deadline' ? 'Deadline: ' : ''}${a.title}`,
        body: `${rel} — ${describeOccurrence(a, occ, settings)}${where ? ` · ${where}` : ''}`,
        activityId: a.id,
      };
    }
    if (job.kind === 'task') {
      const t = a.checklist.find((x) => x.id === job.task_id);
      if (!t || t.done || !t.due_date) return null;
      const due = t.due_time ? formatDateTime(zonedToUtc(t.due_date, t.due_time, a.timezone), settings.timezone, settings, { weekday: true }) : formatDateStr(t.due_date, settings, { weekday: true });
      return { title: `Preparation task: ${t.text}`, body: `For “${a.title}” — due ${due}`, activityId: a.id };
    }
    if (job.kind === 'followup') {
      if (a.schedule !== 'tbd') return null;
      return { title: `Follow up: ${a.title}`, body: `The date/time is still to be confirmed.${a.tbd_note ? ` Note: ${a.tbd_note}` : ''}`, activityId: a.id };
    }
    return null;
  }

  function insertNotification(userId, { kind, title, body, activityId, jobId, fireAt }) {
    const n = {
      id: crypto.randomUUID().replace(/-/g, ''), user_id: userId, activity_id: activityId || null, job_id: jobId || null,
      kind, title, body, fire_at: fireAt || Date.now(), created_at: Date.now(), read_at: null, dismissed_at: null, snoozed_until: null,
      deliveries: { inapp: { status: 'delivered', detail: 'Shown in the app' } },
    };
    db.prepare(`INSERT INTO notifications (id,user_id,activity_id,job_id,kind,title,body,fire_at,created_at,deliveries) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(n.id, userId, n.activity_id, n.job_id, kind, title, body, n.fire_at, n.created_at, JSON.stringify(n.deliveries));
    // keep history bounded
    db.prepare(`DELETE FROM notifications WHERE user_id=? AND id NOT IN (SELECT id FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 500)`).run(userId, userId);
    return n;
  }

  async function deliverExternal(userId, n, { forceChannels } = {}) {
    const settings = getSettings(userId);
    const ch = forceChannels || settings.channels;
    const deliveries = { ...n.deliveries };
    if (ch.push) {
      deliveries.push = await push.sendToUser(userId, {
        title: n.title, body: n.body, notificationId: n.id, tag: n.id,
        url: n.activity_id ? `/#/activity/${n.activity_id}` : '/#/notifications',
      });
    } else deliveries.push = { status: 'off', detail: 'Push is turned off in Settings' };
    if (ch.email) {
      const user = db.prepare('SELECT email FROM users WHERE id=?').get(userId);
      const to = settings.emailAddress || (user && user.email);
      if (!mailer.configured) deliveries.email = { status: 'not-configured', detail: mailer.describe() };
      else {
        try {
          await mailer.send({ to, subject: n.title, text: `${n.title}\n\n${n.body}\n\n${baseUrl ? `Open: ${baseUrl}/#/${n.activity_id ? `activity/${n.activity_id}` : 'notifications'}\n` : ''}— Docket reminders` });
          deliveries.email = { status: 'sent', detail: `Sent to ${to}` };
        } catch (err) { deliveries.email = { status: 'failed', detail: err.message }; }
      }
    } else deliveries.email = { status: 'off', detail: 'Email is turned off in Settings' };
    deliveries.sound = ch.sound ? { status: 'requested', detail: 'Played by open app tabs if the browser allows audio' } : { status: 'off', detail: 'Sound is off' };
    n.deliveries = deliveries;
    db.prepare('UPDATE notifications SET deliveries=? WHERE id=?').run(JSON.stringify(deliveries), n.id);
    hub.send(userId, { type: 'notification.updated', data: publicNotification(n) });
    return deliveries;
  }

  let running = false;
  async function tick(now = Date.now()) {
    if (running) return; running = true;
    try {
      const due = db.prepare("SELECT * FROM reminder_jobs WHERE status='pending' AND fire_at<=? ORDER BY fire_at LIMIT 100").all(now);
      for (const job of due) {
        const claimed = db.prepare("UPDATE reminder_jobs SET status='processing', attempts=attempts+1, processed_at=? WHERE id=? AND status='pending'").run(Date.now(), job.id);
        if (claimed.changes !== 1) continue;
        try {
          if (now - job.fire_at > LATE_LIMIT) { db.prepare("UPDATE reminder_jobs SET status='expired' WHERE id=?").run(job.id); continue; }
          const msg = compose(job, now);
          if (!msg) { db.prepare("UPDATE reminder_jobs SET status='skipped' WHERE id=?").run(job.id); continue; }
          const n = insertNotification(job.user_id, { kind: job.kind, title: msg.title, body: msg.body, activityId: msg.activityId, jobId: job.id, fireAt: job.fire_at });
          db.prepare("UPDATE reminder_jobs SET notification_id=? WHERE id=?").run(n.id, job.id);
          hub.send(job.user_id, { type: 'notification', data: publicNotification(n) });
          await deliverExternal(job.user_id, n);
          db.prepare("UPDATE reminder_jobs SET status='sent', processed_at=? WHERE id=?").run(Date.now(), job.id);
        } catch (err) {
          log.error('reminder delivery failed', job.id, err);
          db.prepare("UPDATE reminder_jobs SET status='failed', processed_at=? WHERE id=?").run(Date.now(), job.id);
        }
      }
    } finally { running = false; }
  }

  function recoverStuck() {
    // jobs left in 'processing' by a crash: if the in-app notification was created, treat as sent (no duplicates)
    db.prepare("UPDATE reminder_jobs SET status='sent' WHERE status='processing' AND notification_id IS NOT NULL").run();
    db.prepare("UPDATE reminder_jobs SET status='pending' WHERE status='processing' AND notification_id IS NULL").run();
  }

  function snooze(userId, notificationId, minutes) {
    const n = db.prepare('SELECT * FROM notifications WHERE id=? AND user_id=?').get(notificationId, userId);
    if (!n) return null;
    const until = Date.now() + minutes * 60000;
    db.prepare(`INSERT OR IGNORE INTO reminder_jobs (user_id, activity_id, kind, task_id, occurrence_start, offset_min, fire_at, status, dedupe_key, source_notification_id, created_at)
      VALUES (?,?, 'snooze', NULL, NULL, ?, ?, 'pending', ?, ?, ?)`).run(userId, n.activity_id, minutes, until, `${userId}|s|${n.id}|${until}`, n.id, Date.now());
    db.prepare('UPDATE notifications SET snoozed_until=?, read_at=COALESCE(read_at, ?) WHERE id=?').run(until, Date.now(), n.id);
    return until;
  }

  async function sendTest(userId) {
    const n = insertNotification(userId, { kind: 'test', title: 'Test notification', body: 'If you can see this, reminders can reach you on this channel.' });
    hub.send(userId, { type: 'notification', data: publicNotification(n) });
    return deliverExternal(userId, n).then((deliveries) => ({ ...publicNotification(n), deliveries }));
  }

  function upcomingJobs(userId, activityId) {
    const rows = activityId
      ? db.prepare("SELECT id, activity_id, kind, task_id, occurrence_start, offset_min, fire_at FROM reminder_jobs WHERE user_id=? AND activity_id=? AND status='pending' ORDER BY fire_at LIMIT 50").all(userId, activityId)
      : db.prepare("SELECT id, activity_id, kind, task_id, occurrence_start, offset_min, fire_at FROM reminder_jobs WHERE user_id=? AND status='pending' ORDER BY fire_at LIMIT 200").all(userId);
    return rows;
  }

  /** Pending reminders with ready-to-show text, for native apps that schedule local alarms. */
  function deviceSchedule(userId, limit = 300) {
    const rows = db.prepare("SELECT * FROM reminder_jobs WHERE user_id=? AND status='pending' ORDER BY fire_at LIMIT ?").all(userId, limit);
    const out = [];
    for (const job of rows) {
      let msg = null;
      try { msg = compose(job, job.fire_at); } catch { msg = null; }
      if (!msg) continue;
      out.push({ key: job.dedupe_key, fire_at: job.fire_at, kind: job.kind, activity_id: msg.activityId || job.activity_id || null, title: msg.title, body: msg.body });
    }
    return out;
  }

  let timers = [];
  function start({ tickMs = 10000, refillMs = 30 * 60000 } = {}) {
    recoverStuck();
    refillAll();
    tick();
    timers.push(setInterval(() => tick().catch((e) => log.error(e)), tickMs));
    timers.push(setInterval(refillAll, refillMs));
  }
  function stop() { timers.forEach(clearInterval); timers = []; }

  return { syncActivity, syncUser, tick, start, stop, snooze, sendTest, upcomingJobs, refillAll, deviceSchedule };
}

export function publicNotification(n) {
  return {
    id: n.id, activity_id: n.activity_id, kind: n.kind, title: n.title, body: n.body, fire_at: n.fire_at,
    created_at: n.created_at, read_at: n.read_at, dismissed_at: n.dismissed_at, snoozed_until: n.snoozed_until,
    deliveries: typeof n.deliveries === 'string' ? JSON.parse(n.deliveries) : n.deliveries,
  };
}
