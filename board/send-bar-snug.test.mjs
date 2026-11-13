// The Send bar is the last thing on the Waiting on you page: main pads only the phone nav under it, in the app shell
// (body.has-sidebar > view root > main) as well as standalone, at 390px and on desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';

const chrome = sharedChrome();

const pub = fileURLToPath(new URL('./public/', import.meta.url));

const FIXTURE = (bodyClass) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}style.css"><link rel="stylesheet" href="${pub}sidebar.css"></head>
<body class="${bodyClass}"><div class="view-questions"><header class="top"></header><main><section id="page"><div class="bar"></div></section></main></div>
<script>{
  const cs = getComputedStyle(document.querySelector('.view-questions main'));
  const app = getComputedStyle(document.documentElement).getPropertyValue('--app-bottom').trim();
  const probe = document.createElement('pre'); probe.id = 'probe'; probe.textContent = JSON.stringify({ pad: cs.paddingBottom, app }); document.body.append(probe);
}</script></body></html>`;

for (const [width, bodyClass, expected] of [[390, 'has-sidebar', '53px'],[1280, 'has-sidebar', '0px']]) {
  test(`at ${width}px (${bodyClass || 'standalone'}) the page ends at Send: main pads only the nav under it`, { skip: !chromeInstalled }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-'));
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, FIXTURE(bodyClass));
    const got = await chrome.probe(`file://${file}`, width);
    assert.equal(got.pad, expected, `main pads ${got.pad} (--app-bottom ${got.app})`);
  });
}
