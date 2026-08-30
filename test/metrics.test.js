'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { analyse, buildSeries, HOUR } = require('../lib/metrics');
const { parseLink } = require('../lib/parse-link');
const { compact } = require('../scripts/poll');

const DAY = 24 * HOUR;

// Builds readings from a rate function: how many views arrived in hour N.
function series(hours, rateAt, { start = 10000, now = Date.now() } = {}) {
  const points = [];
  let views = start;
  for (let h = hours; h >= 0; h--) {
    views += rateAt(hours - h);
    points.push({ t: now - h * HOUR, views: Math.round(views) });
  }
  return points;
}

/* ---------------- the verdict ---------------- */

test('a video accelerating hard reads as viral', () => {
  const result = analyse(series(96, (h) => 50 * 1.05 ** h));
  assert.equal(result.status.tone, 'viral');
  assert.ok(result.change > 1.5, `expected acceleration, got ${result.change}`);
  assert.ok(result.heat > 0.85);
});

test('a constant rate reads as steady, not as a trend', () => {
  const result = analyse(series(96, () => 1000));
  assert.equal(result.status.tone, 'steady');
  assert.ok(Math.abs(result.changePct) < 5);
});

test('a decaying video reads as cooling even after a huge launch', () => {
  const result = analyse(series(96, (h) => 5000 * 0.96 ** h));
  assert.equal(result.status.tone, 'cooling');
  assert.ok(result.changePct < 0);
});

test('a video nobody watches reads as quiet, whatever the percentages say', () => {
  // Two views an hour, with noise that swings the ratio wildly.
  const result = analyse(series(96, () => 1 + Math.random() * 3));
  assert.equal(result.status.tone, 'flat');
  assert.match(result.reason, /essentially idle/);
});

test('no verdict is offered before there is enough history', () => {
  assert.equal(analyse(series(1, () => 500)).status.tone, 'warming');
  assert.equal(analyse([]).status.tone, 'warming');
  assert.equal(analyse([{ t: Date.now(), views: 10 }]).status.tone, 'warming');
});

test('a view count that drops never produces a negative rate', () => {
  const now = Date.now();
  const points = [
    { t: now - 48 * HOUR, views: 1_000_000 },
    { t: now - 24 * HOUR, views: 1_200_000 },
    { t: now, views: 900_000 }, // YouTube purging bot views
  ];
  const result = analyse(points, now);
  assert.ok(result.perHour >= 0, `rate went negative: ${result.perHour}`);
  assert.ok(result.perDay >= 0);
});

/* ---------------- the chart ---------------- */

test('series buckets are evenly spaced and never negative', () => {
  const points = series(30 * 24, (h) => 100 + 50 * Math.sin(h / 12));
  for (const range of ['24h', '7d', '30d', 'all']) {
    const { buckets, bucketHours } = buildSeries(points, { range });
    assert.ok(buckets.length >= 2, `${range} produced ${buckets.length} buckets`);
    assert.ok(bucketHours > 0);
    assert.ok(buckets.every((b) => b.gained >= 0), `${range} has a negative bucket`);
    assert.ok(
      buckets.every((b, i) => i === 0 || b.t > buckets[i - 1].t),
      `${range} buckets are not in order`,
    );
  }
});

test('an unknown range falls back instead of producing nothing', () => {
  const points = series(48, () => 100);
  assert.ok(buildSeries(points, { range: 'nonsense' }).buckets.length >= 2);
});

/* ---------------- links ---------------- */

test('every YouTube link shape resolves to the same video', () => {
  const expected = 'youtube:dQw4w9WgXcQ';
  for (const link of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=42',
    'youtube.com/shorts/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  ]) {
    assert.equal(parseLink(link).id, expected, link);
  }
});

test('links that are not a single video are refused with a reason', () => {
  assert.throws(() => parseLink('https://www.youtube.com/playlist?list=PL1'), /playlists/i);
  assert.throws(() => parseLink('https://tiktok.com/@a/video/1'), /not supported yet/i);
  assert.throws(() => parseLink('not a link'), /does not look like a link/i);
  assert.throws(() => parseLink(''), /Paste a video link/i);
  assert.throws(() => parseLink('https://youtu.be/tooshort'), /not a valid YouTube video id/i);
});

/* ---------------- history compaction ---------------- */

test('compaction keeps recent readings and thins only the old ones', () => {
  const now = 90 * DAY / 1000;
  const entry = { t0: 0, t: [], v: [] };
  let views = 1000;
  for (let t = 0; t <= now; t += 900) {
    views += 10;
    entry.t.push(t);
    entry.v.push(views);
  }
  const before = { count: entry.t.length, first: entry.v[0], last: entry.v.at(-1) };

  compact(entry, now);

  const recent = entry.t.filter((t) => t >= now - 14 * 86400);
  const old = entry.t.filter((t) => t < now - 14 * 86400);
  const gaps = old.slice(1).map((t, i) => t - old[i]);

  assert.ok(entry.t.length < before.count / 4, 'should shrink substantially');
  assert.equal(recent.length, 14 * 86400 / 900 + 1, 'last 14 days kept at full resolution');
  assert.ok(gaps.every((g) => g === 6 * 3600), 'older readings thinned to exact 6h gaps');
  assert.equal(entry.v[0], before.first, 'first reading survives');
  assert.equal(entry.v.at(-1), before.last, 'latest reading survives');
  assert.equal(entry.t.length, entry.v.length, 'timestamps and values stay aligned');
});

test('compaction is idempotent, so history is not eaten run after run', () => {
  const now = 60 * 86400;
  const entry = { t0: 0, t: [], v: [] };
  for (let t = 0; t <= now; t += 900) {
    entry.t.push(t);
    entry.v.push(t);
  }
  compact(entry, now);
  const first = entry.t.length;
  compact(entry, now);
  compact(entry, now);
  assert.equal(entry.t.length, first);
});

test('a brand new entry with one reading survives compaction', () => {
  const entry = { t0: 100, t: [0], v: [42] };
  compact(entry, 100);
  assert.deepEqual(entry.t, [0]);
  assert.deepEqual(entry.v, [42]);
});
