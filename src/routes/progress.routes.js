const express = require('express');
const MediaAsset = require('../models/MediaAsset');
const WatchProgress = require('../models/WatchProgress');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth());

/** GET /api/progress/continue - the "Continue watching" row. */
router.get(
  '/continue',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 12, 50);

    const rows = await WatchProgress.find({ userId: req.user._id, completed: false })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .populate('assetId');

    const items = rows
      .filter((r) => r.assetId && r.assetId.status === 'ready')
      .map((r) => ({
        positionSec: r.positionSec,
        percent: r.assetId.durationSec
          ? Math.round((r.positionSec / r.assetId.durationSec) * 100)
          : 0,
        lastWatchedAt: r.updatedAt,
        asset: r.assetId.toPublic(req),
      }));

    res.json({ items });
  })
);

/**
 * PUT /api/progress/:assetId
 *
 * Called by the player roughly every 10 seconds and once on pause/unload.
 * Upsert rather than find-then-save: two heartbeats can overlap, and the
 * unique (userId, assetId) index would reject the second insert.
 */
router.put(
  '/:assetId',
  asyncHandler(async (req, res) => {
    const positionSec = Number(req.body?.positionSec);
    if (!Number.isFinite(positionSec) || positionSec < 0) {
      return res.status(400).json({ error: 'positionSec must be a non-negative number' });
    }

    const asset = await MediaAsset.findById(req.params.assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const isOwner = String(asset.ownerId) === String(req.user._id);
    if (!isOwner && asset.visibility !== 'public') {
      return res.status(403).json({ error: 'You do not have access to this asset' });
    }

    // Treat the last 5% as finished, so "continue watching" does not
    // resurface something the user just finished.
    const completed = Boolean(asset.durationSec) && positionSec >= asset.durationSec * 0.95;

    const progress = await WatchProgress.findOneAndUpdate(
      { userId: req.user._id, assetId: asset._id },
      { $set: { positionSec, completed } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({ positionSec: progress.positionSec, completed: progress.completed });
  })
);

router.get(
  '/:assetId',
  asyncHandler(async (req, res) => {
    const progress = await WatchProgress.findOne({
      userId: req.user._id,
      assetId: req.params.assetId,
    });
    res.json({
      positionSec: progress ? progress.positionSec : 0,
      completed: progress ? progress.completed : false,
    });
  })
);

module.exports = router;
