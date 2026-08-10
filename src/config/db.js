const mongoose = require('mongoose');

const DEFAULT_URI = 'mongodb://127.0.0.1:27017/flixdrive';

async function connectDB() {
  const uri = process.env.MONGO_URI || DEFAULT_URI;

  mongoose.set('strictQuery', true);

  // The driver buffers queries for 30s by default before admitting it never
  // connected. For a dev PoC a fast, obvious failure beats a long hang.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });

  console.log(`[db] connected to "${mongoose.connection.name}"`);
  return mongoose.connection;
}

module.exports = connectDB;
