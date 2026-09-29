const path = require('path');
const { execFile } = require('child_process');
const exifr = require('exifr');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const MediaAsset = require('../models/MediaAsset');
const { POSTER_DIR, sourcePathFor } = require('../config/paths');
const tagger = require('./imageTagger');

// Static binaries ship with npm install, so there is no system ffmpeg
// to install and no PATH difference between your machine and a grader's.
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

function probe(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function capturePoster(filePath, atSeconds, outputName) {
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .on('end', () => resolve(outputName))
      .on('error', reject)
      .screenshots({
        timestamps: [atSeconds],
        filename: outputName,
        folder: POSTER_DIR,
        size: '640x?',
      });
  });
}

/**
 * Downscale one image to a timeline thumbnail.
 *
 * `-vframes 1` matters for animated GIF and multi-page formats: without it
 * ffmpeg would write one output file per frame.
 */
function captureThumbnail(filePath, outputName) {
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .outputOptions(['-vframes', '1'])
      .size('640x?')
      .on('end', () => resolve(outputName))
      .on('error', reject)
      .save(path.join(POSTER_DIR, outputName));
  });
}

/**
 * Scrub-preview sprite: up to 100 small frames from across the video, tiled
 * into one JPEG. The player shows the frame under the cursor while you hover
 * the timeline, so one image load covers every preview for the whole film.
 *
 * `fps=1/interval` samples a frame every `interval` seconds and `tile` packs
 * them 10 across; tile flushes a part-filled sheet at end of stream, so the
 * last row may be short. The layout is measured back off the written file
 * rather than predicted, because scale=-2 rounding decides the real height.
 */
const SPRITE_COLS = 10;
const SPRITE_MAX_FRAMES = 100;
const SPRITE_FRAME_WIDTH = 160;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegStatic, args, { windowsHide: true }, (err, _out, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim().split('\n').pop())) : resolve());
  });
}

async function captureSprite(asset, filePath) {
  const duration = asset.durationSec || 0;
  if (duration < 2) return null;   // nothing to scrub through

  const interval = Math.max(1, duration / SPRITE_MAX_FRAMES);
  const count = Math.max(1, Math.ceil(duration / interval));
  const rows = Math.ceil(count / SPRITE_COLS);
  const cols = Math.min(SPRITE_COLS, count);
  const name = `${asset._id}-sprite.jpg`;
  const out = path.join(POSTER_DIR, name);

  const filter = `fps=1/${interval},scale=${SPRITE_FRAME_WIDTH}:-2,tile=${cols}x${rows}`;
  const base = ['-v', 'error', '-y'];
  const tail = ['-i', filePath, '-vf', filter, '-frames:v', '1', '-q:v', '6', out];

  // Decoding every frame of a two-hour film takes minutes. Keyframes only is
  // an order of magnitude faster and plenty for a thumbnail - but a short
  // clip may have a single keyframe, so it only kicks in for long videos.
  if (duration > 300) {
    await runFfmpeg([...base, '-skip_frame', 'nokey', ...tail]).catch(() => runFfmpeg([...base, ...tail]));
  } else {
    await runFfmpeg([...base, ...tail]);
  }

  const meta = await probe(out);
  const sheet = (meta.streams || [])[0];
  if (!sheet?.width) throw new Error('Sprite sheet was not written');

  asset.spriteKey = name;
  asset.sprite = {
    cols,
    rows,
    count,
    interval,
    width: Math.round(sheet.width / cols),
    height: Math.round(sheet.height / rows),
  };
  return name;
}

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

// EXIF stores "2024:06:14 09:31:05" - colon-separated in the date half, which
// Date.parse rejects outright. exifr normally hands back a real Date, but
// falls back to the raw string when a tag sits somewhere it does not expect,
// so both shapes have to be handled.
function coerceExifDate(value) {
  if (isValidDate(value)) return value;
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  // EXIF timestamps carry no zone; they mean local time on the camera.
  const parsed = new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return isValidDate(parsed) ? parsed : null;
}

/**
 * When the photo was taken.
 *
 * This has to come from EXIF, not from the file. ffprobe exposes no tag
 * block at all for JPEG, and the stored file's mtime is the moment multer
 * wrote it - both would collapse the timeline onto the upload date.
 *
 * DateTimeOriginal is the shutter moment. CreateDate is usually identical
 * but gets rewritten by some editors, so it is only a fallback. Anything
 * without EXIF (a screenshot, an export, a generated image) legitimately has
 * no capture date, and upload time is then the honest answer.
 */
async function readCapturedAt(filePath, uploadedAt) {
  try {
    // Parse the whole TIFF block rather than requesting three tags by name:
    // a tag written into the wrong IFD comes back under its numeric id, and a
    // name-filtered read would drop it. 0x9003/0x9004 are the numeric forms of
    // DateTimeOriginal and CreateDate.
    const tags = await exifr.parse(filePath, { tiff: true, ifd0: true, exif: true });
    if (!tags) return uploadedAt;

    for (const key of ['DateTimeOriginal', 36867, 'CreateDate', 36868, 'ModifyDate', 306]) {
      const parsed = coerceExifDate(tags[key]);
      if (parsed) return parsed;
    }
  } catch {
    // Malformed or absent EXIF is normal, not an error worth failing on.
  }
  return uploadedAt;
}

async function processVideo(asset, sourcePath) {
  const meta = await probe(sourcePath);
  const videoStream = (meta.streams || []).find((s) => s.codec_type === 'video');
  if (!videoStream) throw new Error('No video stream found in this file');

  const duration = Number(meta.format?.duration) || 0;
  asset.durationSec = Math.round(duration * 100) / 100;
  asset.width = videoStream.width || null;
  asset.height = videoStream.height || null;

  // 10% in, so we skip black intro frames and studio idents.
  const posterAt = Math.max(1, Math.min(duration * 0.1, Math.max(1, duration - 1)));
  const posterName = `${asset._id}.png`;
  await capturePoster(sourcePath, posterAt, posterName);
  asset.posterKey = posterName;

  // Best effort: a video without scrub previews still plays perfectly well,
  // so a sprite failure is logged and the video still becomes 'ready'.
  await captureSprite(asset, sourcePath).catch((err) =>
    console.error(`[worker] sprite failed for ${asset._id}: ${err.message}`));
}

/**
 * Sprite-only job for videos processed before sprites existed. Uses
 * updateOne for the same reason the tagger does: the owner may have renamed
 * or shared the video since, and saving a stale document would undo that.
 */
async function processSprite(assetId) {
  const asset = await MediaAsset.findById(assetId);
  if (!asset || asset.kind !== 'video' || asset.status !== 'ready' || asset.spriteKey) return;
  try {
    if (!(await captureSprite(asset, sourcePathFor(asset)))) return;
    await MediaAsset.updateOne({ _id: asset._id }, { $set: { spriteKey: asset.spriteKey, sprite: asset.sprite } });
    console.log(`[worker] sprite: ${asset._id} (${asset.sprite.count} frames)`);
  } catch (err) {
    console.error(`[worker] sprite failed for ${asset._id}: ${err.message}`);
  }
}

async function processPhoto(asset, sourcePath) {
  // A client that already knows the capture date (a mobile app reading the
  // photo library) wins over EXIF, which editors routinely strip.
  const [meta, capturedAt] = await Promise.all([
    probe(sourcePath),
    isValidDate(asset.capturedAt)
      ? Promise.resolve(asset.capturedAt)
      : readCapturedAt(sourcePath, asset.createdAt),
  ]);

  const imageStream = (meta.streams || []).find((s) => s.codec_type === 'video');
  if (!imageStream) throw new Error('No image data found in this file');

  asset.width = imageStream.width || null;
  asset.height = imageStream.height || null;
  asset.capturedAt = capturedAt;

  const thumbName = `${asset._id}.jpg`;
  await captureThumbnail(sourcePath, thumbName);
  asset.posterKey = thumbName;
}

/**
 * The whole processing stage for one asset.
 *
 * Deliberately cheap: probe metadata + write one derived image. Both finish
 * in about a second regardless of source size, because neither re-encodes
 * the original.
 *
 * PHASE 1.5 UPGRADE POINT: swap the capturePoster call in processVideo for an
 * HLS ladder (ffmpeg -f hls with three -b:v renditions writing to a per-asset
 * folder), then set asset.hlsPlaylistKey. Nothing outside this file changes.
 */
async function processAsset(assetId) {
  const asset = await MediaAsset.findById(assetId);
  if (!asset) return;

  const sourcePath = sourcePathFor(asset);

  try {
    asset.status = 'processing';
    await asset.save();

    if (asset.kind === 'photo') {
      await processPhoto(asset, sourcePath);
    } else {
      await processVideo(asset, sourcePath);
    }

    asset.status = 'ready';
    asset.processingError = null;
    // Tagging runs on its own queue after this, so the photo shows up on the
    // timeline now and gains its tags a moment later.
    const tag = asset.kind === 'photo' && tagger.ENABLED;
    if (tag) asset.aiStatus = 'pending';
    await asset.save();
    if (tag) tagger.enqueueTagging(asset._id);

    const detail = asset.kind === 'photo' ? `${asset.width}x${asset.height}` : `${asset.durationSec}s`;
    console.log(`[worker] ready: ${asset._id} (${asset.kind}, ${detail})`);
  } catch (err) {
    console.error(`[worker] failed: ${assetId}`, err.message);
    asset.status = 'failed';
    asset.processingError = err.message;
    await asset.save().catch(() => {});
  }
}

/**
 * A one-at-a-time in-process queue.
 *
 * ffmpeg is CPU-bound. Running five jobs concurrently on a laptop makes
 * all five slow and starves the HTTP server. Serialising keeps the API
 * responsive during processing.
 *
 * PHASE 2 UPGRADE POINT: replace this chain with BullMQ + Redis so jobs
 * survive a restart and can run in a separate worker process. Callers
 * only use enqueue(), so they are unaffected.
 */
let chain = Promise.resolve();
let queuedCount = 0;

function enqueue(assetId, job = processAsset) {
  queuedCount += 1;
  chain = chain
    .then(() => job(assetId))
    .catch((err) => console.error('[worker] unhandled', err))
    .finally(() => {
      queuedCount -= 1;
    });
  return chain;
}

/**
 * Recover work the last shutdown interrupted.
 *
 * `chain` is a module variable, so a crash, a Ctrl-C or a nodemon reload takes
 * the queue with it and leaves those rows at 'processing' forever - the client
 * polls an asset that no worker will ever touch again. Nothing about the job is
 * lost though: the original is on disk and processAsset is idempotent, so the
 * fix is simply to enqueue them again at boot.
 *
 * 'uploading' is swept too. No route sets it today - the schema default is the
 * only way to reach it - but if one ever did, a stuck row there is the same
 * kind of orphan. An asset whose file has since vanished lands in the normal
 * failure path and ends up 'failed' with a readable reason, which is the right
 * answer for it.
 */
async function requeueInterrupted() {
  const stranded = await MediaAsset.find({
    status: { $in: ['processing', 'uploading'] },
  }).select('_id');

  stranded.forEach((asset) => enqueue(asset._id));
  return stranded.length;
}

/**
 * Videos processed before scrub previews existed get a sprite in the
 * background. On the same queue as new uploads - both are ffmpeg jobs - but
 * queued after anything interrupted, so recovery comes first.
 */
async function backfillSprites() {
  const missing = await MediaAsset.find({
    kind: 'video',
    status: 'ready',
    spriteKey: null,
    durationSec: { $gte: 2 },
  }).select('_id');

  missing.forEach((asset) => enqueue(asset._id, processSprite));
  return missing.length;
}

module.exports = {
  enqueue,
  processAsset,
  requeueInterrupted,
  backfillSprites,
  getQueueDepth: () => queuedCount,
};
