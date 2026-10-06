// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291).
// Implemented with node:crypto only. VAPID private key never leaves the server.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function privateKeyObject(publicKeyB64, privateKeyB64) {
  const pub = fromB64u(publicKeyB64);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: privateKeyB64, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

export function vapidAuthHeader(endpoint, vapid, ttlSec = 12 * 3600) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + ttlSec, sub: vapid.subject }));
  const data = `${header}.${payload}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKeyObject(vapid.publicKey, vapid.privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${vapid.publicKey}`;
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Encrypt a payload for a subscription (aes128gcm, single record). */
export function encryptPayload(payload, p256dhB64, authB64) {
  const uaPublic = fromB64u(p256dhB64);
  const authSecret = fromB64u(authB64);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  const enc = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, enc]);
}

/** Decrypt (used by tests to verify the encryption round-trip). */
export function decryptPayload(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16); const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen); const enc = body.subarray(21 + idlen);
  const shared = uaEcdh.computeSecret(asPublic);
  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(enc.subarray(enc.length - 16));
  const plain = Buffer.concat([d.update(enc.subarray(0, enc.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}

export function createPushService({ db, subject }) {
  let vapid;
  const envPub = process.env.VAPID_PUBLIC_KEY, envPriv = process.env.VAPID_PRIVATE_KEY;
  if (envPub && envPriv) vapid = { publicKey: envPub, privateKey: envPriv, source: 'environment' };
  else {
    const row = db.prepare("SELECT value FROM kv WHERE key='vapid'").get();
    if (row) vapid = { ...JSON.parse(row.value), source: 'generated' };
    else {
      vapid = generateVapidKeys();
      db.prepare("INSERT INTO kv(key,value) VALUES('vapid',?)").run(JSON.stringify(vapid));
      vapid.source = 'generated';
    }
  }
  vapid.subject = subject;

  async function sendToSubscription(sub, payloadObj) {
    const body = encryptPayload(JSON.stringify(payloadObj), sub.p256dh, sub.auth);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        TTL: '86400', Urgency: 'high', Authorization: vapidAuthHeader(sub.endpoint, vapid),
      },
      body, signal: AbortSignal.timeout(15000),
    });
    return res.status;
  }

  /** Send to all of a user's devices. Returns a delivery summary. */
  async function sendToUser(userId, payloadObj) {
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?').all(userId);
    if (!subs.length) return { status: 'no-devices', detail: 'No devices are subscribed to push on this account' };
    let ok = 0; const errors = [];
    for (const sub of subs) {
      try {
        const status = await sendToSubscription(sub, payloadObj);
        if (status >= 200 && status < 300) {
          ok++; db.prepare('UPDATE push_subscriptions SET last_success_at=?, last_error=NULL WHERE id=?').run(Date.now(), sub.id);
        } else if (status === 404 || status === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id);
          errors.push('a device subscription expired and was removed');
        } else {
          errors.push(`push service returned HTTP ${status}`);
          db.prepare('UPDATE push_subscriptions SET last_error=?, last_error_at=? WHERE id=?').run(`HTTP ${status}`, Date.now(), sub.id);
        }
      } catch (err) {
        errors.push(err.name === 'TimeoutError' ? 'push service timed out' : `network error: ${err.message}`);
        db.prepare('UPDATE push_subscriptions SET last_error=?, last_error_at=? WHERE id=?').run(String(err.message).slice(0, 200), Date.now(), sub.id);
      }
    }
    if (ok && !errors.length) return { status: 'sent', detail: `Sent to ${ok} device${ok > 1 ? 's' : ''}` };
    if (ok) return { status: 'partial', detail: `Sent to ${ok} of ${subs.length} devices; ${errors.join('; ')}` };
    return { status: 'failed', detail: errors.join('; ') };
  }

  return { publicKey: vapid.publicKey, source: vapid.source, sendToUser };
}
