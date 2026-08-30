'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const db = require('./lib/db');
const providers = require('./lib/providers');
const metrics = require('./lib/metrics');
const poller = require('./lib/poller');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Optional shared password, for when this is reachable from the internet.
// Unset (the default) leaves the app open, which is what you want locally.
const APP_PASSWORD = process.env.APP_PASSWORD || '';

// The dashboard module lives in lib/ because the static build shares it.
const SHARED_FILES = { '/dashboard.js': path.join(__dirname, 'lib', 'dashboard.js') };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const routes = [
  ['GET', /^\/api\/health$/, health],
  ['GET', /^\/api\/videos$/, listVideos],
  ['POST', /^\/api\/videos$/, addVideo],
  ['DELETE', /^\/api\/videos\/(.+)$/, removeVideo],
  ['GET', /^\/api\/videos\/([^/]+)\/series$/, videoSeries],
  ['POST', /^\/api\/refresh$/, refreshAll],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // /api/health stays open so container health checks work without credentials.
  if (url.pathname !== '/api/health' && !authorized(req)) {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="SOME tracker", charset="UTF-8"',
      'content-type': 'text/plain',
    }).end('Authentication required.');
    return;
  }

  const route = routes.find(([method, pattern]) =>
    method === req.method && pattern.test(url.pathname));

  if (route) {
    const params = url.pathname.match(route[1]).slice(1).map(decodeURIComponent);
    try {
      await route[2](req, res, { url, params });
    } catch (err) {
      const status = err instanceof providers.UnsupportedLinkError ? 400 : 500;
      if (status === 500) console.error('[api]', err);
      json(res, status, { error: err.message });
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url, res);
  json(res, 405, { error: 'Method not allowed' });
});

function authorized(req) {
  if (!APP_PASSWORD) return true;
  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  return sameSecret(decoded.slice(decoded.indexOf(':') + 1), APP_PASSWORD);
}

// Hash both sides first: timingSafeEqual needs equal lengths, and comparing the
// digests keeps the password's length from leaking through the comparison.
function sameSecret(a, b) {
  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function health(req, res) {
  json(res, 200, {
    ok: true,
    tracked: db.listVideos().length,
    youtubeApiKey: providers.hasApiKey(),
    poller: poller.status(),
  });
}

function listVideos(req, res) {
  const now = Date.now();
  const videos = db.listVideos().map((video) => {
    const points = db.snapshots(video.id);
    return { ...shape(video), ...metrics.analyse(points, now), spark: sparkline(points, now) };
  });

  // Loudest first: whatever is moving fastest relative to its own history.
  videos.sort((a, b) => rank(b) - rank(a));

  json(res, 200, {
    videos,
    poller: poller.status(),
    youtubeApiKey: providers.hasApiKey(),
  });
}

function rank(video) {
  const order = { viral: 5, rising: 4, steady: 3, cooling: 2, warming: 1, flat: 0 };
  return (order[video.status?.tone] ?? 0) * 1e12 + (video.perHour || 0);
}

async function addVideo(req, res) {
  const body = await readJson(req);
  const link = providers.parseLink(body.url);

  const existing = db.getVideo(link.id);
  if (existing) {
    return json(res, 200, { video: shape(existing), duplicate: true });
  }

  db.addVideo(link);
  const result = await poller.pollOne({ ...link, external_id: link.externalId });
  const video = db.getVideo(link.id);

  if (!result.ok && !db.latestSnapshot(link.id)) {
    // Nothing readable at all — do not leave a broken card on the dashboard.
    db.deleteVideo(link.id);
    return json(res, 502, { error: result.error });
  }

  const points = db.snapshots(link.id);
  json(res, 201, {
    video: { ...shape(video), ...metrics.analyse(points), spark: sparkline(points) },
  });
}

function removeVideo(req, res, { params }) {
  const removed = db.deleteVideo(params[0]);
  json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'Not tracked.' });
}

function videoSeries(req, res, { url, params }) {
  const id = params[0];
  const video = db.getVideo(id);
  if (!video) return json(res, 404, { error: 'Not tracked.' });

  const range = url.searchParams.get('range') || '7d';
  const points = db.snapshots(id);
  const series = metrics.buildSeries(points, { range });
  json(res, 200, { id, range, ...series, analysis: metrics.analyse(points) });
}

async function refreshAll(req, res) {
  const result = await poller.pollAll();
  json(res, 200, result);
}

// A short, evenly spaced rate series for the card's inline sparkline.
function sparkline(points, now = Date.now()) {
  const { buckets } = metrics.buildSeries(points, { range: '7d', now });
  if (buckets.length < 2) return [];
  const step = Math.max(1, Math.floor(buckets.length / 24));
  return buckets.filter((_, i) => i % step === 0).map((b) => b.gained);
}

function shape(video) {
  return {
    id: video.id,
    provider: video.provider,
    url: video.url,
    title: video.title || video.url,
    author: video.author,
    thumbnail: video.thumbnail,
    publishedAt: video.published_at,
    addedAt: video.added_at,
    lastCheckedAt: video.last_checked_at,
    lastError: video.last_error,
  };
}

function serveStatic(url, res) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const shared = SHARED_FILES[requested];
  const filePath = shared || path.join(PUBLIC_DIR, path.normalize(requested));

  if (!shared && !filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    }).end(data);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  }).end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e5) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new providers.UnsupportedLinkError('Expected a JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

if (require.main === module) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use. Try: PORT=3001 npm start\n`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n  SOME tracker running at http://localhost:${PORT}`);
    console.log(`  Checking every ${poller.intervalMinutes} min` +
      (providers.hasApiKey() ? ' (using the YouTube API key)' : ' (no API key — reading the public page)'));
    console.log(`  Database: ${db.DB_PATH}`);
    console.log(`  Password: ${APP_PASSWORD ? 'required' : 'not set (open access)'}\n`);
    poller.start();
  });

  // Containers stop with SIGTERM. Close the database so SQLite's write-ahead
  // log is checkpointed instead of left behind for the next boot to recover.
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\n  Shutting down…');
      poller.stop();
      server.close(() => {
        try { db.db.close(); } catch { /* already closed */ }
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

module.exports = server;
