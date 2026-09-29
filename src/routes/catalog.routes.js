const express = require('express');
const MediaAsset = require('../models/MediaAsset');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth());

// Everything the catalog can ever return, declared once so no individual
// handler can forget the check.
//
// Deliberately `visibility: 'public'` and not `{ $ne: 'private' }`. The enum
// also carries 'unlisted', reserved for a share-by-link feature - and an
// exclusion filter would have published the very first unlisted asset into
// this grid, which is the opposite of what unlisted means. Naming the allowed
// value means a new visibility is invisible here until someone opts it in.
const CATALOG_FILTER = {
  kind: 'video',
  status: 'ready',
  visibility: 'public',
};

// A user typing "a.*" into search should get titles containing "a.*", not a
// regex that matches everything. Escape before building the RegExp.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SORTS = {
  new: { sharedAt: -1, createdAt: -1 },
  trending: { viewCount: -1, sharedAt: -1 },
};

/**
 * GET /api/catalog
 *
 * Every shared video from every account. This is the one read path that
 * deliberately crosses the ownerId boundary - the library at GET /api/assets
 * stays scoped to the caller.
 *
 * ?sort=new|trending, ?q=title search, ?mine=exclude to hide your own uploads.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 24, 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const sort = SORTS[req.query.sort] || SORTS.new;

    const filter = { ...CATALOG_FILTER };

    const q = String(req.query.q || '').trim();
    if (q) filter.title = new RegExp(escapeRegex(q), 'i');

    // The "From other members" rail wants everyone else's uploads; without
    // this the row is mostly the viewer's own videos on a small instance.
    if (req.query.mine === 'exclude') filter.ownerId = { $ne: req.user._id };

    const [assets, total] = await Promise.all([
      MediaAsset.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        // Attribution is the whole point of a shared catalog, and it is the
        // only reason this route populates where the library does not.
        .populate('ownerId', 'displayName'),
      MediaAsset.countDocuments(filter),
    ]);

    res.json({
      assets: assets.map((a) => a.toPublic(req)),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  })
);

/**
 * GET /api/catalog/summary - counts for the Browse header.
 *
 * Cheap enough to fold into the page load, and it lets the empty state say
 * "nobody has shared anything yet" rather than showing a blank grid.
 */
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const [total, mine, contributors] = await Promise.all([
      MediaAsset.countDocuments(CATALOG_FILTER),
      MediaAsset.countDocuments({ ...CATALOG_FILTER, ownerId: req.user._id }),
      MediaAsset.distinct('ownerId', CATALOG_FILTER),
    ]);

    res.json({ total, mine, contributors: contributors.length });
  })
);

module.exports = router;
