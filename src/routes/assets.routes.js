const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const MediaAsset = require('../models/MediaAsset');
const WatchProgress = require('../models/WatchProgress');
const { requireAuth } = require('../middleware/auth');
const { uploadVideo } = require('../middleware/upload');
const { enqueue } = require('../services/mediaProcessor');
const asyncHandler = require('../utils/asyncHandler');
const { POSTER_DIR, sourcePathFor } = require('../config/paths');

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
      title: (req.body.title || req.file.originalname).trim().slice(0, 200),
      description: (req.body.description || '').slice(0, 2000),
      kind: 'video',
      storageKey: req.file.filename,
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      visibility: req.body.visibility === 'public' ? 'public' : 'private',
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

    const isOwner = String(asset.ownerId?._id ?? asset.ownerId) === String(req.user._id);
    if (!isOwner && asset.visibility === 'private') {
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

    const { shared, favorite, title } = req.body || {};

    if (shared !== undefined) {
      if (typeof shared !== 'boolean') {
        return res.status(400).json({ error: 'shared must be a boolean' });
      }
      // Only ever 'public' or 'private' from here. 'unlisted' stays in the
      // enum for a share-by-link feature that does not exist yet.
      asset.visibility = shared ? 'public' : 'private';
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
    if (!isOwner && asset.visibility === 'private') {
      return res.status(403).json({ error: 'You do not have access to this asset' });
    }

    // $inc rather than load-modify-save so two viewers starting at once do
    // not overwrite each other's increment.
    await MediaAsset.updateOne({ _id: asset._id }, { $inc: { viewCount: 1 } });
    res.json({ ok: true, viewCount: asset.viewCount + 1 });
  })
);

/** DELETE /api/assets/:id - removes the DB rows and the files on disk. */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const asset = await MediaAsset.findOne({ _id: req.params.id, ownerId: req.user._id });
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    await Promise.allSettled([
      fs.unlink(sourcePathFor(asset)),
      asset.posterKey ? fs.unlink(path.join(POSTER_DIR, asset.posterKey)) : Promise.resolve(),
    ]);

    await Promise.all([
      MediaAsset.deleteOne({ _id: asset._id }),
      WatchProgress.deleteMany({ assetId: asset._id }),
    ]);

    res.json({ deleted: true, id: asset._id });
  })
);

module.exports = router;
