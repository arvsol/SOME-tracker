'use strict';

// Fetches live stats for a tracked video.
//
// A YouTube Data API key is the easy path, but it is optional: without one
// this reads the public watch page, and if that page does not carry the count
// it asks the same internal endpoint the YouTube player itself calls, using
// the public client key lifted from the page. No credentials of yours are
// involved in the no-key path, and nothing is hardcoded that YouTube can
// rotate out from under it.

const { parseLink, UnsupportedLinkError } = require('./parse-link');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
// Optional last resort: the base URL of a Piped instance (see the README).
const PIPED_API = (process.env.PIPED_API || '').replace(/\/+$/, '');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Consent cookies and a pinned region. Requests from a datacenter address — a
// CI runner, a VPS — are otherwise often answered with the EU consent
// interstitial instead of the video, which is the usual reason a no-key setup
// suddenly returns nothing.
const YOUTUBE_HEADERS = {
  'user-agent': USER_AGENT,
  'accept-language': 'en-US,en;q=0.9',
  cookie: 'CONSENT=YES+cb; SOCS=CAI',
};

// Without a key each video costs its own request, so they go a few at a time
// rather than all at once.
const NO_KEY_CONCURRENCY = 3;

async function fetchStats(video) {
  const id = video.external_id ?? video.externalId;
  if (video.provider === 'youtube') {
    return YOUTUBE_API_KEY ? youtubeViaApi(id) : youtubeWithoutKey(id);
  }
  if (video.provider === 'vimeo') return vimeoStats(id);
  if (video.provider === 'demo') return demoStats(video);
  throw new Error(`No stats provider for "${video.provider}"`);
}

async function fetchStatsBatch(videos) {
  const results = new Map();

  // With a key, up to 50 videos cost a single quota-cheap request.
  if (YOUTUBE_API_KEY) {
    const ids = videos.filter((v) => v.provider === 'youtube').map((v) => v.external_id);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try {
        const byId = await youtubeApiChunk(chunk);
        for (const id of chunk) {
          const stats = byId.get(id);
          results.set(`youtube:${id}`, stats
            ? { ok: true, stats }
            : { ok: false, error: 'Video is private, deleted or region-blocked.' });
        }
      } catch (err) {
        for (const id of chunk) results.set(`youtube:${id}`, { ok: false, error: err.message });
      }
    }
  }

  const remaining = videos.filter((v) => !results.has(v.id));
  await pooled(remaining, NO_KEY_CONCURRENCY, async (video) => {
    try {
      results.set(video.id, { ok: true, stats: await fetchStats(video) });
    } catch (err) {
      results.set(video.id, { ok: false, error: err.message });
    }
  });

  return results;
}

async function pooled(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

/* ---------------- youtube, with a key ---------------- */

async function youtubeApiChunk(ids) {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,statistics');
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('key', YOUTUBE_API_KEY);

  const res = await request(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || `YouTube API returned ${res.status}`);

  const map = new Map();
  for (const item of body.items || []) {
    const thumbs = item.snippet?.thumbnails || {};
    map.set(item.id, {
      source: 'api',
      title: item.snippet?.title,
      author: item.snippet?.channelTitle,
      publishedAt: item.snippet?.publishedAt,
      thumbnail: (thumbs.medium || thumbs.high || thumbs.default)?.url,
      views: toInt(item.statistics?.viewCount),
      likes: toInt(item.statistics?.likeCount),
      comments: toInt(item.statistics?.commentCount),
    });
  }
  return map;
}

async function youtubeViaApi(id) {
  const stats = (await youtubeApiChunk([id])).get(id);
  if (!stats) throw new Error('Video is private, deleted or region-blocked.');
  return stats;
}

/* ---------------- youtube, without a key ---------------- */

// Three attempts, cheapest first. Each returns null rather than throwing when
// it simply has nothing, so one blocked route does not mask the next.
async function youtubeWithoutKey(id) {
  let html = null;
  try {
    html = await watchPage(id);
  } catch (err) {
    if (!PIPED_API) throw err;
  }

  if (html) {
    const fromPage = statsFromWatchPage(html, id);
    if (fromPage) return fromPage;

    const fromPlayer = await statsFromPlayerApi(id, html);
    if (fromPlayer) return fromPlayer;
  }

  if (PIPED_API) {
    const fromPiped = await statsFromPiped(id);
    if (fromPiped) return fromPiped;
  }

  throw new Error(explainNoKeyFailure(html));
}

async function watchPage(id) {
  const res = await request(
    `https://www.youtube.com/watch?v=${id}&hl=en&gl=US&has_verified=1`,
    { headers: YOUTUBE_HEADERS },
  );
  if (res.status === 404) throw new Error('That video does not exist.');
  if (!res.ok) throw new Error(`YouTube returned ${res.status} for that video.`);
  return res.text();
}

function statsFromWatchPage(html, id) {
  const views =
    toInt(html.match(/"viewCount"\s*:\s*"(\d+)"/)?.[1]) ??
    toInt(html.match(/itemprop="interactionCount"\s+content="(\d+)"/)?.[1]);
  if (views == null) return null;

  return {
    source: 'watch-page',
    title: decodeJsonString(html.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]),
    author: decodeJsonString(html.match(/"ownerChannelName"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]),
    publishedAt: html.match(/"publishDate"\s*:\s*"([^"]+)"/)?.[1] || null,
    thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    views,
    likes: toInt(html.match(/"likeCount"\s*:\s*"(\d+)"/)?.[1]),
    comments: null,
  };
}

// The endpoint youtube.com's own player calls. The key below is read out of
// the page that was just fetched — it is a public constant YouTube ships to
// every visitor, not a credential, and reading it here means a rotation fixes
// itself instead of breaking the poller.
async function statsFromPlayerApi(id, html) {
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  if (!key) return null;
  const clientVersion =
    html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || '2.20240101.00.00';

  let body;
  try {
    const res = await request(`https://www.youtube.com/youtubei/v1/player?key=${key}`, {
      method: 'POST',
      headers: { ...YOUTUBE_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        videoId: id,
        context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } },
      }),
    });
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    return null;
  }

  return statsFromPlayerResponse(body, id);
}

function statsFromPlayerResponse(body, id) {
  const details = body?.videoDetails;
  const views = toInt(details?.viewCount);
  if (views == null) return null;

  const micro = body?.microformat?.playerMicroformatRenderer;
  return {
    source: 'player-api',
    title: details.title ?? null,
    author: details.author ?? null,
    publishedAt: micro?.publishDate || micro?.uploadDate || null,
    thumbnail: details.thumbnail?.thumbnails?.at(-1)?.url
      || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    views,
    likes: null,
    comments: null,
  };
}

async function statsFromPiped(id) {
  try {
    const res = await request(`${PIPED_API}/streams/${id}`, {
      headers: { 'user-agent': USER_AGENT },
    });
    if (!res.ok) return null;
    return statsFromPipedBody(await res.json(), id);
  } catch {
    return null;
  }
}

function statsFromPipedBody(body, id) {
  const views = toInt(body?.views);
  if (views == null) return null;
  return {
    source: 'piped',
    title: body.title ?? null,
    author: body.uploader ?? null,
    publishedAt: body.uploadDate || null,
    thumbnail: body.thumbnailUrl || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    views,
    likes: toInt(body.likes) ?? null,
    comments: null,
  };
}

// A failure here is nearly always one of a few specific things, and saying
// which one saves a lot of guessing.
function explainNoKeyFailure(html) {
  if (!html) {
    return 'Could not reach YouTube at all. If this is a CI runner, its address may be blocked.';
  }
  if (/consent\.youtube\.com|Before you continue|CONSENT_FLOW/i.test(html)) {
    return 'YouTube served a consent page instead of the video. ' +
      'This usually means the request came from a datacenter address — run the poller ' +
      'somewhere else, set PIPED_API, or set YOUTUBE_API_KEY.';
  }
  if (/unusual traffic|not a robot|\/sorry\//i.test(html)) {
    return 'YouTube answered with a bot check. Poll less often, set PIPED_API, ' +
      'or set YOUTUBE_API_KEY.';
  }
  if (/"status"\s*:\s*"(LOGIN_REQUIRED|UNPLAYABLE|ERROR)"/.test(html)) {
    return 'That video is private, age-restricted, deleted or region-blocked.';
  }
  return 'Could not find the view count on the YouTube page. The page layout may ' +
    'have changed — setting YOUTUBE_API_KEY avoids the guesswork.';
}

/* ---------------- vimeo ---------------- */

async function vimeoStats(id) {
  const res = await request(`https://vimeo.com/api/v2/video/${id}.json`);
  if (res.status === 404) throw new Error('Vimeo does not know that video (private or deleted).');
  if (!res.ok) throw new Error(`Vimeo returned ${res.status}.`);
  const [video] = await res.json();
  if (!video) throw new Error('Vimeo returned no data for that video.');
  return {
    source: 'vimeo',
    title: video.title,
    author: video.user_name,
    publishedAt: video.upload_date ? `${video.upload_date.replace(' ', 'T')}Z` : null,
    thumbnail: video.thumbnail_medium,
    views: toInt(video.stats_number_of_plays),
    likes: toInt(video.stats_number_of_likes),
    comments: toInt(video.stats_number_of_comments),
  };
}

/* ---------------- demo rows from `npm run seed` ---------------- */

// These keep ticking so the dashboard stays alive offline. parseLink never
// produces this provider, so real links cannot reach it.
function demoStats(video) {
  const db = require('./db');
  const points = db.snapshots(video.id);
  const last = points[points.length - 1];
  if (!last) return { title: video.title, author: video.author, views: 1000, likes: 0 };

  // Carry on at whatever pace this video was already running at, scaled by the
  // time actually elapsed, so polling does not put fake steps in the curve.
  const dayAgo = points.find((p) => p.t >= last.t - 24 * 3600 * 1000) ?? points[0];
  const hours = Math.max(1, (last.t - dayAgo.t) / 3600000);
  const perHour = Math.max(0, (last.views - dayAgo.views) / hours);
  const elapsed = Math.max(0, (Date.now() - last.t) / 3600000);

  return {
    source: 'demo',
    title: video.title,
    author: video.author,
    thumbnail: video.thumbnail,
    views: Math.round(last.views + perHour * elapsed * (0.7 + Math.random() * 0.6)),
    likes: Math.round(last.views * 0.04),
    comments: null,
  };
}

/* ---------------- plumbing ---------------- */

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Timed out reaching the video host.');
    throw new Error(`Could not reach the video host: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function toInt(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function decodeJsonString(value) {
  if (!value) return null;
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

module.exports = {
  parseLink,
  fetchStats,
  fetchStatsBatch,
  UnsupportedLinkError,
  hasApiKey: () => Boolean(YOUTUBE_API_KEY),
  usingPiped: () => Boolean(PIPED_API),
  // exported for tests
  statsFromWatchPage,
  statsFromPlayerResponse,
  statsFromPipedBody,
  explainNoKeyFailure,
};
