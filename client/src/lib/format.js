export function formatDuration(sec) {
  if (!sec && sec !== 0) return '';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatSize(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

// "3h 24m" reads better than "204 minutes" on a stat tile.
export function formatSpan(sec) {
  const total = Math.round(sec || 0);
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] || '').join('').toUpperCase() || '?';
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const plays = (n) => `${n} ${n === 1 ? 'play' : 'plays'}`;
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const joinMeta = (parts) => parts.filter(Boolean).join('  ·  ');

/**
 * <input type="datetime-local"> has no timezone, so it wants a local-time
 * string - an ISO string with a Z would shift by the user's offset.
 */
export function toLocalInputValue(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// localStorage can throw (private mode, blocked storage); a missing
// preference is never worth an error.
export function readPref(key, fallback) {
  try {
    const raw = localStorage.getItem(`flixdrive.${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try { localStorage.setItem(`flixdrive.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
}

export const isTyping = (target) =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
