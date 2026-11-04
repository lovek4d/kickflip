import test from 'node:test';
import assert from 'node:assert/strict';
import { cardPRs, storedPRs, hasPR, parsePRRef, leastReady, allLanded, prKeyOf } from './card-prs.mjs';

test("cardPRs reads the list, a PR stored without a repo and an older pr: <n> as in the board's repo", () => {
  const prs = [{ repo: 'o/r', number: 6 }, { repo: 'o/site', number: 1 }];
  assert.deepEqual(cardPRs({ prs }, 'o/r'), prs);
  assert.deepEqual(cardPRs({ prs }, null), prs);
  assert.deepEqual(cardPRs({ prs: [{ number: 6 }, prs[1]] }, 'o/r'), prs);
  assert.deepEqual(cardPRs({ prs: [{ number: 6 }, prs[1]] }, null), [prs[1]]);
  assert.deepEqual(cardPRs({ pr: 6 }, 'o/r'), [{ repo: 'o/r', number: 6 }]);
  assert.deepEqual(cardPRs({ pr: 6 }, null), []);
  assert.deepEqual(cardPRs({}, 'o/r'), []);
  assert.deepEqual(storedPRs({ pr: 6 }), [{ number: 6 }]);
  assert.equal(prKeyOf(prs[1]), 'o/site#1');
  assert.deepEqual([hasPR({ prs }), hasPR({ pr: 6 }), hasPR({}), hasPR({ prs: [] })], [true, true, false, false]);
});

test("parsePRRef takes owner/repo#n, or a bare number, stored without a repo as the board's", () => {
  assert.deepEqual(parsePRRef('lovek4d/lovek4d.github.io#1'), { repo: 'lovek4d/lovek4d.github.io', number: 1 });
  assert.deepEqual(parsePRRef('6'), { number: 6 });
  assert.deepEqual(parsePRRef(6), { number: 6 });
  for (const bad of ['abc', '0', 'o/r#', 'o#3', 'o/r#-1', 'https://github.com/o/r/pull/3']) assert.equal(parsePRRef(bad), null, bad);
});

test('the least-ready PR decides, and a card whose PRs all finished reads merged when one merged', () => {
  const open = { state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED' };
  const approved = { ...open, reviewDecision: 'APPROVED' };
  const draft = { ...open, isDraft: true };
  const red = { ...approved, checks: { state: 'fail' } };
  const merged = { state: 'MERGED' };
  const closed = { state: 'CLOSED' };
  assert.equal(leastReady([merged, approved, open]), 2);
  assert.equal(leastReady([approved, draft]), 1);
  assert.equal(leastReady([approved, red]), 1);
  assert.equal(leastReady([approved, { ...open, failing: ['ci'] }]), 1);
  assert.equal(leastReady([merged, null]), 1);
  assert.equal(leastReady([approved, approved]), 0);
  assert.equal(leastReady([closed, merged]), 1);
  assert.equal(leastReady([closed, closed]), 0);
  assert.equal(leastReady([]), -1);
  assert.equal(allLanded([closed, merged]), true);
  assert.equal(allLanded([merged, merged]), true);
  assert.equal(allLanded([closed, closed]), false);
  assert.equal(allLanded([merged, open]), false);
  assert.equal(allLanded([merged, null]), false);
  assert.equal(allLanded([]), false);
});
