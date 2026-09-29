'use strict';

/**
 * The share viewer.
 *
 * Nothing here knows about tokens or localStorage - the slug in the query
 * string is the only credential, and it is passed straight through to
 * /api/share. Keeping this separate from app.js is what lets a recipient
 * without an account watch without ever meeting the auth gate.
 */

const $ = (sel) => document.querySelector(sel);

const formatDuration = (sec) => {
  if (!sec && sec !== 0) return '';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

function showError(title, body) {
  $('#share-error-title').textContent = title;
  $('#share-error-body').textContent = body;
  $('#share-error').hidden = false;
  $('#share-foot').hidden = false;
}

(async function boot() {
  const slug = new URLSearchParams(location.search).get('s');

  // Fail the same way for a missing slug and a revoked one. A different
  // message for each would tell someone probing which slugs had once existed.
  if (!slug) {
    showError('This link is not valid', 'The address is missing its share code.');
    return;
  }

  let media;
  try {
    const res = await fetch(`/api/share/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error(String(res.status));
    media = await res.json();
  } catch {
    showError(
      'This link is not valid',
      'It may have been revoked by its owner, or the address may be incomplete.'
    );
    return;
  }

  document.title = `${media.title} · FlixDrive`;

  // Titles and descriptions are user-supplied. textContent, never innerHTML.
  $('#share-title').textContent = media.title;
  $('#share-sub').textContent = [
    media.kind === 'photo' ? 'Photo' : 'Video',
    media.width && `${media.width}×${media.height}`,
    media.durationSec ? formatDuration(media.durationSec) : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  if (media.description) {
    $('#share-description').textContent = media.description;
    $('#share-description').hidden = false;
  }

  if (media.kind === 'photo') {
    const img = $('#share-image');
    img.src = media.mediaUrl;
    img.alt = media.title;
    img.hidden = false;
  } else {
    const video = $('#share-video');
    if (media.posterUrl) video.poster = media.posterUrl;
    video.src = media.mediaUrl;
    video.hidden = false;
  }

  $('#stage').hidden = false;
  $('#meta').hidden = false;
  $('#share-foot').hidden = false;
})();
