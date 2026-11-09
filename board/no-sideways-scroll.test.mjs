import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pub = fileURLToPath(new URL('./public/', import.meta.url));
const long = 'x'.repeat(400);
const wideTable = `<table><tr>${Array.from({ length: 12 }, (_, i) => `<th>column-${i}-${'h'.repeat(20)}</th>`).join('')}</tr></table>`;

// Each pane's real class, filled with a long unbroken word, a wide pre and a wide table.
const FIXTURE = `<!doctype html><html><head>
<link rel="stylesheet" href="${pub}style.css"><link rel="stylesheet" href="${pub}sidebar.css"></head>
<body class="has-sidebar"><aside class="sidebar open"><div class="sb-scroll"><section><a class="sb-row"><span class="sb-text"><span class="sb-sub">${long}</span></span></a><code>${long}</code></section></div></aside>
<div class="needs-pane"><div class="needs-questions"><main><p>${long}</p><pre>${long}</pre>${wideTable}</main></div></div>
<div class="view-questions"><div class="ctx"><p>${long}</p>${wideTable}<pre>${long}</pre></div></div>
<div class="view-notes"><div class="plan"><p>${long}</p><pre>${long}</pre><div class="md-table">${wideTable}</div></div></div>
<dialog class="reader-sheet" open><div class="reader-body"><div class="reader-row">${long}</div><div class="reader-md"><pre>${long}</pre>${wideTable}</div></div></dialog>
<script>addEventListener('load', () => setTimeout(() => {
  const widths = {};
  for (const sel of ['.sidebar', '.sb-scroll', '.needs-pane', '.view-questions', '.view-notes', '.reader-body'])
    { const el = document.querySelector(sel); widths[sel] = [el.scrollWidth, el.clientWidth];
      // Nothing inside a pane may be its own sideways scroller either.
      for (const inner of el.querySelectorAll('*')) if (['auto', 'scroll'].includes(getComputedStyle(inner).overflowX) && inner.scrollWidth > inner.clientWidth)
        widths[sel + ' ' + inner.tagName.toLowerCase() + '.' + inner.className] = [inner.scrollWidth, inner.clientWidth]; }
  document.body.insertAdjacentHTML('beforeend', '<pre id="probe">' + JSON.stringify(widths) + '</pre>');
}, 300))</script></body></html>`;

for (const width of [390, 1280]) {
  test(`at ${width}px the sidebar and each pane's scrollWidth equals its clientWidth`, { skip: !fs.existsSync(CHROME) }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sideways-'));
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, FIXTURE);
    const { stdout } = await promisify(execFile)(CHROME, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files', `--window-size=${width},900`,
      '--virtual-time-budget=4000', '--dump-dom', `file://${file}`], { encoding: 'utf8', timeout: 60000 });
    const posted = /<pre id="probe">(\{.*?\})<\/pre>/s.exec(stdout)?.[1];
    assert.ok(posted, 'the page reported its layout');
    for (const [sel, [scroll, client]] of Object.entries(JSON.parse(posted.replace(/&quot;/g, '"')))) assert.equal(scroll, client, `${sel} scrolls sideways: ${scroll} in ${client}`);
  });
}
