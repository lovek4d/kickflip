import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
const rule = (selector) => css.split('\n').find((l) => l.startsWith(`${selector} {`)) ?? '';

test('a thread message name is the larger header with the rule under it; its time is a small footer without one', () => {
  assert.match(rule('.msg .who'), /font-size: 12px/);
  assert.match(rule('.msg .who'), /border-bottom: 1px solid var\(--line\)/);
  assert.doesNotMatch(rule('.msg .reply'), /border-top/);
  assert.match(rule('.msg .reply.msg-foot'), /font-size: 11px/);
  assert.doesNotMatch(rule('.msg .reply.msg-foot'), /border/);
});
