import { useState } from 'react';
import { api } from '../lib/api.js';
import { plural } from '../lib/format.js';
import { isActiveJob, useApp } from '../store.jsx';
import Icon from './Icon.jsx';

function stateText(job) {
  const n = job.assets.length;
  switch (job.phase) {
    case 'uploading': return `${Math.round(job.percent * 100)}%`;
    case 'processing': {
      if (job.kind !== 'photos') return 'Processing…';
      return `Processing ${job.assets.filter((a) => a.status === 'ready').length}/${n}`;
    }
    case 'ready': {
      const failed = job.assets.filter((a) => a.status === 'failed').length;
      return failed ? `${n - failed} ready · ${failed} failed` : 'Ready';
    }
    case 'cancelled': return 'Cancelled';
    default: return job.error || 'Failed';
  }
}

/** Follows the user across views while files upload and the worker runs. */
export default function UploadTray() {
  const { uploads, openPlayer, go, toast } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const { jobs } = uploads;
  if (!jobs.length) return null;

  const active = jobs.filter(isActiveJob).length;

  const playJob = async (job) => {
    try {
      const { asset } = await api(`/api/assets/${job.assets[0].id}`);
      openPlayer(asset, [asset]);
    } catch (err) {
      toast(err.message);
    }
  };

  return (
    <aside className={`tray neu${collapsed ? ' is-collapsed' : ''}`} aria-labelledby="tray-title">
      <header className="tray-head">
        {active > 0 && <span className="spinner spinner-sm" aria-hidden="true" />}
        <strong id="tray-title">{active ? `${plural(active, 'upload')} in progress` : 'Uploads done'}</strong>
        <button className="icon-btn tray-btn" type="button" aria-expanded={!collapsed}
                aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'} onClick={() => setCollapsed((c) => !c)}>
          <Icon name="chevronDown" className={collapsed ? 'flip' : ''} />
        </button>
        <button className="icon-btn tray-btn" type="button" aria-label="Clear finished uploads" onClick={uploads.clearFinished}>
          <Icon name="close" />
        </button>
      </header>
      {!collapsed && (
        <ul className="tray-list" aria-live="polite">
          {jobs.map((job) => (
            <li key={job.id} className={`tray-item is-${job.phase === 'cancelled' ? 'failed' : job.phase}`}>
              <div className="tray-line">
                <span className="tray-name">{job.name}</span>
                <span className="tray-state">{stateText(job)}</span>
              </div>
              <div className={`meter${job.phase === 'processing' ? ' is-indeterminate' : ''}`}>
                <i style={{ width: `${Math.round(job.percent * 100)}%` }} />
              </div>
              <div className="tray-actions">
                {job.phase === 'uploading' && (
                  <button type="button" className="tray-act" onClick={() => uploads.cancel(job.id)}>Cancel</button>
                )}
                {job.phase === 'ready' && job.kind === 'video' && job.assets[0]?.status === 'ready' && (
                  <button type="button" className="tray-act" onClick={() => playJob(job)}>Play</button>
                )}
                {job.phase === 'ready' && job.kind === 'photos' && (
                  <button type="button" className="tray-act" onClick={() => go('photos')}>View photos</button>
                )}
                {!isActiveJob(job) && (
                  <button type="button" className="tray-act" onClick={() => uploads.dismiss(job.id)}>Dismiss</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
