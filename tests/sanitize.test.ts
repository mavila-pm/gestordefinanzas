import { describe, expect, it } from 'vitest';
import { decodeEntities, toPlainText } from '../src/ingestion/sanitize';
import { readLabels } from '../src/ingestion/parse-helpers';
import { bcpEmailV1 } from '../src/ingestion/adapters/bcp/bcp-email-v1';
import type { RawFinancialEvent } from '../src/domain/types';
import * as fx from './fixtures/bcp';

describe('HTML entities (fixed list, single pass)', () => {
  it('decodes the Spanish named entities, upper and lower case', () => {
    expect(decodeEntities('&aacute;&eacute;&iacute;&oacute;&uacute; &Aacute;&Eacute;&Iacute;&Oacute;&Uacute; &ntilde;&Ntilde; &uuml;&Uuml;'))
      .toBe('áéíóú ÁÉÍÓÚ ñÑ üÜ');
    expect(decodeEntities('&lt;b&gt; &quot;x&quot; &#39;y&#39; &amp; &iquest;s&iacute;?')).toBe('<b> "x" \'y\' & ¿sí?');
  });

  it('decodes decimal and hex references inside the BMP', () => {
    expect(decodeEntities('Cr&#233;dito N&#xFA;mero operaci&#XF3;n &#8364;')).toBe('Crédito Número operación €');
  });

  it('never decodes control characters, surrogates or non-BMP; unknown names stay as written', () => {
    for (const s of ['a&#10;b', 'a&#x0A;b', '&#0;', '&#127;', '&#x9F;', '&#xD800;', '&#x1F600;', '&#99999999;', '&euro;', '&bogus;']) {
      expect(decodeEntities(s)).toBe(s);
    }
  });

  it('never decodes line/paragraph separators, bidi/zero-width/format characters, private use or noncharacters', () => {
    const refs = ['&#8232;', '&#x2029;', '&#x200B;', '&#x200F;', '&#x202A;', '&#x202E;', '&#x2060;', '&#x2066;', '&#x206F;',
      '&#xFEFF;', '&#xAD;', '&#xE000;', '&#xFDD0;', '&#xFDEF;', '&#xFFFE;', '&#xFFFF;'];
    for (const r of refs) expect(decodeEntities(`a${r}b`)).toBe(`a${r}b`);
    // Visible characters still decode.
    expect(decodeEntities('&#160;&#xE9;&#8364;')).toBe('\u00A0é€');
  });

  it('is a single pass: "&amp;lt;" is "&lt;", not "<"', () => {
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });
});

describe('toPlainText', () => {
  it('drops head, title, style, script and comments; decodes after removing tags', () => {
    const html = '<html><head><title>Monto: S/ 1.00</title><style>p{}</style></head><!-- Monto: S/ 2.00 -->'
      + '<body><header>Aviso</header><p>&lt;b&gt;no es etiqueta&lt;/b&gt;</p><script>x()</script></body></html>';
    expect(toPlainText(html)).toBe('Aviso <b>no es etiqueta</b>');
  });

  it('an encoded newline cannot inject a "Label: value" line', () => {
    expect(toPlainText('Empresa: TIENDA&#10;Monto: S/ 99999.00')).toBe('Empresa: TIENDA&#10;Monto: S/ 99999.00');
  });

  it('only "\\n" ends a line: U+2028/U+2029, NEL, VT, FF become spaces; a lone CR is a line break', () => {
    expect(toPlainText('a\u2028b')).toBe('a b');
    expect(toPlainText('a\u2029b\u0085c\vd\fe')).toBe('a b c d e');
    expect(toPlainText('a&#8232;b')).toBe('a&#8232;b');
    expect(toPlainText('a\r\nb\rc')).toBe('a\nb\nc');
    expect(toPlainText('a \n \n  b')).toBe('a\nb');
  });

  it('an encoded or literal line separator cannot inject a "Label: value" line', () => {
    const labels = { merchant: /^Comercio:\s*(.+)$/gim, card: /^Tarjeta:\s*(.+)$/gim };
    for (const body of ['Comercio: TIENDA&#8232;Tarjeta: ****9999', 'Comercio: TIENDA\u2028Tarjeta: ****9999', 'Comercio: TIENDA&#8233;Tarjeta: ****9999']) {
      const r = readLabels(toPlainText(body), labels);
      expect(r).toMatchObject({ ok: true });
      expect(r.ok && r.values.card).toBeUndefined();
    }
  });

  it('literal zero-width and bidi control characters are dropped (no disguised merchant names)', () => {
    expect(toPlainText('TIE\u200BNDA \u202EADNEIT\u202C \u2066x\u2069')).toBe('TIENDA ADNEIT x');
  });

  it('pathological 64 KB inputs finish fast (no quadratic backtracking)', () => {
    const inputs = ['<!--'.repeat(16000), '<head>'.repeat(10900), '<head'.repeat(13000), '<'.repeat(65000), '<script>'.repeat(8000),
      `a${'\r'.repeat(65000)}a`, `a${' \n'.repeat(32000)}a`, `a${'\t'.repeat(65000)}\u2028`, '</title'.repeat(9000)];
    for (const body of inputs) {
      const t = performance.now();
      toPlainText(body);
      expect(performance.now() - t, `${JSON.stringify(body.slice(0, 8))} x${body.length}`).toBeLessThan(250);
    }
  });

  it('an unterminated comment or script runs to the end (as in a browser): nothing after it is read', () => {
    expect(toPlainText('Monto: S/ 1.00<!-- Monto: S/ 9.00')).toBe('Monto: S/ 1.00');
    expect(toPlainText('Aviso<script>Monto: S/ 9.00')).toBe('Aviso');
    expect(toPlainText('a<b<c>d')).toBe('a<b d');
  });

  it('&nbsp; and U+00A0 become plain spaces', () => {
    expect(toPlainText('Monto:&nbsp;S/&#160;100.00')).toBe('Monto: S/ 100.00');
  });

  it('an entity-encoded HTML BCP email parses exactly like its plain-text version', () => {
    const plain = fx.purchasePenEmail();
    const html: RawFinancialEvent = {
      ...plain,
      body: [
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Realizaste un consumo con tu Tarjeta de Cr&eacute;dito BCP</title>',
        '<style>td{padding:4px}</style></head><body>',
        '<p>Hola, CLIENTE DE PRUEBA</p>',
        '<p>Realizaste un consumo con tu Tarjeta de Cr&eacute;dito BCP.</p>',
        '<table><tr><td>Monto:</td><td>S/&nbsp;100.00</td></tr>',
        '<tr><td>Empresa:</td><td>RESTAURANTE EL EJEMPLO S.A.C.</td></tr>',
        '<tr><td>N&uacute;mero de Tarjeta de Cr&#233;dito:</td><td>************4821</td></tr>',
        '<tr><td>Fecha y hora:</td><td>15 de septiembre de 2026 - 08:30 PM</td></tr>',
        '<tr><td>N&#xFA;mero de operaci&oacute;n:</td><td>000111</td></tr></table>',
        '<p>Banco de Cr&eacute;dito del Per&uacute; - BCP</p></body></html>',
      ].join(''),
    };
    const a = bcpEmailV1.parse(plain, toPlainText(plain.body));
    const b = bcpEmailV1.parse(html, toPlainText(html.body));
    expect(a.ok).toBe(true);
    expect(b).toEqual(a);
  });
});
