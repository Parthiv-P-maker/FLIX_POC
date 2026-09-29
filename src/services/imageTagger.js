const path = require('path');
const MediaAsset = require('../models/MediaAsset');
const { POSTER_DIR, sourcePathFor } = require('../config/paths');
const { VOCABULARY } = require('../config/tagVocabulary');

/**
 * Image understanding for the photo timeline: automatic tags and smart search.
 *
 * One model does both jobs. CLIP maps an image and a sentence into the same
 * 512-dimensional space, so "how well does this photo match this text" is a
 * dot product. That gives:
 *
 *   - classification: score every photo against the captions in
 *     config/tagVocabulary.js and keep the best few as tags, and
 *   - free-text search: embed whatever the user typed and rank their photos
 *     by similarity, so "lemons" or "dog on a beach" work with no tag for it.
 *
 * It runs in-process on the CPU through ONNX Runtime (transformers.js), so
 * there is no Python service and no API key. The quantised model is ~150 MB,
 * downloaded from the Hugging Face hub on first use and cached in
 * MODEL_CACHE_DIR. Inference is ~100 ms per photo on a laptop.
 *
 * Everything here is best effort. A photo becomes 'ready' before it is tagged,
 * and if the model cannot load (offline first run, ML_ENABLED=false) the
 * timeline and plain title search keep working exactly as before.
 */

const ENABLED = String(process.env.ML_ENABLED ?? 'true').toLowerCase() !== 'false';
const MODEL_ID = process.env.ML_MODEL || 'Xenova/clip-vit-base-patch32';
// q8 is the quantised build: a quarter of the download, and on this project's
// photos it picked the same top tag as fp32. Set ML_DTYPE=fp32 to compare.
const DTYPE = process.env.ML_DTYPE || 'q8';
const CACHE_DIR = process.env.MODEL_CACHE_DIR
  ? path.resolve(process.env.MODEL_CACHE_DIR)
  : path.join(__dirname, '..', '..', '.model-cache');

// Stored on every tagged asset. Changing the model, the precision or the
// vocabulary changes this string, and boot re-tags everything that carries an
// older one - so tags never silently mix two vocabularies.
const VOCAB_REVISION = 1;
const TAGGER_VERSION = `${MODEL_ID}@${DTYPE}#v${VOCAB_REVISION}`;

// CLIP's learned temperature. Softmax over (100 x cosine) turns raw
// similarities into a distribution across the vocabulary.
const LOGIT_SCALE = 100;
// A label needs this share of the probability mass to become a tag. With ~50
// labels, chance is 2%; 10% means the model clearly preferred it.
const TAG_MIN_PROB = 0.10;
const MAX_TAGS = 4;

// Free-text search thresholds, tuned on real photos. A matching text-image
// pair scores ~0.25-0.32 cosine; unrelated pairs sit around 0.20-0.23.
//   floor - below this nothing counts, however good it is relative to the rest
//   band  - keep only photos within this distance of the best match, so a
//           query with one clear hit does not drag in the runners-up
const SEARCH_FLOOR = 0.24;
const SEARCH_BAND = 0.025;

// A failed load is retried, but not on every photo in a 500-photo backfill.
const RETRY_AFTER_MS = 5 * 60 * 1000;

const VOCAB_BY_KEY = new Map(VOCABULARY.map((v) => [v.key, v]));

let loading = null;
let models = null;
let labelEmbeds = null;
let lastError = null;
let failedAt = 0;

function status() {
  if (!ENABLED) return 'disabled';
  if (models) return 'ready';
  if (loading) return 'loading';
  return lastError ? 'error' : 'idle';
}

/** L2-normalised rows of a [n, dim] tensor as Float32Arrays. */
function rowsOf(tensor) {
  const [n, dim] = tensor.dims;
  const data = tensor.normalize(2, -1).data;
  const rows = [];
  for (let i = 0; i < n; i += 1) rows.push(Float32Array.from(data.subarray(i * dim, (i + 1) * dim)));
  return rows;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

/**
 * Loads the model once and shares it. Required lazily so that with ML off the
 * process never touches onnxruntime - the test suite and CI run that way.
 */
function load() {
  if (!ENABLED) return Promise.reject(new Error('Image tagging is disabled (ML_ENABLED=false)'));
  if (models) return Promise.resolve(models);
  if (loading) return loading;
  if (lastError && Date.now() - failedAt < RETRY_AFTER_MS) return Promise.reject(lastError);

  loading = (async () => {
    const started = Date.now();
    const t = require('@huggingface/transformers');
    t.env.cacheDir = CACHE_DIR;

    const [processor, tokenizer, vision, text] = await Promise.all([
      t.AutoProcessor.from_pretrained(MODEL_ID),
      t.AutoTokenizer.from_pretrained(MODEL_ID),
      t.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { dtype: DTYPE }),
      t.CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: DTYPE }),
    ]);

    const loaded = { t, processor, tokenizer, vision, text };
    // The vocabulary is fixed, so its caption embeddings are computed once.
    labelEmbeds = await encodeTexts(loaded, VOCABULARY.map((v) => v.prompt));
    models = loaded;
    lastError = null;
    console.log(`[tagger] ${MODEL_ID} (${DTYPE}) ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return models;
  })()
    .catch((err) => {
      lastError = err;
      failedAt = Date.now();
      console.error(`[tagger] model failed to load: ${err.message}`);
      throw err;
    })
    .finally(() => {
      loading = null;
    });

  return loading;
}

async function encodeTexts(m, texts) {
  const inputs = m.tokenizer(texts, { padding: true, truncation: true });
  const { text_embeds: embeds } = await m.text(inputs);
  return rowsOf(embeds);
}

async function embedImage(filePath) {
  const m = await load();
  const image = await m.t.RawImage.read(filePath);
  const inputs = await m.processor(image);
  const { image_embeds: embeds } = await m.vision(inputs);
  return rowsOf(embeds)[0];
}

// Typing "sunset" then "sunsets" then "sunset" again should not re-run the
// text encoder. Small and FIFO - queries are cheap, this just smooths typing.
const queryCache = new Map();
const QUERY_CACHE_MAX = 200;

async function embedQuery(query) {
  const key = query.toLowerCase();
  if (queryCache.has(key)) return queryCache.get(key);
  const m = await load();
  const [vec] = await encodeTexts(m, [query]);
  queryCache.set(key, vec);
  if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
  return vec;
}

/** Zero-shot classification of one image embedding against the vocabulary. */
function classify(imageVec) {
  const logits = labelEmbeds.map((e) => LOGIT_SCALE * dot(e, imageVec));
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const total = exps.reduce((a, b) => a + b, 0);

  return VOCABULARY
    .map((v, i) => ({ key: v.key, score: Math.round((exps[i] / total) * 1000) / 1000 }))
    .filter((t) => t.score >= TAG_MIN_PROB)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TAGS);
}

// Stored as raw float32 bytes: 2 KB per photo instead of ~4.6 KB as a BSON
// array of doubles, and it decodes without walking 512 elements.
const toBuffer = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);

function fromStored(value) {
  if (!value) return null;
  // A lean() read hands back the driver's Binary, a hydrated one a Buffer.
  const bytes = value.buffer instanceof Uint8Array ? value.buffer : value;
  if (!bytes || bytes.length % 4 !== 0) return null;
  // Copy into a fresh ArrayBuffer: the driver's view may not be 4-byte aligned.
  return new Float32Array(Uint8Array.from(bytes).buffer);
}

/**
 * Tag one photo. Reads the 640px thumbnail the worker already wrote - it is a
 * JPEG whatever the original format was, and CLIP only looks at 224px anyway.
 *
 * Written with updateOne rather than save(): the owner may favourite or
 * re-date the photo while it sits in this queue, and saving the stale
 * document would undo that.
 */
async function tagAsset(assetId) {
  const asset = await MediaAsset.findById(assetId).select('kind status posterKey storageKey');
  if (!asset || asset.kind !== 'photo' || asset.status !== 'ready') return;

  const input = asset.posterKey ? path.join(POSTER_DIR, asset.posterKey) : sourcePathFor(asset);

  try {
    const vec = await embedImage(input);
    const tags = classify(vec);
    await MediaAsset.updateOne(
      { _id: assetId },
      { $set: { tags, embedding: toBuffer(vec), aiStatus: 'done', aiVersion: TAGGER_VERSION } }
    );
    console.log(`[tagger] ${assetId}: ${tags.map((t) => t.key).join(', ') || '(no confident tag)'}`);
  } catch (err) {
    // Leaves aiVersion alone, so the next boot's backfill tries again.
    await MediaAsset.updateOne({ _id: assetId }, { $set: { aiStatus: 'failed' } }).catch(() => {});
    if (err !== lastError) console.error(`[tagger] failed: ${assetId}`, err.message);
  }
}

/**
 * Serial, like the ffmpeg queue and for the same reason: inference is CPU
 * bound and running it in parallel only makes every job and every request
 * slower. Kept separate from the ffmpeg queue so a backfill of old photos
 * never delays a new upload's thumbnail.
 */
let chain = Promise.resolve();
let queued = 0;

function enqueueTagging(assetId) {
  if (!ENABLED) return Promise.resolve();
  queued += 1;
  chain = chain
    .then(() => tagAsset(assetId))
    .catch((err) => console.error('[tagger] unhandled', err))
    .finally(() => {
      queued -= 1;
    });
  return chain;
}

/**
 * Tag every ready photo that has never been tagged, or was tagged by a
 * different model or vocabulary. This is how a library that existed before
 * this feature - or before a vocabulary change - catches up.
 */
async function backfillTags() {
  if (!ENABLED) return 0;
  const stale = await MediaAsset.find({
    kind: 'photo',
    status: 'ready',
    aiVersion: { $ne: TAGGER_VERSION },
  }).select('_id');

  if (stale.length) {
    await MediaAsset.updateMany(
      { _id: { $in: stale.map((a) => a._id) } },
      { $set: { aiStatus: 'pending' } }
    );
    stale.forEach((a) => enqueueTagging(a._id));
  }
  return stale.length;
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

const normalise = (s) => String(s).toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();

// Every way of naming a tag -> its key. Built once from the vocabulary.
const TERM_TO_KEY = new Map();
for (const v of VOCABULARY) {
  for (const term of [v.key, v.label, ...v.aliases]) {
    const n = normalise(term.replace(/-/g, ' '));
    if (n && !TERM_TO_KEY.has(n)) TERM_TO_KEY.set(n, v.key);
  }
}

// Crude plural folding - "puppies", "beaches", "cats" - which covers what
// people type into a photo search without pulling in a stemmer.
function termToKey(term) {
  const forms = [term];
  if (term.endsWith('ies')) forms.push(`${term.slice(0, -3)}y`);
  if (term.endsWith('es')) forms.push(term.slice(0, -2));
  if (term.endsWith('s')) forms.push(term.slice(0, -1));
  for (const f of forms) if (TERM_TO_KEY.has(f)) return TERM_TO_KEY.get(f);
  return undefined;
}

/**
 * Which tags a typed query names. "sunset" and "sunsets" and "golden hour"
 * all resolve to the sunset tag. A multi-word query only resolves if every
 * word is a tag ("dog beach" -> both); otherwise the phrase means something
 * the tags cannot express, and the semantic search handles it alone.
 */
function tagsForQuery(query) {
  const n = normalise(query);
  if (!n) return [];
  const whole = termToKey(n);
  if (whole) return [whole];

  const keys = n.split(' ').map(termToKey);
  return keys.every(Boolean) ? [...new Set(keys)] : [];
}

/**
 * Ids of this owner's photos that look like the query, best first.
 * Returns null (not []) when semantic search is unavailable, so the caller
 * can tell "nothing matched" from "could not look".
 */
async function semanticMatches(ownerId, query) {
  if (!ENABLED || !query) return null;

  let qvec;
  try {
    qvec = await embedQuery(query);
  } catch {
    return null;
  }

  const rows = await MediaAsset.find({ ownerId, kind: 'photo', aiStatus: 'done' })
    .select({ embedding: 1 })
    .lean();

  const scored = [];
  for (const row of rows) {
    const vec = fromStored(row.embedding);
    if (vec && vec.length === qvec.length) scored.push({ id: row._id, score: dot(vec, qvec) });
  }
  if (!scored.length) return [];

  scored.sort((a, b) => b.score - a.score);
  const cutoff = Math.max(SEARCH_FLOOR, scored[0].score - SEARCH_BAND);
  return scored.filter((s) => s.score >= cutoff).map((s) => s.id);
}

const labelFor = (key) => VOCAB_BY_KEY.get(key)?.label || key;

/** Starts loading in the background so the first search is not the slow one. */
function warmUp() {
  if (ENABLED) load().catch(() => {});
}

module.exports = {
  ENABLED,
  TAGGER_VERSION,
  status,
  warmUp,
  enqueueTagging,
  backfillTags,
  tagsForQuery,
  semanticMatches,
  labelFor,
  isKnownTag: (key) => VOCAB_BY_KEY.has(key),
  getTagQueueDepth: () => queued,
  // Exposed for testmedia/ml-check.js, which exercises the model directly.
  embedImage,
  embedQuery,
  classify,
  dot,
};
