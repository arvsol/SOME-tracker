'use strict';

// Turns a pasted URL into a canonical video reference, and fetches live stats
// for it. YouTube works with or without an API key; without one we read the
// public watch page, which is best-effort and can break when YouTube changes
// its markup — set YOUTUBE_API_KEY for reliable numbers.

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const { parseLink, UnsupportedLinkError } = require('./parse-link');

async function fetchStats(video) {
  if (video.provider === 'youtube') {
    return YOUTUBE_API_KEY ? youtubeViaApi(video.external_id ?? video.externalId)
                           : youtubeViaPage(video.external_id ?? video.externalId);
  }
  if (video.provider === 'vimeo') {
    return vimeoStats(video.external_id ?? video.externalId);
  }
  if (video.provider === 'demo') {
    return demoStats(video);
  }
  throw new Error(`No stats provider for "${video.provider}"`);
}

// Batches up to 50 ids into a single quota-cheap API call.
async function fetchStatsBatch(videos) {
  const results = new Map();
  const youtubeIds = videos.filter((v) => v.provider === 'youtube').map((v) => v.external_id);

  if (YOUTUBE_API_KEY && youtubeIds.length) {
    for (let i = 0; i < youtubeIds.length; i += 50) {
      const chunk = youtubeIds.slice(i, i + 50);
      try {
        const byId = await youtubeApiChunk(chunk);
        for (const id of chunk) {
          const stats = byId.get(id);
          results.set(
            `youtube:${id}`,
            stats
              ? { ok: true, stats }
              : { ok: false, error: 'Video is private, deleted or region-blocked.' },
          );
        }
      } catch (err) {
        for (const id of chunk) results.set(`youtube:${id}`, { ok: false, error: err.message });
      }
    }
  }

  const remaining = videos.filter((v) => !results.has(v.id));
  await Promise.all(
    remaining.map(async (video) => {
      try {
        results.set(video.id, { ok: true, stats: await fetchStats(video) });
      } catch (err) {
        results.set(video.id, { ok: false, error: err.message });
      }
    }),
  );

  return results;
}

async function youtubeApiChunk(ids) {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,statistics');
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('key', YOUTUBE_API_KEY);

  const res = await request(url);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error?.message || `YouTube API returned ${res.status}`);
  }

  const map = new Map();
  for (const item of body.items || []) {
    const thumbs = item.snippet?.thumbnails || {};
    map.set(item.id, {
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

async function youtubeViaPage(id) {
  const res = await request(`https://www.youtube.com/watch?v=${id}`, {
    headers: { 'user-agent': USER_AGENT, 'accept-language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`YouTube returned ${res.status} for that video.`);
  const html = await res.text();

  const views =
    toInt(html.match(/"viewCount"\s*:\s*"(\d+)"/)?.[1]) ??
    toInt(html.match(/itemprop="interactionCount"\s+content="(\d+)"/)?.[1]);

  if (views == null) {
    throw new Error(
      'Could not read the view count from the YouTube page. Set YOUTUBE_API_KEY for reliable data.',
    );
  }

  return {
    title: decodeJsonString(html.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]),
    author: decodeJsonString(html.match(/"ownerChannelName"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]),
    publishedAt: html.match(/"publishDate"\s*:\s*"([^"]+)"/)?.[1],
    thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    views,
    likes: toInt(html.match(/"likeCount"\s*:\s*"(\d+)"/)?.[1]),
    comments: null,
  };
}

async function vimeoStats(id) {
  const res = await request(`https://vimeo.com/api/v2/video/${id}.json`);
  if (res.status === 404) throw new Error('Vimeo does not know that video (private or deleted).');
  if (!res.ok) throw new Error(`Vimeo returned ${res.status}.`);
  const [video] = await res.json();
  if (!video) throw new Error('Vimeo returned no data for that video.');
  return {
    title: video.title,
    author: video.user_name,
    publishedAt: video.upload_date ? video.upload_date.replace(' ', 'T') + 'Z' : null,
    thumbnail: video.thumbnail_medium,
    views: toInt(video.stats_number_of_plays),
    likes: toInt(video.stats_number_of_likes),
    comments: toInt(video.stats_number_of_comments),
  };
}

// Rows created by `npm run seed` keep ticking so the dashboard stays alive
// offline. parseLink never produces this provider, so real links cannot hit it.
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
    title: video.title,
    author: video.author,
    thumbnail: video.thumbnail,
    views: Math.round(last.views + perHour * elapsed * (0.7 + Math.random() * 0.6)),
    likes: Math.round(last.views * 0.04),
    comments: null,
  };
}

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
};
