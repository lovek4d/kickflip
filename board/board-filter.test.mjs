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

test('the filter has five boxes in order: Ready, Action needed, Questions, Discussing, Blocked', () => {
  assert.deepEqual([...FILTER_BOXES.map((b) => b.name)], ['Ready', 'Action needed', 'Questions', 'Discussing', 'Blocked']);
});

test('each box matches its cards, a card matching several or none: Ready and Discussing only in Todo, Discussing with grilling and prototyping', () => {
  const of = (id) => CARDS.filter(FILTER_BOXES.find((b) => b.id === id).matches).map((it) => it.key).join('');
  assert.equal(of('ready'), 'RS');
  assert.equal(of('action'), 'SM');
  assert.equal(of('questions'), 'GPA');
  assert.equal(of('discussing'), 'DGPA');
  assert.equal(of('blocked'), 'B');
});

test('all boxes checked hides nothing; each unchecked box hides every card it matches, whatever else it matches', () => {
  assert.equal(shown([]), 'RSDGPBAMWX');
  assert.equal(shown(['blocked']), 'RSDGPAMWX');
  assert.equal(shown(['questions']), 'RSDBMWX', 'a question card also discussing hides');
  assert.equal(shown(['discussing']), 'RSBMWX', 'a discussing card with questions hides too');
  assert.equal(shown(['action', 'ready']), 'DGPBAWX');
});

test('showing only some boxes unchecks every other; the cards no box matches stay', () => {
  assert.deepEqual([...filterOnly(['questions'])], ['ready', 'action', 'discussing', 'blocked']);
  assert.deepEqual([...filterOnly(['action', 'questions'])], ['ready', 'discussing', 'blocked']);
  assert.equal(shown(filterOnly(['action'])), 'MWX', 'the staging card is also Ready, so it hides');
});

test('the counts are each box matches across the cards', () => {
  assert.deepEqual({ ...filterCounts(CARDS) }, { ready: 2, action: 2, questions: 3, discussing: 4, blocked: 1 });
});

test("on a phone the filter's menu opens upward from the bottom bar and scrolls when the window is too short", () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const phone = css.match(/@media \(max-width: 899px\) \{ \.board-filter-menu \{([^}]*)\} \}/)?.[1] ?? '';
  for (const rule of [/top: auto/, /bottom: calc\(100% \+ 6px\)/, /max-height: /, /overflow-y: auto/]) assert.match(phone, rule);
});
