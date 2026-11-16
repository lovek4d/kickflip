import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');

test("a card header's empty bump icon shows only while the header is hovered, not while it holds focus", () => {
  const block = css.match(/@media \(hover: hover\) \{\n([^}]*\}[^}]*\})\n\}/s)?.[1] ?? '';
  assert.match(block, /summary:hover button\[data-card-bump\]:not\(\.bumped\)\s*\{ opacity: 1; \}/);
  assert.doesNotMatch(block, /focus/);
  assert.doesNotMatch(block, /\.item:hover/);
});
