const express = require('express');
const MediaAsset = require('../models/MediaAsset');
const WatchProgress = require('../models/WatchProgress');
const { requireAuth } = require('../middleware/auth');
const { uploadVideo } = require('../middleware/upload');
const { enqueue } = require('../services/mediaProcessor');
const { deleteAsset } = require('../services/assetCleanup');
const asyncHandler = require('../utils/asyncHandler');
const { textField } = require('../utils/formField');

const router = express.Router();
router.use(requireAuth());

/**
 * POST /api/assets
 *
 * Returns 202 Accepted, not 201. The bytes are on disk but the asset is
 * not playable yet. The client polls GET /api/assets/:id until status
 * becomes "ready" (or "failed").
 */
router.post(
  '/',
  uploadVideo,
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No video file received' });

    const asset = await MediaAsset.create({
      ownerId: req.user._id,
      title: (textField(req.body.title) || req.file.originalname).trim().slice(0, 200),
      description: textField(req.body.description).slice(0, 2000),
      kind: 'video',
      storageKey: req.file.filename,
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      visibility: textField(req.body.visibility) === 'public' ? 'public' : 'private',
      status: 'processing',
    });

    // Fire and forget. Do NOT await - that would block the response
    // until ffmpeg finishes.
    enqueue(asset._id);

    res.status(202).json({
      asset: asset.toPublic(req),
      pollUrl: `/api/assets/${asset._id}`,
    });
  })
);

/**
 * GET /api/assets - the caller's own library, newest first.
 *
 * Defaults to video only. Photos share this collection but belong to the
 * timeline at GET /api/photos, and mixing them into the video rail would be
 * surprising; `?kind=all` is the explicit opt-out.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 24, 100);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const filter = { ownerId: req.user._id };
    if (req.query.kind !== 'all') filter.kind = req.query.kind || 'video';
    if (req.query.status) filter.status = req.query.status;
    // Title search, for the command palette. Escaped for the same reason as
    // the catalog's: "a.*" is a title to look for, not a pattern.
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (q) filter.title = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const [assets, total] = await Promise.all([
      MediaAsset.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
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

/** GET /api/assets/:id - also the poll target during processing. */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    // Populated because this is the poll target for a catalog item too, and
    // the player credits the uploader.
    const asset = await MediaAsset.findById(req.params.id).populate('ownerId', 'displayName');
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    // Public only for non-owners - 'unlisted' is reachable by slug, not by id.
    // Same rule as middleware/assetAccess.js; see the comment there.
    const isOwner = String(asset.ownerId?._id ?? asset.ownerId) === String(req.user._id);
    if (!isOwner && asset.visibility !== 'public') {
      return res.status(403).json({ error: 'You do not have access to this asset' });
    }

    const progress = await WatchProgress.findOne({ userId: req.user._id, assetId: asset._id });

    res.json({
      asset: asset.toPublic(req),
      progress: progress ? { positionSec: progress.positionSec, completed: progress.completed } : null,
    });
  })
);

/**
 * PATCH /api/assets/:id - owner-only edits: share/unshare, star, rename.
 *
 * Sharing is the opt-in that puts a row into the public catalog, so the
 * ownership check is the security boundary for the whole Browse view. It is
 * expressed in the query rather than fetched-then-compared: a non-owner gets
 * the same 404 as a missing id and learns nothing about what exists.
 */
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const asset = await MediaAsset.findOne({ _id: req.params.id, ownerId: req.user._id });
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const { shared, favorite, title, description, capturedAt, visibility } = req.body || {};

    if (shared !== undefined && visibility !== undefined) {
      return res.status(400).json({ error: 'Send either shared or visibility, not both' });
    }

    if (shared !== undefined) {
      if (typeof shared !== 'boolean') {
        return res.status(400).json({ error: 'shared must be a boolean' });
      }
      // The original two-state toggle, kept because it is what the catalog
      // switch means: in Browse, or not. `visibility` below is the richer
      // control that can also reach 'unlisted'.
      asset.visibility = shared ? 'public' : 'private';
    }

    if (visibility !== undefined) {
      if (!MediaAsset.VISIBILITIES.includes(visibility)) {
        return res.status(400).json({
          error: `visibility must be one of: ${MediaAsset.VISIBILITIES.join(', ')}`,
        });
      }
      // The pre-save hook mints or destroys shareSlug from here.
      asset.visibility = visibility;
    }

    if (favorite !== undefined) {
      if (typeof favorite !== 'boolean') {
        return res.status(400).json({ error: 'favorite must be a boolean' });
      }
      asset.favorite = favorite;
    }

    if (title !== undefined) {
      const next = String(title).trim();
      if (next.length < 1 || next.length > 200) {
        return res.status(400).json({ error: 'Title must be 1-200 characters' });
      }
      asset.title = next;
    }

    if (description !== undefined) {
      // Unlike title, empty is meaningful here - it is how you remove one.
      const next = String(description).trim();
      if (next.length > 2000) {
        return res.status(400).json({ error: 'Description must be 2000 characters or fewer' });
      }
      asset.description = next;
    }

    if (capturedAt !== undefined) {
      // A photo with no EXIF falls back to upload time, which is usually
      // wrong and, until now, uncorrectable. null puts it back on that
      // fallback rather than pinning a bad date forever.
      if (asset.kind !== 'photo') {
        return res.status(400).json({ error: 'capturedAt only applies to photos' });
      }
      if (capturedAt === null) {
        asset.capturedAt = null;
      } else {
        const when = new Date(capturedAt);
        if (Number.isNaN(when.getTime())) {
          return res.status(400).json({ error: 'capturedAt must be a date or null' });
        }
        if (when.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
          return res.status(400).json({ error: 'capturedAt cannot be in the future' });
        }
        asset.capturedAt = when;
      }
    }

    // save(), not findOneAndUpdate(): the pre-save hook is what keeps
    // sharedAt consistent with visibility.
    await asset.save();
    res.json({ asset: asset.toPublic(req) });
  })
);

/**
 * POST /api/assets/:id/view - bump the play count that feeds the Trending rail.
 *
 * Separate from the stream route on purpose. A single viewing issues dozens
 * of range requests, so counting there would rank by seek count.
 */
router.post(
  '/:id/view',
  asyncHandler(async (req, res) => {
    const asset = await MediaAsset.findById(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const isOwner = String(asset.ownerId) === String(req.user._id);
    if (!isOwner && asset.visibility !== 'public') {
      return res.status(403).json({ error: 'You do not have access to this asset' });
    }

    // $inc rather than load-modify-save so two viewers starting at once do
    // not overwrite each other's increment - and `new: true` so the number we
    // report is the one the database actually holds. Computing it as
    // `asset.viewCount + 1` from the pre-increment read threw that atomicity
    // away again the moment two viewers overlapped.
    const updated = await MediaAsset.findOneAndUpdate(
      { _id: asset._id },
      { $inc: { viewCount: 1 } },
      { new: true }
    );
    res.json({ ok: true, viewCount: updated.viewCount });
  })
);

/** DELETE /api/assets/:id - removes the DB rows and the files on disk. */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const asset = await MediaAsset.findOne({ _id: req.params.id, ownerId: req.user._id });
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    await deleteAsset(asset);
    res.json({ deleted: true, id: asset._id });
  })
);

module.exports = router;
