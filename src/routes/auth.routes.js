const express = require('express');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const PasswordReset = require('../models/PasswordReset');
const { signToken, signMediaToken, requireAuth } = require('../middleware/auth');
const { send, renderResetEmail } = require('../services/mailer');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

/**
 * An 8-character minimum is not a defence on its own - without a limit here,
 * login is an unbounded guessing oracle. The window is per IP.
 *
 * The numbers are deliberately loose enough that a human who forgets their
 * password twice is never locked out, and that the e2e suite can run several
 * times in a row, while still being far too tight to brute-force through.
 * Both are env-tunable so a demo can relax them without editing code.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_LOGIN || 20),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in a few minutes.' },
});

// Slower still: registration is how the database gets filled by a script.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_REGISTER || 15),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many accounts created from here. Try again later.' },
});

router.post(
  '/register',
  registerLimiter,
  asyncHandler(async (req, res) => {
    const { email, password, displayName } = req.body || {};

    if (!email || !password || !displayName) {
      return res.status(400).json({ error: 'email, password and displayName are required' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await User.findOne({ email: String(email).toLowerCase() });
    if (existing) return res.status(409).json({ error: 'That email is already registered' });

    const user = new User({ email, displayName });
    user.password = password;
    await user.save();

    res.status(201).json({ user: user.toPublic(), token: signToken(user._id) });
  })
);

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    // passwordHash has select:false, so ask for it explicitly here.
    const user = await User.findOne({ email: String(email).toLowerCase() }).select('+passwordHash');

    // Same message either way, so the response cannot be used to
    // enumerate which emails exist.
    const ok = user && (await user.verifyPassword(password));
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    res.json({ user: user.toPublic(), token: signToken(user._id) });
  })
);

router.get('/me', requireAuth(), (req, res) => {
  res.json({ user: req.user.toPublic() });
});

/**
 * GET /api/auth/media-token
 *
 * Exchanges the session token - sent as a header, as always - for a
 * short-lived one the client can safely put in a <video> or <img> src. See
 * middleware/auth.js for why the two are kept apart.
 */
router.get('/media-token', requireAuth(), (req, res) => {
  res.json({
    token: signMediaToken(req.user._id),
    // So the client knows when to ask again rather than guessing, or worse,
    // discovering the expiry through a broken image.
    expiresIn: process.env.MEDIA_TOKEN_TTL || '2h',
  });
});

/**
 * Asking for a reset is its own rate-limit bucket. Without one this is both a
 * mail-bomb relay and an account-enumeration oracle driven by timing.
 */
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_RESET || 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many reset requests. Try again later.' },
});

/**
 * POST /api/auth/forgot-password
 *
 * Always answers the same way, whether or not the email is registered. Saying
 * "no such account" here would undo the care taken in the login route, which
 * deliberately returns one message for both failure modes.
 */
router.post(
  '/forgot-password',
  resetLimiter,
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();

    const sameAnswer = {
      ok: true,
      message: 'If that email has an account, a reset link is on its way.',
    };

    if (!email) return res.status(400).json({ error: 'email is required' });

    const user = await User.findOne({ email });
    if (!user) return res.json(sameAnswer);

    const { token, expiresInMinutes } = await PasswordReset.issue(user._id);

    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${base}/reset.html?token=${token}`;

    await send(renderResetEmail({ to: user.email, resetUrl, expiresInMinutes }));

    res.json(sameAnswer);
  })
);

/**
 * POST /api/auth/reset-password
 *
 * Consumes the token and sets the new password. Does NOT sign the user in:
 * completing a reset proves control of the mailbox, and dropping them at the
 * login screen to use the password they just chose is both a confirmation that
 * it worked and one less way to end up with a session nobody meant to create.
 */
router.post(
  '/reset-password',
  resetLimiter,
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body || {};

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'token and newPassword are required' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const reset = await PasswordReset.consume(token);
    // One message for expired, already-used, and never-existed. The difference
    // is not useful to a legitimate user and is useful to everyone else.
    if (!reset) {
      return res.status(400).json({ error: 'That reset link is invalid or has expired' });
    }

    const user = await User.findById(reset.userId);
    if (!user) return res.status(400).json({ error: 'That reset link is invalid or has expired' });

    user.password = newPassword;
    await user.save();

    // Burn the token before answering, so a replayed request cannot land in
    // the window between the save and the update.
    reset.usedAt = new Date();
    await reset.save();

    res.json({ ok: true });
  })
);

module.exports = router;
