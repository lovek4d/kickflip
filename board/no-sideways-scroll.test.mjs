import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, dumpProbe } from '../shared/test-helpers.mjs';

const pub = fileURLToPath(new URL('./public/', import.meta.url));
const long = 'x'.repeat(400);
const wideTable = `<table><tr>${Array.from({ length: 12 }, (_, i) => `<th>column-${i}-${'h'.repeat(20)}</th>`).join('')}</tr></table>`;

// Each pane's real class, filled with a long unbroken word, a wide pre and a wide table.
const FIXTURE = `<!doctype html><html><head>
<link rel="stylesheet" href="${pub}style.css"><link rel="stylesheet" href="${pub}sidebar.css"></head>
<body class="has-sidebar"><aside class="sidebar open"><div class="sb-scroll"><section><a class="sb-row"><span class="sb-text"><span class="sb-sub">${long}</span></span></a><code>${long}</code></section></div></aside>
<div class="view-questions"><div class="ctx"><p>${long}</p>${wideTable}<pre>${long}</pre></div></div>
<div class="view-notes"><div class="plan"><p>${long}</p><pre>${long}</pre><div class="md-table">${wideTable}</div></div></div>
<dialog class="reader-sheet" open><div class="reader-body"><div class="reader-row">${long}</div><div class="reader-md"><pre>${long}</pre>${wideTable}</div></div></dialog>
<script>{
  const widths = {};
  for (const sel of ['.sidebar', '.sb-scroll', '.view-questions', '.view-notes', '.reader-body'])
    { const el = document.querySelector(sel); widths[sel] = [el.scrollWidth, el.clientWidth];
      // Nothing inside a pane may be its own sideways scroller either.
      for (const inner of el.querySelectorAll('*')) if (['auto', 'scroll'].includes(getComputedStyle(inner).overflowX) && inner.scrollWidth > inner.clientWidth)
        widths[sel + ' ' + inner.tagName.toLowerCase() + '.' + inner.className] = [inner.scrollWidth, inner.clientWidth]; }
  const probe = document.createElement('pre'); probe.id = 'probe'; probe.textContent = JSON.stringify(widths); document.body.append(probe);
}</script></body></html>`;

for (const width of [390, 1280]) {
  test(`at ${width}px the sidebar and each pane's scrollWidth equals its clientWidth`, { skip: !chromeInstalled }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sideways-'));
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, FIXTURE);
    const widths = await dumpProbe(file, width);
    for (const [sel, [scroll, client]] of Object.entries(widths)) assert.equal(scroll, client, `${sel} scrolls sideways: ${scroll} in ${client}`);
  });
}
