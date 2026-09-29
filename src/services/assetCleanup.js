const fs = require('fs/promises');
const path = require('path');
const MediaAsset = require('../models/MediaAsset');
const WatchProgress = require('../models/WatchProgress');
const { POSTER_DIR, sourcePathFor } = require('../config/paths');

/**
 * Delete one asset: its original, every derived image, its row, and any
 * watch progress pointing at it.
 *
 * Shared by the single delete route and the bulk photo route so the list of
 * files an asset owns lives in one place. Files go first and failures there
 * are ignored - a file already missing from disk must not leave behind a row
 * that can never be deleted.
 */
async function deleteAsset(asset) {
  await Promise.allSettled(
    [
      sourcePathFor(asset),
      asset.posterKey && path.join(POSTER_DIR, asset.posterKey),
      asset.spriteKey && path.join(POSTER_DIR, asset.spriteKey),
    ]
      .filter(Boolean)
      .map((file) => fs.unlink(file))
  );

  await Promise.all([
    MediaAsset.deleteOne({ _id: asset._id }),
    WatchProgress.deleteMany({ assetId: asset._id }),
  ]);
}

module.exports = { deleteAsset };
