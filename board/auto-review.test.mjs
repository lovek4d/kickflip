import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewsOf, reviewNeeds, reviewActions } from './auto-review.mjs';

const now = Date.parse('2026-11-03T12:00:00Z');
const ago = (min) => new Date(now - min * 60000).toISOString();
const pr = (number, over = {}) => ({ number, title: `PR ${number}`, author: 'quinn', url: `https://github.com/o/r/pull/${number}`, head: `h${number}`, touches: ['w/A1'], asked: false, ...over });
const incoming = (...prs) => ({ at: ago(4), repo: 'o/r', prs });
const refs = new Map([['w/A1', '#41'], ['w/A2', '#47']]);
const sent = (number, head, min, id = `e${number}`) => ({ id, ts: ago(min), kind: 'pr-review', data: { pr: number, head } });
const record = (number, over = {}) => ({ ...pr(number), state: 'posted', text: 'Looks fine.', at: ago(30), ...over });
const of = (over = {}) => reviewsOf({ on: true, incoming: null, records: {}, events: [], refs, now, ...over });

test('nothing polled yet shows the empty lane while on, and no lane while off', () => {
  assert.deepEqual(of(), { on: true, shown: true, at: null, repo: null, cards: [], earlier: [], waiting: 0, due: null });
  assert.equal(of({ on: false }).shown, false);
});

test('an incoming PR nobody has reviewed is due, asked ones first, and it is not yet a card', () => {
  const r = of({ incoming: incoming(pr(440), pr(442, { asked: true })) });
  assert.deepEqual([r.cards, r.waiting, r.due.number, r.at, r.repo], [[], 2, 442, ago(4), 'o/r']);
  assert.equal(of({ on: false, incoming: incoming(pr(440)) }).due, null, 'off sends nothing');
});

test('a sent pr-review reads reviewing until a review is recorded at that head, and holds the next one', () => {
  const r = of({ incoming: incoming(pr(440), pr(442)), events: [sent(440, 'h440', 2)] });
  assert.deepEqual(r.cards.map((c) => [c.number, c.state, c.at]), [[440, 'reviewing', ago(2)]]);
  assert.deepEqual(r.cards[0].touches, [{ key: 'w/A1', ref: '#41' }]);
  assert.deepEqual([r.waiting, r.due], [1, null]);
  const done = of({ incoming: incoming(pr(440), pr(442)), events: [sent(440, 'h440', 2)], records: { 440: record(440, { at: ago(1) }) } });
  assert.deepEqual(done.cards.map((c) => [c.number, c.state]), [[440, 'posted']]);
  assert.equal(done.due.number, 442);
});

test('a new head on a posted PR is due again; a held one waits on the owner', () => {
  const moved = of({ incoming: incoming(pr(431, { head: 'new' })), records: { 431: record(431, { head: 'old' }) } });
  assert.deepEqual([moved.cards[0].state, moved.due.number], ['posted', 431]);
  const held = of({ incoming: incoming(pr(437, { head: 'new' })), records: { 437: record(437, { state: 'needs', head: 'old' }) } });
  assert.deepEqual([held.cards[0].state, held.due], ['needs', null]);
});

test("the owner's answer to a held review leaves it held; one the server failed to apply shows its error until recorded again", () => {
  const answer = { id: 'a1', ts: ago(5), kind: 'review-answer', data: { pr: 437, answer: 'post' } };
  const failed = { id: 'f1', ts: ago(4), kind: 'review-failed', data: { pr: 437, answer: 'post', error: 'gh down' } };
  const records = { 437: record(437, { state: 'needs', at: ago(10) }) };
  assert.deepEqual([of({ incoming: incoming(pr(437)), records, events: [answer] }).cards[0].state, of({ incoming: incoming(pr(437)), records, events: [answer] }).cards[0].failure], ['needs', null]);
  const shown = of({ incoming: incoming(pr(437)), records, events: [answer, failed] }).cards[0];
  assert.deepEqual([shown.state, shown.failure], ['needs', 'gh down']);
  const recorded = of({ incoming: incoming(pr(437)), records: { 437: { ...records[437], state: 'posted', at: ago(1) } }, events: [answer, failed] }).cards[0];
  assert.deepEqual([recorded.state, recorded.failure], ['posted', null]);
});

test('cards run needs you, reviewing, posted; a posted review over a day old or on a closed PR folds under earlier', () => {
  const r = of({
    incoming: incoming(pr(431), pr(437), pr(440), pr(426)),
    records: { 431: record(431), 437: record(437, { state: 'needs' }), 426: record(426, { at: ago(26 * 60) }), 421: record(421, { at: ago(3 * 24 * 60) }), 423: record(423, { at: ago(2 * 24 * 60) }) },
    events: [sent(440, 'h440', 1)],
  });
  assert.deepEqual(r.cards.map((c) => [c.number, c.state]), [[437, 'needs'], [440, 'reviewing'], [431, 'posted']]);
  assert.deepEqual(r.earlier.map((c) => c.number), [426, 423, 421], 'newest first');
  assert.deepEqual([r.earlier[1].open, r.earlier[0].open], [false, true]);
});

test('a held review is a Needs you line and an owner action that pushes', () => {
  const r = of({ incoming: incoming(pr(437, { title: 'One endpoint' })), records: { 437: record(437, { state: 'needs', text: 'Clashes with #47.\n\nMore.' }) } });
  assert.deepEqual(reviewNeeds(r), [{ kind: 'Review', title: 'PR #437 One endpoint', text: 'PR #437 One endpoint · review held for you', url: '#review=437', review: 437 }]);
  assert.deepEqual(reviewActions(r), [{ tag: 'review-437', kind: 'review', title: 'PR #437: review held for you', body: 'Clashes with #47.', url: '#review=437', questions: [] }]);
});
