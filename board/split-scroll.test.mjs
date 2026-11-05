// On the desktop split view the right pane scrolls on its own: reaching its end never chains into the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');

test('the desktop right pane is its own scroller that does not chain into the page', () => {
  const split = css.match(/@media \(min-width: 900px\) \{\s*\.split \{[\s\S]*?\n\}/)[0];
  const pane = split.match(/\.needs-pane \{[^}]*\}/)[0];
  assert.match(pane, /overflow-y: auto/);
  assert.match(pane, /overscroll-behavior: contain/);
});
