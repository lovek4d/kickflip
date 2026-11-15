// The header's ? with its open-question count shows on phone widths only: from 900px the Waiting on you pane is
// already beside the lanes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');

test('the header ? is hidden from 900px, the width that places Waiting on you beside the lanes', () => {
  assert.match(css, /@media \(min-width: 900px\) \{[^@]*\.top #questionsLink \{ display: none; \}/);
});

test('the ? is not hidden below 900px', () => {
  assert.doesNotMatch(css, /@media \(max-width: 899px\) \{[^@]*#questionsLink \{ display: none/);
  assert.doesNotMatch(css.replace(/@media \(min-width: 900px\) \{[^@]*\}/g, ''), /#questionsLink \{ display: none/);
});
