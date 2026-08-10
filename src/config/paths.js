const fs = require('fs');
const path = require('path');

const STORAGE_ROOT = process.env.STORAGE_ROOT
  ? path.resolve(process.env.STORAGE_ROOT)
  : path.join(__dirname, '..', '..', 'storage');

// Video originals and photo originals are kept apart so a directory listing
// stays meaningful, and so a future move to S3 can lift one bucket at a time.
const UPLOAD_DIR = path.join(STORAGE_ROOT, 'uploads');
const PHOTO_DIR = path.join(STORAGE_ROOT, 'photos');

// Video posters and photo thumbnails share a folder because they are the same
// thing to a client: a small image served statically without auth.
const POSTER_DIR = path.join(STORAGE_ROOT, 'posters');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

function ensureDirs() {
  for (const dir of [UPLOAD_DIR, PHOTO_DIR, POSTER_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Multer resolves its destination at module load, before server.js gets a
// chance to run anything, so the directories have to exist by the time this
// file finishes evaluating.
ensureDirs();

/**
 * One model covers both kinds, but the bytes live in different folders.
 * Everything that needs a real path asks here instead of joining its own,
 * so switching to object storage later is a change to this file alone.
 */
function sourceDirFor(kind) {
  return kind === 'photo' ? PHOTO_DIR : UPLOAD_DIR;
}

function sourcePathFor(asset) {
  return path.join(sourceDirFor(asset.kind), asset.storageKey);
}

module.exports = {
  STORAGE_ROOT,
  UPLOAD_DIR,
  PHOTO_DIR,
  POSTER_DIR,
  PUBLIC_DIR,
  ensureDirs,
  sourceDirFor,
  sourcePathFor,
};
