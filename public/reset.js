'use strict';

/**
 * The reset page.
 *
 * Holds no session and issues none: the API answers `{ ok: true }` and the
 * user goes to the sign-in screen to use the password they just chose. That
 * round trip is the confirmation that it worked.
 */

const $ = (sel) => document.querySelector(sel);

const form = $('#reset-form');
const status = $('#reset-status');
const token = new URLSearchParams(location.search).get('token');

function fail(message) {
  status.className = 'form-msg is-err';
  status.textContent = message;
}

if (!token) {
  fail('This link is missing its reset code. Request a new one from the sign-in page.');
  form.querySelector('button[type="submit"]').disabled = true;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  const newPassword = form.newPassword.value;

  // Checked here as well as by the API, because getting this wrong locks the
  // user out of an account they have just proved they own.
  if (newPassword !== form.confirmPassword.value) {
    return fail('Those two passwords do not match.');
  }
  if (newPassword.length < 8) {
    return fail('Use at least 8 characters.');
  }

  btn.disabled = true;
  status.className = 'form-msg';
  status.textContent = 'Setting your new password…';

  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    form.reset();
    status.className = 'form-msg is-ok';
    status.textContent = 'Password changed. Redirecting you to sign in…';
    setTimeout(() => { location.href = '/'; }, 1600);
  } catch (err) {
    fail(err.message);
    btn.disabled = false;
  }
});
