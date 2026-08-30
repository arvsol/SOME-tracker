'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tracker.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS videos (
    id              TEXT PRIMARY KEY,
    provider        TEXT NOT NULL,
    external_id     TEXT NOT NULL,
    url             TEXT NOT NULL,
    title           TEXT,
    author          TEXT,
    thumbnail       TEXT,
    published_at    TEXT,
    added_at        TEXT NOT NULL,
    last_checked_at TEXT,
    last_error      TEXT
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    ts       TEXT NOT NULL,
    views    INTEGER NOT NULL,
    likes    INTEGER,
    comments INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_video_ts ON snapshots(video_id, ts);
`);

const statements = {
  insertVideo: db.prepare(`
    INSERT INTO videos (id, provider, external_id, url, title, author, thumbnail, published_at, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `),
  updateMeta: db.prepare(`
    UPDATE videos
       SET title = COALESCE(?, title),
           author = COALESCE(?, author),
           thumbnail = COALESCE(?, thumbnail),
           published_at = COALESCE(?, published_at),
           last_checked_at = ?,
           last_error = ?
     WHERE id = ?
  `),
  markError: db.prepare(`UPDATE videos SET last_checked_at = ?, last_error = ? WHERE id = ?`),
  getVideo: db.prepare(`SELECT * FROM videos WHERE id = ?`),
  allVideos: db.prepare(`SELECT * FROM videos ORDER BY added_at DESC`),
  deleteVideo: db.prepare(`DELETE FROM videos WHERE id = ?`),
  insertSnapshot: db.prepare(`
    INSERT INTO snapshots (video_id, ts, views, likes, comments) VALUES (?, ?, ?, ?, ?)
  `),
  lastSnapshot: db.prepare(`
    SELECT * FROM snapshots WHERE video_id = ? ORDER BY ts DESC LIMIT 1
  `),
  snapshotsSince: db.prepare(`
    SELECT ts, views, likes, comments FROM snapshots
     WHERE video_id = ? AND ts >= ? ORDER BY ts ASC
  `),
  snapshotsAll: db.prepare(`
    SELECT ts, views, likes, comments FROM snapshots WHERE video_id = ? ORDER BY ts ASC
  `),
  // The most recent point at or before the window start, so a chart that starts
  // mid-history still knows the view count it is counting up from.
  snapshotBefore: db.prepare(`
    SELECT ts, views, likes, comments FROM snapshots
     WHERE video_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1
  `),
};

function addVideo(video) {
  statements.insertVideo.run(
    video.id, video.provider, video.externalId, video.url,
    video.title ?? null, video.author ?? null, video.thumbnail ?? null,
    video.publishedAt ?? null, new Date().toISOString(),
  );
  return statements.getVideo.get(video.id);
}

function getVideo(id) {
  return statements.getVideo.get(id);
}

function listVideos() {
  return statements.allVideos.all();
}

function deleteVideo(id) {
  return statements.deleteVideo.run(id).changes > 0;
}

function recordStats(id, stats, checkedAt = new Date()) {
  const ts = checkedAt.toISOString();
  statements.updateMeta.run(
    stats.title ?? null, stats.author ?? null, stats.thumbnail ?? null,
    stats.publishedAt ?? null, ts, null, id,
  );
  if (typeof stats.views === 'number' && Number.isFinite(stats.views)) {
    statements.insertSnapshot.run(id, ts, Math.round(stats.views), stats.likes ?? null, stats.comments ?? null);
  }
}

function recordError(id, message, checkedAt = new Date()) {
  statements.markError.run(checkedAt.toISOString(), String(message).slice(0, 500), id);
}

function snapshots(id, since) {
  const rows = since
    ? statements.snapshotsSince.all(id, since.toISOString())
    : statements.snapshotsAll.all(id);
  return rows.map(toPoint);
}

function snapshotBefore(id, before) {
  const row = statements.snapshotBefore.get(id, before.toISOString());
  return row ? toPoint(row) : null;
}

function latestSnapshot(id) {
  const row = statements.lastSnapshot.get(id);
  return row ? toPoint(row) : null;
}

function toPoint(row) {
  return {
    t: Date.parse(row.ts),
    views: row.views,
    likes: row.likes,
    comments: row.comments,
  };
}

module.exports = {
  db,
  DB_PATH,
  addVideo,
  getVideo,
  listVideos,
  deleteVideo,
  recordStats,
  recordError,
  snapshots,
  snapshotBefore,
  latestSnapshot,
  insertSnapshotRaw: (id, ts, views) => statements.insertSnapshot.run(id, ts, views, null, null),
};
