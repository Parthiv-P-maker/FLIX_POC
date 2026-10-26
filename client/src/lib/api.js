/**
 * The one place that talks to the server.
 *
 * Module state rather than React state: the session token and the media token
 * are read by code that runs outside any render (an XHR progress handler, a
 * keepalive fetch on unload), and neither should cause a re-render when it
 * changes.
 */

const TOKEN_KEY = 'flixdrive.token';

let token = safeGet(TOKEN_KEY);
// Deliberately not persisted. It is cheap to re-request and there is no
// reason to leave it in localStorage where a stray script could read it.
let mediaToken = null;
let onUnauthorized = () => {};

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export const getToken = () => token;

export function setToken(next) {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage blocked: the session just will not survive a reload */ }
}

/** Called on any 401 while signed in, so the app can drop back to the gate. */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

/**
 * Every non-stream endpoint is header-authenticated. A 401 means the token is
 * gone or expired, so we drop it rather than retry against a dead session.
 */
export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (res.status === 401 && token && !path.startsWith('/api/auth/login')) {
    onUnauthorized();
    throw new Error('Session expired, please sign in again');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/**
 * Upload with a real progress readout. fetch() exposes no upload progress, so
 * uploads - and only uploads - use XMLHttpRequest.
 */
export function upload(path, formData, onProgress, onStart) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (onStart) onStart(xhr);
    xhr.open('POST', path);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    // The server still has to write the file; pin the bar at 100%.
    xhr.upload.addEventListener('load', () => onProgress(1));

    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* keep {} */ }
      if (xhr.status === 401 && token) {
        onUnauthorized();
        return reject(new Error('Session expired, please sign in again'));
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        return reject(new Error(data.error || `Upload failed (${xhr.status})`));
      }
      resolve(data);
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
    xhr.send(formData);
  });
}

/**
 * Swap the session token for a short-lived, media-only one. The server refuses
 * a session token in a query string, so no <video> or <img> src works until
 * this has run.
 */
export async function refreshMediaToken() {
  try {
    const { token: fresh } = await api('/api/auth/media-token');
    mediaToken = fresh;
  } catch {
    // Keep the old one; it may still be valid and the next refresh retries.
  }
  return mediaToken;
}

export const clearMediaToken = () => { mediaToken = null; };

// <video src> and <img src> cannot carry an Authorization header.
export const withToken = (url) =>
  `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(mediaToken || '')}`;

// Posters are authorised, so every <img src> needs the token. Null-safe: an
// asset still being processed has no poster yet.
export const posterSrc = (asset) => (asset?.posterUrl ? withToken(asset.posterUrl) : '');

/** Playback position, written with keepalive so the last one survives unload. */
export function sendProgress(assetId, positionSec, keepalive = false) {
  if (!token || !Number.isFinite(positionSec) || positionSec <= 0) return;
  fetch(`/api/progress/${assetId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ positionSec: Math.floor(positionSec) }),
    keepalive,
  }).catch(() => {});
}
