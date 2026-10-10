import { fold } from './text';

/**
 * Vels's social side: greetings, "¿cómo estás?", thanks, "¿qué puedes hacer?" and follow-ups to what Vels itself
 * just said. Answered here, deterministically and briefly, before any financial logic runs, so a social message
 * never reaches the engine and never comes back with numbers, menus or an extra question.
 * Voice: calm, warm, close and adult; few words; feminine only through style ("lista"), never by declaring it.
 */
export type Social = 'greeting' | 'how' | 'how_reply' | 'thanks' | 'ack' | 'bye' | 'capabilities' | 'follow_up' | 'open_order' | 'open_spending';

/** Pick one phrasing without randomness: the same thread position always gives the same line (testable). */
export const pick = <T>(options: readonly T[], seed: number): T => options[Math.abs(seed) % options.length]!;

const GREETING = /^(h|hola+|holi|hey|buenas?|buen(os)? (dias?|tardes|noches)|que tal|alo|ola)( vels| velsuno)?$/;
const HOW = /^(como (estas|andas|vas|te va|te sientes)|que tal (estas|vas|todo|tu dia)|como va todo)( vels)?( y tu)?$/;
const THANKS = /^(muchas )?(gracias|grax|thanks|thank you|mil gracias)( vels)?( por (todo|la ayuda))?$/;
const ACK = /^(ok|okay|oki|okey|listo|ya|ya veo|si|dale|perfecto|genial|bien|entendido|chevere|de acuerdo|claro|vale|bacan|ya entendi)$/;
const BYE = /^(chau|chao|adios|nos vemos|hasta (luego|manana|pronto)|bye)( vels)?$/;
const CAPABILITIES = /^(ayuda|help|que (puedes|sabes) hacer|en que (me )?(puedes|podrias) ayudar|que haces|para que sirves)( vels)?$/;
const FOLLOW_UP = /^(y )?(por que|porque|y eso|como asi|en serio|de verdad|o sea|a que te refieres|que quieres decir)( todo (bien|en orden))?$/;
const HOW_REPLY = /^(yo )?(bien|muy bien|todo bien|mas o menos|ahi|ahi nomas|regular|mal|cansad[oa]|preocupad[oa]|estresad[oa]|tranquil[oa])( gracias)?( y tu)?$/;
const OPEN_ORDER = /^(quiero|necesito|me gustaria|ayudame a) (ordenar|organizar|controlar) (mis|mi) (gastos|finanzas|plata|dinero|cuentas)$/;
const OPEN_SPENDING = /^(estoy|ando) gastando (mucho|demasiado|un monton)$|^gasto (mucho|demasiado)$/;

/** Social kind of a message, given what Vels said last (a follow-up only makes sense after a social line). */
export function socialKind(message: string, lastVelsSocial: Social | null): Social | null {
  const t = fold(message).replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (lastVelsSocial === 'how' && HOW_REPLY.test(t)) return 'how_reply';
  if (lastVelsSocial && FOLLOW_UP.test(t)) return 'follow_up';
  if (GREETING.test(t)) return 'greeting';
  if (HOW.test(t)) return 'how';
  if (THANKS.test(t)) return 'thanks';
  if (BYE.test(t)) return 'bye';
  if (CAPABILITIES.test(t)) return 'capabilities';
  if (OPEN_ORDER.test(t)) return 'open_order';
  if (OPEN_SPENDING.test(t)) return 'open_spending';
  if (ACK.test(t)) return 'ack';
  return null;
}

const OPENERS = ['¿Qué ordenamos hoy?', '¿Qué vemos hoy?', '¿Por dónde empezamos?', 'Cuéntame, ¿qué quieres revisar?'];
/** Only a short, plain first name goes into a greeting (it is the person's own profile text, still checked). */
const safeName = (name: string | null | undefined) => (name && /^[\p{L}' -]{1,30}$/u.test(name.trim()) ? name.trim() : null);

/**
 * Greeting at the start of a conversation: "Hola, Mauro. ¿Qué vemos hoy?". The name goes only here, never on
 * every turn; without a name, "Hola. ¿Qué vemos hoy?". Never "¿Cómo puedo ayudarte?" or "Bienvenido".
 */
export function greeting(name: string | null | undefined, seed: number): string {
  const n = safeName(name);
  return `Hola${n ? `, ${n}` : ''}. ${pick(OPENERS, seed)}`;
}

/** The reply. No figures, no lists, at most one short question; `seed` varies the wording along the thread. */
export function socialReply(kind: Social, message: string, seed: number, name: string | null = null): { text: string; link?: { label: string; href: string } } {
  const t = fold(message);
  switch (kind) {
    case 'greeting': return { text: greeting(name, seed) };
    case 'how': return { text: pick(['Todo en orden por aquí. ¿Y tú?', 'Bien por aquí. ¿Y tú?', 'Aquí, lista para ayudarte. ¿Y tú?'], seed) };
    case 'how_reply': return { text: /\b(mal|cansad|preocupad|estresad|regular|mas o menos)/.test(t) ? 'Vaya. Si algo de tu dinero te preocupa, lo vemos con calma.' : pick(['Me alegra.', 'Qué bueno.'], seed) };
    case 'follow_up': return { text: pick(['Solo una forma de decir que estoy lista para ayudarte.', 'Es una forma de decir que todo está en orden por aquí.'], seed) };
    case 'thanks': return { text: pick(['De nada.', 'Con gusto.', 'Para eso estoy.'], seed) };
    case 'ack': return { text: pick(['Bien.', 'Listo.', 'Aquí estoy si necesitas algo.'], seed) };
    case 'bye': return { text: pick(['Hasta luego.', 'Nos vemos.'], seed) };
    case 'capabilities': return { text: 'Puedo ayudarte a ver cuánto tienes disponible, qué pagos vienen, si te alcanza para algo o cómo ordenar tus deudas.' };
    case 'open_order': return { text: 'Claro. ¿Por dónde quieres empezar? Podemos empezar por lo que tienes disponible ahora.' };
    case 'open_spending': return { text: 'Sí, lo vemos. ¿Quieres revisar en qué se está yendo más?', link: { label: 'Ver en qué gasto', href: '/app/analisis' } };
  }
}
