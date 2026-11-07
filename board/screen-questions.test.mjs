// docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md: a finished grill's questions
// wait on the orchestrator first, which settles the ones the board answers and passes the owner the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { home, at, site, write, read, board, question } from './board-fixture.mjs';
import { publishUnscreened, readScreening, SCREEN_AFTER } from './store.mjs';

const gate = (id) => question(id, { topic: 'item:w/A1', question: 'Prototype round first?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No', recommended: true }], prototype_gate: true });
const owner = () => read(site('orch', 'data', 'owner.json')).items;
const thread = () => fs.readFileSync(site('orch', 'data', 'threads', 'w__A1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
function grilled(kind = 'grill') {
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', kind).code, 0);
  write(path.join(home, 'q.json'), [question('q1', { topic: 'item:w/A1' }), question('q2', { topic: 'item:w/A1' }), gate('q-gate')]);
  assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')).code, 0);
  const done = board('--site', 'orch', 'builder', 'done', 'w/A1', '--next', 'x');
  assert.equal(done.code, 0, done.err);
}

test("a finished grill's questions wait on the orchestrator; settle publishes one resolved into the notes, publish passes the rest on", async () => {
  grilled();
  assert.deepEqual(owner(), []);
  const screening = await readScreening(site('orch'));
  assert.deepEqual(screening['w/A1'].ids, ['q1', 'q2', 'q-gate']);

  assert.match(board('question', 'settle', 'q-gate', '--site', 'orch', '--note', 'No.').err, /prototype question, which is the owner's/);
  assert.match(board('question', 'settle', 'nope', '--site', 'orch', '--note', 'x').err, /no staged question "nope"/);
  const settled = board('question', 'settle', 'q1', '--site', 'orch', '--note', 'The board already keeps one list.');
  assert.equal(settled.code, 0, settled.err);
  assert.deepEqual(owner().map((q) => [q.id, q.resolved]), [['q1', 'Settled by the orchestrator: The board already keeps one list.']]);
  const notes = fs.readFileSync(at('waves', 'w', read(at('waves', 'w', 'wave.json')).items[0].plan), 'utf8');
  assert.match(notes, /## Answers \(orchestrator, \d\d\/\d\d \d\d:\d\d\)\n- q1 \(.*\): settled by the orchestrator\. "The board already keeps one list\."/);

  const published = board('question', 'publish', 'w/A1', '--site', 'orch');
  assert.equal(published.code, 0, published.err);
  assert.match(published.out, /questions q2, q-gate on .* passed to the owner/);
  assert.deepEqual(owner().map((q) => [q.id, Boolean(q.resolved)]), [['q1', true], ['q2', false], ['q-gate', false]]);
  assert.deepEqual(await readScreening(site('orch')), {});
  assert.match(board('question', 'publish', 'w/A1', '--site', 'orch').err, /no questions waiting on you to screen/);
});

test("a prototype planner's questions publish at its done, unscreened", async () => {
  grilled('prototype');
  assert.deepEqual(owner().map((q) => q.id), ['q1', 'q2', 'q-gate']);
});

test('screened questions left 15 minutes publish themselves, with a thread line; younger ones wait', async (t) => {
  grilled();
  const old = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = old; });
  const since = Date.parse((await readScreening(site('orch')))['w/A1'].since);
  assert.deepEqual(await publishUnscreened(site('orch'), new Date(since + SCREEN_AFTER - 1000)), []);
  assert.deepEqual(owner(), []);
  assert.deepEqual(await publishUnscreened(site('orch'), new Date(since + SCREEN_AFTER)), ['w/A1']);
  assert.deepEqual(owner().map((q) => q.id), ['q1', 'q2', 'q-gate']);
  assert.match(thread().at(-1).text, /didn't screen the grill's questions within 15 minutes/);
});

test('closing the card publishes its screened questions at once', async () => {
  grilled();
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--done', '--force', '--text', 'Dropped.').code, 0);
  assert.deepEqual(owner().map((q) => q.id), ['q1', 'q2', 'q-gate']);
  assert.deepEqual(await readScreening(site('orch')), {});
});
