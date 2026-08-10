const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'That does not look like an email address'],
    },
    displayName: { type: String, required: true, trim: true, maxlength: 80 },

    // select:false keeps the hash out of every incidental query, so a stray
    // res.json(user) cannot leak it.
    passwordHash: { type: String, required: true, select: false },
  },
  { timestamps: true }
);

// Callers write `user.password = plain`, never `user.passwordHash`. The
// plaintext is stashed on the document and never persisted - there is no
// matching path in the schema.
userSchema.virtual('password').set(function (plain) {
  this._plainPassword = plain;
});

// This must be pre-validate, not pre-save. Mongoose registers validation as
// its own pre-save hook when the schema is built, which puts it ahead of any
// hook we add later - a pre-save hash would run after `passwordHash` had
// already been rejected as missing.
userSchema.pre('validate', async function (next) {
  if (!this._plainPassword) return next();
  try {
    this.passwordHash = await bcrypt.hash(this._plainPassword, SALT_ROUNDS);
    this._plainPassword = undefined;
    next();
  } catch (err) {
    next(err);
  }
});

userSchema.methods.verifyPassword = function (plain) {
  // Guard the undefined case: without .select('+passwordHash') the field is
  // absent and bcrypt.compare would throw rather than return false.
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(String(plain), this.passwordHash);
};

userSchema.methods.toPublic = function () {
  return {
    id: this._id,
    email: this.email,
    displayName: this.displayName,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('User', userSchema);
