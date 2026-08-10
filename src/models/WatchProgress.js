const mongoose = require('mongoose');

const watchProgressSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    assetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset', required: true },

    positionSec: { type: Number, required: true, min: 0, default: 0 },

    // Set once the viewer passes ~95%, so a finished title stops reappearing
    // in the "continue watching" row.
    completed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// One row per (viewer, asset). The upsert in progress.routes depends on this
// being unique - overlapping heartbeats would otherwise insert duplicates.
watchProgressSchema.index({ userId: 1, assetId: 1 }, { unique: true });

// Drives GET /api/progress/continue, which sorts by recency.
watchProgressSchema.index({ userId: 1, updatedAt: -1 });

module.exports = mongoose.model('WatchProgress', watchProgressSchema);
