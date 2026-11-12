// docs/adr/2026-11-12-1110-a-test-waits-on-state-and-fails-only-at-5x-its-budget.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './test-helpers.mjs';

test('until waits past its budget with a warning, and fails only at 5× the budget', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  let polls = 0;
  const slow = Date.now() + 120;
  await until(() => { polls++; return Date.now() >= slow; }, 'the slow state', 50);
  assert.ok(polls > 1);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /^the slow state: took \d+ ms, past its 50 ms budget$/);
  await until(() => true, 'the quick state', 50);
  assert.equal(warn.mock.callCount(), 1, 'a wait inside its budget says nothing');
  const started = Date.now();
  await assert.rejects(until(() => false, 'the state that never comes', 50), { message: 'the state that never comes' });
  assert.ok(Date.now() - started >= 250);
});
