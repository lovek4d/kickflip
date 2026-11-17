// A card's link row that wraps splits into even lines: five links break 3 and 2, not 4 and 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const chrome = sharedChrome();
const pub = fileURLToPath(new URL('./public/', import.meta.url));

const links = [1001, 1002, 1003, 1004, 1005].map((n) => `<a class="card-link" href="#">#${n}</a>`).join(', ');
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}style.css"></head><body><div class="detail"><dl class="grid"><dt>Related to</dt><dd>${links}</dd></dl></div>
<script>{
  const lines = new Map();
  for (const a of document.querySelectorAll('dd a')) {
    const r = a.getBoundingClientRect();
    const line = lines.get(Math.round(r.top)) ?? { n: 0 };
    line.n++;
    lines.set(Math.round(r.top), line);
  }
  const probe = document.createElement('pre'); probe.id = 'probe';
  probe.textContent = JSON.stringify([...lines.values()]);
  document.body.append(probe);
}</script></body></html>`;

test('a wrapped link row breaks into even lines', { skip: !chromeInstalled }, async () => {
  const file = path.join(tempDir('linkrow-'), 'page.html');
  fs.writeFileSync(file, PAGE);
  const lines = await chrome.probe(`file://${file}`, 340);
  assert.equal(lines.length, 2, `expected two lines: ${JSON.stringify(lines)}`);
  assert.ok(Math.abs(lines[0].n - lines[1].n) <= 1, `uneven break: ${JSON.stringify(lines)}`);
});
