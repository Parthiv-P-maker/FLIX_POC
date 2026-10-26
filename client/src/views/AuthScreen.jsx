import { useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../store.jsx';
import { Logo } from '../components/Sidebar.jsx';
import Icon from '../components/Icon.jsx';

const FEATURES = [
  { icon: 'film', title: 'Stream anything', body: 'Seekable playback, scrub previews and resume.' },
  { icon: 'sparkle', title: 'AI photo search', body: 'Find photos by what is in them.' },
  { icon: 'link', title: 'Share privately', body: 'One link, no account needed.' },
];

export default function AuthScreen() {
  const { enter, theme, toggleTheme } = useApp();
  const [mode, setMode] = useState('login'); // login | register | forgot
  const [form, setForm] = useState({ displayName: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', kind: '' });

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const isRegister = mode === 'register';

  const switchMode = (next) => {
    setMode(next);
    setMsg({ text: '', kind: '' });
  };

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setMsg({ text: '', kind: '' });
    try {
      const payload = { email: form.email.trim(), password: form.password };
      if (isRegister) payload.displayName = form.displayName.trim();
      const data = await api(`/api/auth/${mode}`, { method: 'POST', body: payload });
      await enter(data.user, data.token);
    } catch (err) {
      setMsg({ text: err.message, kind: 'is-err' });
      setBusy(false);
    }
  }

  async function forgot(e) {
    e.preventDefault();
    setBusy(true);
    setMsg({ text: 'Sending…', kind: '' });
    try {
      const data = await api('/api/auth/forgot-password', {
        method: 'POST', body: { email: form.email.trim() },
      });
      // The API says the same thing whether or not the account exists; echo it.
      setMsg({ text: data.message, kind: 'is-ok' });
    } catch (err) {
      setMsg({ text: err.message, kind: 'is-err' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth">
      <button className="icon-btn auth-theme" type="button" onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
      </button>

      <div className="auth-intro">
        <div className="orbit" aria-hidden="true">
          <span className="orbit-ring r1" /><span className="orbit-ring r2" /><span className="orbit-ring r3" />
          <span className="orbit-core"><Icon name="play" /></span>
        </div>
        <span className="hud">Personal media cloud · v2</span>
        <h1 className="auth-headline">
          Your films and photos,<br /><span className="grad-text">in one place.</span>
        </h1>
        <ul className="auth-features">
          {FEATURES.map((f) => (
            <li key={f.title} className="neu">
              <span className="feat-ico"><Icon name={f.icon} /></span>
              <span><strong>{f.title}</strong><small>{f.body}</small></span>
            </li>
          ))}
        </ul>
      </div>

      <div className="auth-card neu">
        <Logo large />

        {mode === 'forgot' ? (
          <form className="auth-form" onSubmit={forgot} noValidate>
            <h2 className="auth-title">Reset your password</h2>
            <p className="muted">Enter your email and we will send a link to choose a new password.</p>
            <label className="field">
              <span className="field-label">Email</span>
              <input type="email" autoComplete="email" required placeholder="you@example.com"
                     value={form.email} onChange={set('email')} />
            </label>
            <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={busy}>
              Send reset link
            </button>
            <button className="link-btn" type="button" onClick={() => switchMode('login')}>
              Back to sign in
            </button>
            <p className={`form-msg ${msg.kind}`} role="alert">{msg.text}</p>
          </form>
        ) : (
          <>
            <div className="segmented" role="tablist" aria-label="Account">
              <button type="button" role="tab" aria-selected={!isRegister}
                      className={`seg${!isRegister ? ' is-active' : ''}`} onClick={() => switchMode('login')}>
                Sign in
              </button>
              <button type="button" role="tab" aria-selected={isRegister}
                      className={`seg${isRegister ? ' is-active' : ''}`} onClick={() => switchMode('register')}>
                Create account
              </button>
            </div>

            <form className="auth-form" onSubmit={submit} autoComplete="on" noValidate>
              {isRegister && (
                <label className="field">
                  <span className="field-label">Display name</span>
                  <input type="text" autoComplete="name" required placeholder="Ada Lovelace"
                         value={form.displayName} onChange={set('displayName')} />
                </label>
              )}
              <label className="field">
                <span className="field-label">Email</span>
                <input type="email" autoComplete="email" required placeholder="you@example.com"
                       value={form.email} onChange={set('email')} />
              </label>
              <label className="field">
                <span className="field-label">Password</span>
                <input type="password" minLength={8} required placeholder="At least 8 characters"
                       autoComplete={isRegister ? 'new-password' : 'current-password'}
                       value={form.password} onChange={set('password')} />
              </label>

              <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={busy}>
                {busy ? <span className="spinner spinner-sm" aria-hidden="true" /> : null}
                {isRegister ? 'Create account' : 'Sign in'}
              </button>
              <p className={`form-msg ${msg.kind}`} role="alert">{msg.text}</p>
            </form>

            {!isRegister && (
              <p className="auth-alt">
                <button className="link-btn" type="button" onClick={() => switchMode('forgot')}>
                  Forgot your password?
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
