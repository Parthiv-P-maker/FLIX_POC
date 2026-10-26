import { api, posterSrc } from '../lib/api.js';
import { formatDuration, formatSize, plays } from '../lib/format.js';
import { useApp } from '../store.jsx';
import Icon from './Icon.jsx';

/**
 * Delete an asset, with the confirm and the error reporting in one place.
 * @returns {Promise<boolean>} whether it was actually deleted
 */
export async function deleteAsset(asset, { toast, onDone }) {
  const noun = asset.kind === 'photo' ? 'Photo' : 'Video';
  if (!window.confirm(`Delete "${asset.title}"? This removes the file from disk.`)) return false;
  try {
    await api(`/api/assets/${asset.id}`, { method: 'DELETE' });
    toast(`${noun} deleted`);
    onDone?.();
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

export function PageHead({ kicker, title, sub, children }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        {kicker && <span className="hud">{kicker}</span>}
        <h1>{title}</h1>
        {sub != null && <p className="page-sub">{sub || ' '}</p>}
      </div>
      {children && <div className="page-head-tools">{children}</div>}
    </header>
  );
}

/**
 * One tile shape for both the private library and the shared catalog.
 * `showOwner` separates them: in Browse the uploader is the point, in your
 * own library it would repeat your name on every card.
 *
 * A <div>, not a <button>: the card carries its own actions (delete), and a
 * button inside a button is invalid. The card-wide click comes from a
 * stretched ::after on the title button.
 */
export function VideoTile({ asset, percent, queue, showOwner = false, index = 0 }) {
  const { openPlayer, toast, refresh } = useApp();
  const ready = asset.status === 'ready';

  const sub = showOwner
    ? [asset.viewCount ? plays(asset.viewCount) : null, formatDuration(asset.durationSec)].filter(Boolean).join(' · ')
    : formatSize(asset.sizeBytes) + (asset.processingError ? ` · ${asset.processingError}` : '');

  const label = ready
    ? `Play ${asset.title}`
    : `${asset.title} — ${asset.status === 'failed' ? 'processing failed' : 'still processing'}`;

  return (
    <div className={`tile${ready ? '' : ' is-pending'}`} style={{ '--i': index }}>
      <div className="thumb">
        {asset.posterUrl
          ? <img src={posterSrc(asset)} alt="" loading="lazy" />
          : <span className="placeholder"><Icon name="film" /></span>}
        <span className="thumb-sheen" aria-hidden="true" />
        {ready && <span className="play-badge" aria-hidden="true"><Icon name="play" /></span>}
        {!ready && (
          <span className={`badge is-${asset.status}`}>
            {asset.status === 'failed' ? 'Failed' : <><span className="dot" />Processing</>}
          </span>
        )}
        {ready && !showOwner && asset.shared && (
          <span className="badge badge-share"><Icon name="globe" />Shared</span>
        )}
        {asset.durationSec ? <span className="duration">{formatDuration(asset.durationSec)}</span> : null}
        {percent ? <span className="progress-bar"><i style={{ width: `${Math.min(percent, 100)}%` }} /></span> : null}
        {asset.isOwner && (
          <button type="button" className="cell-trash" title="Delete this video"
                  aria-label={`Delete ${asset.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteAsset(asset, { toast, onDone: () => refresh('library', 'catalog', 'profile') });
                  }}>
            <Icon name="trash" />
          </button>
        )}
      </div>
      <div className="tile-body">
        <button className="tile-open" type="button" disabled={!ready} aria-label={label}
                onClick={() => openPlayer(asset, queue || [])}>
          {asset.title}
        </button>
        {showOwner && <div className="tile-owner">{asset.isOwner ? 'You' : asset.ownerName || 'Unknown member'}</div>}
        <div className="tile-sub">{sub}</div>
      </div>
    </div>
  );
}

export function Rail({ title, kicker, children, count }) {
  return (
    <section className="rail">
      <div className="rail-head">
        <h2 className="rail-title">{title}</h2>
        {kicker && <span className="hud">{kicker}</span>}
        {count != null && <span className="rail-count">{count}</span>}
      </div>
      {children}
    </section>
  );
}

export function TileGrid({ assets, percentById, showOwner }) {
  return (
    <div className="grid">
      {assets.map((a, i) => (
        <VideoTile key={a.id} asset={a} index={i} queue={assets} showOwner={showOwner}
                   percent={percentById?.get(String(a.id))} />
      ))}
    </div>
  );
}

export function SkeletonGrid({ count = 8 }) {
  return (
    <div className="grid" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="tile tile-skeleton" aria-hidden="true" key={i}>
          <div className="thumb sk" />
          <div className="tile-body"><span className="sk sk-line" /><span className="sk sk-line short" /></div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, actions, steps }) {
  return (
    <div className="empty neu">
      <div className="empty-ico"><Icon name={icon} /></div>
      <h3>{title}</h3>
      <p>{children}</p>
      {actions && <div className="empty-actions">{actions}</div>}
      {steps && (
        <ol className="empty-steps">
          {steps.map((s, i) => <li key={i}><span className="step-n">0{i + 1}</span>{s}</li>)}
        </ol>
      )}
    </div>
  );
}

export function Sentinel({ sentinelRef, show }) {
  return (
    <div className="sentinel" ref={sentinelRef} hidden={!show}>
      <span className="spinner" aria-hidden="true" />
      <span>Loading more…</span>
    </div>
  );
}
