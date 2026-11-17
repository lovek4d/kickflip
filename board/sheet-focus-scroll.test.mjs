// A sheet with a keyboard focuses its field without scrolling: iOS otherwise scrolls the board behind the sheet to bring the
// field above the keyboard, then it settles back (dialogs.js fitSheet pins the scroll afterwards).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = (name) => fs.readFileSync(fileURLToPath(new URL(`./public/${name}`, import.meta.url)), 'utf8');

test('New task, search and Close board focus their field with preventScroll', () => {
  const calls = [
    ['new-task.js', "$('#askText').focus("],
    ['app-search.js', 'field.focus('],
    ['view-settings.js', 'typed.focus('],
  ];
  for (const [file, call] of calls) {
    const text = src(file);
    const at = text.indexOf(call);
    assert.notEqual(at, -1, `${file} focuses its field`);
    assert.ok(text.startsWith('{ preventScroll: true })', at + call.length), `${file} focus doesn't scroll the page`);
  }
});
