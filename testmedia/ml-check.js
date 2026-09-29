/**
 * `npm run test:ml` - checks the image model itself, without a server or a
 * database.
 *
 * Separate from `npm test` on purpose: the first run downloads ~150 MB of
 * CLIP weights, which the API suite must never depend on. Run this after
 * changing the vocabulary, the model or the thresholds in
 * services/imageTagger.js.
 *
 * The fixtures are ffmpeg test patterns (testmedia/seed.js generates them if
 * missing), so the checks are about behaviour the patterns can show: the
 * classifier recognises them, and free-text search ranks them sensibly.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const tagger = require('../src/services/imageTagger');

const MEDIA = __dirname;
let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// Generated on demand, same as seed.js, so a clean checkout can run this.
function fixture(name, src, size) {
  const file = path.join(MEDIA, name);
  if (!fs.existsSync(file)) {
    execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `${src}=size=${size}`,
      '-frames:v', '1', file]);
  }
  return file;
}

async function main() {
  if (!tagger.ENABLED) {
    console.log('ML_ENABLED=false - nothing to check.');
    return;
  }

  console.log('\nclassification');
  const bars = fixture('forest.jpg', 'smptebars', '1000x750');
  const barsVec = await tagger.embedImage(bars);
  check('embedding is a unit vector of 512 floats',
    barsVec.length === 512 && Math.abs(tagger.dot(barsVec, barsVec) - 1) < 1e-3,
    `len=${barsVec.length}`);

  const tags = tagger.classify(barsVec);
  check('colour bars are tagged as a test pattern', tags[0]?.key === 'test-pattern',
    tags.map((t) => `${t.key}:${t.score}`).join(' '));
  check('at most four tags, all above the confidence floor',
    tags.length <= 4 && tags.every((t) => t.score >= 0.1));

  console.log('\nsearch');
  const relevant = await tagger.embedQuery('TV colour bars test card');
  const unrelated = await tagger.embedQuery('a golden retriever puppy');
  const sRel = tagger.dot(relevant, barsVec);
  const sUnrel = tagger.dot(unrelated, barsVec);
  check('a matching description scores above an unrelated one', sRel > sUnrel + 0.03,
    `${sRel.toFixed(3)} vs ${sUnrel.toFixed(3)}`);
  check('an unrelated query stays under the search floor', sUnrel < 0.24, sUnrel.toFixed(3));

  console.log('\nquery parsing');
  check('plural resolves to its tag', tagger.tagsForQuery('puppies')[0] === 'dog');
  check('alias resolves to its tag', tagger.tagsForQuery('golden hour')[0] === 'sunset');
  check('two tag words resolve to both',
    JSON.stringify(tagger.tagsForQuery('dog beach')) === '["dog","beach"]');
  check('a phrase with a non-tag word resolves to none',
    tagger.tagsForQuery('dog wearing a hat').length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
