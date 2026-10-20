import { describe, expect, it } from 'vitest';
import { decodeEntities, toPlainText } from '../src/ingestion/sanitize';
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
