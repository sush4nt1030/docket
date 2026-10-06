// Minimal SMTP client (implicit TLS on 465, STARTTLS on 587/25) with AUTH PLAIN/LOGIN.
// Configured only through server-side environment variables.
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

export function mailerConfigFromEnv(env = process.env) {
  const port = Number(env.SMTP_PORT || 587);
  return {
    host: env.SMTP_HOST || '',
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
    allowInsecure: env.SMTP_ALLOW_INSECURE === 'true', // only for local test servers
  };
}

function encodeHeader(s) { return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`; }
function wrap76(b64) { return b64.replace(/.{1,76}/g, (m) => m + '\r\n'); }
function addrOnly(s) { const m = /<([^>]+)>/.exec(s); return (m ? m[1] : s).trim(); }

export function createMailer(cfg) {
  const configured = !!(cfg.host && cfg.from);
  const missing = [];
  if (!cfg.host) missing.push('SMTP_HOST'); if (!cfg.from) missing.push('SMTP_FROM');

  async function send({ to, subject, text }) {
    if (!configured) throw new Error(`Email is not configured (missing ${missing.join(', ')})`);
    let socket = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : net.connect({ host: cfg.host, port: cfg.port });
    socket.setTimeout(20000);
    let buf = ''; let waiter = null; const lines = [];
    const onData = (d) => {
      buf += d.toString('utf8'); let i;
      while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
      tryResolve();
    };
    function tryResolve() {
      if (!waiter) return;
      const idx = lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
      if (idx >= 0) { const resp = lines.splice(0, idx + 1); const w = waiter; waiter = null; w.resolve({ code: +resp[resp.length - 1].slice(0, 3), lines: resp }); }
    }
    let failure = null;
    const attach = (s) => {
      s.on('data', onData);
      s.on('error', (err) => { failure = err; if (waiter) { const w = waiter; waiter = null; w.reject(err); } });
      s.on('timeout', () => { const err = new Error('SMTP connection timed out'); failure = err; s.destroy(); if (waiter) { const w = waiter; waiter = null; w.reject(err); } });
    };
    attach(socket);
    const read = () => new Promise((resolve, reject) => { if (failure) return reject(failure); waiter = { resolve, reject }; tryResolve(); });
    const cmd = async (line, expect) => {
      if (line !== null) socket.write(line + '\r\n');
      const r = await read();
      if (expect && !expect.includes(r.code)) throw new Error(`SMTP error after "${line ? line.split(' ')[0] : 'connect'}": ${r.lines.join(' ')}`);
      return r;
    };
    try {
      await cmd(null, [220]);
      const host = os.hostname() || 'localhost';
      let ehlo = await cmd(`EHLO ${host}`, [250]);
      let caps = ehlo.lines.join('\n').toUpperCase();
      if (!cfg.secure) {
        if (caps.includes('STARTTLS')) {
          await cmd('STARTTLS', [220]);
          socket.removeListener('data', onData);
          socket = tls.connect({ socket, servername: cfg.host });
          await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });
          socket.setTimeout(20000); attach(socket);
          ehlo = await cmd(`EHLO ${host}`, [250]); caps = ehlo.lines.join('\n').toUpperCase();
        } else if (!cfg.allowInsecure) {
          throw new Error('SMTP server does not offer STARTTLS; refusing to send without encryption (set SMTP_SECURE=true for port 465)');
        }
      }
      if (cfg.user) {
        if (/AUTH[ =][^\n]*PLAIN/.test(caps)) {
          await cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64')}`, [235]);
        } else {
          await cmd('AUTH LOGIN', [334]);
          await cmd(Buffer.from(cfg.user).toString('base64'), [334]);
          await cmd(Buffer.from(cfg.pass).toString('base64'), [235]);
        }
      }
      await cmd(`MAIL FROM:<${addrOnly(cfg.from)}>`, [250]);
      await cmd(`RCPT TO:<${addrOnly(to)}>`, [250, 251]);
      await cmd('DATA', [354]);
      const msgId = `<${crypto.randomUUID()}@${addrOnly(cfg.from).split('@')[1] || 'docket.local'}>`;
      const msg = [
        `From: ${cfg.from}`, `To: ${to}`, `Subject: ${encodeHeader(subject)}`, `Date: ${new Date().toUTCString()}`,
        `Message-ID: ${msgId}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64',
        '', wrap76(Buffer.from(text).toString('base64')),
      ].join('\r\n');
      await cmd(msg + '\r\n.', [250]);
      socket.write('QUIT\r\n'); socket.end();
      return { messageId: msgId };
    } catch (err) { socket.destroy(); throw err; }
  }

  return {
    configured, missing,
    describe: () => configured ? `SMTP ${cfg.host}:${cfg.port}${cfg.secure ? ' (TLS)' : ''} from ${cfg.from}` : `Not configured — set ${missing.join(', ')} on the server`,
    send,
  };
}
