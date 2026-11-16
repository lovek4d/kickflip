// An icon and the word after it have one 5px gap between them, from the icon helper's own CSS, whatever the line around
// them is laid out as: the helper's own word (inside .it), a working dot or still dot with the word after it as a sibling,
// and a mark (.mark > .it) with none of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const chrome = sharedChrome();
const pub = fileURLToPath(new URL('./public/', import.meta.url));
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(pub, 'ui-icon-text.js'), 'utf8'), context);
const { iconText, ICON_COLOURS } = context.BoardUI;

const css = fs.readFileSync(path.join(pub, 'sidebar.css'), 'utf8');
test('the helper owns the gap: 5px inside, 5px after an icon alone, and no per-place stand-in', () => {
  assert.match(css, /\.it \{[^}]*gap: 5px;/);
  assert.match(css, /\.it:where\(:not\(:has\(\.it-w\)\)\) \{ margin-right: 5px; \}/);
  assert.doesNotMatch(css, /\.it-current \{[^}]*gap: 0/);
  const style = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  assert.doesNotMatch(style, /\.it-(pulse|dot)\.it-current \{[^}]*margin-right/);
});

// One line per way the board lays a dot and its word out: the line is plain inline, so only the helper's CSS can make the gap.
const CASES = [
  ...['dot', 'pulse'].flatMap((shape) => ICON_COLOURS.map((c) => [`${shape} ${c} with its word inside`, iconText(shape, c, 'word')])),
  ...['dot', 'pulse'].flatMap((shape) => ['current', ...ICON_COLOURS].map((c) => [`${shape} ${c} alone, then a word`, `${iconText(shape, c, '')}word`])),
];
const FIXTURE = `<!doctype html><html><head><link rel="stylesheet" href="${pub}colors.css"><link rel="stylesheet" href="${pub}sidebar.css"><link rel="stylesheet" href="${pub}style.css"></head><body>
${CASES.map(([, html], i) => `<div class="line" id="c${i}">${html}</div>`).join('\n')}
<div id="m"><span class="mark" aria-hidden="true">${iconText('dot', 'current', '')}</span>word</div>
<script>{
  const out = {};
  for (const el of document.querySelectorAll('.line')) {
    const icon = el.querySelector('.it-i').getBoundingClientRect();
    const inner = el.querySelector('.it-w');
    const range = document.createRange();
    const text = inner ? inner.getBoundingClientRect() : (range.selectNodeContents(el.lastChild), range.getBoundingClientRect());
    out[el.id] = text.left - icon.right;
  }
  const mark = document.querySelector('.mark').getBoundingClientRect();
  const r = document.createRange(); r.selectNodeContents(document.getElementById('m').lastChild);
  out.mark = r.getBoundingClientRect().left - mark.right;
  const probe = document.createElement('pre'); probe.id = 'probe'; probe.textContent = JSON.stringify(out); document.body.append(probe);
}</script></body></html>`;

test('every dot the helper draws sits 5px from its word, and a mark keeps its own 5px', { skip: !chromeInstalled }, async () => {
  const file = path.join(tempDir('icon-gap-'), 'page.html');
  fs.writeFileSync(file, FIXTURE);
  const got = await chrome.probe(`file://${file}`, 600);
  CASES.forEach(([name], i) => assert.ok(Math.abs(got[`c${i}`] - 5) < 0.5, `${name}: ${got[`c${i}`]}px`));
  assert.ok(Math.abs(got.mark - 5) < 0.5, `mark: ${got.mark}px`);
});
