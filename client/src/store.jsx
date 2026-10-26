import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, clearMediaToken, getToken, refreshMediaToken, setToken, setUnauthorizedHandler, upload,
} from './lib/api.js';
import { readPref, writePref } from './lib/format.js';

/**
 * App-wide state that more than one view needs: who is signed in, which view
 * is open, the toast, the upload tray, the open video, and "something changed,
 * fetch again" signals.
 *
 * The vanilla client re-ran loadLibrary()/loadPhotos() after every mutation.
 * Here each data set has a version number instead: a mutation bumps it, and
 * any mounted view that depends on it refetches. A view that is not on screen
 * simply fetches fresh the next time it mounts.
 */
const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

export const VIEWS = ['watch', 'browse', 'photos', 'upload', 'profile'];
const viewFromHash = () => {
  const v = location.hash.slice(1);
  return VIEWS.includes(v) ? v : 'watch';
};

const MEDIA_TOKEN_REFRESH_MS = 45 * 60 * 1000;

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [mediaReady, setMediaReady] = useState(false);
  const [view, setView] = useState(viewFromHash);
  const [toastMsg, setToastMsg] = useState(null);
  const [versions, setVersions] = useState({ library: 0, catalog: 0, photos: 0, profile: 0 });
  const [player, setPlayer] = useState(null);           // { asset, queue }
  const [photoIntent, setPhotoIntent] = useState(null); // { q, openId, favorite }
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState(() => readPref('theme', 'dark'));
  const toastTimer = useRef(null);

  /* ---- theme ---- */
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePref('theme', theme);
  }, [theme]);
  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);

  /* ---- toast ---- */
  const toast = useCallback((message) => {
    setToastMsg({ message, id: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3400);
  }, []);

  /* ---- refresh signals ---- */
  const refresh = useCallback((...keys) => {
    setVersions((v) => {
      const next = { ...v };
      keys.forEach((k) => { next[k] += 1; });
      return next;
    });
  }, []);

  /* ---- navigation ---- */
  // The view lives in the URL, so a reload stays put and the installed app's
  // shortcuts (/#photos, /#upload) land in the right place.
  const go = useCallback((name) => {
    const next = VIEWS.includes(name) ? name : 'watch';
    if (location.hash !== `#${next}`) history.replaceState(null, '', `#${next}`);
    setView(next);
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /* ---- uploads ---- */
  const uploads = useUploads({ signedIn: Boolean(user), refresh });

  /* ---- auth ---- */
  const signOut = useCallback(() => {
    setToken(null);
    clearMediaToken();
    setMediaReady(false);
    setPlayer(null);
    setPaletteOpen(false);
    uploads.abortAll();
    setUser(null);
  }, [uploads]);

  useEffect(() => { setUnauthorizedHandler(signOut); }, [signOut]);

  const enter = useCallback(async (nextUser, nextToken) => {
    if (nextToken) setToken(nextToken);
    setUser(nextUser);
    // Before anything renders media: every poster and stream URL needs it.
    await refreshMediaToken();
    setMediaReady(true);
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    const id = setInterval(() => { refreshMediaToken(); }, MEDIA_TOKEN_REFRESH_MS);
    return () => clearInterval(id);
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    if (!getToken()) { setBooting(false); return undefined; }
    (async () => {
      try {
        const { user: me } = await api('/api/auth/me');
        if (!cancelled) await enter(me);
      } catch {
        setToken(null); // stale token: clear it and show the gate
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [enter]);

  /* ---- player ---- */
  const openPlayer = useCallback((asset, queue = []) => setPlayer({ asset, queue, key: Date.now() }), []);
  const closePlayer = useCallback(() => setPlayer(null), []);

  const value = useMemo(() => ({
    user, setUser, booting, mediaReady, enter, signOut,
    view, go,
    toast, toastMsg,
    versions, refresh,
    player, openPlayer, closePlayer,
    photoIntent, setPhotoIntent,
    paletteOpen, setPaletteOpen,
    theme, toggleTheme,
    uploads,
  }), [user, booting, mediaReady, enter, signOut, view, go, toast, toastMsg, versions, refresh,
    player, openPlayer, closePlayer, photoIntent, paletteOpen, theme, toggleTheme, uploads]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/* ------------------------------------------------------------------ *
 * Upload tray
 *
 * Every upload becomes a job, tracked from the first byte to "ready". The form
 * is handed back immediately, so a second upload can start while the first is
 * still going, and switching views does not hide the progress.
 *
 * phase: uploading -> processing -> ready | failed | cancelled
 * ------------------------------------------------------------------ */

let jobSeq = 0;
export const isActiveJob = (job) => job.phase === 'uploading' || job.phase === 'processing';

function useUploads({ signedIn, refresh }) {
  const [jobs, setJobs] = useState([]);
  const xhrs = useRef(new Map());

  const patch = useCallback((id, changes) => {
    setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...(typeof changes === 'function' ? changes(j) : changes) } : j)));
  }, []);

  const start = useCallback(async ({ kind, name, path, formData }) => {
    const id = ++jobSeq;
    setJobs((list) => [{ id, kind, name, phase: 'uploading', percent: 0, assets: [], error: null }, ...list]);

    // Progress fires many times a second; once per frame is plenty.
    let frame = 0;
    let latest = 0;
    const onProgress = (fraction) => {
      latest = fraction;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; patch(id, { percent: latest }); });
    };

    try {
      const data = await upload(path, formData, onProgress, (xhr) => xhrs.current.set(id, xhr));
      const assets = (data.assets || [data.asset]).map((a) => ({ id: a.id, status: a.status }));
      patch(id, { phase: 'processing', percent: 1, assets });
      refresh(kind === 'video' ? 'library' : 'photos', 'profile');
    } catch (err) {
      patch(id, { phase: err.message === 'Upload cancelled' ? 'cancelled' : 'failed', error: err.message });
    } finally {
      xhrs.current.delete(id);
    }
  }, [patch, refresh]);

  // One poll for every job still processing, asking about each unfinished
  // asset rather than reloading whole grids.
  const processing = jobs.filter((j) => j.phase === 'processing');
  const pendingKey = processing.map((j) => j.id).join(',');
  useEffect(() => {
    if (!pendingKey || !signedIn) return undefined;
    const timer = setTimeout(async () => {
      const updated = await Promise.all(processing.map(async (job) => {
        const assets = await Promise.all(job.assets.map((a) => (
          a.status === 'ready' || a.status === 'failed'
            ? a
            : api(`/api/assets/${a.id}`).then(({ asset }) => ({ ...a, status: asset.status }))
              .catch(() => ({ ...a, status: 'failed' }))
        )));
        const done = assets.every((a) => a.status === 'ready' || a.status === 'failed');
        if (!done) return { ...job, assets, tick: (job.tick || 0) + 1 };
        const ok = assets.some((a) => a.status === 'ready');
        return { ...job, assets, phase: ok ? 'ready' : 'failed', error: ok ? null : 'Processing failed' };
      }));

      const finished = new Set(updated.filter((j) => j.phase !== 'processing').map((j) => j.kind));
      if (finished.has('video')) refresh('library', 'catalog', 'profile');
      if (finished.has('photos')) refresh('photos', 'profile');

      const byId = new Map(updated.map((j) => [j.id, j]));
      setJobs((list) => list.map((j) => byId.get(j.id) || j));
    }, 2500);
    return () => clearTimeout(timer);
    // `tick` changes on every unfinished round, which re-arms the timer.
  },[pendingKey, signedIn, processing.map((j) => j.tick || 0).join(',')]);

  // Closing the tab mid-upload loses the file. Ask first.
  const uploading = jobs.some((j) => j.phase === 'uploading');
  useEffect(() => {
    if (!uploading) return undefined;
    const guard = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [uploading]);

  const cancel = useCallback((id) => xhrs.current.get(id)?.abort(), []);
  const dismiss = useCallback((id) => setJobs((list) => list.filter((j) => j.id !== id)), []);
  const clearFinished = useCallback(() => setJobs((list) => list.filter(isActiveJob)), []);
  const abortAll = useCallback(() => {
    xhrs.current.forEach((xhr) => xhr.abort());
    xhrs.current.clear();
    setJobs([]);
  }, []);

  return useMemo(() => ({ jobs, start, cancel, dismiss, clearFinished, abortAll }),
    [jobs, start, cancel, dismiss, clearFinished, abortAll]);
}
