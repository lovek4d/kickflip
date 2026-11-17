// docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md: the board filter's boxes, what each matches,
// and that an unchecked box hides every card it matches, boxes overlapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout });
for (const file of ['ui-icon-text.js', 'ui.js', 'ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) {
  vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
}
const { FILTER_BOXES, filterHides, filterOnly, filterCounts } = context.BoardUI;

const card = (key, it) => ({ key, lane: 'todo', phase: 'ready', blocked: false, action: null, questions: null, ...it });
const CARDS = [
  card('R', { phase: 'ready' }),
  card('S', { phase: 'staging', action: { kind: 'implement' } }),
  card('D', { phase: 'discussing' }),
  card('G', { phase: 'grilling', action: { kind: 'questions' }, questions: { state: 'open', open: 2 } }),
  card('P', { phase: 'prototyping', action: { kind: 'pick' } }),
  card('B', { phase: 'ready', blocked: true }),
  card('A', { phase: 'grilling', questions: { state: 'open', open: 1 } }),
  card('M', { lane: 'review', phase: 'ready', action: { kind: 'merge' } }),
  card('W', { lane: 'progress', phase: 'ready' }),
  card('X', { lane: 'done', phase: 'discussing', questions: { state: 'resolved', open: 0 } }),
];
const shown = (off) => CARDS.filter((it) => !filterHides(it, off)).map((it) => it.key).join('');

test('the filter has four boxes in order: Ready, Action needed, Questions, Blocked', () => {
  assert.deepEqual([...FILTER_BOXES.map((b) => b.name)], ['Ready', 'Action needed', 'Questions', 'Blocked']);
});

test('each box matches its cards, a card matching several or none: Ready only in Todo', () => {
  const of = (id) => CARDS.filter(FILTER_BOXES.find((b) => b.id === id).matches).map((it) => it.key).join('');
  assert.equal(of('ready'), 'RS');
  assert.equal(of('action'), 'SM');
  assert.equal(of('questions'), 'GPA');
  assert.equal(of('blocked'), 'B');
});

test('all boxes checked hides nothing; each unchecked box hides every card it matches, whatever else it matches', () => {
  assert.equal(shown([]), 'RSDGPBAMWX');
  assert.equal(shown(['blocked']), 'RSDGPAMWX');
  assert.equal(shown(['questions']), 'RSDBMWX', 'a question card hides');
  assert.equal(shown(['action', 'ready']), 'DGPBAWX');
});

test('showing only some boxes unchecks every other; the cards no box matches stay', () => {
  assert.deepEqual([...filterOnly(['questions'])], ['ready', 'action', 'blocked']);
  assert.deepEqual([...filterOnly(['action', 'questions'])], ['ready', 'blocked']);
  assert.equal(shown(filterOnly(['action'])), 'DMWX', 'the staging card is also Ready, so it hides; a discussing card no box matches stays');
});

test('the counts are each box matches across the cards', () => {
  assert.deepEqual({ ...filterCounts(CARDS) }, { ready: 2, action: 2, questions: 3, blocked: 1 });
});
// On a phone the filter's menu opens upward from the bottom bar and scrolls when the window is too short: it is a
// popup, and popup.test.mjs holds its placing.

// The pane's chips glow while the filter shows only their box (app-lanes.js showsOnly, app-pane.js).
test('a chip is on only while the filter unchecks exactly every other box', () => {
  const lanes = fs.readFileSync(new URL('./public/app-lanes.js', import.meta.url), 'utf8');
  const pane = fs.readFileSync(new URL('./public/app-pane.js', import.meta.url), 'utf8');
  assert.match(lanes, /const showsOnly = /);
  assert.match(pane, /B\.showsOnly\(id\) \? ' on'/);
  assert.match(pane, /if \(B\.showsOnly\(chip\.dataset\.paneShow\)\) B\.clearFilter\(\)/);
});
