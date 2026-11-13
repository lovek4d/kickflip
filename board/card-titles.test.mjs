// docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBoard, pullOf } from './domain.mjs';
import { fakeGh, prView, writePR, calls } from '../shared/fake-gh.mjs';
import { boardWith, home, at, site, write, read, lines, run, board, wave } from './board-fixture.mjs';

const shape = 'isn\'t "<type>(<scope>): <summary>" with the type one of feat, fix, refactor, docs, test, chore, perf, build, ci, style, revert and a lowercase scope';
const words = '"<type>(<scope>): <summary>" of at most 100 characters, or "ask(<scope>): <question>?" for a question';
const items = () => read(at('waves', 'w', 'wave.json')).items;

test('item add, item set --title and reply --title refuse a title that is neither a Conventional subject nor an ask, and write nothing', async () => {
  const before = read(at('waves', 'w', 'wave.json'));
  assert.deepEqual(await board('item', 'add', 'w/B1', '--site', 'orch', '--phase', 'grilling', '--title', 'Header jumps on scroll'),
    { code: 1, out: '', err: `--title "Header jumps on scroll" ${shape}; a card's title is ${words}\n` });
  assert.deepEqual(await board('item', 'set', 'w/A1', '--site', 'orch', '--title', 'ask(board): why'),
    { code: 1, out: '', err: `--title "ask(board): why" isn't "ask(<scope>): <question>?", ending with "?"; a card's title is ${words}\n` });
  assert.deepEqual(read(at('waves', 'w', 'wave.json')), before);
  assert.equal((await board('item', 'add', 'w/B1', '--site', 'orch', '--phase', 'grilling', '--title', 'fix(board): header jumps on scroll')).code, 0);
  assert.equal((await board('item', 'add', 'w/B2', '--site', 'orch', '--phase', 'discussing', '--text', 'First message.', '--title', 'ask(board): do we still need staging?')).code, 0);
  assert.equal((await board('item', 'set', 'w/A1', '--site', 'orch', '--title', 'feat: the first')).code, 0);
  assert.deepEqual(items().map((i) => i.title), ['feat: the first', 'feat: later','fix(board): header jumps on scroll', 'ask(board): do we still need staging?']);

  // A New card keeps its raw-message title; reply --title retitles it, Conventionally.
  fs.appendFileSync(site('audit', 'data', 'events.jsonl'), JSON.stringify({ id: 'a1', ts: '2026-11-09T10:00:00Z', kind: 'ask', data: { text: 'Fix the header' } }) + '\n');
  process.env.HOME = home;
  const { fileAsk } = await import('./store.mjs');
  await fileAsk(site('audit'), 'a1');
  const bad = await board('reply', 'audit/T-1', '--text', 'It jumps.', '--title', 'Header jumps', '--site', 'audit');
  assert.deepEqual([bad.code, bad.err], [1, `--title "Header jumps" ${shape}; a card's title is ${words}\n`]);
  const t1 = () => read(site('audit', 'data', 'items.json')).items.find((i) => i.id === 'T-1');
  assert.deepEqual([t1().title, t1().phase], ['Fix the header', undefined]);
  assert.equal((await board('reply', 'audit/T-1', '--text', 'It jumps.', '--title', 'fix(board): header jumps on scroll', '--site', 'audit')).code, 0);
  assert.equal(t1().title, 'fix(board): header jumps on scroll');
});

test("builder start refuses a build of a card whose title isn't a Conventional subject, naming item set --title, and leaves it in Todo", async () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One' }, { id: 'A2', title: 'ask(board): why?' }] });
  assert.deepEqual(await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build'), { code: 1, out: '',
    err: `w/A1's title "One" ${shape}; retitle it with item set w/A1 --title "<type>(<scope>): <summary>" before it goes into In Progress\n` });
  assert.match((await board('--site', 'orch', 'builder', 'start', 'w/A2', '--kind', 'build')).err, /^w\/A2's title "ask\(board\): why\?" is an ask, which is answered, not built; retitle it/);
  assert.deepEqual([items()[0].lane, fs.existsSync(at('waves', 'w', 'agents', 'A1.json'))], [undefined, false]);
  assert.equal((await board('item', 'set', 'w/A1', '--site', 'orch', '--title', 'feat(board): one')).code, 0);
  const r = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build');
  assert.equal(r.code, 0, r.err);
  assert.equal(items()[0].lane, 'progress');
});

// A title builder start would refuse is caught when the orchestrator readies the card, not when the pull fails.
test("item set --phase ready refuses a card whose title builder start would refuse, and takes a --title that fixes it in the same call", async () => {
  write(at('waves', 'w', 'a1.md'), '# A1\n');
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', plan: 'a1.md', size: 'small', phase: 'ready' }, { id: 'A2', title: 'ask(board): why?', plan: 'a1.md', size: 'small', phase: 'ready' }] });
  const ready = (key, ...more) => board('item', 'set', key, '--site', 'orch', '--phase', 'ready', ...more);
  assert.deepEqual(await ready('w/A1'), { code: 1, out: '',
    err: `w/A1's title "One" ${shape}; retitle it with item set w/A1 --title "<type>(<scope>): <summary>" before it goes into In Progress\n` });
  assert.match((await ready('w/A2')).err, /^w\/A2's title "ask\(board\): why\?" is an ask, which is answered, not built; retitle it/);
  assert.deepEqual(items().map((i) => i.title), ['One', 'ask(board): why?']);
  const r = await ready('w/A1', '--title', 'feat(board): one');
  assert.equal(r.code, 0, r.err);
  assert.equal(items()[0].title, 'feat(board): one');
});

test("the pull leaves a ready card whose title isn't a Conventional subject, listing it to retitle", async () => {
  const built = (title) => buildBoard({ fromWaves: false, events: [], files: [{ slug: 'w', itemFile: { items: [{ id: 'T-1', title, phase: 'ready' }] } }] });
  assert.deepEqual(['pullable', 'pulls', 'retitle'].map((f) => pullOf(built('Fix the header').items)[f]), [[], [], ['w/T-1']]);
  assert.deepEqual(['pullable', 'pulls', 'retitle'].map((f) => pullOf(built('ask(board): why?').items)[f]), [[], [], ['w/T-1']]);
  assert.deepEqual(['pullable', 'pulls', 'retitle'].map((f) => pullOf(built('fix(board): the header').items)[f]), [['w/T-1'], ['w/T-1'], []]);
});

test("merge refuses a PR whose title isn't a Conventional subject before it merges any, naming gh pr edit", async () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  write(at('waves', 'w', 'wave.json'), { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'feat: one', prs: [{ number: 7 }, { number: 8 }], lane: 'review' }] });
  writePR(dir, 7, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }));
  writePR(dir, 8, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', title: '#517: the work' }));
  const r = await boardWith(['--site', 'orch', 'merge', 'w/A1'], env);
  assert.deepEqual([r.code, r.err], [1, `PR #8's title "#517: the work" ${shape}; retitle it with gh pr edit 8 --repo o/r --title "<type>(<scope>): <summary>" and merge again\n`]);
  assert.deepEqual(calls(dir).filter((a) => a[1] === 'merge'), []);
  assert.equal(items()[0].lane, 'review');
  assert.equal(fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl')) && lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).length, false);
});
