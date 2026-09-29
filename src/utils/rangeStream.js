const fs = require('fs');

// One megabyte per chunk when the browser asks for an open-ended range
// ("bytes=0-"). Serving the entire file in one response would work but
// would defeat the point: the browser could not cheaply seek.
const CHUNK_SIZE = 1 * 1024 * 1024;

/**
 * Pipe a read stream to the response with the teardown every send needs.
 *
 * The browser aborts in-flight requests constantly while seeking, and a read
 * can fail at any point. Without the 'error' handler an I/O failure is an
 * unhandled 'error' event, which in Node is an uncaught exception that takes
 * the whole process down.
 */
function pipeFile(filePath, res, req, options = {}) {
  const stream = fs.createReadStream(filePath, options);

  stream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.status(500).json({ error: 'Failed to read the underlying file' });
  });
  // Without this the file descriptor leaks on every scrub.
  req.on('close', () => stream.destroy());

  stream.pipe(res);
}

/**
 * Answer a request for a file's bytes, honouring Range.
 *
 * Chrome and Safari send a Range header on the very first request for a
 * <video> source. Answering with 200 + the whole file works but makes the
 * scrub bar refuse to seek; 206 with a correct Content-Range is what makes
 * seeking work.
 *
 * Shared by the authenticated stream route and the public share route so the
 * two cannot disagree about range semantics - the subtle parts (clamping,
 * when to 416, the open-ended chunk size) are exactly the parts nobody wants
 * to maintain twice.
 */
function sendRange({ req, res, filePath, fileSize, mimeType, cacheControl }) {
  const range = req.headers.range;
  const cache = cacheControl || 'private, max-age=0, no-cache';

  // No Range header: send the whole file, but advertise that we support
  // ranges so the browser knows it may ask for one next time.
  if (!range) {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache,
    });
    return pipeFile(filePath, res, req);
  }

  // Range looks like "bytes=1048576-" or "bytes=1048576-2097151".
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
  }

  const start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : Math.min(start + CHUNK_SIZE - 1, fileSize - 1);

  // Clamp before use. An out-of-range start must be 416, and an end past
  // EOF must be pulled back or createReadStream throws.
  if (Number.isNaN(start) || start >= fileSize || start < 0) {
    return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
  }
  end = Math.min(end, fileSize - 1);
  // "bytes=500-100" is unsatisfiable per RFC 7233. Serving from `start` to EOF
  // instead answers a question the client did not ask.
  if (end < start) {
    return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
  }

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': mimeType,
    'Cache-Control': cache,
  });

  return pipeFile(filePath, res, req, { start, end });
}

module.exports = { sendRange, pipeFile, CHUNK_SIZE };
