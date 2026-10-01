#!/usr/bin/env node
// Pre-publish check for the static landing page.
// Usage: node check.mjs [--root .] [--out <screenshots dir>]
// Exit code 1 if any ❌ check fails. ⚠️ are warnings, ℹ️ are info.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : def; };
const ROOT = path.resolve(arg('--root', '.'));
const OUT = path.resolve(arg('--out', path.join(process.env.TMPDIR || os.tmpdir(), 'site-check')));
fs.mkdirSync(OUT, { recursive: true });

let playwright;
try { playwright = await import('playwright'); }
catch { playwright = await import(path.join(execSync('npm root -g').toString().trim(), 'playwright', 'index.mjs')); }
const { chromium } = playwright;

const results = [];
const ok = (m) => results.push(['✅', m]);
const warn = (m) => results.push(['⚠️', m]);
const fail = (m) => results.push(['❌', m]);
const info = (m) => results.push(['ℹ️', m]);

// ---------- static checks (no browser) ----------
const htmlPath = path.join(ROOT, 'index.html');
// HTML comments hold usage examples (fake paths) — ignore them
const html = fs.readFileSync(htmlPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const canonical = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];

// local references: src / href / poster, plus absolute URLs under the canonical base
const refs = new Set();
for (const m of html.matchAll(/\b(?:src|href|poster)="([^"#][^"]*)"/g)) refs.add(m[1]);
for (const m of html.matchAll(/content="(https?:\/\/[^"]+\.(?:png|jpe?g|webp|svg))"/g)) refs.add(m[1]);
const missing = [];
for (let r of refs) {
  if (canonical && r.startsWith(canonical)) r = r.slice(canonical.length);
  if (/^(https?:|mailto:|tel:|data:|\/\/)/.test(r)) continue;
  const p = path.join(ROOT, decodeURIComponent(r.split(/[?#]/)[0]));
  if (!fs.existsSync(p)) missing.push(r);
}
missing.length ? fail(`Нет файлов, на которые ссылается страница: ${missing.join(', ')}`) : ok(`Все локальные файлы на месте (${refs.size} ссылок проверено)`);

if (/ЗАМЕНИ|ТВОЙ-ДОМЕН|TODO|lorem ipsum/i.test(html)) fail('В index.html остались заглушки (ЗАМЕНИ / ТВОЙ-ДОМЕН / TODO)');
else ok('Заглушек домена и TODO нет');

for (const [re, name] of [[/<title>[^<]{10,}<\/title>/, 'title'], [/name="description" content="[^"]{50,}"/, 'meta description'],
  [/property="og:image"/, 'og:image'], [/rel="canonical"/, 'canonical'], [/rel="icon"/, 'favicon']]) {
  re.test(html) ? ok(`SEO: ${name} есть`) : fail(`SEO: нет ${name}`);
}
for (const f of ['robots.txt', 'sitemap.xml', '.nojekyll']) {
  fs.existsSync(path.join(ROOT, f)) ? ok(`${f} есть`) : warn(`Нет ${f}`);
}

// asset sizes + mp4 faststart
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const assetsDir = path.join(ROOT, 'assets');
let heavy = 0;
if (fs.existsSync(assetsDir)) for (const f of walk(assetsDir)) {
  const rel = path.relative(ROOT, f), size = fs.statSync(f).size, ext = path.extname(f).toLowerCase();
  if (/\.(png|jpe?g|webp|gif)$/.test(ext) && size > 500 * 1024 && !rel.endsWith('og-preview.png')) { warn(`Тяжёлая картинка ${rel}: ${(size / 1024) | 0} КБ (лучше ≤ 500 КБ)`); heavy++; }
  if (ext === '.mp4') {
    if (size > 10 * 1024 * 1024) { warn(`Тяжёлое видео ${rel}: ${(size / 1048576).toFixed(1)} МБ (лучше ≤ 10 МБ)`); heavy++; }
    const buf = fs.readFileSync(f);
    const moov = buf.indexOf('moov'), mdat = buf.indexOf('mdat');
    if (moov === -1 || (mdat !== -1 && moov > mdat)) warn(`${rel}: moov в конце файла — видео не стартует до полной загрузки (нужен -movflags +faststart)`);
  }
}
if (!heavy) ok('Размеры картинок и видео в норме');

// ---------- browser checks ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.xml': 'application/xml', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(p).size, type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? +range[1] : 0, end = range[2] ? +range[2] : size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return fs.createReadStream(p, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));

// Google Fonts are fetched with curl (it honours the environment's proxy/CA) and cached, so text is measured
// in the real Unbounded/Manrope — the fallback font is much narrower and hides overflow bugs.
const FONT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const fontCache = new Map();
let fontsFailed = 0;
const fontRoute = async (route) => {
  const url = route.request().url();
  try {
    if (!fontCache.has(url)) fontCache.set(url, execFileSync('curl', ['-sSfL', '--max-time', '20', '-A', FONT_UA, url], { maxBuffer: 20 << 20 }));
    const type = url.includes('fonts.googleapis.com') ? 'text/css; charset=utf-8' : 'font/woff2';
    await route.fulfill({ status: 200, body: fontCache.get(url), headers: { 'content-type': type, 'access-control-allow-origin': '*' } });
  } catch { fontsFailed++; await route.abort(); }
};
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
for (const [label, vp] of [['desktop', { width: 1366, height: 860 }], ['mobile', { width: 390, height: 844 }], ['mobile-360', { width: 360, height: 740 }]]) {
  const page = await browser.newPage({ viewport: vp });
  const errors = [], bad = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.url().startsWith(BASE) && r.status() >= 400) bad.push(`${r.status()} ${r.url().slice(BASE.length)}`); });
  // the page may open Telegram on submit — never navigate away during the check
  await page.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return {}; }; });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort()); // no other external requests: deterministic
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, fontRoute);
  await page.goto(BASE + 'index.html', { waitUntil: 'load' });
  await page.evaluate(() => document.querySelectorAll('.reveal').forEach(e => e.classList.add('in')));

  const L = `[${label}]`;
  const fontsLoaded = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, '')); });
  new Set(fontsLoaded).size >= 2 ? ok(`${L} Фирменные шрифты загружены (${[...new Set(fontsLoaded)].join(', ')})`)
    : warn(`${L} Шрифты Unbounded/Manrope не загрузились (curl недоступен?) — ширина текста проверена на запасном шрифте`);
  bad.length ? fail(`${L} Сервер вернул ошибки: ${bad.join(', ')}`) : ok(`${L} Все запросы к сайту успешны`);

  const scrollX = await page.evaluate(() => { window.scrollTo(9999, 0); const x = window.scrollX; window.scrollTo(0, 0); return x; });
  scrollX > 0 ? fail(`${L} Страница листается вбок на ${scrollX}px`) : ok(`${L} Нет горизонтальной прокрутки`);

  // text that sticks out of the screen: body has overflow-x:hidden, so it is silently cut off instead of scrolling
  const cut = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    return [...document.querySelectorAll('h1,h2,h3,h4,p,li,a,button,label,.num,.lbl,.eyebrow,.tag,.amount')]
      .filter(e => !e.closest('.gtrack,.gtabs,#lb,.blob') && e.offsetParent !== null)
      // measure the text itself (a Range), not the box: a long word overflows its own block without widening it
      .map(e => { const rg = document.createRange(); rg.selectNodeContents(e); return { e, right: Math.max(rg.getBoundingClientRect().right, e.getBoundingClientRect().right) }; })
      .filter(x => x.right > W + 1)
      .map(x => `${x.e.tagName.toLowerCase()}${x.e.className ? '.' + String(x.e.className).split(' ')[0] : ''} «${x.e.textContent.trim().slice(0, 30)}» (+${Math.round(x.right - W)}px)`)
      .filter((v, i, a) => a.indexOf(v) === i).slice(0, 8);
  });
  cut.length ? fail(`${L} Текст вылезает за край экрана и обрезается: ${cut.join('; ')}`) : ok(`${L} Весь текст помещается по ширине экрана`);

  const nav = await page.evaluate(() => {
    const navEl = document.querySelector('nav'), cta = document.querySelector('.nav-cta'), logo = document.querySelector('nav .logo');
    const n = navEl.getBoundingClientRect(), c = cta.getBoundingClientRect(), l = logo.getBoundingClientRect();
    const links = [...document.querySelectorAll('.nav-links a')].map(a => a.getAttribute('href'));
    const order = links.map(h => { const el = document.querySelector(h); return el ? [...document.querySelectorAll('*')].indexOf(el) : -1; });
    return { hasLinks: !!document.querySelector('.nav-links'), linksCount: links.length, missing: links.filter((h, i) => order[i] === -1),
      sorted: order.every((v, i) => i === 0 || v > order[i - 1]), ctaInside: c.top >= n.top && c.bottom <= n.bottom + 1,
      ctaRight: c.left > l.right, oneLine: c.height < 60 };
  });
  if (!nav.hasLinks || nav.linksCount === 0) fail(`${L} Меню: нет <div class="nav-links"> — кнопка вывалится влево`);
  else if (nav.missing.length) fail(`${L} Меню ведёт на несуществующие секции: ${nav.missing.join(', ')}`);
  else if (!nav.sorted) warn(`${L} Порядок пунктов меню не совпадает с порядком секций`);
  else ok(`${L} Меню: ${nav.linksCount} пунктов, порядок совпадает с секциями`);
  nav.ctaInside && nav.ctaRight && nav.oneLine ? ok(`${L} Кнопка «Бесплатный урок» справа в шапке, в одну строку`) : fail(`${L} Кнопка в шапке съехала (inside=${nav.ctaInside}, right=${nav.ctaRight}, oneLine=${nav.oneLine})`);

  const a11y = await page.evaluate(() => ({
    noAlt: [...document.querySelectorAll('img:not([alt])')].map(i => i.getAttribute('src')),
    noPoster: [...document.querySelectorAll('.gcard video:not([poster])')].map(v => v.getAttribute('src')),
    emoji: (document.body.innerText.match(/\p{Extended_Pictographic}/gu) || []).join(' '),
  }));
  a11y.noAlt.length ? fail(`${L} Картинки без alt: ${a11y.noAlt.join(', ')}`) : ok(`${L} У всех картинок есть alt`);
  if (a11y.noPoster.length) warn(`${L} Видео без обложки poster: ${a11y.noPoster.join(', ')}`);
  if (a11y.emoji) warn(`${L} Эмодзи в тексте (по правилам бренда — только SVG): ${a11y.emoji}`);

  // gallery: panels, tabs, lightbox
  const gal = await page.evaluate(() => [...document.querySelectorAll('.gpanel')].map(p => ({
    id: p.id, works: p.querySelectorAll('.gcard:not(.placeholder)').length, placeholders: p.querySelectorAll('.gcard.placeholder').length })));
  info(`${L} Галерея: ${gal.map(g => `${g.id.replace('gp-', '')} — ${g.works} работ${g.placeholders ? ` + ${g.placeholders} заглушки` : ''}`).join('; ')}`);
  let tabsOk = true;
  for (const tab of await page.locator('.gtab').all()) {
    await tab.click();
    const id = await tab.getAttribute('aria-controls');
    if (!(await page.locator('#' + id).isVisible())) tabsOk = false;
  }
  tabsOk ? ok(`${L} Вкладки галереи переключаются`) : fail(`${L} Вкладка галереи не открывает свою панель`);
  const firstWithWork = gal.find(g => g.works);
  if (firstWithWork) {
    await page.click(`#tab-${firstWithWork.id.replace('gp-', '')}`);
    await page.locator(`#${firstWithWork.id} .gcard:not(.placeholder)`).first().click({ force: true });
    const opened = await page.locator('#lb').isVisible();
    const media = await page.evaluate(() => { const m = document.querySelector('#lb .lb-media img, #lb .lb-media video'); return m ? m.getBoundingClientRect().width : 0; });
    await page.keyboard.press('Escape');
    const closed = await page.locator('#lb').isHidden();
    opened && closed && media > 0 ? ok(`${L} Лайтбокс открывается и закрывается по Esc`) : fail(`${L} Лайтбокс: open=${opened} mediaWidth=${media} closedByEsc=${closed}`);
  }
  // «1-е занятие» dialog: every trigger opens it, the button inside closes it, Esc closes it
  const triggers = await page.locator('[data-open="firstLesson"]').count();
  if (triggers) {
    const res = [];
    for (let i = 0; i < triggers; i++) {
      const t = page.locator('[data-open="firstLesson"]').nth(i);
      await t.scrollIntoViewIfNeeded();
      await t.click();
      const open = await page.evaluate(() => document.getElementById('firstLesson').open);
      const inView = await page.evaluate(() => { const r = document.getElementById('firstLesson').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1 && r.width > 0; });
      if (i === 0) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(OUT, `first-lesson-${label}.png`) }); }
      await page.keyboard.press('Escape');
      const closed = await page.evaluate(() => !document.getElementById('firstLesson').open);
      res.push(open && inView && closed);
    }
    await page.locator('[data-open="firstLesson"]').first().click();
    await page.locator('#firstLesson .fl-cta').click();
    const ctaOk = await page.evaluate(() => !document.getElementById('firstLesson').open && location.hash === '#contact');
    res.every(Boolean) && ctaOk ? ok(`${L} Окно «1-е занятие»: открывается (${triggers} кнопки), помещается в экран, закрывается; «Записаться» ведёт к форме`)
      : fail(`${L} Окно «1-е занятие» работает неправильно (по кнопкам: ${res.join(', ')}; «Записаться» → форма: ${ctaOk})`);
  }
  await page.locator('#gallery').screenshot({ path: path.join(OUT, `gallery-${label}.png`) });

  // lead form: fills, submits, shows the message and opens a t.me link
  await page.fill('#name', 'Проверка');
  await page.selectOption('#subj', { index: 1 });
  await page.fill('#contactm', '@test');
  await page.click('#leadForm button[type=submit]');
  const form = await page.evaluate(() => ({ msg: getComputedStyle(document.getElementById('okMsg')).display !== 'none', url: window.__opened[0] || '' }));
  form.msg && form.url.startsWith('https://t.me/') ? ok(`${L} Форма: сообщение показано, Telegram-ссылка сформирована`) : fail(`${L} Форма не сработала (msg=${form.msg}, url=${form.url || 'нет'})`);

  errors.length ? fail(`${L} Ошибки JavaScript: ${errors.join(' | ')}`) : ok(`${L} Ошибок JavaScript нет`);
  await page.screenshot({ path: path.join(OUT, `full-${label}.png`), fullPage: true });
  await page.close();
}
await browser.close();
server.close();

// ---------- report ----------
const order = { '❌': 0, '⚠️': 1, 'ℹ️': 2, '✅': 3 };
results.sort((a, b) => order[a[0]] - order[b[0]]);
for (const [s, m] of results) console.log(`${s} ${m}`);
const f = results.filter(r => r[0] === '❌').length, w = results.filter(r => r[0] === '⚠️').length;
console.log(`\nИтого: ${f} ошибок, ${w} предупреждений. Скриншоты: ${OUT}`);
process.exit(f ? 1 : 0);
