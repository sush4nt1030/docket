import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { zonedToUtc, expandOccurrences, findOverlaps, utcToTimeStr } from '../shared/time.js';
import { normalizeActivity } from '../shared/model.js';
import { encryptPayload, decryptPayload, vapidAuthHeader, generateVapidKeys } from '../server/push.js';
import { activitiesToIcs, parseIcs } from '../server/ics.js';

test('Kathmandu (UTC+5:45) conversion', () => {
  assert.equal(new Date(zonedToUtc('2026-10-07', '10:00', 'Asia/Kathmandu')).toISOString(), '2026-10-07T04:15:00.000Z');
});

test('weekly recurrence keeps local wall-clock time across a DST change (New York)', () => {
  const a = { id: 'aaaaaa1', schedule: 'scheduled', start_date: '2026-10-26', start_time: '09:00', end_time: '10:00', timezone: 'America/New_York', recurrence: { freq: 'weekly', interval: 1, byweekday: [1] } };
  const occ = expandOccurrences(a, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 20), 'UTC');
  const times = occ.map((o) => new Date(o.start).toISOString().slice(0, 16));
  assert.deepEqual(times.slice(0, 3), ['2026-10-26T13:00', '2026-11-02T14:00', '2026-11-09T14:00']);
  occ.forEach((o) => assert.equal(utcToTimeStr(o.start, 'America/New_York'), '09:00'));
});

test('monthly on the 31st skips short months; count and exdates honoured', () => {
  const a = { id: 'aaaaaa2', schedule: 'scheduled', start_date: '2026-01-31', all_day: true, timezone: 'UTC', recurrence: { freq: 'monthly', interval: 1, count: 4, exdates: ['2026-05-31'] } };
  const occ = expandOccurrences(a, 0, Date.UTC(2027, 0, 1), 'UTC');
  assert.deepEqual(occ.map((o) => o.date), ['2026-01-31', '2026-03-31', '2026-07-31']);
});

test('overlap detection', () => {
  const mk = (id, s, e) => ({ id, key: id, allDay: false, start: s, end: e });
  const m = findOverlaps([mk('a', 0, 100 * 60000), mk('b', 50 * 60000, 200 * 60000), mk('c', 300 * 60000, 400 * 60000)]);
  assert.deepEqual(m.get('a'), ['b']); assert.equal(m.has('c'), false);
});

test('validation: TBD allowed without date; scheduled requires date/time; end after start', () => {
  assert.deepEqual(normalizeActivity({ id: 'abcdef1', title: 'X', schedule: 'tbd' }).errors, {});
  assert.ok(normalizeActivity({ id: 'abcdef1', title: 'X' }).errors.start_date);
  assert.ok(normalizeActivity({ id: 'abcdef1', title: 'X', start_date: '2026-10-10' }).errors.start_time);
  assert.ok(normalizeActivity({ id: 'abcdef1', title: 'X', start_date: '2026-10-10', start_time: '10:00', end_time: '09:00' }).errors.end_time);
  assert.ok(normalizeActivity({ id: 'abcdef1', title: '' , schedule: 'tbd' }).errors.title);
});

test('web push payload encryption round-trips (RFC 8291) and VAPID JWT verifies', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const body = encryptPayload('{"hello":"world"}', ua.getPublicKey().toString('base64url'), auth.toString('base64url'));
  assert.equal(decryptPayload(body, ua, auth), '{"hello":"world"}');
  const keys = generateVapidKeys();
  const h = vapidAuthHeader('https://push.example.com/abc', { ...keys, subject: 'mailto:a@b.c' });
  const t = /t=([^,]+)/.exec(h)[1]; const [hd, pl, sig] = t.split('.');
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${hd}.${pl}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(pl, 'base64url')).aud, 'https://push.example.com');
});

test('ICS export → import round-trip', () => {
  const a = normalizeActivity({ id: 'abcdef9', title: 'Club, weekly; meeting', start_date: '2026-10-09', start_time: '16:00', end_time: '17:00', timezone: 'Asia/Kathmandu', recurrence: { freq: 'weekly', byweekday: [5] }, reminders: [{ minutes: 60 }] }).value;
  const ics = activitiesToIcs([a]);
  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=FR/);
  const [b] = parseIcs(ics, { timezone: 'Asia/Kathmandu' });
  assert.equal(b.title, 'Club, weekly; meeting');
  assert.equal(b.start_time, '16:00'); assert.equal(b.end_time, '17:00'); assert.equal(b.recurrence.freq, 'weekly');
  assert.deepEqual(b.reminders, [{ minutes: 60 }]);
});
