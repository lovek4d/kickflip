// The request row has the same space above (from the text box) and below (to Send, or the box's edge) in a thread's
// reply box, a question's box and the New task box, on a phone and on desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const chrome = sharedChrome();
const pub = fileURLToPath(new URL('./public/', import.meta.url));

const ROW = '<span class="request-row"><button class="req">Prototype</button><button class="req">Grill</button></span>';
const SENDS = '<div class="send-actions"><button>Implement</button><button>Discuss</button></div>';
const BOXES = {
  thread: `<form data-reply="x"><div class="dz"><textarea rows="2"></textarea></div><div class="pending-files" data-files></div><div class="row">${ROW}${SENDS}</div></form>`,
  question: `<div class="composer"><div class="dz"><textarea rows="2"></textarea></div><div class="note-tools"><div class="pending-files" data-files></div>${ROW}</div></div>`,
  'new task': `<form id="askForm"><div class="dz"><textarea rows="4"></textarea></div><div class="note-tools"><div class="pending-files" data-files></div>${ROW}</div>${SENDS}</form>`,
};

const FIXTURE = (box) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}style.css"></head><body><div id="box" style="width:340px">${box}</div>
<script>{
  const r = (el) => el.getBoundingClientRect();
  const row = r(document.querySelector('.request-row'));
  const above = row.top - r(document.querySelector('.dz')).bottom;
  const next = document.querySelector('.send-actions');
  const below = (next ? r(next).top : r(document.querySelector('#box > *')).bottom) - row.bottom;
  const probe = document.createElement('pre'); probe.id = 'probe'; probe.textContent = JSON.stringify({ above, below }); document.body.append(probe);
}</script></body></html>`;

for (const width of [390, 1280]) {
  for (const [name, box] of Object.entries(BOXES)) {
    test(`at ${width}px the ${name} box has equal space above and below its request row`, { skip: !chromeInstalled }, async () => {
      const file = path.join(tempDir('rrow-'), 'page.html');
      fs.writeFileSync(file, FIXTURE(box));
      const got = await chrome.probe(`file://${file}`, width);
      assert.ok(got.above > 0, `nothing above the row: ${got.above}px`);
      assert.ok(Math.abs(got.above - got.below) < 0.5, `above ${got.above}px, below ${got.below}px`);
    });
  }
}

// Outside New and Todo the request row is hidden; the thread box keeps its gap between the text box and Send.
const HIDDEN = `<!doctype html><html data-request-words="hidden"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${pub}style.css"></head><body><div id="box" style="width:340px">${BOXES.thread}</div>
<script>{
  const r = (el) => el.getBoundingClientRect();
  const gap = r(document.querySelector('.send-actions')).top - r(document.querySelector('.dz')).bottom;
  const probe = document.createElement('pre'); probe.id = 'probe'; probe.textContent = JSON.stringify({ gap }); document.body.append(probe);
}</script></body></html>`;

for (const width of [390, 1280]) {
  test(`at ${width}px a thread box with its request row hidden keeps the gap above Send`, { skip: !chromeInstalled }, async () => {
    const file = path.join(tempDir('rrow-'), 'page.html');
    fs.writeFileSync(file, HIDDEN);
    const got = await chrome.probe(`file://${file}`, width);
    assert.ok(got.gap >= 8, `gap above Send: ${got.gap}px`);
  });
}
