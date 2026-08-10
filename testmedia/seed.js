/**
 * Populates the demo account with a video and a spread of photos so the
 * library and timeline have something to render. Run with the server up:
 *   node testmedia/seed.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { withCaptureDate } = require('./exif');

const BASE = process.env.BASE || 'http://localhost:5000';
const MEDIA = __dirname;
const ffmpeg = require('ffmpeg-static');

const EMAIL = 'demo@flixdrive.local';
const PASSWORD = 'password123';

const PHOTOS = [
  { name: 'beach.jpg', src: 'testsrc',      size: '1400x900', monthsAgo: 0 },
  { name: 'city.jpg', src: 'rgbtestsrc',    size: '1200x800', monthsAgo: 0 },
  { name: 'forest.jpg', src: 'smptebars',   size: '1000x750', monthsAgo: 1 },
  { name: 'desert.jpg', src: 'testsrc2',    size: '1600x900', monthsAgo: 1 },
  { name: 'lake.jpg', src: 'yuvtestsrc',    size: '900x900',  monthsAgo: 3 },
  { name: 'ridge.jpg', src: 'smptehdbars',  size: '1280x720', monthsAgo: 3 },
];

function buildPhotos() {
  for (const p of PHOTOS) {
    const out = path.join(MEDIA, p.name);
    execFileSync(ffmpeg, [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `${p.src}=size=${p.size}:rate=1:duration=1`,
      '-frames:v', '1', out,
    ]);

    const when = new Date();
    when.setMonth(when.getMonth() - p.monthsAgo);
    when.setDate(Math.min(when.getDate(), 27));

    // Stamp a real capture date so the timeline spans several months.
    fs.writeFileSync(out, withCaptureDate(fs.readFileSync(out), when));
  }
}

async function main() {
  buildPhotos();

  let res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: 'Parth' }),
    });
  }
  const { token } = await res.json();
  const auth = { Authorization: `Bearer ${token}` };

  const videoFd = new FormData();
  videoFd.append('title', 'Test Pattern — 6s clip');
  videoFd.append('video', new File([fs.readFileSync(path.join(MEDIA, 'clip.mp4'))], 'clip.mp4', {
    type: 'video/mp4',
  }));
  const vres = await fetch(`${BASE}/api/assets`, { method: 'POST', headers: auth, body: videoFd });
  console.log('video upload:', vres.status);

  const photoFd = new FormData();
  for (const p of PHOTOS) {
    photoFd.append('photos', new File([fs.readFileSync(path.join(MEDIA, p.name))], p.name, {
      type: 'image/jpeg',
    }));
  }
  const pres = await fetch(`${BASE}/api/photos`, { method: 'POST', headers: auth, body: photoFd });
  console.log('photo upload:', pres.status, (await pres.json()).count, 'photos');

  // Give the serial worker time to drain before reporting.
  await new Promise((r) => setTimeout(r, 6000));

  const lib = await (await fetch(`${BASE}/api/assets`, { headers: auth })).json();
  const tl = await (await fetch(`${BASE}/api/photos`, { headers: auth })).json();
  console.log('library:', lib.assets.map((a) => `${a.title} [${a.status}]`).join(', '));
  console.log('timeline:', tl.groups.map((g) => `${g.label} (${g.items.length})`).join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });
