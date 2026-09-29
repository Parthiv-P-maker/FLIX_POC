const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { loadViewableAsset } = require('../middleware/assetAccess');
const asyncHandler = require('../utils/asyncHandler');
const { POSTER_DIR } = require('../config/paths');

const router = express.Router();

/**
 * GET /api/posters/:id - the video poster frame or the photo thumbnail.
 *
 * These used to be served by express.static straight off POSTER_DIR, with no
 * auth at all. That was a hole: the filename was the asset id, and ObjectIds
 * minted in one upload batch are consecutive, so knowing a single poster URL
 * let anyone walk the rest of someone's library by incrementing the last hex
 * digit. A photo "thumbnail" is 640px wide, which is the photo.
 *
 * So derived images now go through exactly the same ownership and visibility
 * check as the original bytes. The cost is one indexed _id lookup per image;
 * the Cache-Control below keeps repeat views off the server entirely.
 *
 * Auth comes from ?token= because an <img src> cannot carry headers, the same
 * concession the stream route makes.
 */
router.get(
  '/:id',
  requireAuth({ allowQuery: true }),
  asyncHandler(async (req, res) => {
    // requireReady is false on purpose: a 'failed' asset may still have had a
    // poster written before the step that failed, and a missing poster is a
    // cleaner 404 than a 409 about playability.
    const asset = await loadViewableAsset(req, { requireReady: false });
    if (!asset.posterKey) return res.status(404).json({ error: 'No poster for this asset' });

    res.sendFile(
      asset.posterKey,
      {
        // `root` is what makes sendFile reject a key that tries to escape the
        // directory. storageKey and posterKey are server-generated today, but
        // this stops that from being load-bearing.
        root: POSTER_DIR,
        headers: {
          // Set here rather than via sendFile's `maxAge`, which emits
          // "public, max-age=..." - the exact opposite of what an authorised
          // response needs. 'private' keeps a shared proxy from handing this
          // image to the next caller. An asset's bytes never change, so an
          // hour in the browser cache is free.
          'Cache-Control': 'private, max-age=3600',
        },
      },
      (err) => {
        if (!err) return;
        if (res.headersSent) return res.destroy();
        res.status(410).json({ error: 'Poster is missing from storage' });
      }
    );
  })
);

/**
 * GET /api/posters/:id/sprite - the scrub-preview sheet for a video.
 *
 * Every frame of the video in miniature, so it gets exactly the poster's
 * access rules and cache policy.
 */
router.get(
  '/:id/sprite',
  requireAuth({ allowQuery: true }),
  asyncHandler(async (req, res) => {
    const asset = await loadViewableAsset(req, { requireReady: false });
    if (!asset.spriteKey) return res.status(404).json({ error: 'No preview sprite for this asset' });

    res.sendFile(
      asset.spriteKey,
      { root: POSTER_DIR, headers: { 'Cache-Control': 'private, max-age=3600' } },
      (err) => {
        if (!err) return;
        if (res.headersSent) return res.destroy();
        res.status(410).json({ error: 'Sprite is missing from storage' });
      }
    );
  })
);

module.exports = router;
