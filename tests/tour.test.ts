import { describe, expect, it } from 'vitest';
import { clampStep, placeBubble, TOUR_STEPS } from '../src/web/tour';

const bubble = { width: 320, height: 200 };

describe('tour steps', () => {
  it('covers the eight places in order, each with a real target and a short text', () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual(['summary', 'available', 'movements', 'upcoming', 'cards', 'analysis', 'savings', 'vels']);
    for (const s of TOUR_STEPS) {
      expect(s.targets.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
      // Every step can fall back to a navigation entry that exists on desktop or mobile.
      expect(s.targets.some((t) => t.startsWith('.sidebar nav a[href=') || t.startsWith('.bottom-nav a[href='))).toBe(true);
    }
  });
  it('points mobile users to Más only for what lives there', () => {
    for (const id of ['upcoming', 'cards', 'analysis']) {
      const s = TOUR_STEPS.find((x) => x.id === id)!;
      expect(s.targets.at(-1)).toBe('.bottom-nav a[href="/app/mas"]');
      expect(s.via?.from).toBe(s.targets.length - 1);
    }
  });
  it('shows what can be said to Vels', () => {
    const v = TOUR_STEPS.at(-1)!;
    expect(v.examples).toContain('Pago Netflix el día 15.');
    expect(v.examples).toHaveLength(6);
  });
  it('keeps the stored step in range', () => {
    expect(clampStep(null)).toBe(0);
    expect(clampStep(Number.NaN)).toBe(0);
    expect(clampStep(-3)).toBe(0);
    expect(clampStep(3)).toBe(3);
    expect(clampStep(99)).toBe(TOUR_STEPS.length - 1);
  });
});

describe('bubble placement', () => {
  const desktop = { width: 1280, height: 800, bottomInset: 0 };
  const phone = { width: 390, height: 844, bottomInset: 72 };

  it('desktop: beside a sidebar item, arrow at its middle', () => {
    const p = placeBubble({ top: 300, left: 16, width: 220, height: 44 }, bubble, desktop);
    expect(p.side).toBe('right');
    expect(p.left).toBe(16 + 220 + 14);
    expect(p.top + p.arrow).toBe(322);
  });
  it('mobile: above a bottom-nav tab, never over the navigation, inside the screen', () => {
    const p = placeBubble({ top: 780, left: 160, width: 70, height: 60 }, { width: 366, height: 220 }, phone);
    expect(p.side).toBe('above');
    expect(p.top + 220).toBeLessThanOrEqual(844 - 72);
    expect(p.left).toBeGreaterThanOrEqual(12);
    expect(p.left + 366).toBeLessThanOrEqual(390 - 12);
  });
  it('mobile: below a wide card near the top', () => {
    const p = placeBubble({ top: 120, left: 10, width: 370, height: 180 }, { width: 366, height: 200 }, phone);
    expect(p.side).toBe('below');
    expect(p.top).toBe(120 + 180 + 14);
  });
  it('a tall card: the bubble stays on screen and clear of the navigation', () => {
    const p = placeBubble({ top: 60, left: 10, width: 370, height: 700 }, { width: 366, height: 200 }, phone);
    expect(p.top).toBeGreaterThanOrEqual(12);
    expect(p.top + 200).toBeLessThanOrEqual(844 - 72 - 12);
  });
  it('no element: centred, no arrow', () => {
    const p = placeBubble(null, bubble, desktop);
    expect(p.side).toBe('center');
    expect(p.left).toBe((1280 - 320) / 2);
  });
});
