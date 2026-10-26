# The React client is built in its own stage, so Vite and the client's dev
# dependencies never reach the runtime image - only the static dist/ does.
FROM node:22-bookworm-slim AS client
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client ./
RUN npm run build

# Debian slim rather than Alpine: onnxruntime-node (behind the CLIP tagger)
# and sharp ship glibc binaries only, and on musl they fail at first use, not
# at build time.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=5000 \
    STORAGE_ROOT=/data/storage \
    MODEL_CACHE_DIR=/data/model-cache

WORKDIR /app

# Dependencies first, so a source-only change reuses this layer. The ffmpeg
# and ffprobe binaries are downloaded by their postinstall scripts here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY --from=client /client/dist ./client/dist

# Uploads and the downloaded model live on a volume, so a rebuild or redeploy
# keeps both. Owned by the unprivileged user the server runs as.
RUN mkdir -p /data/storage /data/model-cache && chown -R node:node /data
VOLUME /data
USER node

EXPOSE 5000

# /api/health needs no auth. Global fetch, so no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/server.js"]
