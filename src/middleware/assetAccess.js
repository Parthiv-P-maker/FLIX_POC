const MediaAsset = require('../models/MediaAsset');

/**
 * Who is allowed to see an asset's bytes.
 *
 * Two routes serve files off disk - the range stream and the poster route -
 * and they must agree exactly. Expressed once here so a future third consumer
 * cannot quietly invent a weaker rule.
 *
 * Throws with a `status` so errorHandler turns it into the right response;
 * every caller is already wrapped in asyncHandler.
 */
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * @param {object} req      the request, after requireAuth has set req.user
 * @param {object} options
 * @param {boolean} options.requireReady  reject assets the worker has not finished
 */
async function loadViewableAsset(req, { requireReady = true } = {}) {
  const asset = await MediaAsset.findById(req.params.id);
  if (!asset) throw httpError(404, 'Asset not found');

  const isOwner = String(asset.ownerId) === String(req.user._id);
  if (!isOwner && asset.visibility === 'private') {
    throw httpError(403, 'You do not have access to this asset');
  }
  if (requireReady && asset.status !== 'ready') {
    throw httpError(409, `Asset is not playable yet (status: ${asset.status})`);
  }

  return asset;
}

module.exports = { loadViewableAsset, httpError };
