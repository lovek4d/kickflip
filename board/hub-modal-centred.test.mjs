// On the hub page there is no pane, so from 900px a hub sheet is a centred modal, not the right pane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./public/hub.css', import.meta.url), 'utf8');
const block = css.match(/@media \(min-width: 900px\) \{\s*\.hub-view \.hub-modal\.settings-modal \{[^]*?\n\}/)?.[0] ?? '';

test('from 900px a hub modal is centred, width capped, with its backdrop kept', () => {
  assert.match(block, /inset: 0; margin: auto/);
  assert.match(block, /width: min\(680px/);
  assert.match(block, /border-radius: 18px/);
  assert.doesNotMatch(block, /::backdrop/);
});

test('it outranks the right-pane rule and does not slide in', () => {
  assert.match(block, /\[open\] \{ animation: none/);
});
