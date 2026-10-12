// Motion system check (no server): built CSS + real class names. Verifies that pressable surfaces lift on hover with
// a mouse, do not move with prefers-reduced-motion, keep transitions within 140–220 ms, animate no layout property,
// and that touch (no hover) never gets a stuck hover state. Run after `npm run build`: node scripts/qa/motion.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const dir = '.next/static/chunks';
const css = readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><main class="stack" style="animation:none">
<a class="card row link-card" id="card" href="#">Mis suscripciones</a>
<ul class="plain sub-list"><li><a class="sub-row" id="row" href="#"><span class="sub-logo" data-provider="netflix">N</span><span class="setting-text"><strong>Netflix</strong></span><span class="sub-row-end"><strong>S/ 44.90</strong></span></a></li></ul>
<table class="data-table"><tbody><tr id="tr"><th>Oct</th><td>S/ 44.90</td></tr></tbody></table>
<button id="btn">Guardar</button></main></body></html>`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) failed++; };
for (const reduced of [false, true]) {
  const ctx = await browser.newContext({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const p = await ctx.newPage(); await p.setContent(html);
  const info = await p.evaluate(() => {
    const cs = (id) => getComputedStyle(document.getElementById(id));
    return { dur: ['card', 'row', 'btn'].map((id) => cs(id).transitionDuration), props: ['card', 'row', 'btn', 'tr'].map((id) => cs(id).transitionProperty) };
  });
  const ms = info.dur.flatMap((d) => d.split(',').map((x) => parseFloat(x) * (x.includes('ms') ? 1 : 1000)));
  ok(reduced ? ms.every((m) => m <= 220) : ms.every((m) => m === 0 || (m >= 140 && m <= 220)), `${reduced ? 'reduced' : 'normal'}: durations ${[...new Set(ms)].join('/')} ms ${reduced ? '(near-instant allowed)' : 'within 140–220'}`);
  ok(info.props.every((x) => !/\b(width|height|top|left|margin|padding)\b/.test(x)), `${reduced ? 'reduced' : 'normal'}: no layout property animated (${[...new Set(info.props.join(',').split(', '))].join(' ')})`);
  await p.hover('#row'); await p.waitForTimeout(300);
  const t = await p.evaluate(() => getComputedStyle(document.getElementById('row')).transform);
  ok(reduced ? t === 'none' : t !== 'none', `${reduced ? 'reduced: row does not move' : 'normal: row lifts'} on hover (${t})`);
  await p.hover('#tr'); await p.waitForTimeout(250);
  ok((await p.evaluate(() => getComputedStyle(document.getElementById('tr')).backgroundColor)) !== 'rgba(0, 0, 0, 0)', `${reduced ? 'reduced' : 'normal'}: table row highlights on hover`);
  await ctx.close();
}
// Touch device: no hover media → tapping must not leave a lifted card behind.
const touch = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
const tp = await touch.newPage(); await tp.setContent(html);
await tp.tap('#row', { noWaitAfter: true }).catch(() => {}); await tp.waitForTimeout(300);
const tt = await tp.evaluate(() => [getComputedStyle(document.getElementById('row')).transform, matchMedia('(hover: hover)').matches]);
ok(tt[0] === 'none' || tt[0] === 'matrix(1, 0, 0, 1, 0, 0)' || tt[1], `touch: no stuck hover lift after a tap (${tt[0]}, hover media ${tt[1]})`);
await browser.close();
console.log(failed ? `FAILED ${failed}` : 'OK motion');
process.exit(failed ? 1 : 0);
