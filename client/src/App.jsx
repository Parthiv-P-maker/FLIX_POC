import { useEffect } from 'react';
import { useApp } from './store.jsx';
import { isTyping } from './lib/format.js';
import AuthScreen from './views/AuthScreen.jsx';
import Sidebar, { MobileNav } from './components/Sidebar.jsx';
import Toast from './components/Toast.jsx';
import UploadTray from './components/UploadTray.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Player from './player/Player.jsx';
import Watch from './views/Watch.jsx';
import Browse from './views/Browse.jsx';
import Photos from './views/Photos.jsx';
import Upload from './views/Upload.jsx';
import Profile from './views/Profile.jsx';

const VIEW_COMPONENTS = { watch: Watch, browse: Browse, photos: Photos, upload: Upload, profile: Profile };

export default function App() {
  const { user, booting, view, setPaletteOpen, paletteOpen, player } = useApp();

  // Ctrl/Cmd+K toggles the palette from anywhere, even mid-typing: it is the
  // one shortcut people expect to always work. "/" opens it when nothing
  // else wants the key.
  useEffect(() => {
    if (!user) return undefined;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (e.key === '/' && !paletteOpen && !player && !isTyping(e.target) &&
                 !document.querySelector('.overlay')) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [user, paletteOpen, player, setPaletteOpen]);

  if (booting) {
    return (
      <div className="boot" aria-busy="true">
        <span className="logo-mark logo-mark-lg">FD</span>
        <span className="spinner" aria-hidden="true" />
      </div>
    );
  }

  if (!user) return <><AuthScreen /><Toast /></>;

  const View = VIEW_COMPONENTS[view] || Watch;

  return (
    <>
      <div className="shell">
        <Sidebar />
        <main className="content" id="main">
          {/* key: each view animates in on switch, and starts with fresh state. */}
          <div className="view" key={view}>
            <View />
          </div>
        </main>
        <MobileNav />
      </div>
      {player && <Player key={player.key} />}
      {paletteOpen && <CommandPalette />}
      <UploadTray />
      <Toast />
    </>
  );
}
