import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, type LegalSection } from '../../components/legal-page';
import { PRIVACY_VERSION } from '../../src/web/legal';

export const metadata: Metadata = { title: 'Política de Privacidad · Velsuno' };

/*
 * Base text for professional legal review (docs/legal/README.md: LEGAL REVIEW REQUIRED BEFORE PRODUCTION).
 * Every statement must match the code: tables in supabase/migrations, src/ai/sanitize.ts (secrets removed),
 * images never stored, message bodies not stored, conversation kept to the last 40 messages, cookies below.
 */
const P = ({ children }: { children: React.ReactNode }) => <p>{children}</p>;

const SECTIONS: LegalSection[] = [
  { id: 'responsable', title: 'Responsable del tratamiento', body: <>
    <P>[RAZÓN SOCIAL — por completar], con RUC [RUC — por completar] y domicilio en [DOMICILIO — por completar], es responsable de tus datos personales en Velsuno. Tratamos tus datos conforme a la Ley N.º 29733, Ley de Protección de Datos Personales, y su Reglamento. Contacto de privacidad: [CORREO DE PRIVACIDAD — por completar].</P>
  </> },
  { id: 'datos', title: 'Qué datos tratamos', body: <>
    <ul>
      <li><strong>Cuenta y perfil:</strong> correo electrónico, nombre y apellidos, número de celular, fecha de nacimiento (para confirmar que eres mayor de edad) y tu contraseña, que se guarda cifrada por nuestro proveedor de autenticación; nosotros no la vemos.</li>
      <li><strong>Consentimientos:</strong> la versión de los Términos y de esta Política que aceptaste y la fecha.</li>
      <li><strong>Información financiera que registras o importas:</strong> movimientos (monto, moneda, fecha, comercio, categoría), cuentas y tarjetas identificadas solo por sus últimos 4 dígitos, saldos, ingresos esperados, pagos, deudas, presupuestos, planes y tus decisiones sobre sugerencias.</li>
      <li><strong>Mensajes bancarios que pegas o reenvías:</strong> usamos el texto para crear el movimiento y guardamos los datos extraídos y su origen (canal, fecha); no guardamos el texto completo del mensaje.</li>
      <li><strong>Conversaciones con Vels:</strong> guardamos los mensajes recientes (hasta 40) para darte contexto. Puedes borrarlos con «Limpiar conversación».</li>
      <li><strong>Imágenes:</strong> si envías una foto o captura para leer un dato, la procesamos en ese momento y no la almacenamos; solo conservamos una huella técnica para no cobrarte dos veces la misma lectura.</li>
      <li><strong>Datos técnicos y de seguridad:</strong> registros de inicio de sesión y de uso que generan nuestros proveedores (por ejemplo, fecha, dirección IP y navegador), un historial de cambios de tus movimientos para auditoría y el registro de uso de funciones con IA (cantidad y costo, no el contenido).</li>
    </ul>
  </> },
  { id: 'nunca', title: 'Lo que nunca te pedimos ni guardamos', body: <>
    <P>Claves de tu banca por internet, PIN, CVV, códigos OTP o de verificación, ni el número completo de tus tarjetas. Si escribes alguno por error en una conversación, lo eliminamos antes de guardar o procesar el texto. Si aparece en una imagen, la imagen no se guarda.</P>
  </> },
  { id: 'finalidades', title: 'Para qué usamos tus datos', body: <>
    <ul>
      <li>Crear y proteger tu cuenta, verificar tu correo y tu edad.</li>
      <li>Darte el servicio: ordenar tus movimientos, evitar duplicados, calcular tu dinero libre, recordarte pagos y responder tus preguntas.</li>
      <li>Seguridad, prevención de fraude y cumplimiento de obligaciones legales.</li>
      <li>Mejorar el servicio con información agregada que no te identifica.</li>
    </ul>
    <P>No vendemos tus datos ni los usamos para publicidad. No te enviaremos comunicaciones comerciales sin tu consentimiento separado.</P>
  </> },
  { id: 'base', title: 'Base para tratar tus datos', body: <>
    <P>Tratamos tus datos para ejecutar la relación que aceptas al crear tu cuenta (los Términos), con tu consentimiento cuando la ley lo exige y para cumplir obligaciones legales. [Revisar con asesoría legal la base aplicable a cada finalidad y el registro del banco de datos ante la Autoridad Nacional de Protección de Datos Personales.]</P>
  </> },
  { id: 'proveedores', title: 'Proveedores que nos ayudan', body: <>
    <ul>
      <li><strong>Supabase</strong>: base de datos y autenticación (servidores en Estados Unidos).</li>
      <li><strong>Vercel</strong>: alojamiento y entrega de la aplicación.</li>
      <li><strong>Proveedor de correo</strong>: envío de correos de acceso y seguridad ([PROVEEDOR DE CORREO — por completar]).</li>
      <li><strong>Proveedores de inteligencia artificial</strong> (cuando la función está activa, por ejemplo OpenRouter, Google o DeepSeek): reciben solo el texto o la imagen necesarios para responder, sin claves ni números completos de tarjeta.</li>
      <li><strong>Proveedor de pagos</strong>: hoy no realizamos cobros; si se incorpora, lo indicaremos aquí ([PROVEEDOR DE PAGOS — por completar]).</li>
    </ul>
    <P>Estos proveedores tratan los datos por encargo nuestro y con medidas de seguridad. Algunos están fuera del Perú, por lo que tus datos pueden transferirse al extranjero con las garantías que exige la ley.</P>
  </> },
  { id: 'conservacion', title: 'Cuánto tiempo los conservamos', body: <>
    <P>Mientras tengas una cuenta. Si dejas el plan Plus, no borramos tu información. Si eliminas tu cuenta desde Ajustes, borramos tus datos de nuestra base de datos; las copias de seguridad de nuestros proveedores, si existen, se eliminan en sus plazos habituales. Podemos conservar lo que la ley nos obligue a mantener.</P>
  </> },
  { id: 'seguridad', title: 'Cómo protegemos tus datos', body: <>
    <P>Conexiones cifradas, contraseñas cifradas por el proveedor de autenticación, separación estricta en la base de datos para que cada persona vea solo sus datos, acceso mínimo para nuestros sistemas, y registros de seguridad sin contraseñas ni enlaces de acceso. Ninguna medida es infalible: si ocurre un incidente que te afecte, te lo informaremos según la ley.</P>
  </> },
  { id: 'derechos', title: 'Tus derechos', body: <>
    <P>Puedes acceder a tus datos, rectificarlos, cancelarlos (eliminarlos), oponerte a su tratamiento y revocar tu consentimiento cuando corresponda. Desde la app puedes descargar tus movimientos (Ajustes → Descargar mis movimientos), corregir tu información y eliminar tu cuenta. Para otras solicitudes, escríbenos al contacto de privacidad. Si no quedas conforme, puedes acudir a la Autoridad Nacional de Protección de Datos Personales.</P>
  </> },
  { id: 'cookies', title: 'Cookies y almacenamiento en tu navegador', body: <>
    <P>Usamos solo lo necesario para que la app funcione: cookies de sesión para mantenerte conectado, una cookie temporal para completar el acceso desde un enlace de correo (dura 1 hora) y una cookie con tu preferencia de tema claro u oscuro. No usamos cookies de publicidad ni de seguimiento de terceros.</P>
  </> },
  { id: 'menores', title: 'Menores de edad', body: <>
    <P>Velsuno es solo para mayores de 18 años. Verificamos la fecha de nacimiento al registrarte. Si sabemos que una cuenta pertenece a un menor, la eliminaremos.</P>
  </> },
  { id: 'cambios', title: 'Cambios a esta Política', body: <>
    <P>Publicaremos cada nueva versión con su fecha. Si el cambio es importante, te lo diremos y, cuando corresponda, te pediremos aceptarlo de nuevo. También puedes revisar los <Link href="/terminos">Términos y Condiciones</Link>.</P>
  </> },
];

export default function Privacy() {
  return (
    <LegalPage title="Política de Privacidad" version={PRIVACY_VERSION} sections={SECTIONS}
      intro={<p>Aquí explicamos qué datos usa Velsuno, para qué, con quién los compartimos y cómo puedes ejercer tus derechos.</p>} />
  );
}
