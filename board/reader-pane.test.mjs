// On a desktop window the reader sheet is a panel over the right half where Waiting on you sits, at the width the
// lanes | pane seam gives that half; below 900px it stays the phone sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
const wide = css.slice(css.indexOf('@media (min-width: 900px) {\n  .split'));
const panel = wide.match(/\.sheet\.reader-sheet \{[^}]*\}/)?.[0] ?? '';

test('the reader takes the right pane: below the header, to the right edge, at the pane width', () => {
  assert.match(panel, /inset: 56px 0 0 auto/);
  assert.match(panel, /width: var\(--pane-w, calc\(\(100vw - var\(--sidebar-w, 0px\)\) \/ 2\)\)/);
  assert.match(panel, /max-width: none/);
  assert.match(panel, /border-radius: 0/);
});

test('the board stays visible beside it and it slides in from the right', () => {
  assert.match(wide, /\.reader-sheet::backdrop \{[^}]*background: transparent/);
  assert.match(wide, /\.sheet\.reader-sheet\[open\] \{ animation: reader-in/);
  assert.match(css, /@keyframes reader-in \{ from \{ transform: translateX\(100%\); \} \}/);
});

test('the phone sheet rules stay outside the desktop media query', () => {
  assert.match(css.slice(0, css.indexOf('@media (min-width: 900px) {\n  .split')), /\.reader-sheet \{ height: 85dvh;/);
});
