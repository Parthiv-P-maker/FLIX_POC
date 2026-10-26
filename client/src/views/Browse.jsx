import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { plural } from '../lib/format.js';
import { useDebounced } from '../lib/hooks.js';
import { useApp } from '../store.jsx';
import Icon from '../components/Icon.jsx';
import { EmptyState, PageHead, Rail, SkeletonGrid, TileGrid } from '../components/Media.jsx';

export default function Browse() {
  const { versions, mediaReady, go } = useApp();
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 250);
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!mediaReady) return undefined;
    let stale = false;
    (async () => {
      // Search collapses the rails into one list; running the rail queries
      // as well would show the same video four times.
      if (q) {
        const found = await api(`/api/catalog?limit=60&q=${encodeURIComponent(q)}`);
        if (!stale) setData({ mode: 'search', q, found });
        return;
      }
      const [trending, fresh, others, summary] = await Promise.all([
        api('/api/catalog?sort=trending&limit=12'),
        api('/api/catalog?sort=new&limit=18'),
        api('/api/catalog?sort=new&limit=12&mine=exclude'),
        api('/api/catalog/summary'),
      ]);
      if (!stale) setData({ mode: 'rails', trending, fresh, others, summary });
    })().catch(() => {});
    return () => { stale = true; };
  }, [q, versions.catalog, mediaReady]);

  const summary = data?.mode === 'rails' ? data.summary : null;
  const sub = summary
    ? summary.total
      ? `${plural(summary.total, 'video')} shared by ${plural(summary.contributors, 'member')}` +
        (summary.mine ? ` · ${summary.mine} from you` : '')
      : 'Nothing has been shared yet.'
    : '';

  // Ranking by plays is noise until something has actually been played.
  const trending = data?.mode === 'rails' && data.trending.assets.some((a) => a.viewCount > 0)
    ? data.trending.assets : [];

  return (
    <>
      <PageHead kicker="Shared catalog" title="Browse" sub={sub}>
        <label className="searchbox">
          <Icon name="search" />
          <span className="sr-only">Search the catalog</span>
          <input type="search" placeholder="Search the catalog" autoComplete="off"
                 value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </PageHead>

      {data == null && <Rail title="New on FlixDrive"><SkeletonGrid count={6} /></Rail>}

      {data?.mode === 'search' && (
        <>
          <Rail title={`${data.found.total} result${data.found.total === 1 ? '' : 's'} for “${data.q}”`}>
            <TileGrid assets={data.found.assets} showOwner />
          </Rail>
          {data.found.total === 0 && (
            <EmptyState icon="search" title="Nothing matched">No shared video has that in its title.</EmptyState>
          )}
        </>
      )}

      {data?.mode === 'rails' && (
        <>
          {trending.length > 0 && (
            <Rail title="Trending now" kicker="Most played"><TileGrid assets={trending} showOwner /></Rail>
          )}
          {data.fresh.assets.length > 0 && (
            <Rail title="New on FlixDrive" kicker="Fresh"><TileGrid assets={data.fresh.assets} showOwner /></Rail>
          )}
          {data.others.assets.length > 0 && (
            <Rail title="From other members"><TileGrid assets={data.others.assets} showOwner /></Rail>
          )}
          {summary.total === 0 && (
            <EmptyState icon="browse" title="The catalog is empty"
                        actions={<button className="btn" type="button" onClick={() => go('watch')}>Go to your library</button>}>
              Videos are private until someone shares them. Share one of yours to get things started.
            </EmptyState>
          )}
        </>
      )}
    </>
  );
}
