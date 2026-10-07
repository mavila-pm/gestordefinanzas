import type { Metadata } from 'next';
import { LegalPage } from '../../components/legal-page';

export const metadata: Metadata = { title: 'Privacidad · Velsuno' };

/** Describes what the code actually stores and sends (keep in sync with migrations, src/ai/sanitize.ts and lib/ai.ts). */
export default function Privacy() {
  return (
    <LegalPage title="Política de privacidad">
      <p>Velsuno es una app de finanzas personales. Tratamos tus datos según la Ley N.º 29733, Ley de Protección de Datos
        Personales del Perú, y su reglamento.</p>

      <h2>Qué datos guardamos</h2>
      <ul>
        <li>Tu cuenta: correo y, si lo indicas, tu nombre.</li>
        <li>Tus finanzas: movimientos (monto, moneda, fecha, comercio, categoría), cuentas y tarjetas (solo los últimos 4 dígitos),
          saldos, ingresos, pagos, deudas y presupuestos que registras o importas.</li>
        <li>De los mensajes bancarios que pegas o reenvías guardamos los datos del movimiento y su origen (canal, fecha);
          no guardamos el texto completo del mensaje.</li>
        <li>Tus conversaciones con Vels y el uso de funciones con IA (cantidad, no el contenido de las imágenes).</li>
      </ul>

      <h2>Qué nunca guardamos</h2>
      <p>Claves del banco, PIN, CVV, códigos OTP ni el número completo de tu tarjeta. Si los escribes por error en una
        conversación con Vels, los quitamos antes de guardar o procesar el texto. Las fotos que envías para leer un dato no se almacenan.</p>

      <h2>Para qué los usamos</h2>
      <p>Solo para darte el servicio: ordenar tus movimientos, calcular tu dinero libre, avisarte de pagos y responder tus preguntas.
        No vendemos tus datos ni los usamos para publicidad.</p>

      <h2>Con quién se comparten</h2>
      <ul>
        <li>Proveedores de infraestructura que alojan la app y la base de datos (Supabase y Vercel).</li>
        <li>Si usas funciones con IA, un proveedor de modelos de lenguaje recibe el texto necesario para responderte, sin claves ni
          números completos de tarjeta.</li>
      </ul>
      <p>Cada persona solo puede ver sus propios datos: el aislamiento se aplica en la base de datos, no solo en la pantalla.</p>

      <h2>Tus derechos</h2>
      <p>Puedes acceder a tus datos y exportarlos (Movimientos → Exportar), corregirlos desde la app y pedir su cancelación
        u oposición escribiéndonos. Si no recibes respuesta, puedes acudir a la Autoridad Nacional de Protección de Datos Personales.</p>

      <h2>Cuánto tiempo</h2>
      <p>Guardamos tus datos mientras tengas una cuenta. Si dejas el plan Plus, no borramos tu información financiera.
        Si pides cerrar tu cuenta, eliminamos tus datos salvo lo que la ley nos obligue a conservar.</p>
    </LegalPage>
  );
}
