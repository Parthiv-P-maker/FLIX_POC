/**
 * End-to-end smoke test. Boots nothing itself - run the server first, then:
 *   node testmedia/e2e.js
 */
const fs = require('fs');
const path = require('path');
const { withCaptureDate } = require('./exif');

const BASE = process.env.BASE || 'http://localhost:5000';
const MEDIA = __dirname;

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const formatBytes = (b) => `${(b / (1024 * 1024)).toFixed(1)} MB`;

async function json(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, opts);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

function filePart(p, type) {
  return new File([fs.readFileSync(p)], path.basename(p), { type });
}

async function pollUntilReady(id, token, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const { body } = await json(`/api/assets/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (body.asset && body.asset.status !== 'processing' && body.asset.status !== 'uploading') {
      return body.asset;
    }
    await sleep(500);
  }
  return null;
}

(async function run() {
  console.log(`\nFlixDrive e2e against ${BASE}\n`);

  // ---- health -------------------------------------------------------
  console.log('health');
  {
    const { res, body } = await json('/api/health');
    check('GET /api/health returns 200', res.status === 200, `queueDepth=${body.queueDepth}`);
  }

  // ---- auth ---------------------------------------------------------
  console.log('\nauth');
  const email = `e2e-${Date.now()}@test.local`;
  let token;
  {
    const { res, body } = await json('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123', displayName: 'E2E Runner' }),
    });
    check('register returns 201 + token', res.status === 201 && !!body.token);
    check('password hash is not echoed back', !JSON.stringify(body).includes('passwordHash'));
    token = body.token;
  }
  const auth = { Authorization: `Bearer ${token}` };

  {
    const { res } = await json('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123', displayName: 'Dupe' }),
    });
    check('duplicate register returns 409', res.status === 409);
  }
  {
    const { res, body } = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }),
    });
    check('login returns a token', res.status === 200 && !!body.token);
  }
  {
    const { res } = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong-password' }),
    });
    check('wrong password returns 401', res.status === 401);
  }
  {
    const { res } = await json('/api/assets');
    check('unauthenticated library returns 401', res.status === 401);
  }

  // ---- video upload + processing -------------------------------------
  console.log('\nvideo upload');
  let assetId;
  {
    const fd = new FormData();
    fd.append('title', 'E2E test clip');
    fd.append('video', filePart(path.join(MEDIA, 'clip.mp4'), 'video/mp4'));
    const { res, body } = await json('/api/assets', { method: 'POST', headers: auth, body: fd });
    check('upload returns 202 Accepted', res.status === 202, `status=${body.asset && body.asset.status}`);
    assetId = body.asset && body.asset.id;
  }
  {
    const fd = new FormData();
    fd.append('video', filePart(path.join(MEDIA, 'photo1.jpg'), 'image/jpeg'));
    const { res } = await json('/api/assets', { method: 'POST', headers: auth, body: fd });
    check('non-video rejected with 400', res.status === 400);
  }

  const asset = await pollUntilReady(assetId, token);
  check('worker reached status=ready', asset && asset.status === 'ready', asset && asset.processingError);
  check('ffprobe filled in duration', !!(asset && asset.durationSec > 5), asset && `${asset.durationSec}s`);
  check('ffprobe filled in dimensions', !!(asset && asset.width === 640 && asset.height === 360),
    asset && `${asset.width}x${asset.height}`);
  check('poster was generated', !!(asset && asset.posterUrl));

  if (asset && asset.posterUrl) {
    const res = await fetch(`${asset.posterUrl}?token=${token}`);
    check('poster served through the auth route',
      res.status === 200 && res.headers.get('content-type').startsWith('image/'));
    check('poster is not publicly cacheable',
      (res.headers.get('cache-control') || '').includes('private'),
      res.headers.get('cache-control'));
    await res.arrayBuffer();

    // Regression guard for SEC-01. Posters were once served by express.static
    // off a directory named by asset id, so anyone could walk a private
    // library by incrementing the last hex digit of a URL they had seen.
    const anon = await fetch(asset.posterUrl);
    check('poster refuses an unauthenticated request', anon.status === 401, `got ${anon.status}`);

    const legacy = await fetch(`${BASE}/static/posters/${assetId}.png`);
    check('the old /static/posters mount is gone', legacy.status === 404, `got ${legacy.status}`);
  }

  // ---- range streaming (the critical one) -----------------------------
  console.log('\nrange streaming');
  {
    const res = await fetch(`${BASE}/api/stream/${assetId}?token=${token}`, {
      headers: { Range: 'bytes=0-1023' },
    });
    const cr = res.headers.get('content-range');
    check('partial request returns 206', res.status === 206, `got ${res.status}`);
    check('Content-Range header present', !!cr, cr || 'missing');
    check('Content-Length is exactly 1024', res.headers.get('content-length') === '1024',
      res.headers.get('content-length'));
    check('Accept-Ranges: bytes advertised', res.headers.get('accept-ranges') === 'bytes');
    await res.arrayBuffer();
  }
  {
    const res = await fetch(`${BASE}/api/stream/${assetId}?token=${token}`);
    check('rangeless request returns 200', res.status === 200);
    check('rangeless still advertises ranges', res.headers.get('accept-ranges') === 'bytes');
    await res.arrayBuffer();
  }
  {
    // Seeking past EOF must not crash createReadStream.
    const res = await fetch(`${BASE}/api/stream/${assetId}?token=${token}`, {
      headers: { Range: 'bytes=99999999-' },
    });
    check('out-of-range start returns 416', res.status === 416, `got ${res.status}`);
  }
  {
    // Unsatisfiable per RFC 7233. This used to be clamped into "start to EOF",
    // which answers a question the client never asked.
    const res = await fetch(`${BASE}/api/stream/${assetId}?token=${token}`, {
      headers: { Range: 'bytes=500-100' },
    });
    check('inverted range returns 416', res.status === 416, `got ${res.status}`);
  }
  {
    const res = await fetch(`${BASE}/api/stream/${assetId}`);
    check('stream without token returns 401', res.status === 401);
  }

  // ---- watch progress -------------------------------------------------
  console.log('\nwatch progress');
  {
    const { res, body } = await json(`/api/progress/${assetId}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionSec: 3 }),
    });
    check('PUT progress accepted', res.status === 200 && body.positionSec === 3);
    check('not marked complete at 50%', body.completed === false);
  }
  {
    // Repeat write must upsert, not violate the unique index.
    const { res } = await json(`/api/progress/${assetId}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionSec: 4 }),
    });
    check('repeat PUT upserts cleanly', res.status === 200);
  }
  {
    const { body } = await json('/api/progress/continue', { headers: auth });
    const found = body.items.find((i) => String(i.asset.id) === String(assetId));
    check('appears in continue-watching', !!found, found && `${found.percent}%`);
  }
  {
    const { body } = await json(`/api/progress/${assetId}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionSec: 5.9 }),
    });
    check('past 95% marks completed', body.completed === true);
  }
  {
    const { body } = await json('/api/progress/continue', { headers: auth });
    check('completed title leaves the row', !body.items.some((i) => String(i.asset.id) === String(assetId)));
  }
  {
    const { res } = await json(`/api/progress/${assetId}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionSec: -5 }),
    });
    check('negative position rejected with 400', res.status === 400);
  }

  // ---- photos (phase 3) -----------------------------------------------
  console.log('\nphotos');
  let photoIds = [];
  {
    const fd = new FormData();
    fd.append('photos', filePart(path.join(MEDIA, 'photo1.jpg'), 'image/jpeg'));
    fd.append('photos', filePart(path.join(MEDIA, 'photo2.png'), 'image/png'));
    const { res, body } = await json('/api/photos', { method: 'POST', headers: auth, body: fd });
    check('batch photo upload returns 202', res.status === 202, `count=${body.count}`);
    check('both photos created', body.count === 2);
    photoIds = (body.assets || []).map((a) => a.id);
  }

  const photos = [];
  for (const id of photoIds) photos.push(await pollUntilReady(id, token));

  check('all photos reached ready', photos.every((p) => p && p.status === 'ready'),
    photos.map((p) => p && p.status).join(','));
  check('photo dimensions probed', photos[0] && photos[0].width === 1200 && photos[0].height === 800,
    photos[0] && `${photos[0].width}x${photos[0].height}`);
  check('thumbnails generated', photos.every((p) => p && p.posterUrl));
  check('photos carry capturedAt', photos.every((p) => p && p.capturedAt));
  check('photos expose originalUrl, not streamUrl',
    photos.every((p) => p && p.originalUrl && !p.streamUrl));

  if (photos[0]) {
    const res = await fetch(`${photos[0].posterUrl}?token=${token}`);
    check('thumbnail served through the auth route', res.status === 200);
    await res.arrayBuffer();

    // A photo thumbnail is 640px wide - for a private photo that is the photo,
    // so it has to be at least as protected as the original.
    const anon = await fetch(photos[0].posterUrl);
    check('thumbnail refuses an unauthenticated request', anon.status === 401, `got ${anon.status}`);
    const full = await fetch(`${photos[0].originalUrl}?token=${token}`);
    check('full photo served through auth route', full.status === 200,
      full.headers.get('content-type'));
    await full.arrayBuffer();
  }

  {
    const { body } = await json('/api/photos', { headers: auth });
    check('timeline groups by month', Array.isArray(body.groups) && body.groups.length >= 1,
      body.groups && body.groups.map((g) => `${g.label}(${g.items.length})`).join(' '));
    check('timeline total counts both', body.total === 2, `total=${body.total}`);
  }
  {
    const { body } = await json('/api/assets', { headers: auth });
    check('photos stay out of the video library', !body.assets.some((a) => a.kind === 'photo'),
      `${body.assets.length} video(s)`);
  }
  {
    const { body } = await json('/api/assets?kind=all', { headers: auth });
    check('kind=all returns everything', body.assets.length === 3, `${body.assets.length} assets`);
  }

  // ---- pagination -------------------------------------------------------
  // The API has always paged; nothing ever asked it for page 2, so an
  // off-by-one in skip() would have gone unnoticed. limit=1 forces several
  // pages out of the handful of fixtures already uploaded.
  console.log('\npagination');
  {
    const { body: p1 } = await json('/api/photos?limit=1&page=1', { headers: auth });
    const { body: p2 } = await json('/api/photos?limit=1&page=2', { headers: auth });

    const idOf = (b) => b.groups[0] && b.groups[0].items[0] && String(b.groups[0].items[0].id);

    check('photo page 1 returns exactly one row', p1.groups.reduce((n, g) => n + g.items.length, 0) === 1);
    check('photo page 1 reports more to come', p1.hasMore === true);
    check('photo page 2 is a different photo', idOf(p1) && idOf(p2) && idOf(p1) !== idOf(p2),
      `${idOf(p1)} vs ${idOf(p2)}`);
    check('total counts the whole set, not the page', p1.total === 2, `total=${p1.total}`);
    check('the last photo page reports no more', p2.hasMore === false);

    const { body: a1 } = await json('/api/assets?limit=1&page=1', { headers: auth });
    check('asset page 1 returns exactly one row', a1.assets.length === 1);
    check('asset paging agrees with the total', a1.total === 1 && a1.hasMore === false,
      `total=${a1.total} hasMore=${a1.hasMore}`);

    // Walking past the end is a normal thing for a scroll to do once.
    const { res: beyondRes, body: beyond } = await json('/api/photos?limit=1&page=99', { headers: auth });
    check('a page past the end is empty, not an error',
      beyondRes.status === 200 && beyond.groups.length === 0, `got ${beyondRes.status}`);
  }

  // ---- capture dates --------------------------------------------------
  // The timeline is meaningless if every photo lands on its upload date, and
  // that is exactly what happened before EXIF was parsed properly.
  console.log('\ncapture dates');
  let datedIds = [];
  {
    const taken = new Date(2021, 4, 17, 14, 30, 0);   // 17 May 2021
    const stamped = withCaptureDate(fs.readFileSync(path.join(MEDIA, 'photo1.jpg')), taken);

    const fd = new FormData();
    fd.append('photos', new File([stamped], 'holiday.jpg', { type: 'image/jpeg' }));
    const { body } = await json('/api/photos', { method: 'POST', headers: auth, body: fd });
    datedIds.push(body.assets[0].id);

    const ready = await pollUntilReady(body.assets[0].id, token);
    const got = ready && new Date(ready.capturedAt);
    check('EXIF DateTimeOriginal drives capturedAt',
      !!got && got.getFullYear() === 2021 && got.getMonth() === 4 && got.getDate() === 17,
      got && got.toISOString());

    const { body: tl } = await json('/api/photos', { headers: auth });
    const group = tl.groups.find((g) => g.key === '2021-05');
    check('backdated photo gets its own month group', !!group, group && group.label);
    check('newest month still sorts first', tl.groups[0].key > '2021-05', tl.groups[0].key);
  }
  {
    // A client that knows better than EXIF must win.
    const taken = new Date(2019, 0, 9, 8, 0, 0);
    const stamped = withCaptureDate(fs.readFileSync(path.join(MEDIA, 'photo1.jpg')), new Date(2021, 4, 17));

    const fd = new FormData();
    fd.append('photos', new File([stamped], 'client-dated.jpg', { type: 'image/jpeg' }));
    fd.append('capturedAt', taken.toISOString());
    const { body } = await json('/api/photos', { method: 'POST', headers: auth, body: fd });
    datedIds.push(body.assets[0].id);

    const ready = await pollUntilReady(body.assets[0].id, token);
    const got = ready && new Date(ready.capturedAt);
    check('client-supplied capturedAt overrides EXIF',
      !!got && got.getFullYear() === 2019 && got.getMonth() === 0,
      got && got.toISOString());
  }
  {
    // No EXIF at all is normal (screenshots, exports) - upload time is right.
    const fd = new FormData();
    fd.append('photos', filePart(path.join(MEDIA, 'photo2.png'), 'image/png'));
    const { body } = await json('/api/photos', { method: 'POST', headers: auth, body: fd });
    datedIds.push(body.assets[0].id);

    const ready = await pollUntilReady(body.assets[0].id, token);
    const got = ready && new Date(ready.capturedAt);
    const ageMs = Math.abs(Date.now() - got.getTime());
    check('photo without EXIF falls back to upload time', ageMs < 5 * 60 * 1000,
      `${Math.round(ageMs / 1000)}s ago`);
  }
  for (const id of datedIds) {
    await json(`/api/assets/${id}`, { method: 'DELETE', headers: auth });
  }

  // ---- profile ---------------------------------------------------------
  console.log('\nprofile');
  {
    const { res, body } = await json('/api/profile', { headers: auth });
    check('GET /api/profile returns 200', res.status === 200);
    check('reports the video count', body.stats.videos === 1, `videos=${body.stats.videos}`);
    check('reports the photo count', body.stats.photos === 2, `photos=${body.stats.photos}`);
    check('reports storage used', body.stats.storageBytes > 0, formatBytes(body.stats.storageBytes));
    check('reports library runtime', body.stats.librarySec > 5, `${body.stats.librarySec}s`);
    check('does not leak the hash', !JSON.stringify(body).includes('passwordHash'));
  }
  {
    const { res, body } = await json('/api/profile', {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Renamed Runner' }),
    });
    check('PATCH updates the display name', res.status === 200 && body.user.displayName === 'Renamed Runner');

    const { body: me } = await json('/api/auth/me', { headers: auth });
    check('rename persists', me.user.displayName === 'Renamed Runner');
  }
  {
    const { res } = await json('/api/profile', {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '   ' }),
    });
    check('blank display name rejected', res.status === 400);
  }
  {
    const { res } = await json('/api/profile/password', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'wrong-one', newPassword: 'brand-new-pass' }),
    });
    check('wrong current password returns 401', res.status === 401);
  }
  {
    const { res } = await json('/api/profile/password', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'password123', newPassword: 'short' }),
    });
    check('short new password returns 400', res.status === 400);
  }
  {
    const { res } = await json('/api/profile/password', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'password123', newPassword: 'password123' }),
    });
    check('reusing the same password returns 400', res.status === 400);
  }
  {
    const { res } = await json('/api/profile/password', {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'password123', newPassword: 'a-better-password' }),
    });
    check('password change succeeds', res.status === 200);

    const { res: oldLogin } = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }),
    });
    check('old password stops working', oldLogin.status === 401);

    const { res: newLogin } = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-better-password' }),
    });
    check('new password works', newLogin.status === 200);

    // Tokens are signed with the server secret, not the password.
    const { res: stillMe } = await json('/api/auth/me', { headers: auth });
    check('existing token still valid after change', stillMe.status === 200);
  }
  {
    const { res } = await json('/api/profile');
    check('profile requires auth', res.status === 401);
  }

  // ---- isolation between users ----------------------------------------
  console.log('\naccess control');
  // Hoisted: the shared-catalog section below needs a second identity to
  // prove that sharing actually crosses the ownership boundary.
  let otherToken;
  let otherAuth;
  {
    const { body: other } = await json('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `other-${Date.now()}@test.local`,
        password: 'password123',
        displayName: 'Someone Else',
      }),
    });
    otherToken = other.token;
    otherAuth = { Authorization: `Bearer ${otherToken}` };

    const { res: detail } = await json(`/api/assets/${assetId}`, { headers: otherAuth });
    check("another user cannot read a private asset", detail.status === 403, `got ${detail.status}`);

    const stream = await fetch(`${BASE}/api/stream/${assetId}?token=${other.token}`);
    check("another user cannot stream it", stream.status === 403, `got ${stream.status}`);

    // The poster is derived from a private original, so it inherits its rules.
    const poster = await fetch(`${BASE}/api/posters/${assetId}?token=${other.token}`);
    check("another user cannot fetch its poster", poster.status === 403, `got ${poster.status}`);

    const { body: lib } = await json('/api/assets', { headers: otherAuth });
    check('new user sees an empty library', lib.assets.length === 0);
  }
  {
    const { res } = await json('/api/assets/not-a-real-objectid', { headers: auth });
    check('malformed id returns 400, not 500', res.status === 400, `got ${res.status}`);
  }

  // ---- sharing + the public catalog -------------------------------------
  // The catalog is the one read path that crosses ownerId on purpose, so
  // every assertion here is really about the boundary holding in both
  // directions: shared means visible, unshared means gone again.
  console.log('\nshared catalog');
  const jsonAuth = (headers) => ({ ...headers, 'Content-Type': 'application/json' });
  {
    const { body: before } = await json('/api/catalog', { headers: otherAuth });
    check('private video is absent from the catalog',
      !before.assets.some((a) => String(a.id) === String(assetId)), `total=${before.total}`);
  }
  {
    const { res, body } = await json(`/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ shared: true }),
    });
    check('PATCH shared=true returns 200', res.status === 200 && body.asset.shared === true);
    check('sharing stamps sharedAt', !!(body.asset && body.asset.sharedAt));
  }
  {
    const { body } = await json('/api/catalog', { headers: otherAuth });
    const found = body.assets.find((a) => String(a.id) === String(assetId));
    check('shared video reaches another account\'s catalog', !!found);
    check('catalog credits the uploader', found && found.ownerName === 'Renamed Runner',
      found && String(found.ownerName));
    check('catalog marks it not-owned for the viewer', found && found.isOwner === false);
  }
  {
    const { res } = await json(`/api/assets/${assetId}`, { headers: otherAuth });
    check('another user can now read the detail', res.status === 200, `got ${res.status}`);

    const stream = await fetch(`${BASE}/api/stream/${assetId}?token=${otherToken}`, {
      headers: { Range: 'bytes=0-1023' },
    });
    check('another user can range-stream it', stream.status === 206, `got ${stream.status}`);
    await stream.arrayBuffer();

    // Browse renders other people's posters, so authorising them must not have
    // broken the shared case - it is the reason the check is visibility-based
    // rather than owner-only.
    const poster = await fetch(`${BASE}/api/posters/${assetId}?token=${otherToken}`);
    check('another user can fetch a shared poster', poster.status === 200, `got ${poster.status}`);
    await poster.arrayBuffer();
  }
  {
    // Sharing grants read, never write. Both of these are the same 404 a
    // missing id would give, so a stranger learns nothing about what exists.
    const { res: unshare } = await json(`/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: jsonAuth(otherAuth),
      body: JSON.stringify({ shared: false }),
    });
    check('non-owner cannot unshare it', unshare.status === 404, `got ${unshare.status}`);

    const { res: del } = await json(`/api/assets/${assetId}`, {
      method: 'DELETE',
      headers: otherAuth,
    });
    check('non-owner cannot delete it', del.status === 404, `got ${del.status}`);
  }
  {
    const { res } = await json(`/api/assets/${assetId}/view`, { method: 'POST', headers: otherAuth });
    check('view bump accepted from a non-owner', res.status === 200);

    const { body } = await json('/api/catalog?sort=trending', { headers: otherAuth });
    const found = body.assets.find((a) => String(a.id) === String(assetId));
    check('view counter increments', found && found.viewCount >= 1, found && `${found.viewCount}`);
  }
  {
    const { body: hit } = await json(`/api/catalog?q=${encodeURIComponent('E2E test')}`, { headers: otherAuth });
    check('catalog search matches the title',
      hit.assets.some((a) => String(a.id) === String(assetId)), `total=${hit.total}`);

    const { body: miss } = await json('/api/catalog?q=zzz-definitely-not-there', { headers: otherAuth });
    check('catalog search excludes non-matches', miss.total === 0, `total=${miss.total}`);

    // A raw regex here would match every title in the catalog.
    const { body: meta } = await json(`/api/catalog?q=${encodeURIComponent('.*')}`, { headers: otherAuth });
    check('catalog escapes regex metacharacters', meta.total === 0, `total=${meta.total}`);
  }
  {
    const { body } = await json('/api/catalog?mine=exclude', { headers: auth });
    check('mine=exclude drops your own uploads',
      !body.assets.some((a) => String(a.id) === String(assetId)));
  }
  {
    const { body: summary } = await json('/api/catalog/summary', { headers: auth });
    check('summary counts your contribution', summary.mine >= 1, `mine=${summary.mine}`);

    const { body: prof } = await json('/api/profile', { headers: auth });
    check('profile reports the shared count', prof.stats.shared === 1, `shared=${prof.stats.shared}`);
  }
  {
    const { body } = await json(`/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ shared: false }),
    });
    check('unsharing clears sharedAt',
      body.asset.shared === false && body.asset.sharedAt === null, String(body.asset.sharedAt));

    const { res } = await json(`/api/assets/${assetId}`, { headers: otherAuth });
    check('unshared video is private again', res.status === 403, `got ${res.status}`);

    const { body: cat } = await json('/api/catalog', { headers: otherAuth });
    check('unshared video leaves the catalog',
      !cat.assets.some((a) => String(a.id) === String(assetId)));
  }

  // ---- share by link (unlisted) -----------------------------------------
  console.log('\nshare by link');
  {
    const { res, body } = await json(`/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ visibility: 'unlisted' }),
    });
    check('PATCH visibility=unlisted returns 200', res.status === 200, `got ${res.status}`);
    check('unlisted is not "shared"', body.asset.shared === false && body.asset.linkShared === true);
    check('owner is given a share link', typeof body.asset.shareUrl === 'string',
      body.asset.shareUrl);

    const slug = new URL(body.asset.shareUrl, BASE).searchParams.get('s');
    check('the slug is 128 bits of hex', /^[a-f0-9]{32}$/.test(slug || ''), slug);

    // The whole point: no account, no token, still plays.
    const { res: metaRes, body: meta } = await json(`/api/share/${slug}`);
    check('share metadata needs no auth at all', metaRes.status === 200, `got ${metaRes.status}`);
    check('share payload carries a media url', typeof meta.mediaUrl === 'string');
    check('share payload does not leak the owner',
      meta.ownerId === undefined && meta.ownerName === undefined);
    check('share payload does not leak view counts or size',
      meta.viewCount === undefined && meta.sizeBytes === undefined);

    const anonStream = await fetch(`${BASE}/api/share/${slug}/media`, {
      headers: { Range: 'bytes=0-1023' },
    });
    check('anonymous range request returns 206', anonStream.status === 206, `got ${anonStream.status}`);
    check('anonymous stream sends Content-Range', !!anonStream.headers.get('content-range'),
      anonStream.headers.get('content-range'));
    await anonStream.arrayBuffer();

    const anonPoster = await fetch(`${BASE}/api/share/${slug}/poster`);
    check('anonymous poster returns 200', anonPoster.status === 200, `got ${anonPoster.status}`);
    await anonPoster.arrayBuffer();

    // Unlisted means link-only. Knowing the id must not be enough, even for a
    // signed-in account - ObjectIds are too predictable for that.
    const { res: byId } = await json(`/api/assets/${assetId}`, { headers: otherAuth });
    check('unlisted is not readable by id', byId.status === 403, `got ${byId.status}`);

    const byIdStream = await fetch(`${BASE}/api/stream/${assetId}?token=${otherToken}`);
    check('unlisted is not streamable by id', byIdStream.status === 403, `got ${byIdStream.status}`);

    const { body: cat } = await json('/api/catalog', { headers: otherAuth });
    check('unlisted stays out of the catalog',
      !cat.assets.some((a) => String(a.id) === String(assetId)));

    const bogus = await fetch(`${BASE}/api/share/${'0'.repeat(32)}`);
    check('an unknown slug returns 404', bogus.status === 404, `got ${bogus.status}`);

    // Revoking has to kill the link, not just hide the asset.
    await json(`/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ visibility: 'private' }),
    });
    const revoked = await fetch(`${BASE}/api/share/${slug}`);
    check('revoking the share kills the link', revoked.status === 404, `got ${revoked.status}`);
    const revokedMedia = await fetch(`${BASE}/api/share/${slug}/media`);
    check('revoked link cannot stream either', revokedMedia.status === 404, `got ${revokedMedia.status}`);

    // Re-sharing mints a fresh slug rather than resurrecting the old one.
    const { body: reshared } = await json(`/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ visibility: 'unlisted' }),
    });
    const newSlug = new URL(reshared.asset.shareUrl, BASE).searchParams.get('s');
    check('re-sharing does not reuse the revoked slug', newSlug !== slug);

    await json(`/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ visibility: 'private' }),
    });
  }

  // ---- descriptions + capture dates --------------------------------------
  console.log('\nmetadata editing');
  {
    const { res, body } = await json(`/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ description: 'A test pattern, six seconds long.' }),
    });
    check('PATCH description returns 200', res.status === 200, `got ${res.status}`);
    check('description round-trips', body.asset.description === 'A test pattern, six seconds long.');

    const { body: cleared } = await json(`/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ description: '' }),
    });
    check('an empty description clears it', cleared.asset.description === '');

    const tooLong = await json(`/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ description: 'x'.repeat(2001) }),
    });
    check('an over-long description is rejected', tooLong.res.status === 400, `got ${tooLong.res.status}`);

    const onVideo = await json(`/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ capturedAt: '2020-01-01T00:00:00.000Z' }),
    });
    check('capturedAt is rejected on a video', onVideo.res.status === 400, `got ${onVideo.res.status}`);

    // Remember the real date: the year-facet checks further down count photos
    // by year, so moving one to 2019 and leaving it there would fail a test
    // that has nothing to do with this one.
    const { body: before } = await json(`/api/assets/${photoIds[0]}`, { headers: auth });
    const originalCapturedAt = before.asset.capturedAt;

    const { res: pRes, body: pBody } = await json(`/api/assets/${photoIds[0]}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ capturedAt: '2019-07-04T12:30:00.000Z' }),
    });
    check('capturedAt is accepted on a photo', pRes.status === 200, `got ${pRes.status}`);
    check('capturedAt round-trips',
      new Date(pBody.asset.capturedAt).toISOString() === '2019-07-04T12:30:00.000Z',
      pBody.asset.capturedAt);

    const future = await json(`/api/assets/${photoIds[0]}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ capturedAt: '2999-01-01T00:00:00.000Z' }),
    });
    check('a future capturedAt is rejected', future.res.status === 400, `got ${future.res.status}`);

    const { body: restored } = await json(`/api/assets/${photoIds[0]}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ capturedAt: originalCapturedAt }),
    });
    check('the original capture date is restored',
      new Date(restored.asset.capturedAt).toISOString() === new Date(originalCapturedAt).toISOString(),
      restored.asset.capturedAt);

    const bothFlags = await json(`/api/assets/${assetId}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ shared: true, visibility: 'unlisted' }),
    });
    check('shared and visibility together are rejected', bothFlags.res.status === 400,
      `got ${bothFlags.res.status}`);
  }

  // ---- favourites + photo filters ---------------------------------------
  console.log('\nphoto filters');
  {
    const { res, body } = await json(`/api/assets/${photoIds[0]}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ favorite: true }),
    });
    check('PATCH favorite=true returns 200', res.status === 200 && body.asset.favorite === true);
  }
  {
    const { body } = await json('/api/photos?favorite=1', { headers: auth });
    check('favourite filter returns only starred rows', body.total === 1, `total=${body.total}`);
    check('facet reports the favourite count', body.facets.favorites === 1,
      `favorites=${body.facets.favorites}`);
  }
  {
    const { body } = await json('/api/photos', { headers: auth });
    // Facets must describe the whole library, not the filtered page, or the
    // chips would disappear the moment one of them was clicked.
    check('facets list years across the library',
      Array.isArray(body.facets.years) && body.facets.years.length >= 1,
      body.facets.years.map((y) => `${y.year}(${y.count})`).join(' '));
  }
  {
    const year = new Date().getFullYear();
    const { body: hit } = await json(`/api/photos?year=${year}`, { headers: auth });
    check('year filter keeps this year\'s photos', hit.total === 2, `total=${hit.total}`);

    const { body: miss } = await json('/api/photos?year=1990', { headers: auth });
    check('year with nothing in it returns empty', miss.total === 0, `total=${miss.total}`);
  }
  {
    const { body: hit } = await json('/api/photos?q=photo1', { headers: auth });
    check('photo search matches titles', hit.total === 1, `total=${hit.total}`);

    const { body: meta } = await json(`/api/photos?q=${encodeURIComponent('.*')}`, { headers: auth });
    check('photo search escapes regex metacharacters', meta.total === 0, `total=${meta.total}`);
  }
  {
    const { res } = await json(`/api/assets/${photoIds[0]}`, {
      method: 'PATCH',
      headers: jsonAuth(auth),
      body: JSON.stringify({ favorite: 'yes-please' }),
    });
    check('non-boolean favorite rejected with 400', res.status === 400, `got ${res.status}`);
  }

  // ---- delete -----------------------------------------------------------
  console.log('\ndelete');
  {
    const { res, body } = await json(`/api/assets/${assetId}`, { method: 'DELETE', headers: auth });
    check('delete returns ok', res.status === 200 && body.deleted === true);

    const { res: after } = await json(`/api/assets/${assetId}`, { headers: auth });
    check('asset is gone afterwards', after.status === 404);

    const { body: cont } = await json('/api/progress/continue', { headers: auth });
    check('progress rows cleaned up', !cont.items.some((i) => String(i.asset.id) === String(assetId)));
  }
  for (const id of photoIds) {
    await json(`/api/assets/${id}`, { method: 'DELETE', headers: auth });
  }
  {
    const { body } = await json('/api/photos', { headers: auth });
    check('photos deleted too', body.total === 0);
  }

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log(`${'='.repeat(46)}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nRunner crashed:', err);
  process.exit(1);
});
