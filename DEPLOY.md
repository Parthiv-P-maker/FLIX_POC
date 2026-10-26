# Deploying FlixDrive

FlixDrive is a long-running Node server with state on disk, so it cannot go on
a static or serverless host (Netlify, Vercel, GitHub Pages). It needs:

- **A persistent disk** for uploads (`STORAGE_ROOT`) and the CLIP model cache
- **MongoDB**
- **~1-2 GB of RAM** with photo tagging on (`ML_ENABLED=false` gets by on 512 MB)
- **No request-size cap** in front of it if you want large video uploads

The repo ships a Docker setup for exactly that: the app, MongoDB and Caddy
(HTTPS) in one `docker compose up`.

## Option A — a VPS with Docker (recommended)

Any Linux VPS with 2 GB RAM works: DigitalOcean, Hetzner, Lightsail, or the
Oracle Cloud Always Free ARM VM. (The GitHub Student Pack includes
DigitalOcean credit.)

1. **Point a domain at the server.** Add an `A` record for e.g.
   `flix.example.com` to the VPS's IP. No domain? A free DuckDNS subdomain
   works.

2. **Install Docker** on the server:

   ```bash
   curl -fsSL https://get.docker.com | sh
   ```

3. **Get the code onto it** and create `.env`:

   ```bash
   git clone <your repo url> flixdrive && cd flixdrive
   cp .env.example .env
   ```

   In `.env` set:

   ```ini
   DOMAIN=flix.example.com
   JWT_SECRET=<output of: openssl rand -hex 32>
   ```

   `MONGO_URI`, `TRUST_PROXY`, `PUBLIC_URL` and `CLIENT_ORIGIN` are set by
   `docker-compose.yml`, so leave them out.

4. **Open ports 80 and 443** in the provider's firewall, then start it:

   ```bash
   docker compose up -d --build
   ```

   Caddy gets a Let's Encrypt certificate on its own within a minute. Open
   `https://flix.example.com`.

5. **Updating:** `git pull && docker compose up -d --build`. Uploads, the
   database and the model cache live in named volumes and survive rebuilds.

Useful commands:

```bash
docker compose logs -f app      # server log (password-reset links appear here)
docker compose ps               # health status
docker compose down             # stop; add -v ONLY to delete all data
```

### Using MongoDB Atlas instead of the bundled Mongo

Create a free M0 cluster, allow the VPS's IP under *Network Access*, then in
`docker-compose.yml` delete the `MONGO_URI` line and the `mongo` service, and
put the Atlas connection string in `.env` as `MONGO_URI`. The free tier caps
at 512 MB, which is metadata only — the media itself stays on the VPS disk.

## Option B — Railway or Fly.io

Both build the `Dockerfile` directly. Attach a **volume mounted at `/data`**
(otherwise every deploy wipes uploads), use MongoDB Atlas for the database,
and set these variables:

```ini
JWT_SECRET=<long random string>
MONGO_URI=<atlas connection string>
TRUST_PROXY=1
PUBLIC_URL=https://<your app's url>
```

Size the machine at 1 GB+ RAM, or set `ML_ENABLED=false`. Volume storage is
billed per GB, so this gets expensive faster than a VPS once you store video.

Render's free tier is **not** suitable: it has no persistent disk and sleeps
when idle.

## Option C — from your own PC, for a quick demo

Run the app as usual (`npm start`) and expose it with a Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:5000
```

It prints a public `https://….trycloudflare.com` URL. Set `TRUST_PROXY=1` in
`.env` while tunnelling (and remove it afterwards). The site is only up while
your PC is, and Cloudflare caps uploads at 100 MB per request.

## Before you share the link

- `JWT_SECRET` is a fresh random value, not the one from `.env.example`.
- Password-reset mail is not wired up — reset links are only printed to the
  server log. See *Password reset* in the README.
- Anyone who finds the URL can register. Lower `RATE_LIMIT_REGISTER` if that
  matters.
