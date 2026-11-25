// docs/adr/2026-11-15-1200-an-event-with-no-task-waits-on-the-orchestrator-until-acted-on.md: pr-review, review-answer,
// arch-review and slack-question are orchestrator waits, as an overnight triage is, each until the command that acts
// on it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventWaits } from './domain.mjs';

const AT = '2026-11-15T10:00:00.000Z';
const LATER = '2026-11-15T10:20:00.000Z';
const pr = { number: 12, title: 'Fix limiter', head: 'aaa', url: 'https://github.com/o/r/pull/12' };
const incoming = { repo: 'o/r', prs: [pr] };
const brief = (waits) => waits.map(({ key, ref, kind, since, picked, link }) => ({ key, ref, kind, since, picked, link }));

test('a pr-review waits until review post or review record records a review at its head', () => {
  const events = [{ id: 'e1', ts: AT, kind: 'pr-review', data: { pr: 12, head: 'aaa', title: 'Fix limiter' } }];
  const waits = eventWaits(events, { incoming });
  assert.deepEqual(brief(waits), [{ key: 'e1', ref: 'PR #12', kind: 'pr-review', since: AT, picked: null, link: '#review=12' }]);
  assert.match(waits[0].next, /as SKILL\.md's Incoming reviews says: review overlap 12 first, then review post 12 --file <review\.md> --read-at <time>/);
  assert.match(waits[0].next, /review record 12 --state posted\|needs/);
  assert.deepEqual(eventWaits(events, { incoming, reviews: { 12: { number: 12, head: 'aaa', state: 'posted', at: LATER } } }), []);
  // A review recorded at an older head, or before the ask, leaves it waiting.
  assert.equal(eventWaits(events, { incoming, reviews: { 12: { number: 12, head: 'old', state: 'posted', at: LATER } } }).length, 1);
  assert.equal(eventWaits(events, { incoming, reviews: { 12: { number: 12, head: 'aaa', state: 'posted', at: '2026-11-15T09:00:00.000Z' } } }).length, 1);
  // A PR the hub no longer lists has nothing left to review.
  assert.deepEqual(eventWaits(events, { incoming: { repo: 'o/r', prs: [] } }), []);
});

test('a review-failed waits until the held review is recorded again; the owner\'s review-answer waits on nobody', () => {
  const held = { 12: { number: 12, head: 'aaa', state: 'needs', at: AT } };
  for (const answer of ['post', 'skip']) {
    const events = [{ id: 'e2', ts: LATER, kind: 'review-failed', data: { pr: 12, answer, error: 'gh down' } }];
    const waits = eventWaits(events, { incoming, reviews: held });
    assert.deepEqual(brief(waits), [{ key: 'e2', ref: 'PR #12', kind: 'review-failed', since: LATER, picked: null, link: '#review=12' }]);
    assert.match(waits[0].title, /failed on the held review of PR #12: gh down/);
    assert.match(waits[0].next, answer === 'post' ? /review post 12 --file/ : /review record 12 --state posted/);
    assert.deepEqual(eventWaits(events, { incoming, reviews: { 12: { ...held[12], state: 'posted', at: '2026-11-15T10:30:00.000Z' } } }), []);
    assert.deepEqual(eventWaits([{ id: 'e3', ts: LATER, kind: 'review-answer', data: { pr: 12, answer } }], { incoming, reviews: held }), []);
  }
});

test("an arch-review waits until its audit task asks its findings or closes, and links that task", () => {
  const events = [{ id: 'e3', ts: AT, kind: 'arch-review', data: { key: 'w/T-9', repo: '/code/kickflip', branch: 'main' } }];
  const audit = { key: 'w/T-9', ref: 'T-9', lane: 'progress' };
  const waits = eventWaits(events, { items: [audit] });
  assert.deepEqual(brief(waits), [{ key: 'e3', ref: 'T-9', kind: 'arch-review', since: AT, picked: null, link: '#selectedCard=w%2FT-9' }]);
  assert.match(waits[0].next, /question add/);
  assert.deepEqual(eventWaits(events, { items: [{ ...audit, questions: { open: 2, first: 'q1' } }] }), []);
  assert.deepEqual(eventWaits(events, { items: [{ ...audit, lane: 'done' }] }), []);
  assert.deepEqual(eventWaits(events, { items: [] }), [], 'an audit task gone from the board has nothing to wait on');
});

test('a slack-question waits until a slack command records it handled: slack-handled names its event', () => {
  const asked = { id: 'e4', ts: AT, kind: 'slack-question', data: { reviewer: 'Ann', from: 'reviewer', answer: true } };
  const quiet = { id: 'e5', ts: AT, kind: 'slack-question', data: { reviewer: 'Ann', from: 'owner', answer: false } };
  const waits = eventWaits([asked, quiet]);
  assert.deepEqual(brief(waits), [
    { key: 'e4', ref: 'Slack · Ann', kind: 'slack-question', since: AT, picked: null, link: '' },
    { key: 'e5', ref: 'Slack · Ann', kind: 'slack-question', since: AT, picked: null, link: '' },
  ]);
  assert.match(waits[0].next, /slack answer e4 --text .*slack task e4 <file>.*slack skip e4/);
  assert.match(waits[1].next, /slack thread e5/);
  const handled = (id) => ({ id: `h-${id}`, ts: LATER, kind: 'slack-handled', data: { id, by: 'answer' } });
  assert.deepEqual(eventWaits([asked, quiet, handled('e4')]).map((w) => w.key), ['e5']);
  assert.deepEqual(eventWaits([asked, quiet, handled('e4'), handled('e5')]), []);
});

test('the waits come in event order across kinds', () => {
  const events = [
    { id: 's1', ts: '2026-11-15T09:00:00.000Z', kind: 'slack-question', data: { reviewer: 'Ann', answer: true } },
    { id: 'p1', ts: AT, kind: 'pr-review', data: { pr: 12, head: 'aaa' } },
  ];
  assert.deepEqual(eventWaits(events, { incoming }).map((w) => w.key), ['s1', 'p1']);
});
