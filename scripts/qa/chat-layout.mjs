// Browser check of the chat layout (no server, no account): the built CSS + the chat's real DOM structure, 30+ messages,
// mobile 390×844. Asserts the conversation list (not the page) scrolls, the oldest message is reachable, and the
// composer never covers the last message; the Vels header (avatar · Vels ✓ · status) is compact and unclipped and the
// avatar files load at their size. Run after `npm run build`: node scripts/qa/chat-layout.mjs [screenshot-dir]
import { readdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const dir = '.next/static/chunks';
const shots = process.argv[2] ?? null;
const img = (size) => `data:image/png;base64,${readFileSync(`public/brand/vels/vels-avatar-${size <= 32 ? 64 : size <= 64 ? 128 : 256}.png`).toString('base64')}`;
const avatar = (size) => `<span class="vels-avatar" style="width:${size}px;height:${size}px"><img alt="" width="${size}" height="${size}" src="${img(size)}"></span>`;
const check = '<span class="vels-official" role="img" aria-label="Asistente oficial de Velsuno" title="Asistente oficial de Velsuno"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 8.5L7 11.5L12.5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
const header = (tag, status = ['ok', 'Conectada']) => `<div class="vels-identity">${avatar(44)}<div class="vels-identity-text"><${tag} class="vels-name">Vels${check}</${tag}><span class="vels-status ${status[0]}" role="status"><span class="dot"></span>${status[1]}</span></div></div>`;
const css = readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n');
const msgs = Array.from({ length: 34 }, (_, i) => i % 2
  ? `<li class="msg user"><p>Mensaje ${i} de la persona</p></li>`
  : `<li class="msg velsuno${i % 4 === 0 ? ' first' : ''}">${i % 4 === 0 ? `<span class="msg-avatar">${avatar(28)}</span>` : ''}<p>Respuesta ${i} de Vels con un poco más de texto para ocupar dos líneas en móvil.</p></li>`).join('');
const page = (inner) => `<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${inner}</body></html>`;
const chat = `<div class="chat"><ol class="chat-list" id="list">${msgs}</ol><form class="composer"><textarea rows="1"></textarea><button class="send" type="submit">→</button></form></div>`;
const shells = {
  'Vels page (/app/preguntar)': `<div class="shell"><div class="shell-main"><header class="topbar"><a class="brand">Velsuno</a></header><main class="assistant-page"><div class="row">${header('h1')}</div>${chat}</main></div><nav class="bottom-nav"><a>1</a><a>2</a><a>3</a><a>4</a><a>5</a></nav></div>`,
  'Vels panel (floating)': `<button class="vels-fab" aria-label="Hablar con Vels">${avatar(52)}</button><dialog class="vels-panel" id="d"><div class="vels-head">${header('h2')}<button class="icon" aria-label="Cerrar">×</button></div>${chat}</dialog><script>document.getElementById('d').showModal()</script>`,
  'Onboarding (/bienvenida)': `<div class="onboarding"><div class="onboarding-top"><span class="brand">Velsuno</span></div><div class="onboarding-body">${chat}</div></div>`,
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
let failed = 0;
for (const [name, inner] of Object.entries(shells)) {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await p.setContent(page(inner));
  const r = await p.evaluate(async () => {
    const list = document.getElementById('list');
    const doc = document.scrollingElement;
    const first = list.firstElementChild.getBoundingClientRect;
    list.scrollTop = list.scrollHeight;
    await new Promise((r) => requestAnimationFrame(r));
    const composer = document.querySelector('.composer').getBoundingClientRect();
    const last = list.lastElementChild.getBoundingClientRect();
    const atEnd = { lastBottom: last.bottom, composerTop: composer.top, listBottom: list.getBoundingClientRect().bottom };
    list.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(r));
    const top = list.firstElementChild.getBoundingClientRect().top >= list.getBoundingClientRect().top - 1;
    return {
      listScrolls: list.scrollHeight > list.clientHeight + 10,
      pageScrolls: doc.scrollHeight > window.innerHeight + 1,
      oldestReachable: top,
      lastNotUnderComposer: atEnd.lastBottom <= atEnd.composerTop + 1 && atEnd.lastBottom <= atEnd.listBottom + 1,
      overflowY: getComputedStyle(list).overflowY, touchAction: getComputedStyle(list).touchAction,
      avatarsLoaded: [...document.querySelectorAll('.vels-avatar img')].every((i) => i.complete && i.naturalWidth >= i.width * 2),
      avatarRound: [...document.querySelectorAll('.vels-avatar')].every((a) => { const b = a.getBoundingClientRect(); return Math.abs(b.width - b.height) < 0.5 && getComputedStyle(a).borderRadius === '50%'; }),
      headerHeight: Math.round(document.querySelector('.vels-identity')?.getBoundingClientRect().height ?? 0),
      headerClipped: [...document.querySelectorAll('.vels-name, .vels-status')].some((e) => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > window.innerWidth),
    };
  });
  // Real gesture: a wheel / swipe over the list moves the list, not the page.
  await p.evaluate(() => { document.getElementById('list').scrollTop = document.getElementById('list').scrollHeight; });
  const box = await p.locator('#list').boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.wheel(0, -1200);
  await p.waitForTimeout(200);
  const moved = await p.evaluate(() => { const l = document.getElementById('list'); return l.scrollHeight - l.clientHeight - l.scrollTop > 200; });
  const identity = !name.startsWith('Onboarding') ? r.avatarsLoaded && r.avatarRound && r.headerHeight > 0 && r.headerHeight <= 56 && !r.headerClipped : r.avatarsLoaded;
  const ok = r.listScrolls && !r.pageScrolls && r.oldestReachable && r.lastNotUnderComposer && moved && r.overflowY === 'auto' && identity;
  if (shots && name.startsWith('Vels panel')) await p.screenshot({ path: `${shots}/vels-panel-390.png` });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify({ ...r, wheelScrollsList: moved })}`);
  await p.close();
}
if (shots) {
  // Desktop panel (400 px), dark scheme, and offline status: screenshots for the visual check.
  const desk = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await desk.setContent(page(shells['Vels panel (floating)']));
  await desk.screenshot({ path: `${shots}/vels-panel-desktop.png` });
  const dark = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true });
  await dark.setContent(page(shells['Vels panel (floating)'].replace('class="vels-panel"', 'class="vels-panel"').replace("showModal()", "showModal();document.documentElement.dataset.theme='dark'")));
  await dark.screenshot({ path: `${shots}/vels-panel-dark.png` });
  const off = await browser.newPage({ viewport: { width: 390, height: 300 }, isMobile: true });
  await off.setContent(page(`<div style="padding:16px">${header('h2', ['off', 'Sin conexión'])}<br>${header('h2', ['wait', 'Reconectando…'])}</div>`));
  await off.screenshot({ path: `${shots}/vels-status.png` });
  const fab = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 3 });
  await fab.setContent(page(`<div class="shell"><div class="shell-main"><main style="padding:16px"><p>Inicio</p></main></div><nav class="bottom-nav"><a>Inicio</a><a>Pagos</a><a>+</a><a>Análisis</a><a>Más</a></nav></div><button class="vels-fab" aria-label="Hablar con Vels">${avatar(52)}</button>`));
  await fab.screenshot({ path: `${shots}/vels-fab.png`, clip: { x: 230, y: 640, width: 160, height: 204 } });
}
await browser.close();
process.exit(failed ? 1 : 0);
