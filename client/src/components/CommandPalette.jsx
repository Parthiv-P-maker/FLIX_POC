import { useEffect, useMemo, useRef, useState } from 'react';
import { api, posterSrc } from '../lib/api.js';
import { formatDuration, plural } from '../lib/format.js';
import { useFocusTrap } from '../lib/hooks.js';
import { useApp } from '../store.jsx';
import Icon from './Icon.jsx';

/** Ctrl+K: one search across your videos, the catalog, photos and actions. */
export default function CommandPalette() {
  const { go, signOut, setPaletteOpen, openPlayer, closePlayer, setPhotoIntent, toggleTheme, theme } = useApp();
  // The player underneath would keep its own focus trap and shortcuts.
  useEffect(() => { closePlayer(); }, [closePlayer]);
  const [text, setText] = useState('');
  const [results, setResults] = useState(null); // { q, mine, shared, photos }
  const [status, setStatus] = useState('');
  const [active, setActive] = useState(0);
  const dialog = useFocusTrap(true);
  const list = useRef(null);
  const close = () => setPaletteOpen(false);

  // `keys` are extra words the filter matches on.
  const ACTIONS = useMemo(() => [
    { label: 'Go to Watch', keys: 'home library videos', icon: 'watch', run: () => go('watch') },
    { label: 'Go to Browse', keys: 'catalog shared explore', icon: 'browse', run: () => go('browse') },
    { label: 'Go to Photos', keys: 'timeline pictures images', icon: 'photos', run: () => go('photos') },
    { label: 'Go to Profile', keys: 'account settings password name', icon: 'profile', run: () => go('profile') },
    { label: 'Upload a video', keys: 'add new file', icon: 'upload', run: () => go('upload') },
    { label: 'Add photos', keys: 'upload images pictures', icon: 'upload', run: () => go('upload') },
    { label: 'Show favourite photos', keys: 'starred hearts', icon: 'heart', run: () => { setPhotoIntent({ favorite: true }); go('photos'); } },
    { label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`, keys: 'theme dark light mode appearance', icon: theme === 'dark' ? 'sun' : 'moon', run: toggleTheme },
    { label: 'Sign out', keys: 'log out logout', icon: 'out', run: signOut },
  ], [go, signOut, setPhotoIntent, toggleTheme, theme]);

  const q = text.trim();

  useEffect(() => {
    if (!q) { setResults(null); setStatus(''); return undefined; }
    setStatus('Searching…');
    let stale = false;
    // Actions filter on every keystroke; the network waits for a pause.
    const t = setTimeout(async () => {
      const enc = encodeURIComponent(q);
      const [mine, shared, photos] = await Promise.all([
        api(`/api/assets?limit=5&q=${enc}`).catch(() => ({ assets: [] })),
        api(`/api/catalog?limit=5&mine=exclude&q=${enc}`).catch(() => ({ assets: [] })),
        api(`/api/photos?limit=6&q=${enc}`).catch(() => ({ groups: [] })),
      ]);
      if (stale) return;
      setResults({ q, mine: mine.assets, shared: shared.assets, photos });
      const found = mine.assets.length + shared.assets.length + photos.groups.flatMap((g) => g.items).length;
      setStatus(plural(found, 'result'));
    }, 220);
    return () => { stale = true; clearTimeout(t); };
  }, [q]);

  const groups = useMemo(() => {
    const needle = q.toLowerCase();
    const actions = ACTIONS.filter((a) => `${a.label} ${a.keys}`.toLowerCase().includes(needle));
    if (!q || !results || results.q !== q) return [['Actions', actions]];

    const videoItem = (all) => (a) => ({
      label: a.title,
      sub: [a.ownerName && !a.isOwner ? a.ownerName : null, formatDuration(a.durationSec),
        a.status !== 'ready' ? 'processing' : null].filter(Boolean).join(' · '),
      thumb: posterSrc(a),
      run: () => { if (a.status === 'ready') openPlayer(a, all); else go('watch'); },
    });

    const photoList = results.photos.groups.flatMap((g) => g.items);
    const photoItems = photoList.map((p) => ({
      label: p.title,
      sub: [new Date(p.capturedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }),
        p.tags?.slice(0, 2).map((t) => t.label).join(', ')].filter(Boolean).join(' · '),
      thumb: posterSrc(p),
      run: () => { setPhotoIntent({ q, openId: p.id }); go('photos'); },
    }));
    // Always offer the full photo search, which also covers visual matches.
    photoItems.push({
      label: `Search photos for “${q}”`,
      sub: results.photos.search?.mode === 'smart' ? 'Titles, tags and what is in the picture' : 'Titles and tags',
      icon: 'sparkle',
      run: () => { setPhotoIntent({ q }); go('photos'); },
    });

    return [
      ['Actions', actions],
      ['Your videos', results.mine.map(videoItem(results.mine))],
      ['Shared videos', results.shared.map(videoItem(results.shared))],
      ['Photos', photoItems],
    ];
  }, [q, results, ACTIONS, openPlayer, go, setPhotoIntent]);

  const flat = groups.flatMap(([, items]) => items);
  useEffect(() => { setActive(0); }, [q, results]);

  useEffect(() => {
    list.current?.querySelector(`#pal-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (i) => {
    const item = flat[i];
    if (!item) return;
    close();
    item.run();
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (flat.length ? (i + 1) % flat.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  let n = -1;
  return (
    <div className="overlay palette-overlay" role="dialog" aria-modal="true" aria-label="Search everything"
         onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="palette neu" ref={dialog}>
        <div className="palette-input">
          <Icon name="search" />
          <input data-autofocus type="text" autoComplete="off" spellCheck={false}
                 placeholder="Search videos, photos and actions"
                 role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
                 aria-label="Search videos, photos and actions"
                 aria-activedescendant={flat.length ? `pal-${active}` : undefined}
                 value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" aria-label="Results" ref={list}>
          {groups.map(([title, items]) => items.length > 0 && (
            <div key={title} role="presentation">
              <div className="pal-group hud" role="presentation">{title}</div>
              {items.map((item) => {
                n += 1;
                const i = n;
                return (
                  <div key={`${title}-${i}`} id={`pal-${i}`} role="option" aria-selected={i === active}
                       className="pal-item" onMouseEnter={() => setActive(i)} onClick={() => run(i)}>
                    <span className="pal-thumb">
                      {item.thumb ? <img src={item.thumb} alt="" loading="lazy" /> : <Icon name={item.icon || 'go'} />}
                    </span>
                    <span className="pal-text">
                      <span className="pal-label">{item.label}</span>
                      {item.sub && <span className="pal-sub">{item.sub}</span>}
                    </span>
                    <Icon name="go" className="pal-go" />
                  </div>
                );
              })}
            </div>
          ))}
          {!flat.length && <div className="pal-empty">{q ? `Nothing matched “${q}”.` : ''}</div>}
        </div>
        <footer className="palette-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span className="palette-status" aria-live="polite">{status}</span>
        </footer>
      </div>
    </div>
  );
}
