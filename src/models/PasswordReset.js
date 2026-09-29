const crypto = require('crypto');
const mongoose = require('mongoose');

const TTL_MINUTES = Number(process.env.RESET_TOKEN_TTL_MIN || 30);

/**
 * A pending password reset.
 *
 * Its own collection rather than fields on User, for two reasons: the rows are
 * short-lived and want a TTL index, and a reset in flight should not make the
 * User document dirty.
 *
 * The token is stored **hashed**. Someone with read access to this collection -
 * a leaked backup, an aggregation endpoint that says too much - must not be
 * able to take over accounts with what they find, and a raw token here would
 * let them do exactly that. SHA-256 rather than bcrypt because unlike a
 * password this value is 256 bits of CSPRNG output: there is nothing to brute
 * force, and the lookup happens on a hot path.
 */
const passwordResetSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    tokenHash: { type: String, required: true, unique: true },

    expiresAt: { type: Date, required: true },

    // Single use. Kept rather than deleted on use so a replayed link can be
    // told apart from one that never existed, if that is ever worth logging.
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Mongo sweeps expired rows on its own, so nothing has to remember to.
// expireAfterSeconds: 0 means "delete when expiresAt passes".
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Mint a reset for a user, invalidating any earlier one.
 *
 * Requesting a second reset must retire the first: otherwise every request
 * ever made stays live until it expires, and the window for a leaked link
 * grows with each attempt.
 */
passwordResetSchema.statics.issue = async function issue(userId) {
  await this.deleteMany({ userId });

  const token = crypto.randomBytes(32).toString('hex');
  await this.create({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),
  });

  // The raw token is returned exactly once, to be mailed. It is never
  // recoverable from the database afterwards.
  return { token, expiresInMinutes: TTL_MINUTES };
};

/** Resolve a raw token to a live reset, or null. */
passwordResetSchema.statics.consume = async function consume(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;

  const row = await this.findOne({
    tokenHash: hashToken(token),
    usedAt: null,
    // The TTL index is a background sweep that runs about once a minute, so a
    // just-expired row can still be sitting there. Check the time explicitly.
    expiresAt: { $gt: new Date() },
  });

  return row;
};

module.exports = mongoose.model('PasswordReset', passwordResetSchema);
module.exports.TTL_MINUTES = TTL_MINUTES;
