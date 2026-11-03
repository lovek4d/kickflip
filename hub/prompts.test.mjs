import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { until } from '../shared/test-helpers.mjs';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HUB_DIR, 'permission-hook.mjs');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-')));
process.env.HOME = home;
const { expired, GONE_AFTER, NO_ANSWER, UNREACHABLE, DROPPED, DENIED, WAIT_MS,
  promptRecord, answerOf, rememberRules, rememberedAnswer, pruneRemembered, readPrompts, savePrompts, updatePrompts, withPromptsLock, rememberedFor, pendingFor, matchesRule } = await import('./prompts.mjs');
const { readManifest, writeManifest, withManifestLock, saveJSON } = await import('./boards.mjs');

const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };
const writeManifestFile = (m) => withManifestLock(() => saveJSON(path.join(home, '.claude', 'kickflip', 'manifest.json'), m));
const freePort = () => new Promise((resolve, reject) => { const s = http.createServer().on('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

function runHook(input, port, preload) {
  return new Promise((resolve) => {
    const t = Date.now();
    const child = spawn(process.execPath, [...(preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : []), HOOK], { env: { ...process.env, KICKFLIP_HUB_PORT: String(port) } });
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

const live = { pid: 123, procStart: 'Fri Oct 30 10:00:00 2026' };
const board = { route: 'shop', title: 'Shop', owner: { session: 's1', since: '2026-10-30T17:00:00.000Z' } };
const context = () => ({ running: new Map([['s1', live]]), boards: [board] });
const kept = (inputs, choice = 'always') => {
  const store = { prompts: {}, remembered: {} };
  for (const input of inputs) {
    const rec = promptRecord(input, { board, live });
    rec.answer = answerOf(rec, { choice }).answer;
    rememberRules(store, rec, context());
  }
  return store;
};

test('remembered rules persist by session and match only the exact command, path, domain or bare tool', () => {
  const writeFile = (file_path) => ({ ...bash(''), tool_name: 'Write', tool_input: { file_path, content: 'x' } });
  const fetchUrl = (url) => ({ ...bash(''), tool_name: 'WebFetch', tool_input: { url } });
  const tool = (tool_name) => ({ ...bash(''), tool_name, tool_input: { title: 'x' } });
  const inputs = [bash('npm test'), writeFile('/r/a.md'), fetchUrl('https://docs.x.dev/a'), tool('mcp__linear__save_issue')];
  const store = kept(inputs);
  savePrompts(store);
  const restored = readPrompts();
  assert.deepEqual(restored, store);
  assert.deepEqual(Object.keys(restored.remembered), ['s1']);
  for (const input of [...inputs, fetchUrl('https://docs.x.dev/b')]) assert.deepEqual(rememberedAnswer(restored, input), { choice: 'allow' });
  for (const input of [bash('npm test '), bash('npm test --watch'), bash('npm'), writeFile('/r/a.md/child'), writeFile('/r/b.md'),
    fetchUrl('https://other.x.dev/a'), fetchUrl('https://sub.docs.x.dev/a'), fetchUrl('https://docs.x.dev.evil/a'), tool('mcp__linear__get_issue'),
    { ...inputs[0], session_id: 's2' }, { ...inputs[0], session_id: '' }]) assert.equal(rememberedAnswer(restored, input), null, JSON.stringify(input));
  assert.deepEqual(pendingFor('shop', restored), []);
  assert.deepEqual(rememberedFor('shop', restored), [{ session: 's1', rules: ['Bash(npm test)', 'Write(//r/a.md)', 'WebFetch(domain:docs.x.dev)', 'mcp__linear__save_issue'] }]);
});

test('suggested rules retain their exact scope; prefixes, globs and unknown rule contents never widen a match', () => {
  const suggestions = (rule) => [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [rule] }];
  const store = kept([bash('npm test', { permission_suggestions: suggestions({ toolName: 'Bash', ruleContent: 'npm test' }) })]);
  assert.deepEqual(rememberedAnswer(store, bash('npm test')), { choice: 'allow' });
  assert.equal(rememberedAnswer(store, bash('npm test extra')), null);
  for (const [rule, input] of [
    [{ toolName: 'Bash', ruleContent: 'npm:*' }, bash('npm test')],
    [{ toolName: 'Bash', ruleContent: 'npm *' }, bash('npm test')],
    [{ toolName: 'Write', ruleContent: '//r/**' }, { tool_name: 'Write', tool_input: { file_path: '/r/a' } }],
    [{ toolName: 'Write', ruleContent: '/r/a' }, { tool_name: 'Write', tool_input: { file_path: '/r/a' } }],
    [{ toolName: 'WebFetch', ruleContent: 'domain:*.x.dev' }, { tool_name: 'WebFetch', tool_input: { url: 'https://docs.x.dev' } }],
    [{ toolName: 'Other', ruleContent: 'x' }, { tool_name: 'Other', tool_input: { x: 'x' } }],
  ]) assert.equal(matchesRule(rule, input), false);
  assert.equal(matchesRule({ toolName: 'Bash' }, bash('anything')), true);
});

test('Allow once and Deny keep no rules and AskUserQuestion is never auto-answered, even by a bare tool rule', () => {
  for (const choice of ['allow', 'deny']) assert.deepEqual(kept([bash('npm test')], choice).remembered, {});
  const store = kept([question]);
  assert.deepEqual(store.remembered, {});
  store.remembered.s1 = { rules: [{ toolName: 'AskUserQuestion' }] };
  assert.equal(rememberedAnswer(store, question), null);
  assert.equal(matchesRule({ toolName: 'AskUserQuestion' }, question), false);
});

test('remembered rules end when the session stops, restarts under the same id, loses its board or changes owner', () => {
  for (const next of [
    { ...context(), running: new Map() },
    { ...context(), running: new Map([['s1', { ...live, pid: 124 }]]) },
    { ...context(), running: new Map([['s1', { ...live, procStart: 'another start' }]]) },
    { ...context(), boards: [] },
    { ...context(), boards: [{ ...board, owner: { session: 's2' } }] },
  ]) {
    const store = kept([bash('npm test')]);
    assert.equal(pruneRemembered(store, context()), false);
    assert.equal(pruneRemembered(store, next), true);
    assert.equal(rememberedAnswer(store, bash('npm test')), null);
    savePrompts(store);
    assert.deepEqual(readPrompts().remembered, {});
  }
  const rec = promptRecord(bash('npm test'), { board, live });
  rec.answer = { choice: 'always' };
  assert.equal(rememberRules({ prompts: {} }, rec, { ...context(), running: new Map() }), false);
  assert.equal(rememberRules({ prompts: {} }, rec, { ...context(), boards: [] }), false);
});

test('remembered rules follow a session into its board and then end when that board changes owner', () => {
  const store = { prompts: {}, remembered: {} };
  const rec = promptRecord(bash('npm test'), { board: null, live });
  rec.answer = { choice: 'always' };
  assert.equal(rememberRules(store, rec, { ...context(), boards: [] }), true);
  assert.equal(pruneRemembered(store, { ...context(), boards: [] }), false);
  assert.equal(rememberedFor(null, store).length, 1);
  assert.equal(pruneRemembered(store, context()), true);
  assert.equal(rememberedFor(null, store).length, 0);
  assert.equal(rememberedFor('shop', store).length, 1);
  assert.equal(store.remembered.s1.ownerSince, board.owner.since);
  assert.equal(pruneRemembered(store, { ...context(), boards: [{ ...board, owner: { session: 's2' } }] }), true);
  assert.equal(rememberedAnswer(store, bash('npm test')), null);
});

test('answering an older boardless prompt retains or resolves the current board binding', () => {
  for (const existing of [true, false]) {
    const store = { prompts: {}, remembered: {} };
    const older = promptRecord(bash('npm test'), { board: null, live });
    if (existing) {
      const newer = promptRecord(bash('npm run build'), { board, live });
      newer.answer = { choice: 'always' };
      assert.equal(rememberRules(store, newer, context()), true);
    }
    older.answer = { choice: 'always' };
    assert.equal(rememberRules(store, older, context()), true);
    assert.equal(store.remembered.s1.route, 'shop');
    assert.equal(store.remembered.s1.ownerSince, board.owner.since);
    assert.equal(store.remembered.s1.rules.length, existing ? 2 : 1);
    assert.equal(pruneRemembered(store, { ...context(), boards: [{ ...board, owner: { session: 's2', since: '2026-10-30T18:00:00.000Z' } }] }), true);
    assert.equal(rememberedAnswer(store, bash('npm test')), null);
    assert.equal(rememberedAnswer(store, bash('npm run build')), null);
  }
});

test('an owner change away and back while the hub is down invalidates remembered rules and pending prompts', () => {
  const store = kept([bash('npm test')]);
  const pending = promptRecord(bash('npm run build'), { board, live });
  store.prompts[pending.id] = pending;
  savePrompts(store);
  const restored = readPrompts();
  const returned = { ...context(), boards: [{ ...board, owner: { session: 's1', since: '2026-10-30T19:00:00.000Z' } }] };
  assert.equal(pruneRemembered(restored, returned), true);
  assert.equal(rememberedAnswer(restored, bash('npm test')), null);
  restored.prompts[pending.id].answer = { choice: 'always' };
  assert.equal(rememberRules(restored, restored.prompts[pending.id], returned), false);
  assert.equal(rememberedAnswer(restored, bash('npm run build')), null);
});

test('join clears boardless rules and prompts for both owners while the hub is stopped, even after a takeover back', () => {
  const web = (...parts) => path.join(home, '.claude', 'kickflip', ...parts);
  const dir = web('sites', 'shop');
  const join = (session) => {
    execFileSync(process.execPath, [path.join(HUB_DIR, '..', 'bin', 'kickflip.mjs'), 'join', '--name', 'shop',
      '--session', session, '--force', '--dir', dir, '--port', '4600',
      '--cmd', JSON.stringify([process.execPath, path.join(HUB_DIR, '..', 'board', 'server.mjs'), dir])],
    { env: { ...process.env, KICKFLIP_HUB_PORT: '1' }, stdio: 'pipe' });
  };
  for (const returns of [false, true]) {
    write(web('manifest.json'), { version: 1, sites: {} });
    const store = { prompts: {}, remembered: {} };
    for (const session of ['s1', 's2', 'unrelated']) {
      const rec = promptRecord({ ...bash('npm test'), session_id: session }, { board: null, live });
      rec.answer = { choice: 'always' };
      rememberRules(store, rec, { running: new Map([[session, live]]), boards: [] });
      rec.answer = null;
      store.prompts[rec.id] = rec;
    }
    savePrompts(store);
    join('s1');
    join('s2');
    if (returns) join('s1');
    const restored = readPrompts();
    const { sites } = JSON.parse(fs.readFileSync(web('manifest.json'), 'utf8'));
    const restarted = { running: new Map([['s1', live], ['s2', live], ['unrelated', live]]),
      boards: [{ route: 'shop', owner: sites.shop.owner }] };
    pruneRemembered(restored, restarted);
    assert.equal(rememberedAnswer(restored, bash('npm test')), null);
    assert.equal(rememberedAnswer(restored, { ...bash('npm test'), session_id: 's2' }), null);
    assert.deepEqual(Object.keys(restored.remembered), ['unrelated']);
    assert.deepEqual(Object.values(restored.prompts).map((r) => r.session), ['unrelated']);
  }
});

test('ownership writes clear both sessions across routes and boardless prompts, while a same-owner rejoin keeps them', async () => {
  const web = (...parts) => path.join(home, '.claude', 'kickflip', ...parts);
  const store = { prompts: {}, remembered: {} };
  for (const session of ['old', 'new', 'unrelated']) {
    store.remembered[session] = { route: null, runtime: live, rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] };
    for (const route of [null, 'shop', 'another']) {
      const rec = promptRecord({ ...bash('npm test'), session_id: session }, { board: route ? { ...board, route } : null, live });
      store.prompts[rec.id] = rec;
    }
  }
  for (const change of ['takeover', 'leave', 'generation', 'starting']) {
    const owner = { session: 'old', since: '2026-10-30T17:00:00Z' };
    write(web('manifest.json'), change === 'starting' ? { sites: {}, starting: { shop: owner } } : { sites: { shop: { owner } } });
    savePrompts(store);
    await withManifestLock(() => writeManifest(readManifest()));
    assert.deepEqual(readPrompts(), store);
    await withManifestLock(() => {
      const m = readManifest();
      if (change === 'leave') delete m.sites.shop;
      else if (change === 'starting') m.starting.shop = { ...owner, session: 'new' };
      else m.sites.shop.owner = { ...owner, session: change === 'generation' ? 'old' : 'new', since: '2026-10-30T18:00:00Z' };
      return writeManifest(m);
    });
    const dropped = change === 'leave' || change === 'generation' ? ['old'] : ['old', 'new'];
    assert.deepEqual(Object.keys(readPrompts().remembered), Object.keys(store.remembered).filter((s) => !dropped.includes(s)));
    assert.ok(Object.values(readPrompts().prompts).every((r) => !dropped.includes(r.session)));
  }
});

test('hub prompt mutations and ownership writes share a lock and cannot restore cleared rules or pending prompts', async () => {
  const web = (...parts) => path.join(home, '.claude', 'kickflip', ...parts);
  write(web('manifest.json'), { sites: { shop: { owner: board.owner } } });
  savePrompts({ prompts: {}, remembered: {} });
  let entered;
  const acquired = new Promise((resolve) => { entered = resolve; });
  let release;
  const held = withPromptsLock(async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
  });
  await acquired;
  const mutation = updatePrompts((store) => {
    Object.assign(store, kept([bash('npm test')]));
    const rec = promptRecord(bash('npm run build'), { board, live });
    store.prompts[rec.id] = rec;
  });
  release();
  await held;
  await mutation;
  await withManifestLock(() => {
    const m = readManifest();
    m.sites.shop.owner = { session: 's2', since: '2026-10-30T18:00:00Z' };
    return writeManifest(m);
  });
  await updatePrompts((store) => {
    assert.deepEqual(store, { prompts: {}, remembered: {} });
    store.prompts.unrelated = { session: 'unrelated', route: null };
  });
  assert.deepEqual(readPrompts().remembered, {});
  assert.deepEqual(Object.keys(readPrompts().prompts), ['unrelated']);
});

test('a session without a reliable process start cannot remember rules or retain persisted rules after PID reuse', () => {
  for (const procStart of [undefined, null, '', 'unknown']) {
    const uncertain = { ...live, procStart };
    const next = { ...context(), running: new Map([['s1', uncertain]]) };
    const store = { prompts: {}, remembered: {} };
    const rec = promptRecord(bash('npm test'), { board, live: uncertain });
    rec.answer = { choice: 'always' };
    assert.equal(rememberRules(store, rec, next), false);
    assert.equal(rememberedAnswer(store, bash('npm test')), null);
    store.remembered.s1 = { route: 'shop', ownerSince: board.owner.since,
      runtime: { pid: live.pid, procStart: procStart ?? null }, rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] };
    savePrompts(store);
    const restored = readPrompts();
    assert.equal(pruneRemembered(restored, next), true);
    assert.equal(rememberedAnswer(restored, bash('npm test')), null);
  }
});

test('the hook accepts an immediate remembered allow without polling and rejects immediate questions or other choices', async () => {
  const preload = (choice) => `globalThis.fetch = async (url, opts) => {
    if (opts?.method !== 'POST' || !url.endsWith('/_hub/prompts')) throw new Error('unexpected poll');
    return { ok: true, json: async () => ({ state: 'answered', answer: { choice: ${JSON.stringify(choice)} } }) };
  };`;
  assert.deepEqual(decision(await runHook(bash('npm test'), 1, preload('allow'))), { behavior: 'allow' });
  for (const [input, choice] of [[question, 'allow'], [bash('npm test'), 'deny'], [bash('npm test'), 'always']]) {
    assert.equal(decision(await runHook(input, 1, preload(choice))).behavior, 'deny');
  }
});

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
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
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

let hub;
let port;
let base;
function startHub() {
  hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(port), KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false' } });
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

const hubPrompts = async () => (await (await fetch(`${base}/_hub/api/hub`)).json()).prompts;
const answer = (id, body) => fetch(`${base}/_hub/prompts/${id}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test("a session that owns no board waits on the hub page by its folder and counts in the badge; a question needs a pick on each, and its answer still reaches the hook after the hub restarts", async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  write(path.join(home, '.claude', 'kickflip', 'manifest.json'), { version: 1, sites: {} });
  await startHub();
  const total = async () => (await (await fetch(`${base}/_hub/needs.json`)).json()).total;
  const two = { ...question, session_id: 's-nobody', cwd: path.join(home, 'work'), tool_input: { questions: [...question.tool_input.questions, { question: 'Size?', header: '', multiSelect: false, options: [{ label: 'S', description: '' }] }] } };
  const hook = runHook(two, port);
  let prompts;
  await until(async () => { prompts = await hubPrompts(); return prompts.length; }, 'the prompt appears on the hub');
  const [p] = prompts;
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

test('a remembered match bypasses prompts and push, survives a hub restart, and ends on owner change or session stop', async () => {
  await stopHub();
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const web = (...parts) => path.join(home, '.claude', 'kickflip', ...parts);
  const dir = web('sites', 'shop');
  const manifest = { version: 1, sites: { shop: { title: 'Shop', dir, port: await freePort(),
    cmd: [process.execPath, path.join(HUB_DIR, '..', 'board', 'server.mjs'), dir], owner: { ...board.owner } } } };
  await writeManifestFile(manifest);
  write(path.join(dir, 'board.json'), { title: 'Shop', items: 'items.json' });
  write(path.join(dir, 'items.json'), { items: [] });
  const sessionFile = path.join(home, '.claude', 'sessions', `${process.pid}.json`);
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim();
  write(sessionFile, { sessionId: 's1', pid: process.pid, procStart, kind: 'bg' });
  write(web('prompts.json'), { prompts: {}, remembered: {} });
  write(web('push', 'subs.json'), [{ endpoint: 'https://unused.invalid/device', keys: {} }]);
  write(web('settings.json'), { notifications: { on: true, weekends_off: false, snoozed_until: new Date(Date.now() + 86_400_000).toISOString() } });
  await startHub();
  const post = async (input) => (await (await fetch(`${base}/_hub/prompts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).json());
  const data = async () => (await (await fetch(`${base}/_hub/api/hub`)).json());
  const queue = () => JSON.parse(fs.readFileSync(web('push', 'queue.json'), 'utf8')).items;
  const first = await post(bash('npm test'));
  assert.equal((await answer(first.id, { choice: 'always' })).status, 200);
  const wait = await (await fetch(`${base}/_hub/prompts/${first.id}/wait`)).json();
  assert.equal(wait.answer.choice, 'always');
  await until(() => fs.existsSync(web('push', 'queue.json')), 'the initial prompt push');
  const pushed = queue().length;
  assert.deepEqual((await data()).groups[0].sites[0].remembered, [{ session: 's1', rules: ['Bash(npm test)'] }]);
  await stopHub();
  await startHub();
  assert.deepEqual(decision(await runHook(bash('npm test'), port)), { behavior: 'allow' });
  assert.deepEqual(JSON.parse(fs.readFileSync(web('prompts.json'), 'utf8')).prompts, {});
  assert.equal(queue().length, pushed);

  for (const [input, changed] of [
    [{ ...bash(''), tool_name: 'Write', tool_input: { file_path: '/r/a' } }, { ...bash(''), tool_name: 'Write', tool_input: { file_path: '/r/b' } }],
    [{ ...bash(''), tool_name: 'WebFetch', tool_input: { url: 'https://docs.x.dev/a' } }, { ...bash(''), tool_name: 'WebFetch', tool_input: { url: 'https://other.x.dev/a' } }],
  ]) {
    const p = await post(input);
    assert.equal((await answer(p.id, { choice: 'always' })).status, 200);
    await fetch(`${base}/_hub/prompts/${p.id}/wait`);
    assert.deepEqual(await post(input), { state: 'answered', answer: { choice: 'allow' } });
    const asked = await post(changed);
    assert.ok(asked.id);
    await fetch(`${base}/_hub/prompts/${asked.id}`, { method: 'DELETE' });
  }
  for (const input of [bash('npm test --watch'), question, { ...bash('npm test'), session_id: 's2' }]) {
    const asked = await post(input);
    assert.ok(asked.id);
    await fetch(`${base}/_hub/prompts/${asked.id}`, { method: 'DELETE' });
  }
  manifest.sites.shop.owner.session = 's2';
  await writeManifestFile(manifest);
  assert.deepEqual((await data()).groups[0].sites[0].remembered, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(web('prompts.json'), 'utf8')).remembered, {});
  const asked = await post(bash('npm test'));
  assert.ok(asked.id);
  await fetch(`${base}/_hub/prompts/${asked.id}`, { method: 'DELETE' });
  manifest.sites.shop.owner.session = 's1';
  await writeManifestFile(manifest);
  const again = await post(bash('npm test'));
  await answer(again.id, { choice: 'always' });
  fs.unlinkSync(sessionFile);
  assert.deepEqual((await data()).groups[0].sites[0].remembered, []);
  assert.ok((await post(bash('npm test'))).id);
});

test('remembered rules and question answers use own session and question keys', () => {
  for (const session of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
    const store = { prompts: {}, remembered: {} };
    const input = bash('npm test', { session_id: session });
    assert.equal(rememberedAnswer(store, input), null);
    const rec = promptRecord(input, { board: null, live });
    rec.answer = { choice: 'always' };
    assert.equal(rememberRules(store, rec, { running: new Map([[session, live]]), boards: [] }), true);
    savePrompts(store);
    assert.deepEqual(rememberedAnswer(readPrompts(), input), { choice: 'allow' });
    assert.equal(rememberedAnswer(readPrompts(), bash('other', { session_id: session })), null);
    const q = promptRecord({ ...question, tool_input: { questions: [{ question: session, options: [{ label: 'Yes' }] }] } }, { board: null, live });
    assert.match(answerOf(q, { answers: {} }).error, /Pick an answer/);
    assert.deepEqual(answerOf(q, { answers: { [session]: 'Yes' } }).answer.answers, { [session]: 'Yes' });
  }
});
