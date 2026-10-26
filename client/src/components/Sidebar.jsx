import { useApp } from '../store.jsx';
import { initialsOf } from '../lib/format.js';
import Icon from './Icon.jsx';

export const NAV = [
  { view: 'watch', label: 'Watch', icon: 'watch' },
  { view: 'browse', label: 'Browse', icon: 'browse' },
  { view: 'photos', label: 'Photos', icon: 'photos' },
  { view: 'upload', label: 'Upload', icon: 'upload' },
  { view: 'profile', label: 'Profile', icon: 'profile' },
];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function Logo({ large = false }) {
  return (
    <div className={`logo${large ? ' logo-lg' : ''}`}>
      <span className="logo-mark">FD</span>
      <span className="logo-text">Flix<b>Drive</b></span>
    </div>
  );
}

export default function Sidebar() {
  const { view, go, user, setPaletteOpen, theme, toggleTheme, uploads } = useApp();
  const active = uploads.jobs.filter((j) => j.phase === 'uploading' || j.phase === 'processing').length;

  return (
    <aside className="sidebar neu">
      <Logo />

      <button className="search-trigger" type="button" onClick={() => setPaletteOpen(true)}
              aria-label="Search everything (Ctrl+K)">
        <Icon name="search" />
        <span>Search</span>
        <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>

      <nav className="nav" aria-label="Main">
        <span className="hud nav-kicker">Navigate</span>
        {NAV.map((item) => (
          <button key={item.view} type="button"
                  className={`nav-btn${view === item.view ? ' is-active' : ''}`}
                  aria-current={view === item.view ? 'page' : undefined}
                  onClick={() => go(item.view)}>
            <span className="nav-ico"><Icon name={item.icon} /></span>
            <span>{item.label}</span>
            {item.view === 'upload' && active > 0 && <span className="nav-badge">{active}</span>}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button className="theme-toggle" type="button" onClick={toggleTheme}
                aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
          <span className={`theme-opt${theme === 'dark' ? ' is-on' : ''}`}><Icon name="moon" /></span>
          <span className={`theme-opt${theme === 'light' ? ' is-on' : ''}`}><Icon name="sun" /></span>
        </button>

        <button className="user-chip" type="button" onClick={() => go('profile')}>
          <span className="avatar avatar-sm">{initialsOf(user.displayName)}</span>
          <span className="user-chip-text">
            <strong>{user.displayName}</strong>
            <small>{user.email}</small>
          </span>
        </button>
      </div>
    </aside>
  );
}

/** Bottom tab bar on phones, where a sidebar would eat the screen. */
export function MobileNav() {
  const { view, go, setPaletteOpen } = useApp();
  return (
    <nav className="mobile-nav neu" aria-label="Main">
      {NAV.filter((n) => n.view !== 'profile').map((item) => (
        <button key={item.view} type="button"
                className={`mnav-btn${view === item.view ? ' is-active' : ''}`}
                aria-current={view === item.view ? 'page' : undefined}
                onClick={() => go(item.view)}>
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </button>
      ))}
      <button type="button" className="mnav-btn" onClick={() => setPaletteOpen(true)}>
        <Icon name="search" />
        <span>Search</span>
      </button>
      <button type="button" className={`mnav-btn${view === 'profile' ? ' is-active' : ''}`}
              onClick={() => go('profile')}>
        <Icon name="profile" />
        <span>You</span>
      </button>
    </nav>
  );
}
