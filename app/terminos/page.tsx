import type { Metadata } from 'next';
import { LegalPage } from '../../components/legal-page';

export const metadata: Metadata = { title: 'Términos · Velsuno' };

export default function Terms() {
  return (
    <LegalPage title="Términos de uso">
      <h2>El servicio</h2>
      <p>Velsuno te ayuda a ordenar y entender tus finanzas personales a partir de lo que registras, importas o reenvías.
        Está en etapa beta: algunas funciones pueden cambiar o fallar, y te avisaremos de cambios importantes.</p>

      <h2>No es asesoría financiera</h2>
      <p>Los cálculos (como tu dinero libre) dependen de los datos que ingresas y de los mensajes de tu banco. Lo que es estimado
        se muestra como estimado. Velsuno no reemplaza la información oficial de tu banco ni una asesoría profesional.</p>

      <h2>Tu cuenta</h2>
      <ul>
        <li>Eres responsable de mantener segura tu contraseña. Nunca te pediremos la clave de tu banco.</li>
        <li>No uses Velsuno para datos de otras personas sin su permiso ni para fines ilegales.</li>
      </ul>

      <h2>Planes</h2>
      <p>El plan Free es gratuito. El plan Plus puede probarse gratis por 14 días sin tarjeta; al terminar la prueba vuelves a Free
        sin perder tus datos. Nunca cobramos sin tu consentimiento expreso.</p>

      <h2>Responsabilidad</h2>
      <p>Hacemos lo razonable para que el servicio funcione y tus datos estén protegidos, pero no garantizamos que esté libre de
        errores o interrupciones. Revisa siempre los movimientos marcados como «por revisar».</p>

      <h2>Ley aplicable</h2>
      <p>Estos términos se rigen por las leyes de la República del Perú.</p>
    </LegalPage>
  );
}
