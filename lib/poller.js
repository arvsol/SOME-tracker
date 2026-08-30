'use strict';

const db = require('./db');
const providers = require('./providers');

const POLL_MINUTES = Number(process.env.POLL_INTERVAL_MINUTES || 15);

let timer = null;
let running = false;
let lastRunAt = null;

async function pollAll() {
  if (running) return { skipped: true };
  running = true;
  const startedAt = new Date();
  try {
    const videos = db.listVideos();
    if (!videos.length) return { checked: 0 };

    const results = await providers.fetchStatsBatch(videos);
    let ok = 0;
    let failed = 0;

    for (const video of videos) {
      const result = results.get(video.id);
      if (!result) continue;
      if (result.ok) {
        db.recordStats(video.id, result.stats, startedAt);
        ok++;
      } else {
        db.recordError(video.id, result.error, startedAt);
        failed++;
      }
    }

    lastRunAt = startedAt.toISOString();
    return { checked: videos.length, ok, failed };
  } finally {
    running = false;
  }
}

// Fetch a single video immediately, so a freshly pasted link shows numbers at
// once instead of waiting for the next scheduled poll.
async function pollOne(video) {
  try {
    const stats = await providers.fetchStats(video);
    db.recordStats(video.id, stats);
    return { ok: true, stats };
  } catch (err) {
    db.recordError(video.id, err.message);
    return { ok: false, error: err.message };
  }
}

function start() {
  if (timer) return;
  const intervalMs = Math.max(1, POLL_MINUTES) * 60 * 1000;
  timer = setInterval(() => {
    pollAll().catch((err) => console.error('[poller] run failed:', err.message));
  }, intervalMs);
  timer.unref?.();
  pollAll().catch((err) => console.error('[poller] initial run failed:', err.message));
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  start,
  stop,
  pollAll,
  pollOne,
  intervalMinutes: POLL_MINUTES,
  status: () => ({ lastRunAt, running, intervalMinutes: POLL_MINUTES }),
};
