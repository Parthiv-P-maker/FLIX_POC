const express = require('express');
const User = require('../models/User');
const { signToken, requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.post(
  '/register',
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

module.exports = router;
