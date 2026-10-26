import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './styles/theme.css';
import './styles/app.css';
import { readPref } from './lib/format.js';
import { Logo } from './components/Sidebar.jsx';

/**
 * The reset page. Holds no session and issues none: the API answers ok and
 * the user signs in with the password they just chose. That round trip is
 * the confirmation that it worked.
 */
function Reset() {
  const token = new URLSearchParams(location.search).get('token');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(token
    ? { text: '', kind: '' }
    : { text: 'This link is missing its reset code. Request a new one from the sign-in page.', kind: 'is-err' });

  useEffect(() => { document.documentElement.dataset.theme = readPref('theme', 'dark'); }, []);

  const submit = async (e) => {
    e.preventDefault();
    // Checked here as well as by the API: getting this wrong locks the user
    // out of an account they have just proved they own.
    if (pw !== confirm) { setMsg({ text: 'Those two passwords do not match.', kind: 'is-err' }); return; }
    if (pw.length < 8) { setMsg({ text: 'Use at least 8 characters.', kind: 'is-err' }); return; }

    setBusy(true);
    setMsg({ text: 'Setting your new password…', kind: '' });
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setPw(''); setConfirm('');
      setMsg({ text: 'Password changed. Redirecting you to sign in…', kind: 'is-ok' });
      setTimeout(() => { location.href = '/'; }, 1600);
    } catch (err) {
      setMsg({ text: err.message, kind: 'is-err' });
      setBusy(false);
    }
  };

  return (
    <main className="auth auth-single">
      <div className="auth-card neu">
        <Logo large />
        <form className="auth-form" onSubmit={submit} noValidate>
          <h1 className="auth-title">Choose a new password</h1>
          <label className="field">
            <span className="field-label">New password</span>
            <input type="password" autoComplete="new-password" minLength={8} required placeholder="At least 8 characters"
                   value={pw} onChange={(e) => setPw(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Confirm password</span>
            <input type="password" autoComplete="new-password" minLength={8} required
                   value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={busy || !token}>Set password</button>
          <p className={`form-msg ${msg.kind}`} role="alert">{msg.text}</p>
          <a className="link-btn" href="/">Back to sign in</a>
        </form>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><Reset /></StrictMode>);
