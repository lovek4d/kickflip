import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');

// docs/adr/2026-11-17-1100-a-cards-menu-narrows-the-board-to-its-chain.md: the "…" holds the bump.
test("a card header's \"…\" shows only while the header is hovered, bumped or its menu open, not while it holds focus", () => {
  const block = css.match(/@media \(hover: hover\) \{\n([^}]*\}[^}]*\})\n\}/s)?.[1] ?? '';
  assert.match(block, /\.item button\[data-card-menu\]:not\(\.bumped, \[aria-expanded="true"\]\)\s*\{ opacity: 0; \}/);
  assert.match(block, /summary:hover button\[data-card-menu\]\s*\{ opacity: 1; \}/);
  assert.doesNotMatch(block, /focus/);
  assert.doesNotMatch(block, /\.item:hover/);
});
