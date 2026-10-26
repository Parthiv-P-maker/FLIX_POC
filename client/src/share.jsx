import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './styles/theme.css';
import './styles/app.css';
import { formatDuration, joinMeta, readPref } from './lib/format.js';
import { Logo } from './components/Sidebar.jsx';
import Icon from './components/Icon.jsx';

/**
 * The share viewer. Knows nothing about tokens or sessions: the slug in the
 * query string is the only credential, passed straight to /api/share. That is
 * what lets a recipient without an account watch without meeting the gate.
 */
function Share() {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    document.documentElement.dataset.theme = readPref('theme', 'dark');
    const slug = new URLSearchParams(location.search).get('s');
    // Fail the same way for a missing slug and a revoked one, so a prober
    // cannot tell which slugs once existed.
    if (!slug) {
      setState({ status: 'error', title: 'This link is not valid', body: 'The address is missing its share code.' });
      return;
    }
    fetch(`/api/share/${encodeURIComponent(slug)}`)
      .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
      .then((media) => {
        document.title = `${media.title} · FlixDrive`;
        setState({ status: 'ok', media });
      })
      .catch(() => setState({
        status: 'error',
        title: 'This link is not valid',
        body: 'It may have been revoked by its owner, or the address may be incomplete.',
      }));
  }, []);

  const { media } = state;

  return (
    <main className="share-page">
      <header className="share-head">
        <Logo />
        <span className="pill">Shared with you</span>
      </header>

      {state.status === 'loading' && <div className="share-stage neu sk" style={{ aspectRatio: '16 / 9' }} />}

      {state.status === 'ok' && (
        <>
          <section className="share-stage neu">
            {media.kind === 'photo'
              ? <img src={media.mediaUrl} alt={media.title} />
              : <video src={media.mediaUrl} poster={media.posterUrl || undefined} controls playsInline preload="metadata" />}
          </section>
          <section className="share-meta">
            <h1>{media.title}</h1>
            <p className="hero-meta">
              {joinMeta([
                media.kind === 'photo' ? 'Photo' : 'Video',
                media.width && `${media.width}×${media.height}`,
                media.durationSec ? formatDuration(media.durationSec) : null,
              ])}
            </p>
            {media.description && <p className="share-description">{media.description}</p>}
          </section>
        </>
      )}

      {state.status === 'error' && (
        <section className="empty neu">
          <div className="empty-ico"><Icon name="alert" /></div>
          <h3>{state.title}</h3>
          <p>{state.body}</p>
        </section>
      )}

      {state.status !== 'loading' && (
        <footer className="share-foot">
          <a className="btn" href="/">Open FlixDrive <Icon name="go" /></a>
        </footer>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><Share /></StrictMode>);
