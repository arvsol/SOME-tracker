# No dependencies to install, so this is a copy and a CMD.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/tracker.db

WORKDIR /app

COPY package.json ./
COPY server.js seed.js ./
COPY lib ./lib
COPY public ./public

# Tracked history lives here. Mount a volume so it survives a redeploy —
# without one, every deploy starts the curves over from scratch.
RUN addgroup -S app && adduser -S app -G app \
 && mkdir -p /data && chown -R app:app /data /app
VOLUME /data
USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
