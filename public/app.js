'use strict';

// Frontend for the Node server: the API already does the analysis, so this
// adapter is a thin wrapper over fetch. All rendering lives in dashboard.js,
// shared with the static GitHub Pages build.

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const adapter = {
  async list() {
    const data = await api('/api/videos');
    const mins = data.poller?.intervalMinutes ?? 15;
    const checked = data.poller?.lastRunAt
      ? `Last checked ${Dashboard.ago(Date.parse(data.poller.lastRunAt))}. `
      : '';
    return {
      videos: data.videos,
      note: `${checked}Checking every ${mins} min.` +
        (data.youtubeApiKey ? '' : ' No YOUTUBE_API_KEY set — using the public page fallback.'),
    };
  },

  series(id, range) {
    return api(`/api/videos/${encodeURIComponent(id)}/series?range=${range}`);
  },

  add(url) {
    return api('/api/videos', { method: 'POST', body: JSON.stringify({ url }) });
  },

  async remove(id) {
    await api(`/api/videos/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async refresh() {
    await api('/api/refresh', { method: 'POST' });
  },
};

Dashboard.create({
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
    refreshButton: document.getElementById('refresh'),
  },
});
