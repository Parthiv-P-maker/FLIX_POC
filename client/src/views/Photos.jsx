import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, posterSrc } from '../lib/api.js';
import { plural } from '../lib/format.js';
import { useSentinel, useWidth } from '../lib/hooks.js';
import { useApp } from '../store.jsx';
import Icon from '../components/Icon.jsx';
import { EmptyState, PageHead, Sentinel, deleteAsset } from '../components/Media.jsx';
import { aspectOf, justify, mergeGroups } from '../photos/justify.js';
import Lightbox from '../photos/Lightbox.jsx';

const PAGE_SIZE = 60;
const TAG_CHIP_LIMIT = 12;
const SUGGEST_LIMIT = 6;
const SKELETON_ROWS = [[1.5, 1, 1.3, 0.8], [1, 1.5, 1.2], [0.9, 1.3, 1, 1.4]];
const EMPTY_FILTER = { q: '', favorite: false, year: null, tag: null };

export default function Photos() {
  const { versions, refresh, toast, go, mediaReady, photoIntent, setPhotoIntent } = useApp();

  // `tag` is an exact AI tag (chip or suggestion); `q` is free text the server
  // matches against titles, tags and visual similarity.
  const [filter, setFilter] = useState(() => ({
    ...EMPTY_FILTER,
    q: photoIntent?.q || '',
    favorite: Boolean(photoIntent?.favorite),
  }));
  const [text, setText] = useState(filter.q);
  const [data, setData] = useState(null);
  const [groups, setGroups] = useState([]);
  const [paging, setPaging] = useState({ page: 0, hasMore: false });
  const [favCount, setFavCount] = useState(0);
  const [lightbox, setLightbox] = useState(-1);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [lastSel, setLastSel] = useState(-1);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const openAfterLoad = useRef(photoIntent?.openId || null);
  const timeline = useRef(null);
  const width = useWidth(timeline);

  /* ---- palette hand-off ---- */
  useEffect(() => {
    if (!photoIntent) return;
    if (photoIntent.q !== undefined || photoIntent.favorite) {
      setFilter({ ...EMPTY_FILTER, q: photoIntent.q || '', favorite: Boolean(photoIntent.favorite) });
      setText(photoIntent.q || '');
    }
    openAfterLoad.current = photoIntent.openId || null;
    setPhotoIntent(null);
  }, [photoIntent, setPhotoIntent]);

  /* ---- loading ---- */
  const query = useCallback((page) => {
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(page) });
    if (filter.q) p.set('q', filter.q);
    if (filter.favorite) p.set('favorite', '1');
    if (filter.year) p.set('year', String(filter.year));
    if (filter.tag) p.set('tag', filter.tag);
    return p.toString();
  }, [filter]);

  // A newer request always wins: a search typed while one is in flight must
  // not let "anim" results land under "anime".
  const load = useCallback(async ({ append = false } = {}) => {
    const id = ++seq.current;
    const page = append ? paging.page + 1 : 1;
    const res = await api(`/api/photos?${query(page)}`);
    if (id !== seq.current) return;
    setGroups((prev) => (append ? mergeGroups(prev, res.groups) : res.groups));
    setPaging({ page, hasMore: res.hasMore });
    setFavCount(res.facets.favorites || 0);
    setData(res);
  }, [paging.page, query]);

  useEffect(() => {
    if (!mediaReady) return undefined;
    // Longer than a title filter would need: each query runs the text model.
    const t = setTimeout(() => load().catch((err) => toast(err.message)), filter.q ? 350 : 0);
    return () => clearTimeout(t);
  }, [filter, versions.photos, mediaReady, tick]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // Open a photo the palette asked for, once its page has landed.
  useEffect(() => {
    if (!openAfterLoad.current || !data) return;
    const i = flat.findIndex((p) => String(p.id) === String(openAfterLoad.current));
    openAfterLoad.current = null;
    if (i !== -1) setLightbox(i);
  }, [flat, data]);

  // Processing photos and outstanding AI tags both need asking again. Only
  // from page 1: a refetch would throw away pages someone scrolled through.
  const processing = flat.some((p) => p.status === 'processing' || p.status === 'uploading');
  const tagging = Boolean(data?.ai?.tagging);
  useEffect(() => {
    if ((!processing && !tagging) || paging.page !== 1 || lightbox !== -1) return undefined;
    const t = setTimeout(() => setTick((n) => n + 1), processing ? 2500 : 3000);
    return () => clearTimeout(t);
  }, [processing, tagging, paging.page, data, lightbox]);

  const sentinel = useSentinel(paging.hasMore, () => load({ append: true }).catch((err) => toast(err.message)));

  /* ---- filters ---- */
  const tags = data?.facets?.tags || [];
  const years = data?.facets?.years || [];
  const filtersActive = Boolean(filter.q || filter.favorite || filter.year || filter.tag);
  const labelOfTag = (key) => tags.find((t) => t.key === key)?.label || key;

  const filterByTag = (key, force = false) => {
    setFilter((f) => ({ ...f, q: '', tag: !force && f.tag === key ? null : key }));
    setText('');
    setSuggestOpen(false);
  };

  const shownTags = useMemo(() => {
    const shown = tags.slice(0, TAG_CHIP_LIMIT);
    const active = tags.find((t) => t.key === filter.tag);
    if (active && !shown.includes(active)) shown.push(active);
    return shown;
  }, [tags, filter.tag]);

  const suggestions = useMemo(() => {
    const needle = text.trim().toLowerCase();
    if (!needle) return [];
    return tags
      .filter((t) => t.label.toLowerCase().includes(needle) || t.key.includes(needle))
      .sort((a, b) => Number(b.label.toLowerCase().startsWith(needle)) - Number(a.label.toLowerCase().startsWith(needle)))
      .slice(0, SUGGEST_LIMIT);
  }, [text, tags]);
  const showSuggest = suggestOpen && suggestions.length > 0;

  const onSearchKey = (e) => {
    if (e.key === 'ArrowDown' && showSuggest) { e.preventDefault(); setSuggestIndex((i) => (i + 1) % suggestions.length); }
    else if (e.key === 'ArrowUp' && showSuggest) { e.preventDefault(); setSuggestIndex((i) => (i - 1 + suggestions.length) % suggestions.length); }
    else if (e.key === 'Escape' && showSuggest) { e.preventDefault(); setSuggestOpen(false); }
    else if (e.key === 'Enter') {
      if (showSuggest && suggestIndex >= 0) { e.preventDefault(); filterByTag(suggestions[suggestIndex].key, true); }
      else { setSuggestOpen(false); setFilter((f) => ({ ...f, q: text.trim(), tag: null })); }
    }
  };

  /* ---- favourites ---- */
  const toggleFavorite = async (photo) => {
    const next = !photo.favorite;
    try {
      await api(`/api/assets/${photo.id}`, { method: 'PATCH', body: { favorite: next } });
      if (filter.favorite) {
        // The photo just left the filtered set; refetch, which also renews counts.
        setTick((n) => n + 1);
      } else {
        setGroups((gs) => gs.map((g) => ({
          ...g, items: g.items.map((p) => (p.id === photo.id ? { ...p, favorite: next } : p)),
        })));
        setFavCount((c) => Math.max(0, c + (next ? 1 : -1)));
      }
      toast(next ? 'Added to favourites' : 'Removed from favourites');
    } catch (err) {
      toast(err.message);
    }
  };

  /* ---- selection ---- */
  const toggleSelected = (index, range) => {
    setSelecting(true);
    const id = String(flat[index].id);
    setSelected((prev) => {
      const next = new Set(prev);
      const on = !prev.has(id);
      if (range && lastSel !== -1) {
        const [from, to] = [Math.min(lastSel, index), Math.max(lastSel, index)];
        for (let i = from; i <= to; i += 1) {
          const pid = String(flat[i].id);
          if (on) next.add(pid); else next.delete(pid);
        }
      } else if (on) next.add(id); else next.delete(id);
      return next;
    });
    setLastSel(index);
  };

  const endSelecting = () => { setSelecting(false); setSelected(new Set()); setLastSel(-1); };

  useEffect(() => {
    if (!selecting) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && lightbox === -1) endSelecting(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selecting, lightbox]);

  const bulk = async (action) => {
    const ids = [...selected];
    if (!ids.length) return;
    if (action === 'delete' && !window.confirm(`Delete ${plural(ids.length, 'photo')}? This removes the files from disk.`)) return;
    try {
      const { count } = await api('/api/photos/bulk', { method: 'POST', body: { ids, action } });
      const verb = { favorite: 'Added to favourites', unfavorite: 'Removed from favourites', delete: 'Deleted' }[action];
      toast(`${verb}: ${plural(count, 'photo')}`);
      endSelecting();
      refresh('photos', ...(action === 'delete' ? ['profile'] : []));
    } catch (err) {
      toast(err.message);
    }
  };

  /* ---- render ---- */
  const libraryEmpty = data && data.total === 0 && !filtersActive;
  const noMatch = data && data.total === 0 && filtersActive;
  const sub = !data ? '' : data.total
    ? `${plural(data.total, 'photo')} across ${plural(groups.length, 'month')}${filtersActive ? ' · filtered' : ''}`
    : libraryEmpty ? 'Nothing here yet.' : 'No matches.';

  let hint = null;
  if (filter.tag) hint = <>Showing photos tagged <strong>{labelOfTag(filter.tag)}</strong>.</>;
  else if (data?.search?.mode === 'smart') {
    const parts = ['matching titles'];
    if (data.search.tags.length) parts.push(`photos tagged ${data.search.tags.map((t) => t.label).join(' + ')}`);
    parts.push('photos that look like it');
    hint = <>Smart search for <strong>“{data.search.q}”</strong>: {parts.join(', ')}.</>;
  } else if (data?.search && data?.ai?.enabled) {
    hint = 'Searching titles and tags only while the image model loads.';
  }

  const indexOf = new Map(flat.map((p, i) => [p.id, i]));

  return (
    <>
      <PageHead kicker="Timeline" title="Photos" sub={sub}>
        <div className="searchbox searchbox-smart">
          <Icon name={data?.ai?.enabled ? 'sparkle' : 'search'} />
          <input type="search" autoComplete="off" placeholder="Search what's in your photos"
                 aria-label="Search photos by title or by what they show"
                 role="combobox" aria-autocomplete="list" aria-expanded={showSuggest} aria-controls="photo-suggest"
                 aria-activedescendant={showSuggest && suggestIndex >= 0 ? `suggest-${suggestIndex}` : undefined}
                 value={text}
                 onChange={(e) => {
                   setText(e.target.value);
                   setSuggestOpen(true);
                   setSuggestIndex(-1);
                   // Typing starts a new search; a picked tag would silently narrow it.
                   setFilter((f) => ({ ...f, q: e.target.value.trim(), tag: null }));
                 }}
                 onKeyDown={onSearchKey}
                 onBlur={() => setSuggestOpen(false)} />
          {data?.ai?.enabled && <span className="ai-badge" title="Photos are tagged by an on-device image model">AI</span>}
          {showSuggest && (
            <ul className="suggest neu" id="photo-suggest" role="listbox" aria-label="Tag suggestions">
              {suggestions.map((tag, i) => (
                <li key={tag.key} id={`suggest-${i}`} role="option" aria-selected={i === suggestIndex}
                    onMouseDown={(e) => { e.preventDefault(); filterByTag(tag.key, true); }}>
                  <span className="sg-kind">Tag</span>
                  <span className="sg-label">{tag.label}</span>
                  <span className="sg-count">{plural(tag.count, 'photo')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className={`btn${selecting ? ' is-on' : ''}`} type="button" aria-pressed={selecting}
                onClick={() => (selecting ? endSelecting() : setSelecting(true))}>
          <Icon name="checkCircle" />{selecting ? 'Done' : 'Select'}
        </button>
      </PageHead>

      {selecting && (
        <div className="selbar neu" role="toolbar" aria-label="Selected photos">
          <button className="icon-btn" type="button" onClick={endSelecting} aria-label="Cancel selection"><Icon name="close" /></button>
          <strong aria-live="polite">{selected.size ? `${selected.size} selected` : 'Select photos'}</strong>
          <span className="selbar-hint">Shift-click to select a range</span>
          <span className="pc-spacer" />
          <button className="btn btn-sm" type="button" onClick={() => setSelected(
            selected.size === flat.length ? new Set() : new Set(flat.map((p) => String(p.id))),
          )}>
            {selected.size && selected.size === flat.length ? 'Select none' : 'Select all'}
          </button>
          <button className="btn btn-sm" type="button" disabled={!selected.size} onClick={() => bulk('favorite')}>Favourite</button>
          <button className="btn btn-sm" type="button" disabled={!selected.size} onClick={() => bulk('unfavorite')}>Unfavourite</button>
          <button className="btn btn-sm btn-danger" type="button" disabled={!selected.size} onClick={() => bulk('delete')}>Delete</button>
        </div>
      )}

      {hint && <p className="search-hint"><Icon name="sparkle" /> <span>{hint}</span></p>}

      <div className="filterbar">
        <button type="button" className={`chip${!filter.favorite ? ' is-active' : ''}`}
                onClick={() => setFilter((f) => ({ ...f, favorite: false }))}>All</button>
        <button type="button" className={`chip chip-star${filter.favorite ? ' is-active' : ''}`}
                onClick={() => setFilter((f) => ({ ...f, favorite: true }))}>
          <Icon name="heart" /><span>Favourites</span>
          {favCount > 0 && <em className="chip-count">{favCount}</em>}
        </button>
        {years.length > 1 && <span className="filter-sep" />}
        {years.length > 1 && years.map(({ year, count }) => (
          <button key={year} type="button" className={`chip${filter.year === year ? ' is-active' : ''}`}
                  onClick={() => setFilter((f) => ({ ...f, year: f.year === year ? null : year }))}>
            <span>{year}</span><em className="chip-count">{count}</em>
          </button>
        ))}
      </div>

      {shownTags.length > 0 && (
        <div className="filterbar tagbar" aria-label="Filter by tag">
          <span className="hud">AI tags</span>
          {shownTags.map((tag) => (
            <button key={tag.key} type="button" aria-pressed={filter.tag === tag.key}
                    className={`chip chip-tag${filter.tag === tag.key ? ' is-active' : ''}`}
                    onClick={() => filterByTag(tag.key)}>
              <span>{tag.label}</span><em className="chip-count">{tag.count}</em>
            </button>
          ))}
        </div>
      )}

      <div className={`timeline${selecting ? ' is-selecting' : ''}`} ref={timeline} aria-busy={!data}>
        {!data && (
          <>
            <span className="sk sk-month" />
            {SKELETON_ROWS.map((row, i) => (
              <div className="sk-photo-row" aria-hidden="true" key={i}>
                {row.map((grow, j) => <span className="sk" style={{ flex: grow }} key={j} />)}
              </div>
            ))}
          </>
        )}

        {width > 0 && groups.map((group) => (
          <section className="month" key={group.key}>
            <div className="month-head">
              <h2>{group.label}</h2>
              <span className="month-line" aria-hidden="true" />
              <span className="hud">{plural(group.items.length, 'photo')}</span>
            </div>
            {justify(group.items, width).map((row, r) => (
              <div className="photo-row" key={r} style={{ gap: `${row.gap}px`, marginBottom: `${row.gap}px` }}>
                {row.items.map((photo) => {
                  const index = indexOf.get(photo.id);
                  const isSel = selected.has(String(photo.id));
                  return (
                    <Fragment key={photo.id}>
                      <div className={`photo-cell${isSel ? ' is-selected' : ''}`}
                           style={{ height: `${row.height}px`, width: `${row.height * aspectOf(photo)}px` }}>
                        {photo.posterUrl
                          ? <img src={posterSrc(photo)} alt="" loading="lazy" />
                          : <span className="placeholder">{photo.status === 'failed' ? 'Failed' : <span className="spinner" />}</span>}
                        <button type="button" className="cell-open" aria-label={`Open ${photo.title}`}
                                disabled={!selecting && photo.status !== 'ready'}
                                onClick={(e) => {
                                  if (selecting) toggleSelected(index, e.shiftKey);
                                  else if (photo.status === 'ready') setLightbox(index);
                                }} />
                        <button type="button" className={`cell-star${photo.favorite ? ' is-on' : ''}`}
                                aria-pressed={Boolean(photo.favorite)}
                                aria-label={`${photo.favorite ? 'Remove' : 'Add'} ${photo.title} ${photo.favorite ? 'from' : 'to'} favourites`}
                                onClick={(e) => { e.stopPropagation(); toggleFavorite(photo); }}>
                          <Icon name="heart" />
                        </button>
                        {photo.isOwner && (
                          <button type="button" className="cell-trash" aria-label={`Delete ${photo.title}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    deleteAsset(photo, { toast, onDone: () => refresh('photos', 'profile') });
                                  }}>
                            <Icon name="trash" />
                          </button>
                        )}
                        <button type="button" className="cell-check" aria-pressed={isSel}
                                aria-label={`Select ${photo.title}`}
                                onClick={(e) => { e.stopPropagation(); toggleSelected(index, e.shiftKey); }}>
                          <Icon name="check" />
                        </button>
                      </div>
                    </Fragment>
                  );
                })}
              </div>
            ))}
          </section>
        ))}
      </div>

      <Sentinel sentinelRef={sentinel} show={paging.hasMore} />

      {noMatch && (
        <EmptyState icon="search" title="No photos match"
                    actions={<button className="btn" type="button" onClick={() => { setFilter(EMPTY_FILTER); setText(''); }}>Clear filters</button>}>
          Try a different search, or clear the filters.
        </EmptyState>
      )}
      {libraryEmpty && (
        <EmptyState icon="photos" title="Your timeline is empty"
                    actions={<button className="btn btn-primary" type="button" onClick={() => go('upload')}>Add photos</button>}>
          Photos are grouped by the date they were taken, and tagged automatically so you can
          search them by what they show.
        </EmptyState>
      )}

      {lightbox !== -1 && flat[lightbox] && (
        <Lightbox
          photos={flat}
          index={lightbox}
          onIndex={setLightbox}
          onClose={() => setLightbox(-1)}
          onFavorite={(photo) => {
            // With the favourites filter on, un-starring drops this photo
            // from the set - close so the index is not left stale.
            if (filter.favorite && photo.favorite) setLightbox(-1);
            toggleFavorite(photo);
          }}
          onTag={(key) => { setLightbox(-1); filterByTag(key, true); }}
          onChanged={() => setTick((n) => n + 1)}
        />
      )}
    </>
  );
}
