'use strict';

// Frontend for the GitHub Pages build. There is no server here: readings are
// fetched as JSON straight from the repo, the analysis runs in the browser
// using the same lib/metrics.js the Node app uses, and adding or removing a
// video is a commit made through the GitHub API with your own token.

const CONFIG = globalThis.TRACKER_CONFIG;
const TOKEN_KEY = 'some-tracker:token';

/* ---------------- token, kept in this browser only ---------------- */

const token = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return ''; // private mode, or storage blocked
    }
  },
  set(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* nothing we can do; the session just stays read-only */ }
    renderConnection();
  },
  has() {
    return Boolean(this.get());
  },
};

function requireToken() {
  if (!token.has()) {
    openConnectPanel();
    throw new Error('Connect a GitHub token first — see “Connect” at the top right.');
  }
  return token.get();
}

/* ---------------- reading the repo ---------------- */

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.message || `${url.split('/').pop()} — ${res.status}`);
  }
  return res.json();
}

// The tracked list is read through the API when a token is present, because
// raw.githubusercontent.com can serve a cached copy for a few minutes and a
// video you just added would appear to vanish.
async function loadVideos() {
  if (token.has()) {
    const file = await github(`/contents/data/videos.json?ref=${CONFIG.branch}`);
    return { data: JSON.parse(fromBase64(file.content)), sha: file.sha };
  }
  return { data: await fetchJson(`${CONFIG.dataBase}/videos.json?t=${Date.now()}`), sha: null };
}

function loadHistory() {
  return fetchJson(`${CONFIG.dataBase}/history.json?t=${Date.now()}`);
}

/* ---------------- writing to the repo ---------------- */

async function github(path, options = {}) {
  return fetchJson(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${requireToken()}`,
      'x-github-api-version': '2022-11-28',
      ...options.headers,
    },
  });
}

async function commitVideos(videos, sha, message) {
  await github('/contents/data/videos.json', {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: toBase64(`${JSON.stringify({ videos }, null, 2)}\n`),
      sha,
      branch: CONFIG.branch,
    }),
  });
}

// Best effort: ask the poller to run now so a new card gets its first reading
// in a minute rather than at the next quarter hour. Needs the token to carry
// Actions write access; without it the scheduled run picks the video up.
async function nudgePoller() {
  try {
    await github('/actions/workflows/poll.yml/dispatches', {
      method: 'POST',
      body: JSON.stringify({ ref: CONFIG.branch }),
    });
  } catch { /* the schedule will get to it */ }
}

/* ---------------- turning stored readings into a dashboard ---------------- */

function pointsOf(entry) {
  if (!entry?.t?.length) return [];
  return entry.t.map((offset, i) => ({
    t: (entry.t0 + offset) * 1000,
    views: entry.v[i],
    likes: null,
    comments: null,
  }));
}

function spark(points) {
  const { buckets } = TrackerMetrics.buildSeries(points, { range: '7d' });
  if (buckets.length < 2) return [];
  const step = Math.max(1, Math.floor(buckets.length / 24));
  return buckets.filter((_, i) => i % step === 0).map((b) => b.gained);
}

function rank(video) {
  const order = { viral: 5, rising: 4, steady: 3, cooling: 2, warming: 1, flat: 0 };
  return (order[video.status?.tone] ?? 0) * 1e12 + (video.perHour || 0);
}

const cache = { points: new Map() };

const adapter = {
  async list() {
    const [{ data: list }, history] = await Promise.all([loadVideos(), loadHistory()]);

    cache.points.clear();
    const videos = (list.videos || []).map((video) => {
      const entry = history.videos?.[video.id];
      const points = pointsOf(entry);
      cache.points.set(video.id, points);
      return {
        ...video,
        title: entry?.title || video.url,
        author: entry?.author,
        thumbnail: entry?.thumbnail,
        publishedAt: entry?.publishedAt,
        lastError: entry?.lastError,
        ...TrackerMetrics.analyse(points),
        // After the spread: the stored readings carry no like counts, so the
        // analysis would otherwise blank out what the poller recorded.
        likes: entry?.likes ?? null,
        spark: spark(points),
      };
    });

    videos.sort((a, b) => rank(b) - rank(a));

    const checked = history.updatedAt
      ? `Last reading ${Dashboard.ago(Date.parse(history.updatedAt))}.`
      : 'No readings yet.';
    return {
      videos,
      note: `${checked} A scheduled GitHub Action takes one every 15 minutes.` +
        (token.has() ? '' : ' Read-only — connect a token to add videos.'),
    };
  },

  async series(id, range) {
    return TrackerMetrics.buildSeries(cache.points.get(id) || [], { range });
  },

  async add(url) {
    const link = TrackerLinks.parseLink(url);
    const { data, sha } = await loadVideos();
    const videos = data.videos || [];

    const existing = videos.find((v) => v.id === link.id);
    if (existing) return { video: { title: existing.url, ...existing }, duplicate: true };

    videos.push({
      id: link.id,
      provider: link.provider,
      externalId: link.externalId,
      url: link.url,
      addedAt: new Date().toISOString(),
    });

    await commitVideos(videos, sha, `Track ${link.url}`);
    await nudgePoller();
    return { video: { title: link.url }, duplicate: false };
  },

  async remove(id) {
    const { data, sha } = await loadVideos();
    const videos = (data.videos || []).filter((v) => v.id !== id);
    await commitVideos(videos, sha, `Stop tracking ${id}`);
  },
};

/* ---------------- connect panel ---------------- */

const connectButton = document.getElementById('connect');
const panel = document.getElementById('connect-panel');
const tokenInput = document.getElementById('token-input');

function renderConnection() {
  const connected = token.has();
  connectButton.textContent = connected ? 'Connected' : 'Connect';
  connectButton.classList.toggle('connected', connected);
  document.getElementById('token-save').hidden = connected;
  document.getElementById('token-clear').hidden = !connected;
  tokenInput.hidden = connected;
  document.getElementById('token-help').hidden = connected;
  document.getElementById('token-connected').hidden = !connected;
}

function openConnectPanel() {
  panel.hidden = false;
}

connectButton.addEventListener('click', () => {
  panel.hidden = !panel.hidden;
});

document.getElementById('token-save').addEventListener('click', () => {
  const value = tokenInput.value.trim();
  if (!value) return;
  token.set(value);
  tokenInput.value = '';
  panel.hidden = true;
  dashboard.reload().catch(() => {});
});

document.getElementById('token-clear').addEventListener('click', () => {
  token.set('');
  panel.hidden = true;
  dashboard.reload().catch(() => {});
});

document.getElementById('repo-link').href =
  `https://github.com/${CONFIG.owner}/${CONFIG.repo}`;
document.getElementById('token-link').href =
  `https://github.com/settings/personal-access-tokens/new`;

/* ---------------- base64 that survives non-ASCII titles ---------------- */

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(encoded) {
  const binary = atob(String(encoded).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/* ---------------- boot ---------------- */

renderConnection();

const dashboard = Dashboard.create({
  adapter,
  elements: {
    form: document.getElementById('add-form'),
    input: document.getElementById('link-input'),
    addButton: document.getElementById('add-button'),
    message: document.getElementById('form-message'),
    board: document.getElementById('board'),
    empty: document.getElementById('empty'),
    summary: document.getElementById('summary'),
    note: document.getElementById('poll-note'),
    refreshButton: null,
  },
});
