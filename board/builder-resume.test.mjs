// #804: builder resume passes the orchestrator's words to a running builder, or resumes a handed-back one in its own
// session; the owner's messages and new notes reach a running builder by themselves
// (docs/adr/2026-11-16-0007-builder-resume-updates-a-running-builder-or-resumes-a-handed-back-one.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boardWith, home, at, write, read, threadOf, onHome, site } from './board-fixture.mjs';
import * as store from './store.mjs';

const waveFile = () => at('waves', 'w', 'wave.json');
const setA1 = (fields) => { const w = read(waveFile()); Object.assign(w.items.find((i) => i.id === 'A1'), fields); write(waveFile(), w); };
const recordFile = () => at('waves', 'w', 'agents', 'A1.json');
const record = () => read(recordFile());
const onOrch = (...args) => boardWith(['--site', 'orch', ...args]);
const tree = () => ({ path: path.join(home, 'tree'), branch: 'A1', repo: path.join(home, 'repo') });
function building(extra = {}) {
  setA1({ lane: 'progress', phase: 'ready' });
  write(recordFile(), { started: new Date(Date.now() - 60_000).toISOString(), kind: 'claude', model: 'opus', worktree: tree(), session: { id: 's1', pid: null, log: 's1.log' }, ...extra });
}
const handedBack = (extra) => building({ done: new Date().toISOString(), handed_back: new Date().toISOString(), calls: [{ at: new Date().toISOString(), text: 'Kept the sheet' }], ...extra });
const pointer = () => path.join(site('orch'), 'data', 'builder-news', 's1.json');

test("builder resume passes the orchestrator's words to a running builder, whose next command prints them once", async () => {
  building();
  const r = await onOrch('builder', 'resume', 'w/A1', '--text', 'Use the button design');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'A1: passed to its running builder, which reads it at its next command\n');
  assert.equal(threadOf().at(-1).text, 'Passed to the builder: Use the button design');
  assert.equal(record().done, undefined, 'the build runs on');
  assert.deepEqual(read(pointer()), { key: 'w/A1' }, "the builder's hook finds it by its session");
  const next = await onOrch('builder', 'progress', 'w/A1', '--phase', 'building', 'Writing the sheet');
  assert.equal(next.code, 0, next.err);
  assert.match(next.out, /^New on w\/A1 while you build: the orchestrator wrote: Use the button design$/m);
  assert.match(next.out, /^Take it in before you hand back/m);
  assert.equal(fs.existsSync(pointer()), false);
  assert.doesNotMatch((await onOrch('builder', 'call', 'w/A1', 'Kept the sheet')).out, /New on/, 'once only');
});

test('a notes section added while it builds reaches the builder, and builder done refuses until it has', async () => {
  building();
  const draft = path.join(home, 'draft.md');
  fs.writeFileSync(draft, 'Separate from the page.\n');
  assert.equal((await onOrch('item', 'notes', 'w/A1', '--heading', 'Separate from the page', '--file', draft)).code, 0);
  const done = await onOrch('builder', 'done', 'w/A1', '--summary', 'Built it.', '--risk', 'low', '--text', 'Checked');
  assert.equal(done.code, 1);
  assert.match(done.err, /New on w\/A1 while you build: its notes gained the section "Separate from the page"; read it in \S+\.md/);
  assert.match(done.err, /builder done again once your build takes it in/);
  assert.equal(record().done, undefined, 'the build stays open');
  assert.equal(record().news, undefined, 'the refusal delivered it');
});

test('builder asks --wait returns as soon as news waits, as a pause ends the wait', async (t) => {
  onHome(t);
  building();
  assert.equal((await onOrch('builder', 'ask', 'w/A1', 'Sheet or page?')).code, 0);
  await store.builderResume(site('orch'), 'w/A1', 'Separate from the page');
  const { lines } = await store.listAsks(site('orch'), 'w/A1', { wait: true });
  assert.deepEqual(lines.slice(0, 3), ['ask1. Sheet or page?', '  waiting on the orchestrator', 'New on w/A1 while you build: the orchestrator wrote: Separate from the page']);
});

test('builder resume on a handed-back build marks it for the board to resume, its words waiting for the resumed session', async () => {
  handedBack();
  const r = await onOrch('builder', 'resume', 'w/A1', '--text', 'Make it a button');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'A1: the board resumes its builder in its own session\n');
  const rec = record();
  assert.equal(rec.rerun.text, 'Make it a button');
  assert.deepEqual(rec.news.map((n) => [n.from, n.text]), [['orchestrator', 'Make it a button']]);
  assert.equal(fs.existsSync(pointer()), false, 'no session runs to read it');
  assert.ok(rec.done && rec.handed_back, 'it reads handed back until the board resumes it');
  assert.match((await onOrch('builder', 'resume', 'w/A1', '--text', 'Again')).err, /already waits on the board to resume its builder/);
});

test('builder resume on an open build whose process is gone marks it for the board to resume, not queueing to a dead session', async (t) => {
  onHome(t);
  building({ session: { id: 's1', pid: 2 ** 22 + 12345, log: 's1.log' } });
  const r = await onOrch('builder', 'resume', 'w/A1', '--text', 'Carry on');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'A1: the board resumes its builder in its own session\n');
  assert.equal(record().rerun.text, 'Carry on');
  assert.equal(fs.existsSync(pointer()), false, 'no session runs to read it');
  const taken = await store.takeRerun(site('orch'), 'w/A1');
  assert.deepEqual(taken.news.slice(0, 1), ['New on w/A1 while you build: the orchestrator wrote: Carry on']);
  assert.equal(record().done, undefined);
});

test('builder resume refuses a card not In Progress, one with no running or handed-back build, and a build with no session to resume', async () => {
  handedBack();
  setA1({ lane: 'todo' });
  assert.match((await onOrch('builder', 'resume', 'w/A1', '--text', 'x')).err, /builder resume takes a task In Progress; A1 is in todo/);
  building({ done: new Date().toISOString() });
  assert.match((await onOrch('builder', 'resume', 'w/A1', '--text', 'x')).err, /A1 has no running or handed-back build to resume/);
  handedBack({ session: undefined });
  assert.match((await onOrch('builder', 'resume', 'w/A1', '--text', 'x')).err, /A1's build has no Claude session the board launched to resume/);
  handedBack({ kind: 'codex' });
  assert.match((await onOrch('builder', 'resume', 'w/A1', '--text', 'x')).err, /A1's build has no Claude session the board launched to resume/);
  building();
  assert.match((await onOrch('builder', 'resume', 'w/A1')).err, /--text/);
});
