import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatSize, formatSpan, initialsOf } from '../lib/format.js';
import { useApp } from '../store.jsx';
import Icon from '../components/Icon.jsx';
import { PageHead } from '../components/Media.jsx';

function Ring({ value, max }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <svg className="ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle className="ring-track" cx="18" cy="18" r="15.9" />
      <circle className="ring-fill" cx="18" cy="18" r="15.9" style={{ strokeDasharray: `${pct} 100` }} />
    </svg>
  );
}

export default function Profile() {
  const { user, setUser, signOut, toast, versions, theme, toggleTheme } = useApp();
  const [stats, setStats] = useState(null);
  const [name, setName] = useState(user.displayName);
  const [nameMsg, setNameMsg] = useState({ text: '', kind: '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [pwMsg, setPwMsg] = useState({ text: '', kind: '' });
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let stale = false;
    api('/api/profile').then(({ user: u, stats: s }) => {
      if (stale) return;
      setUser(u);
      setStats(s);
    }).catch(() => {});
    return () => { stale = true; };
  }, [versions.profile, setUser]);

  const saveName = async (e) => {
    e.preventDefault();
    setBusy('name');
    setNameMsg({ text: 'Saving…', kind: '' });
    try {
      const { user: u } = await api('/api/profile', { method: 'PATCH', body: { displayName: name.trim() } });
      setUser(u);
      setNameMsg({ text: 'Saved.', kind: 'is-ok' });
      toast('Display name updated');
    } catch (err) {
      setNameMsg({ text: err.message, kind: 'is-err' });
    } finally { setBusy(''); }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    setBusy('pw');
    setPwMsg({ text: 'Updating…', kind: '' });
    try {
      await api('/api/profile/password', { method: 'PUT', body: pw });
      setPw({ currentPassword: '', newPassword: '' });
      setPwMsg({ text: 'Password changed.', kind: 'is-ok' });
      toast('Password changed');
    } catch (err) {
      setPwMsg({ text: err.message, kind: 'is-err' });
    } finally { setBusy(''); }
  };

  const tiles = stats ? [
    { value: stats.videos, label: 'Videos', icon: 'film' },
    { value: stats.photos, label: 'Photos', icon: 'photos' },
    { value: stats.shared, label: 'Shared to catalog', icon: 'globe' },
    { value: stats.favorites, label: 'Favourite photos', icon: 'heart' },
    { value: formatSize(stats.storageBytes), label: 'Storage used', icon: 'upload' },
    { value: formatSpan(stats.librarySec), label: 'Runtime in library', icon: 'watch' },
    { value: formatSpan(stats.watchedSec), label: 'Watched', icon: 'play' },
    { value: `${stats.finished}/${stats.started}`, label: 'Finished / started', icon: 'check', ring: [stats.finished, stats.started] },
  ] : null;

  return (
    <>
      <PageHead kicker="Account" title="Profile" sub="Your account and what is in your library." />

      <article className="profile-card neu">
        <span className="avatar avatar-lg">{initialsOf(user.displayName)}</span>
        <div className="profile-id">
          <h2>{user.displayName}</h2>
          <p className="muted">{user.email}</p>
          <p className="hud">
            Member since {new Date(user.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </p>
        </div>
        <div className="profile-actions">
          <button className="btn" type="button" onClick={toggleTheme}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />{theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <button className="btn" type="button" onClick={signOut}><Icon name="out" />Sign out</button>
        </div>
      </article>

      <div className="stats">
        {tiles ? tiles.map((t, i) => (
          <div className="stat neu" key={t.label} style={{ '--i': i }}>
            <span className="stat-ico">{t.ring ? <Ring value={t.ring[0]} max={t.ring[1]} /> : <Icon name={t.icon} />}</span>
            <div className="stat-value">{t.value}</div>
            <div className="hud">{t.label}</div>
          </div>
        )) : Array.from({ length: 8 }, (_, i) => <div className="stat sk" key={i} style={{ height: 128 }} />)}
      </div>

      <div className="upload-pair">
        <form className="panel neu" onSubmit={saveName}>
          <h2 className="panel-title">Display name</h2>
          <p className="panel-sub">Shown on your account. Your email stays your login.</p>
          <label className="field">
            <span className="field-label">Name</span>
            <input type="text" maxLength={80} required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy === 'name'}>Save name</button>
          <p className={`form-msg ${nameMsg.kind}`} role="status">{nameMsg.text}</p>
        </form>

        <form className="panel neu" onSubmit={savePassword}>
          <h2 className="panel-title">Password</h2>
          <p className="panel-sub">You stay signed in on this device after changing it.</p>
          <label className="field">
            <span className="field-label">Current password</span>
            <input type="password" autoComplete="current-password" required value={pw.currentPassword}
                   onChange={(e) => setPw((p) => ({ ...p, currentPassword: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">New password</span>
            <input type="password" autoComplete="new-password" minLength={8} required placeholder="At least 8 characters"
                   value={pw.newPassword} onChange={(e) => setPw((p) => ({ ...p, newPassword: e.target.value }))} />
          </label>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy === 'pw'}>Change password</button>
          <p className={`form-msg ${pwMsg.kind}`} role="status">{pwMsg.text}</p>
        </form>
      </div>
    </>
  );
}
