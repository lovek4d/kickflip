import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBoard } from '../shared/test-helpers.mjs';
import { startScriptRunner } from './server.mjs';
import { appendMessage } from './store.mjs';
import { ownerActions, ACTION_KIND } from './domain.mjs';
import { runScript, scriptSha, OUTPUT_CAP, SCRIPT_LIMIT } from './scripts.mjs';
import { plainLine, recordOnly } from '../bin/event-lines.mjs';

// docs/adr/2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md
function world(name) {
  const site = path.join(home, name);
  const data = path.join(site, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One', lane: 'progress', created: '2026-11-14T00:00:00Z' }] }));
  fs.writeFileSync(path.join(data, 'owner.json'), '{"items":[]}');
  const events = () => (fs.existsSync(path.join(data, 'events.jsonl')) ? fs.readFileSync(path.join(data, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const lines = () => fs.readFileSync(path.join(data, 'threads', 't__A1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const offer = async (body, text = 'Stops the stuck builder; my rules refuse kill.') => {
    const file = path.join(site, 'script.sh');
    fs.writeFileSync(file, body);
    await appendMessage(site, 't/A1', { text, script: file });
    return lines().filter((l) => l.script).at(-1).script;
  };
  return { site, data, events, lines, offer };
}
const send = (base, kind, data, headers = {}) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ kind, ...data }) });
const threadOf = async (base) => (await (await fetch(`${base}/api/thread?key=t/A1`)).json()).filter((m) => m.script);
const card = async (base) => (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === 't/A1');

test('a script offer is a message with its full script, its hash, and the host and user it runs as; an empty or oversized script is refused', async () => {
  const w = world('post');
  const body = '#!/bin/sh\necho one\necho two\n';
  const s = await w.offer(body);
  assert.deepEqual({ ...s, id: typeof s.id }, { id: 'string', body, sha: scriptSha(body), host: os.hostname().replace(/\.local$/, ''), user: os.userInfo().username });
  assert.equal(w.lines().at(-1).text, 'Stops the stuck builder; my rules refuse kill.');
  await assert.rejects(w.offer('  \n'), /--script .* is empty/);
  await assert.rejects(w.offer('x'.repeat(SCRIPT_LIMIT + 1)), /past a script's/);
  await assert.rejects(appendMessage(w.site, 't/A1', { text: 'x', script: path.join(w.site, 'script.sh'), who: 'love' }), /--script is the orchestrator's/);
});

// Starts a board whose script run runEnded() waits out: the runner's exit, then the board reading the result it wrote.
async function startRunning(t, site) {
  let exited;
  const startScript = (...args) => {
    const child = startScriptRunner(...args);
    exited = new Promise((resolve) => child.on('exit', resolve));
    return child;
  };
  const board = await startBoard(t, { site, startScript });
  const runEnded = async () => { await exited; board.changed('data/events.jsonl'); await board.settled(); };
  return { ...board, runEnded };
}

test('a waiting script is Action needed on its card and pushes at once; Run is the owner\'s, checked against the script\'s hash, runs once, and posts its result back', async (t) => {
  const w = world('run');
  const s = await w.offer('echo "ran in $(pwd)"\necho oops >&2\n');
  const { base, runEnded } = await startRunning(t, w.site);

  const waiting = await card(base);
  assert.equal(waiting.action.kind, ACTION_KIND.script);
  const push = ownerActions({ items: [waiting], needs: [], owner: [], reviews: { cards: [] } }).find((a) => a.tag === 'item-t/A1');
  assert.equal(push.now, true);
  assert.deepEqual((await threadOf(base)).map((m) => m.script.state), ['waiting']);

  // A shared person, even one with Full, sees it read-only.
  fs.writeFileSync(path.join(w.site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/items.json', slug: 't', share: [{ login: 'ann', level: 'full' }] }));
  assert.equal((await send(base, 'script-run', { key: 't/A1', id: s.id, sha: s.sha }, { 'x-kickflip-shared': 'ann' })).status, 403);
  // A page drawn from another script text can't run this one.
  const stale = await send(base, 'script-run', { key: 't/A1', id: s.id, sha: scriptSha('echo other') });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /changed/);
  assert.deepEqual(w.events(), []);

  assert.equal((await send(base, 'script-run', { key: 't/A1', id: s.id, sha: s.sha })).status, 200);
  assert.equal((await send(base, 'script-run', { key: 't/A1', id: s.id, sha: s.sha })).status, 400);
  await runEnded();
  const result = w.events().find((e) => e.kind === 'script-result');
  assert.deepEqual([result.data.key, result.data.id, result.data.exit], ['t/A1', s.id, 0]);
  assert.match(result.data.output, /^ran in \S+\noops\n$/);
  assert.equal(w.events().filter((e) => e.kind === 'script-run').length, 1);
  const [ran] = await threadOf(base);
  assert.deepEqual([ran.script.state, ran.script.exit, ran.script.log], ['finished', 0, `script-${s.id}.log`]);
  assert.match(fs.readFileSync(path.join(home, '.claude', 'kickflip', 'logs', ran.script.log), 'utf8'), /oops/);
  assert.equal((await card(base)).action, null);
  assert.equal((await send(base, 'script-run', { key: 't/A1', id: s.id, sha: s.sha })).status, 400);
});

test('a failing script reads failed with its exit code, and its output is capped at 64 KB with the whole of it in the log', async (t) => {
  const w = world('fail');
  const s = await w.offer(`head -c ${OUTPUT_CAP + 5000} /dev/zero | tr '\\0' a\necho\necho last line\nexit 3\n`);
  const { base, runEnded } = await startRunning(t, w.site);
  assert.equal((await send(base, 'script-run', { key: 't/A1', id: s.id, sha: s.sha })).status, 200);
  await runEnded();
  const [failed] = await threadOf(base);
  assert.deepEqual([failed.script.state, failed.script.exit], ['failed', 3]);
  assert.ok(failed.script.output.length <= OUTPUT_CAP);
  assert.match(failed.script.output, /last line\n$/);
  assert.ok(fs.statSync(path.join(home, '.claude', 'kickflip', 'logs', failed.script.log)).size > OUTPUT_CAP + 5000);
});

test('Decline marks the script declined, never runs it, and a new offer replaces a waiting one', async (t) => {
  const w = world('decline');
  const first = await w.offer('echo first\n');
  const second = await w.offer('echo second\n');
  const { base } = await startBoard(t, { site: w.site });
  assert.deepEqual((await threadOf(base)).map((m) => m.script.state), ['replaced', 'waiting']);
  assert.equal((await send(base, 'script-run', { key: 't/A1', id: first.id, sha: first.sha })).status, 400);

  assert.equal((await send(base, 'script-decline', { key: 't/A1', id: second.id })).status, 200);
  assert.deepEqual((await threadOf(base)).map((m) => m.script.state), ['replaced', 'declined']);
  assert.equal((await send(base, 'script-run', { key: 't/A1', id: second.id, sha: second.sha })).status, 400);
  assert.equal((await card(base)).action, null);
  assert.deepEqual(w.events().map((e) => e.kind), ['script-decline']);
});

test('the run itself times out, and the orchestrator hears the Run, its result and a decline', async () => {
  const log = path.join(home, 'timeout.log');
  const r = await runScript({ body: 'echo start\nsleep 5\necho never\n', cwd: home, log, timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.exit, 0);
  assert.equal(r.output, 'start\n');

  const line = (kind, data) => JSON.stringify({ id: 'e1', ts: '2026-11-14T12:00:00Z', kind, data: { key: 't/A1', ...data } });
  for (const kind of ['script-run', 'script-result', 'script-decline']) assert.equal(recordOnly(line(kind, { id: 's1' })), false, kind);
  const dir = world('lines').site;
  assert.match(await plainLine(dir, line('script-run', { id: 's1' })), /script-result event follows/);
  assert.match(await plainLine(dir, line('script-result', { id: 's1', exit: 2, output: 'a\nb\nboom' })), /script .*exit 2.*boom/);
  assert.match(await plainLine(dir, line('script-decline', { id: 's1' })), /declined/);
});
