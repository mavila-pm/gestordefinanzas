import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, type LegalSection } from '../../components/legal-page';
import { TERMS_VERSION } from '../../src/web/legal';

export const metadata: Metadata = { title: 'Términos y Condiciones · Velsuno' };

/*
 * Base text for professional legal review (docs/legal/README.md: LEGAL REVIEW REQUIRED BEFORE PRODUCTION).
 * Bracketed fields are decisions or data the Product Owner must complete; never invent them.
 * Keep every statement true to what the code does (registration 18+, Free/trial/Plus, no payments, no bank access).
 */
const P = ({ children }: { children: React.ReactNode }) => <p>{children}</p>;

const SECTIONS: LegalSection[] = [
  { id: 'servicio', title: 'Quiénes somos y qué es Velsuno', body: <>
    <P>Velsuno es un servicio digital de organización de finanzas personales ofrecido por [RAZÓN SOCIAL — por completar], con RUC [RUC — por completar] y domicilio en [DOMICILIO — por completar] («Velsuno», «nosotros»).</P>
    <P>Velsuno te ayuda a registrar y ordenar tus movimientos, entender en qué se va tu dinero, planificar pagos y estimar cuánto puedes usar hasta tu próximo ingreso. Incluye Vels, un asistente que responde preguntas sobre tu información dentro de la aplicación.</P>
  </> },
  { id: 'aceptacion', title: 'Aceptación de estos términos', body: <>
    <P>Al crear tu cuenta y marcar la casilla de aceptación, aceptas estos Términos y declaras haber leído la <Link href="/privacidad">Política de Privacidad</Link>. Guardamos la versión que aceptaste y la fecha. Si no estás de acuerdo, no uses Velsuno.</P>
  </> },
  { id: 'elegibilidad', title: 'Quién puede usar Velsuno', body: <>
    <P>Velsuno es solo para personas mayores de 18 años. Al registrarte nos indicas tu fecha de nacimiento y verificamos la edad; no completamos el registro si no cumples este requisito.</P>
    <P>La cuenta es personal. No puedes registrar datos financieros de otras personas sin su autorización.</P>
  </> },
  { id: 'cuenta', title: 'Tu cuenta y su seguridad', body: <>
    <P>Para usar Velsuno debes verificar tu correo, crear una contraseña y completar tu perfil. Te pedimos que la información que nos des sea verdadera y que la mantengas actualizada.</P>
    <P>Eres responsable de mantener segura tu contraseña y el acceso a tu correo y a tus dispositivos. Avísanos si crees que alguien entró a tu cuenta. Velsuno nunca te pedirá la clave de tu banco, tu PIN, el CVV de tu tarjeta ni códigos de verificación (OTP).</P>
  </> },
  { id: 'informacion', title: 'Información financiera que registras o importas', body: <>
    <P>Velsuno funciona con la información que tú registras, la que pegas o reenvías desde mensajes de tu banco y la que nos indicas en conversación. No tenemos acceso a tus cuentas bancarias ni movemos dinero.</P>
    <P>Esa información puede estar incompleta, llegar con retraso o contener errores del remitente. Cuando un dato es dudoso lo marcamos para que lo revises («por revisar»), y los valores aproximados se muestran como «estimado». Revisa siempre la información oficial de tu banco antes de tomar decisiones.</P>
  </> },
  { id: 'vels', title: 'Vels, automatización e inteligencia artificial', body: <>
    <P>Vels te ayuda a organizar, interpretar y simular tu información financiera. Los montos los calcula Velsuno con reglas fijas a partir de tus datos; cuando una función usa inteligencia artificial, esta solo ayuda a interpretar lo que escribes o lo que muestra una imagen, y Velsuno valida el resultado antes de usarlo.</P>
    <P>Las respuestas dependen de los datos disponibles y pueden ser incompletas o equivocarse. Las simulaciones («¿y si…?», «¿puedo gastar…?») son ejemplos sobre una copia de tus datos: no ejecutan pagos ni cambian nada en tu banco. Vels no controla tus cuentas ni garantiza resultados financieros. Antes de guardar algo que Vels propone, te pedimos confirmación.</P>
  </> },
  { id: 'asesoria', title: 'Velsuno no es asesoría profesional', body: <>
    <P>Velsuno es una herramienta de organización. No brinda asesoría financiera, de inversión, tributaria, contable ni legal, y no reemplaza a un profesional. Las decisiones sobre tu dinero son tuyas y las tomas bajo tu responsabilidad.</P>
  </> },
  { id: 'terceros', title: 'Bancos, correos y otros terceros', body: <>
    <P>Velsuno no está afiliado a los bancos o entidades cuyos nombres aparecen en tus movimientos. Los mensajes, correos y datos de terceros pueden cambiar de formato o dejar de enviarse; en ese caso algunas funciones pueden dejar de reconocerlos automáticamente.</P>
    <P>Usamos proveedores para alojar la aplicación, la base de datos, enviar correos y, cuando corresponda, funciones de inteligencia artificial. Sus nombres y funciones están en la Política de Privacidad.</P>
  </> },
  { id: 'planes', title: 'Planes Free, prueba y Plus', body: <>
    <P>El plan Free es gratuito. Algunas funciones son parte del plan Plus, que puedes probar gratis durante el período indicado en la app, sin tarjeta. Al terminar la prueba vuelves a Free automáticamente y no perdemos tus datos.</P>
    <P>Hoy Velsuno no realiza cobros. Cuando el plan Plus tenga precio, te informaremos antes el precio, la periodicidad, la renovación, la forma de cancelar y la política de reembolsos ([POLÍTICA DE COBROS Y REEMBOLSOS — por completar]). Nunca te cobraremos sin tu consentimiento expreso.</P>
  </> },
  { id: 'propiedad', title: 'Propiedad intelectual y licencia de uso', body: <>
    <P>Velsuno, su marca, diseño y software nos pertenecen o tenemos derecho a usarlos. Te damos una licencia personal, limitada, no exclusiva e intransferible para usar la aplicación según estos Términos. Tu información sigue siendo tuya.</P>
  </> },
  { id: 'uso', title: 'Uso aceptable', body: <>
    <P>No puedes: usar Velsuno para actividades ilegales o fraudulentas; intentar acceder a cuentas o datos de otras personas; vulnerar o probar la seguridad del servicio sin autorización; automatizar el acceso de forma abusiva; copiar, revender o descompilar el software; ni enviar contenido que dañe el servicio o a terceros.</P>
  </> },
  { id: 'disponibilidad', title: 'Disponibilidad, cambios y errores', body: <>
    <P>Velsuno se encuentra en etapa beta. Trabajamos para que funcione bien, pero puede tener interrupciones, errores o cambios. Podemos modificar, agregar o retirar funciones; si un cambio es importante para ti, te avisaremos con anticipación razonable.</P>
  </> },
  { id: 'terminacion', title: 'Suspensión y cierre de la cuenta', body: <>
    <P>Puedes dejar de usar Velsuno y eliminar tu cuenta desde Ajustes en cualquier momento. Podemos suspender o cerrar una cuenta que incumpla estos Términos o que ponga en riesgo el servicio o a otras personas, informándote cuando sea posible.</P>
  </> },
  { id: 'responsabilidad', title: 'Limitación de responsabilidad', body: <>
    <P>En la medida permitida por la ley aplicable, Velsuno no responde por decisiones tomadas con base en información incompleta o incorrecta proporcionada por ti o por terceros, ni por daños indirectos derivados del uso del servicio. Nada de lo indicado limita los derechos que la ley de protección al consumidor u otras normas te reconocen y que no pueden excluirse.</P>
    <P>Si la ley lo permite, responderás frente a Velsuno por los daños que cause un uso tuyo contrario a estos Términos.</P>
  </> },
  { id: 'fuerza-mayor', title: 'Fuerza mayor', body: <>
    <P>No seremos responsables por incumplimientos causados por hechos fuera de nuestro control razonable, como fallas generales de internet, de proveedores o desastres naturales.</P>
  </> },
  { id: 'comunicaciones', title: 'Comunicaciones', body: <>
    <P>Te escribiremos al correo verificado de tu cuenta para temas de acceso, seguridad y cambios relevantes del servicio. No te enviaremos publicidad sin tu consentimiento.</P>
  </> },
  { id: 'cambios', title: 'Cambios a estos Términos', body: <>
    <P>Si cambiamos estos Términos publicaremos una nueva versión con su fecha. Si el cambio es importante, te pediremos aceptarlo de nuevo antes de seguir usando Velsuno.</P>
  </> },
  { id: 'ley', title: 'Ley aplicable y controversias', body: <>
    <P>Estos Términos se rigen por las leyes de la República del Perú. [JURISDICCIÓN Y MECANISMO DE SOLUCIÓN DE CONTROVERSIAS — por definir con asesoría legal.] Esto no impide que acudas a las autoridades de protección al consumidor que correspondan.</P>
  </> },
];

export default function Terms() {
  return (
    <LegalPage title="Términos y Condiciones" version={TERMS_VERSION} sections={SECTIONS}
      intro={<p>Estas son las reglas para usar Velsuno. Las escribimos en lenguaje simple; si algo no queda claro, escríbenos.</p>} />
  );
}
