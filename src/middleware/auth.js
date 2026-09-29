const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Two kinds of token, and they are not interchangeable.
 *
 * A session token is the real credential: it authorises everything, including
 * deleting your library and changing your password. It travels in an
 * Authorization header, where it stays out of URLs, logs, browser history and
 * Referer headers.
 *
 * A media token exists because <video src> and <img src> cannot send headers,
 * so the stream and poster routes have no choice but to accept a credential in
 * the query string. Putting the *session* token there - which is what this used
 * to do - meant a 7-day key to the whole account was written into every access
 * log, every history entry, and every referrer a share page sent. The media
 * token is scoped to reading bytes and expires in hours, not days.
 *
 * The separation is only worth anything if it is enforced in both directions,
 * so a media token is rejected on the header path too. Otherwise it would be a
 * full session credential wearing a shorter expiry.
 */
const MEDIA_PURPOSE = 'media';

function signToken(userId) {
  return jwt.sign({ sub: String(userId), purpose: 'session' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

/**
 * Long enough to watch a film without the URL going stale mid-playback, short
 * enough that a leaked one is worth little. The client refreshes it on a timer
 * and again before opening the player.
 */
function signMediaToken(userId) {
  return jwt.sign({ sub: String(userId), purpose: MEDIA_PURPOSE }, process.env.JWT_SECRET, {
    expiresIn: process.env.MEDIA_TOKEN_TTL || '2h',
  });
}

function extractToken(req, { allowQuery = false } = {}) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return { token: header.slice(7), fromQuery: false };
  }
  if (allowQuery && typeof req.query.token === 'string') {
    return { token: req.query.token, fromQuery: true };
  }
  return { token: null, fromQuery: false };
}

function requireAuth({ allowQuery = false } = {}) {
  return async function (req, res, next) {
    try {
      const { token, fromQuery } = extractToken(req, { allowQuery });
      if (!token) return res.status(401).json({ error: 'Missing auth token' });

      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const isMedia = payload.purpose === MEDIA_PURPOSE;

      // A media token in a header would be a session token with a shorter
      // life; a session token in a URL is the leak this whole split exists to
      // prevent. Neither is a mistake worth being lenient about.
      if (fromQuery && !isMedia) {
        return res.status(401).json({ error: 'This URL needs a media token, not a session token' });
      }
      if (!fromQuery && isMedia) {
        return res.status(401).json({ error: 'A media token cannot be used for this request' });
      }

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

module.exports = { signToken, signMediaToken, requireAuth, MEDIA_PURPOSE };
