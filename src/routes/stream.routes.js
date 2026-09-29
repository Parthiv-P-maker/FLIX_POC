const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const { requireAuth } = require('../middleware/auth');
const { loadViewableAsset } = require('../middleware/assetAccess');
const asyncHandler = require('../utils/asyncHandler');
const { sourcePathFor } = require('../config/paths');

const router = express.Router();

// One megabyte per chunk when the browser asks for an open-ended range
// ("bytes=0-"). Serving the entire file in one response would work but
// would defeat the point: the browser could not cheaply seek.
const CHUNK_SIZE = 1 * 1024 * 1024;

/**
 * Pipe a read stream to the response with the teardown both branches need.
 *
 * The browser aborts in-flight requests constantly while seeking, and a read
 * can fail at any point. Without the 'error' handler an I/O failure is an
 * unhandled 'error' event, which in Node is an uncaught exception that takes
 * the whole process down - so this has to wrap every send, not just the
 * partial-content one.
 */
function pipeFile(filePath, res, req, options = {}) {
  const stream = fs.createReadStream(filePath, options);

  stream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.status(500).json({ error: 'Failed to read the underlying file' });
  });
  // Without this the file descriptor leaks on every scrub.
  req.on('close', () => stream.destroy());

  stream.pipe(res);
}

/**
 * GET /api/stream/:id
 *
 * The heart of the player. Chrome/Safari send a Range header on the very
 * first request for a <video> source. Answering with 200 + the whole file
 * makes the scrub bar refuse to seek; answering 206 with a correct
 * Content-Range is what makes seeking work.
 *
 * Auth comes from ?token= because a <video src> cannot carry headers.
 */
router.get(
  '/:id',
  requireAuth({ allowQuery: true }),
  asyncHandler(async (req, res) => {
    // Ownership, visibility and readiness all live in one place now, shared
    // with the poster route so the two cannot drift apart.
    const asset = await loadViewableAsset(req);

    // Videos and photos live in different folders; the model knows which.
    const filePath = sourcePathFor(asset);

    // An asset's bytes never change once written, so a photo reopened in the
    // lightbox should come from cache. Video stays no-cache: the responses
    // are partial and range-dependent.
    const cacheControl =
      asset.kind === 'photo' ? 'private, max-age=3600' : 'private, max-age=0, no-cache';

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return res.status(410).json({ error: 'Underlying file is missing from storage' });
    }

    const fileSize = stat.size;
    const range = req.headers.range;

    // No Range header: send the whole file, but advertise that we support
    // ranges so the browser knows it may ask for one next time.
    if (!range) {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': asset.mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
      });
      return pipeFile(filePath, res, req);
    }

    // Range looks like "bytes=1048576-" or "bytes=1048576-2097151".
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }

    const start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : Math.min(start + CHUNK_SIZE - 1, fileSize - 1);

    // Clamp before use. An out-of-range start must be 416, and an end past
    // EOF must be pulled back or createReadStream throws.
    if (Number.isNaN(start) || start >= fileSize || start < 0) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }
    end = Math.min(end, fileSize - 1);
    // "bytes=500-100" is unsatisfiable per RFC 7233. Serving from `start` to
    // EOF instead - which is what clamping used to do - answers a question the
    // client did not ask.
    if (end < start) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }

    const contentLength = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': contentLength,
      'Content-Type': asset.mimeType,
      'Cache-Control': 'private, max-age=0, no-cache',
    });

    pipeFile(filePath, res, req, { start, end });
  })
);

module.exports = router;
