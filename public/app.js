'use strict';

const form = document.getElementById('add-form');
const input = document.getElementById('link-input');
const addButton = document.getElementById('add-button');
const message = document.getElementById('form-message');
const board = document.getElementById('board');
const empty = document.getElementById('empty');
const summary = document.getElementById('summary');
const pollNote = document.getElementById('poll-note');
const refreshButton = document.getElementById('refresh');

const REFRESH_MS = 60 * 1000;
const state = {
  videos: [],
  openId: null,
  range: '7d',
  series: new Map(),
};

/* ---------------- api ---------------- */

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function load() {
  const data = await api('/api/videos');
  state.videos = data.videos;
  renderBoard();
  renderSummary(data);
}

/* ---------------- adding links ---------------- */

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) return;

  setBusy(true);
  say('Fetching…');
  try {
    const { video, duplicate } = await api('/api/videos', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    input.value = '';
    say(duplicate ? `Already tracking “${video.title}”.` : `Tracking “${video.title}”.`, 'success');
    await load();
  } catch (err) {
    say(err.message, 'error');
  } finally {
    setBusy(false);
    input.focus();
  }
});

// Pasting a link is the whole interaction — submit it without a click.
input.addEventListener('paste', () => {
  setTimeout(() => {
    if (input.value.trim()) form.requestSubmit();
  }, 0);
});

refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  refreshButton.textContent = 'Refreshing…';
  try {
    await api('/api/refresh', { method: 'POST' });
    state.series.clear();
    await load();
    if (state.openId) await openDetail(state.openId);
  } catch (err) {
    say(err.message, 'error');
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = 'Refresh now';
  }
});

function setBusy(busy) {
  addButton.disabled = busy;
  addButton.textContent = busy ? 'Working…' : 'Track it';
}

function say(text, tone = '') {
  message.textContent = text;
  message.className = `form-message ${tone}`;
}

/* ---------------- rendering ---------------- */

function renderSummary(data) {
  const total = state.videos.reduce((sum, v) => sum + (v.views || 0), 0);
  const perDay = state.videos.reduce((sum, v) => sum + (v.perDay || 0), 0);
  const hot = state.videos.filter((v) => ['viral', 'rising'].includes(v.status.tone)).length;

  summary.hidden = state.videos.length === 0;
  summary.replaceChildren(
    pill('Tracking', String(state.videos.length)),
    pill('Total views', compact(total)),
    pill('Views/day', compact(Math.round(perDay))),
    pill('Heating up', String(hot)),
  );

  const mins = data.poller?.intervalMinutes ?? 15;
  const checked = data.poller?.lastRunAt ? `Last checked ${ago(Date.parse(data.poller.lastRunAt))}. ` : '';
  pollNote.textContent =
    `${checked}Checking every ${mins} min.` +
    (data.youtubeApiKey ? '' : ' No YOUTUBE_API_KEY set — using the public page fallback.');
}

function pill(label, value) {
  const el = document.createElement('span');
  el.className = 'summary-pill';
  el.append(`${label} `);
  const b = document.createElement('b');
  b.textContent = value;
  el.append(b);
  return el;
}

function renderBoard() {
  empty.hidden = state.videos.length > 0;
  board.replaceChildren(...state.videos.map(renderCard));
  if (state.openId && state.videos.some((v) => v.id === state.openId)) {
    drawDetail(state.openId);
  }
}

function renderCard(video) {
  const card = el('article', `card tone-${video.status.tone}`);
  card.dataset.id = video.id;
  if (video.id === state.openId) card.classList.add('is-open');

  const main = el('div', 'card-main');
  main.addEventListener('click', () => toggleDetail(video.id));

  const thumb = thumbnail(video);

  const body = el('div', 'card-body');
  const title = el('h2', 'card-title', video.title);
  const parts = [video.author || video.provider];
  if (video.publishedAt) parts.push(`published ${dateLabel(Date.parse(video.publishedAt))}`);
  parts.push(`tracked ${ago(Date.parse(video.addedAt))}`);
  const meta = el('p', 'card-meta', parts.join(' · '));
  body.append(title, meta);

  if (video.reason) body.append(el('p', 'card-reason', video.reason));
  if (video.lastError) body.append(el('p', 'card-error', `Last check failed: ${video.lastError}`));

  const stats = el('div', 'card-stats');
  stats.append(
    sparkSvg(video.spark, video.status.tone),
    stat(compact(video.views), 'views'),
    stat(
      video.perDay == null ? '–' : `+${compact(Math.round(video.perDay))}`,
      'per day',
      video.perDay > 0 ? 'up' : '',
    ),
    stat(momentumLabel(video), 'momentum', momentumTone(video)),
    badge(video.status),
  );

  main.append(thumb, body, stats);
  card.append(main);

  if (video.id === state.openId) card.append(detailShell(video));
  return card;
}

// A real image when the provider gave us one, otherwise a quiet placeholder
// rather than an empty box.
function thumbnail(video) {
  if (!video.thumbnail) {
    const fallback = el('div', 'thumb thumb-empty', '▶');
    return fallback;
  }
  const img = document.createElement('img');
  img.className = 'thumb';
  img.loading = 'lazy';
  img.alt = '';
  img.src = video.thumbnail;
  img.addEventListener('error', () => img.replaceWith(el('div', 'thumb thumb-empty', '▶')));
  return img;
}

// On a quiet video the percentage is noise on top of tiny numbers, so it is
// shown without the green/amber styling that would imply a real trend.
function momentumLabel(video) {
  if (video.changePct == null) return '–';
  return `${video.changePct >= 0 ? '+' : ''}${Math.round(video.changePct)}%`;
}

function momentumTone(video) {
  if (video.changePct == null || video.status.tone === 'flat') return '';
  return video.changePct >= 0 ? 'up' : 'down';
}

function stat(value, label, tone = '') {
  const wrap = el('div', 'stat');
  wrap.append(el('div', `stat-value ${tone}`, value), el('div', 'stat-label', label));
  return wrap;
}

function badge(status) {
  return el('span', `badge badge-${status.tone}`, `${status.icon} ${status.label}`);
}

/* ---------------- detail panel ---------------- */

function toggleDetail(id) {
  state.openId = state.openId === id ? null : id;
  renderBoard();
  if (state.openId) openDetail(state.openId);
}

function detailShell(video) {
  const detail = el('div', 'detail');
  detail.addEventListener('click', (e) => e.stopPropagation());

  const head = el('div', 'detail-head');
  const ranges = el('div', 'range-group');
  for (const [key, label] of [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All time']]) {
    const button = el('button', `range-button ${state.range === key ? 'active' : ''}`, label);
    button.type = 'button';
    button.addEventListener('click', () => {
      state.range = key;
      renderBoard();
      openDetail(video.id);
    });
    ranges.append(button);
  }

  const links = el('div', 'detail-links');
  const open = document.createElement('a');
  open.href = video.url;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.textContent = 'Open video ↗';

  const remove = el('button', 'remove-button', 'Stop tracking');
  remove.type = 'button';
  remove.addEventListener('click', () => removeVideo(video));
  links.append(open, remove);

  head.append(ranges, links);

  const wrap = el('div', 'chart-wrap');
  wrap.append(el('div', 'chart-tip'));
  const chartSlot = el('div', 'chart-slot');
  chartSlot.append(el('p', 'chart-caption', 'Loading history…'));
  wrap.append(chartSlot);

  detail.append(head, wrap, detailStats(video));
  return detail;
}

function detailStats(video) {
  const grid = el('div', 'detail-grid');
  const entries = [
    ['Views now', compact(video.views)],
    ['Gained while tracked', `+${compact(video.trackedGain || 0)}`],
    ['Per hour', video.perHour == null ? '–' : compact(Math.round(video.perHour))],
    ['Peak per hour', video.peakPerHour == null ? '–' : compact(Math.round(video.peakPerHour))],
    ['Likes', video.likes == null ? '–' : compact(video.likes)],
    ['Readings', String(video.readings ?? 0)],
  ];
  for (const [label, value] of entries) {
    const cell = document.createElement('div');
    cell.append(el('div', 'detail-stat-label', label), el('div', 'detail-stat-value', value));
    grid.append(cell);
  }
  return grid;
}

async function removeVideo(video) {
  if (!confirm(`Stop tracking “${video.title}”? Its history is deleted too.`)) return;
  await api(`/api/videos/${encodeURIComponent(video.id)}`, { method: 'DELETE' });
  state.openId = null;
  state.series.delete(video.id);
  say(`Stopped tracking “${video.title}”.`);
  await load();
}

async function openDetail(id) {
  try {
    const data = await api(`/api/videos/${encodeURIComponent(id)}/series?range=${state.range}`);
    state.series.set(id, data);
    drawDetail(id);
  } catch (err) {
    say(err.message, 'error');
  }
}

function drawDetail(id) {
  const card = board.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  const slot = card?.querySelector('.chart-slot');
  const data = state.series.get(id);
  if (!slot || !data) return;

  if (!data.buckets || data.buckets.length < 2) {
    slot.replaceChildren(el('p', 'chart-caption',
      'Not enough history yet — the curve appears after a few checks.'));
    return;
  }

  const video = state.videos.find((v) => v.id === id);
  slot.replaceChildren(
    chart(data, card.querySelector('.chart-tip'), video?.status.tone || 'steady'),
    el('p', 'chart-caption',
      `Views gained per ${hours(data.bucketHours)}. Taller means more people were watching then. ` +
      `Tracking since ${dateLabel(video?.trackingSince)}.`),
  );
}

/* ---------------- svg chart ---------------- */

const TONE_COLORS = {
  viral: '#ff6b4a', rising: '#34d399', steady: '#7d8bab',
  cooling: '#f0b429', flat: '#5a637a', warming: '#8b7fd4',
};

function chart(data, tip, tone) {
  const buckets = data.buckets;
  const W = 900;
  const H = 210;
  const pad = { top: 14, right: 12, bottom: 26, left: 48 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const max = Math.max(1, ...buckets.map((b) => b.gained));
  const ceiling = niceCeiling(max);
  const color = TONE_COLORS[tone] || TONE_COLORS.steady;

  const x = (i) => pad.left + (plotW * i) / Math.max(1, buckets.length - 1);
  const y = (v) => pad.top + plotH - (plotH * v) / ceiling;

  const svg = svgEl('svg', {
    class: 'chart',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    role: 'img',
  });

  const gradientId = `grad-${Math.random().toString(36).slice(2, 8)}`;
  const defs = svgEl('defs');
  const gradient = svgEl('linearGradient', { id: gradientId, x1: '0', y1: '0', x2: '0', y2: '1' });
  gradient.append(
    svgEl('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '.38' }),
    svgEl('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': '0' }),
  );
  defs.append(gradient);
  svg.append(defs);

  // horizontal gridlines + y labels
  for (let i = 0; i <= 4; i++) {
    const value = (ceiling * i) / 4;
    const yy = y(value);
    svg.append(svgEl('line', {
      x1: pad.left, x2: W - pad.right, y1: yy, y2: yy,
      stroke: '#232b3d', 'stroke-width': 1,
    }));
    const label = svgEl('text', {
      x: pad.left - 9, y: yy + 4, 'text-anchor': 'end',
      fill: '#667089', 'font-size': '11',
    });
    label.textContent = compact(value);
    svg.append(label);
  }

  const line = buckets.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(b.gained).toFixed(1)}`).join(' ');
  const area = `${line} L${x(buckets.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;

  svg.append(svgEl('path', { d: area, fill: `url(#${gradientId})` }));
  svg.append(svgEl('path', {
    d: line, fill: 'none', stroke: color, 'stroke-width': 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  // x labels at a handful of evenly spaced points
  const ticks = Math.min(6, buckets.length);
  for (let i = 0; i < ticks; i++) {
    const index = Math.round((i * (buckets.length - 1)) / (ticks - 1 || 1));
    const label = svgEl('text', {
      x: x(index), y: H - 8,
      'text-anchor': i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle',
      fill: '#667089', 'font-size': '11',
    });
    label.textContent = tickLabel(buckets[index].t, data.bucketHours);
    svg.append(label);
  }

  const marker = svgEl('circle', { r: 4, fill: color, opacity: '0' });
  svg.append(marker);

  const overlay = svgEl('rect', {
    x: pad.left, y: pad.top, width: plotW, height: plotH,
    fill: 'transparent', style: 'cursor: crosshair',
  });
  overlay.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = Math.max(0, Math.min(buckets.length - 1,
      Math.round(((ratio * W - pad.left) / plotW) * (buckets.length - 1))));
    const bucket = buckets[index];

    marker.setAttribute('cx', x(index));
    marker.setAttribute('cy', y(bucket.gained));
    marker.setAttribute('opacity', '1');

    tip.replaceChildren();
    const strong = document.createElement('b');
    strong.textContent = `+${compact(bucket.gained)} views`;
    tip.append(strong, document.createElement('br'),
      `${dateLabel(bucket.t, true)} · ${compact(bucket.views)} total`);
    tip.classList.add('visible');
    tip.style.left = `${(x(index) / W) * rect.width}px`;
    tip.style.top = `${(y(bucket.gained) / H) * rect.height}px`;
  });
  overlay.addEventListener('pointerleave', () => {
    tip.classList.remove('visible');
    marker.setAttribute('opacity', '0');
  });
  svg.append(overlay);

  return svg;
}

function niceCeiling(max) {
  const magnitude = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / magnitude) * magnitude;
}

function svgEl(name, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function sparkSvg(values, tone) {
  const svg = svgEl('svg', { class: 'spark', viewBox: '0 0 100 34', preserveAspectRatio: 'none' });
  if (!values || values.length < 2) return svg;

  const max = Math.max(1, ...values);
  const step = 100 / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(32 - (v / max) * 29).toFixed(1)}`);

  svg.append(svgEl('polyline', {
    points: points.join(' '),
    fill: 'none',
    stroke: TONE_COLORS[tone] || TONE_COLORS.steady,
    'stroke-width': 2,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
    'vector-effect': 'non-scaling-stroke',
  }));
  return svg;
}

/* ---------------- formatting ---------------- */

function compact(n) {
  if (n == null || Number.isNaN(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `${trim(n / 1e3)}K`;
  return String(Math.round(n));
}

function trim(n) {
  return String(Math.round(n * 10) / 10);
}

function hours(h) {
  if (h == null) return 'step';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h === 1) return 'hour';
  if (h === 24) return 'day';
  if (h % 24 === 0) return `${h / 24} days`;
  return `${trim(h)} hours`;
}

// X-axis labels: show the hour while buckets are sub-daily, otherwise just the
// date, so a 24h view and an all-time view both stay readable.
function tickLabel(t, bucketHours) {
  const date = new Date(t);
  if (bucketHours && bucketHours < 24) {
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dateLabel(t, withTime = false) {
  if (!t) return 'unknown';
  const date = new Date(t);
  const opts = withTime
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric' };
  return date.toLocaleString(undefined, opts);
}

function ago(t) {
  if (!t) return 'never';
  const seconds = Math.max(0, (Date.now() - t) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hrs = minutes / 60;
  if (hrs < 24) return `${Math.round(hrs)}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/* ---------------- boot ---------------- */

load().catch((err) => say(err.message, 'error'));
setInterval(() => {
  load().catch(() => {});
  if (state.openId) openDetail(state.openId).catch(() => {});
}, REFRESH_MS);
input.focus();
