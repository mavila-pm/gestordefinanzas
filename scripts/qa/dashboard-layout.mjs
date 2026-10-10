// Browser check of the Resumen dashboard layout (no server, no account): built CSS + the page's real class structure
// with SYNTHETIC figures. Asserts per width: no horizontal overflow, phone = one column in priority order,
// tablet = KPIs in one row + two columns; desktop = KPIs (2×2) beside "Dinero disponible" + two columns, wide container (not a centered phone).
// Run after `npm run build`: node scripts/qa/dashboard-layout.mjs [screenshot-dir]
import { readdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const dir = '.next/static/chunks';
const shots = process.argv[2] ?? null;
const css = readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n');
const kpi = (l, v, s) => `<div class="kpi"><span>${l}</span><strong>${v}</strong><small class="muted">${s}</small></div>`;
const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('');
const main = `<main class="dash">
<header class="home-head"><div><h1>Hola, Ana.</h1><p class="slogan">Tu dinero, más claro.</p></div><a class="button">Registrar movimiento</a></header>
<a class="notice warning review-alert"><span><strong>2 movimientos por revisar</strong><small>Confírmalos para completar tu resumen.</small></span></a>
<div class="dash-top">
 <section class="hero" data-k="hero"><div class="hero-top"><span class="label">Dinero disponible</span><span class="state">Estimado</span></div><p class="figure">S/ 820.00</p>
 <small class="until">Hasta tu próximo ingreso, el <strong>30 oct</strong> (20 días).</small>
 <div class="free-bar"><span class="seg committed" style="flex-grow:3"></span><span class="seg set-aside" style="flex-grow:1"></span><span class="seg free" style="flex-grow:2"></span></div>
 <dl class="free-legend"><div><dt><i class="committed"></i>Pagos</dt><dd>S/ 1,364.90</dd></div><div><dt><i class="set-aside"></i>Reservado</dt><dd>S/ 400.00</dd></div><div><dt><i class="free"></i>Disponible</dt><dd>S/ 820.00</dd></div></dl>
 <div class="hero-foot"><span>Saldo S/ 2,584.90</span><a>Ver cálculo</a></div></section>
 <section class="kpis" data-k="kpis">${kpi('Ingresos', 'S/ 5,500.00', 'Registrados')}${kpi('Gastos', 'S/ 4,200.00', 'Registrados')}${kpi('Ahorro', 'S/ 1,300.00', 'Estimado: hay movimientos por revisar')}
 <a class="kpi link-kpi"><span>Próximo pago</span><strong>S/ 480.00</strong><small class="muted">Tarjeta BCP · vence el 30 oct</small></a></section>
</div>
<div class="dash-cols">
 <div class="col" data-k="left">
  <section class="card stack-sm o-trend" data-k="trend"><div class="row"><h2>Ingresos y gastos</h2><a class="section-link">Análisis</a></div><ul class="plain bars">${rows(6, (i) => `<li><span>Mes ${i + 1}</span><span class="bar-track"><span class="bar income" style="width:${60 + i * 5}%"></span><span class="bar expense" style="width:${50 + i * 4}%"></span></span></li>`)}</ul></section>
  <section class="card stack-sm o-spend" data-k="spend"><div class="row"><h2>En qué se fue tu dinero</h2><a class="section-link">Detalle</a></div><small class="muted">Gastos registrados en octubre 2026 · PEN</small><ul class="plain stack-sm">${rows(4, (i) => `<li class="cat-row"><span>Categoría ${i + 1}</span><strong class="amount">S/ ${1800 - i * 400}.00</strong><span class="progress"><span class="fill" style="width:${40 - i * 8}%"></span></span></li>`)}</ul></section>
  <section class="card stack-sm o-recent" data-k="recent"><div class="row"><h2>Movimientos recientes</h2><a class="section-link">Ver todos</a></div><ul class="tx-list">${rows(6, (i) => `<li><a class="tx-row"><span>Comercio ${i + 1}</span><span class="amount">−S/ ${30 + i}.00</span></a></li>`)}</ul></section>
 </div>
 <div class="col" data-k="right">
  <div class="o-coming" data-k="coming"><section class="stack-sm"><div class="row"><h2>Próximos pagos</h2><a class="section-link">Ver todo</a></div><ul class="plain coming card">${rows(4, (i) => `<li><span class="day"><b>${12 + i * 5}</b>oct</span><span class="setting-text"><span>Pago ${i + 1}</span></span><span class="amount">−S/ ${120 + i * 100}.00</span></li>`)}</ul></section></div>
  <div class="o-savings" data-k="savings"><section class="card stack-sm"><div class="row"><h2>Meta de ahorro</h2></div><p class="row"><strong>S/ 1,300.00 de S/ 1,500.00</strong><span class="muted">87%</span></p><span class="progress"><span class="fill" style="width:87%"></span></span></section></div>
  <section class="card stack-sm o-credit" data-k="credit"><div class="row"><h2>Tarjetas y deudas</h2><a class="section-link">Ver</a></div>
   <div class="credit-line"><span class="row"><span class="muted small">Línea total · PEN</span><strong class="amount">S/ 18,000.00</strong></span><span class="progress"><span class="fill" style="width:22%"></span></span><small class="muted">Usas el 22% (S/ 3,960.00)</small></div>
   <ul class="plain stack-sm debt-mini">${rows(3, (i) => `<li><span>Tarjeta ${i + 1}</span><strong class="amount">S/ ${480 + i * 300}.00</strong><small class="muted" style="grid-column:1 / -1">Cierra el 20 · paga hasta el 30 oct</small></li>`)}</ul>
   <div class="credit-health stack-xs"><h3>Tu salud crediticia</h3><ul class="plain stack-xs"><li class="signal watch"><i></i>Tarjeta 2 usa el 64% de su línea. La referencia usual es menos del 30%.</li><li class="signal good"><i></i>Sin pagos vencidos este mes.</li></ul><small class="muted">Con lo que registras en Velsuno. No es tu calificación en Infocorp ni en la SBS.</small></div></section>
 </div>
</div></main>`;
const shell = `<div class="shell"><aside class="sidebar"><a class="brand">Velsuno</a><nav><ul class="nav-list">${rows(7, (i) => `<li><a>Item ${i}</a></li>`)}</ul></nav></aside><div class="shell-main"><header class="topbar"><a class="brand">Velsuno</a></header>${main}</div><nav class="bottom-nav"><a>1</a><a>2</a><a>3</a><a>4</a><a>5</a></nav></div>`;
const page = (theme) => `<!doctype html><html lang="es" data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${shell}</body></html>`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
let failed = 0;
const fail = (m) => { failed++; console.log(`  ✗ ${m}`); };
for (const [w, h] of [[390, 844], [768, 1024], [1280, 900], [1440, 960]]) {
  for (const theme of ['light', 'dark']) {
    const p = await browser.newPage({ viewport: { width: w, height: h }, isMobile: w < 768, hasTouch: w < 768 });
    await p.setContent(page(theme));
    const r = await p.evaluate(() => {
      const box = (k) => { const e = document.querySelector(`[data-k="${k}"]`); const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), bottom: Math.round(b.bottom) }; };
      return { scrollW: document.documentElement.scrollWidth, main: Math.round(document.querySelector('main.dash').getBoundingClientRect().width),
        hero: box('hero'), kpis: box('kpis'), trend: box('trend'), coming: box('coming'), spend: box('spend'), recent: box('recent'), credit: box('credit'), savings: box('savings'),
        kpiTops: [...document.querySelectorAll('.dash-top .kpi')].map((e) => Math.round(e.getBoundingClientRect().y)) };
    });
    console.log(`${w}×${h} ${theme}: main ${r.main}px`);
    if (r.scrollW > w) fail(`horizontal overflow ${r.scrollW} > ${w}`);
    if (w < 768) {
      // One column, priority: hero → KPIs → próximos pagos → ahorro → en qué se fue → tarjetas → tendencia → movimientos.
      const order = ['hero', 'kpis', 'coming', 'savings', 'spend', 'credit', 'trend', 'recent'].map((k) => r[k].y);
      if (order.some((y, i) => i && y <= order[i - 1])) fail(`phone order wrong: ${order.join(',')}`);
      if (r.trend.x !== r.coming.x) fail('phone is not one column');
    } else {
      if (r.coming.x <= r.trend.x) fail('tablet/desktop: próximos pagos not beside the trend');
      if (Math.abs(r.coming.y - r.trend.y) > 2) fail('the two columns do not start together');
    }
    if (w >= 1024) {
      if (r.kpis.x <= r.hero.x || Math.abs(r.kpis.y - r.hero.y) > 2) fail('desktop: KPIs not beside Dinero disponible');
      if (r.main < 960) fail(`desktop container too narrow (${r.main}px)`);
    }
    if (w === 768 && new Set(r.kpiTops).size !== 1) fail('tablet: KPIs not in one row');
    if (shots) await p.screenshot({ path: `${shots}/dashboard-${w}-${theme}.png`, fullPage: true });
    await p.close();
  }
}
await browser.close();
console.log(failed ? `FAILED ${failed}` : 'OK dashboard layout');
process.exit(failed ? 1 : 0);
