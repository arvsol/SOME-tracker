'use strict';

// Everything the dashboard needs to answer "how is this video doing *right now*".
//
// The core idea: a raw view count says nothing about momentum. What matters is
// the rate of new views, and whether that rate is speeding up or slowing down.
// So we compare the most recent window against the window immediately before
// it, and also against the video's own best-ever window.

const HOUR = 3600 * 1000;
const MIN_SPAN = 2 * HOUR;      // below this we cannot say anything honest
const MAX_WINDOW = 24 * HOUR;   // "right now" means at most the last day

const STATUS = {
  viral:   { label: 'Going viral', icon: '🔥', tone: 'viral' },
  rising:  { label: 'Picking up',  icon: '📈', tone: 'rising' },
  steady:  { label: 'Steady',      icon: '➡️', tone: 'steady' },
  cooling: { label: 'Cooling off', icon: '📉', tone: 'cooling' },
  flat:    { label: 'Quiet',       icon: '💤', tone: 'flat' },
  warming: { label: 'Warming up',  icon: '⏳', tone: 'warming' },
};

// Linear interpolation between the two snapshots surrounding `t`, so windows
// can start at any instant rather than only where a poll happened to land.
function viewsAt(points, t) {
  if (!points.length) return null;
  if (t <= points[0].t) return points[0].views;
  if (t >= points[points.length - 1].t) return points[points.length - 1].views;

  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }

  const a = points[lo];
  const b = points[hi];
  const span = b.t - a.t;
  if (span <= 0) return b.views;
  return a.views + ((b.views - a.views) * (t - a.t)) / span;
}

function ratePerHour(points, from, to) {
  const span = to - from;
  if (span <= 0) return 0;
  const gained = viewsAt(points, to) - viewsAt(points, from);
  return Math.max(0, gained) / (span / HOUR);
}

// The best rate this video ever sustained over a window of the same length,
// which is what makes "viral" relative to the video itself rather than to some
// arbitrary global threshold.
function peakRate(points, windowMs) {
  const first = points[0].t;
  const last = points[points.length - 1].t;
  if (last - first < windowMs) return ratePerHour(points, first, last);

  const steps = 60;
  const stride = Math.max((last - first - windowMs) / steps, HOUR / 4);
  let peak = 0;
  for (let start = first; start <= last - windowMs; start += stride) {
    peak = Math.max(peak, ratePerHour(points, start, start + windowMs));
  }
  return Math.max(peak, ratePerHour(points, last - windowMs, last));
}

function analyse(points, now = Date.now()) {
  if (!points.length) {
    return { status: STATUS.warming, views: null, tracking: false, reason: 'No readings yet.' };
  }

  const latest = points[points.length - 1];
  const first = points[0];
  const span = latest.t - first.t;

  const base = {
    views: latest.views,
    likes: latest.likes,
    comments: latest.comments,
    lastReadingAt: latest.t,
    trackingSince: first.t,
    trackedGain: latest.views - first.views,
    readings: points.length,
    tracking: true,
  };

  if (points.length < 2 || span < MIN_SPAN) {
    return {
      ...base,
      status: STATUS.warming,
      reason: 'Collecting the first few hours of data.',
      perHour: null,
      perDay: null,
      change: null,
      heat: null,
    };
  }

  // Window = the last 24h, or half the history when we have less than 48h.
  const windowMs = Math.min(MAX_WINDOW, span / 2);
  const recent = ratePerHour(points, latest.t - windowMs, latest.t);
  const prior = ratePerHour(points, latest.t - 2 * windowMs, latest.t - windowMs);
  const peak = peakRate(points, windowMs);

  // How fast is it moving compared with just before? >1 means accelerating.
  const change = prior > 0 ? recent / prior : recent > 0 ? Infinity : 1;
  // How close is it to its own best run? 1 means it is at its peak right now.
  const heat = peak > 0 ? recent / peak : 0;
  const status = classify({ recent, peak, change, heat });

  return {
    ...base,
    windowHours: windowMs / HOUR,
    perHour: recent,
    perDay: recent * 24,
    priorPerHour: prior,
    peakPerHour: peak,
    change,
    changePct: Number.isFinite(change) ? (change - 1) * 100 : null,
    heat,
    status,
    reason: explain({ status, recent, change, heat, windowHours: windowMs / HOUR }),
  };
}

// Under this many views/hour (~120/day) nothing meaningful is happening, and
// the percentage swings are just noise on top of very small numbers.
const QUIET_PER_HOUR = 5;

function classify({ recent, change, heat }) {
  if (recent < QUIET_PER_HOUR) return STATUS.flat;
  // Viral means pulling away fast *and* doing it at its own best pace, so a
  // video that merely twitches upward after a long sleep is not mislabelled.
  if (change >= 1.5 && heat >= 0.85) return STATUS.viral;
  if (change >= 1.15) return STATUS.rising;
  if (change <= 0.8) return STATUS.cooling;
  return STATUS.steady;
}

function explain({ status, recent, change, heat, windowHours }) {
  const window = windowHours >= 23 ? 'the last 24h' : `the last ${round(windowHours)}h`;
  const rate = `${compact(Math.round(recent * 24))} views/day`;
  if (status === STATUS.flat) {
    return `Only ${rate} in ${window} — essentially idle.`;
  }
  if (!Number.isFinite(change)) return `${rate} in ${window} — it was flat before.`;
  const delta = (change - 1) * 100;
  const direction = delta >= 0 ? 'faster' : 'slower';
  const peakNote = heat >= 0.95 && change > 1.05 ? ' Best run so far.' : '';
  return `${rate} in ${window}, ${Math.abs(Math.round(delta))}% ${direction} than the window before.${peakNote}`;
}

// Turns raw snapshots into evenly spaced buckets for the chart: the total view
// count at each step, plus how many views were gained during that step.
function buildSeries(points, { range = '7d', now = Date.now() } = {}) {
  if (points.length < 1) return { buckets: [], bucketHours: 0 };

  const first = points[0].t;
  const last = points[points.length - 1].t;
  const spans = { '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR };

  const span = spans[range] ?? spans['7d'];
  const from = range === 'all' ? first : Math.max(first, last - span);
  const to = last;
  const totalSpan = Math.max(to - from, HOUR);

  const targetBuckets = 48;
  const bucketMs = niceBucket(totalSpan / targetBuckets);
  const count = Math.max(2, Math.min(240, Math.ceil(totalSpan / bucketMs)));

  const buckets = [];
  let previous = viewsAt(points, to - count * bucketMs);
  for (let i = count - 1; i >= 0; i--) {
    const at = to - i * bucketMs;
    const views = viewsAt(points, at);
    buckets.push({
      t: at,
      views: Math.round(views),
      gained: Math.max(0, Math.round(views - previous)),
      // Buckets before the first reading are extrapolated flat, not measured.
      measured: at >= first - bucketMs,
    });
    previous = views;
  }

  return { buckets: buckets.filter((b) => b.measured), bucketHours: bucketMs / HOUR };
}

function niceBucket(ms) {
  const steps = [
    HOUR / 4, HOUR / 2, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
    24 * HOUR, 2 * 24 * HOUR, 7 * 24 * HOUR,
  ];
  return steps.find((s) => s >= ms) ?? steps[steps.length - 1];
}

function compact(n) {
  if (n == null) return '–';
  if (n >= 1e9) return `${round(n / 1e9)}B`;
  if (n >= 1e6) return `${round(n / 1e6)}M`;
  if (n >= 1e3) return `${round(n / 1e3)}K`;
  return String(Math.round(n));
}

function round(n) {
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

module.exports = { analyse, buildSeries, viewsAt, compact, STATUS, HOUR };
