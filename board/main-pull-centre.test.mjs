// Main's bar is one line when it fits and wraps the commit group under the name when it doesn't, the state and Visit
// keeping line 1; its refresh icon sits centred on the commit's text, with the header's padding, in both themes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const chrome = sharedChrome();

const pub = fileURLToPath(new URL('./public/', import.meta.url));
const ICON = '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/></svg>';

const FIXTURE = (theme, slug) => `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}style.css"></head>
<body><div class="lane-github"><button class="ghost gh-refresh" type="button">${ICON}</button></div>
<div class="tb-main"><div class="tb-main-left"><div class="tb-main-name">${ICON}<span>${slug}</span></div><div class="tb-main-commit"><span class="tb-main-text"><strong>main</strong>@<code>427325d</code> <span class="muted">8m</span></span><span class="main-pull"><button class="ghost gh-refresh" type="button">${ICON}</button></span></div></div><div class="meta"><span>Updating…</span><a href="#">Visit</a></div></div>
<script>{
  const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
  const mid = (r) => r.top + r.height / 2;
  const pad = (sel) => getComputedStyle(document.querySelector(sel)).padding;
  const probe = document.createElement('pre'); probe.id = 'probe';
  probe.textContent = JSON.stringify({
    text: mid(rect('.tb-main-text strong')), icon: mid(rect('.tb-main .gh-refresh svg')),
    nameTop: rect('.tb-main-name').top, commitTop: rect('.tb-main-commit').top, metaTop: rect('.tb-main .meta').top,
    overflow: document.documentElement.scrollWidth > innerWidth,
    pad: pad('.tb-main .gh-refresh'), headerPad: pad('.lane-github .gh-refresh'),
  }); document.body.append(probe);
}</script></body></html>`;

const run = async (theme, width, slug) => {
  const dir = tempDir('mainpull-');
  const file = path.join(dir, 'page.html');
  fs.writeFileSync(file, FIXTURE(theme, slug));
  return chrome.probe(`file://${file}`, width);
};

for (const theme of ['dark', 'light']) {
  for (const width of [390, 1280]) {
    test(`${theme} at ${width}px: the refresh icon is centred on main's text with the header's padding`, { skip: !chromeInstalled }, async () => {
      const got = await run(theme, width, 'owner/repo');
      assert.ok(Math.abs(got.icon - got.text) <= 1, `icon centre ${got.icon} vs text centre ${got.text}`);
      assert.equal(got.pad, got.headerPad);
    });
  }
  test(`${theme}: the bar is one line at 1100px`, { skip: !chromeInstalled }, async () => {
    const got = await run(theme, 1100, 'owner/repo');
    assert.equal(got.commitTop, got.nameTop);
    assert.ok(Math.abs(got.metaTop - got.nameTop) <= 1);
  });
  test(`${theme}: at 390px with a long slug the commit group wraps under the name and the state stays on line 1`, { skip: !chromeInstalled }, async () => {
    const got = await run(theme, 390, 'a-very-long-organisation/an-even-longer-repository-name');
    assert.ok(got.commitTop > got.nameTop + 10, `commit ${got.commitTop} under name ${got.nameTop}`);
    assert.ok(Math.abs(got.metaTop - got.nameTop) <= 1);
    assert.equal(got.overflow, false);
  });
}
