// The desktop pane scrolls on its own and never sideways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');

test('the desktop right pane is its own scroller that does not chain into the page', () => {
  const split = css.match(/@media \(min-width: 900px\) \{\s*\.split \{[\s\S]*?\n\}/)[0];
  const pane = split.match(/\.board-pane \{[^}]*\}/)[0];
  assert.match(pane, /overflow-y: auto/);
  assert.match(pane, /overscroll-behavior: contain/);
});

test('the desktop right pane never scrolls sideways: its content wraps to the pane width', () => {
  const wide = css.slice(css.indexOf('@media (min-width: 900px) {\n  .split'));
  const pane = wide.match(/\.board-pane \{[^}]*\}/)[0];
  assert.match(pane, /overflow-x: hidden/);
  assert.match(wide, /\.board-pane \* \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
  assert.match(wide, /\.board-pane pre[^{]*\{[^}]*white-space: pre-wrap;/);
});

test('the desktop board column is its own scroller below the header, so its bar sits on the left pane edge and the window never scrolls', () => {
  const wide = css.slice(css.indexOf('@media (min-width: 900px) {\n  .split'));
  const main = wide.match(/\.split > main \{[^}]*\}/)[0];
  assert.match(main, /height: calc\(100vh - 56px\)/);
  assert.match(main, /overflow-y: auto/);
  assert.match(main, /overscroll-behavior: contain/);
  assert.match(wide, /html:has\(\.view-board:not\(\[hidden\]\)\) \{ overflow: hidden; \}/);
});
