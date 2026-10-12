import Link from 'next/link';
import { SettingsPage, SettingsSection } from '../../../../components/settings';
import { restartTourAction } from '../../tour-actions';

export const metadata = { title: 'Ayuda · Ajustes' };

/** Help without a manual: the short tour of the app, and Vels for everything else. */
export default function HelpSettings() {
  return (
    <SettingsPage title="Ayuda" testId="settings-help">
      <SettingsSection title="Recorrido de la app">
        <p className="muted small">Un repaso de un minuto por Resumen, Dinero disponible, Movimientos, Próximos pagos, Tarjetas, Análisis, Ahorro y Vels.</p>
        <form action={restartTourAction}><button type="submit" className="secondary" data-testid="tour-restart">Ver el recorrido otra vez</button></form>
      </SettingsSection>
      <SettingsSection title="Pregúntale a Vels">
        <p className="muted small">Escríbele como hablas: «gano S/ 3,500 al mes», «pago Netflix el día 15», «¿me alcanza para algo de S/ 300?».</p>
        <Link href="/app/preguntar" className="button quiet">Hablar con Vels</Link>
      </SettingsSection>
    </SettingsPage>
  );
}
