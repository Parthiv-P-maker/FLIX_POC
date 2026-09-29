const express = require('express');
const fsp = require('fs/promises');
const MediaAsset = require('../models/MediaAsset');
const asyncHandler = require('../utils/asyncHandler');
const { sourcePathFor, POSTER_DIR } = require('../config/paths');
const { sendRange } = require('../utils/rangeStream');

const router = express.Router();

/**
 * Share-by-link. The only routes in the app with no requireAuth at all.
 *
 * The authorisation here *is* the slug: 128 random bits that only the owner
 * has ever been shown. That is a deliberate trade - the point of the feature
 * is handing a video to someone who does not have an account - so the rules
 * around it have to be tight:
 *
 *   - Lookup is by slug only. There is no route from an asset id to these
 *     responses, so an unlisted asset cannot be found by walking ObjectIds.
 *   - A slug exists only while the asset is shared. Going private nulls it,
 *     which is what makes "revoke" real.
 *   - The payload below is hand-built rather than reusing toPublic(), which
 *     carries ownerId, viewCount, storage size and the owner's display name.
 *     An anonymous viewer gets what they need to watch and nothing else.
 */
async function findShared(slug) {
  if (typeof slug !== 'string' || !/^[a-f0-9]{32}$/.test(slug)) return null;

  const asset = await MediaAsset.findOne({
    shareSlug: slug,
    // Belt and braces. The pre-save hook already nulls the slug when an asset
    // goes private, so this should be unreachable - but it is one index scan
    // to guarantee a revoked link cannot serve bytes even if a slug survived.
    visibility: { $in: ['unlisted', 'public'] },
    status: 'ready',
  });

  return asset;
}

/** GET /api/share/:slug - just enough metadata to render a viewer. */
router.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const asset = await findShared(req.params.slug);
    if (!asset) return res.status(404).json({ error: 'This share link is not valid' });

    const base = `${req.protocol}://${req.get('host')}`;
    const isPhoto = asset.kind === 'photo';

    res.json({
      kind: asset.kind,
      title: asset.title,
      description: asset.description,
      width: asset.width,
      height: asset.height,
      durationSec: isPhoto ? undefined : asset.durationSec,
      mimeType: asset.mimeType,
      posterUrl: asset.posterKey ? `${base}/api/share/${asset.shareSlug}/poster` : null,
      mediaUrl: `${base}/api/share/${asset.shareSlug}/media`,
    });
  })
);

/** GET /api/share/:slug/media - the bytes, range-capable like the main route. */
router.get(
  '/:slug/media',
  asyncHandler(async (req, res) => {
    const asset = await findShared(req.params.slug);
    if (!asset) return res.status(404).json({ error: 'This share link is not valid' });

    const filePath = sourcePathFor(asset);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return res.status(410).json({ error: 'Underlying file is missing from storage' });
    }

    sendRange({ req, res, filePath, fileSize: stat.size, mimeType: asset.mimeType });
  })
);

/** GET /api/share/:slug/poster - the poster frame or thumbnail. */
router.get(
  '/:slug/poster',
  asyncHandler(async (req, res) => {
    const asset = await findShared(req.params.slug);
    if (!asset || !asset.posterKey) {
      return res.status(404).json({ error: 'This share link is not valid' });
    }

    res.sendFile(asset.posterKey, { root: POSTER_DIR }, (err) => {
      if (!err) return;
      if (res.headersSent) return res.destroy();
      res.status(410).json({ error: 'Poster is missing from storage' });
    });
  })
);

module.exports = router;
