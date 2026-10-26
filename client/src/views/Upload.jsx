import { useRef, useState } from 'react';
import { useApp } from '../store.jsx';
import Icon from '../components/Icon.jsx';
import { PageHead } from '../components/Media.jsx';

const MAX_PHOTOS = 20;

/** A dropzone wired to a hidden file input. */
function DropZone({ icon, label, accept, multiple, files, onFiles, inputRef, describe }) {
  const [over, setOver] = useState(false);
  const has = files.length > 0;
  return (
    <label className={`drop${over ? ' is-over' : ''}${has ? ' has-file' : ''}`}
           onDragEnter={(e) => { e.preventDefault(); setOver(true); }}
           onDragOver={(e) => { e.preventDefault(); setOver(true); }}
           onDragLeave={() => setOver(false)}
           onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); }}>
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} hidden
             onChange={(e) => onFiles([...e.target.files])} />
      <span className="drop-orb"><Icon name={has ? 'check' : icon} /></span>
      <strong className="drop-label">{has ? describe(files) : label}</strong>
      <small>{has ? 'Click to choose again' : 'or click to browse'}</small>
      <span className="drop-corners" aria-hidden="true"><i /><i /><i /><i /></span>
    </label>
  );
}

export default function Upload() {
  const { uploads } = useApp();
  const videoInput = useRef(null);
  const photoInput = useRef(null);

  const [videoFiles, setVideoFiles] = useState([]);
  const [title, setTitle] = useState('');
  const [shared, setShared] = useState(false);
  const [videoMsg, setVideoMsg] = useState({ text: '', kind: '' });

  const [photoFiles, setPhotoFiles] = useState([]);
  const [photoMsg, setPhotoMsg] = useState({ text: '', kind: '' });

  const QUEUED = 'Uploading. Follow it in the tray - you can keep browsing or add another.';

  const submitVideo = (e) => {
    e.preventDefault();
    const file = videoFiles[0];
    if (!file) { setVideoMsg({ text: 'Choose a video first.', kind: 'is-err' }); return; }
    const fd = new FormData();
    fd.append('video', file);
    if (title.trim()) fd.append('title', title.trim());
    // The route reads 'public' specifically; an unchecked box sends nothing.
    if (shared) fd.append('visibility', 'public');
    uploads.start({ kind: 'video', name: title.trim() || file.name, path: '/api/assets', formData: fd });
    setVideoMsg({ text: QUEUED, kind: 'is-ok' });
    setVideoFiles([]); setTitle(''); setShared(false);
    if (videoInput.current) videoInput.current.value = '';
  };

  const submitPhotos = (e) => {
    e.preventDefault();
    if (!photoFiles.length) { setPhotoMsg({ text: 'Choose at least one photo.', kind: 'is-err' }); return; }
    const files = photoFiles.slice(0, MAX_PHOTOS);
    const fd = new FormData();
    files.forEach((f) => fd.append('photos', f));
    uploads.start({
      kind: 'photos', name: files.length === 1 ? files[0].name : `${files.length} photos`, path: '/api/photos', formData: fd,
    });
    setPhotoMsg({
      text: photoFiles.length > MAX_PHOTOS ? `${QUEUED} Only the first ${MAX_PHOTOS} were sent.` : QUEUED,
      kind: 'is-ok',
    });
    setPhotoFiles([]);
    if (photoInput.current) photoInput.current.value = '';
  };

  return (
    <>
      <PageHead kicker="Ingest" title="Upload" sub="Files are processed in the background — you can keep browsing." />

      <div className="upload-pair">
        <form className="panel neu" onSubmit={submitVideo}>
          <div className="panel-head">
            <span className="panel-ico"><Icon name="film" /></span>
            <div>
              <h2 className="panel-title">Add a video</h2>
              <p className="panel-sub">MP4, WebM, MOV or MKV.</p>
            </div>
          </div>

          <DropZone icon="upload" label="Drop a video here" accept="video/*" inputRef={videoInput}
                    files={videoFiles} onFiles={(f) => { setVideoFiles(f.slice(0, 1)); setVideoMsg({ text: '', kind: '' }); }}
                    describe={(f) => f[0].name} />

          <label className="field">
            <span className="field-label">Title <em>optional</em></span>
            <input type="text" placeholder="Defaults to the filename" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>

          <label className="switch">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            <span className="switch-track"><span className="switch-knob" /></span>
            <span className="switch-text">
              <strong>Share to the catalog</strong>
              <small>Everyone with an account can find and watch it. You can undo this any time.</small>
            </span>
          </label>

          <button className="btn btn-primary btn-block btn-lg" type="submit"><Icon name="upload" />Upload video</button>
          <p className={`form-msg ${videoMsg.kind}`} role="status">{videoMsg.text}</p>
        </form>

        <form className="panel neu" onSubmit={submitPhotos}>
          <div className="panel-head">
            <span className="panel-ico"><Icon name="photos" /></span>
            <div>
              <h2 className="panel-title">Add photos</h2>
              <p className="panel-sub">JPEG, PNG, WebP, GIF or AVIF. Up to {MAX_PHOTOS} at once.</p>
            </div>
          </div>

          <DropZone icon="photos" label="Drop photos here" accept="image/*" multiple inputRef={photoInput}
                    files={photoFiles} onFiles={(f) => { setPhotoFiles(f); setPhotoMsg({ text: '', kind: '' }); }}
                    describe={(f) => (f.length === 1 ? f[0].name : `${f.length} photos selected`)} />

          <ul className="upload-perks">
            <li><Icon name="calendar" />Grouped by the date each photo was taken</li>
            <li><Icon name="sparkle" />Tagged by an on-device AI model, so you can search by content</li>
          </ul>

          <button className="btn btn-primary btn-block btn-lg" type="submit"><Icon name="upload" />Upload photos</button>
          <p className={`form-msg ${photoMsg.kind}`} role="status">{photoMsg.text}</p>
        </form>
      </div>
    </>
  );
}
