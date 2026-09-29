const express = require('express');
const User = require('../models/User');
const MediaAsset = require('../models/MediaAsset');
const WatchProgress = require('../models/WatchProgress');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(requireAuth());

/**
 * Everything the profile page shows, in one round trip.
 *
 * The counts come from an aggregation rather than find().length because the
 * page only needs the totals - pulling every document back to count it would
 * scale with library size for no reason.
 */
async function buildStats(userId) {
  const [byKind, watch, shared, favorites] = await Promise.all([
    MediaAsset.aggregate([
      { $match: { ownerId: userId } },
      {
        $group: {
          _id: '$kind',
          count: { $sum: 1 },
          bytes: { $sum: '$sizeBytes' },
          seconds: { $sum: { $ifNull: ['$durationSec', 0] } },
        },
      },
    ]),
    WatchProgress.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: null,
          watchedSec: { $sum: '$positionSec' },
          started: { $sum: 1 },
          finished: { $sum: { $cond: ['$completed', 1, 0] } },
        },
      },
    ]),
    // How much of your library is in the public catalog, and how much of it
    // you have starred. Both are cheap counts against existing indexes.
    // Matches catalog.routes' CATALOG_FILTER exactly - this number is supposed
    // to be "how many of my videos are in Browse", so it has to ask the same
    // question, including excluding a future 'unlisted'.
    MediaAsset.countDocuments({ ownerId: userId, kind: 'video', visibility: 'public' }),
    MediaAsset.countDocuments({ ownerId: userId, kind: 'photo', favorite: true }),
  ]);

  const pick = (kind) => byKind.find((r) => r._id === kind) || { count: 0, bytes: 0, seconds: 0 };
  const videos = pick('video');
  const photos = pick('photo');
  const w = watch[0] || { watchedSec: 0, started: 0, finished: 0 };

  return {
    videos: videos.count,
    photos: photos.count,
    shared,
    favorites,
    storageBytes: videos.bytes + photos.bytes,
    librarySec: videos.seconds,
    watchedSec: Math.round(w.watchedSec),
    started: w.started,
    finished: w.finished,
  };
}

/** GET /api/profile - account details plus library totals. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ user: req.user.toPublic(), stats: await buildStats(req.user._id) });
  })
);

/** PATCH /api/profile - rename yourself. Email is the login and stays fixed. */
router.patch(
  '/',
  asyncHandler(async (req, res) => {
    const displayName = String(req.body?.displayName ?? '').trim();
    if (displayName.length < 1 || displayName.length > 80) {
      return res.status(400).json({ error: 'Display name must be 1-80 characters' });
    }

    req.user.displayName = displayName;
    await req.user.save();
    res.json({ user: req.user.toPublic() });
  })
);

/**
 * PUT /api/profile/password
 *
 * Requires the current password even though the caller is already
 * authenticated: a token left behind on a shared machine should not be enough
 * to lock the real owner out.
 */
router.put(
  '/password',
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // req.user came from requireAuth without the hash, so re-read it here.
    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!(await user.verifyPassword(currentPassword))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (await user.verifyPassword(newPassword)) {
      return res.status(400).json({ error: 'New password must differ from the current one' });
    }

    user.password = newPassword;
    await user.save();

    // Tokens stay valid: they are signed with the server secret, not the
    // password, so nothing about them changes here.
    res.json({ ok: true });
  })
);

module.exports = router;
