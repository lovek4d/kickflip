// From 900px a settings modal (the hub's and the board's) is a centred modal, not the right pane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
const block = css.match(/@media \(min-width: 900px\) \{\n  \.split[^]*?\n  \.settings-modal, \.sheet\.arch-sheet \{[^]*?\n  \.settings-modal\[open\][^\n]*/)?.[0] ?? '';

test('from 900px a hub modal is centred, width capped, with its backdrop kept', () => {
  assert.match(block, /inset: 0; margin: auto/);
  assert.match(block, /width: min\(680px/);
  assert.match(block, /border-radius: 18px/);
  assert.doesNotMatch(block, /::backdrop/);
});

test('it does not slide in', () => {
  assert.match(block, /\[open\][^\n]*\{ animation: none/);
});
