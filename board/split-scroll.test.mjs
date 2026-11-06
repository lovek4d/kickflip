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

test('the Send bar ends its page and its pane: no padding runs on below it', () => {
  const pane = css.match(/\.needs-pane \{[^}]*sticky[^}]*\}/)[0];
  assert.match(pane, /padding: 12px 16px 0;/);
  const page = css.match(/body \.view-questions main \{[^}]*\}/)[0];
  assert.match(page, /padding-bottom: var\(--app-bottom, 0px\)/);
  assert.ok(css.indexOf(page) > css.indexOf('body.has-sidebar > :not(.sidebar) > main {'), 'it comes after the phone rule it overrides');
});
