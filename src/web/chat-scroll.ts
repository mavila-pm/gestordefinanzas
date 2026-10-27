/**
 * Chat scroll policy (like a messaging app): the list follows new messages only while the person is at the bottom
 * or just sent something themselves; if they scrolled up to read, it stays put and a "new messages" button appears.
 * Pure (no DOM) so it can be tested.
 */
export const NEAR_BOTTOM_PX = 96;

export function distanceFromBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): number {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}

export const isNearBottom = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }) => distanceFromBottom(el) <= NEAR_BOTTOM_PX;

/** What to do when messages change: follow ('stick') or leave the reader where they are and offer a jump ('notify'). */
export function onNewContent(s: { nearBottom: boolean; ownSend: boolean; grew: boolean }): 'stick' | 'notify' | 'none' {
  if (s.ownSend || s.nearBottom) return 'stick';
  return s.grew ? 'notify' : 'none';
}

/** Connection label in the Vels header. "Conectada" is about Vels being usable, not about the AI provider. */
export function velsStatus(online: boolean, recovering: boolean): { label: 'Conectada' | 'Sin conexión' | 'Reconectando…'; tone: 'ok' | 'off' | 'wait' } {
  if (!online) return { label: 'Sin conexión', tone: 'off' };
  if (recovering) return { label: 'Reconectando…', tone: 'wait' };
  return { label: 'Conectada', tone: 'ok' };
}
