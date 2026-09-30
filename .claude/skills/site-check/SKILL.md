---
name: site-check
description: Pre-publish check of the tutor landing page (index.html) — broken asset links, SEO tags, asset sizes and mp4 faststart, header/nav layout, horizontal scroll, gallery tabs and lightbox, lead form, JS errors — on desktop and mobile, with screenshots. Use before every commit/PR that touches index.html or assets/, after adding gallery works, or whenever the user asks to check, test, verify or screenshot the site ("проверь сайт", "всё ли работает", "сделай скрины").
---

# site-check — проверка сайта перед публикацией

Одна команда прогоняет статические проверки и проверки в настоящем браузере (Playwright, Chromium)
на двух экранах — десктоп 1366×860 и телефон 390×844 — и сохраняет скриншоты.

## Запуск

```bash
node .claude/skills/site-check/scripts/check.mjs --out "$SCRATCH/site-check"
```

- `--root` — папка сайта (по умолчанию текущая, корень репозитория).
- `--out` — куда положить скриншоты (по умолчанию `$TMPDIR/site-check`). Клади в scratchpad, не в репозиторий.
- Код выхода `1`, если есть хотя бы одна ❌.

Нужны Playwright и Chromium. В облачных сессиях их обеспечивает `.claude/hooks/session-start.sh`;
локально — `npm i -g playwright && npx playwright install chromium`.

## Что проверяется

| Группа | Проверки |
|---|---|
| Файлы | каждый `src` / `href` / `poster` и og:image ведут на существующий файл (HTML-комментарии игнорируются) |
| SEO | title, description, og:image, canonical, favicon; наличие `robots.txt`, `sitemap.xml`, `.nojekyll`; нет заглушек `ЗАМЕНИ` / `ТВОЙ-ДОМЕН` / `TODO` |
| Вес | картинки ≤ 500 КБ, видео ≤ 10 МБ, у mp4 moov в начале (faststart) |
| Шапка | есть `<div class="nav-links">`, кнопка «Бесплатный урок» справа внутри шапки и в одну строку, пункты меню ведут на существующие секции в том же порядке |
| Вёрстка | нет горизонтальной прокрутки, у всех `img` есть `alt`, у видео в галерее есть `poster`, нет эмодзи в тексте (правило бренда) |
| Галерея | сколько работ и заглушек в каждой вкладке; вкладки переключаются; лайтбокс открывается и закрывается по Esc |
| Форма | заполняется и отправляется, показывает сообщение, формирует ссылку `https://t.me/…` (сам Telegram не открывается) |
| JS | нет ошибок JavaScript |

Внешние запросы (Google Fonts и т.п.) в проверке блокируются — поэтому на скриншотах системный шрифт
вместо Unbounded/Manrope, это нормально. Chromium из Playwright не играет H.264 — на скриншотах у видео
видна обложка `poster`, это тоже нормально.

## Как отчитываться

1. Запусти скрипт, прочитай отчёт (сначала ❌, потом ⚠️, ℹ️, ✅).
2. Открой скриншоты `gallery-desktop.png`, `gallery-mobile.png` (и `full-*.png`, если менялась вёрстка вне галереи)
   и посмотри на них глазами — скрипт не заметит некрасивого, только сломанное.
3. ❌ — чини до коммита. ⚠️ — исправь, если это часть текущей задачи, иначе упомяни пользователю.
4. Пользователю — коротко: сколько ошибок/предупреждений, что починено, что осталось; при изменениях вёрстки
   отправь 1–2 скриншота.
