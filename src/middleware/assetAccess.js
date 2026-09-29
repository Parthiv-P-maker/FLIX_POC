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

  // Only 'public' is readable by id. 'unlisted' deliberately is not: its whole
  // contract is "reachable by link", and the id is not the link - ObjectIds
  // are semi-predictable, so honouring a bare id here would quietly downgrade
  // every unlisted asset to "findable by anyone with an account". Holders of
  // the slug come in through routes/share.routes.js instead.
  const isOwner = String(asset.ownerId) === String(req.user._id);
  if (!isOwner && asset.visibility !== 'public') {
    throw httpError(403, 'You do not have access to this asset');
  }
  if (requireReady && asset.status !== 'ready') {
    throw httpError(409, `Asset is not playable yet (status: ${asset.status})`);
  }

  return asset;
}

module.exports = { loadViewableAsset, httpError };
