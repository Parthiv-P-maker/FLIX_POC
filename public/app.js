'use strict';

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = 'flixdrive.token';

let token = localStorage.getItem(TOKEN_KEY);
let currentUser = null;
let pollTimer = null;

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

/**
 * Every non-stream endpoint is header-authenticated. A 401 anywhere means
 * the token is gone or expired, so we drop it and fall back to the gate
 * rather than letting the UI retry against a dead session.
 */
async function api(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && currentUser) {
    signOut();
    throw new Error('Session expired, please sign in again');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// <video src> and <img src> cannot carry an Authorization header, so the
// stream and poster routes take the token in the query string instead.
const withToken = (url) => `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

// Posters are authorised now, not static, so every <img src> needs the token.
// Null-safe because an asset still being processed has no poster yet.
const posterSrc = (asset) => (asset.posterUrl ? withToken(asset.posterUrl) : '');

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function formatDuration(sec) {
  if (!sec && sec !== 0) return '';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatSize(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

// "3h 24m" reads better than "204 minutes" on a stat tile.
function formatSpan(sec) {
  const total = Math.round(sec || 0);
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] || '').join('') || '?';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

let authMode = 'login';

$('#auth-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.seg');
  if (!tab) return;
  authMode = tab.dataset.mode;

  document.querySelectorAll('#auth-tabs .seg')
    .forEach((t) => t.classList.toggle('is-active', t === tab));

  const isRegister = authMode === 'register';
  const form = $('#auth-form');
  $('#name-field').hidden = !isRegister;
  form.displayName.required = isRegister;
  form.password.autocomplete = isRegister ? 'new-password' : 'current-password';
  form.querySelector('.btn-label').textContent = isRegister ? 'Create account' : 'Sign in';
  $('#auth-error').textContent = '';
});

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('button[type="submit"]');
  const payload = { email: form.email.value.trim(), password: form.password.value };
  if (authMode === 'register') payload.displayName = form.displayName.value.trim();

  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const data = await api(`/api/auth/${authMode}`, { method: 'POST', body: payload });
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    form.reset();
    await enterApp(data.user);
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

function signOut() {
  token = null;
  currentUser = null;
  clearTimeout(pollTimer);
  localStorage.removeItem(TOKEN_KEY);
  closePlayer();
  closeLightbox();
  $('#app').hidden = true;
  $('#auth-screen').hidden = false;
}

$('#signout-btn').addEventListener('click', signOut);

function paintIdentity(user) {
  currentUser = user;
  $('#chip-name').textContent = user.displayName;
  $('#chip-email').textContent = user.email;
  $('#chip-avatar').textContent = initialsOf(user.displayName);
  $('#profile-name').textContent = user.displayName;
  $('#profile-email').textContent = user.email;
  $('#profile-avatar').textContent = initialsOf(user.displayName);
  $('#profile-joined').textContent =
    `Member since ${new Date(user.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`;
  $('#name-form').displayName.value = user.displayName;
}

async function enterApp(user) {
  paintIdentity(user);
  $('#auth-screen').hidden = true;
  $('#app').hidden = false;
  showView('watch');
  await Promise.all([loadLibrary(), loadCatalog(), loadPhotos(), loadProfile()]);
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

function showView(name) {
  document.querySelectorAll('.nav-btn')
    .forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
  document.querySelectorAll('.view')
    .forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
  window.scrollTo({ top: 0 });

  // The timeline is measured against its container, and a hidden view is
  // zero-wide - so photos loaded while another tab was open never got laid
  // out. This is the moment the container first has a width.
  if (name === 'photos' && photoGroups.length) renderTimeline();
}

$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  if (btn) showView(btn.dataset.view);
});
$('#user-chip').addEventListener('click', () => showView('profile'));

// Buttons inside empty states that jump elsewhere.
document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) showView(goto.dataset.goto);
});

/* ------------------------------------------------------------------ *
 * Library
 * ------------------------------------------------------------------ */

const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.8 19 12 7 19.2z"/></svg>';
const GLOBE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 2c1.4 0 3 2.4 3.4 6H8.6C9 6.4 10.6 4 12 4M6.6 10C7 6.9 8 4.8 8.9 4.3A8 8 0 0 0 4.3 10zm-.2 2H4.1a8 8 0 0 0 4.8 7.7C7.9 18.9 6.8 16 6.4 12m2 0h7.2c-.4 3.8-2 6-3.6 6s-3.2-2.2-3.6-6m9.2 0h2.3a8 8 0 0 1-4.8 7.7c1-1.2 2.1-4 2.5-7.7m0-2c-.4-3.7-1.5-6.5-2.5-7.7a8 8 0 0 1 4.8 7.7z"/></svg>';

const plays = (n) => `${n} ${n === 1 ? 'play' : 'plays'}`;

/**
 * One tile shape for both the private library and the shared catalog.
 *
 * `showOwner` is what separates them: in Browse the uploader's name is the
 * point, in your own library it would just repeat your own name on every row.
 */
function videoTile(asset, progressPercent, { showOwner = false } = {}) {
  const tile = document.createElement('button');
  tile.className = 'tile';
  tile.type = 'button';

  const ready = asset.status === 'ready';
  // A file still being probed has no poster and no playable bytes yet.
  if (!ready) tile.disabled = true;

  const badge = ready
    ? ''
    : `<span class="badge is-${asset.status}">${asset.status === 'failed' ? 'Failed' : 'Processing'}</span>`;
  // Only meaningful on your own tiles - in the catalog every row is shared.
  const shareFlag = !showOwner && asset.shared
    ? `<span class="badge badge-share">${GLOBE_SVG}Shared</span>`
    : '';
  const poster = asset.posterUrl
    ? `<img src="${posterSrc(asset)}" alt="" loading="lazy" />`
    : '<span class="placeholder">No preview</span>';
  const duration = asset.durationSec
    ? `<span class="duration">${formatDuration(asset.durationSec)}</span>`
    : '';
  const bar = progressPercent
    ? `<span class="progress-bar"><i style="width:${Math.min(progressPercent, 100)}%"></i></span>`
    : '';
  const play = ready ? `<span class="play-badge">${PLAY_SVG}</span>` : '';

  const sub = showOwner
    ? [asset.viewCount ? plays(asset.viewCount) : null, formatDuration(asset.durationSec)]
        .filter(Boolean).join(' · ')
    : formatSize(asset.sizeBytes) + (asset.processingError ? ' · ' + asset.processingError : '');

  tile.innerHTML = `
    <div class="thumb">${poster}${play}${badge || shareFlag}${duration}${bar}</div>
    <div class="tile-body">
      <div class="tile-title"></div>
      ${showOwner ? '<div class="tile-owner"></div>' : ''}
      <div class="tile-sub"></div>
    </div>`;
  // Titles and display names are user-supplied - assign as text, never HTML.
  tile.querySelector('.tile-title').textContent = asset.title;
  tile.querySelector('.tile-sub').textContent = sub;
  if (showOwner) {
    tile.querySelector('.tile-owner').textContent =
      asset.isOwner ? 'You' : asset.ownerName || 'Unknown member';
  }

  if (ready) tile.addEventListener('click', () => openPlayer(asset));
  return tile;
}

function paintHero(assets, percentById) {
  const hero = $('#hero');
  const featured = assets.find((a) => a.status === 'ready');
  if (!featured) { hero.hidden = true; return; }

  const percent = percentById.get(String(featured.id));
  $('#hero-poster').src = posterSrc(featured);
  $('#hero-title').textContent = featured.title;
  $('#hero-meta').textContent = [
    formatDuration(featured.durationSec),
    featured.width && `${featured.width}×${featured.height}`,
    formatSize(featured.sizeBytes),
  ].filter(Boolean).join('  ·  ');
  $('#hero-play-label').textContent = percent ? `Resume · ${percent}%` : 'Play';
  $('#hero-play').onclick = () => openPlayer(featured);
  hero.hidden = false;
}

async function loadLibrary() {
  const [library, cont] = await Promise.all([
    api('/api/assets?limit=100'),
    api('/api/progress/continue'),
  ]);

  const percentById = new Map(cont.items.map((i) => [String(i.asset.id), i.percent]));

  const grid = $('#library-grid');
  grid.replaceChildren();
  library.assets.forEach((a) => grid.appendChild(videoTile(a, percentById.get(String(a.id)))));

  const hasAny = library.assets.length > 0;
  $('#library-empty').hidden = hasAny;
  $('#watch-sub').textContent = hasAny
    ? `${plural(library.total, 'video')} in your library`
    : 'Nothing here yet.';

  paintHero(library.assets, percentById);

  const continueGrid = $('#continue-grid');
  continueGrid.replaceChildren();
  cont.items.forEach((i) => continueGrid.appendChild(videoTile(i.asset, i.percent)));
  $('#continue-row').hidden = cont.items.length === 0;

  schedulePollIfProcessing(library.assets);
}

/**
 * The worker runs out of band, so the only way the client learns an asset
 * became playable is to ask again. Polling stops as soon as nothing is left
 * in flight rather than running on a permanent interval.
 */
function schedulePollIfProcessing(assets) {
  clearTimeout(pollTimer);
  const pending = assets.some((a) => a.status === 'processing' || a.status === 'uploading');
  if (!pending || !currentUser) return;
  pollTimer = setTimeout(() => {
    // Catalog too: a shared upload only reaches Browse once it is 'ready'.
    Promise.all([loadLibrary(), loadCatalog(), loadPhotos()]).catch(() => {});
  }, 2500);
}

/* ------------------------------------------------------------------ *
 * Browse - the shared catalog
 * ------------------------------------------------------------------ */

/** Fills a rail and hides it when the query came back empty. */
function paintRail(rowSel, gridSel, assets) {
  const grid = $(gridSel);
  grid.replaceChildren();
  assets.forEach((a) => grid.appendChild(videoTile(a, null, { showOwner: true })));
  $(rowSel).hidden = assets.length === 0;
}

async function loadCatalog() {
  const q = $('#catalog-search').value.trim();

  // Search collapses the three rails into one result list. Running the rail
  // queries as well would show the same video four times.
  if (q) {
    const found = await api(`/api/catalog?limit=60&q=${encodeURIComponent(q)}`);
    ['#trending-row', '#fresh-row', '#others-row'].forEach((s) => { $(s).hidden = true; });
    paintRail('#results-row', '#results-grid', found.assets);
    $('#results-title').textContent = `${found.total} result${found.total === 1 ? '' : 's'} for “${q}”`;
    $('#results-row').hidden = false;
    $('#browse-empty').hidden = found.total > 0;
    $('#browse-empty-title').textContent = 'Nothing matched';
    $('#browse-empty-body').textContent = 'No shared video has that in its title.';
    return;
  }

  $('#results-row').hidden = true;

  const [trending, fresh, others, summary] = await Promise.all([
    api('/api/catalog?sort=trending&limit=12'),
    api('/api/catalog?sort=new&limit=18'),
    api('/api/catalog?sort=new&limit=12&mine=exclude'),
    api('/api/catalog/summary'),
  ]);

  // Ranking by plays is noise until something has actually been played.
  const hasPlays = trending.assets.some((a) => a.viewCount > 0);
  paintRail('#trending-row', '#trending-grid', hasPlays ? trending.assets : []);
  paintRail('#fresh-row', '#fresh-grid', fresh.assets);
  paintRail('#others-row', '#others-grid', others.assets);

  $('#browse-empty').hidden = summary.total > 0;
  $('#browse-empty-title').textContent = 'The catalog is empty';
  $('#browse-empty-body').textContent =
    'Videos are private until someone shares them. Share one of yours to get things started.';

  $('#browse-sub').textContent = summary.total
    ? `${plural(summary.total, 'video')} shared by ${plural(summary.contributors, 'member')}` +
      (summary.mine ? ` · ${summary.mine} from you` : '')
    : 'Nothing has been shared yet.';
}

// Debounced so typing does not fire a request per keystroke.
let catalogSearchTimer = null;
$('#catalog-search').addEventListener('input', () => {
  clearTimeout(catalogSearchTimer);
  catalogSearchTimer = setTimeout(() => loadCatalog().catch(() => {}), 250);
});

/* ------------------------------------------------------------------ *
 * Player
 * ------------------------------------------------------------------ */

const video = $('#player');
let playingAsset = null;
let lastSentAt = 0;

// Opening a video is asynchronous - it waits on the resume point before it can
// start. These two make that interruptible: `playerSession` identifies the
// current open so a superseded one can bail, and the controller detaches any
// listener that open attached to the shared <video> element.
let playerSession = 0;
let playerAbort = null;

/** Reflects share state on the player's toggle. Owner-only; hidden otherwise. */
function paintShareButton(asset) {
  const btn = $('#player-share');
  btn.hidden = !asset.isOwner;
  $('#player-delete').hidden = !asset.isOwner;
  if (!asset.isOwner) return;

  btn.querySelector('.btn-label').textContent = asset.shared ? 'Shared · make private' : 'Share to catalog';
  btn.classList.toggle('is-on', Boolean(asset.shared));
}

async function openPlayer(asset) {
  // Every open supersedes the one before it. There is a single <video>
  // element, so without this an open that is still fetching its resume point
  // can come back after the user has clicked a different video and seek *that*
  // one to the first video's position.
  const session = ++playerSession;
  if (playerAbort) playerAbort.abort();
  playerAbort = new AbortController();
  const { signal } = playerAbort;

  playingAsset = asset;
  lastSentAt = 0;

  $('#player-title').textContent = asset.title;
  $('#player-meta').textContent = [
    // Someone else's upload: say whose. Your own already sits in your library.
    !asset.isOwner && asset.ownerName ? `Shared by ${asset.ownerName}` : null,
    asset.width && `${asset.width}×${asset.height}`,
    formatDuration(asset.durationSec),
    asset.viewCount ? plays(asset.viewCount) : null,
  ].filter(Boolean).join('  ·  ');

  paintShareButton(asset);

  // Show the overlay straight away so the click feels immediate; the source is
  // attached below, once we know where to start from.
  $('#player-overlay').hidden = false;

  // One bump per open, not per range request - see the route comment.
  api(`/api/assets/${asset.id}/view`, { method: 'POST' }).catch(() => {});

  // Resume where we left off, but not if the viewer was essentially at the
  // start or right at the end - both would feel broken.
  let resumeAt = 0;
  try {
    const p = await api(`/api/progress/${asset.id}`);
    if (!p.completed && p.positionSec > 5) resumeAt = p.positionSec;
  } catch { /* a missing progress row is not an error */ }

  // The user closed this, or opened something else, while we were waiting.
  if (session !== playerSession) return;

  // Both of these must happen after the await and in this order. The element
  // preloads metadata, so assigning src first - as this used to - lets
  // loadedmetadata fire while the progress request is still in flight, and a
  // listener attached afterwards never runs: no resume, and no autoplay.
  video.addEventListener(
    'loadedmetadata',
    () => {
      if (resumeAt > 0 && resumeAt < video.duration - 10) video.currentTime = resumeAt;
      video.play().catch(() => {});
    },
    { once: true, signal }
  );

  video.src = withToken(asset.streamUrl);
}

function closePlayer() {
  // Invalidate any open still waiting on its resume point, and drop the
  // loadedmetadata listener so it cannot fire against the next video.
  playerSession += 1;
  if (playerAbort) {
    playerAbort.abort();
    playerAbort = null;
  }

  if (playingAsset && video.currentTime > 0) sendProgress(true);
  video.pause();
  video.removeAttribute('src');
  video.load();
  playingAsset = null;
  $('#player-overlay').hidden = true;
}

function sendProgress(keepalive = false) {
  if (!playingAsset || !token) return;
  const positionSec = Math.floor(video.currentTime);
  if (!Number.isFinite(positionSec) || positionSec <= 0) return;

  // keepalive lets the last write survive the page being torn down; a normal
  // fetch would be cancelled on unload.
  fetch(`/api/progress/${playingAsset.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ positionSec }),
    keepalive,
  }).catch(() => {});
}

// timeupdate fires ~4x a second; throttling to 10s is what the API expects.
video.addEventListener('timeupdate', () => {
  if (!playingAsset || video.paused) return;
  const now = Date.now();
  if (now - lastSentAt < 10000) return;
  lastSentAt = now;
  sendProgress();
});

video.addEventListener('pause', () => sendProgress());
video.addEventListener('ended', () => sendProgress());
window.addEventListener('beforeunload', () => sendProgress(true));

$('#player-close').addEventListener('click', () => {
  closePlayer();
  loadLibrary().catch(() => {});
  loadCatalog().catch(() => {});
  loadProfile().catch(() => {});
});

$('#player-share').addEventListener('click', async () => {
  if (!playingAsset) return;
  const next = !playingAsset.shared;
  if (next && !confirm(`Share "${playingAsset.title}" to the catalog? Everyone with an account will be able to watch it.`)) return;

  try {
    const { asset } = await api(`/api/assets/${playingAsset.id}`, {
      method: 'PATCH',
      body: { shared: next },
    });
    // Keep the in-memory copy in step so a second click toggles back.
    playingAsset = { ...playingAsset, ...asset };
    paintShareButton(playingAsset);
    toast(next ? 'Shared to the catalog' : 'Made private again');
    loadLibrary().catch(() => {});
    loadCatalog().catch(() => {});
    loadProfile().catch(() => {});
  } catch (err) {
    toast(err.message);
  }
});

$('#player-delete').addEventListener('click', async () => {
  if (!playingAsset) return;
  if (!confirm(`Delete "${playingAsset.title}"? This removes the file from disk.`)) return;
  const id = playingAsset.id;
  playingAsset = null;           // stop the pause handler writing progress for a dead row
  closePlayer();
  await api(`/api/assets/${id}`, { method: 'DELETE' });
  toast('Video deleted');
  loadLibrary();
  loadProfile();
});

/* ------------------------------------------------------------------ *
 * Photo timeline
 * ------------------------------------------------------------------ */

// Flat, in display order, so the lightbox arrows can walk across month
// boundaries instead of stopping at the end of a group.
let flatPhotos = [];
let photoIndex = -1;

// The last response, kept so a window resize can re-run the justified layout
// without re-fetching. Layout is pure geometry; the data has not changed.
let photoGroups = [];

const photoFilter = { q: '', favorite: false, year: null };

/* ---- justified layout ---------------------------------------------- */

// Photos still being processed have no dimensions yet. 3:2 is the commonest
// camera ratio, so an un-probed cell lands close and does not jump far.
const FALLBACK_ASPECT = 1.5;

const aspectOf = (p) => (p.width && p.height ? p.width / p.height : FALLBACK_ASPECT);

/**
 * Row geometry, derived from the container rather than fixed.
 *
 * A 200px target row on a phone yields two photos per row and enormous cells,
 * so the target shrinks with the viewport. The gap is returned alongside it
 * because the solver must subtract exactly the value the DOM will render.
 */
function rowMetrics(containerWidth) {
  if (containerWidth < 520) return { target: 120, gap: 5 };
  if (containerWidth < 900) return { target: 160, gap: 6 };
  return { target: 200, gap: 8 };
}

/**
 * Greedy justified rows, the same shape Flickr and Google Photos use.
 *
 * Photos are packed at a nominal height until they overflow the container,
 * then the row's height is solved backwards so the row fills the width
 * exactly. Every photo keeps its own aspect ratio - which is the entire point
 * of replacing the old fixed-square grid.
 */
function justify(photos, containerWidth) {
  const { target, gap } = rowMetrics(containerWidth);
  const rows = [];
  let row = [];
  let aspectSum = 0;

  for (const photo of photos) {
    row.push(photo);
    aspectSum += aspectOf(photo);

    const gaps = gap * (row.length - 1);
    // Would this row, at the target height, now overflow the container?
    if (aspectSum * target + gaps >= containerWidth) {
      rows.push({ items: row, height: (containerWidth - gaps) / aspectSum, gap });
      row = [];
      aspectSum = 0;
    }
  }

  // The trailing row is left at the target height rather than stretched: a
  // single leftover photo blown up to full width looks like a bug.
  if (row.length) rows.push({ items: row, height: target, gap });

  return rows;
}

const HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3 4.3 12.9a4.7 4.7 0 0 1 6.6-6.7l1.1 1 1.1-1a4.7 4.7 0 1 1 6.6 6.7z"/></svg>';

function photoCell(photo, index, height) {
  const cell = document.createElement('button');
  cell.className = 'photo-cell';
  cell.type = 'button';
  cell.style.height = `${height}px`;
  cell.style.width = `${height * aspectOf(photo)}px`;

  cell.innerHTML = photo.posterUrl
    ? `<img src="${posterSrc(photo)}" alt="" loading="lazy" />`
    : `<span class="placeholder">${photo.status === 'failed' ? 'Failed' : '…'}</span>`;

  const star = document.createElement('span');
  star.className = `cell-star${photo.favorite ? ' is-on' : ''}`;
  star.innerHTML = HEART_SVG;
  star.title = photo.favorite ? 'Remove from favourites' : 'Add to favourites';
  // A click on the heart must not also open the lightbox.
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(photo);
  });
  cell.appendChild(star);

  if (photo.status === 'ready') cell.addEventListener('click', () => showPhoto(index));
  return cell;
}

/**
 * Renders photoGroups into the timeline at the current container width.
 *
 * `recheck` guards a genuine chicken-and-egg problem: laying out a tall
 * timeline is what makes the page scroll, and the scrollbar that appears then
 * narrows the very container the rows were solved against - so every row
 * overflows by exactly the scrollbar width. After building the DOM we
 * re-measure, and lay out once more if the width moved. One correction only;
 * the second pass cannot change the scrollbar again.
 */
function renderTimeline(recheck = true) {
  const wrap = $('#timeline');
  const width = wrap.clientWidth;
  if (width === 0) return;   // the view is hidden; nothing to measure against

  lastLayoutWidth = width;
  wrap.replaceChildren();
  flatPhotos = [];

  for (const group of photoGroups) {
    const section = document.createElement('section');
    section.className = 'month';

    const head = document.createElement('div');
    head.className = 'month-head';
    head.innerHTML = `<h2></h2><span class="month-count">${plural(group.items.length, 'photo')}</span>`;
    head.querySelector('h2').textContent = group.label;
    section.appendChild(head);

    // Index into flatPhotos before laying out, so lightbox arrows walk the
    // whole timeline in display order regardless of row boundaries.
    const indexOf = new Map();
    for (const photo of group.items) indexOf.set(photo, flatPhotos.push(photo) - 1);

    for (const { items, height, gap } of justify(group.items, width)) {
      const rowEl = document.createElement('div');
      rowEl.className = 'photo-row';
      // Both the flex gap and the margin below the row come from the same
      // number the solver subtracted, so the row fills the width exactly.
      rowEl.style.gap = `${gap}px`;
      rowEl.style.setProperty('--row-gap', `${gap}px`);
      items.forEach((photo) => rowEl.appendChild(photoCell(photo, indexOf.get(photo), height)));
      section.appendChild(rowEl);
    }

    wrap.appendChild(section);
  }

  if (recheck && wrap.clientWidth !== width) renderTimeline(false);
}

/* ---- filters -------------------------------------------------------- */

function paintYearChips(years) {
  const wrap = $('#year-chips');
  wrap.replaceChildren();
  $('#year-sep').hidden = years.length < 2;
  if (years.length < 2) return;   // a single year is not a choice

  for (const { year, count } of years) {
    const chip = document.createElement('button');
    chip.className = `chip${photoFilter.year === year ? ' is-active' : ''}`;
    chip.dataset.year = year;
    chip.innerHTML = `<span></span><em class="chip-count">${count}</em>`;
    chip.querySelector('span').textContent = year;
    wrap.appendChild(chip);
  }
}

function photoQueryString() {
  const params = new URLSearchParams({ limit: '500' });
  if (photoFilter.q) params.set('q', photoFilter.q);
  if (photoFilter.favorite) params.set('favorite', '1');
  if (photoFilter.year) params.set('year', String(photoFilter.year));
  return params.toString();
}

const filtersActive = () =>
  Boolean(photoFilter.q || photoFilter.favorite || photoFilter.year);

async function loadPhotos() {
  const data = await api(`/api/photos?${photoQueryString()}`);
  photoGroups = data.groups;
  renderTimeline();

  const { years, favorites } = data.facets;
  paintYearChips(years);
  $('#fav-count').textContent = favorites || '';

  document.querySelectorAll('#photo-filters [data-filter]').forEach((c) =>
    c.classList.toggle('is-active',
      c.dataset.filter === (photoFilter.favorite ? 'fav' : 'all')));

  // Three distinct states: an empty library, a filter that matched nothing,
  // and results. Showing the "upload your first photo" panel to someone whose
  // search simply missed would be wrong.
  const libraryEmpty = data.total === 0 && !filtersActive();
  $('#photos-empty').hidden = !libraryEmpty;
  $('#photos-no-match').hidden = !(data.total === 0 && filtersActive());

  $('#photos-sub').textContent = data.total
    ? `${plural(data.total, 'photo')} across ${plural(data.groups.length, 'month')}` +
      (filtersActive() ? ' · filtered' : '')
    : libraryEmpty ? 'Nothing here yet.' : 'No matches.';
}

async function toggleFavorite(photo) {
  const next = !photo.favorite;
  try {
    await api(`/api/assets/${photo.id}`, { method: 'PATCH', body: { favorite: next } });
    photo.favorite = next;   // shared object reference, so the lightbox agrees

    if (photoFilter.favorite) {
      // The photo has just left the filtered set, so the grid has to reflow
      // against fresh data - and that refetch also renews the facet counts.
      await loadPhotos();
    } else {
      // Re-render locally instead of refetching the whole library for one
      // star, and move the chip's count by hand since no response will.
      renderTimeline();
      const count = Number($('#fav-count').textContent || 0) + (next ? 1 : -1);
      $('#fav-count').textContent = count > 0 ? String(count) : '';
    }
    paintPhotoMeta();
    toast(next ? 'Added to favourites' : 'Removed from favourites');
  } catch (err) {
    toast(err.message);
  }
}

$('#photo-filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;

  if (chip.dataset.year) {
    const year = Number(chip.dataset.year);
    photoFilter.year = photoFilter.year === year ? null : year;   // click again to clear
  } else {
    photoFilter.favorite = chip.dataset.filter === 'fav';
  }
  loadPhotos().catch((err) => toast(err.message));
});

let photoSearchTimer = null;
$('#photo-search').addEventListener('input', (e) => {
  photoFilter.q = e.target.value.trim();
  clearTimeout(photoSearchTimer);
  photoSearchTimer = setTimeout(() => loadPhotos().catch(() => {}), 250);
});

$('#clear-filters').addEventListener('click', () => {
  photoFilter.q = '';
  photoFilter.favorite = false;
  photoFilter.year = null;
  $('#photo-search').value = '';
  loadPhotos().catch((err) => toast(err.message));
});

/**
 * Row widths are computed from the container, so they have to be recomputed
 * when it changes.
 *
 * Only width matters. Re-rendering changes the container's *height*, so
 * reacting to that would feed the observer its own output forever.
 *
 * This handles resizing an already-visible timeline. It deliberately does not
 * handle the first reveal: a display:none container has no box to observe,
 * and the transition back to visible is not a size change the observer can be
 * relied on to deliver. showView() drives that case instead.
 */
let lastLayoutWidth = 0;
new ResizeObserver(() => {
  const width = $('#timeline').clientWidth;
  if (width === 0 || width === lastLayoutWidth) return;
  if (photoGroups.length) renderTimeline();
}).observe($('#timeline'));

/**
 * Repaints the lightbox chrome for the current photo. Split out of showPhoto
 * because starring updates the footer without re-loading the image.
 */
function paintPhotoMeta() {
  if (photoIndex < 0) return;
  const photo = flatPhotos[photoIndex];

  $('#photo-title').textContent = photo.title;
  $('#photo-meta').textContent = [
    `${photoIndex + 1} of ${flatPhotos.length}`,
    photo.width && `${photo.width}×${photo.height}`,
    formatSize(photo.sizeBytes),
    new Date(photo.capturedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
  ].filter(Boolean).join('  ·  ');

  const fav = $('#photo-fav');
  fav.classList.toggle('is-on', Boolean(photo.favorite));
  fav.setAttribute('aria-pressed', String(Boolean(photo.favorite)));
  fav.querySelector('.btn-label').textContent = photo.favorite ? 'Favourited' : 'Favourite';
}

function showPhoto(index) {
  if (index < 0 || index >= flatPhotos.length) return;
  photoIndex = index;

  $('#photo-full').src = withToken(flatPhotos[index].originalUrl);
  paintPhotoMeta();

  $('#photo-prev').hidden = index === 0;
  $('#photo-next').hidden = index === flatPhotos.length - 1;
  $('#photo-overlay').hidden = false;
}

function closeLightbox() {
  $('#photo-overlay').hidden = true;
  $('#photo-full').removeAttribute('src');
  photoIndex = -1;
}

$('#photo-close').addEventListener('click', closeLightbox);
$('#photo-prev').addEventListener('click', () => showPhoto(photoIndex - 1));
$('#photo-next').addEventListener('click', () => showPhoto(photoIndex + 1));

$('#photo-fav').addEventListener('click', () => {
  if (photoIndex < 0) return;
  const photo = flatPhotos[photoIndex];
  // With the favourites filter on, un-starring drops this photo from the
  // result set - close first so the lightbox is not left on a stale index.
  if (photoFilter.favorite && photo.favorite) closeLightbox();
  toggleFavorite(photo);
});

$('#photo-delete').addEventListener('click', async () => {
  if (photoIndex < 0) return;
  const photo = flatPhotos[photoIndex];
  if (!confirm(`Delete "${photo.title}"?`)) return;
  closeLightbox();
  await api(`/api/assets/${photo.id}`, { method: 'DELETE' });
  toast('Photo deleted');
  loadPhotos();
  loadProfile();
});

document.addEventListener('keydown', (e) => {
  if (!$('#player-overlay').hidden) {
    if (e.key === 'Escape') $('#player-close').click();
    return;
  }
  if ($('#photo-overlay').hidden) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') showPhoto(photoIndex - 1);
  if (e.key === 'ArrowRight') showPhoto(photoIndex + 1);
  if (e.key === 'f' || e.key === 'F') $('#photo-fav').click();
});

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

async function loadProfile() {
  const { user, stats } = await api('/api/profile');
  paintIdentity(user);

  const tiles = [
    { value: stats.videos, label: 'Videos' },
    { value: stats.photos, label: 'Photos' },
    { value: stats.shared, label: 'Shared to catalog' },
    { value: stats.favorites, label: 'Favourite photos' },
    { value: formatSize(stats.storageBytes), label: 'Storage used' },
    { value: formatSpan(stats.librarySec), label: 'Runtime in library' },
    { value: formatSpan(stats.watchedSec), label: 'Watched' },
    { value: `${stats.finished}/${stats.started}`, label: 'Finished / started' },
  ];

  const wrap = $('#stats');
  wrap.replaceChildren();
  for (const t of tiles) {
    const el = document.createElement('div');
    el.className = 'stat';
    el.innerHTML = '<div class="stat-value"></div><div class="stat-label"></div>';
    el.querySelector('.stat-value').textContent = t.value;
    el.querySelector('.stat-label').textContent = t.label;
    wrap.appendChild(el);
  }
}

$('#name-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const status = $('#name-status');
  const btn = form.querySelector('button[type="submit"]');

  btn.disabled = true;
  status.className = 'form-msg';
  status.textContent = 'Saving…';
  try {
    const { user } = await api('/api/profile', {
      method: 'PATCH',
      body: { displayName: form.displayName.value.trim() },
    });
    paintIdentity(user);
    status.classList.add('is-ok');
    status.textContent = 'Saved.';
    toast('Display name updated');
  } catch (err) {
    status.classList.add('is-err');
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const status = $('#password-status');
  const btn = form.querySelector('button[type="submit"]');

  btn.disabled = true;
  status.className = 'form-msg';
  status.textContent = 'Updating…';
  try {
    await api('/api/profile/password', {
      method: 'PUT',
      body: {
        currentPassword: form.currentPassword.value,
        newPassword: form.newPassword.value,
      },
    });
    form.reset();
    status.classList.add('is-ok');
    status.textContent = 'Password changed.';
    toast('Password changed');
  } catch (err) {
    status.classList.add('is-err');
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------------ *
 * Uploads
 * ------------------------------------------------------------------ */

/** Wires a dropzone to its hidden file input and reflects the selection. */
function wireDrop(dropSel, input, describe) {
  const drop = $(dropSel);
  const label = drop.querySelector('.drop-label');
  const original = label.textContent;

  const reflect = () => {
    const has = input.files.length > 0;
    drop.classList.toggle('has-file', has);
    label.textContent = has ? describe(input.files) : original;
  };

  input.addEventListener('change', reflect);

  ['dragenter', 'dragover'].forEach((type) =>
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((type) =>
    drop.addEventListener(type, () => drop.classList.remove('is-over')));

  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    // Assigning a DataTransfer's FileList is what makes the dropped files
    // part of the form, so the normal submit path needs no special case.
    input.files = e.dataTransfer.files;
    reflect();
  });

  return reflect;
}

const videoInput = $('#video-form').video;
const photoInput = $('#photo-form').photos;

const resetVideoDrop = wireDrop('#video-drop', videoInput, (f) => f[0].name);
const resetPhotoDrop = wireDrop('#photo-drop', photoInput, (f) =>
  f.length === 1 ? f[0].name : `${f.length} photos selected`);

$('#video-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const status = $('#video-status');
  const btn = form.querySelector('button[type="submit"]');

  if (!form.video.files.length) {
    status.className = 'form-msg is-err';
    status.textContent = 'Choose a video first.';
    return;
  }

  const fd = new FormData();
  fd.append('video', form.video.files[0]);
  if (form.title.value.trim()) fd.append('title', form.title.value.trim());
  // The route reads 'public' specifically; an unchecked box sends nothing.
  if (form.shared.checked) fd.append('visibility', 'public');

  btn.disabled = true;
  status.className = 'form-msg';
  status.textContent = 'Uploading…';
  try {
    const data = await api('/api/assets', { method: 'POST', body: fd, isForm: true });
    status.classList.add('is-ok');
    status.textContent = `Uploaded "${data.asset.title}". Processing now.` +
      (data.asset.shared ? ' It will appear in Browse once ready.' : '');
    form.reset();
    resetVideoDrop();
    loadLibrary();
    loadCatalog().catch(() => {});
  } catch (err) {
    status.classList.add('is-err');
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#photo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const status = $('#photo-status');
  const btn = form.querySelector('button[type="submit"]');

  if (!form.photos.files.length) {
    status.className = 'form-msg is-err';
    status.textContent = 'Choose at least one photo.';
    return;
  }

  const fd = new FormData();
  [...form.photos.files].slice(0, 20).forEach((f) => fd.append('photos', f));

  btn.disabled = true;
  status.className = 'form-msg';
  status.textContent = 'Uploading…';
  try {
    const data = await api('/api/photos', { method: 'POST', body: fd, isForm: true });
    status.classList.add('is-ok');
    status.textContent = `Uploaded ${plural(data.count, 'photo')}. Building thumbnails…`;
    form.reset();
    resetPhotoDrop();
    loadPhotos();
    schedulePollIfProcessing(data.assets);
  } catch (err) {
    status.classList.add('is-err');
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

(async function boot() {
  if (!token) { $('#auth-screen').hidden = false; return; }
  try {
    const { user } = await api('/api/auth/me');
    await enterApp(user);
  } catch {
    // Stored token is stale - clear it and show the gate.
    localStorage.removeItem(TOKEN_KEY);
    token = null;
    $('#auth-screen').hidden = false;
  }
})();
