const fs = require('fs/promises');
const multer = require('multer');

/**
 * Multer writes uploads to disk *before* the route handler runs, so any
 * failure after that point - a validation error, a dropped database
 * connection, or multer's own file-count limit tripping on the 21st file -
 * leaves bytes in storage/ with no row pointing at them and nothing to ever
 * clean them up.
 *
 * Doing this here rather than in each route covers both cases at once: an
 * error thrown by the handler and an error thrown by the upload middleware
 * itself. On success this function never runs, so the files are kept.
 */
async function discardUploads(req) {
  const files = [...(req.files || []), ...(req.file ? [req.file] : [])];
  if (files.length === 0) return;

  const results = await Promise.allSettled(files.map((f) => fs.unlink(f.path)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    console.error(`[cleanup] could not remove ${failed} orphaned upload(s) after a failed request`);
  }
}

/**
 * The single place a thrown error becomes an HTTP response.
 *
 * Anything that reaches here without a recognised shape is a bug, so it is
 * logged in full and reported as a bare 500 - the message could contain a
 * file path or a connection string.
 */
// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
module.exports = function errorHandler(err, req, res, next) {
  // Fire and forget: the response below must not wait on disk I/O, and a
  // failure to unlink is a log line, never a different status code.
  discardUploads(req).catch(() => {});

  if (res.headersSent) {
    // Common when a range stream dies mid-flight: the status line is already
    // out, so the only correct move is to drop the socket.
    return res.destroy();
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      // The limit depends on which upload tripped it. Reading MAX_UPLOAD_MB
      // unconditionally told someone with a 30 MB photo that they had exceeded
      // "the 2048 MB limit" - wrong, and impossible to act on. err.field is
      // already 'video' or 'photos'.
      const isPhoto = err.field === 'photos';
      const maxMb = Number(
        isPhoto ? process.env.MAX_PHOTO_MB || 25 : process.env.MAX_UPLOAD_MB || 2048
      );
      const noun = isPhoto ? 'Each photo' : 'The video';
      return res.status(413).json({ error: `${noun} must be under ${maxMb} MB` });
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
