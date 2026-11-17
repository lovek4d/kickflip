// Waiting on you's page and the desktop pane: the pane scrolls on its own, nothing pads on below either, and the
// board's ? shows at every width.
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

test('the Send bar ends its page and its pane: no padding runs on below it', () => {
  const pane = css.match(/\.board-pane \{[^}]*sticky[^}]*\}/)[0];
  assert.match(pane, /padding: 12px 16px 0;/);
  const page = css.match(/body \.view-questions\.view-questions main \{[^}]*\}/)[0];
  assert.match(page, /padding-bottom: var\(--app-bottom, 0px\)/);
  assert.ok(css.indexOf(page) > css.indexOf('body.has-sidebar > :not(.sidebar) > main {'), 'it comes after the phone rule it overrides');
});

// docs/adr/2026-11-12-2330-the-desktop-pane-is-back-without-the-needs-you-deck.md
test('no width hides the question mark: on a desktop it opens its topic in the pane', () => {
  assert.doesNotMatch(css, /pages-switch \{ display: none; \}/);
});

test('the desktop right pane never scrolls sideways: its content wraps to the pane width', () => {
  const wide = css.slice(css.indexOf('@media (min-width: 900px) {\n  .split'));
  const pane = wide.match(/\.board-pane \{[^}]*\}/)[0];
  assert.match(pane, /overflow-x: hidden/);
  assert.match(wide, /\.board-pane \* \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
  assert.match(wide, /\.board-pane pre[^{]*\{[^}]*white-space: pre-wrap;/);
});
