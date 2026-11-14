// Main's refresh icon sits centred on its text line: its centre is within 1px of the text's centre, in both themes
// and at phone width.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const chrome = sharedChrome();

const pub = fileURLToPath(new URL('./public/', import.meta.url));
const ICON = '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/></svg>';

const FIXTURE = (theme) => `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}style.css"></head>
<body><div class="tb-main"><div class="tb-main-row"><div class="tb-main-text"><strong>main</strong>@<code>427325d</code> <span class="muted">8m</span><span class="main-pull"><button class="ghost gh-refresh" type="button">${ICON}</button></span></div><div class="meta"></div></div></div>
<script>{
  const mid = (r) => r.top + r.height / 2;
  const text = document.querySelector('.tb-main-text strong').getBoundingClientRect();
  const icon = document.querySelector('.gh-refresh svg').getBoundingClientRect();
  const probe = document.createElement('pre'); probe.id = 'probe';
  probe.textContent = JSON.stringify({ text: mid(text), icon: mid(icon) }); document.body.append(probe);
}</script></body></html>`;

for (const theme of ['dark', 'light']) {
  for (const width of [390, 1280]) {
    test(`${theme} at ${width}px: the refresh icon is centred on main's text`, { skip: !chromeInstalled }, async () => {
      const dir = tempDir('mainpull-');
      const file = path.join(dir, 'page.html');
      fs.writeFileSync(file, FIXTURE(theme));
      const got = await chrome.probe(`file://${file}`, width);
      assert.ok(Math.abs(got.icon - got.text) <= 1, `icon centre ${got.icon} vs text centre ${got.text}`);
    });
  }
}
