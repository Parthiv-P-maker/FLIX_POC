/**
 * The media files the suite and the seed script upload.
 *
 * They are gitignored (testmedia/*.mp4, *.jpg, *.png), so a fresh clone - and
 * every CI run - starts without them. Each one is an ffmpeg test pattern built
 * with the bundled binary, which keeps the repo small and needs nothing
 * installed. A file that already exists is left alone.
 *
 * The shapes are load-bearing: e2e.js asserts the probed dimensions (640x360
 * video, 1200x800 photo) and a duration over 5 s, and the PNG carries an alpha
 * channel so the thumbnail path sees a transparent source.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const MEDIA = __dirname;

const FIXTURES = [
  {
    name: 'clip.mp4',
    args: [
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    ],
  },
  {
    name: 'photo1.jpg',
    args: ['-f', 'lavfi', '-i', 'testsrc2=size=1200x800:rate=1:duration=1', '-frames:v', '1'],
  },
  {
    name: 'photo2.png',
    args: [
      '-f', 'lavfi', '-i', 'rgbtestsrc=size=900x900:rate=1:duration=1',
      '-frames:v', '1', '-vf', 'format=rgba',
    ],
  },
];

function ensureFixtures() {
  const built = [];
  for (const f of FIXTURES) {
    const out = path.join(MEDIA, f.name);
    if (fs.existsSync(out)) continue;
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...f.args, out]);
    built.push(f.name);
  }
  return built;
}

module.exports = { ensureFixtures, MEDIA };
