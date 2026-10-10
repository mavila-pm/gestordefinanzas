import { logout } from '../../auth/actions';
import { SettingsNav } from '../../../components/settings-client';

/** Ajustes: sections on the left (desktop) and the chosen one on the right; on mobile each section is its own screen. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="settings-shell">
      <aside className="settings-desktop-only" aria-label="Ajustes">
        <p className="caption" style={{ padding: '0 12px 8px' }}>Ajustes</p>
        <SettingsNav variant="sidebar" />
        <form action={logout} style={{ padding: '12px 12px 0' }}><button type="submit" className="link" style={{ paddingLeft: 0 }}>Cerrar sesión</button></form>
      </aside>
      {children}
    </div>
  );
}
