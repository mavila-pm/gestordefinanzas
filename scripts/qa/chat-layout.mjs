// Browser check of the chat layout (no server, no account): the built CSS + the chat's real DOM structure, 30+ messages,
// mobile 390×844. Asserts the conversation list (not the page) scrolls, the oldest message is reachable, and the
// composer never covers the last message. Run after `npm run build`: node scripts/qa/chat-layout.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const dir = '.next/static/chunks';
const css = readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n');
const msgs = Array.from({ length: 34 }, (_, i) => i % 2
  ? `<li class="msg user"><p>Mensaje ${i} de la persona</p></li>`
  : `<li class="msg velsuno${i % 4 === 0 ? ' first' : ''}">${i % 4 === 0 ? '<span class="msg-avatar"><span class="vels-avatar" style="width:26px;height:26px"></span></span>' : ''}<p>Respuesta ${i} de Vels con un poco más de texto para ocupar dos líneas en móvil.</p></li>`).join('');
const page = (inner) => `<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${inner}</body></html>`;
const chat = `<div class="chat"><ol class="chat-list" id="list">${msgs}</ol><form class="composer"><textarea rows="1"></textarea><button class="send" type="submit">→</button></form></div>`;
const shells = {
  'Vels page (/app/preguntar)': `<div class="shell"><div class="shell-main"><header class="topbar"><a class="brand">Velsuno</a></header><main class="assistant-page"><div class="row"><h1>Vels</h1></div>${chat}</main></div><nav class="bottom-nav"><a>1</a><a>2</a><a>3</a><a>4</a><a>5</a></nav></div>`,
  'Vels panel (floating)': `<dialog class="vels-panel" id="d"><div class="vels-head"><h2>Vels</h2></div>${chat}</dialog><script>document.getElementById('d').showModal()</script>`,
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
    };
  });
  // Real gesture: a wheel / swipe over the list moves the list, not the page.
  await p.evaluate(() => { document.getElementById('list').scrollTop = document.getElementById('list').scrollHeight; });
  const box = await p.locator('#list').boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.wheel(0, -1200);
  await p.waitForTimeout(200);
  const moved = await p.evaluate(() => { const l = document.getElementById('list'); return l.scrollHeight - l.clientHeight - l.scrollTop > 200; });
  const ok = r.listScrolls && !r.pageScrolls && r.oldestReachable && r.lastNotUnderComposer && moved && r.overflowY === 'auto';
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify({ ...r, wheelScrollsList: moved })}`);
  await p.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
