const multer = require('multer');

/**
 * The single place a thrown error becomes an HTTP response.
 *
 * Anything that reaches here without a recognised shape is a bug, so it is
 * logged in full and reported as a bare 500 - the message could contain a
 * file path or a connection string.
 */
// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
module.exports = function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    // Common when a range stream dies mid-flight: the status line is already
    // out, so the only correct move is to drop the socket.
    return res.destroy();
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const maxMb = Number(process.env.MAX_UPLOAD_MB || 2048);
      return res.status(413).json({ error: `File is larger than the ${maxMb} MB limit` });
    }
    // upload.js signals a rejected MIME type with this code, so the message
    // has to cover both that and a genuinely misnamed form field.
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error: `Unsupported file type, or the wrong form field name (expected "${err.field}")`,
      });
    }
    return res.status(400).json({ error: err.message });
  }

  // A malformed ObjectId in the path is a client mistake, not a server fault.
  if (err.name === 'CastError') {
    return res.status(400).json({ error: `Malformed ${err.path}: "${err.value}"` });
  }

  if (err.name === 'ValidationError') {
    const detail = Object.values(err.errors || {})
      .map((e) => e.message)
      .join('; ');
    return res.status(400).json({ error: detail || 'Validation failed' });
  }

  // Races past the explicit findOne check in the register route.
  if (err.code === 11000) {
    return res.status(409).json({ error: 'That value is already taken' });
  }

  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }

  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: 'Internal server error' });
};
