const crypto = require('crypto');
const mongoose = require('mongoose');

// Status is a state machine: uploading -> processing -> ready | failed
const STATUSES = ['uploading', 'processing', 'ready', 'failed'];
const VISIBILITIES = ['private', 'unlisted', 'public'];

// Phase 3 rides on this same document rather than a parallel Photo model.
// Ownership, visibility, the processing state machine and the delete path are
// identical for both; only the worker branch differs.
const KINDS = ['video', 'photo'];

const mediaAssetSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    kind: { type: String, enum: KINDS, default: 'video', index: true },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 2000 },

    // Storage: `storageKey` is a filename today, an S3 object key later.
    // Nothing outside services/storage should assume it is a local path.
    storageKey: { type: String, required: true },
    originalFilename: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },

    // Filled in by the ffmpeg worker. Photos leave durationSec null.
    durationSec: { type: Number, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    posterKey: { type: String, default: null },

    // When the photo was taken, not when it was uploaded - the timeline sorts
    // on this. Falls back to the file's mtime when there is no usable EXIF.
    capturedAt: { type: Date, default: null },

    // Starred by the owner. Photos only in practice, but the field costs
    // nothing on a video row and keeps the toggle route kind-agnostic.
    favorite: { type: Boolean, default: false },

    status: { type: String, enum: STATUSES, default: 'uploading', index: true },
    processingError: { type: String, default: null },

    // Uploads are private until the owner shares them. Anything not 'private'
    // is in the public catalog.
    visibility: { type: String, enum: VISIBILITIES, default: 'private', index: true },

    // Set the moment visibility leaves 'private', cleared when it returns.
    // The catalog's "New" rail sorts on this rather than createdAt: a video
    // uploaded last month but shared today is new *to the catalog*.
    sharedAt: { type: Date, default: null },

    // The capability that makes a share link work. Minted alongside sharedAt
    // and destroyed with it, so revoking a share revokes every link that was
    // ever handed out. 128 bits of randomness because possessing this *is*
    // the authorisation - unlike the asset id, it must not be guessable.
    // Uniqueness is enforced by a partial index below, not here; see why.
    shareSlug: { type: String, default: null },

    // Bumped once per playback by POST /api/assets/:id/view, not by the range
    // route - a single viewing issues dozens of range requests.
    viewCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

mediaAssetSchema.index({ ownerId: 1, createdAt: -1 });

// The photo timeline pages through one owner's photos newest-capture-first.
mediaAssetSchema.index({ ownerId: 1, kind: 1, capturedAt: -1 });

// The catalog reads across every owner, so it needs an index that does not
// start with ownerId. Both rails filter the same prefix and differ only in
// the sort, which is why sharedAt and viewCount are separate indexes.
mediaAssetSchema.index({ visibility: 1, kind: 1, status: 1, sharedAt: -1 });
mediaAssetSchema.index({ visibility: 1, kind: 1, status: 1, viewCount: -1 });

/**
 * Share links are looked up by slug on every request to /api/share, and two
 * assets must never share one.
 *
 * Partial, not sparse. A sparse index only skips documents where the field is
 * *absent* - an explicit null is still indexed, so with `default: null` every
 * unshared asset would index the same null and the second one inserted would
 * collide. That is not hypothetical: it broke batch photo upload, which uses
 * insertMany and therefore writes the default straight through.
 */
mediaAssetSchema.index(
  { shareSlug: 1 },
  { unique: true, partialFilterExpression: { shareSlug: { $type: 'string' } } }
);

/**
 * `ownerId` is an ObjectId on a plain query and a User document once the
 * caller has populated it. The catalog needs the display name; the library
 * does not populate and must not crash. This normalises both shapes.
 */
function ownerOf(asset) {
  const raw = asset.ownerId;
  if (raw && typeof raw === 'object' && raw.displayName) {
    return { id: raw._id, displayName: raw.displayName };
  }
  return { id: raw, displayName: null };
}

/**
 * `req.user` is set by requireAuth on every route that reaches here, so the
 * viewer-relative flags come for free without threading an extra argument
 * through each call site.
 */
mediaAssetSchema.methods.toPublic = function (req) {
  const base = req ? `${req.protocol}://${req.get('host')}` : '';
  const isPhoto = this.kind === 'photo';
  const owner = ownerOf(this);
  const isOwner = Boolean(req?.user) && String(owner.id) === String(req.user._id);

  const json = {
    id: this._id,
    ownerId: owner.id,
    ownerName: owner.displayName,
    // Delete, rename and the share toggle are all owner-only. The client
    // reads this one flag rather than re-deriving it from ownerId.
    isOwner,
    kind: this.kind,
    title: this.title,
    description: this.description,
    mimeType: this.mimeType,
    sizeBytes: this.sizeBytes,
    width: this.width,
    height: this.height,
    status: this.status,
    visibility: this.visibility,
    // 'shared' has always meant "in the public catalog", and the Browse view
    // reads it that way, so it stays pinned to 'public' now that 'unlisted'
    // is a real third state rather than a placeholder in the enum.
    shared: this.visibility === 'public',
    linkShared: this.visibility === 'unlisted',
    sharedAt: this.sharedAt,
    viewCount: this.viewCount || 0,
    favorite: Boolean(this.favorite),
    processingError: this.processingError,
    // Keyed by asset id, not by posterKey: the route resolves the filename
    // itself after checking who is asking, so the storage layout stays private.
    // Needs a ?token= like the stream URL - an <img src> cannot send headers.
    posterUrl: this.posterKey ? `${base}/api/posters/${this._id}` : null,
    createdAt: this.createdAt,
  };

  // Owner only, and deliberately so: the slug is a bearer credential. Handing
  // it to every viewer of a public video would turn "anyone signed in can
  // watch this" into "anyone at all can", permanently and untraceably.
  if (isOwner && this.shareSlug) {
    json.shareUrl = `${base}/share.html?s=${this.shareSlug}`;
  }

  if (isPhoto) {
    json.capturedAt = this.capturedAt || this.createdAt;
    // Same range-capable route as video; for an image the browser just takes
    // the whole body. Named differently so a client cannot mistake a photo
    // for something it should hand to a <video> element.
    json.originalUrl = `${base}/api/stream/${this._id}`;
  } else {
    json.durationSec = this.durationSec;
    json.streamUrl = `${base}/api/stream/${this._id}`;
  }

  return json;
};

/**
 * Keep sharedAt and shareSlug in lockstep with visibility so no route has to
 * remember to. Re-sharing something restamps sharedAt, which is deliberate: it
 * should reappear at the top of the "New" rail.
 *
 * The slug is minted once and then kept for as long as the asset is shared at
 * all, so flipping between 'unlisted' and 'public' does not invalidate a link
 * someone has already been given. Going back to 'private' destroys it - that
 * is the revoke, and it has to be a real one, so a link handed out before
 * stops working rather than springing back to life on the next share.
 */
mediaAssetSchema.pre('save', function (next) {
  if (this.isModified('visibility') || this.isNew) {
    const isPrivate = this.visibility === 'private';

    this.sharedAt = isPrivate ? null : new Date();

    if (isPrivate) {
      this.shareSlug = null;
    } else if (!this.shareSlug) {
      this.shareSlug = crypto.randomBytes(16).toString('hex');
    }
  }
  next();
});

module.exports = mongoose.model('MediaAsset', mediaAssetSchema);
module.exports.STATUSES = STATUSES;
module.exports.KINDS = KINDS;
module.exports.VISIBILITIES = VISIBILITIES;
