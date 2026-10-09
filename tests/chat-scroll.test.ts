import { describe, expect, it } from 'vitest';
import { distanceFromBottom, isNearBottom, NEAR_BOTTOM_PX, onNewContent, velsStatus } from '../src/web/chat-scroll';

/** Scroll like a messaging app + the Vels header status (pure policy; the browser check is in tests/e2e/chat-layout.ts). */
describe('chat scroll policy', () => {
  const box = (scrollTop: number) => ({ scrollHeight: 3000, clientHeight: 600, scrollTop });
  it('near the bottom = within NEAR_BOTTOM_PX of the end', () => {
    expect(distanceFromBottom(box(2400))).toBe(0);
    expect(isNearBottom(box(2400 - NEAR_BOTTOM_PX))).toBe(true);
    expect(isNearBottom(box(1200))).toBe(false);
  });
  it('10: the reader scrolled up + an answer arrives → NOT pulled down; a jump button is offered', () => {
    expect(onNewContent({ nearBottom: false, ownSend: false, grew: true })).toBe('notify');
  });
  it('11: the person sends a message → back to the end, even if they were reading above', () => {
    expect(onNewContent({ nearBottom: false, ownSend: true, grew: true })).toBe('stick');
  });
  it('at the bottom, new messages keep the view at the end; nothing new → nothing happens', () => {
    expect(onNewContent({ nearBottom: true, ownSend: false, grew: true })).toBe('stick');
    expect(onNewContent({ nearBottom: false, ownSend: false, grew: false })).toBe('none');
  });
});

describe('Vels header status', () => {
  it('13: online → "Conectada" (Vels works even without the AI provider)', () => {
    expect(velsStatus(true, false)).toEqual({ label: 'Conectada', tone: 'ok' });
  });
  it('14: offline never says "Conectada"; back online shows "Reconectando…" first', () => {
    expect(velsStatus(false, false).label).toBe('Sin conexión');
    expect(velsStatus(false, true).label).toBe('Sin conexión');
    expect(velsStatus(true, true).label).toBe('Reconectando…');
  });
});
