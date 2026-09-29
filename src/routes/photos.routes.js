const crypto = require('crypto');
const express = require('express');
const MediaAsset = require('../models/MediaAsset');
const { requireAuth } = require('../middleware/auth');
const { uploadPhotos } = require('../middleware/upload');
const { enqueue } = require('../services/mediaProcessor');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth());

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * POST /api/photos
 *
 * Accepts up to 20 files under the field name `photos`. Like video upload
 * this answers 202, not 201: dimensions and the thumbnail are not written
 * until the worker gets to each row.
 */
router.post(
  '/',
  uploadPhotos,
  asyncHandler(async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No image files received' });

    // One title for a batch would be meaningless, so each photo falls back to
    // its own filename unless the client sent exactly one.
    const singleTitle = files.length === 1 ? (req.body.title || '').trim() : '';

    // A client holding the OS photo library knows the capture date even when
    // EXIF has been stripped. Parallel array to `photos`, so index i belongs
    // to file i; anything unparseable falls through to the worker's EXIF read.
    const supplied = [].concat(req.body.capturedAt || []);
    const capturedAtFor = (i) => {
      const d = new Date(supplied[i]);
      return supplied[i] && !Number.isNaN(d.getTime()) ? d : null;
    };

    const shared = req.body.visibility === 'public';

    const created = await MediaAsset.insertMany(
      files.map((file, i) => ({
        capturedAt: capturedAtFor(i),
        // insertMany skips save middleware, so the hook that normally derives
        // these two from visibility never runs here and they have to be set by
        // hand. A slug per photo, not per batch: they are separate assets and
        // revoking one must not revoke the rest.
        sharedAt: shared ? new Date() : null,
        shareSlug: shared ? crypto.randomBytes(16).toString('hex') : null,
        ownerId: req.user._id,
        kind: 'photo',
        title: (singleTitle || file.originalname).slice(0, 200),
        description: (req.body.description || '').slice(0, 2000),
        storageKey: file.filename,
        originalFilename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        visibility: shared ? 'public' : 'private',
        status: 'processing',
      }))
    );

    // Fire and forget, one job per photo. Do NOT await - thumbnailing twenty
    // images would hold the response open for seconds.
    created.forEach((asset) => enqueue(asset._id));

    res.status(202).json({
      count: created.length,
      assets: created.map((a) => a.toPublic(req)),
    });
  })
);

// A user typing "a.*" into the filter bar should get titles containing
// "a.*", not a regex that matches every photo they own.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The year facet powers the jump-chips above the timeline, and it has to be
 * built from the *unfiltered* library. Deriving it from the filtered rows
 * would make the chips vanish as soon as one of them was clicked.
 *
 * capturedAt is null until the worker reads EXIF, so the year falls back to
 * createdAt exactly the way the grouping below does.
 */
async function yearFacet(ownerId) {
  const rows = await MediaAsset.aggregate([
    { $match: { ownerId, kind: 'photo' } },
    {
      $group: {
        _id: { $year: { $ifNull: ['$capturedAt', '$createdAt'] } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: -1 } },
  ]);
  return rows.map((r) => ({ year: r._id, count: r.count }));
}

/**
 * GET /api/photos - the timeline, newest capture first, grouped by month.
 *
 * Grouping happens here rather than in the client so every consumer gets the
 * same month boundaries, and so the labels are computed once.
 *
 * ?q= title search, ?favorite=1 stars only, ?year=2024 one year.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 60, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const filter = { ownerId: req.user._id, kind: 'photo' };
    if (req.query.status) filter.status = req.query.status;

    const q = String(req.query.q || '').trim();
    if (q) filter.title = new RegExp(escapeRegex(q), 'i');

    if (req.query.favorite === '1') filter.favorite = true;

    // A year filter has to span the same fallback the grouping uses, so it
    // cannot be a plain range on capturedAt - rows still awaiting EXIF have
    // none. $expr lets the range apply to the coalesced value.
    const year = Number(req.query.year);
    if (Number.isInteger(year) && year > 1900) {
      filter.$expr = {
        $eq: [{ $year: { $ifNull: ['$capturedAt', '$createdAt'] } }, year],
      };
    }

    const [photos, total, years, favorites] = await Promise.all([
      MediaAsset.find(filter)
        .sort({ capturedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      MediaAsset.countDocuments(filter),
      yearFacet(req.user._id),
      MediaAsset.countDocuments({ ownerId: req.user._id, kind: 'photo', favorite: true }),
    ]);

    // Map preserves insertion order, so the groups come out already sorted by
    // the query above - no second sort needed.
    const groups = new Map();
    for (const photo of photos) {
      const when = photo.capturedAt || photo.createdAt;
      const key = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: `${MONTHS[when.getMonth()]} ${when.getFullYear()}`,
          items: [],
        });
      }
      groups.get(key).items.push(photo.toPublic(req));
    }

    res.json({
      groups: [...groups.values()],
      // Facets describe the whole library, not this filtered page, so the
      // client can keep the chips stable while a filter is applied.
      facets: { years, favorites },
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  })
);

module.exports = router;
