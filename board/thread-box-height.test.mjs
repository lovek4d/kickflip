// On a phone the thread reply box is as tall as the New task box (4 rows); on desktop it keeps its 2 rows.
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

const FIXTURE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}style.css"></head>
<body><dialog open id="sheet" class="sheet"><form id="askForm"><div class="dz"><textarea id="askText" rows="4"></textarea></div></form></dialog>
<form data-reply="x"><div class="dz bare"><textarea id="reply" rows="2"></textarea></div></form>
<script>{
  const h = (id) => document.getElementById(id).getBoundingClientRect().height;
  const probe = document.createElement('pre'); probe.id = 'probe'; probe.textContent = JSON.stringify({ ask: h('askText'), reply: h('reply') }); document.body.append(probe);
}</script></body></html>`;

for (const [width, same] of [[390, true], [1280, false]]) {
  test(`at ${width}px the thread box ${same ? 'matches' : 'is shorter than'} the New task box`, { skip: !chromeInstalled }, async () => {
    const dir = tempDir('tbox-');
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, FIXTURE);
    const got = await chrome.probe(`file://${file}`, width);
    if (same) assert.ok(Math.abs(got.reply - got.ask) < 1, `reply ${got.reply}px vs ask ${got.ask}px`);
    else assert.ok(got.reply < got.ask, `reply ${got.reply}px vs ask ${got.ask}px`);
  });
}
