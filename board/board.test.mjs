import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeDevice } from '../hub/fake-device.mjs';

const bin = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', name);
let home;
const at = (...p) => path.join(home, '.claude', ...p);
const site = (route, ...p) => at('web-ts', 'sites', route, ...p);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const lines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function run(script, args, input, env = {}) {
  const r = spawnSync(process.execPath, [bin(script), ...args], { env: { ...process.env, HOME: home, ...env }, input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const board = (...args) => run('board.mjs', args);
function runAsync(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin(script), ...args], { env: { ...process.env, HOME: home, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}
async function withDevice(fn) {
  const device = await startFakeDevice();
  write(at('web-ts', 'push', 'subs.json'), [device.subscription]);
  write(at('web-ts', 'settings.json'), { polling: { windows: [{ from: '00:00', every_minutes: 15 }], hold_overnight: true, wakes: [] } });
  const b = (...args) => runAsync('board.mjs', args, { WEB_TS_HUB_PORT: String(device.port) });
  try { await fn(b, device.received); } finally { await device.close(); }
}

const wave = () => ({ title: 'W', items: [{ id: 'A1', title: 'One', next: 'Old' }], followups: [{ id: 'PROD-1', title: 'Later', filed: '2026-10-22' }] });
const question = (id, extra = {}) => ({ id, topic: 'site', question: 'Keep it?', options: [{ id: 'A', label: 'Keep', recommended: true }, { id: 'B', label: 'Drop' }], ...extra });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
  write(at('waves', 'w', 'wave.json'), wave());
  write(site('orch', 'board.json'), { title: 'Orch', items: 'waves' });
  write(site('orch', 'data', 'owner.json'), { topics: [{ id: 'site', title: 'Site' }], items: [] });
  write(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'e1', ts: '2026-10-23T10:00:00Z', kind: 'ask', data: {} }) + '\n');
  write(site('audit', 'board.json'), { title: 'Audit', items: 'data/wave.json', slug: 'audit' });
  write(site('audit', 'data', 'wave.json'), wave());
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

test('reply answers a known event and refuses an unknown one', () => {
  assert.equal(board('reply', 'e1', '--site', 'orch', '--html', '<p>Done.</p>').code, 0);
  assert.equal(fs.readFileSync(site('orch', 'data', 'replies', 'e1.html'), 'utf8'), '<p>Done.</p>');
  assert.equal(run('board.mjs', ['reply', 'e1', '--site', 'orch', '--file', '-'], '<p>Again.</p>').code, 0);
  assert.equal(fs.readFileSync(site('orch', 'data', 'replies', 'e1.html'), 'utf8'), '<p>Again.</p>');
  const r = board('reply', 'e9', '--site', 'orch', '--html', 'x');
  assert.equal(r.code, 1);
  assert.match(r.err, /no event "e9"/);
  assert.equal(fs.existsSync(site('orch', 'data', 'replies', 'e9.html')), false);
});

test('reply refuses a file path passed as --html, which would post the path itself', () => {
  const r = board('reply', 'e1', '--site', 'orch', '--html', '/tmp/scratch/answer.html');
  assert.equal(r.code, 2);
  assert.match(r.err, /--file \/tmp\/scratch\/answer\.html/);
  assert.equal(fs.existsSync(site('orch', 'data', 'replies', 'e1.html')), false);
});

test('every text flag refuses a bare file path, and --file refuses a missing file', () => {
  const real = path.join(home, 'notes');
  write(real, 'hello');
  const thread = board('thread', 'w/A1', '--site', 'orch', '--text', real);
  assert.equal(thread.code, 2);
  assert.match(thread.err, /--text takes text, not a file path/);
  assert.doesNotMatch(thread.err, /for a file use/);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', './plan.md').code, 2);
  // Prose that mentions a path is still text.
  assert.equal(board('thread', 'w/A1', '--site', 'orch', '--text', `Wrote ${real} for you`).code, 0);
  const missing = board('reply', 'e1', '--site', 'orch', '--file', path.join(home, 'nope.html'));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no such file/);
});

test('item add makes a planned card, waiting when it has deps, and refuses a taken id or unknown dep', () => {
  assert.equal(board('item', 'add', 'w/B2', '--site', 'orch', '--title', 'Two', '--notes', 'Why').code, 0);
  assert.deepEqual(read(at('waves', 'w', 'wave.json')).items.at(-1), { id: 'B2', title: 'Two', notes: 'Why', status: 'planned' });
  assert.equal(board('item', 'add', 'w/C3', '--site', 'orch', '--title', 'Three', '--deps', 'A1,B2').code, 0);
  assert.deepEqual(read(at('waves', 'w', 'wave.json')).items.at(-1), { id: 'C3', title: 'Three', deps: ['A1', 'B2'], status: 'waiting' });
  const taken = board('item', 'add', 'w/A1', '--site', 'orch', '--title', 'Again');
  assert.equal(taken.code, 1);
  assert.match(taken.err, /already has an item "A1"/);
  const dep = board('item', 'add', 'w/D4', '--site', 'orch', '--title', 'Four', '--deps', 'Z9');
  assert.equal(dep.code, 1);
  assert.match(dep.err, /no item "Z9"/);
  assert.equal(read(at('waves', 'w', 'wave.json')).items.length, 3);
  assert.equal(board('item', 'add', 'audit/E5', '--site', 'audit', '--title', 'Five').code, 0);
  assert.equal(read(site('audit', 'data', 'wave.json')).items.at(-1).id, 'E5');
});

test('working marks a known ask started and refuses an unknown one', () => {
  assert.equal(board('working', 'e1', '--site', 'orch').code, 0);
  assert.ok(Date.parse(read(site('orch', 'data', 'working.json')).events.e1));
  const r = board('working', 'e9', '--site', 'orch');
  assert.equal(r.code, 1);
  assert.match(r.err, /no event "e9"/);
});

test("thread appends a line to an item's thread", () => {
  assert.equal(board('thread', 'w/A1', '--site', 'orch', '--text', 'Built.', '--who', 'Jamie', '--via', 'github', '--link', 'https://github.com/o/r/pull/1').code, 0);
  assert.equal(board('thread', 'w/A1', '--site', 'orch', '--text', 'Merged.').code, 0);
  const msgs = lines(site('orch', 'data', 'threads', 'w__A1.jsonl'));
  assert.deepEqual(msgs.map(({ ts, ...m }) => m), [
    { who: 'Jamie', text: 'Built.', link: 'https://github.com/o/r/pull/1', via: 'github' },
    { who: 'claude', text: 'Merged.' },
  ]);
  assert.ok(!Number.isNaN(Date.parse(msgs[0].ts)));
});

test('thread refuses an unknown item, an empty text and an unknown channel', () => {
  assert.equal(board('thread', 'w/Z9', '--site', 'orch', '--text', 'Hi').code, 1);
  assert.equal(board('thread', 'w/A1', '--site', 'orch', '--text', ' ').code, 1);
  assert.equal(board('thread', 'w/A1', '--site', 'orch', '--text', 'Hi', '--via', 'email').code, 1);
  assert.equal(board('thread', 'w/A1', '--text', 'Hi').code, 1);
  assert.equal(fs.existsSync(site('orch', 'data', 'threads')), false);
});

test('question add appends valid questions and rejects the whole file otherwise', () => {
  const drawn = (more = {}) => ({ id: 'A', label: 'Keep', diagram: [[{ text: 'Hub' }, { text: 'Board', tone: 'info', to: [0] }], [{ text: 'Owner', tone: 'success' }]], practice: ['One place to change.'], ...more });
  write(path.join(home, 'q.json'), [question('q1', { url: 'prototype-site.html?q=q1' }), question('q2', { topic: 'item:w/A1', urgent: true, url: 'https://linear.app/x/issue/INT-1', options: [drawn(), { id: 'B', label: 'Drop' }] }), question('q4', { topic: 'item:ask:e1' })]);
  assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')).code, 0);
  assert.deepEqual(read(site('orch', 'data', 'owner.json')).items.map((q) => [q.id, q.url]), [['q1', 'prototype-site.html?q=q1'], ['q2', 'https://linear.app/x/issue/INT-1'], ['q4', undefined]]);
  assert.deepEqual(read(site('orch', 'data', 'owner.json')).items[1].options[0], drawn());

  const rejected = [
    [question('q1')],
    [question('q3', { topic: 'nowhere' })],
    [question('q3', { topic: 'item:w/Z9' })],
    [question('q3', { topic: 'item:ask:e9' })],
    [question('q3', { options: [] })],
    [question('q3', { options: [{ id: 'A', label: 'Keep', recommend: true }] })],
    [question('q3', { options: [{ id: 'A', label: 'X', recommended: true }, { id: 'B', label: 'Y', recommended: true }] })],
    [question('q3'), question('q3')],
    [question('q3', { url: '/orch/prototype-site.html' })],
    [question('q3', { url: 'notes.html' })],
    [question('q3', { options: [drawn({ practice: undefined })] })],
    [question('q3', { options: [drawn({ diagram: undefined })] })],
    [question('q3', { options: [drawn({ diagram: [] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }, { text: 'E' }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: ' ' }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A', tone: 'red' }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A', to: [1] }], [{ text: 'B' }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A', to: [0] }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A', shape: 'round' }]] })] })],
    [question('q3', { options: [drawn({ practice: [] })] })],
  ];
  for (const file of rejected) {
    write(path.join(home, 'bad.json'), file);
    assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'bad.json')).code, 1, JSON.stringify(file));
  }
  assert.deepEqual(read(site('orch', 'data', 'owner.json')).items.map((q) => q.id), ['q1', 'q2', 'q4']);
});

test('a new topic takes questions, and resolving one records when', () => {
  assert.equal(board('topic', 'add', 'plan', '--site', 'orch', '--title', 'Plan', '--summary', 'The next wave.').code, 0);
  write(path.join(home, 'q.json'), question('q1', { topic: 'plan' }));
  assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')).code, 0);
  assert.equal(board('question', 'resolve', 'q1', '--site', 'orch', '--note', 'Kept it.').code, 0);
  const owner = read(site('orch', 'data', 'owner.json'));
  assert.deepEqual(owner.topics.at(-1), { id: 'plan', title: 'Plan', summary: 'The next wave.' });
  assert.equal(owner.items[0].resolved, 'Kept it.');
  assert.ok(Date.parse(owner.items[0].resolved_at) <= Date.now());
  assert.equal(board('question', 'resolve', 'q9', '--site', 'orch', '--note', 'x').code, 1);
});

test('item set edits the item in a waves board and in a file board', () => {
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'building', '--next', 'Run tests', '--pr', '42').code, 0);
  const { status_at: _w, ...edited } = read(at('waves', 'w', 'wave.json')).items[0];
  assert.deepEqual(edited, { id: 'A1', title: 'One', next: 'Run tests', status: 'building', pr: 42 });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--from-ask', 'e9').code, 1);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--from-ask', 'e1').code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].from_ask, 'e1');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking', '--next', '').code, 0);
  assert.deepEqual([read(at('waves', 'w', 'wave.json')).items[0].status, 'next' in read(at('waves', 'w', 'wave.json')).items[0]], ['checking', false]);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--clear-next', '--status', 'held').code, 0);
  const { status_at: _a, ...audit } = read(site('audit', 'data', 'wave.json')).items[0];
  assert.deepEqual(audit, { id: 'A1', title: 'One', status: 'held' });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'audit', '--status', 'held').code, 1);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--status', 'shipped').code, 1);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--pr', 'abc').code, 1);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit').code, 1);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--clear-status').code, 0);
  assert.equal(read(site('audit', 'data', 'wave.json')).items[0].status, undefined);
});

test('item set --notes-file, or its alias --plan, names a notes file inside the wave folder, and --title renames the card', () => {
  write(at('waves', 'w', 'A1-notes.md'), '# So far');
  write(at('waves', 'w', 'A1-old.md'), '# Old');
  const item = () => read(at('waves', 'w', 'wave.json')).items[0];
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', 'A1-notes.md', '--title', 'One, renamed').code, 0);
  assert.deepEqual([item().plan, item().title], ['A1-notes.md', 'One, renamed']);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--plan', 'A1-old.md').code, 0);
  assert.equal(item().plan, 'A1-old.md');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--plan', 'A1-old.md', '--notes-file', 'A1-notes.md').code, 2);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', '../outside.md').code, 1);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--title', ' ').code, 1);
  assert.equal(board('item', 'add', 'w/B2', '--site', 'orch', '--title', 'Two', '--notes-file', 'A1-notes.md').code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items.at(-1).plan, 'A1-notes.md');
});

test('item set --install records a device build with when it was built, takes only https or an iOS manifest link, and --clear-install removes it', () => {
  const ios = 'itms-services://?action=download-manifest&url=https://mac.ts.net/orch/installs/w-A1/manifest.plist';
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--install', ios, '--install-sha', 'ABCDEF1234', '--install-label', 'Install beta').code, 0);
  const { built_at, ...install } = read(at('waves', 'w', 'wave.json')).items[0].install;
  assert.deepEqual(install, { url: ios, label: 'Install beta', sha: 'abcdef1234' });
  assert.ok(Math.abs(Date.parse(built_at) - Date.now()) < 60000);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--install', 'https://mac.ts.net/audit/installs/audit-A1/app.apk').code, 0);
  assert.deepEqual(Object.keys(read(site('audit', 'data', 'wave.json')).items[0].install), ['url', 'built_at']);
  for (const [args, err] of [
    [['--install', 'http://mac.ts.net/app.apk'], /^--install takes an https:\/\/ or itms-services:\/\/ URL/],
    [['--install', 'javascript:alert(1)'], /^--install takes /],
    [['--install', 'itms-services://?action=download-manifest&url=http://x/manifest.plist'], /^--install: an itms-services/],
    [['--install', ios, '--install-sha', 'main'], /^--install-sha takes a commit sha/],
    [['--install-sha', 'abcdef1'], /^--install-sha and --install-label go with --install/],
    [['--install', ios, '--clear-install'], /^pass --install or --clear-install, not both/],
  ]) {
    const r = board('item', 'set', 'w/A1', '--site', 'orch', ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err, args.join(' '));
  }
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].install.url, ios);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--clear-install').code, 0);
  assert.equal('install' in read(at('waves', 'w', 'wave.json')).items[0], false);
});

test('a follow-up is filed with a date and leaves its lane when done', () => {
  assert.equal(board('followup', 'add', 'audit', '--site', 'audit', '--id', 'PROD-7', '--title', 'Tidy', '--from', 'A1').code, 0);
  assert.equal(board('followup', 'add', 'audit', '--site', 'audit', '--id', 'PROD-7', '--title', 'Again').code, 1);
  assert.equal(board('followup', 'add', 'audit', '--site', 'audit', '--id', 'tidy', '--title', 'Tidy').code, 1);
  assert.equal(board('followup', 'done', 'audit', 'PROD-1', '--site', 'audit').code, 0);
  const { followups } = read(site('audit', 'data', 'wave.json'));
  assert.deepEqual(followups.map((f) => [f.id, Boolean(f.done)]), [['PROD-1', true], ['PROD-7', false]]);
  assert.match(followups[1].filed, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(followups[1].from, 'A1');
});

test('agent.mjs still writes builder records, beside the wave file it names', () => {
  assert.equal(run('agent.mjs', ['start', 'w/A1', '--label', 'Opus builder']).code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).label, 'Opus builder');
  assert.equal(run('agent.mjs', ['done', 'w/A1']).code, 0);
  assert.equal(Number.isNaN(Date.parse(read(at('waves', 'w', 'agents', 'A1.json')).done)), false);

  assert.equal(run('agent.mjs', ['start', 'audit/A1', '--dir', site('audit', 'data')]).code, 0);
  assert.equal(typeof read(site('audit', 'data', 'agents', 'A1.json')).started, 'string');
  assert.equal(board('builder', 'done', 'audit/A1', '--site', 'audit').code, 0);
  assert.equal(typeof read(site('audit', 'data', 'agents', 'A1.json')).done, 'string');
  assert.equal(run('agent.mjs', ['start', 'audit/A1', '--dir', site('audit', 'data')]).code, 0);
  assert.equal('done' in read(site('audit', 'data', 'agents', 'A1.json')), false);
  assert.equal(run('agent.mjs', ['start', 'w/Z9']).code, 1);
});

test('builder keeps one record per agent on an item, with its kind and an ETA it can change or clear', () => {
  assert.equal(board('builder', 'start', 'w/A1', '--label', 'Opus builder', '--kind', 'opus').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'codex', '--eta', '2026-10-23T16:30:00-07:00').code, 0);
  assert.deepEqual([read(at('waves', 'w', 'agents', 'A1.json')).kind, read(at('waves', 'w', 'agents', 'A1@bench.json')).eta], ['opus', '2026-10-23T23:30:00.000Z']);
  assert.equal(board('builder', 'progress', 'w/A1', 'Still', 'running', '--site', 'orch', '--agent', 'bench', '--eta', '2026-10-24T01:00:00Z').code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1@bench.json')).eta, '2026-10-24T01:00:00.000Z');
  assert.equal(board('builder', 'progress', 'w/A1', 'Done soon', '--site', 'orch', '--agent', 'bench', '--clear-eta').code, 0);
  assert.equal('eta' in read(at('waves', 'w', 'agents', 'A1@bench.json')), false);
  assert.match(board('builder', 'progress', 'w/A1', 'x', '--site', 'orch', '--eta', 'soon').err, /--eta takes an ISO time/);
  assert.equal(board('builder', 'progress', 'w/A1', 'Benchmarking', '--site', 'orch', '--agent', 'bench', '--eta', '2026-10-24T01:00:00Z').code, 0);
  assert.equal(board('builder', 'done', 'w/A1', '--agent', 'bench').code, 0);
  const bench = read(at('waves', 'w', 'agents', 'A1@bench.json'));
  assert.deepEqual([typeof bench.done, 'eta' in bench, 'done' in read(at('waves', 'w', 'agents', 'A1.json'))], ['string', false, false]);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'Review').code, 0);
  assert.equal('done' in read(at('waves', 'w', 'agents', 'A1.json')), false);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--pr', '7', '--clear-status').code, 0);
  assert.deepEqual([typeof read(at('waves', 'w', 'agents', 'A1.json')).done, read(at('waves', 'w', 'agents', 'A1@bench.json')).done], ['string', bench.done]);
});

test('a hand-back closes every builder record still open on the item', () => {
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'fix').code, 0);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking').code, 0);
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1@fix.json')).done, 'string');
});

test("builder start and progress on --site write each new status line to the item's thread, named by a further agent's kind", () => {
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--progress', 'Reading the plan').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'bench', '--kind', 'codex', '--progress', 'Running the benchmark').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', 'Running', 'the', 'benchmark', '--site', 'orch', '--agent', 'bench').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', 'Writing', 'tests', '--site', 'orch').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', '--site', 'orch', '--text', 'Writing docs').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', 'Twice', '--site', 'orch', '--text', 'Twice').code, 2);
  assert.equal(board('builder', 'progress', 'w/A1', '--site', 'orch').code, 2);
  assert.equal(board('builder', 'done', 'w/A1', '--site', 'orch').code, 0);
  const unseen = board('builder', 'progress', 'w/A1', 'Unseen', '--agent', 'bench');
  assert.deepEqual([unseen.code, /needs --site/.test(unseen.err)], [1, true]);
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'lint', '--progress', 'Unseen').code, 1);
  const msgs = lines(site('orch', 'data', 'threads', 'w__A1.jsonl'));
  assert.deepEqual(msgs.map(({ who, kind, text }) => [who, kind, text]), [
    ['claude', 'status', 'Reading the plan'],
    ['claude', 'status', 'Codex: Running the benchmark'],
    ['claude', 'status', 'Writing tests'],
    ['claude', 'status', 'Writing docs'],
  ]);
  assert.deepEqual(['progress' in read(at('waves', 'w', 'agents', 'A1.json')), 'progress_at' in read(at('waves', 'w', 'agents', 'A1@bench.json'))], [false, false]);
  assert.ok(msgs.every((m) => !Number.isNaN(Date.parse(m.ts))));
});

const toolUse = (id, command, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const toolResult = (id, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const stopHook = (input) => run('builder-stop-hook.mjs', [], typeof input === 'string' ? input : JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: 'a1', ...input }));
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('the SubagentStop hook closes the builder records its agent started and left open, quietly and any number of times', () => {
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'bench').code, 0);
  assert.equal(board('builder', 'start', 'audit/A1', '--site', 'audit').code, 0);
  assert.equal(board('builder', 'done', 'audit/A1', '--site', 'audit').code, 0);
  const finished = read(site('audit', 'data', 'agents', 'A1.json')).done;
  const transcript = path.join(home, 'agent.jsonl');
  write(transcript, [
    'not json',
    toolUse('t1', 'node ~/.claude/skills/join-web-ts/board/bin/board.mjs --site orch builder start w/A1 --kind build --label "Opus builder"; ls', ago(5 * 60 * 1000)),
    toolResult('t1', ago(1000)),
    toolUse('t2', 'B="node ~/.claude/skills/join-web-ts/board/bin/board.mjs --site orch"; eval "$B builder start w/A1 --agent bench --kind codex"', ago(1000)),
    toolUse('t3', '$B builder start audit/A1 --site audit', ago(1000)),
  ].join('\n') + '\n');
  for (const _ of [1, 2]) {
    const r = stopHook({ agent_transcript_path: transcript });
    assert.deepEqual([r.code, r.out], [0, '']);
  }
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1.json')).done, 'string');
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1@bench.json')).done, 'string');
  assert.equal(read(site('audit', 'data', 'agents', 'A1.json')).done, finished);
});

test('the SubagentStop hook leaves a record another agent restarted on the card after its own start', () => {
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'fix').code, 0);
  const transcript = path.join(home, 'agent.jsonl');
  write(transcript, [toolUse('t1', 'node board.mjs --site orch builder start w/A1 --agent fix', ago(10 * 60 * 1000)), toolResult('t1', ago(10 * 60 * 1000 - 500))].join('\n'));
  assert.equal(stopHook({ agent_transcript_path: transcript }).code, 0);
  assert.equal('done' in read(at('waves', 'w', 'agents', 'A1@fix.json')), false);
});

test('the SubagentStop hook exits 0 with nothing on stdout when its input or transcript is missing', () => {
  for (const input of [{ agent_transcript_path: path.join(home, 'gone.jsonl') }, {}, 'not json']) {
    const r = stopHook(input);
    assert.deepEqual([r.code, r.out, /builder-stop-hook: /.test(r.err)], [0, '', true]);
  }
});

test('a refusal exits non-zero with one line naming the bad flag, and changes nothing', () => {
  for (const [args, code, err] of [
    [['item', 'set', 'w/A1', '--site', 'orch', '--colour', 'red'], 2, /^item set does not take --colour\b/],
    [['item', 'set', 'w/A1', '--site', 'orch', '--status', 'shipped'], 1, /^--status takes /],
  ]) {
    const r = board(...args);
    assert.equal(r.code, code, args.join(' '));
    assert.match(r.err, err, args.join(' '));
    assert.equal(r.err.trim().split('\n').length, 1, args.join(' '));
  }
  assert.equal(board('frobnicate').code, 2);
  assert.deepEqual(read(at('waves', 'w', 'wave.json')), wave());
});

test('push adds the replies written since the last push to the body, and records the push only when web-ts push succeeds', () => {
  const stub = path.join(home, 'stub.mjs');
  const calls = path.join(home, 'calls.jsonl');
  write(stub, "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n'); process.exit(Number(process.env.STUB_EXIT || 0));");
  const push = (exit, ...args) => run('board.mjs', ['push', '--site', 'orch', ...args], undefined, { WEB_TS_PUSH_CMD: JSON.stringify([process.execPath, stub, 'push']), STUB_CALLS: calls, STUB_EXIT: String(exit) });
  const state = site('orch', 'data', 'push-state.json');
  const reply = (id, msAgo) => {
    write(site('orch', 'data', 'replies', `${id}.html`), '<p>Done.</p>');
    const t = new Date(Date.now() - msAgo);
    fs.utimesSync(site('orch', 'data', 'replies', `${id}.html`), t, t);
  };

  reply('e1', 60_000);
  assert.equal(push(0, '--title', 'Question', '--body', 'Pick one', '--url', '/orch/questions.html').code, 0);
  assert.ok(!Number.isNaN(Date.parse(read(state).last_push)));

  write(state, { last_push: new Date(Date.now() - 30_000).toISOString() });
  reply('e2', 10_000);
  reply('e3', 5_000);
  const failed = push(3, '--title', 'Ready', '--body', 'A1 is green', '--tag', 'ready-A1', '--urgent');
  assert.equal(failed.code, 3);
  const kept = read(state).last_push;
  assert.equal(push(0, '--title', 'Ready', '--tag', 'ready-A1').code, 0);
  assert.ok(Date.parse(read(state).last_push) > Date.parse(kept));
  assert.equal(push(0, '--title', 'Digest').code, 0);
  assert.equal(push(0, '--title', 'Answered: keep it?', '--tag', 'ask-e1', '--now').code, 0);

  assert.deepEqual(lines(calls), [
    ['push', '--title', 'Question', '--body', 'Pick one', '--url', '/orch/questions.html?from=push'],
    ['push', '--title', 'Ready', '--body', 'A1 is green · and 2 replies', '--tag', 'ready-A1', '--urgent'],
    ['push', '--title', 'Ready', '--body', 'and 2 replies', '--tag', 'ready-A1'],
    ['push', '--title', 'Digest'],
    ['push', '--title', 'Answered: keep it?', '--tag', 'ask-e1', '--now'],
  ]);
  assert.equal(board('push', '--site', 'orch').code, 2);
  assert.equal(board('push', '--title', 'No site').code, 1);
});

test("a Claude thread line or reply rewrites its item's queued push to the latest message, and a sent push stays sent", () => {
  write(at('web-ts', 'push', 'subs.json'), [{ endpoint: 'https://push.invalid/device', keys: { p256dh: 'x', auth: 'y' }, origin: 'https://hub.invalid' }]);
  const queueFile = at('web-ts', 'push', 'queue.json');
  const queue = () => Object.fromEntries(read(queueFile).items.map((i) => [i.tag, i.body]));
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'm1', ts: '2026-10-23T10:05:00Z', kind: 'item-message', data: { key: 'w/A1' } }) + '\n');
  const lastPush = () => write(site('orch', 'data', 'push-state.json'), { last_push: new Date(Date.now() - 60_000).toISOString() });
  write(site('orch', 'data', 'replies', 'old.html'), '<p>Earlier.</p>');

  assert.equal(board('push', '--site', 'orch', '--title', 'Answered: keep it?', '--body', 'Too early', '--tag', 'ask-e1').code, 0);
  lastPush();
  assert.equal(board('push', '--site', 'orch', '--title', 'Answered: keep it?', '--body', 'First answer', '--tag', 'ask-e1').code, 0);
  assert.equal(board('push', '--site', 'orch', '--title', 'One needs you', '--body', 'Pick a layout', '--url', '/orch/prototype-layout.html?q=w-layout', '--tag', 'item-w/A1').code, 0);
  assert.deepEqual(queue(), { 'ask-e1': 'First answer · and 1 reply', 'item-w/A1': 'Pick a layout' });
  const urls = () => Object.fromEntries(read(queueFile).items.map((i) => [i.tag, i.url]));
  assert.equal(urls()['item-w/A1'], '/orch/prototype-layout.html?q=w-layout&from=push');

  assert.equal(board('thread', 'ask:e1', '--site', 'orch', '--text', 'Second answer\nwith more below').code, 0);
  assert.deepEqual(queue(), { 'ask-e1': 'Second answer · and 1 reply', 'item-w/A1': 'Pick a layout' });
  assert.equal(board('thread', 'ask:e1', '--site', 'orch', '--who', 'love', '--text', 'Thanks').code, 0);
  assert.equal(board('thread', 'w/A1', '--site', 'orch', '--who', 'Jamie', '--via', 'github', '--text', 'Looks good').code, 0);
  assert.deepEqual(queue(), { 'ask-e1': 'Second answer · and 1 reply', 'item-w/A1': 'Pick a layout' });

  assert.equal(board('reply', 'e1', '--site', 'orch', '--html', '<p>Third &amp; <b>final</b></p><details><summary>Why</summary>Long</details>').code, 0);
  const long = 'Layout B, because '.repeat(20);
  assert.equal(board('reply', 'm1', '--site', 'orch', '--html', `<p>${long}</p>`).code, 0);
  const bodies = queue();
  assert.equal(bodies['ask-e1'], 'Third & final · and 1 reply');
  // Once Claude answers in the thread, the push opens that thread at its reply box, not the page it first linked.
  assert.equal(urls()['item-w/A1'], '/orch/#item=w%2FA1&reply');
  assert.ok(bodies['item-w/A1'].length <= 160 && bodies['item-w/A1'].endsWith('…') && long.startsWith(bodies['item-w/A1'].slice(0, -1)));

  write(queueFile, { items: [] });
  assert.equal(board('thread', 'ask:e1', '--site', 'orch', '--text', 'After it went out').code, 0);
  assert.deepEqual(read(queueFile).items, []);
});

test("after a thread's push has gone, Claude's next line answering the owner there pushes again at once under its tag; other lines stay quiet", () => withDevice(async (b, received) => {
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'm1', ts: '2026-10-23T10:05:00Z', kind: 'item-message', data: { key: 'w/A1' } }) + '\n');
  const seen = () => received.map(({ title, body, url, tag }) => [tag, title, body, url]);
  const url = '/orch/#item=ask%3Ae1';

  assert.equal((await b('push', '--site', 'orch', '--now', '--title', 'Answered: keep it?', '--body', 'Yes', '--url', url, '--tag', 'ask-e1')).code, 0);
  assert.deepEqual(seen(), [['ask-e1', 'Answered: keep it?', 'Yes', `${url}&reply`]]);

  assert.equal((await b('thread', 'ask:e1', '--site', 'orch', '--text', 'Reading SKILL.md')).code, 0);
  assert.equal((await b('thread', 'ask:e1', '--site', 'orch', '--who', 'love', '--text', 'And the follow-up?')).code, 0);
  assert.equal((await b('thread', 'ask:e1', '--site', 'orch', '--who', 'Jamie', '--via', 'github', '--text', 'Looks good')).code, 0);
  assert.equal((await b('builder', 'progress', 'w/A1', '--site', 'orch', 'Running', 'tests')).code, 0);
  assert.equal((await b('reply', 'm1', '--site', 'orch', '--html', '<p>No push has gone for this card</p>')).code, 0);
  assert.equal(received.length, 1);

  assert.equal((await b('thread', 'ask:e1', '--site', 'orch', '--text', 'Filed as follow-up INT-56\nwith more', '--answer')).code, 0);
  assert.equal((await b('reply', 'e1', '--site', 'orch', '--html', '<p>Done &amp; dusted</p>')).code, 0);
  assert.deepEqual(seen().slice(1), [['ask-e1', 'Answered: keep it?', 'Filed as follow-up INT-56 · and 1 reply', `${url}&reply`], ['ask-e1', 'Answered: keep it?', 'Done & dusted', `${url}&reply`]]);
  assert.deepEqual(read(at('web-ts', 'push', 'queue.json')).items, []);

  assert.equal((await b('thread', 'ask:e1', '--site', 'orch', '--who', 'love', '--text', 'Mine', '--answer')).code, 1);
  assert.equal(received.length, 3);
}));

test('checked sends the queued pushes at the end of a tick, each as its own notification', () => withDevice(async (b, received) => {
  assert.equal((await b('push', '--site', 'orch', '--title', '2 PRs merged', '--body', '0 open', '--url', '/orch/')).code, 0);
  assert.equal((await b('push', '--site', 'orch', '--title', 'A1 waits on Ready', '--url', '/orch/#item=w%2FA1', '--tag', 'item-w/A1')).code, 0);
  assert.equal(received.length, 0);
  assert.equal((await b('checked', '--site', 'orch', '--every', '15')).code, 0);
  assert.deepEqual(received.map(({ title, tag, url }) => [title, tag, url]), [['2 PRs merged', undefined, '/orch/'], ['A1 waits on Ready', 'item-w/A1', '/orch/#item=w%2FA1&reply']]);
  assert.deepEqual(read(at('web-ts', 'push', 'queue.json')).items, []);
}));

test('item set refuses to start a blocked item, and done or merged names the items it unblocked and says so in their threads', () => {
  write(at('waves', 'd', 'wave.json'), { items: [
    { id: 'A1', title: 'One', status: 'building' },
    { id: 'A2', title: 'Two', status: 'waiting', deps: ['A1'] },
    { id: 'A3', title: 'Three', status: 'waiting', deps: ['A1', 'A2'] },
    { id: 'A4', title: 'Four', status: 'done', deps: ['A1'] },
  ] });
  const status = () => read(at('waves', 'd', 'wave.json')).items.map((it) => it.status);
  const blocked = board('item', 'set', 'd/A3', '--status', 'building', '--site', 'orch');
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /d\/A1.*d\/A2|d\/A2.*d\/A1/);
  assert.deepEqual(status(), ['building', 'waiting', 'waiting', 'done']);
  const done = board('item', 'set', 'd/A1', '--status', 'done', '--site', 'orch');
  assert.equal(done.code, 0);
  assert.deepEqual(done.out.split('\n').filter((l) => l.startsWith('unblocked')), ['unblocked: d/A2']);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'd__A2.jsonl')).map(({ ts, ...m }) => m), [{ who: 'claude', text: 'Unblocked: A1 is done.' }]);
  assert.equal(fs.existsSync(site('orch', 'data', 'threads', 'd__A3.jsonl')), false);
  assert.equal(board('item', 'set', 'd/A2', '--status', 'building', '--site', 'orch').code, 0);
  const merged = board('item', 'set', 'd/A2', '--status', 'merged', '--site', 'orch');
  assert.deepEqual(merged.out.split('\n').filter((l) => l.startsWith('unblocked')), ['unblocked: d/A3']);
});

test('item set takes checking as a hand-back that unblocks nothing, and done from checking unblocks as usual', () => {
  write(at('waves', 'd', 'wave.json'), { items: [
    { id: 'A1', title: 'One', status: 'building' },
    { id: 'A2', title: 'Two', status: 'waiting', deps: ['A1'] },
  ] });
  const unblocked = (r) => r.out.split('\n').filter((l) => l.startsWith('unblocked'));
  const checking = board('item', 'set', 'd/A1', '--status', 'checking', '--site', 'orch');
  assert.equal(checking.code, 0);
  assert.deepEqual(unblocked(checking), []);
  assert.equal(read(at('waves', 'd', 'wave.json')).items[0].status, 'checking');
  assert.equal(board('item', 'set', 'd/A2', '--status', 'building', '--site', 'orch').code, 1);
  assert.deepEqual(unblocked(board('item', 'set', 'd/A1', '--status', 'done', '--site', 'orch')), ['unblocked: d/A2']);
});

test('a held item never starts or unblocks until --unheld resumes it', () => {
  write(at('waves', 'd', 'wave.json'), { items: [
    { id: 'A1', title: 'One', status: 'building' },
    { id: 'A2', title: 'Two', status: 'waiting', deps: ['A1'] },
    { id: 'A3', title: 'Three', status: 'held' },
  ] });
  const items = () => read(at('waves', 'd', 'wave.json')).items;
  assert.equal(board('item', 'set', 'd/A2', '--held', '--site', 'orch').code, 0);
  assert.equal(items()[1].held, true);
  assert.equal(board('item', 'set', 'd/A2', '--held', '--unheld', '--site', 'orch').code, 1);
  const done = board('item', 'set', 'd/A1', '--status', 'done', '--site', 'orch');
  assert.deepEqual(done.out.split('\n').filter((l) => l.startsWith('unblocked')), []);
  const refused = board('item', 'set', 'd/A2', '--status', 'building', '--site', 'orch');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /d\/A2 is held.*--unheld/);
  assert.equal(items()[1].status, 'waiting');
  assert.equal(board('item', 'set', 'd/A3', '--status', 'building', '--site', 'orch').code, 1);
  assert.equal(board('item', 'set', 'd/A2', '--unheld', '--site', 'orch').code, 0);
  assert.equal(board('item', 'set', 'd/A3', '--unheld', '--site', 'orch').code, 0);
  assert.deepEqual(items().map((it) => [it.status, Boolean(it.held)]), [['done', false], ['waiting', false], [undefined, false]]);
  assert.equal(board('item', 'set', 'd/A2', '--status', 'building', '--site', 'orch').code, 0);
});

test("thread writes in an ask's thread and refuses an unknown ask", () => {
  assert.equal(board('thread', 'ask:e1', '--site', 'orch', '--text', 'Answered here.').code, 0);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'ask__e1.jsonl')).map(({ ts, ...m }) => m), [{ who: 'claude', text: 'Answered here.' }]);
  assert.match(board('thread', 'ask:e9', '--site', 'orch', '--text', 'x').err, /no ask "e9"/);
});

test('item relate-ask folds an ask into an item with one summary line, ask unfold and item set --from-ask move it back out', () => {
  const r = board('item', 'relate-ask', 'e1', 'w/A1', '--summary', 'Asked to keep the header spacing', '--site', 'orch');
  assert.equal(r.code, 0);
  assert.deepEqual(read(site('orch', 'data', 'ask-links.json')), { links: { e1: 'w/A1' } });
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map(({ ts, ...m }) => m), [{ who: 'claude', text: 'Asked to keep the header spacing' }]);
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'm1', ts: '2026-10-23T10:00:00Z', kind: 'item-message', data: { key: 'w/A1' } }) + '\n');
  assert.match(board('item', 'relate-ask', 'm1', 'w/A1', '--summary', 'x', '--site', 'orch').err, /no ask "m1"/);
  assert.match(board('item', 'relate-ask', 'e1', 'w/A9', '--summary', 'x', '--site', 'orch').err, /no item "A9"/);
  assert.equal(board('ask', 'unfold', 'e1', '--site', 'orch').code, 0);
  assert.deepEqual(read(site('orch', 'data', 'ask-links.json')), { links: {} });
  assert.match(board('ask', 'unfold', 'e1', '--site', 'orch').err, /ask "e1" is not folded into a card/);
  board('item', 'relate-ask', 'e1', 'w/A1', '--summary', 'Back in', '--site', 'orch');
  assert.equal(board('item', 'set', 'w/A1', '--from-ask', 'e1', '--site', 'orch').code, 0);
  assert.deepEqual([read(site('orch', 'data', 'ask-links.json')), read(at('waves', 'w', 'wave.json')).items[0].from_ask], [{ links: {} }, 'e1']);
});

function boardsManifest() {
  const entry = (route) => ({ dir: site(route), port: 1, cmd: [process.execPath, '/skill/board/server.mjs', site(route)] });
  write(at('web-ts', 'manifest.json'), { sites: { orch: entry('orch'), audit: entry('audit'), notes: { dir: site('notes'), port: 1, cmd: [process.execPath, 'server.mjs'] } } });
}
const addEvents = (...events) => fs.appendFileSync(site('orch', 'data', 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));

test("ask move sends a New ask to another board with the owner's latest text, its attachments and where it came from, and leaves it Done here with a line linking there", () => {
  boardsManifest();
  write(site('orch', 'data', 'uploads', '1700-shot.png'), 'png bytes');
  write(site('orch', 'data', 'uploads', '.meta', '1700-shot.png.json'), { name: 'shot.png', type: 'image/png', size: 9, at: '2026-10-23T09:00:00Z' });
  const shot = { name: 'shot.png', url: 'uploads/1700-shot.png', path: site('orch', 'data', 'uploads', '1700-shot.png'), type: 'image/png', size: 9 };
  addEvents({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Fix the audit header', files: [shot] } },
    { id: 'e3', ts: '2026-10-23T11:05:00Z', kind: 'ask-edited', data: { id: 'e2', text: 'Fix the audit header spacing' } });
  const r = board('ask', 'move', 'e2', '--to', 'audit', '--site', 'orch');
  assert.equal(r.code, 0, r.err);
  const [moved, ...others] = lines(site('audit', 'data', 'events.jsonl'));
  assert.equal(others.length, 0);
  const [file] = moved.data.files;
  assert.deepEqual([moved.kind, moved.data.text, moved.data.from, file.name, file.type], ['ask', 'Fix the audit header spacing', { route: 'orch', title: 'Orch', id: 'e2' }, 'shot.png', 'image/png']);
  assert.match(file.url, /^uploads\/\d+-shot\.png$/);
  assert.equal(file.path, site('audit', 'data', file.url));
  assert.equal(fs.readFileSync(site('audit', 'data', file.url), 'utf8'), 'png bytes');
  assert.equal(read(site('audit', 'data', 'uploads', '.meta', `${file.url.slice(8)}.json`)).name, 'shot.png');
  const link = `/audit/#item=ask%3A${moved.id}`;
  assert.match(r.out, new RegExp(`moved to ${link.replace(/[/#%]/g, '\\$&')}`));
  const mark = read(site('orch', 'data', 'ask-progress.json')).asks.e2;
  assert.deepEqual([mark.state, mark.moved], ['done', { route: 'audit', title: 'Audit', id: moved.id }]);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'ask__e2.jsonl')).map(({ ts, ...m }) => m), [{ who: 'claude', text: 'Moved to Audit.', link }]);

  assert.match(board('ask', 'move', 'e2', '--to', 'audit', '--site', 'orch').err, /ask "e2" was already moved to \/audit/);
  assert.match(board('ask', 'progress', 'e2', '--site', 'orch').err, /ask "e2" was moved to \/audit/);
  assert.match(board('item', 'set', 'w/A1', '--from-ask', 'e2', '--site', 'orch').err, /ask "e2" was moved to \/audit/);
  assert.equal(lines(site('audit', 'data', 'events.jsonl')).length, 1);
});

test('ask move refuses a route that is not another board, and an ask that is not New, changing nothing', () => {
  boardsManifest();
  addEvents({ id: 'e4', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Folded' } }, { id: 'e5', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Deleted' } },
    { id: 'e6', ts: '2026-10-23T11:01:00Z', kind: 'ask-withdrawn', data: { id: 'e5' } }, { id: 'e7', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Talked' } },
    { id: 'm1', ts: '2026-10-23T11:00:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'Not an ask' } });
  board('reply', 'e1', '--site', 'orch', '--html', '<p>Answered.</p>');
  board('item', 'relate-ask', 'e4', 'w/A1', '--summary', 'Folded in', '--site', 'orch');
  board('thread', 'ask:e7', '--site', 'orch', '--text', 'Answered in the thread.');
  const refusals = [
    [['e7', '--to', 'nope'], /--to nope: no board at \/nope in the hub's manifest; the boards are orch, audit/],
    [['e7', '--to', 'notes'], /no board at \/notes/],
    [['e7', '--to', 'orch'], /--to orch: that is this board/],
    [['e7'], /ask move needs --to <route>/],
    [['m1', '--to', 'audit'], /no ask "m1"/],
    [['e1', '--to', 'audit'], /ask "e1" is not New: Claude already answered it/],
    [['e7', '--to', 'audit'], /ask "e7" is not New/],
    [['e4', '--to', 'audit'], /ask "e4" is folded into w\/A1; run ask unfold e4 first/],
    [['e5', '--to', 'audit'], /ask "e5" was deleted by the owner/],
  ];
  for (const [args, err] of refusals) {
    const r = board('ask', 'move', ...args, '--site', 'orch');
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err);
    assert.equal(r.err.trim().split('\n').length, 1);
  }
  assert.equal(fs.existsSync(site('audit', 'data', 'events.jsonl')), false);
  assert.equal(fs.existsSync(site('orch', 'data', 'ask-progress.json')), false);
});

test('ask move drops the card an ask became when it has not started, and refuses one that has', () => {
  boardsManifest();
  addEvents({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Filed first' } }, { id: 'e3', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Started' } });
  board('item', 'set', 'w/A1', '--from-ask', 'e2', '--site', 'orch');
  board('item', 'add', 'w/A2', '--title', 'Two', '--site', 'orch');
  board('item', 'set', 'w/A2', '--from-ask', 'e3', '--status', 'building', '--site', 'orch');
  assert.match(board('ask', 'move', 'e3', '--to', 'audit', '--site', 'orch').err, /ask "e3" became w\/A2, which has started/);
  const r = board('ask', 'move', 'e2', '--to', 'audit', '--site', 'orch');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /dropped: w\/A1/);
  assert.deepEqual(read(at('waves', 'w', 'wave.json')).items.map((i) => [i.id, i.status]), [['A1', 'dropped'], ['A2', 'building']]);
  assert.deepEqual(lines(site('audit', 'data', 'events.jsonl')).map((e) => e.data.text), ['Filed first']);
  assert.equal(lines(site('orch', 'data', 'threads', 'ask__e2.jsonl'))[0].text, 'Moved to Audit.');
});

test('item set records when the status last changed, and only then', () => {
  board('item', 'set', 'w/A1', '--status', 'building', '--site', 'orch');
  const first = read(at('waves', 'w', 'wave.json')).items[0].status_at;
  assert.ok(Date.parse(first));
  board('item', 'set', 'w/A1', '--next', 'Later', '--site', 'orch');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status_at, first);
  board('item', 'set', 'w/A1', '--status', 'done', '--site', 'orch');
  assert.ok(read(at('waves', 'w', 'wave.json')).items[0].status_at > first);
});

test('ask progress and ask done mark a known ask, keeping --next only while in progress, and refuse an unknown ask', () => {
  assert.equal(board('ask', 'progress', 'e1', '--next', 'Pick a take', '--site', 'orch').code, 0);
  const marked = read(site('orch', 'data', 'ask-progress.json')).asks.e1;
  assert.deepEqual([marked.state, marked.next, Boolean(Date.parse(marked.at))], ['progress', 'Pick a take', true]);
  assert.equal(board('ask', 'done', 'e1', '--site', 'orch').code, 0);
  const done = read(site('orch', 'data', 'ask-progress.json')).asks.e1;
  assert.deepEqual([done.state, done.next], ['done', undefined]);
  assert.match(board('ask', 'progress', 'e9', '--site', 'orch').err, /no ask "e9"/);
  assert.match(board('ask', 'done', 'e1', '--next', 'x', '--site', 'orch').err, /does not take --next/);
});

test('checked records when GitHub was last checked and the interval, and refuses a bad interval', () => {
  assert.equal(board('checked', '--site', 'orch', '--every', '60').code, 0);
  const c = read(site('orch', 'data', 'checked.json'));
  assert.equal(c.every, 60);
  assert.ok(Date.now() - Date.parse(c.at) < 60000);
  assert.equal(board('checked', '--site', 'orch').code, 0);
  assert.equal(read(site('orch', 'data', 'checked.json')).every, 30);
  const bad = board('checked', '--site', 'orch', '--every', '0');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--every/);
  assert.equal(board('checked', '--site', 'orch', '--idle').code, 0);
  assert.deepEqual({ ...read(site('orch', 'data', 'checked.json')), at: null }, { at: null, every: null, idle: true });
  assert.equal(board('checked', '--site', 'orch', '--every', '30').code, 0);
  assert.equal(read(site('orch', 'data', 'checked.json')).idle, undefined);
  assert.equal(board('checked', '--site', 'orch', '--idle', '--every', '30').code, 1);
});

test("reviewers set, add and remove keep the board's own reviewers in its board.json", () => {
  const ann = { name: 'Ann', slack_user: 'U01ANN', dm: 'D01ANN', github: 'ann' };
  const bob = { name: 'Bob', slack_user: 'U02BOB', dm: 'D02BOB', github: 'bob-b' };
  const cfg = () => read(site('orch', 'board.json'));
  write(path.join(home, 'r.json'), [ann]);
  assert.equal(board('reviewers', 'set', '--site', 'orch', '--file', path.join(home, 'r.json')).code, 0);
  assert.deepEqual(cfg(), { title: 'Orch', items: 'waves', reviewers: [ann] });
  write(path.join(home, 'bob.json'), bob);
  assert.equal(board('reviewers', 'add', '--site', 'orch', '--file', path.join(home, 'bob.json')).code, 0);
  write(path.join(home, 'ann.json'), [{ ...ann, name: 'ann', github: 'ann-2' }]);
  assert.equal(board('reviewers', 'add', '--site', 'orch', '--file', path.join(home, 'ann.json')).code, 0);
  assert.deepEqual(cfg().reviewers, [{ ...ann, name: 'ann', github: 'ann-2' }, bob]);
  assert.equal(board('reviewers', 'remove', 'Ann', '--site', 'orch').code, 0);
  assert.deepEqual(cfg().reviewers, [bob]);

  const rejected = [[{ name: 'Cy' }], [{ ...ann, email: 'a@x' }], [{ ...ann, slack_user: 'ann' }], [ann, { ...ann, name: 'ANN' }], ann];
  for (const file of rejected) {
    write(path.join(home, 'bad.json'), file);
    assert.equal(board('reviewers', 'set', '--site', 'orch', '--file', path.join(home, 'bad.json')).code, 1, JSON.stringify(file));
  }
  assert.match(board('reviewers', 'remove', 'Bob', 'Zed', '--site', 'orch').err, /Zed/);
  assert.equal(board('reviewers', 'set', '--file', path.join(home, 'r.json')).code, 1);
  assert.deepEqual(cfg(), { title: 'Orch', items: 'waves', reviewers: [bob] });
});

test("settings prints the board's settings as JSON, off when absent, and settings set auto-merge on|off writes board.json keeping its other keys", () => {
  const cfg = () => read(site('orch', 'board.json'));
  write(site('orch', 'board.json'), { title: 'Orch', items: 'waves', rules: [{ id: 'r1', text: 'Ask first', by: 'owner', at: 'x' }] });
  assert.deepEqual(board('settings', '--site', 'orch'), { code: 0, out: '{"auto_merge":false}\n', err: '' });
  const on = board('settings', 'set', 'auto-merge', 'on', '--site', 'orch');
  assert.equal(on.code, 0);
  assert.match(on.out, /^auto-merge on$/m);
  assert.deepEqual(cfg(), { title: 'Orch', items: 'waves', rules: [{ id: 'r1', text: 'Ask first', by: 'owner', at: 'x' }], auto_merge: true });
  assert.equal(board('settings', '--site', 'orch').out, '{"auto_merge":true}\n');
  assert.equal(board('settings', 'set', 'auto-merge', 'off', '--site', 'orch').code, 0);
  assert.equal(cfg().auto_merge, false);

  const bad = [
    [['settings'], 1, /needs --site/],
    [['settings', 'set', 'auto-merge', 'yes', '--site', 'orch'], 1, /takes on or off/],
    [['settings', 'set', 'auto-deploy', 'on', '--site', 'orch'], 1, /no board setting "auto-deploy"; settings are auto-merge/],
    [['settings', 'set', 'auto-merge', '--site', 'orch'], 2, /settings set takes <name> <on\|off>/],
  ];
  for (const [args, code, err] of bad) {
    const r = board(...args);
    assert.equal(r.code, code, args.join(' '));
    assert.match(r.err, err, args.join(' '));
  }
  assert.equal(cfg().auto_merge, false);
});

test("rules add, edit and remove keep a board's rules in its board.json and the hub's in settings.json, and list prints both", () => {
  const settings = { polling: { windows: [{ from: '08:00', every_minutes: 15 }], hold_overnight: true }, other_key: 'kept' };
  write(at('web-ts', 'settings.json'), settings);
  write(site('orch', 'board.json'), { title: 'Orch', items: 'waves', reviewers: [{ name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' }] });
  assert.deepEqual([board('rules', 'list', '--site', 'orch').out], ['']);
  const added = board('rules', 'add', '--site', 'orch', '--text', 'Ask before\n  touching main');
  assert.equal(added.code, 0);
  const boardId = /^id (\S+)$/m.exec(added.out)[1];
  const hubId = /^id (\S+)$/m.exec(board('rules', 'add', '--hub', '--by', 'claude', '--text', 'Screenshots in every PR').out)[1];
  const cfg = read(site('orch', 'board.json'));
  assert.deepEqual([cfg.title, cfg.reviewers.length, cfg.rules.map((r) => [r.id, r.text, r.by])], ['Orch', 1, [[boardId, 'Ask before touching main', 'owner']]]);
  assert.deepEqual({ ...read(at('web-ts', 'settings.json')), rules: undefined }, { ...settings, rules: undefined });
  const list = board('rules', 'list', '--site', 'orch');
  assert.equal(list.out, `hub ${hubId} claude Screenshots in every PR\nboard ${boardId} owner Ask before touching main\n`);
  assert.equal(board('rules', 'list').out, `hub ${hubId} claude Screenshots in every PR\n`);

  assert.equal(board('rules', 'edit', boardId, '--site', 'orch', '--text', 'Ask first').code, 0);
  assert.equal(board('rules', 'edit', hubId, '--hub', '--text', 'Screenshots always').code, 0);
  assert.deepEqual(read(at('web-ts', 'settings.json')).rules.map((r) => [r.text, r.by]), [['Screenshots always', 'claude']]);
  assert.match(board('rules', 'remove', hubId, '--site', 'orch').err, /it is a hub rule, so pass --hub/);
  assert.match(board('rules', 'remove', boardId, '--hub', '--site', 'orch').err, /it is a board rule, so drop --hub/);
  assert.equal(board('rules', 'remove', boardId, '--site', 'orch').code, 0);
  assert.equal(board('rules', 'remove', hubId, '--hub').code, 0);
  assert.equal(board('rules', 'list', '--site', 'orch').out, '');
  assert.deepEqual(read(site('orch', 'board.json')).rules, []);
});

test('rules refuse a board rule without --site, an empty text, an unknown author or id, and stray flags', () => {
  const bad = [
    [['rules', 'add', '--text', 'x'], 1, /needs --site/],
    [['rules', 'add', '--site', 'orch', '--text', '  '], 1, /non-empty/],
    [['rules', 'add', '--site', 'orch'], 1, /non-empty/],
    [['rules', 'add', '--site', 'orch', '--text', 'x', '--by', 'bob'], 1, /--by takes owner or claude/],
    [['rules', 'edit', 'r9', '--site', 'orch', '--text', 'x'], 1, /no board rule "r9"/],
    [['rules', 'remove', 'r9', '--hub'], 1, /no hub rule "r9"/],
    [['rules', 'remove', '--site', 'orch'], 2, /rules remove takes <id>/],
    [['rules', 'list', '--hub'], 2, /does not take --hub/],
    [['rules', 'edit', 'r9', '--site', 'orch', '--by', 'claude', '--text', 'x'], 2, /does not take --by/],
  ];
  for (const [args, code, err] of bad) {
    const r = board(...args);
    assert.equal(r.code, code, args.join(' '));
    assert.match(r.err, err, args.join(' '));
  }
  assert.equal(read(site('orch', 'board.json')).rules, undefined);
  assert.equal(fs.existsSync(at('web-ts', 'settings.json')), false);
});
