# FlixDrive — personal media library

Auth, upload, media processing, and HTTP range streaming for a Netflix-style
player, plus a photo timeline. Videos and photos share one `MediaAsset`
document, separated by a `kind` discriminator.

Uploads are **private by default**. A video can be shared two ways: into a
public catalog every account can browse, or by an unguessable link that works
without an account at all — see [Sharing](#sharing).

## Requirements

- Node 18+ (the code uses `fs/promises` and global `fetch`)
- MongoDB running locally, or an Atlas connection string

`ffmpeg` does **not** need to be installed. `ffmpeg-static` and `ffprobe-static`
ship the binaries with `npm install`, so the same code runs on Windows, WSL,
macOS, and a grader's machine without a PATH difference.

> If `npm install` is interrupted, `ffmpeg-static` can end up without its
> binary (npm will not re-run the postinstall on a later `npm install`).
> Symptom: `spawn .../ffmpeg.exe ENOENT` when processing starts. Fix:
> `node node_modules/ffmpeg-static/install.js`.

## Setup

```bash
npm install
cp .env.example .env        # then edit JWT_SECRET
npm run dev
```

Then open <http://localhost:5000> — the client is served from the same origin
as the API. Register an account, upload a video, and it appears under **Watch**
once the worker finishes.

Five views: **Watch** (hero + continue-watching + your library), **Browse**
(the shared catalog — trending, new, and other members' uploads, with search),
**Photos** (capture-date timeline, justified grid, favourites, AI tags, smart
search and bulk select), **Upload** (drag-and-drop), and **Profile** (library
stats, rename, password change).

Across the app:

- **Player** with its own controls: thumbnail previews while scrubbing, a
  speed menu, picture-in-picture, fullscreen, YouTube-style keyboard shortcuts
  (press <kbd>?</kbd> in the player) and an "Up next" card that plays the next
  video in the row it was opened from.
- **Upload tray** in the corner that tracks every upload and its processing
  across views. Several uploads can run at once, and each can be cancelled.
- **Command palette** (<kbd>Ctrl</kbd>+<kbd>K</kbd> or <kbd>/</kbd>): one
  search across your videos, the catalog and your photos, plus quick actions.
- **Skeleton loaders** while the first data arrives, and written empty states.
- **Phone layout** with a bottom tab bar that clears the home indicator.
- **Installable** as an app (manifest + service worker). The worker caches only
  the app shell, never anything under `/api`.

## Smart photo search

Every photo is tagged by CLIP (`Xenova/clip-vit-base-patch32`, quantised),
running in-process through transformers.js — no Python, no API key. The first
start downloads ~150 MB into `.model-cache/`; after that it loads in about a
second and tags a photo in ~0.1 s. Photos become `ready` before they are
tagged, and the tagger runs on its own queue so it never delays a thumbnail.

- **Tags** are zero-shot: each label in `src/config/tagVocabulary.js` is a
  caption, and a photo keeps the (up to four) captions the model clearly
  prefers. Adding a tag is adding a line. Changing the vocabulary or the model
  re-tags the library at the next boot.
- **Search** (`GET /api/photos?q=`) matches a photo if its title contains the
  text, *or* it carries the tags the words name ("puppies" → dog), *or* CLIP
  ranks it among the closest images to the text — so "girl with pink eyes"
  works with no tag for it.
- `ML_ENABLED=false` turns it off and search falls back to titles. `npm test`
  runs that way; `npm run test:ml` checks the model itself.

Files land in `storage/uploads` (video), `storage/photos` (photo originals) and
`storage/posters` (posters + thumbnails). All are gitignored. Set
`STORAGE_ROOT` to put them somewhere else.

## Layout

```
src/
  server.js               app wiring, security headers, route mounting, shutdown
  config/paths.js         storage dirs; sourcePathFor(asset) resolves bytes
  config/db.js            mongoose connection
  models/                 User, MediaAsset, WatchProgress, PasswordReset
  middleware/
    auth.js               session vs media tokens; requireAuth
    assetAccess.js        the one visibility rule, shared by stream + posters
    upload.js             multer config, MIME allowlists
    errorHandler.js       thrown error -> HTTP response; orphan cleanup
  routes/                 auth, profile, assets, catalog, photos,
                          stream, posters, share, progress
  config/tagVocabulary.js the labels the image classifier can assign
  services/
    mediaProcessor.js     ffmpeg/ffprobe worker, in-process queue, boot recovery,
                          scrub-preview sprites
    imageTagger.js        CLIP tagging queue, smart search, boot backfill
    assetCleanup.js       deletes an asset's files and rows (single and bulk)
    mailer.js             outbound mail seam (console in development)
  utils/
    rangeStream.js        Range parsing + safe piping, shared by both routes
    asyncHandler.js       routes async rejections into next()
    formField.js          reads a multipart text field that may be an array
public/
  index.html app.js       the SPA
  share.html share.js     standalone viewer for a share link (no account)
  reset.html reset.js     standalone password reset page
  styles.css
  sw.js manifest.webmanifest icons/   the installable app shell
testmedia/
  run-tests.js            `npm test` — owns the whole lifecycle
  e2e.js                  198 assertions
  ml-check.js             `npm run test:ml` — the image model itself
  seed.js exif.js         demo data, EXIF fixture builder
```

### A CSS trap worth knowing

`hidden` is only `display: none` in the *user-agent* stylesheet, so any
author-level `display` rule beats it and the element stays on screen. Several
selectors here set one, which put both modals on top of the login form until
this landed in `styles.css`:

```css
[hidden] { display: none !important; }
```

When verifying visibility, check `getComputedStyle(el).display` — reading
`el.hidden` returns `true` for an element that is plainly visible.

### Two traps in the justified photo grid

The timeline packs photos into rows that fill the container exactly, which
means the layout is solved against a measured width. Both of these produced a
visibly broken grid during development:

- **The scrollbar is caused by the thing it breaks.** Laying out a tall
  timeline is what makes the page scroll, and the scrollbar that then appears
  narrows the container the rows were just solved against — so every row
  overflows by exactly the scrollbar width. `renderTimeline()` re-measures
  after building the DOM and lays out once more if the width moved.
- **`ResizeObserver` does not rescue the first reveal.** A `display: none`
  container has no box, so the timeline loaded while another tab was open
  renders into a zero-width container and silently produces nothing. The
  observer cannot be relied on to deliver the transition back to visible, so
  `showView()` triggers the layout instead; the observer only handles genuine
  resizes of an already-visible grid.

Row height and gap are returned together by `rowMetrics()` and applied inline,
because the solver has to subtract exactly the gap the DOM will render — a
gap set only in CSS drifts out of step at the mobile breakpoint and the rows
overflow again.

### Why tiles are `<div>`s, not `<button>`s

A tile is one big click target that also carries its own delete control. A
`<button>` inside a `<button>` is invalid, and browsers resolve it by dropping
the inner one from the accessibility tree — so while the tile was a button, its
actions were reachable by mouse only. Each card is now a `<div>` whose primary
control is a real button with a stretched `::after` covering the card, and the
actions are ordinary buttons layered above it. One control in the
accessibility tree, the whole card still clickable, everything keyboard
reachable.

## API

| Method | Route | Notes |
|---|---|---|
| POST | `/api/auth/register` | `{ email, password, displayName }` → user + JWT |
| POST | `/api/auth/login` | `{ email, password }` → user + JWT. Rate limited |
| GET | `/api/auth/me` | Bearer token |
| GET | `/api/auth/media-token` | Exchanges the session token for a short-lived media one |
| POST | `/api/auth/forgot-password` | `{ email }`. Always the same answer |
| POST | `/api/auth/reset-password` | `{ token, newPassword }`. Single use |
| GET | `/api/profile` | Account details + library stats |
| PATCH | `/api/profile` | `{ displayName }` |
| PUT | `/api/profile/password` | `{ currentPassword, newPassword }` |
| POST | `/api/assets` | multipart, field `video`. Returns **202**. `visibility=public` shares on upload |
| GET | `/api/assets` | Your video library. `?limit=`, `?page=`, `?kind=photo\|all`, `?q=` title search |
| GET | `/api/assets/:id` | Poll this until `status === "ready"` |
| PATCH | `/api/assets/:id` | Owner only. `{ shared?, visibility?, favorite?, title?, description?, capturedAt? }` |
| POST | `/api/assets/:id/view` | Bumps the play count behind the Trending rail |
| DELETE | `/api/assets/:id` | Removes DB rows + files on disk (either kind) |
| GET | `/api/catalog` | **Everyone's** public videos. `?sort=new\|trending`, `?q=`, `?mine=exclude` |
| GET | `/api/catalog/summary` | Totals for the Browse header |
| POST | `/api/photos` | multipart, field `photos`, up to 20. Returns **202** |
| GET | `/api/photos` | Timeline grouped by capture month. `?q=` smart search, `?tag=`, `?favorite=1`, `?year=`, `?page=`. Returns tag facets |
| POST | `/api/photos/bulk` | `{ ids, action: favorite\|unfavorite\|delete }`. Only the caller's photos are touched |
| GET | `/api/stream/:id?token=MEDIA` | Range-request playback (also serves photo originals) |
| GET | `/api/posters/:id?token=MEDIA` | Poster frame or photo thumbnail |
| GET | `/api/posters/:id/sprite?token=MEDIA` | Scrub-preview sprite sheet for a video |
| GET | `/api/share/:slug` | **No auth.** Metadata for a share link |
| GET | `/api/share/:slug/media` | **No auth.** Range-request playback |
| GET | `/api/share/:slug/poster` | **No auth.** Poster for a share link |
| PUT | `/api/progress/:assetId` | `{ positionSec }`, called every ~10s |
| GET | `/api/progress/continue` | The "Continue watching" row |
| GET | `/api/health` | Includes current ffmpeg queue depth |

## Two kinds of token

A `<video src>` and an `<img src>` cannot send an `Authorization` header, so
those routes have no choice but to take a credential in the query string. The
question is *which* credential.

Putting the session JWT there — which this used to do — meant a 7-day key to
the whole account was written into every access log, every browser history
entry, and every `Referer` a share page sent. So there are two:

| | Session token | Media token |
|---|---|---|
| Sent as | `Authorization` header only | `?token=` only |
| Authorises | everything | reading media bytes |
| Lives | 7 days | 2 hours (`MEDIA_TOKEN_TTL`) |

Each is **refused** where the other belongs. A media token accepted in a header
would just be a session token with a shorter expiry, so the check runs both
ways. The client swaps one for the other at sign-in and refreshes on a timer.

`morgan` also redacts `token=` from its output, because the media token is
still a credential.

## Sharing

`GET /api/catalog` and `/api/share/*` are the only read paths that deliberately
cross the `ownerId` boundary. Everything else — the library, the photo
timeline, profile stats — stays scoped to the caller.

Three visibility states:

- **`private`** (the default). Nobody else can list it, read it, or stream it;
  detail, stream and poster routes all answer **403**.
- **`public`** — `PATCH { shared: true }`. Appears in every account's Browse
  view, credited to the uploader's display name.
- **`unlisted`** — `PATCH { visibility: 'unlisted' }`. Reachable only through a
  share link. It stays out of the catalog, and out of id-based reads too: a
  signed-in stranger who guesses the ObjectId still gets 403.

The rules, all enforced server-side:

- Sharing grants **read only**. Rename, re-share and delete stay owner-only,
  and a non-owner attempting them gets **404** — the same answer a missing id
  gives, so a stranger learns nothing about what exists.
- Un-sharing is immediate and total: `sharedAt` is cleared, the share slug is
  destroyed, and the video drops back to 403 for everyone else.

Watch progress stays per-user throughout, so two people watching the same
shared video keep separate resume positions — the Netflix-profile behaviour,
without a profile concept.

### How a share link works

`shareSlug` is 128 bits of CSPRNG output. Possession of it *is* the
authorisation — that is the whole point, since the recipient has no account —
so the rules around it are tight:

- Lookup is by slug only. There is no route from an asset id to a share
  response, so an unlisted asset cannot be found by walking ObjectIds.
- A slug exists only while the asset is shared. Going private nulls it, which
  is what makes revocation real: a link handed out before stops working, and
  re-sharing mints a *different* one rather than resurrecting the old.
- The share payload is hand-built rather than reusing `toPublic()`, which
  carries `ownerId`, the owner's display name, view counts and file size. An
  anonymous viewer gets what they need to watch and nothing else.
- `share.html` is a standalone page. Serving the SPA to someone with no account
  would just show them the auth gate.

A `pre('save')` hook keeps `sharedAt` and `shareSlug` in step with `visibility`
so no route has to remember to. Note that `insertMany` bypasses that hook,
which is why the photo upload route sets both by hand.

> **Index footgun.** `shareSlug` must use a *partial* index, not a sparse one.
> A sparse index still indexes an explicit `null`, and `default: null` plus
> `insertMany` writes one for every unshared row — so the second photo in a
> batch collided on the unique index. `partialFilterExpression: { shareSlug:
> { $type: 'string' } }` indexes only real slugs.

### Why the play counter is its own route

`POST /api/assets/:id/view` looks redundant next to the stream route, but
counting inside `/api/stream` would rank the Trending rail by *seek count* — a
single viewing issues dozens of range requests. The client bumps it once, when
the player opens.

### Photos: where `capturedAt` comes from

A timeline grouped by *upload* date is close to useless, so capture date is
resolved in this order:

1. A `capturedAt` field sent alongside the upload — a client with access to the
   OS photo library knows the real date even when EXIF has been stripped.
2. EXIF `DateTimeOriginal`, then `CreateDate`, then `ModifyDate`, read with
   `exifr`.
3. Upload time. Correct for screenshots and exports, which genuinely have no
   capture date.

The owner can correct it afterwards from the lightbox; `PATCH { capturedAt:
null }` puts a photo back on the fallback.

Two traps worth knowing, both of which produced silently wrong timelines
during development:

- **ffprobe cannot do this.** It reports no tag block at all for JPEG, which is
  why `exifr` is a dependency rather than reusing the probe already being run
  for dimensions.
- **File mtime is not a fallback.** Multer writes a fresh file on upload, so the
  stored copy's mtime is always the upload moment.

### Password reset

Tokens are 256 bits of CSPRNG output, stored as a SHA-256 hash so a leaked
backup cannot be used to take over accounts. Single use, expiring via a TTL
index, and requesting a second retires the first. `forgot-password` answers
identically whether or not the address is registered.

**Delivery is a stub.** There is no SMTP account behind this project, so
`services/mailer.js` prints the link to the server console and says plainly
that nothing was sent — a reset that appears to work and silently delivers
nothing would be worse. Wiring up nodemailer is a change to that one file.

## Hosting a demo

Enough to put it online for a demo, not a production setup:

- **Database:** a free MongoDB Atlas cluster; put its connection string in
  `MONGO_URI`.
- **Environment:** `JWT_SECRET` (a long random string), `MONGO_URI`, and
  `TRUST_PROXY=1` on any host that puts a proxy in front of the app (Render,
  Railway, Fly, nginx). `PORT` is usually set by the host.
- **Memory:** the image model plus ffmpeg wants ~1 GB of RAM. On a 512 MB
  plan set `ML_ENABLED=false` — tagging and visual search switch off, and
  everything else keeps working.
- **Storage:** uploads live on local disk. Most hosts wipe it on every
  redeploy, so either attach a persistent disk and point `STORAGE_ROOT` at it,
  or expect to re-upload demo files after a deploy.
- **Uploads:** proxies in front of the host often cap request size (Cloudflare
  at 100 MB), so keep demo videos small.

Build command `npm install`, start command `npm start`. The first boot
downloads the model, so the first request after a deploy is slower.

## Testing

```bash
npm test
```

198 assertions. The runner owns the whole lifecycle: it picks a free port,
creates a throwaway database and a temp storage directory, boots the server,
runs the suite, and tears all of it down in a `finally` — so it never touches
your dev data and a failed run leaves nothing behind. It also fails a run where
the server logged an error line even if every assertion passed.

> Deliberately **not** `mongodb-memory-server`: a ~100 MB `mongod` download on
> first run is a slow and failure-prone step on a marker's machine, to avoid a
> dependency the project already requires. CI uses a Mongo service container
> instead — see `.github/workflows/ci.yml`.

Coverage includes auth and the session/media token split, upload and the
worker, range streaming (206 + `Content-Range`, 416 on out-of-range and on an
inverted range, 401 without a token), watch progress and its completion
threshold, photo batches, capture-date resolution and editing, pagination past
page 1, profile stats, the password reset lifecycle, cross-user access control,
the full share-link lifecycle including revocation, and cascade deletes.

The sharing block runs a second registered account against the first one's
library and asserts the boundary in both directions. Search on both the catalog
and the photo filter bar is tested with `.*` as the query — a raw regex there
would match every row.

```bash
npm run lint        # eslint
npm run seed        # demo account, with the server already running
```

`npm run seed` uploads a generated clip and six photos stamped with EXIF dates
spread across three months, so the timeline has real groups. Logs in as
`demo@flixdrive.local` / `password123`, creating it if needed.

### The one line that matters most

```bash
curl -s -D - -o /dev/null -H 'Range: bytes=0-1023' \
  "http://localhost:5000/api/stream/$ID?token=$MEDIA_TOKEN"
```

If that prints `200` instead of `206`, seeking will not work in the browser.
Get `$MEDIA_TOKEN` from `GET /api/auth/media-token` — a session token is
refused here on purpose.

## Upgrade points

Both are marked with comments in `src/services/mediaProcessor.js`:

- **HLS ladder** — replace the poster capture in `processVideo` with an ffmpeg
  HLS transcode writing three renditions plus a master playlist. Add
  `hlsPlaylistKey` to the model and switch the client to `hls.js`. No route
  changes.
- **Durable queue** — replace the in-process promise chain with BullMQ + Redis
  so jobs survive a restart and run in a separate worker process. Callers only
  use `enqueue()`, so nothing else changes. Until then, `requeueInterrupted()`
  sweeps assets stuck in `processing` at boot, which is the cheap version of
  the same guarantee.

## Known gaps

- **Mail is not wired up.** See [Password reset](#password-reset).
- **No moderation, reporting or takedown path** on the shared catalog.
- **No refresh tokens.** A session JWT is valid for 7 days and cannot be
  revoked, so a password change does not lock out a stolen session. The media
  token split limits the blast radius of a *leaked URL*, not of a stolen
  session token.
- **Photo favourites are a boolean on the asset**, so they belong to the owner
  rather than the viewer. Correct while photos stay private; if photo sharing
  lands it needs to become a per-user join like `WatchProgress`.
- **Search is a regex scan.** Unanchored and case-insensitive, so it cannot use
  an index. Fine at this scale; a text index is the fix.
- **Photo thumbnails are flattened to JPEG**, so transparent PNGs get a black
  background.
- **HEIC is rejected at upload**: the bundled ffmpeg has no HEVC image decoder.
- **No automated browser tests.** The suite is API-level; the front end is
  verified structurally (every referenced element id exists, every generated
  class is styled) but not driven in a real browser.
