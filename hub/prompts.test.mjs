import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HUB_DIR, 'permission-hook.mjs');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-')));
process.env.HOME = home;
const { expired, GONE_AFTER, NO_ANSWER, UNREACHABLE, DROPPED, DENIED, WAIT_MS } = await import('./prompts.mjs');

const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };
const freePort = () => new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// The hook as Claude Code runs it: the input on stdin, the decision on stdout. → {status, out, ms}
function runHook(input, port) {
  return new Promise((resolve) => {
    const t = Date.now();
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, WEB_TS_HUB_PORT: String(port) } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, out: out ? JSON.parse(out) : null, ms: Date.now() - t }));
    child.stdin.end(JSON.stringify(input));
  });
}
const decision = (r) => { assert.equal(r.status, 0); assert.equal(r.out.hookSpecificOutput.hookEventName, 'PermissionRequest'); return r.out.hookSpecificOutput.decision; };

const bash = (command, extra = {}) => ({ session_id: 's1', cwd: '/r', hook_event_name: 'PermissionRequest', permission_mode: 'auto', tool_name: 'Bash', tool_input: { command, description: 'x' }, ...extra });
const question = { session_id: 's1', cwd: '/r', hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Colour?', header: 'C', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }] } };

// A hub that answers each prompt's first poll with `answer`, or holds every poll pending when answer is null, or
// says the prompt is gone when answer is 'gone'.
async function fakeHub({ answer, deadlineIn = WAIT_MS }) {
  const seen = { posted: [], deleted: [] };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.method === 'POST' && req.url === '/_hub/prompts') { seen.posted.push(JSON.parse(body)); return json(200, { id: 'p1', deadline: new Date(Date.now() + deadlineIn).toISOString() }); }
    if (req.method === 'DELETE') { seen.deleted.push(req.url); return json(200, { ok: true }); }
    if (answer === 'gone') return json(404, { state: 'gone' });
    if (answer) return json(200, { state: 'answered', answer });
    setTimeout(() => json(200, { state: 'pending' }), 200);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, seen, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test("the hook prints the owner's Allow once and Deny as the probe's decisions, and passes the hub the input it got", async () => {
  const hub = await fakeHub({ answer: { choice: 'allow' } });
  try {
    assert.deepEqual(decision(await runHook(bash('npm test'), hub.port)), { behavior: 'allow' });
    assert.deepEqual(hub.seen.posted, [bash('npm test')]);
  } finally { await hub.close(); }
  const no = await fakeHub({ answer: { choice: 'deny', message: DENIED } });
  try { assert.deepEqual(decision(await runHook(bash('npm test'), no.port)), { behavior: 'deny', message: DENIED }); } finally { await no.close(); }
});

test("Always allow adds only the prompt's addRules suggestions, each for the session, and with none one rule for that exact call", async () => {
  const hub = await fakeHub({ answer: { choice: 'always' } });
  try {
    const suggested = bash('curl -s x', { permission_suggestions: [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'curl -s x' }], behavior: 'allow', destination: 'localSettings' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { type: 'addDirectories', directories: ['/r'], destination: 'session' },
    ] });
    assert.deepEqual(decision(await runHook(suggested, hub.port)), { behavior: 'allow', updatedPermissions: [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'curl -s x' }], behavior: 'allow', destination: 'session' },
    ] });
    const built = async (input) => decision(await runHook(input, hub.port)).updatedPermissions;
    const one = (rule) => [{ type: 'addRules', rules: [rule], behavior: 'allow', destination: 'session' }];
    assert.deepEqual(await built(bash('touch /r/asked')), one({ toolName: 'Bash', ruleContent: 'touch /r/asked' }));
    assert.deepEqual(await built({ ...bash(''), tool_name: 'Write', tool_input: { file_path: '/r/a.md', content: 'x' } }), one({ toolName: 'Write', ruleContent: '//r/a.md' }));
    assert.deepEqual(await built({ ...bash(''), tool_name: 'WebFetch', tool_input: { url: 'https://docs.x.dev/a', prompt: 'p' } }), one({ toolName: 'WebFetch', ruleContent: 'domain:docs.x.dev' }));
    assert.deepEqual(await built({ ...bash(''), tool_name: 'mcp__linear__save_issue', tool_input: { title: 't' } }), one({ toolName: 'mcp__linear__save_issue' }));
  } finally { await hub.close(); }
});

test("an AskUserQuestion is allowed with the owner's picks as its answers, beside its own input", async () => {
  const hub = await fakeHub({ answer: { choice: 'allow', answers: { 'Colour?': 'Blue' } } });
  try {
    assert.deepEqual(decision(await runHook(question, hub.port)), { behavior: 'allow', updatedInput: { ...question.tool_input, answers: { 'Colour?': 'Blue' } } });
  } finally { await hub.close(); }
});

test("the hook denies with a note when no answer comes by the hub's deadline, telling the hub it gave up, when the hub drops the prompt, and at once when the hub can't be reached", async () => {
  const quiet = await fakeHub({ answer: null, deadlineIn: 1500 });
  try {
    const r = await runHook(bash('npm test'), quiet.port);
    assert.deepEqual(decision(r), { behavior: 'deny', message: NO_ANSWER });
    assert.ok(r.ms >= 1400 && r.ms < 6000, `${r.ms} ms`);
    assert.deepEqual(quiet.seen.deleted, ['/_hub/prompts/p1']);
  } finally { await quiet.close(); }
  const gone = await fakeHub({ answer: 'gone' });
  try { assert.deepEqual(decision(await runHook(bash('npm test'), gone.port)), { behavior: 'deny', message: DROPPED }); } finally { await gone.close(); }
  const r = await runHook(bash('npm test'), await freePort());
  assert.deepEqual(decision(r), { behavior: 'deny', message: UNREACHABLE });
  assert.ok(r.ms < 3000, `${r.ms} ms`);
});

test("a pending prompt expires once its hook stops polling or never takes its answer, with the hub's downtime not counted against it", () => {
  const t0 = Date.parse('2026-10-30T10:00:00Z');
  const iso = (ms) => new Date(t0 + ms).toISOString();
  const rec = (id, over) => ({ id, at: iso(0), deadline: iso(WAIT_MS), seen: iso(0), answer: null, ...over });
  const store = { prompts: {
    polling: rec('polling', { seen: iso(5 * 60_000) }),
    left: rec('left', { seen: iso(60_000) }),
    untaken: rec('untaken', { seen: iso(4 * 60_000), answer: { choice: 'allow', at: iso(4 * 60_000) } }),
    taking: rec('taking', { seen: iso(5 * 60_000), answer: { choice: 'allow', at: iso(5 * 60_000) } }),
  } };
  const now = 5 * 60_000 + GONE_AFTER / 2;
  assert.deepEqual(expired(store, { now: t0 + now }).map((r) => r.id), ['left', 'untaken']);
  assert.deepEqual(expired(store, { now: t0 + now, aliveSince: t0 + 5 * 60_000 }).map((r) => r.id), ['untaken']);
  assert.deepEqual(expired({ prompts: { late: rec('late', { seen: iso(WAIT_MS + GONE_AFTER) }) } }, { now: t0 + WAIT_MS + GONE_AFTER + 1 }).map((r) => r.id), ['late']);
});

// ---------- a scratch hub ----------
let hub;
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
function startHub() {
  hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, WEB_TS_HUB_PORT: String(port), WEB_TS_CLAUDE: '/usr/bin/false' } });
  return new Promise((resolve, reject) => {
    let out = '';
    hub.stdout.on('data', (d) => { out += d; if (out.includes('hub on')) resolve(); });
    hub.once('exit', reject);
  });
}
async function stopHub() {
  if (!hub || hub.exitCode !== null || hub.signalCode !== null) return;
  const exited = new Promise((resolve) => hub.once('exit', resolve));
  hub.kill('SIGTERM');
  await exited;
}
after(async () => { await stopHub(); fs.rmSync(home, { recursive: true, force: true }); });

const until = async (fn, what) => {
  for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail(`timed out waiting for ${what}`);
};
const hubPrompts = async () => (await (await fetch(`${base}/_hub/api/hub`)).json()).prompts;
const answer = (id, body) => fetch(`${base}/_hub/prompts/${id}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test("a session that owns no board waits on the hub page by its folder and counts in the badge; a question needs a pick on each, and its answer still reaches the hook after the hub restarts", async () => {
  write(path.join(home, '.claude', 'web-ts', 'manifest.json'), { version: 1, sites: {} });
  await startHub();
  const total = async () => (await (await fetch(`${base}/_hub/needs.json`)).json()).total;
  const two = { ...question, session_id: 's-nobody', cwd: path.join(home, 'work'), tool_input: { questions: [...question.tool_input.questions, { question: 'Size?', header: '', multiSelect: false, options: [{ label: 'S', description: '' }] }] } };
  const hook = runHook(two, port);
  const [p] = await until(async () => (await hubPrompts()).length && hubPrompts(), 'the prompt');
  assert.deepEqual([p.title, p.cwd, p.tool, p.questions.map((q) => q.question)], ['~/work', '~/work', 'AskUserQuestion', ['Colour?', 'Size?']]);
  assert.equal(await total(), 1);
  assert.equal((await answer(p.id, { choice: 'always' })).status, 400);
  assert.equal((await answer(p.id, { choice: 'allow', answers: { 'Colour?': 'Blue' } })).status, 400);
  assert.equal((await answer(p.id, { choice: 'allow', answers: { 'Colour?': 'Green', 'Size?': 'S' } })).status, 400);

  await stopHub();
  await startHub();
  assert.deepEqual((await hubPrompts()).map((x) => x.id), [p.id]);
  assert.equal((await answer(p.id, { choice: 'allow', answers: { 'Colour?': 'Blue', 'Size?': 'S' } })).status, 200);
  assert.equal((await answer(p.id, { choice: 'deny' })).status, 409);
  assert.deepEqual(decision(await hook), { behavior: 'allow', updatedInput: { ...two.tool_input, answers: { 'Colour?': 'Blue', 'Size?': 'S' } } });
  assert.deepEqual(await hubPrompts(), []);
  assert.equal(await total(), 0);
  assert.equal((await answer(p.id, { choice: 'deny' })).status, 404);
});
