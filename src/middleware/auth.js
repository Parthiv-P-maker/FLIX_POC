const jwt = require('jsonwebtoken');
const User = require('../models/User');

function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

// A <video src="..."> tag cannot send an Authorization header, so the
// stream route needs the token in the query string. Everything else
// should use the header.
function extractToken(req, { allowQuery = false } = {}) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  if (allowQuery && typeof req.query.token === 'string') return req.query.token;
  return null;
}

function requireAuth({ allowQuery = false } = {}) {
  return async function (req, res, next) {
    try {
      const token = extractToken(req, { allowQuery });
      if (!token) return res.status(401).json({ error: 'Missing auth token' });

      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(payload.sub);
      if (!user) return res.status(401).json({ error: 'User no longer exists' });

      req.user = user;
      next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

module.exports = { signToken, requireAuth };
