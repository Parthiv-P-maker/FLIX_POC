/**
 * `npm test` — the whole suite, from nothing.
 *
 * The e2e script used to say "boot the server first, then run me", which meant
 * it ran against whatever was on port 5000 with whatever data happened to be
 * in the dev database. That is a footgun twice over: a stale server silently
 * tests the wrong code, and a passing run can leave rows behind in a database
 * someone cares about.
 *
 * So this owns the whole lifecycle: a throwaway database, a throwaway storage
 * directory, a port nobody else is on, and teardown that runs even when the
 * suite fails.
 *
 * It deliberately does NOT use mongodb-memory-server. That would download a
 * ~100 MB mongod on first run - a slow, failure-prone step on a marker's
 * machine - to avoid a dependency the project already requires anyway. CI gets
 * a Mongo service container instead; see .github/workflows/ci.yml.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');

const ROOT = path.join(__dirname, '..');

// A name nothing else will pick, so a crashed run cannot collide with a live one.
const DB_NAME = `flixdrive_test_${process.pid}_${Date.now()}`;
const MONGO_HOST = process.env.TEST_MONGO_HOST || 'mongodb://127.0.0.1:27017';
const MONGO_URI = `${MONGO_HOST}/${DB_NAME}`;

/** Ask the OS for a free port rather than guessing one and racing for it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // Not up yet. Keep trying until the deadline.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: 'inherit', shell: false });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'flixdrive-test-'));

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    MONGO_URI,
    STORAGE_ROOT: storage,
    JWT_SECRET: 'test-only-secret-not-used-outside-the-suite',
    // The suite hammers login and register on purpose; the production defaults
    // would start returning 429 partway through and fail unrelated checks.
    RATE_LIMIT_LOGIN: '10000',
    // The API suite runs without the CLIP model: a 150 MB download on a
    // marker's first `npm test` is the same trap mongodb-memory-server would
    // be. The model itself is covered by `npm run test:ml`.
    ML_ENABLED: 'false',
    RATE_LIMIT_REGISTER: '10000',
  };

  console.log(`\nFlixDrive test run`);
  console.log(`  database  ${DB_NAME}`);
  console.log(`  storage   ${storage}`);
  console.log(`  port      ${port}\n`);

  const serverLog = [];
  const server = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, shell: false });
  // Buffered rather than inherited: a passing run should not bury the results
  // under a few hundred morgan lines. On failure it is all printed.
  server.stdout.on('data', (d) => serverLog.push(d.toString()));
  server.stderr.on('data', (d) => serverLog.push(d.toString()));

  let exitCode = 1;
  try {
    if (!(await waitForHealth(base))) {
      console.error('Server did not become healthy. Its output:\n');
      console.error(serverLog.join(''));
      return 1;
    }

    exitCode = await run(process.execPath, ['testmedia/e2e.js'], { ...env, BASE: base });

    if (exitCode !== 0) {
      console.error('\n--- server output ---');
      console.error(serverLog.join(''));
    }

    // A clean suite should not have logged a single error; if it did, something
    // is being swallowed that the assertions are not looking at.
    const noise = serverLog.join('').match(/\[(error|fatal|cleanup)\]/g);
    if (noise && exitCode === 0) {
      console.error(`\nServer logged ${noise.length} error line(s) during a passing run:`);
      console.error(serverLog.join('').split('\n').filter((l) => /\[(error|fatal|cleanup)\]/.test(l)).join('\n'));
      exitCode = 1;
    }

    return exitCode;
  } finally {
    server.kill();

    try {
      const conn = await mongoose.createConnection(MONGO_URI).asPromise();
      await conn.dropDatabase();
      await conn.close();
    } catch (err) {
      console.error(`Could not drop ${DB_NAME}: ${err.message}`);
    }

    fs.rmSync(storage, { recursive: true, force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
