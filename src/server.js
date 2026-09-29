require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const morgan = require('morgan');

const connectDB = require('./config/db');
const { PUBLIC_DIR } = require('./config/paths');
const errorHandler = require('./middleware/errorHandler');
const { getQueueDepth, requeueInterrupted } = require('./services/mediaProcessor');

// Every token this process issues or accepts is signed with it, so booting
// without one would silently accept `undefined` as the secret.
if (!process.env.JWT_SECRET) {
  console.error('[server] JWT_SECRET is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // The progress bar and the justified photo cells set their width and
        // height as style attributes, so a bare 'self' would break the layout.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        mediaSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  })
);

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    // Without exposedHeaders the browser hides these from JS, and any
    // client-side logic that reads Content-Range silently sees null.
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
  })
);

app.use(express.json({ limit: '1mb' }));

// A <video src> and an <img src> cannot carry an Authorization header, so the
// stream and poster routes accept ?token=. morgan logs the full URL, which
// would write a working 7-day credential to disk on every seek - so override
// the built-in `url` token to blank the value out first. This applies to every
// morgan format, including the 'dev' one below.
const SENSITIVE_PARAMS = new Set(['token']);
morgan.token('url', (req) => {
  const raw = req.originalUrl || req.url;
  const split = raw.indexOf('?');
  if (split === -1) return raw;

  const params = new URLSearchParams(raw.slice(split + 1));
  const sensitive = [...params.keys()].filter((k) => SENSITIVE_PARAMS.has(k));
  if (sensitive.length === 0) return raw;

  sensitive.forEach((k) => params.set(k, 'REDACTED'));
  return `${raw.slice(0, split)}?${params}`;
});

app.use(morgan('dev'));

// The demo client is served from the same origin as the API, which is why it
// never trips CORS and why <video src="/api/stream/..."> just works.
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, queueDepth: getQueueDepth(), uptimeSec: Math.round(process.uptime()) });
});

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/profile', require('./routes/profile.routes'));
app.use('/api/assets', require('./routes/assets.routes'));
app.use('/api/catalog', require('./routes/catalog.routes'));
app.use('/api/photos', require('./routes/photos.routes'));
app.use('/api/stream', require('./routes/stream.routes'));
// Posters and thumbnails used to sit behind express.static with no auth at
// all. They are derived from the original, so they need the original's rules.
app.use('/api/posters', require('./routes/posters.routes'));
// The only unauthenticated API surface. Possession of the 128-bit slug is the
// authorisation, which is the whole point of a share link.
app.use('/api/share', require('./routes/share.routes'));
app.use('/api/progress', require('./routes/progress.routes'));

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

/**
 * A rejection nobody caught is a bug, and the default is to print a warning
 * and carry on in an unknown state. Log it loudly and keep serving: this is a
 * media server, and killing an in-flight stream over an unrelated bug is worse
 * than continuing. An uncaught *exception* is different - the process is not
 * safe to continue after one, so it exits and lets the supervisor restart it.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception, shutting down:', err);
  process.exit(1);
});

connectDB()
  .then(async () => {
    // The worker queue lives in memory, so anything mid-flight when the
    // process last stopped is now a row stuck at 'processing' that nothing
    // will ever pick up again. The bytes are still on disk, so the job is
    // simply re-runnable - do it before accepting traffic.
    const recovered = await requeueInterrupted();
    if (recovered > 0) {
      console.log(`[server] re-queued ${recovered} asset(s) interrupted by the last shutdown`);
    }

    const server = app.listen(PORT, () =>
      console.log(`[server] listening on http://localhost:${PORT}`)
    );

    /**
     * Stop accepting connections, let in-flight requests finish, then close
     * the database. Without this a deploy or a Ctrl-C cuts active range
     * streams mid-chunk and leaves mongoose connections for the driver to
     * time out.
     *
     * The timer is the backstop: a client holding a long download would
     * otherwise keep the process alive indefinitely. unref() so it cannot by
     * itself be the reason we stay running.
     */
    const shutdown = (signal) => {
      console.log(`[server] ${signal} received, closing down`);

      const force = setTimeout(() => {
        console.error('[server] forced exit: connections did not drain in 10s');
        process.exit(1);
      }, 10_000);
      force.unref();

      server.close(async () => {
        await mongoose.connection.close().catch(() => {});
        console.log('[server] closed cleanly');
        process.exit(0);
      });
    };

    ['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => shutdown(sig)));
  })
  .catch((err) => {
    console.error('[server] failed to start:', err.message);
    process.exit(1);
  });

module.exports = app;
