'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MODULE = path.join(__dirname, '..', 'lib', 'providers.js');

// providers.js reads its configuration at require time, so each scenario gets
// a fresh copy with the environment it is meant to exercise.
function loadProviders(env = {}) {
  const saved = {};
  for (const key of ['YOUTUBE_API_KEY', 'PIPED_API']) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  delete require.cache[require.resolve(MODULE)];
  const providers = require(MODULE);
  Object.assign(process.env, saved);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
  }
  return providers;
}

/* ---------------- fixtures resembling what YouTube actually serves ------- */

const WATCH_PAGE_WITH_COUNT = `
<!DOCTYPE html><html><head><meta name="title" content="x"></head><body>
<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"dQw4w9WgXcQ",
"title":"Never Gonna Give You Up","author":"Rick Astley","viewCount":"1583920411"},
"microformat":{"playerMicroformatRenderer":{"publishDate":"2009-10-25"}}};</script>
<script>var ytcfg={};ytcfg.set({"INNERTUBE_API_KEY":"AIzaSyPUBLICCLIENTKEY",
"INNERTUBE_CLIENT_VERSION":"2.20260815.01.00"});</script>
<script>{"ownerChannelName":"Rick Astley","publishDate":"2009-10-25",
"likeCount":"18400000"}</script>
</body></html>`;

// The page a datacenter address usually gets: no counts, no player config.
const CONSENT_PAGE = `
<!DOCTYPE html><html><body><form action="https://consent.youtube.com/save">
<h1>Before you continue to YouTube</h1></form></body></html>`;

// Rendered, but the count lives only in the player response.
const WATCH_PAGE_NO_COUNT = `
<!DOCTYPE html><html><body>
<script>var ytcfg={};ytcfg.set({"INNERTUBE_API_KEY":"AIzaSyPUBLICCLIENTKEY",
"INNERTUBE_CLIENT_VERSION":"2.20260815.01.00"});</script>
</body></html>`;

const PLAYER_RESPONSE = {
  videoDetails: {
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    author: 'Rick Astley',
    viewCount: '1583920411',
    thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/x/default.jpg' }] },
  },
  microformat: { playerMicroformatRenderer: { publishDate: '2009-10-25' } },
};

/* ---------------- parsers ---------------- */

test('reads the view count straight off the watch page', () => {
  const { statsFromWatchPage } = loadProviders();
  const stats = statsFromWatchPage(WATCH_PAGE_WITH_COUNT, 'dQw4w9WgXcQ');

  assert.equal(stats.views, 1583920411);
  assert.equal(stats.title, 'Never Gonna Give You Up');
  assert.equal(stats.author, 'Rick Astley');
  assert.equal(stats.publishedAt, '2009-10-25');
  assert.equal(stats.likes, 18400000);
  assert.equal(stats.source, 'watch-page');
});

test('returns null rather than guessing when the page has no count', () => {
  const { statsFromWatchPage } = loadProviders();
  assert.equal(statsFromWatchPage(CONSENT_PAGE, 'abc'), null);
  assert.equal(statsFromWatchPage(WATCH_PAGE_NO_COUNT, 'abc'), null);
});

test('reads the player API response', () => {
  const { statsFromPlayerResponse } = loadProviders();
  const stats = statsFromPlayerResponse(PLAYER_RESPONSE, 'dQw4w9WgXcQ');

  assert.equal(stats.views, 1583920411);
  assert.equal(stats.title, 'Never Gonna Give You Up');
  assert.equal(stats.publishedAt, '2009-10-25');
  assert.equal(stats.source, 'player-api');
});

test('an unplayable player response yields nothing', () => {
  const { statsFromPlayerResponse } = loadProviders();
  assert.equal(statsFromPlayerResponse({ playabilityStatus: { status: 'LOGIN_REQUIRED' } }, 'x'), null);
  assert.equal(statsFromPlayerResponse({}, 'x'), null);
});

test('failure messages name the actual cause', () => {
  const { explainNoKeyFailure } = loadProviders();
  assert.match(explainNoKeyFailure(CONSENT_PAGE), /consent page/i);
  assert.match(explainNoKeyFailure('<html>our systems have detected unusual traffic</html>'), /bot check/i);
  assert.match(explainNoKeyFailure('{"status":"LOGIN_REQUIRED"}'), /private, age-restricted/i);
  assert.match(explainNoKeyFailure(null), /could not reach/i);
});

/* ---------------- the fallback chain ---------------- */

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push(href);
    for (const [pattern, respond] of routes) {
      if (href.includes(pattern)) return respond(options);
    }
    throw new Error(`unexpected request: ${href}`);
  };
  return calls;
}

const ok = (body) => () => ({
  ok: true,
  status: 200,
  text: async () => body,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

test('stops at the watch page when it has the count', async (t) => {
  const providers = loadProviders();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  const calls = mockFetch([['youtube.com/watch', ok(WATCH_PAGE_WITH_COUNT)]]);
  const stats = await providers.fetchStats({ provider: 'youtube', externalId: 'dQw4w9WgXcQ' });

  assert.equal(stats.views, 1583920411);
  assert.equal(stats.source, 'watch-page');
  assert.equal(calls.length, 1, 'should not call the player API when the page sufficed');
});

test('falls through to the player API, using the key found on the page', async (t) => {
  const providers = loadProviders();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  const calls = mockFetch([
    ['youtube.com/watch', ok(WATCH_PAGE_NO_COUNT)],
    ['youtubei/v1/player', ok(PLAYER_RESPONSE)],
  ]);
  const stats = await providers.fetchStats({ provider: 'youtube', externalId: 'dQw4w9WgXcQ' });

  assert.equal(stats.views, 1583920411);
  assert.equal(stats.source, 'player-api');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /key=AIzaSyPUBLICCLIENTKEY/, 'should reuse the page key, not a hardcoded one');
});

test('a consent page fails with an explanation, not a wrong number', async (t) => {
  const providers = loadProviders();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  mockFetch([['youtube.com/watch', ok(CONSENT_PAGE)]]);
  await assert.rejects(
    providers.fetchStats({ provider: 'youtube', externalId: 'dQw4w9WgXcQ' }),
    /consent page/i,
  );
});

test('Piped is used as a last resort when configured', async (t) => {
  const providers = loadProviders({ PIPED_API: 'https://pipedapi.example/' });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  const calls = mockFetch([
    ['youtube.com/watch', ok(CONSENT_PAGE)],
    ['pipedapi.example', ok({ title: 'T', uploader: 'U', views: 4242, uploadDate: '2026-01-01' })],
  ]);
  const stats = await providers.fetchStats({ provider: 'youtube', externalId: 'dQw4w9WgXcQ' });

  assert.equal(stats.views, 4242);
  assert.equal(stats.source, 'piped');
  assert.equal(stats.author, 'U');
  assert.match(calls.at(-1), /pipedapi\.example\/streams\/dQw4w9WgXcQ$/, 'no double slash in the URL');
});

test('a key, when present, skips scraping entirely', async (t) => {
  const providers = loadProviders({ YOUTUBE_API_KEY: 'test-key' });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  const calls = mockFetch([['googleapis.com/youtube/v3/videos', ok({
    items: [{
      id: 'dQw4w9WgXcQ',
      snippet: { title: 'T', channelTitle: 'C', publishedAt: '2009-10-25T00:00:00Z', thumbnails: {} },
      statistics: { viewCount: '99', likeCount: '9', commentCount: '3' },
    }],
  })]]);

  const results = await providers.fetchStatsBatch([
    { id: 'youtube:dQw4w9WgXcQ', provider: 'youtube', external_id: 'dQw4w9WgXcQ' },
  ]);

  assert.equal(results.get('youtube:dQw4w9WgXcQ').stats.views, 99);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('googleapis.com'));
});

test('one dead video does not sink the rest of the batch', async (t) => {
  const providers = loadProviders();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  mockFetch([
    ['v=good', ok(WATCH_PAGE_WITH_COUNT)],
    ['v=dead', () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) })],
  ]);

  const results = await providers.fetchStatsBatch([
    { id: 'youtube:good', provider: 'youtube', external_id: 'good' },
    { id: 'youtube:dead', provider: 'youtube', external_id: 'dead' },
  ]);

  assert.equal(results.get('youtube:good').ok, true);
  assert.equal(results.get('youtube:dead').ok, false);
  assert.match(results.get('youtube:dead').error, /does not exist/i);
});
