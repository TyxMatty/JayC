# syntax=docker/dockerfile:1
# Build context is the repository root (npm workspaces share one lockfile):
#   docker build -f signaling-server/Dockerfile -t jay-c-signaling .
#
# Debian (glibc) rather than Alpine: mediasoup ships a prebuilt glibc worker binary,
# which avoids compiling the C++ worker (python, meson, g++) inside the image.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    RTC_PORT=40000

WORKDIR /app

COPY package.json package-lock.json ./
COPY signaling-server/package.json signaling-server/
RUN npm ci --omit=dev --workspace signaling-server --include-workspace-root=false \
 && test -x node_modules/mediasoup/worker/out/Release/mediasoup-worker \
 && npm cache clean --force

COPY signaling-server/src signaling-server/src

USER node
# 3000: signaling (WebSocket). 40000: all media (UDP preferred, TCP fallback).
EXPOSE 3000 40000/udp 40000/tcp

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "signaling-server/src/server.js"]
