// docs/adr/2026-11-25-0405-the-owner-links-and-unlinks-a-cards-related-to-by-hand.md: on the open card, a tag or link
// chip with its ×, the add chip and the search field are one height, so the Tags and Related to rows keep theirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const chrome = sharedChrome();
const pub = fileURLToPath(new URL('./public/', import.meta.url));
const context = vm.createContext({ Date, location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout, AbortController });
for (const file of ['ui-icon-text.js', 'ui.js', 'ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(path.join(pub, file), 'utf8'), context);
const ui = context.BoardUI;

const card = { key: 'w/A1', ref: 'A1', tags: ['phone', 'perf'], related: [{ key: 'w/A2', ref: 'T-790', lane: 'review' }, { key: 'w/A3', ref: 'T-771', lane: 'done' }] };
const hits = [['T-701', 'A card title long enough to run past a phone screen', 'progress'], ['T-702', 'Another title', 'done']].map(([ref, title, lane]) => ({ kind: 'work', key: `w/${ref}`, ref, title, lane }));
const row = (label, html) => `<dt>${label}</dt><dd>${html}</dd>`;
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}style.css"></head><body><div class="detail"><dl class="grid">
${row('Tags', ui.tagRow(card))}${row('Related to', ui.relatedRow(card))}${row('Tags', ui.tagRow({ key: 'w/A1' }))}${row('Related to', ui.relatedRow({ key: 'w/A1' }))}
${row('Related to', ui.relatedRow({ ...card, related: [] }, { typed: 'T-7', items: [] }).split('<div class="link-hits"')[0])}
</dl><dl class="grid">${row('Related to', ui.relatedRow(card, { typed: 'T-7', items: hits }))}</dl></div>
<script>{
  const h = (el) => Math.round(el.getBoundingClientRect().height * 10) / 10;
  const chips = [...document.querySelectorAll('.tag-chip.whole, .tag-add, .link-field')].map((el) => [el.className, h(el)]);
  const rows = [...document.querySelectorAll('dl:first-of-type dd')].map(h);
  const past = Math.round(document.querySelector('.link-hits').getBoundingClientRect().right - innerWidth);
  const probe = document.createElement('pre'); probe.id = 'probe';
  probe.textContent = JSON.stringify({ chips, rows, past });
  document.body.append(probe);
}</script></body></html>`;

test("a chip with its ×, the add chip and the search field are all 28px, so a row is as tall with chips as without, and the search's hits stay on screen", { skip: !chromeInstalled }, async () => {
  const file = path.join(tempDir('chiprow-'), 'page.html');
  fs.writeFileSync(file, PAGE);
  for (const width of [390, 1280]) {
    const { chips, rows, past } = await chrome.probe(`file://${file}`, width);
    assert.ok(past <= 0, `the search's hits run ${past}px past the screen at ${width}px`);
    assert.ok(chips.length >= 7, JSON.stringify(chips));
    for (const [cls, height] of chips) assert.equal(height, 28, `${cls} at ${width}px: ${JSON.stringify(chips)}`);
    assert.equal(new Set(rows).size, 1, `rows at ${width}px: ${JSON.stringify(rows)}`);
  }
});
