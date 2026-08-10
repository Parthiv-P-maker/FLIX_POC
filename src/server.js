require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const connectDB = require('./config/db');
const { POSTER_DIR, PUBLIC_DIR } = require('./config/paths');
const errorHandler = require('./middleware/errorHandler');
const { getQueueDepth } = require('./services/mediaProcessor');

// Every token this process issues or accepts is signed with it, so booting
// without one would silently accept `undefined` as the secret.
if (!process.env.JWT_SECRET) {
  console.error('[server] JWT_SECRET is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    // Without exposedHeaders the browser hides these from JS, and any
    // client-side logic that reads Content-Range silently sees null.
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// Posters are small, public-ish images - plain static serving is fine.
// Video never goes through express.static; it needs the range route.
app.use('/static/posters', express.static(POSTER_DIR, { maxAge: '1h' }));

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
app.use('/api/progress', require('./routes/progress.routes'));

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] listening on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('[server] failed to start:', err.message);
    process.exit(1);
  });

module.exports = app;
