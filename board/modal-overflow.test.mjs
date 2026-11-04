import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = (file) => fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8');

test('sheets and settings modals clip sideways overflow and wrap long text', () => {
  const rules = css('style.css');
  assert.match(rules, /\.sheet, \.settings-modal \{ overflow-x: hidden; overflow-wrap: anywhere; \}/);
  assert.match(rules, /\.settings-body \{ overflow-x: hidden; overflow-wrap: anywhere; \}/);
});

test('code inside hub modals wraps instead of holding its full width', () => {
  assert.match(css('hub.css'), /\.hub-view :is\(\.hub-modal, \.sheet\) code \{ white-space: pre-wrap; overflow-wrap: anywhere; \}/);
});
