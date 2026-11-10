// The Send bar is the last thing on the Waiting on you page: main pads only the phone nav under it, in the app shell
// (body.has-sidebar > view root > main) as well as standalone, at 390px and on desktop.
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

const FIXTURE = (bodyClass) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}style.css"><link rel="stylesheet" href="${pub}sidebar.css"></head>
<body class="${bodyClass}"><div class="view-questions"><header class="top"></header><main><section id="page"><div class="bar"></div></section></main></div>
<script>addEventListener('load', () => setTimeout(() => {
  const cs = getComputedStyle(document.querySelector('.view-questions main'));
  const app = getComputedStyle(document.documentElement).getPropertyValue('--app-bottom').trim();
  document.body.insertAdjacentHTML('beforeend', '<pre id="probe">' + JSON.stringify({ pad: cs.paddingBottom, app }) + '</pre>');
}, 300))</script></body></html>`;

for (const [width, bodyClass, expected] of [[390, 'has-sidebar', '53px'],[1280, 'has-sidebar', '0px']]) {
  test(`at ${width}px (${bodyClass || 'standalone'}) the page ends at Send: main pads only the nav under it`, { skip: !fs.existsSync(CHROME) }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-'));
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, FIXTURE(bodyClass));
    const { stdout } = await promisify(execFile)(CHROME, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files', `--window-size=${width},900`,
      '--virtual-time-budget=4000', '--dump-dom', `file://${file}`], { encoding: 'utf8', timeout: 60000 });
    const got = JSON.parse(/<pre id="probe">(\{.*?\})<\/pre>/s.exec(stdout)[1].replace(/&quot;/g, '"'));
    assert.equal(got.pad, expected, `main pads ${got.pad} (--app-bottom ${got.app})`);
  });
}
