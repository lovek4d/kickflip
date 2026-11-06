import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8');

test('at phone width every box in the stage is capped to the stage, so a fixed-width panel stacks and is not cut off', () => {
  assert.match(read('prototype.html'), /@media \(max-width: 599px\) \{ #stage :where\([^)]*div[^)]*\) \{[^}]*max-width: 100%[^}]*min-width: 0/);
});

test('the viewer note field is at least 16px, so iOS Safari does not zoom on focus', () => {
  const rule = read('prototype-switcher.js').match(/\.ps-switch \.ps-text \{[^}]*\}/)?.[0] ?? '';
  const px = Number(rule.match(/font:\s*\d+\s+(\d+)px/)?.[1]);
  assert.ok(px >= 16, `font is ${px}px`);
});

test('every input, select and textarea in the stage is 16px', () => {
  assert.match(read('prototype.html'), /#stage :where\(input, select, textarea\) \{[^}]*font-size: 16px/);
});
