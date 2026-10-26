import { useCallback, useEffect, useRef, useState } from 'react';
import { api, posterSrc, refreshMediaToken, sendProgress, withToken } from '../lib/api.js';
import {
  clamp, formatDuration, isTyping, joinMeta, plays, readPref, writePref,
} from '../lib/format.js';
import { useFocusTrap } from '../lib/hooks.js';
import { useApp } from '../store.jsx';
import { deleteAsset } from '../components/Media.jsx';
import Icon from '../components/Icon.jsx';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const UP_NEXT_SECONDS = 8;
const PROGRESS_EVERY_MS = 10000;
const IDLE_MS = 2600;

const SHORTCUTS = [
  [['Space', 'K'], 'Play / pause'],
  [['J', 'L'], 'Back / forward 10 s'],
  [['←', '→'], 'Back / forward 5 s'],
  [['↑', '↓'], 'Volume'],
  [['M'], 'Mute'],
  [['F'], 'Fullscreen'],
  [['<', '>'], 'Slower / faster'],
  [['0–9'], 'Jump to 0–90%'],
  [['?'], 'Show this list'],
];

/**
 * The video overlay. Mounted fresh for every open (App keys it), so all the
 * per-video state - resume point, up-next countdown, menus - starts clean
 * without a reset routine, and unmounting is the close.
 */
export default function Player() {
  const { player, closePlayer, openPlayer, toast, refresh } = useApp();
  const { queue } = player;
  const [asset, setAsset] = useState(player.asset);

  const video = useRef(null);
  const stage = useRef(null);
  const scrub = useRef(null);
  const lastSent = useRef(0);
  const alive = useRef(true); // false once deleted, so pause stops writing progress
  const dialog = useFocusTrap(true);

  const [t, setT] = useState(0);
  const [dur, setDur] = useState(asset.durationSec || 0);
  const [buffered, setBuffered] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [vol, setVol] = useState(() => clamp(Number(readPref('volume', 1)) || 0, 0, 1));
  const [muted, setMuted] = useState(() => Boolean(readPref('muted', false)));
  const [rate, setRate] = useState(() => (SPEEDS.includes(readPref('speed', 1)) ? readPref('speed', 1) : 1));
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [flash, setFlash] = useState(null);
  const [preview, setPreview] = useState(null); // { x, t }
  const [dragging, setDragging] = useState(false);
  const [upNext, setUpNext] = useState(null);   // { asset, left }
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(asset.description || '');
  const [busy, setBusy] = useState(false);

  const durationNow = useCallback(() => {
    const v = video.current;
    return (v && Number.isFinite(v.duration) ? v.duration : asset.durationSec) || 0;
  }, [asset.durationSec]);

  const showFlash = (text) => setFlash({ text, id: Date.now() });

  /* ---- open: resume point, then source ----------------------------- */
  useEffect(() => {
    let cancelled = false;
    alive.current = true; // StrictMode runs this twice; the first cleanup cleared it
    const v = video.current;
    v.volume = vol;
    v.muted = muted;
    v.defaultPlaybackRate = rate;
    v.playbackRate = rate;

    // One bump per open, not per range request.
    api(`/api/assets/${asset.id}/view`, { method: 'POST' }).catch(() => {});

    (async () => {
      // Resume, unless the viewer was essentially at the start or the end. The
      // media token is refreshed alongside: a film is long enough that starting
      // on a nearly-expired token would stall partway through.
      let resumeAt = 0;
      try {
        const [p] = await Promise.all([api(`/api/progress/${asset.id}`), refreshMediaToken()]);
        if (!p.completed && p.positionSec > 5) resumeAt = p.positionSec;
      } catch { /* no progress row is not an error */ }
      if (cancelled) return;

      // Listener first, then src: the element preloads metadata, so the other
      // order can fire loadedmetadata before anything is listening.
      v.addEventListener('loadedmetadata', () => {
        if (resumeAt > 0 && resumeAt < v.duration - 10) v.currentTime = resumeAt;
        v.play().catch(() => {});
      }, { once: true });
      v.src = withToken(asset.streamUrl);
    })();

    return () => {
      cancelled = true;
      if (alive.current && v.currentTime > 0) sendProgress(asset.id, v.currentTime, true);
      alive.current = false;
      v.pause();
      v.removeAttribute('src');
      v.load();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      refresh('library', 'catalog', 'profile');
    };
    // Runs once per mount; App remounts the player for every new video.
  }, []);

  useEffect(() => {
    const onUnload = () => {
      const v = video.current;
      if (alive.current && v) sendProgress(asset.id, v.currentTime, true);
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [asset.id]);

  /* ---- media events ------------------------------------------------- */
  const onTimeUpdate = () => {
    const v = video.current;
    setT(v.currentTime);
    if (v.paused || !alive.current) return;
    const now = Date.now();
    if (now - lastSent.current < PROGRESS_EVERY_MS) return;
    lastSent.current = now;
    sendProgress(asset.id, v.currentTime);
  };

  // Only the range that contains the playhead counts: a chunk buffered far
  // ahead after a seek is not something the viewer can play into.
  const onProgress = () => {
    const v = video.current;
    let end = 0;
    for (let i = 0; i < v.buffered.length; i += 1) {
      if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
    }
    setBuffered(end);
  };

  const onPause = () => {
    setPlaying(false);
    setWaiting(false);
    if (alive.current) sendProgress(asset.id, video.current.currentTime);
  };

  const onVolume = () => {
    const v = video.current;
    setVol(v.volume);
    setMuted(v.muted);
    writePref('volume', v.volume);
    writePref('muted', v.muted);
  };

  const nextInQueue = () => {
    const i = queue.findIndex((a) => String(a.id) === String(asset.id));
    if (i === -1) return null;
    return queue.slice(i + 1).find((a) => a.status === 'ready') || null;
  };

  const onEnded = () => {
    if (alive.current) sendProgress(asset.id, video.current.currentTime);
    const next = nextInQueue();
    if (next) setUpNext({ asset: next, left: UP_NEXT_SECONDS });
  };

  // Up-next countdown.
  useEffect(() => {
    if (!upNext) return undefined;
    if (upNext.left <= 0) { openPlayer(upNext.asset, queue); return undefined; }
    const id = setTimeout(() => setUpNext((u) => u && { ...u, left: u.left - 1 }), 1000);
    return () => clearTimeout(id);
  }, [upNext, openPlayer, queue]);

  /* ---- controls ----------------------------------------------------- */
  const togglePlay = () => {
    const v = video.current;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };

  const seekTo = (seconds) => {
    const d = durationNow();
    if (!d) return;
    video.current.currentTime = clamp(seconds, 0, Math.max(0, d - 0.1));
    setT(video.current.currentTime);
  };

  const seekBy = (delta) => {
    seekTo((video.current.currentTime || 0) + delta);
    showFlash(`${delta > 0 ? '+' : '−'}${Math.abs(delta)}s`);
  };

  const nudgeVolume = (delta) => {
    const v = video.current;
    v.muted = false;
    v.volume = clamp(Math.round((v.volume + delta) * 20) / 20, 0, 1);
    showFlash(`Volume ${Math.round(v.volume * 100)}%`);
  };

  const toggleMute = () => {
    const v = video.current;
    v.muted = !v.muted;
    // Unmuting at zero volume would change nothing the viewer can hear.
    if (!v.muted && v.volume === 0) v.volume = 0.5;
    showFlash(v.muted ? 'Muted' : `Volume ${Math.round(v.volume * 100)}%`);
  };

  const setSpeed = (next) => {
    const v = video.current;
    // defaultPlaybackRate too: a new src resets playbackRate to it.
    v.defaultPlaybackRate = next;
    v.playbackRate = next;
    setRate(next);
    writePref('speed', next);
  };

  const stepSpeed = (dir) => {
    const i = SPEEDS.indexOf(rate);
    const next = SPEEDS[clamp((i === -1 ? SPEEDS.indexOf(1) : i) + dir, 0, SPEEDS.length - 1)];
    setSpeed(next);
    showFlash(`${next}×`);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (stage.current.requestFullscreen) stage.current.requestFullscreen().catch(() => {});
    // iPhone Safari cannot fullscreen an element, only the video itself.
    else if (video.current.webkitEnterFullscreen) video.current.webkitEnterFullscreen();
  };

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const togglePip = () => {
    const p = document.pictureInPictureElement
      ? document.exitPictureInPicture()
      : video.current.requestPictureInPicture();
    p.catch(() => toast('Picture in picture is not available for this video'));
  };

  /* ---- auto-hiding controls ---------------------------------------- */
  const idleTimer = useRef(null);
  const busyRef = useRef(false);
  busyRef.current = !playing || dragging || speedOpen || keysOpen || Boolean(upNext);
  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => { if (!busyRef.current) setIdle(true); }, IDLE_MS);
  }, []);
  useEffect(() => { wake(); return () => clearTimeout(idleTimer.current); }, [playing, wake]);

  // On touch, the first tap on a hidden-controls stage brings the controls
  // back rather than pausing the film out from under the viewer.
  const lastPointer = useRef('mouse');
  const onPictureClick = () => {
    if (lastPointer.current === 'touch' && idle) return wake();
    return togglePlay();
  };

  /* ---- scrubbing ---------------------------------------------------- */
  const timeAtX = (clientX) => {
    const r = scrub.current.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1) * durationNow();
  };
  const showPreview = (clientX) => {
    const r = scrub.current.getBoundingClientRect();
    setPreview({ x: clientX - r.left, width: r.width, t: timeAtX(clientX) });
  };

  /* ---- keyboard ----------------------------------------------------- */
  const handleKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === ' ' && e.target instanceof HTMLButtonElement) return false;
    switch (e.key) {
      case ' ': case 'k': case 'K': togglePlay(); break;
      case 'j': case 'J': seekBy(-10); break;
      case 'l': case 'L': seekBy(10); break;
      case 'ArrowLeft': seekBy(-5); break;
      case 'ArrowRight': seekBy(5); break;
      case 'ArrowUp': nudgeVolume(0.05); break;
      case 'ArrowDown': nudgeVolume(-0.05); break;
      case 'm': case 'M': toggleMute(); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case '<': stepSpeed(-1); break;
      case '>': stepSpeed(1); break;
      case '?': setKeysOpen((o) => !o); break;
      case 'Home': seekTo(0); break;
      case 'End': seekTo(durationNow()); break;
      default:
        if (/^[0-9]$/.test(e.key)) { seekTo((durationNow() * Number(e.key)) / 10); break; }
        return false;
    }
    return true;
  };
  const keyRef = useRef(handleKey);
  keyRef.current = handleKey;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        // Peel off the innermost layer first: menu, then help, then the player.
        if (speedOpen) return setSpeedOpen(false);
        if (keysOpen) return setKeysOpen(false);
        if (document.activeElement?.tagName === 'TEXTAREA') return setEditing(false);
        return closePlayer();
      }
      if (e.target.type === 'range' && e.key.startsWith('Arrow')) return undefined;
      if (isTyping(e.target) && e.target.type !== 'range') return undefined;
      if (keyRef.current(e)) { e.preventDefault(); wake(); }
      return undefined;
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [speedOpen, keysOpen, closePlayer, wake]);

  // Close the speed menu on any press outside it.
  useEffect(() => {
    if (!speedOpen) return undefined;
    const onDown = (e) => { if (!e.target.closest('.pc-speed-wrap')) setSpeedOpen(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [speedOpen]);

  /* ---- owner actions ------------------------------------------------ */
  const patchAsset = async (body) => {
    const res = await api(`/api/assets/${asset.id}`, { method: 'PATCH', body });
    setAsset((a) => ({ ...a, ...res.asset }));
    return { ...asset, ...res.asset };
  };

  const toggleShare = async () => {
    const next = !asset.shared;
    if (next && !window.confirm(`Share "${asset.title}" to the catalog? Everyone with an account will be able to watch it.`)) return;
    try {
      await patchAsset({ shared: next });
      toast(next ? 'Shared to the catalog' : 'Made private again');
      refresh('library', 'catalog', 'profile');
    } catch (err) { toast(err.message); }
  };

  // Copy a share link, minting one on first use. Private goes to 'unlisted';
  // public must stay public, or asking for a link would pull it from Browse.
  const copyLink = async () => {
    setBusy(true);
    try {
      let current = asset;
      if (!current.shareUrl) {
        current = await patchAsset({ visibility: current.visibility === 'private' ? 'unlisted' : current.visibility });
        refresh('library');
      }
      try {
        await navigator.clipboard.writeText(current.shareUrl);
        toast('Share link copied — anyone with it can watch, no account needed');
      } catch {
        toast(current.shareUrl); // clipboard denied: showing it beats failing silently
      }
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const saveDescription = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await patchAsset({ description: draft });
      setEditing(false);
      toast('Description saved');
      refresh('library');
    } catch (err) { toast(err.message); } finally { setBusy(false); }
  };

  const remove = async () => {
    const ok = await deleteAsset(asset, { toast, onDone: () => refresh('library', 'catalog', 'profile') });
    if (!ok) return;
    alive.current = false;
    closePlayer();
  };

  /* ---- render ------------------------------------------------------- */
  const pct = dur ? (t / dur) * 100 : 0;
  const silent = muted || vol === 0;
  const description = (asset.description || '').trim();
  const sprite = asset.sprite;

  let thumbStyle = null;
  if (preview && sprite) {
    const i = clamp(Math.floor(preview.t / sprite.interval), 0, sprite.count - 1);
    const scale = 160 / sprite.width;
    thumbStyle = {
      height: `${Math.round(sprite.height * scale)}px`,
      backgroundImage: `url("${withToken(sprite.url)}")`,
      backgroundSize: `${sprite.cols * sprite.width * scale}px ${sprite.rows * sprite.height * scale}px`,
      backgroundPosition: `-${(i % sprite.cols) * sprite.width * scale}px -${Math.floor(i / sprite.cols) * sprite.height * scale}px`,
    };
  }
  const half = sprite ? 86 : 28;
  const previewLeft = preview ? clamp(preview.x, half, preview.width - half) : 0;

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="player-title"
         onMouseDown={(e) => { if (e.target === e.currentTarget) closePlayer(); }}>
      <div className="modal modal-wide neu" ref={dialog}>
        <header className="modal-head">
          <div>
            <span className="hud">Now playing</span>
            <h3 id="player-title">{asset.title}</h3>
          </div>
          <button className="icon-btn" type="button" onClick={closePlayer} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <div ref={stage}
             className={`player-stage${playing ? ' is-playing' : ''}${idle ? ' is-idle' : ''}${dragging ? ' is-dragging' : ''}`}
             onPointerMove={wake} onPointerDown={wake} onFocus={wake}>
          <video ref={video} playsInline preload="metadata" poster={posterSrc(asset) || undefined}
                 onPointerDown={(e) => { lastPointer.current = e.pointerType; }}
                 onClick={onPictureClick} onDoubleClick={toggleFullscreen}
                 onPlay={() => setPlaying(true)} onPause={onPause}
                 onTimeUpdate={onTimeUpdate} onDurationChange={(e) => setDur(e.currentTarget.duration || asset.durationSec || 0)}
                 onProgress={onProgress} onSeeked={onProgress} onVolumeChange={onVolume}
                 onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
                 onWaiting={() => setWaiting(true)} onPlaying={() => setWaiting(false)}
                 onCanPlay={() => setWaiting(false)} onEnded={onEnded}
                 onError={() => { setWaiting(false); if (alive.current) showFlash('This video could not be played'); }} />

          {waiting && <div className="player-spinner"><span className="spinner" /></div>}
          {flash && <div className="player-flash" key={flash.id} aria-hidden="true">{flash.text}</div>}

          {upNext && (
            <aside className="upnext neu" aria-live="polite">
              <div className="upnext-thumb">
                {upNext.asset.posterUrl && <img src={posterSrc(upNext.asset)} alt="" />}
                <svg className="upnext-ring" viewBox="0 0 36 36" aria-hidden="true">
                  <circle cx="18" cy="18" r="16" style={{ strokeDashoffset: 100 - (upNext.left / UP_NEXT_SECONDS) * 100 }} />
                </svg>
              </div>
              <div className="upnext-body">
                <span className="hud">Up next in {upNext.left}s</span>
                <strong>{upNext.asset.title}</strong>
                <div className="upnext-actions">
                  <button className="btn btn-primary btn-sm" type="button" onClick={() => openPlayer(upNext.asset, queue)}>Play now</button>
                  <button className="btn btn-sm" type="button" onClick={() => setUpNext(null)}>Cancel</button>
                </div>
              </div>
            </aside>
          )}

          {keysOpen && (
            <div className="keys-help neu" role="dialog" aria-label="Keyboard shortcuts">
              <h4>Keyboard shortcuts</h4>
              <dl>
                {SHORTCUTS.map(([keys, what]) => (
                  <div key={what}>
                    <dt>{keys.map((k) => <kbd key={k}>{k}</kbd>)}</dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          <div className="pc">
            <div ref={scrub} className="scrub" role="slider" tabIndex={0} aria-label="Seek"
                 aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(t)}
                 aria-valuetext={`${formatDuration(t)} of ${formatDuration(dur)}`}
                 onPointerMove={(e) => { showPreview(e.clientX); if (dragging) seekTo(timeAtX(e.clientX)); }}
                 onPointerLeave={() => { if (!dragging) setPreview(null); }}
                 onPointerDown={(e) => {
                   setDragging(true);
                   e.currentTarget.setPointerCapture(e.pointerId);
                   showPreview(e.clientX);
                   seekTo(timeAtX(e.clientX));
                 }}
                 onPointerUp={(e) => {
                   setDragging(false);
                   if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                   if (e.pointerType !== 'mouse') setPreview(null);
                 }}
                 onPointerCancel={() => { setDragging(false); setPreview(null); }}>
              <div className="scrub-track">
                <i className="scrub-buffer" style={{ width: dur ? `${(buffered / dur) * 100}%` : '0%' }} />
                <i className="scrub-played" style={{ width: `${pct}%` }} />
                <i className="scrub-knob" style={{ left: `${pct}%` }} />
              </div>
              {preview && (
                <div className="scrub-preview" style={{ left: `${previewLeft}px` }}>
                  {thumbStyle && <div className="scrub-thumb" style={thumbStyle} />}
                  <span className="scrub-time">{formatDuration(preview.t)}</span>
                </div>
              )}
            </div>

            <div className="pc-row">
              <button className="pc-btn pc-main" type="button" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
                <Icon name={playing ? 'pause' : 'play'} />
              </button>
              <button className="pc-btn pc-skip" type="button" onClick={() => seekBy(-10)} aria-label="Back 10 seconds">
                <Icon name="back10" /><span>10</span>
              </button>
              <button className="pc-btn pc-skip" type="button" onClick={() => seekBy(10)} aria-label="Forward 10 seconds">
                <Icon name="fwd10" /><span>10</span>
              </button>
              <div className="pc-volume">
                <button className="pc-btn" type="button" onClick={toggleMute} aria-label={silent ? 'Unmute' : 'Mute'}>
                  <Icon name={silent ? 'muted' : 'volume'} />
                </button>
                <input className="pc-vol" type="range" min="0" max="1" step="0.05" aria-label="Volume"
                       value={silent ? 0 : vol} style={{ '--fill': `${(silent ? 0 : vol) * 100}%` }}
                       onChange={(e) => {
                         const v = video.current;
                         v.volume = Number(e.target.value);
                         v.muted = v.volume === 0;
                       }} />
              </div>
              <span className="pc-time">{formatDuration(t)} <i>/</i> {formatDuration(dur)}</span>
              <span className="pc-spacer" />
              <div className="pc-speed-wrap">
                <button className="pc-btn pc-pill" type="button" aria-haspopup="true" aria-expanded={speedOpen}
                        aria-label="Playback speed" onClick={() => setSpeedOpen((o) => !o)}>
                  {rate}×
                </button>
                {speedOpen && (
                  <div className="pc-menu neu" role="group" aria-label="Playback speed">
                    {SPEEDS.map((s) => (
                      <button key={s} type="button" aria-pressed={s === rate} autoFocus={s === rate}
                              onClick={() => { setSpeed(s); setSpeedOpen(false); }}>
                        {s === 1 ? 'Normal' : `${s}×`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {document.pictureInPictureEnabled && (
                <button className="pc-btn" type="button" onClick={togglePip} aria-label="Picture in picture">
                  <Icon name="pip" />
                </button>
              )}
              <button className="pc-btn" type="button" onClick={() => setKeysOpen((o) => !o)}
                      aria-label="Keyboard shortcuts" aria-expanded={keysOpen}>
                <Icon name="keys" />
              </button>
              <button className="pc-btn" type="button" onClick={toggleFullscreen} aria-label="Fullscreen">
                <Icon name={fullscreen ? 'exitFull' : 'full'} />
              </button>
            </div>
          </div>
        </div>

        {(asset.isOwner || description) && (
          <section className="about">
            {editing ? (
              <form className="about-form" onSubmit={saveDescription}>
                <label className="field">
                  <span className="field-label">Description</span>
                  <textarea rows={3} maxLength={2000} placeholder="What is this?" autoFocus
                            value={draft} onChange={(e) => setDraft(e.target.value)} />
                </label>
                <div className="about-actions">
                  <button className="btn btn-primary" type="submit" disabled={busy}>Save</button>
                  <button className="btn" type="button" onClick={() => { setEditing(false); setDraft(description); }}>Cancel</button>
                </div>
              </form>
            ) : (
              <>
                {description && <p className="about-text">{description}</p>}
                {asset.isOwner && (
                  <button className="link-btn" type="button" onClick={() => { setDraft(description); setEditing(true); }}>
                    <Icon name="edit" /> {description ? 'Edit description' : 'Add a description'}
                  </button>
                )}
              </>
            )}
          </section>
        )}

        <footer className="modal-foot">
          <span className="muted-sm">
            {joinMeta([
              !asset.isOwner && asset.ownerName ? `Shared by ${asset.ownerName}` : null,
              asset.width && `${asset.width}×${asset.height}`,
              formatDuration(asset.durationSec),
              asset.viewCount ? plays(asset.viewCount) : null,
            ])}
          </span>
          {asset.isOwner && (
            <div className="foot-actions">
              <button className={`btn${asset.shared ? ' is-on' : ''}`} type="button" onClick={toggleShare}>
                <Icon name="globe" />{asset.shared ? 'Shared · make private' : 'Share to catalog'}
              </button>
              <button className={`btn${asset.linkShared ? ' is-on' : ''}`} type="button" onClick={copyLink} disabled={busy}>
                <Icon name="link" />{asset.shareUrl ? 'Copy link' : 'Get a link'}
              </button>
              <button className="btn btn-danger" type="button" onClick={remove}><Icon name="trash" />Delete</button>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
