// The board menu opens upward from the header where the header sits at the bottom (a phone), under it on desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const chrome = sharedChrome();
const pub = fileURLToPath(new URL('./public/', import.meta.url));

const FIXTURE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}style.css"></head>
<body><header class="top"><div class="brand"><h1><button class="title-menu">Board</button></h1>
<div id="boardMenu" class="board-menu" role="menu"><button class="board-menu-item">Join in terminal</button><button class="board-menu-item">Settings</button></div></div><div class="nav"></div></header>
<main style="height:2000px"></main>
<script>{
  const top = document.querySelector('.top').getBoundingClientRect();
  const m = document.getElementById('boardMenu').getBoundingClientRect();
  const probe = document.createElement('pre'); probe.id = 'probe';
  probe.textContent = JSON.stringify({ menuTop: m.top, menuBottom: m.bottom, headerTop: top.top, headerBottom: top.bottom });
  document.body.append(probe);
}</script></body></html>`;

for (const [width, up] of [[390, true], [1280, false]]) {
  test(`at ${width}px the board menu opens ${up ? 'above' : 'below'} the header, inside the viewport`, { skip: !chromeInstalled }, async () => {
    const file = path.join(tempDir('menu-flip-'), 'page.html');
    fs.writeFileSync(file, FIXTURE);
    const got = await chrome.probe(`file://${file}`, width);
    if (up) {
      assert.ok(got.menuBottom <= got.headerTop, `menu bottom ${got.menuBottom} is above the header top ${got.headerTop}`);
      assert.ok(got.menuTop >= 0, `menu top ${got.menuTop} is on screen`);
    } else {
      assert.ok(got.menuTop >= got.headerBottom - 1, `menu top ${got.menuTop} is under the header bottom ${got.headerBottom}`);
    }
  });
}
