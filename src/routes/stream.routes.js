const express = require('express');
const fsp = require('fs/promises');
const { requireAuth } = require('../middleware/auth');
const { loadViewableAsset } = require('../middleware/assetAccess');
const asyncHandler = require('../utils/asyncHandler');
const { sourcePathFor } = require('../config/paths');
const { sendRange } = require('../utils/rangeStream');

const router = express.Router();

/**
 * GET /api/stream/:id
 *
 * The heart of the player. The range semantics live in utils/rangeStream so
 * this route and the public share route cannot drift apart on them; what is
 * left here is the part that differs, which is who is allowed to ask.
 *
 * Auth comes from ?token= because a <video src> cannot carry headers.
 */
router.get(
  '/:id',
  requireAuth({ allowQuery: true }),
  asyncHandler(async (req, res) => {
    // Ownership, visibility and readiness all live in one place, shared with
    // the poster route.
    const asset = await loadViewableAsset(req);

    // Videos and photos live in different folders; the model knows which.
    const filePath = sourcePathFor(asset);

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return res.status(410).json({ error: 'Underlying file is missing from storage' });
    }

    // An asset's bytes never change once written, so a photo reopened in the
    // lightbox should come from cache. Video stays no-cache: the responses
    // are partial and range-dependent.
    const cacheControl =
      asset.kind === 'photo' ? 'private, max-age=3600' : 'private, max-age=0, no-cache';

    sendRange({
      req,
      res,
      filePath,
      fileSize: stat.size,
      mimeType: asset.mimeType,
      cacheControl,
    });
  })
);

module.exports = router;
