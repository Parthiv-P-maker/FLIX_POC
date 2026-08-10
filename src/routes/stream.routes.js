const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const MediaAsset = require('../models/MediaAsset');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { sourcePathFor } = require('../config/paths');

const router = express.Router();

// One megabyte per chunk when the browser asks for an open-ended range
// ("bytes=0-"). Serving the entire file in one response would work but
// would defeat the point: the browser could not cheaply seek.
const CHUNK_SIZE = 1 * 1024 * 1024;

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
    const asset = await MediaAsset.findById(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const isOwner = String(asset.ownerId) === String(req.user._id);
    if (!isOwner && asset.visibility === 'private') {
      return res.status(403).json({ error: 'You do not have access to this asset' });
    }
    if (asset.status !== 'ready') {
      return res.status(409).json({ error: `Asset is not playable yet (status: ${asset.status})` });
    }

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
      return fs.createReadStream(filePath).pipe(res);
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
    if (end < start) end = fileSize - 1;

    const contentLength = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': contentLength,
      'Content-Type': asset.mimeType,
      'Cache-Control': 'private, max-age=0, no-cache',
    });

    const stream = fs.createReadStream(filePath, { start, end });

    // The browser aborts in-flight range requests constantly while seeking.
    // Without this the file descriptor leaks on every scrub.
    stream.on('error', () => res.destroy());
    req.on('close', () => stream.destroy());

    stream.pipe(res);
  })
);

module.exports = router;
