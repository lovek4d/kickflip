// The attach icon sits inside the text box at its bottom-left corner, and the typed text keeps clear of it, on a phone
// and on desktop (docs/adr/2026-11-16-0730-the-attach-icon-sits-inside-the-text-box.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const chrome = sharedChrome();
const pub = fileURLToPath(new URL('./public/', import.meta.url));
const ATTACH = '<label class="attach"><input type="file" data-attach></label>';

const FIXTURE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}style.css"></head><body><div style="width:340px"><div class="dz"><textarea rows="2"></textarea>${ATTACH}</div></div>
<script>{
  const r = (el) => el.getBoundingClientRect();
  const box = r(document.querySelector('textarea')), a = r(document.querySelector('.attach'));
  const pad = parseFloat(getComputedStyle(document.querySelector('textarea')).paddingBottom);
  const probe = document.createElement('pre'); probe.id = 'probe';
  probe.textContent = JSON.stringify({ left: a.left - box.left, bottom: box.bottom - a.bottom, inside: a.top >= box.top, textClear: pad >= box.bottom - a.top });
  document.body.append(probe);
}</script></body></html>`;

for (const width of [390, 1280]) {
  test(`at ${width}px the attach icon is at the text box's bottom left and the text clears it`, { skip: !chromeInstalled }, async () => {
    const file = path.join(tempDir('attach-in-'), 'page.html');
    fs.writeFileSync(file, FIXTURE);
    const got = await chrome.probe(`file://${file}`, width);
    assert.ok(got.left >= 0 && got.left < 12, `left ${got.left}px`);
    assert.ok(got.bottom >= 0 && got.bottom < 12, `bottom ${got.bottom}px`);
    assert.ok(got.inside && got.textClear, JSON.stringify(got));
  });
}
