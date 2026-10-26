import { useCallback, useEffect, useRef, useState } from 'react';
import { api, posterSrc } from '../lib/api.js';
import { formatDuration, formatSize, joinMeta, plural } from '../lib/format.js';
import { useSentinel } from '../lib/hooks.js';
import { useApp } from '../store.jsx';
import Icon from '../components/Icon.jsx';
import {
  EmptyState, PageHead, Rail, Sentinel, SkeletonGrid, TileGrid,
} from '../components/Media.jsx';

// A page size, not a ceiling: the API paginates and `hasMore` is honoured.
const PAGE_SIZE = 24;
const POLL_MS = 2500;

export default function Watch() {
  const { versions, go, openPlayer, mediaReady, refresh } = useApp();
  const [assets, setAssets] = useState(null);
  const [total, setTotal] = useState(0);
  const [cont, setCont] = useState([]);
  const [percentById, setPercentById] = useState(new Map());
  const [paging, setPaging] = useState({ page: 0, hasMore: false });
  const loading = useRef(false);

  const load = useCallback(async ({ append = false } = {}) => {
    if (loading.current) return;
    loading.current = true;
    const page = append ? paging.page + 1 : 1;
    try {
      // "Continue watching" and the hero describe the whole library, so they
      // are only rebuilt on a fresh load, not per page.
      const [library, progress] = await Promise.all([
        api(`/api/assets?limit=${PAGE_SIZE}&page=${page}`),
        append ? null : api('/api/progress/continue'),
      ]);
      if (progress) {
        setCont(progress.items);
        setPercentById(new Map(progress.items.map((i) => [String(i.asset.id), i.percent])));
      }
      setAssets((prev) => (append && prev ? [...prev, ...library.assets] : library.assets));
      setTotal(library.total);
      setPaging({ page, hasMore: library.hasMore });
    } finally {
      loading.current = false;
    }
  }, [paging.page]);

  useEffect(() => {
    if (mediaReady) load().catch(() => {});
    // Only a version bump or the media token arriving should reload.
  }, [versions.library, mediaReady]);

  // The worker runs out of band; the only way to learn an asset became
  // playable is to ask again. Stops as soon as nothing is in flight.
  const pending = assets?.some((a) => a.status === 'processing' || a.status === 'uploading');
  useEffect(() => {
    if (!pending) return undefined;
    const t = setTimeout(() => refresh('library', 'catalog'), POLL_MS);
    return () => clearTimeout(t);
  }, [pending, assets, refresh]);

  const sentinel = useSentinel(paging.hasMore, () => load({ append: true }).catch(() => {}));

  const featured = assets?.find((a) => a.status === 'ready');
  const featuredPct = featured && percentById.get(String(featured.id));
  const hasAny = assets && assets.length > 0;

  return (
    <>
      <PageHead kicker="Library" title="Watch"
                sub={assets == null ? '' : hasAny ? `${plural(total, 'video')} in your library` : 'Nothing here yet.'} />

      {assets == null && <div className="sk sk-hero" aria-hidden="true" />}

      {featured && (
        <article className="hero neu">
          <div className="hero-art">
            <img src={posterSrc(featured)} alt="" />
            <span className="hero-scan" aria-hidden="true" />
          </div>
          <div className="hero-body">
            <span className="pill">Latest upload</span>
            <h2>{featured.title}</h2>
            <p className="hero-meta">
              {joinMeta([
                formatDuration(featured.durationSec),
                featured.width && `${featured.width}×${featured.height}`,
                formatSize(featured.sizeBytes),
              ])}
            </p>
            {featuredPct ? (
              <div className="hero-progress">
                <div className="meter"><i style={{ width: `${featuredPct}%` }} /></div>
                <span className="hud">{featuredPct}% watched</span>
              </div>
            ) : null}
            <div className="hero-actions">
              <button className="btn btn-primary btn-lg" type="button" onClick={() => openPlayer(featured, assets)}>
                <Icon name="play" />
                {featuredPct ? `Resume · ${featuredPct}%` : 'Play now'}
              </button>
              <button className="btn btn-lg" type="button" onClick={() => go('upload')}>
                <Icon name="upload" /> Upload
              </button>
            </div>
          </div>
        </article>
      )}

      {cont.length > 0 && (
        <Rail title="Continue watching" kicker="Resume">
          <TileGrid assets={cont.map((i) => i.asset)}
                    percentById={new Map(cont.map((i) => [String(i.asset.id), i.percent]))} />
        </Rail>
      )}

      <Rail title="Your library" count={hasAny ? total : null}>
        {assets == null ? <SkeletonGrid count={8} /> : <TileGrid assets={assets} percentById={percentById} />}
        <Sentinel sentinelRef={sentinel} show={paging.hasMore} />
        {assets && !hasAny && (
          <EmptyState
            icon="watch"
            title="Your library is empty"
            actions={<>
              <button className="btn btn-primary" type="button" onClick={() => go('upload')}>Upload a video</button>
              <button className="btn" type="button" onClick={() => go('browse')}>Browse shared videos</button>
            </>}
            steps={[
              <><b>Upload</b> a video or a batch of photos</>,
              <><b>Watch</b> anywhere, and pick up where you left off</>,
              <><b>Share</b> to the catalog, or send a private link</>,
            ]}
          >
            Upload a video and it appears here as soon as it is processed. Everything you upload
            stays private until you share it.
          </EmptyState>
        )}
      </Rail>
    </>
  );
}
