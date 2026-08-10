# FlixDrive — personal media library

Auth, upload, media processing, and HTTP range streaming for a Netflix-style
player, plus a photo timeline. Videos and photos share one `MediaAsset`
document, separated by a `kind` discriminator.

Uploads are **private by default**. Sharing a video opts it into a public
catalog that every account can browse and stream — see [Sharing](#sharing).

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
**Photos** (capture-date timeline, justified grid, favourites and filters),
**Upload** (drag-and-drop), and **Profile** (library stats, rename, password
change).

Files land in `storage/uploads` (video), `storage/photos` (photo originals) and
`storage/posters` (posters + thumbnails). All are gitignored.

## Layout

```
src/
  server.js               app wiring, static mounts, route mounting
  config/paths.js         storage dirs; sourcePathFor(asset) resolves bytes
  config/db.js            mongoose connection
  models/                 User, MediaAsset, WatchProgress
  middleware/             auth (JWT), upload (multer), errorHandler
  routes/                 auth, profile, assets, catalog, photos, stream, progress
  services/mediaProcessor.js   ffmpeg/ffprobe worker + in-process queue
  utils/asyncHandler.js
public/                   vanilla-JS client (no build step)
testmedia/                e2e suite, seed script, EXIF fixture builder
```

### A CSS trap worth knowing

`hidden` is only `display: none` in the *user-agent* stylesheet, so any
author-level `display` rule beats it and the element stays on screen. Three
selectors here set one (`.overlay`, `.auth-screen`, `.field`), which put both
modals on top of the login form until this landed in `styles.css`:

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

## API

| Method | Route | Notes |
|---|---|---|
| POST | `/api/auth/register` | `{ email, password, displayName }` → user + JWT |
| POST | `/api/auth/login` | `{ email, password }` → user + JWT |
| GET | `/api/auth/me` | Bearer token |
| GET | `/api/profile` | Account details + library stats |
| PATCH | `/api/profile` | `{ displayName }` |
| PUT | `/api/profile/password` | `{ currentPassword, newPassword }` |
| POST | `/api/assets` | multipart, field name `video`. Returns **202**. `visibility=public` shares on upload |
| GET | `/api/assets` | Your video library, paginated. `?kind=photo\|all` to widen |
| GET | `/api/assets/:id` | Poll this until `status === "ready"` |
| PATCH | `/api/assets/:id` | Owner only. `{ shared?, favorite?, title? }` |
| POST | `/api/assets/:id/view` | Bumps the play count behind the Trending rail |
| DELETE | `/api/assets/:id` | Removes DB rows + files on disk (either kind) |
| GET | `/api/catalog` | **Everyone's** shared videos. `?sort=new\|trending`, `?q=`, `?mine=exclude` |
| GET | `/api/catalog/summary` | Totals for the Browse header |
| POST | `/api/photos` | multipart, field `photos`, up to 20. Returns **202** |
| GET | `/api/photos` | Timeline, grouped by capture month. `?q=`, `?favorite=1`, `?year=` |
| GET | `/api/stream/:id?token=JWT` | Range-request playback (also serves photo originals) |
| PUT | `/api/progress/:assetId` | `{ positionSec }`, called every ~10s |
| GET | `/api/progress/continue` | The "Continue watching" row |
| GET | `/api/health` | Includes current ffmpeg queue depth |

## Sharing

`GET /api/catalog` is the **only** read path that deliberately crosses the
`ownerId` boundary. Everything else — the library, the photo timeline, profile
stats — stays scoped to the caller.

The rules, all enforced server-side:

- A new upload is `visibility: 'private'`. Nobody else can list it, read it, or
  stream it; both the detail route and the stream route answer **403**.
- `PATCH /api/assets/:id { shared: true }` flips it to `'public'` and stamps
  `sharedAt`. It now appears in every account's Browse view, credited to the
  uploader's display name.
- Sharing grants **read only**. Rename, re-share and delete stay owner-only,
  and a non-owner attempting them gets **404** — the same answer a missing id
  gives, so a stranger learns nothing about what exists.
- Un-sharing is immediate and total: `sharedAt` is cleared and the video drops
  out of the catalog and back to 403 for everyone else.

Watch progress stays per-user throughout, so two people watching the same
shared video keep separate resume positions — the Netflix-profile behaviour,
without a profile concept.

`sharedAt` exists rather than reusing `createdAt` because the "New" rail means
new *to the catalog*: a video uploaded last month but shared today belongs at
the top. A `pre('save')` hook keeps the two fields in step so no route has to
remember to. Note that `insertMany` bypasses that hook, which is why the photo
upload route sets `sharedAt` by hand.

### Why the play counter is its own route

`POST /api/assets/:id/view` looks redundant next to the stream route, but
counting inside `/api/stream` would rank the Trending rail by *seek count* — a
single viewing issues dozens of range requests. The client bumps it once, when
the player opens.

### Why `/api/stream` takes the token in the query string

A `<video src="...">` tag cannot send an `Authorization` header. The stream
route is the one endpoint that accepts `?token=`; everything else is
header-only. Before production this should become a short-lived signed URL
rather than the full session JWT.

### Photos: where `capturedAt` comes from

A timeline grouped by *upload* date is close to useless, so capture date is
resolved in this order:

1. A `capturedAt` field sent alongside the upload — a client with access to the
   OS photo library knows the real date even when EXIF has been stripped.
2. EXIF `DateTimeOriginal`, then `CreateDate`, then `ModifyDate`, read with
   `exifr`.
3. Upload time. Correct for screenshots and exports, which genuinely have no
   capture date.

Two traps worth knowing, both of which produced silently wrong timelines
during development:

- **ffprobe cannot do this.** It reports no tag block at all for JPEG, which is
  why `exifr` is a dependency rather than reusing the probe already being run
  for dimensions.
- **File mtime is not a fallback.** Multer writes a fresh file on upload, so the
  stored copy's mtime is always the upload moment.

## Testing

With the server running:

```bash
npm run test:e2e
```

102 assertions covering auth, upload, the worker, range streaming (206 +
`Content-Range`, 416 on out-of-range, 401 without a token), watch progress and
its completion threshold, photo batches, capture-date resolution, profile stats
and password changes, cross-user access control, and cascade deletes.

The sharing block runs a second registered account against the first one's
library and asserts the boundary in both directions: private is invisible,
shared is listable/readable/streamable but still not writable, and un-sharing
puts it back to 403. Search on both the catalog and the photo filter bar is
tested with `.*` as the query — a raw regex there would match every row.

To fill the demo account with something to look at:

```bash
npm run seed
```

Uploads a generated clip and six photos stamped with EXIF dates spread across
three months, so the timeline has real groups. Logs in as
`demo@flixdrive.local` / `password123`, creating it if needed.

### The one line that matters most

```bash
curl -s -D - -o /dev/null -H 'Range: bytes=0-1023' \
  "http://localhost:5000/api/stream/$ID?token=$TOKEN"
```

If that prints `200` instead of `206`, seeking will not work in the browser.

## Upgrade points

Both are marked with comments in `src/services/mediaProcessor.js`:

- **HLS ladder** — replace the poster capture in `processVideo` with an ffmpeg
  HLS transcode writing three renditions plus a master playlist. Add
  `hlsPlaylistKey` to the model and switch the client to `hls.js`. No route
  changes.
- **Durable queue** — replace the in-process promise chain with BullMQ + Redis
  so jobs survive a restart and run in a separate worker process. Callers only
  use `enqueue()`, so nothing else changes.

Not yet done, and needed before this is more than a PoC:

- The stream token is the full session JWT (see above). This matters more now
  that the catalog is cross-account: a shared video's stream URL, token and
  all, is handed to any signed-in viewer.
- No moderation, reporting or takedown path on the shared catalog.
- `'unlisted'` is still in the `visibility` enum but nothing sets it; the share
  toggle only ever writes `'public'` or `'private'`. It is the hook for
  share-by-link.
- Photo favourites are a boolean on the asset, so they belong to the owner
  rather than the viewer. That is correct while photos stay private, but if
  photo sharing lands it needs to become a per-user join like `WatchProgress`.
- Photo thumbnails are flattened to JPEG, so transparent PNGs get a black
  background.
- HEIC is rejected at upload: the bundled ffmpeg has no HEVC image decoder.
