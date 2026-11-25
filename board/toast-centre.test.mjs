// docs/adr/2026-11-25-0400-a-toast-centres-on-the-lanes.md
// From 900px a toast centres on the lanes (the room between the sidebar and the pane), never on the window; on a phone it centres as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const chrome = sharedChrome();
const pub = fileURLToPath(new URL('./public/', import.meta.url));

const fixture = (cls) => `<!doctype html><html><head><link rel="stylesheet" href="${pub}colors.css"><link rel="stylesheet" href="${pub}style.css"></head>
<body class="has-sidebar"><div class="${cls}"><div class="toast-stack"><div class="toast-row" id="toast"><div class="toast">Saved</div></div></div></div>
<script>{
  const r = document.querySelector('.toast').getBoundingClientRect();
  const probe = document.createElement('pre'); probe.id = 'probe';
  probe.textContent = JSON.stringify({ centre: (r.left + r.right) / 2, vw: document.documentElement.clientWidth });
  document.body.append(probe);
}</script></body></html>`;

const centre = async (cls, width) => {
  const file = path.join(tempDir('toast-centre-'), 'page.html');
  fs.writeFileSync(file, fixture(cls));
  return chrome.probe(`file://${file}`, width);
};

test('at 1280px a board toast centres on the lanes, left of the pane', { skip: !chromeInstalled }, async () => {
  const g = await centre('view-board', 1280);
  const sidebar = 272, pane = (g.vw - sidebar) / 2;
  assert.ok(Math.abs(g.centre - (sidebar + (g.vw - sidebar - pane) / 2)) <= 1, `centre ${g.centre}`);
});

test('at 1280px a page toast centres on the room right of the sidebar', { skip: !chromeInstalled }, async () => {
  const g = await centre('view-hub', 1280);
  assert.ok(Math.abs(g.centre - (272 + (g.vw - 272) / 2)) <= 1, `centre ${g.centre}`);
});

test('at 390px a toast centres on the phone', { skip: !chromeInstalled }, async () => {
  const g = await centre('view-board', 390);
  assert.ok(Math.abs(g.centre - g.vw / 2) <= 1, `centre ${g.centre}`);
});
