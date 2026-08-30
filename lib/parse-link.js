'use strict';

// Turns a pasted URL into a canonical video reference. Pure and dependency
// free, so the browser and the server agree on what a link means — the static
// build wraps this same file rather than keeping a second copy.

class UnsupportedLinkError extends Error {}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function parseLink(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new UnsupportedLinkError('Paste a video link first.');

  let url;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    throw new UnsupportedLinkError(`That does not look like a link: "${raw}"`);
  }

  const host = url.hostname.replace(/^www\.|^m\./, '').toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be' && segments[0]) {
    return youtube(segments[0]);
  }

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = url.searchParams.get('v');
    if (v) return youtube(v);
    // /shorts/ID, /embed/ID, /live/ID, /v/ID
    if (['shorts', 'embed', 'live', 'v'].includes(segments[0]) && segments[1]) {
      return youtube(segments[1]);
    }
    throw new UnsupportedLinkError(
      'That YouTube link does not point at a single video (channels and playlists are not tracked).',
    );
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = segments.find((s) => /^\d+$/.test(s));
    if (id) {
      return { provider: 'vimeo', externalId: id, id: `vimeo:${id}`, url: `https://vimeo.com/${id}` };
    }
    throw new UnsupportedLinkError('Could not find a video id in that Vimeo link.');
  }

  throw new UnsupportedLinkError(
    `${host} is not supported yet — YouTube and Vimeo links work today.`,
  );
}

function youtube(rawId) {
  const id = rawId.split(/[?&#]/)[0];
  if (!YOUTUBE_ID.test(id)) {
    throw new UnsupportedLinkError(`"${rawId}" is not a valid YouTube video id.`);
  }
  return {
    provider: 'youtube',
    externalId: id,
    id: `youtube:${id}`,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

module.exports = { parseLink, UnsupportedLinkError };
