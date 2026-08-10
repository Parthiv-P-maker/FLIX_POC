const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { UPLOAD_DIR, PHOTO_DIR } = require('../config/paths');

const ALLOWED_MIME = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
]);

// HEIC is deliberately absent: the bundled ffmpeg build has no HEVC image
// decoder, so accepting it would just queue uploads that fail in the worker.
const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

function randomName(originalname, fallbackExt) {
  const ext = path.extname(originalname).toLowerCase() || fallbackExt;
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

// diskStorage streams straight to disk. memoryStorage would buffer the
// whole file in RAM - fatal for a 2GB upload.
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, randomName(file.originalname, '.mp4')),
});

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTO_DIR),
  filename: (req, file, cb) => cb(null, randomName(file.originalname, '.jpg')),
});

// multer has no "wrong content type" code, so a rejected MIME reuses
// LIMIT_UNEXPECTED_FILE. errorHandler turns both cases into one 400 that
// mentions the type and the field name.
function filterBy(allowed, field) {
  return function (req, file, cb) {
    if (!allowed.has(file.mimetype)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', field));
    }
    cb(null, true);
  };
}

const maxMb = Number(process.env.MAX_UPLOAD_MB || 2048);
const maxPhotoMb = Number(process.env.MAX_PHOTO_MB || 25);

const uploadVideo = multer({
  storage: videoStorage,
  fileFilter: filterBy(ALLOWED_MIME, 'video'),
  limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
}).single('video');

// Batched on purpose - a timeline is populated by dropping a folder in, and
// one request per photo would mean one round trip per photo.
const uploadPhotos = multer({
  storage: photoStorage,
  fileFilter: filterBy(ALLOWED_IMAGE_MIME, 'photos'),
  limits: { fileSize: maxPhotoMb * 1024 * 1024, files: 20 },
}).array('photos', 20);

module.exports = { uploadVideo, uploadPhotos, ALLOWED_MIME, ALLOWED_IMAGE_MIME };
