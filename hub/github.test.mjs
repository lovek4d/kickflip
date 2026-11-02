import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGh, prView, writePR, writeUser, calls } from '../shared/fake-gh.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'github-'));
process.env.HOME = home;
const priorPath = process.env.PATH;
process.env.PATH = `${fakeGh(home)}:${priorPath}`;
writeUser(home, { login: 'owner' });
const { summarize, changesBetween, carry, checkGitHub } = await import('./github.mjs');
after(() => { process.env.PATH = priorPath; fs.rmSync(home, { recursive: true, force: true }); });

const gh = (over = {}) => ({
  pr: 7, state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
  head: 'abc1234567', failing: [], pending: 0, events: [], ...over,
});
const sum = (over) => summarize(gh(over));

test('summarize keeps the state fields, sorted failing names and the newest event', () => {
  const s = sum({ failing: ['lint', 'build', 'lint'], pending: 2, reviewDecision: '', events: [{ id: 11, at: '2026-10-23T10:00:00Z' }, { id: 12, at: '2026-10-23T11:00:00Z' }] });
  assert.deepEqual(s, {
    state: 'OPEN', isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', head: 'abc1234567',
    failing: ['build', 'lint'], pending: 2, eventId: '12', eventAt: '2026-10-23T11:00:00Z',
  });
});

test('a PR seen for the first time reports only a merge or unhandled comments', () => {
  assert.deepEqual(changesBetween(undefined, sum()), []);
  assert.deepEqual(changesBetween(undefined, sum({ failing: ['x'], isDraft: true })), []);
  assert.deepEqual(changesBetween(undefined, sum({ state: 'MERGED', events: [{ id: 1, at: 't' }] })), ['comments', 'merged']);
});

test('changesBetween names each kind of change once, in order', () => {
  const prev = sum();
  assert.deepEqual(changesBetween(prev, sum()), []);
  assert.deepEqual(changesBetween(prev, sum({ failing: ['build'] })), ['ci']);
  assert.deepEqual(changesBetween(sum({ pending: 3 }), sum({ pending: 1 })), []);
  assert.deepEqual(changesBetween(sum({ pending: 3 }), sum({ pending: 0 })), ['ci']);
  assert.deepEqual(changesBetween(prev, sum({ head: 'def', pending: 4 })), []);
  assert.deepEqual(changesBetween(prev, sum({ head: 'def', pending: 0 })), ['ci']);
  assert.deepEqual(changesBetween(prev, sum({ head: 'def', state: 'MERGED' })), ['ci', 'merged']);
  assert.deepEqual(changesBetween(prev, sum({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' })), ['review', 'mergeable']);
  assert.deepEqual(changesBetween(prev, sum({ events: [{ id: 5, at: 't' }] })), ['comments']);
  assert.deepEqual(changesBetween(sum({ events: [{ id: 5, at: 't' }] }), sum({ events: [{ id: 5, at: 't' }] })), []);
  assert.deepEqual(changesBetween(sum({ events: [{ id: 5, at: 't' }] }), sum()), []);
  assert.deepEqual(changesBetween(prev, sum({ state: 'MERGED' })), ['merged']);
  assert.deepEqual(changesBetween(sum({ state: 'MERGED' }), sum({ state: 'MERGED' })), []);
  assert.deepEqual(changesBetween(prev, sum({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })), ['mergeable']);
  assert.deepEqual(changesBetween(prev, sum({ isDraft: true })), ['draft']);
});

test("a head move never asks a session to rebuild an install", () => {
  const moved = changesBetween(sum(), sum({ head: 'def4567890' }));
  assert.deepEqual(moved, ['ci']);
  assert.deepEqual(changesBetween(undefined, sum({ head: 'def' })), []);
  assert.deepEqual(changesBetween(sum({ head: null }), sum({ head: 'def' })), ['ci']);
  assert.ok(!changesBetween(sum(), sum({ head: 'def', state: 'CLOSED' })).includes('head'));
  assert.ok(!changesBetween(sum(), sum({ head: null })).includes('head'));
});

test('an UNKNOWN mergeability is no change, and the last known one carries over it', () => {
  const prev = sum();
  const unknown = sum({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  assert.deepEqual(changesBetween(prev, unknown), []);
  const kept = carry(prev, unknown);
  assert.equal(kept.mergeable, 'MERGEABLE');
  assert.equal(kept.mergeStateStatus, 'BLOCKED');
  assert.deepEqual(changesBetween(kept, sum()), []);
  assert.deepEqual(changesBetween(kept, sum({ mergeable: 'CONFLICTING' })), ['mergeable']);
  assert.equal(carry(undefined, unknown).mergeable, 'UNKNOWN');
});

test('the poll remembers head changes without waking either kind of board until CI settles', async () => {
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const claude = (...parts) => path.join(home, '.claude', ...parts);
  const waveDir = path.join(home, 'waves-board');
  const fileDir = path.join(home, 'file-board');
  const events = (dir) => {
    const file = path.join(dir, 'data/events.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
  };
  const cmd = [process.execPath, new URL('../board/server.mjs', import.meta.url).pathname];
  const manifest = { sites: { waves: { dir: waveDir, port: 1, cmd }, file: { dir: fileDir, port: 1, cmd } } };
  write(path.join(waveDir, 'board.json'), { items: 'waves' });
  write(claude('waves', 'w', 'wave.json'), { repo: 'o/r', items: [
    { id: 'A1', pr: 7, install: { url: 'https://m/app.apk' } }, { id: 'A2', pr: 7 }, { id: 'A3', pr: 8 },
  ] });
  write(path.join(fileDir, 'board.json'), { items: 'data/wave.json', slug: 'own' });
  write(path.join(fileDir, 'data/wave.json'), { repo: 'o/r', items: [
    { id: 'S1', pr: 7, install: { url: 'https://m/app.apk', sha: 'new' } }, { id: 'S2', pr: 7 },
  ] });
  const result = (pr, head, more = {}) => writePR(home, pr, prView({ head, pending: 2, ...more }));
  const poll = () => checkGitHub({ every: 15, manifest });
  result(7, 'old');
  result(8, 'old');
  assert.deepEqual((await poll()).changes, []);
  result(7, 'new');
  result(8, 'new');
  const moved = await poll();
  assert.deepEqual(moved.changes, []);
  assert.deepEqual(events(waveDir), []);
  assert.deepEqual(events(fileDir), []);
  assert.deepEqual(calls(home).filter((a) => a[0] === 'pr').map((a) => a[2]), ['7', '8', '7', '8']);
  const state = JSON.parse(fs.readFileSync(claude('kickflip', 'github-state.json'), 'utf8'));
  assert.equal(state.prs['o/r#8'].head, 'new');
  assert.deepEqual((await poll()).events, []);
  result(7, 'newer', { pending: 0 });
  await poll();
  assert.deepEqual(events(waveDir).at(-1).data.prs, [
    { wave: 'w', id: 'A1', pr: 7, changes: ['ci'] }, { wave: 'w', id: 'A2', pr: 7, changes: ['ci'] },
  ]);
  assert.deepEqual(events(fileDir).at(-1).data.prs, [
    { wave: 'own', id: 'S1', pr: 7, changes: ['ci'] }, { wave: 'own', id: 'S2', pr: 7, changes: ['ci'] },
  ]);
});

test('the poll retries a failed CI delivery without repeating it on another board', async () => {
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const claude = (...parts) => path.join(home, '.claude', ...parts);
  const installDir = path.join(home, 'retry-install');
  const otherDir = path.join(home, 'retry-other');
  const cmd = [process.execPath, new URL('../board/server.mjs', import.meta.url).pathname];
  const manifest = { sites: { install: { dir: installDir, port: 1, cmd }, other: { dir: otherDir, port: 1, cmd } } };
  for (const [dir, install] of [[installDir, { url: 'https://m/app.apk' }], [otherDir, undefined]]) {
    write(path.join(dir, 'board.json'), { items: 'data/wave.json', slug: 'w' });
    write(path.join(dir, 'data/wave.json'), { repo: 'o/r', items: [{ id: 'A1', pr: 7, install }] });
  }
  const stateFile = claude('kickflip', 'github-state.json');
  write(stateFile, { prs: { 'o/r#7': sum() } });
  writePR(home, 7, prView({ head: 'new' }));
  const blocked = path.join(installDir, 'data/events.jsonl');
  fs.mkdirSync(blocked);
  const poll = () => checkGitHub({ every: 15, manifest });
  const first = await poll();
  assert.equal(first.failed.length, 1);
  assert.deepEqual(first.events.map((e) => e.route), ['other']);
  const otherEvents = path.join(otherDir, 'data/events.jsonl');
  const delivered = fs.readFileSync(otherEvents, 'utf8');
  assert.deepEqual(JSON.parse(delivered).data.prs, [{ wave: 'w', id: 'A1', pr: 7, changes: ['ci'] }]);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).prs['o/r#7'].head, 'abc1234567');
  fs.rmdirSync(blocked);
  const retried = await poll();
  assert.deepEqual(retried.failed, []);
  assert.deepEqual(retried.events.map((e) => e.route), ['install']);
  assert.deepEqual(JSON.parse(fs.readFileSync(blocked, 'utf8')).data.prs, [{ wave: 'w', id: 'A1', pr: 7, changes: ['ci'] }]);
  assert.equal(fs.readFileSync(otherEvents, 'utf8'), delivered);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).prs['o/r#7'].head, 'new');
  assert.deepEqual((await poll()).events, []);
});
