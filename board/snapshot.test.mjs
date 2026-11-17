// #969: card state comes from one snapshot reader (snapshot.mjs readSnapshot) that the server, the CLI and the store
// share (docs/adr/2026-11-17-2200-card-state-comes-from-one-snapshot-reader.md). A CLI guard reads the lane, blockedBy
// and finished the page draws, with no server running, so a dep the board reads as Done before it stores the move
// blocks nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { home, at, site, write, read, wave } from './board-fixture.mjs';
import { buildBoard, blockWordsOf } from './domain.mjs';
import { builtCards, outsideData, readSnapshot } from './snapshot.mjs';
import * as store from './store.mjs';

const waveFile = () => at('waves', 'w', 'wave.json');
// A fixed time ms before 2026-10-25T12:00:00Z, for the order of a card's moves, taps and merges.
const ago = (ms) => new Date(Date.parse('2026-10-25T12:00:00Z') - ms).toISOString();
// The test's HOME for the in-process store and snapshot calls, which read os.homedir().
const asHome = (t) => {
  const was = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = was; });
};
// ENG-1 holds its Merge and waits on A1, given A1's fields.
const waitingOnA1 = (a1) => write(waveFile(), { ...wave(), repo: 'o/r', items: [
  { id: 'A1', title: 'feat: one', created: '2026-10-21', ...a1 },
  { id: 'ENG-1', title: 'feat: later', created: '2026-10-22', deps: ['A1'], lane: 'review', merge_ready: { branch: 'ENG-1', at: ago(1000) } },
] });

test("a dep whose PR merged has finished for the CLI before the board stores its move to Done", async (t) => {
  asHome(t);
  waitingOnA1({ lane: 'review', prs: [{ number: 7 }], lane_at: ago(60_000) });
  write(at('kickflip', 'github-state.json'), { prs: { 'o/r#7': { state: 'MERGED', mergedAt: ago(30_000) } } });
  const cards = await builtCards(site('orch'));
  assert.deepEqual([cards.get('w/A1').lane, cards.get('w/A1').finished, cards.get('w/ENG-1').blockedBy], ['done', true, []]);
  await store.tapMerge(site('orch'), 'w/ENG-1');
  assert.ok(read(waveFile()).items.find((i) => i.id === 'ENG-1').merge_ready.tapped, 'its Merge took');
});

test("a dep the owner tapped Done has finished for the CLI before the board stores its move", async (t) => {
  asHome(t);
  waitingOnA1({ lane: 'progress', lane_at: ago(60_000) });
  write(site('orch', 'data', 'events.jsonl'), `${JSON.stringify({ id: 'e9', ts: ago(1000), kind: 'card-done', data: { key: 'w/A1' } })}\n`);
  assert.equal((await builtCards(site('orch'))).get('w/A1').finished, true);
  await store.tapMerge(site('orch'), 'w/ENG-1');
});

test('an unfinished dep blocks the CLI in the words the card draws', async (t) => {
  asHome(t);
  waitingOnA1({ lane: 'progress' });
  const card = (await builtCards(site('orch'))).get('w/ENG-1');
  assert.equal(blockWordsOf(card), 'by A1');
  await assert.rejects(store.tapMerge(site('orch'), 'w/ENG-1'), { message: 'w/ENG-1 is blocked by A1, so its Merge waits until nothing blocks it' });
});

test('a reopened dep has finished, and its words join a blocked-until condition', () => {
  const files = [{ slug: 'w', itemFile: { items: [
    { id: 'A1', title: 'One', lane: 'todo', reopened_at: '2026-10-25T10:00:00Z', closed_at: '2026-10-24T10:00:00Z' },
    { id: 'B1', title: 'Two', lane: 'todo' },
    { id: 'C1', title: 'Three', lane: 'todo', deps: ['A1', 'B1'], blocked_until: 'the API ships' },
  ] }, agents: {} }];
  const cards = new Map(buildBoard({ files }).items.map((i) => [i.key, i]));
  assert.deepEqual([cards.get('w/A1').finished, cards.get('w/B1').finished], [true, false]);
  assert.deepEqual(cards.get('w/C1').blockedBy.map((d) => d.key), ['w/B1']);
  assert.equal(blockWordsOf(cards.get('w/C1')), 'by B1 and until the API ships');
  assert.equal(blockWordsOf(cards.get('w/B1')), '');
});

test("readSnapshot's item-only read carries the cards' sources and no page events", async (t) => {
  asHome(t);
  const outside = await outsideData(site('orch'));
  const items = await readSnapshot(site('orch'), outside, { items: true });
  const whole = await readSnapshot(site('orch'), outside);
  assert.deepEqual(items.files.map((f) => f.slug), ['w']);
  assert.equal(items.events, undefined);
  assert.deepEqual(whole.events.map((e) => e.id), ['e1']);
  assert.deepEqual(buildBoard(items).items.filter((i) => i.kind === 'work').map((i) => i.key), buildBoard(whole).items.filter((i) => i.kind === 'work').map((i) => i.key));
});
