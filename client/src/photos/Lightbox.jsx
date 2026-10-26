import { useEffect, useState } from 'react';
import { api, withToken } from '../lib/api.js';
import { formatSize, isTyping, joinMeta, toLocalInputValue } from '../lib/format.js';
import { useFocusTrap } from '../lib/hooks.js';
import { useApp } from '../store.jsx';
import Icon from '../components/Icon.jsx';
import { deleteAsset } from '../components/Media.jsx';

/**
 * Full-size photo viewer. `photos` is the timeline flattened in display
 * order, so the arrows walk across month boundaries.
 */
export default function Lightbox({ photos, index, onIndex, onClose, onFavorite, onTag, onChanged }) {
  const { toast, refresh } = useApp();
  const photo = photos[index];
  const [editingDate, setEditingDate] = useState(false);
  const [dateValue, setDateValue] = useState('');
  const [loaded, setLoaded] = useState(false);
  const dialog = useFocusTrap(true);

  useEffect(() => { setLoaded(false); setEditingDate(false); }, [photo.id]);

  const step = (d) => {
    const next = index + d;
    if (next >= 0 && next < photos.length) onIndex(next);
  };

  // Text fields live in here (the date picker): "f" or an arrow must not
  // fire mid-typing. Escape always works, since dismissing is always safe.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (isTyping(e.target)) return;
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'f' || e.key === 'F') onFavorite(photo);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // A photo with no EXIF falls back to its upload time, which is usually
  // wrong. This is the only way to correct it.
  const saveDate = async (value) => {
    try {
      await api(`/api/assets/${photo.id}`, { method: 'PATCH', body: { capturedAt: value } });
      setEditingDate(false);
      toast(value === null ? 'Date reset to the upload time' : 'Capture date updated');
      // The date decides the month group, so the timeline is rebuilt.
      onChanged();
    } catch (err) {
      toast(err.message);
    }
  };

  const remove = async () => {
    const ok = await deleteAsset(photo, { toast, onDone: () => refresh('photos', 'profile') });
    if (ok) onClose();
  };

  const tags = photo.tags || [];

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="photo-title"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-wide neu" ref={dialog}>
        <header className="modal-head">
          <div>
            <span className="hud">{index + 1} / {photos.length}</span>
            <h3 id="photo-title">{photo.title}</h3>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>

        <div className="lightbox-stage">
          {!loaded && <span className="spinner lightbox-spinner" aria-hidden="true" />}
          <img key={photo.id} src={withToken(photo.originalUrl)} alt={photo.title}
               className={loaded ? 'is-loaded' : ''} onLoad={() => setLoaded(true)} />
          {index > 0 && (
            <button className="nav-arrow nav-prev" type="button" onClick={() => step(-1)} aria-label="Previous">
              <Icon name="prev" />
            </button>
          )}
          {index < photos.length - 1 && (
            <button className="nav-arrow nav-next" type="button" onClick={() => step(1)} aria-label="Next">
              <Icon name="next" />
            </button>
          )}
        </div>

        {editingDate && (
          <form className="about-form about-inline" onSubmit={(e) => {
            e.preventDefault();
            if (!dateValue) { toast('Pick a date, or use Clear to fall back to the upload time'); return; }
            // The input is local time with no zone; let Date attach the browser's.
            saveDate(new Date(dateValue).toISOString());
          }}>
            <label className="field">
              <span className="field-label">Date taken</span>
              <input type="datetime-local" value={dateValue} onChange={(e) => setDateValue(e.target.value)} />
            </label>
            <div className="about-actions">
              <button className="btn btn-primary" type="submit">Save date</button>
              <button className="btn" type="button" title="Fall back to the upload time" onClick={() => saveDate(null)}>Clear</button>
            </div>
          </form>
        )}

        {(tags.length > 0 || photo.aiStatus === 'pending') && (
          <div className="photo-tags">
            <span className="hud"><Icon name="sparkle" /> Detected</span>
            {tags.length ? tags.map((tag) => (
              <button key={tag.key} type="button" className="chip chip-tag" title={`Show all photos tagged ${tag.label}`}
                      onClick={() => onTag(tag.key)}>
                <span>{tag.label}</span>
                {/* The model's confidence, so an odd tag reads as a guess. */}
                <em className="tag-score" style={{ '--score': `${Math.round(tag.score * 100)}%` }}>
                  {Math.round(tag.score * 100)}%
                </em>
              </button>
            )) : <span className="muted-sm">Tagging…</span>}
          </div>
        )}

        <footer className="modal-foot">
          <span className="muted-sm">
            {joinMeta([
              photo.width && `${photo.width}×${photo.height}`,
              formatSize(photo.sizeBytes),
              new Date(photo.capturedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
            ])}
          </span>
          <div className="foot-actions">
            {photo.isOwner && (
              <button className={`btn${editingDate ? ' is-on' : ''}`} type="button" onClick={() => {
                setDateValue(toLocalInputValue(photo.capturedAt));
                setEditingDate((o) => !o);
              }}>
                <Icon name="calendar" />Edit date
              </button>
            )}
            <button className={`btn star-btn${photo.favorite ? ' is-on' : ''}`} type="button"
                    aria-pressed={Boolean(photo.favorite)} onClick={() => onFavorite(photo)}>
              <Icon name="heart" />{photo.favorite ? 'Favourited' : 'Favourite'}
            </button>
            {photo.isOwner && (
              <button className="btn btn-danger" type="button" onClick={remove}><Icon name="trash" />Delete</button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
