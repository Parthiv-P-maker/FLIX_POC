'use strict';

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = 'flixdrive.token';

let token = localStorage.getItem(TOKEN_KEY);
let currentUser = null;
let pollTimer = null;

// Deliberately not persisted. The session token has to survive a reload; this
// one is cheap to re-request and there is no reason to leave it lying in
// localStorage where a stray script could read it.
let mediaToken = null;
let mediaTokenTimer = null;

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

/**
 * Upload with a real progress readout.
 *
 * fetch() exposes no upload progress at all, which is why a 2 GB video used to
 * sit on a motionless "Uploading…" for minutes with no way to tell a slow
 * network from a hung request. XMLHttpRequest is the only thing in the
 * platform that reports bytes sent, so uploads - and only uploads - use it.
 */
function upload(path, formData, onProgress, onStart) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // Handed out so the upload tray can offer Cancel.
    if (onStart) onStart(xhr);
    xhr.open('POST', path);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.addEventListener('progress', (e) => {
      // Not every transfer can report a total; leave the bar indeterminate
      // rather than inventing a percentage.
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });

    // The last bytes leaving the browser is not the end of the story: the
    // server still has to write the file and insert the row. Pin the bar at
    // 100% and let the caller's status text carry the rest.
    xhr.upload.addEventListener('load', () => onProgress(1));

    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* keep {} */ }

      if (xhr.status === 401 && currentUser) {
        signOut();
        return reject(new Error('Session expired, please sign in again'));
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        return reject(new Error(data.error || `Upload failed (${xhr.status})`));
      }
      resolve(data);
    });

    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

    xhr.send(formData);
  });
}

/**
 * Swap the session token for a short-lived, media-only one.
 *
 * The server refuses a session token in a query string now, so nothing with a
 * <video> or <img> src works until this has run. Re-requested well inside the
 * token's lifetime so a long viewing session never hits an expiry mid-scrub.
 */
async function refreshMediaToken() {
  try {
    const { token: fresh } = await api('/api/auth/media-token');
    mediaToken = fresh;
  } catch {
    // Leave the old one in place; it may still be valid, and the next
    // scheduled refresh will try again.
  }
  return mediaToken;
}

function startMediaTokenRefresh() {
  clearInterval(mediaTokenTimer);
  // Well under the two-hour default, so a tab left open overnight keeps
  // working rather than quietly showing broken thumbnails.
  mediaTokenTimer = setInterval(() => { refreshMediaToken(); }, 45 * 60 * 1000);
}

// <video src> and <img src> cannot carry an Authorization header, so the
// stream and poster routes take a media token in the query string instead.
const withToken = (url) =>
  `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(mediaToken || '')}`;

// Posters are authorised now, not static, so every <img src> needs the token.
// Null-safe because an asset still being processed has no poster yet.
const posterSrc = (asset) => (asset.posterUrl ? withToken(asset.posterUrl) : '');

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Modal focus management
 * ------------------------------------------------------------------ */

// Where focus was before a modal opened, so it can be handed back on close.
// Without this, dismissing the player drops a keyboard user at the top of the
// document instead of on the tile they came from.
let focusBeforeModal = null;

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'textarea:not([disabled])', 'select:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

const visibleFocusable = (root) =>
  [...root.querySelectorAll(FOCUSABLE)].filter(
    (el) => !el.hidden && el.offsetParent !== null && !el.closest('[hidden]')
  );

/**
 * Keep Tab inside the open dialog.
 *
 * `aria-modal` tells a screen reader to ignore the rest of the page, but it
 * does nothing about the Tab key - without this, tabbing out of the player
 * walks the sidebar and the tiles behind it while the overlay still covers
 * them, which is a worse experience than no dialog at all.
 */
function trapFocus(overlay, e) {
  if (e.key !== 'Tab') return;

  const items = visibleFocusable(overlay);
  if (items.length === 0) return;

  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;

  if (e.shiftKey && (active === first || !overlay.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function openModal(overlay) {
  focusBeforeModal = document.activeElement;
  overlay.hidden = false;

  // Focus the close button rather than the first control: it is the one thing
  // every dialog has, and it tells a screen reader user immediately how to get
  // back out.
  const close = overlay.querySelector('.icon-btn');
  if (close) close.focus();
}

function closeModal(overlay) {
  overlay.hidden = true;

  // Only restore if the element is still in the document - deleting an asset
  // removes the tile that was focused.
  if (focusBeforeModal && document.contains(focusBeforeModal)) {
    focusBeforeModal.focus();
  }
  focusBeforeModal = null;
}

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

/* ---- forgot password ---- */

function showForgot(on) {
  $('#forgot-form').hidden = !on;
  $('#auth-form').hidden = on;
  $('#auth-tabs').hidden = on;
  $('#forgot-row').hidden = on;
  $('#auth-error').textContent = '';
  $('#forgot-status').textContent = '';
  if (on) $('#forgot-form').email.value = $('#auth-form').email.value.trim();
}

$('#forgot-btn').addEventListener('click', () => showForgot(true));
$('#forgot-cancel').addEventListener('click', () => showForgot(false));

$('#forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('button[type="submit"]');
  const status = $('#forgot-status');

  btn.disabled = true;
  status.className = 'form-msg';
  status.textContent = 'Sending…';
  try {
    const data = await api('/api/auth/forgot-password', {
      method: 'POST',
      body: { email: form.email.value.trim() },
    });
    status.classList.add('is-ok');
    // The API says the same thing whether or not the account exists, and so
    // does this - echoing it rather than writing our own keeps the two honest.
    status.textContent = data.message;
  } catch (err) {
    status.classList.add('is-err');
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

function signOut() {
  token = null;
  currentUser = null;
  mediaToken = null;
  clearInterval(mediaTokenTimer);
  clearTimeout(pollTimer);
  localStorage.removeItem(TOKEN_KEY);
  closePlayer();
  closeLightbox();
  // Uploads belong to the account that started them.
  trayJobs.forEach((job) => job.xhr?.abort());
  trayJobs.length = 0;
  paintTray();
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

/* ---- skeletons --------------------------------------------------------- */

function skeletonTiles(grid, count) {
  grid.replaceChildren();
  grid.setAttribute('aria-busy', 'true');
  for (let i = 0; i < count; i += 1) {
    const tile = document.createElement('div');
    tile.className = 'tile tile-skeleton';
    tile.setAttribute('aria-hidden', 'true');
    tile.innerHTML = '<div class="thumb sk"></div>' +
      '<div class="tile-body"><span class="sk sk-line"></span><span class="sk sk-line short"></span></div>';
    grid.appendChild(tile);
  }
}

// Widths vary per row so the placeholder reads as photos, not as a table.
const SKELETON_ROWS = [[1.5, 1, 1.3, 0.8], [1, 1.5, 1.2], [0.9, 1.3, 1, 1.4]];

function skeletonTimeline() {
  const wrap = $('#timeline');
  wrap.replaceChildren();
  wrap.setAttribute('aria-busy', 'true');
  const head = document.createElement('span');
  head.className = 'sk sk-month';
  wrap.appendChild(head);
  for (const row of SKELETON_ROWS) {
    const el = document.createElement('div');
    el.className = 'sk-photo-row';
    el.setAttribute('aria-hidden', 'true');
    row.forEach((grow) => {
      const cell = document.createElement('span');
      cell.className = 'sk';
      cell.style.flex = String(grow);
      el.appendChild(cell);
    });
    wrap.appendChild(el);
  }
}

/** Placeholders everywhere the first load will fill, painted before it starts. */
function paintSkeletons() {
  skeletonTiles($('#library-grid'), 8);
  skeletonTiles($('#fresh-grid'), 6);
  $('#fresh-row').hidden = false;
  $('#hero-skeleton').hidden = false;
  $('#library-empty').hidden = true;
  $('#photos-empty').hidden = true;
  skeletonTimeline();
}

async function enterApp(user) {
  paintIdentity(user);
  $('#auth-screen').hidden = true;
  $('#app').hidden = false;
  paintSkeletons();
  showView(location.hash.slice(1) || 'watch');

  // Before anything renders: every poster and every stream URL needs this, and
  // tiles built without it would all 401.
  await refreshMediaToken();
  startMediaTokenRefresh();

  await Promise.all([loadLibrary(), loadCatalog(), loadPhotos(), loadProfile()]);
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

const VIEWS = ['watch', 'browse', 'photos', 'upload', 'profile'];

function showView(name) {
  if (!VIEWS.includes(name)) name = 'watch';
  // The view goes in the URL, so a reload stays put and the installed app's
  // shortcuts (/#photos, /#upload) land in the right place.
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
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

const TRASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 11.2A2 2 0 0 1 15 22H9a2 2 0 0 1-2-1.8z"/></svg>';

/**
 * Delete an asset, with the confirm and the error reporting in one place.
 *
 * Every caller used to inline this, and the two that mattered - the player and
 * the lightbox - had already closed their overlay before awaiting, with no
 * catch. A failure there showed the user a vanished item, no error, and an
 * unhandled rejection in the console, then brought it back on the next reload.
 *
 * @returns {Promise<boolean>} whether the asset was actually deleted
 */
async function deleteAsset(asset, onDone) {
  const noun = asset.kind === 'photo' ? 'Photo' : 'Video';
  if (!confirm(`Delete "${asset.title}"? This removes the file from disk.`)) return false;

  try {
    await api(`/api/assets/${asset.id}`, { method: 'DELETE' });
    toast(`${noun} deleted`);
    if (onDone) onDone();
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

/**
 * The little bin that appears on a tile you own.
 *
 * A real <button>. It used to be a <span>, because the tile itself was a
 * <button> and nesting one inside another is invalid - but that also meant the
 * only way to delete from the grid was with a mouse. Tiles and photo cells are
 * <div>s now, with the card-wide click supplied by a stretched ::after on the
 * primary button, so the actions can be buttons too.
 *
 * stopPropagation keeps the click off the card underneath.
 */
function trashControl(asset, onDone) {
  const noun = asset.kind === 'photo' ? 'photo' : 'video';
  const trash = document.createElement('button');
  trash.type = 'button';
  trash.className = 'cell-trash';
  trash.title = `Delete this ${noun}`;
  // The title attribute is a tooltip, not a name a screen reader can rely on.
  trash.setAttribute('aria-label', `Delete ${asset.title}`);
  trash.innerHTML = TRASH_SVG;
  trash.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteAsset(asset, onDone);
  });
  return trash;
}

/**
 * One tile shape for both the private library and the shared catalog.
 *
 * `showOwner` is what separates them: in Browse the uploader's name is the
 * point, in your own library it would just repeat your own name on every row.
 */
function videoTile(asset, progressPercent, { showOwner = false } = {}) {
  // A <div>, not a <button>. The card carries its own actions (delete), and a
  // button inside a button is invalid HTML that browsers resolve by dropping
  // the inner one from the accessibility tree - which is why those actions
  // used to be mouse-only. The whole-card click comes from a stretched
  // ::after on .tile-open instead; see styles.css.
  const tile = document.createElement('div');
  tile.className = 'tile';

  const ready = asset.status === 'ready';
  // A file still being probed has no poster and no playable bytes yet.
  if (!ready) tile.classList.add('is-pending');

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
      <div class="tile-title"><button class="tile-open" type="button"></button></div>
      ${showOwner ? '<div class="tile-owner"></div>' : ''}
      <div class="tile-sub"></div>
    </div>`;

  // Titles and display names are user-supplied - assign as text, never HTML.
  const open = tile.querySelector('.tile-open');
  open.textContent = asset.title;
  tile.querySelector('.tile-sub').textContent = sub;
  if (showOwner) {
    tile.querySelector('.tile-owner').textContent =
      asset.isOwner ? 'You' : asset.ownerName || 'Unknown member';
  }

  if (!ready) {
    open.disabled = true;
    // Otherwise the only cue that this tile is inert is a slight fade.
    open.setAttribute('aria-label',
      `${asset.title} — ${asset.status === 'failed' ? 'processing failed' : 'still processing'}`);
  } else {
    open.setAttribute('aria-label', `Play ${asset.title}`);
  }

  // Deleting used to require opening the player first, which is a lot of
  // ceremony for clearing out a failed upload.
  if (asset.isOwner) {
    tile.querySelector('.thumb').appendChild(
      trashControl(asset, () => { loadLibrary(); loadCatalog().catch(() => {}); loadProfile(); })
    );
  }

  tileAssets.set(tile, asset);
  // The rail the tile sits in becomes the player's queue, so "Up next" means
  // the next video in the row the viewer was looking at.
  if (ready) open.addEventListener('click', () => openPlayer(asset, queueFor(tile.parentElement)));
  return tile;
}

// Tile element -> the asset it renders. A WeakMap, so replacing a grid's
// children lets the old entries be collected with no bookkeeping.
const tileAssets = new WeakMap();

function queueFor(grid) {
  if (!grid) return [];
  return [...grid.children].map((t) => tileAssets.get(t)).filter(Boolean);
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
  $('#hero-play').onclick = () => openPlayer(featured, queueFor($('#library-grid')));
  hero.hidden = false;
}

// A page size, not a ceiling. The API has always paginated; the client used to
// ask for 100 and ignore `hasMore`, which meant video 101 existed but could
// never be reached.
const LIBRARY_PAGE_SIZE = 24;

const libraryPaging = { page: 0, hasMore: false, loading: false, percentById: new Map() };

/**
 * @param {boolean} append  true to add the next page, false to reload from the
 *                          first one. A reload is what every mutation wants;
 *                          append is only ever driven by the scroll sentinel.
 */
async function loadLibrary({ append = false } = {}) {
  if (libraryPaging.loading) return;
  libraryPaging.loading = true;
  const page = append ? libraryPaging.page + 1 : 1;

  try {
    // "Continue watching" and the hero describe the whole library, not the page
    // that just arrived, so they are only rebuilt on a fresh load.
    const [library, cont] = await Promise.all([
      api(`/api/assets?limit=${LIBRARY_PAGE_SIZE}&page=${page}`),
      append ? Promise.resolve(null) : api('/api/progress/continue'),
    ]);

    if (cont) {
      libraryPaging.percentById = new Map(cont.items.map((i) => [String(i.asset.id), i.percent]));
    }
    const percentById = libraryPaging.percentById;

    const grid = $('#library-grid');
    if (!append) grid.replaceChildren();
    grid.removeAttribute('aria-busy');
    $('#hero-skeleton').hidden = true;
    library.assets.forEach((a) => grid.appendChild(videoTile(a, percentById.get(String(a.id)))));

    libraryPaging.page = page;
    libraryPaging.hasMore = library.hasMore;
    $('#library-sentinel').hidden = !library.hasMore;

    const hasAny = grid.childElementCount > 0;
    $('#library-empty').hidden = hasAny;
    $('#watch-sub').textContent = hasAny
      ? `${plural(library.total, 'video')} in your library`
      : 'Nothing here yet.';

    if (!append) {
      paintHero(library.assets, percentById);

      const continueGrid = $('#continue-grid');
      continueGrid.replaceChildren();
      cont.items.forEach((i) => continueGrid.appendChild(videoTile(i.asset, i.percent)));
      $('#continue-row').hidden = cont.items.length === 0;
    }

    schedulePollIfProcessing(library.assets);
  } finally {
    libraryPaging.loading = false;
  }
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
  grid.removeAttribute('aria-busy');
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
// The row the video was opened from, in display order - feeds "Up next".
let playerQueue = [];
let lastSentAt = 0;

// Opening a video is asynchronous - it waits on the resume point before it can
// start. These two make that interruptible: `playerSession` identifies the
// current open so a superseded one can bail, and the controller detaches any
// listener that open attached to the shared <video> element.
let playerSession = 0;
let playerAbort = null;

/** Reflects share state on the player's toggles. Owner-only; hidden otherwise. */
function paintShareButton(asset) {
  const btn = $('#player-share');
  const link = $('#player-link');

  btn.hidden = !asset.isOwner;
  link.hidden = !asset.isOwner;
  $('#player-delete').hidden = !asset.isOwner;
  if (!asset.isOwner) return;

  btn.querySelector('.btn-label').textContent = asset.shared ? 'Shared · make private' : 'Share to catalog';
  btn.classList.toggle('is-on', Boolean(asset.shared));

  // Three visibility states, two controls. This one owns 'unlisted': it mints
  // a link on first use, and offers to revoke once one exists.
  const hasLink = Boolean(asset.shareUrl);
  link.querySelector('.btn-label').textContent = hasLink ? 'Copy link' : 'Get a link';
  link.classList.toggle('is-on', asset.linkShared === true);
}

/**
 * The description panel.
 *
 * Read-only for a viewer, editable for the owner. An asset with no description
 * shows nothing at all to a viewer - an empty paragraph is just a gap - but
 * still offers the owner a way to add one.
 */
function paintDescription(asset) {
  const text = $('#player-description');
  const edit = $('#description-edit');
  const form = $('#description-form');

  const body = (asset.description || '').trim();

  text.textContent = body;
  text.hidden = body.length === 0;

  form.hidden = true;
  edit.hidden = !asset.isOwner;
  edit.textContent = body ? 'Edit description' : 'Add a description';
  form.description.value = body;

  // Someone else's video with no description has nothing to put here, and the
  // section's own padding would otherwise leave a gap above the footer.
  $('#player-about').hidden = !asset.isOwner && body.length === 0;
}

$('#description-edit').addEventListener('click', () => {
  $('#description-form').hidden = false;
  $('#description-edit').hidden = true;
  $('#player-description').hidden = true;
  $('#description-form').description.focus();
});

$('#description-cancel').addEventListener('click', () => {
  if (playingAsset) paintDescription(playingAsset);
});

$('#description-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!playingAsset) return;
  const btn = e.currentTarget.querySelector('button[type="submit"]');

  btn.disabled = true;
  try {
    const { asset } = await api(`/api/assets/${playingAsset.id}`, {
      method: 'PATCH',
      body: { description: e.currentTarget.description.value },
    });
    // Keep the in-memory copy in step, the same way the share toggle does.
    playingAsset = { ...playingAsset, ...asset };
    paintDescription(playingAsset);
    toast('Description saved');
    loadLibrary();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

/**
 * Copy a share link, minting one if this is the first time.
 *
 * Going through 'unlisted' rather than 'public' is the point: the recipient
 * needs no account, but the video still does not show up in Browse for
 * everyone else.
 */
$('#player-link').addEventListener('click', async () => {
  if (!playingAsset) return;
  const btn = $('#player-link');

  btn.disabled = true;
  try {
    let asset = playingAsset;

    if (!asset.shareUrl) {
      // A private asset has to be promoted to 'unlisted' to be linkable. One
      // that is already public must NOT be - that would pull it out of the
      // catalog as a side effect of asking for a link. Re-sending its current
      // visibility still saves the row, which is what mints the slug for an
      // asset shared before share links existed.
      const next = asset.visibility === 'private' ? 'unlisted' : asset.visibility;
      const res = await api(`/api/assets/${asset.id}`, {
        method: 'PATCH',
        body: { visibility: next },
      });
      asset = { ...asset, ...res.asset };
      playingAsset = asset;
      paintShareButton(asset);
      loadLibrary();
    }

    try {
      await navigator.clipboard.writeText(asset.shareUrl);
      toast('Share link copied — anyone with it can watch, no account needed');
    } catch {
      // Clipboard access can be denied even on a secure origin. Showing the
      // link beats silently failing; the user can select it by hand.
      toast(asset.shareUrl);
    }
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

async function openPlayer(asset, queue = []) {
  // Every open supersedes the one before it. There is a single <video>
  // element, so without this an open that is still fetching its resume point
  // can come back after the user has clicked a different video and seek *that*
  // one to the first video's position.
  const session = ++playerSession;
  if (playerAbort) playerAbort.abort();
  playerAbort = new AbortController();
  const { signal } = playerAbort;

  playingAsset = asset;
  playerQueue = queue;
  lastSentAt = 0;
  resetPlayerChrome();

  $('#player-title').textContent = asset.title;
  $('#player-meta').textContent = [
    // Someone else's upload: say whose. Your own already sits in your library.
    !asset.isOwner && asset.ownerName ? `Shared by ${asset.ownerName}` : null,
    asset.width && `${asset.width}×${asset.height}`,
    formatDuration(asset.durationSec),
    asset.viewCount ? plays(asset.viewCount) : null,
  ].filter(Boolean).join('  ·  ');

  paintShareButton(asset);
  paintDescription(asset);

  // Show the overlay straight away so the click feels immediate; the source is
  // attached below, once we know where to start from. "Up next" opens a video
  // with the overlay already up, and re-opening would overwrite the element
  // focus should return to on close.
  if ($('#player-overlay').hidden) openModal($('#player-overlay'));

  // One bump per open, not per range request - see the route comment.
  api(`/api/assets/${asset.id}/view`, { method: 'POST' }).catch(() => {});

  // Resume where we left off, but not if the viewer was essentially at the
  // start or right at the end - both would feel broken.
  //
  // The media token is refreshed alongside it: a tile rendered an hour ago
  // carries an hour-old token, and a film is long enough that starting one on
  // a nearly-expired token would stall partway through.
  let resumeAt = 0;
  try {
    const [p] = await Promise.all([
      api(`/api/progress/${asset.id}`),
      refreshMediaToken(),
    ]);
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

  // Send first, then clear, then pause. pause() fires the 'pause' handler
  // synchronously, which called sendProgress again while playingAsset was
  // still set - two PUTs for every close, writing the same position twice.
  if (playingAsset && video.currentTime > 0) sendProgress(true);
  playingAsset = null;
  cancelUpNext();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});

  video.pause();
  video.removeAttribute('src');
  video.load();
  closeModal($('#player-overlay'));
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
  const asset = playingAsset;

  // Confirm while the video is still up, so the user can see what they are
  // about to delete. Only tear the player down once they have said yes.
  const deleted = await deleteAsset(asset, () => { loadLibrary(); loadProfile(); });
  if (!deleted) return;

  playingAsset = null;           // stop the pause handler writing progress for a dead row
  closePlayer();
});

/* ---- player: custom controls ---------------------------------------- */

const stage = $('#player-stage');
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const UP_NEXT_SECONDS = 8;

// Volume, mute and speed follow the viewer from video to video and across
// reloads. localStorage can throw (private mode, blocked storage), and a
// missing preference is never worth an error.
function readPref(key, fallback) {
  try {
    const raw = localStorage.getItem(`flixdrive.${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try { localStorage.setItem(`flixdrive.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const durationNow = () =>
  (Number.isFinite(video.duration) ? video.duration : playingAsset?.durationSec) || 0;

function paintPlayState() {
  stage.classList.toggle('is-playing', !video.paused);
  $('#pc-play').setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
}

function paintVolume() {
  const silent = video.muted || video.volume === 0;
  stage.classList.toggle('is-muted', silent);
  $('#pc-vol').value = silent ? 0 : video.volume;
  $('#pc-mute').setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
}

function paintTime() {
  const d = durationNow();
  const t = video.currentTime || 0;
  $('#pc-time').textContent = `${formatDuration(t)} / ${formatDuration(d)}`;

  const pct = d ? (t / d) * 100 : 0;
  $('#scrub-played').style.width = `${pct}%`;
  $('#scrub-knob').style.left = `${pct}%`;

  const scrub = $('#scrub');
  scrub.setAttribute('aria-valuemax', String(Math.round(d)));
  scrub.setAttribute('aria-valuenow', String(Math.round(t)));
  scrub.setAttribute('aria-valuetext', `${formatDuration(t)} of ${formatDuration(d)}`);
}

// Only the range that contains the playhead counts: a chunk buffered far
// ahead after a seek is not something the viewer can play into.
function paintBuffer() {
  const d = durationNow();
  let end = 0;
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (video.buffered.start(i) <= video.currentTime + 0.5) end = Math.max(end, video.buffered.end(i));
  }
  $('#scrub-buffer').style.width = d ? `${(end / d) * 100}%` : '0%';
}

/** Brief centred readout for keyboard actions: "+10s", "1.5×", "Muted". */
function flash(text) {
  const el = $('#player-flash');
  el.textContent = text;
  el.classList.remove('is-on');
  void el.offsetWidth;   // restart the animation
  el.classList.add('is-on');
}

function togglePlay() {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function seekTo(seconds) {
  const d = durationNow();
  if (!d) return;
  video.currentTime = clamp(seconds, 0, Math.max(0, d - 0.1));
  paintTime();
}

function seekBy(delta) {
  seekTo((video.currentTime || 0) + delta);
  flash(`${delta > 0 ? '+' : '−'}${Math.abs(delta)}s`);
}

function nudgeVolume(delta) {
  video.muted = false;
  video.volume = clamp(Math.round((video.volume + delta) * 20) / 20, 0, 1);
  flash(`Volume ${Math.round(video.volume * 100)}%`);
}

function toggleMute() {
  video.muted = !video.muted;
  // Unmuting at zero volume would change nothing the viewer can hear.
  if (!video.muted && video.volume === 0) video.volume = 0.5;
  flash(video.muted ? 'Muted' : `Volume ${Math.round(video.volume * 100)}%`);
}

/* speed */

function setSpeed(rate) {
  // defaultPlaybackRate too: assigning a new src resets playbackRate to it,
  // and the next video in the queue should keep the viewer's choice.
  video.defaultPlaybackRate = rate;
  video.playbackRate = rate;
  writePref('speed', rate);
}

function paintSpeed() {
  const rate = video.playbackRate;
  $('#pc-speed').textContent = `${rate}×`;
  $('#pc-speed-menu').querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === rate)));
}

function toggleSpeedMenu(open) {
  const menu = $('#pc-speed-menu');
  const next = open ?? menu.hidden;
  menu.hidden = !next;
  $('#pc-speed').setAttribute('aria-expanded', String(next));
  if (next) (menu.querySelector('[aria-pressed="true"]') || menu.firstElementChild).focus();
}

SPEEDS.forEach((rate) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.rate = rate;
  b.textContent = rate === 1 ? 'Normal' : `${rate}×`;
  $('#pc-speed-menu').appendChild(b);
});

$('#pc-speed').addEventListener('click', () => toggleSpeedMenu());
$('#pc-speed-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rate]');
  if (!b) return;
  setSpeed(Number(b.dataset.rate));
  toggleSpeedMenu(false);
  $('#pc-speed').focus();
});

function stepSpeed(dir) {
  const i = SPEEDS.indexOf(video.playbackRate);
  const next = SPEEDS[clamp((i === -1 ? SPEEDS.indexOf(1) : i) + dir, 0, SPEEDS.length - 1)];
  setSpeed(next);
  flash(`${next}×`);
}

/* fullscreen and picture-in-picture */

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (stage.requestFullscreen) {
    stage.requestFullscreen().catch(() => {});
  } else if (video.webkitEnterFullscreen) {
    // iPhone Safari cannot fullscreen an element, only the video itself.
    video.webkitEnterFullscreen();
  }
}

$('#pc-pip').hidden = !document.pictureInPictureEnabled;
$('#pc-pip').addEventListener('click', () => {
  const pip = document.pictureInPictureElement
    ? document.exitPictureInPicture()
    : video.requestPictureInPicture();
  pip.catch(() => toast('Picture in picture is not available for this video'));
});

/* shortcuts panel */

function toggleKeysHelp(open) {
  const panel = $('#keys-help');
  const next = open ?? panel.hidden;
  panel.hidden = !next;
  $('#pc-keys').setAttribute('aria-expanded', String(next));
}
$('#pc-keys').addEventListener('click', () => toggleKeysHelp());

/* auto-hiding controls */

let idleTimer = null;
function wakeControls() {
  stage.classList.remove('is-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const busy = video.paused || scrubDragging ||
      !$('#pc-speed-menu').hidden || !$('#keys-help').hidden || !$('#upnext').hidden;
    if (!busy) stage.classList.add('is-idle');
  }, 2600);
}
['pointermove', 'pointerdown', 'focusin'].forEach((type) => stage.addEventListener(type, wakeControls));

/* clicks on the picture */

// On touch, the first tap on a hidden-controls stage should bring the
// controls back, not pause the film out from under the viewer.
let lastPointerType = 'mouse';
video.addEventListener('pointerdown', (e) => { lastPointerType = e.pointerType; });
video.addEventListener('click', () => {
  if (lastPointerType === 'touch' && stage.classList.contains('is-idle')) return wakeControls();
  togglePlay();
});
video.addEventListener('dblclick', toggleFullscreen);

/* timeline: hover previews and dragging */

const scrub = $('#scrub');
let scrubDragging = false;

function timeAtX(clientX) {
  const r = scrub.getBoundingClientRect();
  return clamp((clientX - r.left) / r.width, 0, 1) * durationNow();
}

/**
 * The preview frame comes out of the sprite sheet the worker built: frame i
 * is at column i % cols, row i / cols. Scaling the whole sheet by the same
 * factor as the frame keeps the maths in source pixels.
 */
function showScrubPreview(clientX) {
  const r = scrub.getBoundingClientRect();
  const t = timeAtX(clientX);
  const preview = $('#scrub-preview');
  const thumb = $('#scrub-thumb');
  const sprite = playingAsset?.sprite;

  preview.hidden = false;
  $('#scrub-time').textContent = formatDuration(t);

  if (sprite) {
    const i = clamp(Math.floor(t / sprite.interval), 0, sprite.count - 1);
    const scale = 160 / sprite.width;
    const col = i % sprite.cols;
    const row = Math.floor(i / sprite.cols);
    thumb.hidden = false;
    thumb.style.height = `${Math.round(sprite.height * scale)}px`;
    thumb.style.backgroundImage = `url("${withToken(sprite.url)}")`;
    thumb.style.backgroundSize = `${sprite.cols * sprite.width * scale}px ${sprite.rows * sprite.height * scale}px`;
    thumb.style.backgroundPosition = `-${col * sprite.width * scale}px -${row * sprite.height * scale}px`;
  } else {
    thumb.hidden = true;
  }

  // Keep the bubble inside the stage at either end of the bar.
  const half = sprite ? 82 : 26;
  preview.style.left = `${clamp(clientX - r.left, half, r.width - half)}px`;
}

scrub.addEventListener('pointermove', (e) => {
  showScrubPreview(e.clientX);
  if (scrubDragging) seekTo(timeAtX(e.clientX));
});
scrub.addEventListener('pointerleave', () => {
  if (!scrubDragging) $('#scrub-preview').hidden = true;
});
scrub.addEventListener('pointerdown', (e) => {
  scrubDragging = true;
  scrub.setPointerCapture(e.pointerId);
  scrub.classList.add('is-dragging');
  showScrubPreview(e.clientX);
  seekTo(timeAtX(e.clientX));
});
['pointerup', 'pointercancel'].forEach((type) => scrub.addEventListener(type, (e) => {
  if (!scrubDragging) return;
  scrubDragging = false;
  scrub.classList.remove('is-dragging');
  if (scrub.hasPointerCapture(e.pointerId)) scrub.releasePointerCapture(e.pointerId);
  if (e.pointerType !== 'mouse') $('#scrub-preview').hidden = true;
  wakeControls();
}));

/* buttons */

$('#pc-play').addEventListener('click', togglePlay);
$('#pc-back').addEventListener('click', () => seekBy(-10));
$('#pc-fwd').addEventListener('click', () => seekBy(10));
$('#pc-mute').addEventListener('click', toggleMute);
$('#pc-full').addEventListener('click', toggleFullscreen);
$('#pc-vol').addEventListener('input', (e) => {
  video.volume = Number(e.target.value);
  video.muted = video.volume === 0;
});

/* media events */

video.addEventListener('play', () => { paintPlayState(); wakeControls(); });
video.addEventListener('pause', () => { paintPlayState(); wakeControls(); });
video.addEventListener('timeupdate', paintTime);
video.addEventListener('durationchange', paintTime);
video.addEventListener('progress', paintBuffer);
video.addEventListener('seeked', paintBuffer);
video.addEventListener('ratechange', paintSpeed);
video.addEventListener('volumechange', () => {
  paintVolume();
  writePref('volume', video.volume);
  writePref('muted', video.muted);
});
video.addEventListener('waiting', () => { $('#player-spinner').hidden = false; });
['playing', 'canplay', 'pause', 'error'].forEach((type) =>
  video.addEventListener(type, () => { $('#player-spinner').hidden = true; }));
video.addEventListener('error', () => {
  if (playingAsset) flash('This video could not be played');
});

/* up next */

let upNextTimer = null;

function nextInQueue() {
  const i = playerQueue.findIndex((a) => String(a.id) === String(playingAsset?.id));
  if (i === -1) return null;
  return playerQueue.slice(i + 1).find((a) => a.status === 'ready') || null;
}

function cancelUpNext() {
  clearInterval(upNextTimer);
  upNextTimer = null;
  $('#upnext').hidden = true;
}

function playNext(next) {
  cancelUpNext();
  openPlayer(next, playerQueue);
}

video.addEventListener('ended', () => {
  const next = nextInQueue();
  if (!next) return;

  let left = UP_NEXT_SECONDS;
  $('#upnext-count').textContent = String(left);
  $('#upnext-title').textContent = next.title;
  $('#upnext-poster').src = posterSrc(next);
  $('#upnext').hidden = false;
  $('#upnext-play').onclick = () => playNext(next);
  wakeControls();

  upNextTimer = setInterval(() => {
    left -= 1;
    $('#upnext-count').textContent = String(left);
    if (left <= 0) playNext(next);
  }, 1000);
});

$('#upnext-cancel').addEventListener('click', cancelUpNext);

/** Back to a clean slate for the next video, keeping volume and speed. */
function resetPlayerChrome() {
  cancelUpNext();
  toggleSpeedMenu(false);
  toggleKeysHelp(false);
  $('#scrub-preview').hidden = true;
  $('#scrub-buffer').style.width = '0%';
  $('#player-spinner').hidden = false;
  stage.classList.remove('is-idle');
  paintTime();
  paintPlayState();
}

/**
 * Player shortcuts, YouTube-style so they are already familiar.
 * @returns {boolean} whether the key was handled
 */
function handlePlayerKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  // Space on a focused button should press that button, not the video.
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
    case '?': toggleKeysHelp(); break;
    case 'Home': seekTo(0); break;
    case 'End': seekTo(durationNow()); break;
    default:
      if (/^[0-9]$/.test(e.key)) {
        seekTo((durationNow() * Number(e.key)) / 10);
        break;
      }
      return false;
  }
  return true;
}

// Close the speed menu on any click outside it.
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.pc-speed-wrap')) toggleSpeedMenu(false);
});

// Restore the viewer's last settings before anything plays.
video.volume = clamp(Number(readPref('volume', 1)) || 0, 0, 1);
video.muted = Boolean(readPref('muted', false));
setSpeed(SPEEDS.includes(readPref('speed', 1)) ? readPref('speed', 1) : 1);
paintVolume();
paintSpeed();

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

// `tag` is an exact AI tag (from a chip or a suggestion); `q` is free text
// that the server matches against titles, tags and visual similarity.
const photoFilter = { q: '', favorite: false, year: null, tag: null };

// The library's tag facet from the last response - feeds both the chip row and
// the search suggestions, so typing never waits on a request.
let photoTagFacet = [];

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
  // Same reasoning as videoTile: a <div> so the star and bin can be real
  // buttons rather than mouse-only spans.
  const cell = document.createElement('div');
  cell.className = 'photo-cell';
  cell.style.height = `${height}px`;
  cell.style.width = `${height * aspectOf(photo)}px`;

  cell.innerHTML = photo.posterUrl
    ? `<img src="${posterSrc(photo)}" alt="" loading="lazy" />`
    : `<span class="placeholder">${photo.status === 'failed' ? 'Failed' : '…'}</span>`;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'cell-open';
  // The <img> is alt="" because the cell's own label describes it; giving both
  // a name would announce the photo twice.
  open.setAttribute('aria-label', `Open ${photo.title}`);
  if (photo.status !== 'ready') open.disabled = true;
  cell.appendChild(open);

  const star = document.createElement('button');
  star.type = 'button';
  star.className = `cell-star${photo.favorite ? ' is-on' : ''}`;
  star.innerHTML = HEART_SVG;
  star.title = photo.favorite ? 'Remove from favourites' : 'Add to favourites';
  star.setAttribute('aria-label',
    `${photo.favorite ? 'Remove' : 'Add'} ${photo.title} ${photo.favorite ? 'from' : 'to'} favourites`);
  star.setAttribute('aria-pressed', String(Boolean(photo.favorite)));
  // A click on the heart must not also open the lightbox.
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(photo);
  });
  cell.appendChild(star);

  if (photo.isOwner) {
    cell.appendChild(trashControl(photo, () => { loadPhotos(); loadProfile(); }));
  }

  // The selection check. Clicking it outside selection mode enters the mode,
  // the way Google Photos does, so there is no need to find the button first.
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'cell-check';
  check.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>';
  check.setAttribute('aria-label', `Select ${photo.title}`);
  check.setAttribute('aria-pressed', String(selectedPhotos.has(String(photo.id))));
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSelected(index, e.shiftKey);
  });
  cell.appendChild(check);
  cell.dataset.id = photo.id;
  cell.classList.toggle('is-selected', selectedPhotos.has(String(photo.id)));

  // In selection mode a click anywhere on the photo selects it, including
  // photos still processing - clearing out failed uploads is a common reason
  // to select.
  open.addEventListener('click', (e) => {
    if (selecting) toggleSelected(index, e.shiftKey);
    else if (photo.status === 'ready') showPhoto(index);
  });
  if (open.disabled) open.disabled = !selecting;
  return cell;
}

/* ---- selection mode ---------------------------------------------------- */

let selecting = false;
const selectedPhotos = new Set();
let lastSelectedIndex = -1;

function setSelecting(on) {
  selecting = on;
  if (!on) {
    selectedPhotos.clear();
    lastSelectedIndex = -1;
  }
  $('#timeline').classList.toggle('is-selecting', on);
  $('#select-toggle').setAttribute('aria-pressed', String(on));
  $('#select-toggle').querySelector('.btn-label').textContent = on ? 'Done' : 'Select';
  // Cells built for the other mode have the wrong disabled state.
  renderTimeline();
  paintSelection();
}

/**
 * Toggle one photo, or with shift, set the whole range since the last click
 * to the clicked photo's new state - the file-manager convention.
 */
function toggleSelected(index, range) {
  if (!selecting) {
    selecting = true;
    $('#timeline').classList.add('is-selecting');
    $('#select-toggle').setAttribute('aria-pressed', 'true');
    $('#select-toggle').querySelector('.btn-label').textContent = 'Done';
  }
  const id = String(flatPhotos[index].id);
  const on = !selectedPhotos.has(id);

  if (range && lastSelectedIndex !== -1) {
    const [from, to] = [Math.min(lastSelectedIndex, index), Math.max(lastSelectedIndex, index)];
    for (let i = from; i <= to; i += 1) {
      const pid = String(flatPhotos[i].id);
      if (on) selectedPhotos.add(pid); else selectedPhotos.delete(pid);
    }
  } else if (on) {
    selectedPhotos.add(id);
  } else {
    selectedPhotos.delete(id);
  }
  lastSelectedIndex = index;
  paintSelection();
}

/** Repaints marks in place - no relayout, so the grid does not jump. */
function paintSelection() {
  document.querySelectorAll('#timeline .photo-cell').forEach((cell) => {
    const on = selectedPhotos.has(cell.dataset.id);
    cell.classList.toggle('is-selected', on);
    cell.querySelector('.cell-check')?.setAttribute('aria-pressed', String(on));
    const open = cell.querySelector('.cell-open');
    if (open && selecting) open.disabled = false;
  });

  const n = selectedPhotos.size;
  $('#selbar').hidden = !selecting;
  $('#sel-count').textContent = n ? `${n} selected` : 'Select photos';
  ['#sel-fav', '#sel-unfav', '#sel-delete'].forEach((s) => { $(s).disabled = n === 0; });
  $('#sel-all').textContent = n && n === flatPhotos.length ? 'Select none' : 'Select all';
}

async function bulkPhotos(action) {
  const ids = [...selectedPhotos];
  if (!ids.length) return;
  if (action === 'delete' &&
      !confirm(`Delete ${plural(ids.length, 'photo')}? This removes the files from disk.`)) return;

  try {
    const { count } = await api('/api/photos/bulk', { method: 'POST', body: { ids, action } });
    const verb = { favorite: 'Added to favourites', unfavorite: 'Removed from favourites', delete: 'Deleted' }[action];
    toast(`${verb}: ${plural(count, 'photo')}`);
    setSelecting(false);
    await loadPhotos();
    if (action === 'delete') loadProfile().catch(() => {});
  } catch (err) {
    toast(err.message);
  }
}

$('#select-toggle').addEventListener('click', () => setSelecting(!selecting));
$('#sel-cancel').addEventListener('click', () => setSelecting(false));
$('#sel-fav').addEventListener('click', () => bulkPhotos('favorite'));
$('#sel-unfav').addEventListener('click', () => bulkPhotos('unfavorite'));
$('#sel-delete').addEventListener('click', () => bulkPhotos('delete'));
$('#sel-all').addEventListener('click', () => {
  if (selectedPhotos.size === flatPhotos.length) selectedPhotos.clear();
  else flatPhotos.forEach((p) => selectedPhotos.add(String(p.id)));
  paintSelection();
});

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

// The timeline used to ask for 500 photos and render every cell at once.
// Paging keeps the first paint cheap and makes photo 501 reachable.
const PHOTO_PAGE_SIZE = 60;

const photoPaging = { page: 0, hasMore: false, loading: false };

function photoQueryString(page) {
  const params = new URLSearchParams({ limit: String(PHOTO_PAGE_SIZE), page: String(page) });
  if (photoFilter.q) params.set('q', photoFilter.q);
  if (photoFilter.favorite) params.set('favorite', '1');
  if (photoFilter.year) params.set('year', String(photoFilter.year));
  if (photoFilter.tag) params.set('tag', photoFilter.tag);
  return params.toString();
}

/**
 * Fold a newly-fetched page into the groups already on screen.
 *
 * A month straddles a page boundary far more often than not - 60 photos rarely
 * lands exactly on the 1st - so the first group of page 2 is usually the same
 * month as the last group of page 1. Appending it blindly would render the
 * month header twice with the photos split across it.
 */
function mergePhotoGroups(existing, incoming) {
  const byKey = new Map(existing.map((g) => [g.key, g]));

  for (const group of incoming) {
    const current = byKey.get(group.key);
    if (current) {
      current.items.push(...group.items);
    } else {
      byKey.set(group.key, group);
      existing.push(group);
    }
  }
  return existing;
}

const filtersActive = () =>
  Boolean(photoFilter.q || photoFilter.favorite || photoFilter.year || photoFilter.tag);

async function loadPhotos({ append = false } = {}) {
  if (photoPaging.loading) {
    // A search typed while the previous one is in flight must not be dropped,
    // or the grid ends up showing results for "anim" under "anime". Run once
    // more when the current request lands; appends can simply be skipped.
    if (!append) photoPaging.rerun = true;
    return;
  }
  photoPaging.loading = true;
  const page = append ? photoPaging.page + 1 : 1;

  try {
    const data = await api(`/api/photos?${photoQueryString(page)}`);

    photoGroups = append ? mergePhotoGroups(photoGroups, data.groups) : data.groups;
    photoPaging.page = page;
    photoPaging.hasMore = data.hasMore;
    $('#photos-sentinel').hidden = !data.hasMore;

    // Always a full re-render, even when appending: the justified solver packs
    // rows greedily, so new photos change where the *existing* rows break.
    // renderTimeline skips a hidden view, so the skeleton is cleared here -
    // otherwise an empty library would keep showing placeholders.
    $('#timeline').removeAttribute('aria-busy');
    if (!photoGroups.length) $('#timeline').replaceChildren();
    renderTimeline();

    // Photos were the one path that never armed the poll. Uploading twenty and
    // then reloading left the timeline on placeholders until the user thought
    // to refresh again, because only loadLibrary (videos) and the upload
    // handler ever called this.
    schedulePollIfProcessing(photoGroups.flatMap((g) => g.items));

    const { years, favorites, tags } = data.facets;
    paintYearChips(years);
    $('#fav-count').textContent = favorites || '';
    photoTagFacet = tags || [];
    paintTagChips();
    paintSearchHint(data.search, data.ai);
    $('#ai-badge').hidden = !data.ai?.enabled;
    scheduleTagPoll(data.ai);

    document.querySelectorAll('#photo-filters [data-filter]').forEach((c) =>
      c.classList.toggle('is-active',
        c.dataset.filter === (photoFilter.favorite ? 'fav' : 'all')));

    // Three distinct states: an empty library, a filter that matched nothing,
    // and results. Showing the "upload your first photo" panel to someone whose
    // search simply missed would be wrong.
    const libraryEmpty = data.total === 0 && !filtersActive();
    $('#photos-empty').hidden = !libraryEmpty;
    $('#photos-no-match').hidden = !(data.total === 0 && filtersActive());

    // Counts describe the whole filtered set, not the pages fetched so far -
    // "12 of 340 photos" would be about the scroll position, not the library.
    $('#photos-sub').textContent = data.total
      ? `${plural(data.total, 'photo')} across ${plural(photoGroups.length, 'month')}` +
        (filtersActive() ? ' · filtered' : '')
      : libraryEmpty ? 'Nothing here yet.' : 'No matches.';
  } finally {
    photoPaging.loading = false;
    if (photoPaging.rerun) {
      photoPaging.rerun = false;
      loadPhotos().catch(() => {});
    }
  }
}

/**
 * Infinite scroll.
 *
 * An IntersectionObserver rather than a scroll handler: it does not fire on
 * every pixel, and a sentinel inside a display:none view has no box at all, so
 * a hidden tab cannot quietly page through its whole library in the
 * background. `loading` guards the case where a fast scroll re-triggers before
 * the previous page lands.
 */
function watchSentinel(selector, hasMore, load) {
  const sentinel = $(selector);
  new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    if (!hasMore() || !currentUser) return;
    load().catch((err) => toast(err.message));
  }, { rootMargin: '400px' }).observe(sentinel);
}

watchSentinel('#library-sentinel', () => libraryPaging.hasMore,
  () => loadLibrary({ append: true }));
watchSentinel('#photos-sentinel', () => photoPaging.hasMore,
  () => loadPhotos({ append: true }));

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
  // Typing starts a new search; a tag picked earlier would silently narrow it.
  photoFilter.tag = null;
  paintSuggestions(e.target.value);
  clearTimeout(photoSearchTimer);
  // Longer than a title filter needed: each query runs the text model.
  photoSearchTimer = setTimeout(() => loadPhotos().catch(() => {}), 350);
});

$('#clear-filters').addEventListener('click', () => {
  photoFilter.q = '';
  photoFilter.favorite = false;
  photoFilter.year = null;
  photoFilter.tag = null;
  $('#photo-search').value = '';
  loadPhotos().catch((err) => toast(err.message));
});

/* ---- smart search: AI tags ----------------------------------------- */

const labelOfTag = (key) => photoTagFacet.find((t) => t.key === key)?.label || key;

/** Picking a tag replaces any typed query: the two would fight otherwise. */
function filterByTag(key) {
  photoFilter.tag = photoFilter.tag === key ? null : key;   // click again to clear
  photoFilter.q = '';
  $('#photo-search').value = '';
  hideSuggestions();
  return loadPhotos().catch((err) => toast(err.message));
}

const TAG_CHIP_LIMIT = 12;

function paintTagChips() {
  const bar = $('#tag-chips');
  bar.replaceChildren();

  // The active tag stays visible even when it is not among the most common,
  // otherwise there would be nothing on screen to click to clear it.
  const shown = photoTagFacet.slice(0, TAG_CHIP_LIMIT);
  const active = photoTagFacet.find((t) => t.key === photoFilter.tag);
  if (active && !shown.includes(active)) shown.push(active);

  bar.hidden = shown.length === 0;
  if (!shown.length) return;

  const label = document.createElement('span');
  label.className = 'tagbar-label';
  label.textContent = 'Tags';
  bar.appendChild(label);

  for (const tag of shown) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip chip-tag${photoFilter.tag === tag.key ? ' is-active' : ''}`;
    chip.dataset.tag = tag.key;
    chip.setAttribute('aria-pressed', String(photoFilter.tag === tag.key));
    chip.innerHTML = '<span></span><em class="chip-count"></em>';
    chip.querySelector('span').textContent = tag.label;
    chip.querySelector('em').textContent = tag.count;
    bar.appendChild(chip);
  }
}

$('#tag-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-tag]');
  if (chip) filterByTag(chip.dataset.tag);
});

/**
 * One line under the header saying what the search actually did. A visual
 * match can look arbitrary - a photo with no matching title appears - so the
 * hint says a model found it.
 */
function paintSearchHint(search, ai) {
  const hint = $('#photo-search-hint');
  hint.replaceChildren();

  const strong = (text) => {
    const el = document.createElement('strong');
    el.textContent = text;
    return el;
  };

  if (photoFilter.tag) {
    hint.append('Showing photos tagged ', strong(labelOfTag(photoFilter.tag)), '.');
  } else if (search && search.mode === 'smart') {
    const parts = ['Matching titles'];
    if (search.tags.length) parts.push(`photos tagged ${search.tags.map((t) => t.label).join(' + ')}`);
    parts.push('photos that look like it');
    hint.append('Smart search for ', strong(`“${search.q}”`), `: ${parts.join(', ')}.`);
  } else if (search && ai?.enabled) {
    // The model is on but could not answer (still loading, or failed).
    hint.append('Searching titles and tags only while the image model loads.');
  }

  hint.hidden = hint.childNodes.length === 0;
}

/**
 * Tags arrive after the photo is ready - the model runs on its own queue - so
 * keep refreshing while any are outstanding. Only from page 1: re-fetching
 * would otherwise throw away the pages someone has scrolled through.
 */
let tagPollTimer = null;
function scheduleTagPoll(ai) {
  clearTimeout(tagPollTimer);
  if (!ai?.tagging || !currentUser) return;
  tagPollTimer = setTimeout(() => {
    if (photoPaging.page === 1) loadPhotos().catch(() => {});
  }, 3000);
}

/* ---- smart search: suggestions (ARIA combobox) ---------------------- */

const SUGGEST_LIMIT = 6;
let suggestIndex = -1;

function hideSuggestions() {
  $('#photo-suggest').hidden = true;
  $('#photo-search').setAttribute('aria-expanded', 'false');
  $('#photo-search').removeAttribute('aria-activedescendant');
  suggestIndex = -1;
}

function paintSuggestions(text) {
  const list = $('#photo-suggest');
  const needle = text.trim().toLowerCase();
  if (!needle) return hideSuggestions();

  // Prefix matches first ("be" -> Beach before Black and white).
  const matches = photoTagFacet
    .filter((t) => t.label.toLowerCase().includes(needle) || t.key.includes(needle))
    .sort((a, b) => Number(b.label.toLowerCase().startsWith(needle)) -
      Number(a.label.toLowerCase().startsWith(needle)))
    .slice(0, SUGGEST_LIMIT);

  list.replaceChildren();
  if (!matches.length) return hideSuggestions();

  matches.forEach((tag, i) => {
    const li = document.createElement('li');
    li.id = `suggest-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.tag = tag.key;
    li.innerHTML = '<span class="sg-kind">Tag</span><span class="sg-label"></span><span class="sg-count"></span>';
    li.querySelector('.sg-label').textContent = tag.label;
    li.querySelector('.sg-count').textContent = plural(tag.count, 'photo');
    list.appendChild(li);
  });

  suggestIndex = -1;
  list.hidden = false;
  $('#photo-search').setAttribute('aria-expanded', 'true');
}

function moveSuggestion(delta) {
  const items = [...$('#photo-suggest').children];
  if (!items.length) return;
  suggestIndex = (suggestIndex + delta + items.length) % items.length;
  items.forEach((li, i) => li.setAttribute('aria-selected', String(i === suggestIndex)));
  $('#photo-search').setAttribute('aria-activedescendant', items[suggestIndex].id);
}

$('#photo-search').addEventListener('keydown', (e) => {
  const open = !$('#photo-suggest').hidden;
  if (e.key === 'ArrowDown' && open) { e.preventDefault(); moveSuggestion(1); }
  else if (e.key === 'ArrowUp' && open) { e.preventDefault(); moveSuggestion(-1); }
  else if (e.key === 'Escape' && open) { e.preventDefault(); hideSuggestions(); }
  else if (e.key === 'Enter') {
    const picked = open && suggestIndex >= 0 && $('#photo-suggest').children[suggestIndex];
    if (picked) {
      e.preventDefault();
      filterByTag(picked.dataset.tag);
    } else {
      // Enter runs the free-text search now rather than after the debounce.
      clearTimeout(photoSearchTimer);
      hideSuggestions();
      loadPhotos().catch((err) => toast(err.message));
    }
  }
});

// mousedown, not click: the input's blur (which hides the list) fires before
// click would, and the option would be gone by the time it landed.
$('#photo-suggest').addEventListener('mousedown', (e) => {
  const li = e.target.closest('[data-tag]');
  if (!li) return;
  e.preventDefault();
  filterByTag(li.dataset.tag);
});

$('#photo-search').addEventListener('blur', hideSuggestions);

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

  $('#photo-date').hidden = !photo.isOwner;
  $('#capture-form').hidden = true;

  paintPhotoTags(photo);
}

/** The AI tags on the open photo; each one filters the timeline to it. */
function paintPhotoTags(photo) {
  const wrap = $('#photo-tags');
  wrap.replaceChildren();

  const tags = photo.tags || [];
  if (tags.length) {
    for (const tag of tags) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip chip-tag';
      chip.dataset.tag = tag.key;
      chip.title = `Show all photos tagged ${tag.label}`;
      chip.innerHTML = '<span></span><em class="tag-score"></em>';
      chip.querySelector('span').textContent = tag.label;
      // The model's confidence, so an odd tag reads as a guess, not a fact.
      chip.querySelector('em').textContent = `${Math.round(tag.score * 100)}%`;
      wrap.appendChild(chip);
    }
  } else if (photo.aiStatus === 'pending') {
    wrap.innerHTML = '<span class="muted-sm">Tagging…</span>';
  }
  wrap.hidden = wrap.childNodes.length === 0;
}

$('#photo-tags').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-tag]');
  if (!chip) return;
  closeLightbox();
  // Always filter to it, even when it is the active tag already.
  photoFilter.tag = null;
  filterByTag(chip.dataset.tag);
});

/**
 * <input type="datetime-local"> has no timezone, so it wants a local-time
 * string - handing it an ISO string with a Z shifts the value by the user's
 * offset, and the date they see is not the date they stored.
 */
function toLocalInputValue(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

$('#photo-date').addEventListener('click', () => {
  if (photoIndex < 0) return;
  const form = $('#capture-form');
  form.capturedAt.value = toLocalInputValue(flatPhotos[photoIndex].capturedAt);
  form.hidden = !form.hidden;
});

async function saveCaptureDate(value) {
  if (photoIndex < 0) return;
  const photo = flatPhotos[photoIndex];

  try {
    const { asset } = await api(`/api/assets/${photo.id}`, {
      method: 'PATCH',
      body: { capturedAt: value },
    });
    // Mutate in place: flatPhotos and photoGroups share these objects, so the
    // timeline picks the new date up without a refetch.
    photo.capturedAt = asset.capturedAt;
    paintPhotoMeta();
    $('#capture-form').hidden = true;
    toast(value === null ? 'Date reset to the upload time' : 'Capture date updated');
    // The date decides which month group it belongs to, so the timeline has to
    // be rebuilt rather than repainted.
    loadPhotos();
  } catch (err) {
    toast(err.message);
  }
}

$('#capture-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = e.currentTarget.capturedAt.value;
  if (!value) return toast('Pick a date, or use Clear to fall back to the upload time');
  // The input gives local time with no zone; let Date attach the browser's.
  saveCaptureDate(new Date(value).toISOString());
});

$('#capture-reset').addEventListener('click', () => saveCaptureDate(null));

function showPhoto(index) {
  if (index < 0 || index >= flatPhotos.length) return;
  photoIndex = index;

  $('#photo-full').src = withToken(flatPhotos[index].originalUrl);
  paintPhotoMeta();

  $('#photo-prev').hidden = index === 0;
  $('#photo-next').hidden = index === flatPhotos.length - 1;

  // Arrowing between photos keeps the lightbox open, so only take focus on the
  // first open - stealing it on every step would fight the arrow keys.
  const overlay = $('#photo-overlay');
  if (overlay.hidden) openModal(overlay);
}

function closeLightbox() {
  closeModal($('#photo-overlay'));
  $('#capture-form').hidden = true;
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

  const deleted = await deleteAsset(photo, () => { loadPhotos(); loadProfile(); });
  if (deleted) closeLightbox();
});

// Both overlays now contain text fields - the description editor and the date
// picker - and "f" for favourite or an arrow for the next photo would fire
// mid-word. Escape still works, because dismissing is always safe.
const isTyping = (target) =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

document.addEventListener('keydown', (e) => {
  const player = $('#player-overlay');
  const lightbox = $('#photo-overlay');
  const palette = $('#palette');

  // Ctrl/Cmd+K toggles the palette from anywhere in the app, even mid-typing:
  // it is the one shortcut people expect to always work.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k' && currentUser) {
    e.preventDefault();
    if (palette.hidden) openPalette(); else closePalette();
    return;
  }
  if (!palette.hidden) {
    trapFocus(palette, e);
    if (e.key === 'Escape') closePalette();
    return;
  }
  if (e.key === 'Escape' && selecting && player.hidden && lightbox.hidden && !isTyping(e.target)) {
    setSelecting(false);
    return;
  }
  // "/" is the other common search key, but only when nothing else wants it.
  if (e.key === '/' && currentUser && player.hidden && lightbox.hidden && !isTyping(e.target)) {
    e.preventDefault();
    openPalette();
    return;
  }

  if (!player.hidden) {
    trapFocus(player, e);
    if (e.key === 'Escape') {
      // Peel off the innermost layer first: menu, then help, then the player.
      if (!$('#pc-speed-menu').hidden) { toggleSpeedMenu(false); $('#pc-speed').focus(); return; }
      if (!$('#keys-help').hidden) return toggleKeysHelp(false);
      $('#player-close').click();
      return;
    }
    // A range input handles its own arrows; everywhere else a text field wins.
    if (e.target.type === 'range' && e.key.startsWith('Arrow')) return;
    if (isTyping(e.target) && e.target.type !== 'range') return;
    if (handlePlayerKey(e)) {
      e.preventDefault();
      wakeControls();
    }
    return;
  }
  if (lightbox.hidden) return;

  trapFocus(lightbox, e);
  if (e.key === 'Escape') return closeLightbox();
  if (isTyping(e.target)) return;
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

/* ---- upload tray ----------------------------------------------------- */

/**
 * Every upload becomes a job in the corner tray and is tracked there from the
 * first byte to "ready". The form is handed back immediately, so a second
 * upload can start while the first is still going, and switching views no
 * longer hides the progress.
 *
 * phase: uploading -> processing -> ready | failed (| cancelled)
 */
const trayJobs = [];
let trayJobSeq = 0;
let trayPollTimer = null;

const isActive = (job) => job.phase === 'uploading' || job.phase === 'processing';

function trayStateText(job) {
  const n = job.assets.length;
  switch (job.phase) {
    case 'uploading': return `${Math.round(job.percent * 100)}%`;
    case 'processing': {
      if (job.kind !== 'photos') return 'Processing…';
      const done = job.assets.filter((a) => a.status === 'ready').length;
      return `Processing ${done}/${n}`;
    }
    case 'ready': {
      const failed = job.assets.filter((a) => a.status === 'failed').length;
      return failed ? `${n - failed} ready · ${failed} failed` : 'Ready';
    }
    case 'cancelled': return 'Cancelled';
    default: return job.error || 'Failed';
  }
}

function paintTray() {
  const tray = $('#tray');
  const list = $('#tray-list');
  tray.hidden = trayJobs.length === 0;
  if (tray.hidden) return;

  const active = trayJobs.filter(isActive).length;
  $('#tray-title').textContent = active ? `${plural(active, 'upload')} in progress` : 'Uploads done';

  list.replaceChildren();
  for (const job of trayJobs) {
    const li = document.createElement('li');
    li.className = `tray-item is-${job.phase === 'cancelled' ? 'failed' : job.phase}`;
    li.innerHTML = `
      <div class="tray-line"><span class="tray-name"></span><span class="tray-state"></span></div>
      <div class="meter"><i></i></div>
      <div class="tray-line tray-actions"></div>`;
    li.querySelector('.tray-name').textContent = job.name;
    li.querySelector('.tray-state').textContent = trayStateText(job);
    li.querySelector('.meter > i').style.width = `${Math.round(job.percent * 100)}%`;

    const actions = li.querySelector('.tray-actions');
    const act = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tray-act';
      b.textContent = label;
      b.setAttribute('aria-label', `${label}: ${job.name}`);
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };

    if (job.phase === 'uploading') act('Cancel', () => job.xhr?.abort());
    if (job.phase === 'ready' && job.kind === 'video' && job.assets[0]?.status === 'ready') {
      act('Play', () => openTrayVideo(job));
    }
    if (job.phase === 'ready' && job.kind === 'photos') act('View photos', () => showView('photos'));
    if (!isActive(job)) act('Dismiss', () => dismissTrayJob(job));
    actions.hidden = actions.childElementCount === 0;

    list.appendChild(li);
  }
}

function dismissTrayJob(job) {
  const i = trayJobs.indexOf(job);
  if (i !== -1) trayJobs.splice(i, 1);
  paintTray();
}

async function openTrayVideo(job) {
  try {
    const { asset } = await api(`/api/assets/${job.assets[0].id}`);
    openPlayer(asset, queueFor($('#library-grid')));
  } catch (err) {
    toast(err.message);
  }
}

// Collapse keeps the jobs; the x clears everything that has finished.
$('#tray-min').addEventListener('click', () => {
  const collapsed = $('#tray').classList.toggle('is-collapsed');
  $('#tray-min').setAttribute('aria-expanded', String(!collapsed));
  $('#tray-min').setAttribute('aria-label', collapsed ? 'Expand uploads' : 'Collapse uploads');
});
$('#tray-close').addEventListener('click', () => {
  for (let i = trayJobs.length - 1; i >= 0; i -= 1) if (!isActive(trayJobs[i])) trayJobs.splice(i, 1);
  paintTray();
});

/**
 * One poll for every job still processing. Asks about each unfinished asset
 * rather than reloading whole grids - a 20-photo batch should not refetch the
 * timeline twenty times.
 */
function scheduleTrayPoll() {
  clearTimeout(trayPollTimer);
  if (!trayJobs.some((j) => j.phase === 'processing') || !currentUser) return;

  trayPollTimer = setTimeout(async () => {
    const pending = trayJobs.filter((j) => j.phase === 'processing');
    await Promise.all(pending.flatMap((job) => job.assets
      .filter((a) => a.status !== 'ready' && a.status !== 'failed')
      .map((a) => api(`/api/assets/${a.id}`)
        .then(({ asset }) => { a.status = asset.status; })
        .catch(() => { a.status = 'failed'; }))));

    const finishedKinds = new Set();
    for (const job of pending) {
      if (job.assets.every((a) => a.status === 'ready' || a.status === 'failed')) {
        job.phase = job.assets.some((a) => a.status === 'ready') ? 'ready' : 'failed';
        if (job.phase === 'failed') job.error = 'Processing failed';
        finishedKinds.add(job.kind);
      }
    }
    // Refresh only the views that just gained something.
    if (finishedKinds.has('video')) { loadLibrary().catch(() => {}); loadCatalog().catch(() => {}); }
    if (finishedKinds.has('photos')) loadPhotos().catch(() => {});

    paintTray();
    scheduleTrayPoll();
  }, 2500);
}

async function startUpload({ kind, name, path, formData }) {
  const job = {
    id: ++trayJobSeq, kind, name, phase: 'uploading', percent: 0, assets: [], xhr: null, error: null,
  };
  trayJobs.unshift(job);
  $('#tray').classList.remove('is-collapsed');
  paintTray();

  // Repainting the whole tray on every progress event would rebuild it dozens
  // of times a second; once per animation frame is plenty.
  let frame = 0;
  const onProgress = (fraction) => {
    job.percent = fraction;
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; paintTray(); });
  };

  try {
    const data = await upload(path, formData, onProgress, (xhr) => { job.xhr = xhr; });
    job.assets = (data.assets || [data.asset]).map((a) => ({ id: a.id, status: a.status }));
    job.phase = 'processing';
    job.percent = 1;
    if (kind === 'video') loadLibrary().catch(() => {});
    else loadPhotos().catch(() => {});
    scheduleTrayPoll();
  } catch (err) {
    job.phase = err.message === 'Upload cancelled' ? 'cancelled' : 'failed';
    job.error = err.message;
  } finally {
    job.xhr = null;
    paintTray();
  }
}

// Closing the tab mid-upload loses the file. Ask first.
window.addEventListener('beforeunload', (e) => {
  if (trayJobs.some((j) => j.phase === 'uploading')) {
    e.preventDefault();
    e.returnValue = '';
  }
});

$('#video-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const status = $('#video-status');

  if (!form.video.files.length) {
    status.className = 'form-msg is-err';
    status.textContent = 'Choose a video first.';
    return;
  }

  const file = form.video.files[0];
  const fd = new FormData();
  fd.append('video', file);
  if (form.title.value.trim()) fd.append('title', form.title.value.trim());
  // The route reads 'public' specifically; an unchecked box sends nothing.
  if (form.shared.checked) fd.append('visibility', 'public');

  startUpload({ kind: 'video', name: form.title.value.trim() || file.name, path: '/api/assets', formData: fd });

  status.className = 'form-msg is-ok';
  status.textContent = 'Uploading. Follow it in the tray - you can keep browsing or add another.';
  form.reset();
  resetVideoDrop();
});

$('#photo-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const status = $('#photo-status');

  if (!form.photos.files.length) {
    status.className = 'form-msg is-err';
    status.textContent = 'Choose at least one photo.';
    return;
  }

  const files = [...form.photos.files].slice(0, 20);
  const fd = new FormData();
  files.forEach((f) => fd.append('photos', f));

  startUpload({
    kind: 'photos',
    name: files.length === 1 ? files[0].name : `${files.length} photos`,
    path: '/api/photos',
    formData: fd,
  });

  status.className = 'form-msg is-ok';
  status.textContent = 'Uploading. Follow it in the tray - you can keep browsing or add another.';
  form.reset();
  resetPhotoDrop();
});

/* ------------------------------------------------------------------ *
 * Command palette (Ctrl+K)
 * ------------------------------------------------------------------ */

const ICONS = {
  go: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 5l7 7-7 7-1.4-1.4 4.6-4.6H4v-2h12.2l-4.6-4.6z"/></svg>',
  upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 17 9h-3.2v6.5h-3.6V9H7zM5 18.5h14V21H5z"/></svg>',
  photo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm2 10.5 3.4-3.9 2.4 2.7 3-3.6L18 17z"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 3a7.5 7.5 0 1 0 4.55 13.46l4.24 4.25 1.42-1.42-4.25-4.24A7.5 7.5 0 0 0 10.5 3m0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H5v16h5v-2H7V6h3zm5.6 3.4L14.2 8.8 16.4 11H9v2h7.4l-2.2 2.2 1.4 1.4L20.2 12z"/></svg>',
};

// Static actions. `keys` are extra words the filter matches on.
const PALETTE_ACTIONS = [
  { label: 'Go to Watch', keys: 'home library videos', icon: 'go', run: () => showView('watch') },
  { label: 'Go to Browse', keys: 'catalog shared explore', icon: 'go', run: () => showView('browse') },
  { label: 'Go to Photos', keys: 'timeline pictures images', icon: 'go', run: () => showView('photos') },
  { label: 'Go to Profile', keys: 'account settings password name', icon: 'go', run: () => showView('profile') },
  { label: 'Upload a video', keys: 'add new file', icon: 'upload', run: () => { showView('upload'); $('#video-form').video.click(); } },
  { label: 'Add photos', keys: 'upload images pictures', icon: 'upload', run: () => { showView('upload'); $('#photo-form').photos.click(); } },
  { label: 'Show favourite photos', keys: 'starred hearts', icon: 'photo', run: () => { photoFilter.favorite = true; showView('photos'); loadPhotos().catch(() => {}); } },
  { label: 'Sign out', keys: 'log out logout', icon: 'out', run: () => signOut() },
];

let paletteItems = [];
let paletteIndex = 0;
let paletteSeq = 0;
let paletteTimer = null;

function openPalette() {
  if (!currentUser) return;
  const overlay = $('#palette');
  if (!overlay.hidden) return;
  // Another dialog underneath would keep its own focus trap; close them first.
  if (!$('#player-overlay').hidden) closePlayer();
  if (!$('#photo-overlay').hidden) closeLightbox();
  openModal(overlay);
  const input = $('#palette-input');
  input.value = '';
  input.focus();
  renderPalette('');
}

function closePalette() {
  clearTimeout(paletteTimer);
  paletteSeq += 1;   // drop any search still in flight
  closeModal($('#palette'));
}

function paletteRow(item, i) {
  const el = document.createElement('div');
  el.className = 'pal-item';
  el.id = `pal-${i}`;
  el.setAttribute('role', 'option');
  el.setAttribute('aria-selected', String(i === paletteIndex));
  el.dataset.index = i;
  el.innerHTML = '<span class="pal-thumb"></span><span class="pal-text"><span class="pal-label"></span><span class="pal-sub"></span></span>';
  const thumb = el.querySelector('.pal-thumb');
  if (item.thumb) {
    const img = document.createElement('img');
    img.src = item.thumb;
    img.alt = '';
    img.loading = 'lazy';
    thumb.appendChild(img);
  } else {
    thumb.innerHTML = ICONS[item.icon] || ICONS.go;
  }
  el.querySelector('.pal-label').textContent = item.label;
  el.querySelector('.pal-sub').textContent = item.sub || '';
  return el;
}

function paintPalette(groups, emptyText) {
  const list = $('#palette-list');
  list.replaceChildren();
  paletteItems = [];

  for (const [title, items] of groups) {
    if (!items.length) continue;
    const head = document.createElement('div');
    head.className = 'pal-group';
    head.setAttribute('role', 'presentation');
    head.textContent = title;
    list.appendChild(head);
    for (const item of items) {
      list.appendChild(paletteRow(item, paletteItems.length));
      paletteItems.push(item);
    }
  }

  if (!paletteItems.length) {
    const none = document.createElement('div');
    none.className = 'pal-empty';
    none.textContent = emptyText;
    list.appendChild(none);
  }
  paletteIndex = clamp(paletteIndex, 0, Math.max(0, paletteItems.length - 1));
  movePalette(0);
}

function movePalette(delta) {
  if (!paletteItems.length) {
    $('#palette-input').removeAttribute('aria-activedescendant');
    return;
  }
  paletteIndex = (paletteIndex + delta + paletteItems.length) % paletteItems.length;
  $('#palette-list').querySelectorAll('.pal-item').forEach((el) =>
    el.setAttribute('aria-selected', String(Number(el.dataset.index) === paletteIndex)));
  const active = $(`#pal-${paletteIndex}`);
  $('#palette-input').setAttribute('aria-activedescendant', active.id);
  active.scrollIntoView({ block: 'nearest' });
}

function runPaletteItem(i) {
  const item = paletteItems[i];
  if (!item) return;
  closePalette();
  item.run();
}

function matchingActions(q) {
  const needle = q.toLowerCase();
  return PALETTE_ACTIONS.filter((a) => `${a.label} ${a.keys}`.toLowerCase().includes(needle));
}

/** Open a photo from a search result: filter the timeline the same way, then show it. */
async function openPhotoResult(query, id) {
  photoFilter.q = query;
  photoFilter.tag = null;
  $('#photo-search').value = query;
  showView('photos');
  await loadPhotos();
  const index = flatPhotos.findIndex((p) => String(p.id) === String(id));
  if (index !== -1) showPhoto(index);
}

async function renderPalette(query) {
  const q = query.trim();
  const seq = ++paletteSeq;
  paletteIndex = 0;

  if (!q) {
    $('#palette-status').textContent = '';
    paintPalette([['Actions', PALETTE_ACTIONS]], '');
    return;
  }

  // Actions answer instantly; the searches fill in when they land.
  paintPalette([['Actions', matchingActions(q)]], 'Searching…');
  $('#palette-status').textContent = 'Searching…';

  const enc = encodeURIComponent(q);
  const [mine, shared, photos] = await Promise.all([
    api(`/api/assets?limit=5&q=${enc}`).catch(() => ({ assets: [] })),
    api(`/api/catalog?limit=5&mine=exclude&q=${enc}`).catch(() => ({ assets: [] })),
    api(`/api/photos?limit=6&q=${enc}`).catch(() => ({ groups: [] })),
  ]);
  if (seq !== paletteSeq) return;   // a newer query has started

  const videoItem = (list) => (a) => ({
    label: a.title,
    sub: [a.ownerName && !a.isOwner ? a.ownerName : null, formatDuration(a.durationSec),
      a.status !== 'ready' ? 'processing' : null].filter(Boolean).join(' · '),
    thumb: posterSrc(a),
    run: () => { if (a.status === 'ready') openPlayer(a, list); else showView('watch'); },
  });

  const photoList = photos.groups.flatMap((g) => g.items);
  const photoItems = photoList.map((p) => ({
    label: p.title,
    sub: [new Date(p.capturedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }),
      p.tags?.slice(0, 2).map((t) => t.label).join(', ')].filter(Boolean).join(' · '),
    thumb: posterSrc(p),
    run: () => openPhotoResult(q, p.id),
  }));
  // Always offer the full photo search, which also covers the visual matches
  // beyond the first six.
  photoItems.push({
    label: `Search photos for “${q}”`,
    sub: photos.search?.mode === 'smart' ? 'Titles, tags and what is in the picture' : 'Titles and tags',
    icon: 'search',
    run: () => openPhotoResult(q, null),
  });

  paintPalette([
    ['Actions', matchingActions(q)],
    ['Your videos', mine.assets.map(videoItem(mine.assets))],
    ['Shared videos', shared.assets.map(videoItem(shared.assets))],
    ['Photos', photoItems],
  ], `Nothing matched “${q}”.`);

  const found = mine.assets.length + shared.assets.length + photoList.length;
  $('#palette-status').textContent = `${plural(found, 'result')}`;
}

$('#palette-input').addEventListener('input', (e) => {
  clearTimeout(paletteTimer);
  const value = e.target.value;
  // Actions filter on every keystroke; the network waits for a pause.
  if (!value.trim()) return renderPalette('');
  paintPalette([['Actions', matchingActions(value.trim())]], 'Searching…');
  paletteTimer = setTimeout(() => renderPalette(value), 220);
});

$('#palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); runPaletteItem(paletteIndex); }
});

$('#palette-list').addEventListener('click', (e) => {
  const row = e.target.closest('.pal-item');
  if (row) runPaletteItem(Number(row.dataset.index));
});

// A click on the dimmed backdrop, not inside the panel, dismisses it.
$('#palette').addEventListener('mousedown', (e) => {
  if (e.target === e.currentTarget) closePalette();
});

$('#palette-open').addEventListener('click', openPalette);

// Mac users expect Cmd, everyone else Ctrl.
if (/Mac|iPhone|iPad/.test(navigator.platform)) $('#palette-hint').textContent = '⌘K';

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

// Installable app. Registration failing (an http origin that is not
// localhost, a locked-down browser) just means no install and no offline
// shell - the app itself is unaffected.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

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
