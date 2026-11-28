// The + button stays hidden under the loading screen and shows once the board's first paint lifts it (app.js lift).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');

test('the + button is hidden while the board view carries the loading class', () => {
  assert.match(css, /\.view-board\.loading \.fab\s*\{\s*display:\s*none;?\s*\}/);
});
