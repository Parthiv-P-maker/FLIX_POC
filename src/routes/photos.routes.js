const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const MediaAsset = require('../models/MediaAsset');
const { requireAuth } = require('../middleware/auth');
const { uploadPhotos } = require('../middleware/upload');
const { enqueue } = require('../services/mediaProcessor');
const tagger = require('../services/imageTagger');
const { deleteAsset } = require('../services/assetCleanup');
const asyncHandler = require('../utils/asyncHandler');
const { textField } = require('../utils/formField');

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
    const singleTitle = files.length === 1 ? textField(req.body.title).trim() : '';

    // A client holding the OS photo library knows the capture date even when
    // EXIF has been stripped. Parallel array to `photos`, so index i belongs
    // to file i; anything unparseable falls through to the worker's EXIF read.
    const supplied = [].concat(req.body.capturedAt || []);
    const capturedAtFor = (i) => {
      const d = new Date(supplied[i]);
      return supplied[i] && !Number.isNaN(d.getTime()) ? d : null;
    };

    const shared = textField(req.body.visibility) === 'public';

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
        description: textField(req.body.description).slice(0, 2000),
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
 * Every tag in this owner's library with how many photos carry it, most
 * common first. Like the year facet it ignores the active filter, so the tag
 * chips stay put while one of them is selected.
 */
async function tagFacet(ownerId) {
  const rows = await MediaAsset.aggregate([
    { $match: { ownerId, kind: 'photo', 'tags.0': { $exists: true } } },
    { $unwind: '$tags' },
    { $group: { _id: '$tags.key', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
  ]);
  // A key the vocabulary has since dropped is not something the user can
  // search for any more, so it is not offered as a chip either.
  return rows
    .filter((r) => tagger.isKnownTag(r._id))
    .map((r) => ({ key: r._id, label: tagger.labelFor(r._id), count: r.count }));
}

/**
 * GET /api/photos - the timeline, newest capture first, grouped by month.
 *
 * Grouping happens here rather than in the client so every consumer gets the
 * same month boundaries, and so the labels are computed once.
 *
 * ?q= smart search (title, tags, visual similarity), ?tag=beach one tag,
 * ?favorite=1 stars only, ?year=2024 one year.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 60, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const filter = { ownerId: req.user._id, kind: 'photo' };
    if (req.query.status) filter.status = req.query.status;

    // An exact tag, from a tag chip or a suggestion. Unlike ?q= this is a hard
    // filter with no semantic widening: clicking "Beach" means the tag.
    const tag = String(req.query.tag || '').trim();
    if (tag) filter['tags.key'] = tag;

    // Smart search. A photo matches if any of three things is true:
    //   1. its title contains the text - the old behaviour, kept as is
    //   2. it carries every tag the query names ("puppies" -> dog)
    //   3. CLIP rates it as one of the closest images to the text
    // The first two are exact and cheap; the third is what lets "lemons" or
    // "girl with pink eyes" find photos that no tag or title describes.
    const q = String(req.query.q || '').trim().slice(0, 200);
    let search = null;
    if (q) {
      const tagKeys = tagger.tagsForQuery(q);
      const similar = await tagger.semanticMatches(req.user._id, q);

      const any = [{ title: new RegExp(escapeRegex(q), 'i') }];
      if (tagKeys.length) any.push({ 'tags.key': { $all: tagKeys } });
      if (similar?.length) any.push({ _id: { $in: similar } });
      filter.$or = any;

      search = {
        q,
        // 'keyword' when the model is off or not loaded yet - the UI says so
        // rather than implying a visual search ran.
        mode: similar === null ? 'keyword' : 'smart',
        tags: tagKeys.map((key) => ({ key, label: tagger.labelFor(key) })),
      };
    }

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

    const [photos, total, years, favorites, tags, tagging] = await Promise.all([
      MediaAsset.find(filter)
        .sort({ capturedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      MediaAsset.countDocuments(filter),
      yearFacet(req.user._id),
      MediaAsset.countDocuments({ ownerId: req.user._id, kind: 'photo', favorite: true }),
      tagFacet(req.user._id),
      tagger.ENABLED
        ? MediaAsset.countDocuments({ ownerId: req.user._id, kind: 'photo', aiStatus: 'pending' })
        : 0,
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
      facets: { years, favorites, tags },
      search,
      // `tagging` lets the client keep polling until the backlog clears, so
      // tag chips appear without a manual refresh.
      ai: { enabled: tagger.ENABLED, status: tagger.status(), tagging },
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  })
);

const BULK_ACTIONS = ['favorite', 'unfavorite', 'delete'];
const BULK_MAX = 500;

/**
 * POST /api/photos/bulk - one action on many photos: `{ ids, action }`.
 *
 * Backs selection mode on the timeline. The ownerId filter does the access
 * control: ids that are not the caller's photos simply do not match, so they
 * are skipped rather than reported, exactly as a stranger gets 404 not 403 on
 * the single-item routes.
 */
router.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const { ids, action } = req.body || {};
    if (!BULK_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `action must be one of: ${BULK_ACTIONS.join(', ')}` });
    }
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > BULK_MAX) {
      return res.status(400).json({ error: `ids must be an array of 1-${BULK_MAX} photo ids` });
    }
    const valid = ids.filter((id) => typeof id === 'string' && mongoose.isValidObjectId(id));
    const filter = { _id: { $in: valid }, ownerId: req.user._id, kind: 'photo' };

    if (action === 'delete') {
      const photos = await MediaAsset.find(filter);
      // Sequential: each one unlinks files, and a 500-photo batch fired in
      // parallel would open a thousand file handles at once.
      for (const photo of photos) await deleteAsset(photo);
      return res.json({ action, count: photos.length });
    }

    const result = await MediaAsset.updateMany(filter, { $set: { favorite: action === 'favorite' } });
    res.json({ action, count: result.matchedCount });
  })
);

module.exports = router;
