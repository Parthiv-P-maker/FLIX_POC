/**
 * One-shot rename: copies cinesync -> flixdrive.
 *
 * Copies rather than renames so the original stays intact as a backup. Empty
 * throwaway accounts left behind by the e2e suite are skipped; anything that
 * owns an asset is carried across untouched.
 *
 *   node testmedia/migrate-db-name.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const FROM = process.env.MIGRATE_FROM || 'cinesync';
const TO = process.env.MIGRATE_TO || 'flixdrive';
const HOST = (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cinesync')
  .replace(/\/[^/]*$/, '');

const THROWAWAY = /^(e2e|other)-\d+@test\.local$/;

async function main() {
  const client = await mongoose.connect(`${HOST}/${FROM}`);
  const src = client.connection.db;
  const dst = client.connection.client.db(TO);

  const existing = await dst.listCollections().toArray();
  if (existing.length) {
    console.log(`"${TO}" already has ${existing.length} collection(s) - leaving it alone.`);
    await mongoose.disconnect();
    return;
  }

  const assets = await src.collection('mediaassets').find({}).toArray();
  const ownerIds = new Set(assets.map((a) => String(a.ownerId)));

  for (const { name } of await src.listCollections().toArray()) {
    let docs = await src.collection(name).find({}).toArray();

    if (name === 'users') {
      const before = docs.length;
      docs = docs.filter((u) => ownerIds.has(String(u._id)) || !THROWAWAY.test(u.email));
      if (before !== docs.length) {
        console.log(`  users: skipped ${before - docs.length} empty test account(s)`);
      }
    }

    if (docs.length) await dst.collection(name).insertMany(docs);
    console.log(`  ${name}: ${docs.length} document(s) copied`);
  }

  // Indexes are declared in the models and rebuilt on first connect, so only
  // the documents need moving.
  console.log(`\nCopied ${FROM} -> ${TO}. "${FROM}" is untouched if you need it back.`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
