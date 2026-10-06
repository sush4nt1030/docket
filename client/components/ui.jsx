import { useEffect, useRef, useState, useSyncExternalStore, useId } from 'react';
import { LuX, LuCloudOff, LuCloud, LuRefreshCw, LuCircleCheck, LuCircleAlert, LuTriangleAlert, LuLoader } from 'react-icons/lu';
import { useStore, dismissToast, retryNow, notificationAction, setState } from '../store.js';
import { cx, navigate, formatTime } from '../lib.js';
import { STATUS_LABELS, PRIORITY_LABELS } from '../../shared/model.js';

export function Modal({ open, onClose, title, children, footer, size = 'md', labelledBy, className, initialFocus }) {
  const ref = useRef(null);
  const prevFocus = useRef(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement;
    const el = ref.current;
    const focusFirst = () => {
      const target = (initialFocus && el.querySelector(initialFocus)) || el.querySelector('[data-autofocus]') || el.querySelector('input,select,textarea,button:not([data-close])') || el;
      target && target.focus();
    };
    setTimeout(focusFirst, 10);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose && onClose(); }
      if (e.key === 'Tab') {
        const f = [...el.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    el.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => { el.removeEventListener('keydown', onKey); document.body.classList.remove('modal-open'); prevFocus.current && prevFocus.current.focus && prevFocus.current.focus(); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose && onClose(); }}>
      <div ref={ref} className={cx('modal', `modal-${size}`, className)} role="dialog" aria-modal="true" aria-labelledby={labelledBy || `${id}-t`} tabIndex={-1}>
        {title !== undefined && (
          <div className="modal-head">
            <h2 id={`${id}-t`}>{title}</h2>
            <button className="icon-btn" data-close onClick={onClose} aria-label="Close"><LuX /></button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- confirm dialog (promise based) ----------
let confirmState = null; const cl = new Set();
const setConfirm = (v) => { confirmState = v; cl.forEach((l) => l()); };
export function confirmDialog(opts) { return new Promise((resolve) => setConfirm({ ...opts, resolve })); }
export function ConfirmHost() {
  const c = useSyncExternalStore((l) => { cl.add(l); return () => cl.delete(l); }, () => confirmState);
  const [text, setText] = useState('');
  useEffect(() => setText(''), [c]);
  if (!c) return null;
  const close = (v) => { setConfirm(null); c.resolve(v); };
  const blocked = c.typeToConfirm && text.trim() !== c.typeToConfirm;
  return (
    <Modal open onClose={() => close(false)} title={c.title} size="sm" footer={<>
      <button className="btn" onClick={() => close(false)}>{c.cancelLabel || 'Cancel'}</button>
      <button className={cx('btn', c.danger ? 'btn-danger' : 'btn-primary')} disabled={blocked} onClick={() => close(c.input ? text : true)} data-autofocus={!c.typeToConfirm && !c.input ? true : undefined}>{c.confirmLabel || 'Confirm'}</button>
    </>}>
      <div className="confirm-msg">{c.message}</div>
      {(c.typeToConfirm || c.input) && (
        <label className="field">
          <span className="field-label">{c.inputLabel || `Type “${c.typeToConfirm}” to confirm`}</span>
          <input className="input" type={c.inputType || 'text'} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </label>
      )}
    </Modal>
  );
}

export function Field({ label, hint, error, children, htmlFor, className, required }) {
  return (
    <div className={cx('field', error && 'has-error', className)}>
      {label && <label className="field-label" htmlFor={htmlFor}>{label}{required && <span className="req" aria-hidden="true"> *</span>}</label>}
      {children}
      {error ? <p className="field-error" role="alert" id={htmlFor ? `${htmlFor}-err` : undefined}><LuCircleAlert aria-hidden="true" /> {error}</p> : hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

export function CategoryTag({ cat, small }) {
  if (!cat) return <span className={cx('cat-tag', small && 'sm', 'cat-none')}><span className="dot" style={{ background: 'var(--muted-2)' }} aria-hidden="true" />Uncategorized</span>;
  return <span className={cx('cat-tag', small && 'sm')} style={{ '--cat': cat.color }}><span className="dot" aria-hidden="true" />{cat.name}</span>;
}
export function StatusBadge({ status }) { return <span className={cx('badge', `st-${status}`)}>{STATUS_LABELS[status]}</span>; }
export function PriorityBadge({ priority, compact }) {
  if (compact && priority === 'medium') return null;
  return <span className={cx('badge', `pr-${priority}`)} title={`${PRIORITY_LABELS[priority]} priority`}>{priority === 'high' ? '▲ ' : priority === 'low' ? '▽ ' : ''}{PRIORITY_LABELS[priority]}{compact ? '' : ' priority'}</span>;
}

export function EmptyState({ icon, title, children, action }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon" aria-hidden="true">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Segmented({ value, onChange, options, label, size }) {
  return (
    <div className={cx('segmented', size === 'sm' && 'sm')} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={cx(value === o.value && 'on')} onClick={() => onChange(o.value)}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, id, disabled, description }) {
  return (
    <label className={cx('toggle', disabled && 'disabled')} htmlFor={id}>
      <input id={id} type="checkbox" role="switch" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true"><span className="toggle-thumb" /></span>
      <span className="toggle-text"><span>{label}</span>{description && <small>{description}</small>}</span>
    </label>
  );
}

export function SaveIndicator() {
  const save = useStore((s) => s.save);
  const queue = useStore((s) => s.queue);
  const online = useStore((s) => s.online);
  const fromCache = useStore((s) => s.fromCache);
  const n = queue.length;
  let icon, text, cls;
  if (fromCache || !online) { icon = <LuCloudOff />; text = n ? `Offline · ${n} change${n > 1 ? 's' : ''} waiting to sync` : 'Offline · showing saved copy'; cls = 'warn'; }
  else if (save.state === 'error') { icon = <LuCircleAlert />; text = `Failed to save${n ? ` · ${n} waiting` : ''}`; cls = 'err'; }
  else if (save.state === 'conflict') { icon = <LuTriangleAlert />; text = 'Needs your decision'; cls = 'err'; }
  else if (save.state === 'saving' || n) { icon = <LuLoader className="spin" />; text = 'Saving…'; cls = 'busy'; }
  else if (save.state === 'saved') { icon = <LuCircleCheck />; text = 'Saved'; cls = 'ok'; }
  else { icon = <LuCloud />; text = 'All changes saved'; cls = 'ok'; }
  return (
    <div className={cx('save-ind', cls)} role="status" aria-live="polite" title={save.message || text}>
      {icon}<span className="save-text">{text}</span>
      {(save.state === 'error' || fromCache || (!online && n > 0)) && <button className="link-btn" onClick={retryNow}><LuRefreshCw aria-hidden="true" /> Retry</button>}
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const settings = useStore((s) => s.settings);
  const notifications = useStore((s) => s.notifications);
  // a reminder toast closes itself once that reminder is read, snoozed or dismissed here or on another device
  const handled = (n) => { const cur = notifications.find((x) => x.id === n.id); return cur && (cur.dismissed_at || cur.read_at || (cur.snoozed_until && cur.snoozed_until > Date.now())); };
  const visible = toasts.filter((t) => !t.notification || !handled(t.notification));
  return (
    <div className="toasts" aria-live="polite">
      {visible.map((t) => (
        <div key={t.id} className={cx('toast', `toast-${t.kind}`, t.notification && 'toast-notif')} role={t.kind === 'error' ? 'alert' : 'status'}>
          {t.notification ? (
            <>
              <div className="toast-title">🔔 {t.notification.title}</div>
              <div className="toast-body">{t.notification.body}</div>
              <div className="toast-meta">{formatTime(t.notification.created_at, settings.timezone, settings)}</div>
              <div className="toast-actions">
                {t.notification.activity_id && <button className="btn btn-sm" onClick={() => { navigate(`/activity/${t.notification.activity_id}`); dismissToast(t.id); }}>Open</button>}
                <button className="btn btn-sm" onClick={() => { notificationAction(t.notification.id, 'snooze', { minutes: 10 }).catch(() => {}); dismissToast(t.id); }}>Snooze 10 min</button>
                <button className="btn btn-sm" onClick={() => { notificationAction(t.notification.id, 'dismiss').catch(() => {}); dismissToast(t.id); }}>Dismiss</button>
              </div>
            </>
          ) : (
            <div className="toast-row">
              <span>{t.message}</span>
              {t.action && <button className="link-btn" onClick={() => { t.action.onClick(); dismissToast(t.id); }}>{t.action.label}</button>}
              <button className="icon-btn sm" aria-label="Dismiss" onClick={() => dismissToast(t.id)}><LuX /></button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label = 'Loading' }) { return <div className="spinner-wrap" role="status"><LuLoader className="spin" aria-hidden="true" /> {label}…</div>; }

export function Menu({ label, icon, children, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const f = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const k = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', f); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', f); document.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen(!open)}>{icon}</button>
      {open && <div className={cx('menu', `menu-${align}`)} role="menu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

export const clearConflicts = () => setState({ conflicts: [] });
