import { LuTriangleAlert, LuRepeat, LuMapPin, LuVideo, LuListChecks, LuFlag, LuCloudOff } from 'react-icons/lu';
import { useStore } from '../store.js';
import { CategoryTag, StatusBadge, PriorityBadge } from './ui.jsx';
import { cx, catOf, navigate, timeLabel, relDayLabel, todayStr } from '../lib.js';

export function ActivityRow({ a, occ, overlap, showDate, compact, extra }) {
  const settings = useStore((s) => s.settings);
  const categories = useStore((s) => s.categories);
  const queue = useStore((s) => s.queue);
  const cat = catOf(categories, a.category_id);
  const pending = queue.some((o) => o.kind === 'activity' && o.id === a.id);
  const done = (a.checklist || []).filter((t) => t.done).length;
  const total = (a.checklist || []).length;
  const inactive = a.status === 'cancelled' || a.status === 'completed' || a.status === 'missed';
  const open = () => navigate(`/activity/${a.id}`, occ && a.recurrence && a.recurrence.freq !== 'none' ? { on: occ.date } : undefined);
  return (
    <button type="button" className={cx('act-row', inactive && 'inactive', a.status === 'cancelled' && 'cancelled', compact && 'compact')} style={{ '--cat': cat ? cat.color : 'var(--muted-2)' }} onClick={open}>
      <span className="act-bar" aria-hidden="true" />
      <span className="act-time">
        {occ ? (<>
          {showDate && <span className="act-date">{relDayLabel(occ.date, todayStr(settings.timezone), settings)}</span>}
          <span>{timeLabel(a, occ, settings)}</span>
        </>) : <span className="tbd-pill">To be confirmed</span>}
      </span>
      <span className="act-main">
        <span className="act-title">
          {a.kind === 'deadline' && <LuFlag className="ic-deadline" aria-label="Deadline" />}
          {a.title}
          {a.is_sample && <span className="badge badge-sample">Sample</span>}
        </span>
        <span className="act-meta">
          <CategoryTag cat={cat} small />
          {!compact && <StatusBadge status={a.status} />}
          <PriorityBadge priority={a.priority} compact />
          {overlap && <span className="badge badge-warn" title="Overlaps with another activity"><LuTriangleAlert aria-hidden="true" /> Overlap</span>}
          {a.recurrence && a.recurrence.freq !== 'none' && <LuRepeat aria-label="Repeats" title="Repeats" />}
          {a.location && !compact && <span className="meta-item"><LuMapPin aria-hidden="true" />{a.location}</span>}
          {a.meeting_url && <span className="meta-item"><LuVideo aria-hidden="true" />Online</span>}
          {total > 0 && <span className={cx('meta-item', done === total && 'ok')}><LuListChecks aria-hidden="true" />{done}/{total}</span>}
          {pending && <span className="meta-item warn" title="Waiting to sync"><LuCloudOff aria-hidden="true" />Not synced</span>}
          {extra}
        </span>
      </span>
    </button>
  );
}
