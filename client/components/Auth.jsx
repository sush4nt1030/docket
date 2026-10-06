import { useState } from 'react';
import { login, register, relogin, useStore, logout } from '../store.js';
import { Field, Modal } from './ui.jsx';
import { LuCalendarClock } from 'react-icons/lu';

export function AuthScreen() {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errs.email = 'Enter a valid email address';
    if (mode === 'register' && form.password.length < 8) errs.password = 'Use at least 8 characters';
    if (!form.password) errs.password = 'Enter your password';
    setErrors(errs); setMsg('');
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      if (mode === 'login') await login(form.email.trim(), form.password);
      else await register(form.email.trim(), form.password, form.name.trim());
    } catch (err) {
      setErrors(err.extra && err.extra.fields ? err.extra.fields : {});
      setMsg(err.message);
    } finally { setBusy(false); }
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="brand-lg"><span className="brand-mark" aria-hidden="true"><LuCalendarClock /></span> Docket</div>
        <p className="auth-sub">Every commitment, its preparation and its reminders — in one place, on every device.</p>
        <div className="auth-tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setMsg(''); setErrors({}); }}>Sign in</button>
          <button role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setMsg(''); setErrors({}); }}>Create account</button>
        </div>
        <form onSubmit={submit} noValidate>
          {mode === 'register' && (
            <Field label="Your name" htmlFor="au-name" hint="Optional — used for greetings">
              <input id="au-name" className="input" autoComplete="name" value={form.name} onChange={set('name')} />
            </Field>
          )}
          <Field label="Email" htmlFor="au-email" error={errors.email} required>
            <input id="au-email" className="input" type="email" autoComplete="email" value={form.email} onChange={set('email')} aria-invalid={!!errors.email} required />
          </Field>
          <Field label="Password" htmlFor="au-pass" error={errors.password} hint={mode === 'register' ? 'At least 8 characters' : undefined} required>
            <input id="au-pass" className="input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={set('password')} aria-invalid={!!errors.password} required />
          </Field>
          {msg && <div className="alert alert-error" role="alert">{msg}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <p className="auth-foot">Your data is stored on this Docket server and synced to every device where you sign in.</p>
      </div>
    </main>
  );
}

export function SessionExpiredModal() {
  const expired = useStore((s) => s.sessionExpired);
  const user = useStore((s) => s.user);
  const queue = useStore((s) => s.queue);
  const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  if (!expired || !user) return null;
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try { await relogin(user.email, pw); setPw(''); } catch (er) { setErr(er.message); } finally { setBusy(false); }
  }
  return (
    <Modal open title="Your session has ended" size="sm" onClose={() => {}}>
      <form onSubmit={submit}>
        <p>Sign in again as <strong>{user.email}</strong> to continue.{queue.length ? ` ${queue.length} unsynced change${queue.length > 1 ? 's are' : ' is'} kept and will be saved after you sign in.` : ''}</p>
        <Field label="Password" htmlFor="re-pw" error={err}>
          <input id="re-pw" className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </Field>
        <div className="row gap end">
          <button type="button" className="btn" onClick={logout}>Sign out</button>
          <button className="btn btn-primary" disabled={busy || !pw}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
      </form>
    </Modal>
  );
}
