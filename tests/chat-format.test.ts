import { describe, expect, it } from 'vitest';
import { formatVels } from '../src/web/chat-format';

describe('Vels messages: line breaks, never one dense block', () => {
  it('keeps explicit line breaks (the work explanation stays three lines)', () => {
    const t = 'Dependiente: trabajas para una empresa y recibes un sueldo.\nIndependiente: trabajas por tu cuenta, tienes un negocio o recibes ingresos por tus servicios.\n¿Con cuál te identificas más?';
    expect(formatVels(t)).toBe(t);
    expect(formatVels(t).split('\n')).toHaveLength(3);
  });
  it('puts the question on its own line after a statement', () => {
    expect(formatVels('Listo, S/ 1,200 de alquiler. ¿Qué día pagas el alquiler?')).toBe('Listo, S/ 1,200 de alquiler.\n¿Qué día pagas el alquiler?');
    expect(formatVels('Anotado: sueldo, S/ 3,500, días 15 y 30. ¿Tienes algún otro ingreso aparte de tu sueldo?')).toBe('Anotado: sueldo, S/ 3,500, días 15 y 30.\n¿Tienes algún otro ingreso aparte de tu sueldo?');
  });
  it('a one-word lead stays with its question; amounts and abbreviations never split', () => {
    expect(formatVels('Perfecto. ¿Cuánto recibes de sueldo al mes?')).toBe('Perfecto. ¿Cuánto recibes de sueldo al mes?');
    expect(formatVels('Entiendo. ¿En qué fechas te pagan?')).toBe('Entiendo. ¿En qué fechas te pagan?');
    expect(formatVels('Debes S/ 1,200.50 aprox. hasta el 25.')).toBe('Debes S/ 1,200.50 aprox. hasta el 25.');
  });
  it('a long message with several ideas shows one per line', () => {
    const t = 'Tienes S/ 3,000 y separé S/ 1,279.20 para lo que viene hasta el 4 de noviembre. Por eso quedan S/ 1,720.80. Esto no incluye tu tarjeta porque no tiene fecha de pago.';
    expect(formatVels(t).split('\n')).toHaveLength(3);
  });
});
