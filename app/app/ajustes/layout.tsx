import { SettingsNav } from '../../../components/settings-client';
import { LogoutForm } from '../../../components/settings';

/** Ajustes: sections on the left (desktop) and the chosen one on the right; on mobile each section is its own screen. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="settings-shell">
      <aside className="settings-desktop-only" aria-label="Ajustes">
        <p className="caption" style={{ padding: '0 12px 8px' }}>Ajustes</p>
        <SettingsNav variant="sidebar" />
        <LogoutForm style={{ padding: '12px 12px 0' }} />
      </aside>
      {children}
    </div>
  );
}
