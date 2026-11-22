// The questions sheet's Send sits in a footer under its scrolling cards, flush to the sheet's bottom edge with a hairline
// above it: on a phone the sheet stands on the bottom bar and the keyboard (--kb, dialogs.js fitSheet) lifts the footer
// with it; on a desktop the sheet ends at the window's bottom. Scrolled to the end, the last card shows whole above it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const chrome = sharedChrome();
const pub = fileURLToPath(new URL('./public/', import.meta.url));

const card = (n) => `<section class="q"><h3>Question ${n}?</h3><label class="opt"><input type="radio"><span>A</span></label><textarea class="note" rows="2"></textarea></section>`;
const FIXTURE = (kb) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}../../shared/colors.css"><link rel="stylesheet" href="${pub}style.css"></head>
<body><header class="top"></header><main></main>
<script>window.BoardView = { part() {} };</script>
<script src="${pub}ui-icon-text.js"></script><script src="${pub}ui.js"></script><script src="${pub}app-questions-sheet.js"></script>
<script>{
  document.body.insertAdjacentHTML('beforeend', BoardQuestionsSheet.markup());
  const sheet = document.querySelector('dialog.questions-sheet');
  sheet.querySelector('.reader-body').innerHTML = '<div class="view-questions qs-body">' + [1, 2, 3, 4, 5, 6].map(${card}).join('') + '</div>';
  ${kb ? `sheet.classList.add('keyboard-sheet', 'kb'); sheet.style.setProperty('--kb', '${kb}px');` : ''}
  sheet.style.animation = 'none';
  sheet.showModal();
  const body = sheet.querySelector('.reader-body');
  body.scrollTop = body.scrollHeight;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const box = (el) => el.getBoundingClientRect();
    const foot = sheet.querySelector('.qs-foot');
    const cards = sheet.querySelectorAll('section.q');
    const probe = document.createElement('pre'); probe.id = 'probe';
    probe.textContent = JSON.stringify({ vh: innerHeight, sheet: box(sheet).bottom, foot: box(foot), send: box(sheet.querySelector('#send')).bottom,
      bodyBottom: box(body).bottom, bodyHeight: box(body).height, sheetHeight: getComputedStyle(sheet).height, sheetTop: box(sheet).top, last: box(cards[cards.length - 1]).bottom, footIn: body.contains(foot), hairline: getComputedStyle(foot).borderTopWidth,
      nav: innerHeight - box(Object.assign(document.body.appendChild(document.createElement('div')), { style: 'height: var(--app-bottom, 0px)' })).height });
    document.body.append(probe);
  }));
}</script></body></html>`;

for (const [width, kb] of [[390, 0], [390, 300], [1280, 0]]) {
  test(`at ${width}px${kb ? ' with the keyboard open' : ''} Send sits in the sheet's footer, flush to its bottom edge, the last card whole above it`, { skip: !chromeInstalled }, async () => {
    const dir = tempDir('qs-foot-');
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, FIXTURE(kb));
    const g = await chrome.probe(`file://${file}`, width);
    assert.equal(g.footIn, false, 'the footer is outside the scrolling body');
    assert.equal(g.hairline, '1px');
    assert.ok(Math.abs(g.foot.bottom - g.sheet) <= 1, `the footer ends at the sheet's bottom edge: ${g.foot.bottom} vs ${g.sheet}`);
    assert.ok(Math.abs(g.bodyBottom - g.foot.top) <= 1, `the body ends at the footer's hairline: ${g.bodyBottom} vs ${g.foot.top}`);
    assert.ok(g.last <= g.foot.top - 8, `the last card (${g.last}) shows whole above the footer (${g.foot.top})`);
    if (kb) assert.ok(Math.abs(parseFloat(g.sheetHeight) - (g.vh - 12)) <= 1, `the sheet's height is the computed formula (the screen less 12px), not a dropped declaration: ${g.sheetHeight}`);
    assert.ok(g.bodyHeight > 100, `the scrolling body keeps room: ${g.bodyHeight}`);
    const floor = kb ? g.vh - kb : width < 900 ? g.nav : g.vh;
    if (kb) assert.ok(g.sheetTop < floor - 100, `the sheet's top (${g.sheetTop}) sits well above the keyboard (${floor})`);
    if (!kb) assert.ok(Math.abs(g.sheet - floor) <= 1, `the sheet stands on ${floor}: ${g.sheet}`);
    assert.ok(g.send <= floor - 8 && g.send >= floor - 24, `Send sits just above ${kb ? 'the keyboard' : width < 900 ? 'the bottom bar' : "the window's edge"}: ${g.send} vs ${floor}`);
  });
}
