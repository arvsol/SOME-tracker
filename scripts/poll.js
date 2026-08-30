'use strict';

// The poller for the GitHub-hosted build. A scheduled workflow runs this,
// and the readings it appends are committed back to the repo — the repo is
// the database.
//
// It writes only data/history.json. The tracked list in data/videos.json is
// owned by the dashboard, so the two writers never touch the same file.

const fs = require('node:fs');
const path = require('node:path');
const providers = require('../lib/providers');

const ROOT = path.join(__dirname, '..');
const VIDEOS_FILE = path.join(ROOT, 'data', 'videos.json');
const HISTORY_FILE = path.join(ROOT, 'data', 'history.json');

const HOUR = 3600;
const FULL_RESOLUTION_DAYS = 14;   // keep every reading this recent
const COARSE_INTERVAL = 6 * HOUR;  // older than that, thin to one per 6 hours

async function main() {
  const videos = readJson(VIDEOS_FILE, { videos: [] }).videos;
  const history = readJson(HISTORY_FILE, { updatedAt: null, videos: {} });

  if (!videos.length) {
    console.log('Nothing tracked yet — add a link from the dashboard.');
    return;
  }

  if (!providers.hasApiKey()) {
    console.warn(
      'WARNING: no YOUTUBE_API_KEY secret set. Falling back to scraping the\n' +
      '         watch page, which GitHub runners are often served a consent\n' +
      '         page for. Set the secret for reliable numbers.',
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const results = await providers.fetchStatsBatch(videos.map((video) => ({
    id: video.id,
    provider: video.provider,
    external_id: video.externalId,
  })));

  let recorded = 0;
  let failed = 0;

  for (const video of videos) {
    const result = results.get(video.id);
    if (!result) continue;

    const entry = history.videos[video.id] ?? (history.videos[video.id] = blank(now));

    if (!result.ok) {
      entry.lastError = result.error;
      failed++;
      console.warn(`  ${video.id}: ${result.error}`);
      continue;
    }

    const stats = result.stats;
    entry.lastError = null;
    if (stats.title) entry.title = stats.title;
    if (stats.author) entry.author = stats.author;
    if (stats.thumbnail) entry.thumbnail = stats.thumbnail;
    if (stats.publishedAt) entry.publishedAt = stats.publishedAt;
    if (stats.likes != null) entry.likes = stats.likes;

    if (typeof stats.views === 'number' && Number.isFinite(stats.views)) {
      entry.t.push(now - entry.t0);
      entry.v.push(Math.round(stats.views));
      compact(entry, now);
      recorded++;
      console.log(`  ${entry.title || video.id}: ${stats.views.toLocaleString()} views`);
    }
  }

  // Videos removed from the dashboard should not keep their history around.
  const tracked = new Set(videos.map((v) => v.id));
  for (const id of Object.keys(history.videos)) {
    if (!tracked.has(id)) {
      delete history.videos[id];
      console.log(`  dropped history for untracked ${id}`);
    }
  }

  history.updatedAt = new Date().toISOString();
  fs.writeFileSync(HISTORY_FILE, `${JSON.stringify(history, null, 1)}\n`);
  console.log(`\n${recorded} recorded, ${failed} failed.`);

  // A failure for every single video means something systemic (a bad key, an
  // expired quota) rather than one dead link, and should fail the run so the
  // workflow surfaces it instead of committing silence.
  if (failed && !recorded) process.exitCode = 1;
}

function blank(now) {
  return { title: null, author: null, thumbnail: null, publishedAt: null,
           likes: null, lastError: null, t0: now, t: [], v: [] };
}

// Keeps the file from growing without bound: recent readings stay at full
// resolution, older ones are thinned to one per COARSE_INTERVAL. The curves
// barely change, because old points are already far apart on screen.
function compact(entry, now) {
  const cutoff = now - entry.t0 - FULL_RESOLUTION_DAYS * 24 * HOUR;
  const t = [];
  const v = [];
  let lastCoarse = -Infinity;

  for (let i = 0; i < entry.t.length; i++) {
    const isRecent = entry.t[i] >= cutoff;
    const isLast = i === entry.t.length - 1;
    if (isRecent || isLast || entry.t[i] - lastCoarse >= COARSE_INTERVAL) {
      if (!isRecent) lastCoarse = entry.t[i];
      t.push(entry.t[i]);
      v.push(entry.v[i]);
    }
  }

  entry.t = t;
  entry.v = v;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { compact, FULL_RESOLUTION_DAYS, COARSE_INTERVAL };
