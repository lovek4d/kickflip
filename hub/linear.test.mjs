import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeLinear, linearWorld, freePorts } from '../shared/test-helpers.mjs';
import { linearClient, linearStatus, readLinearKey, removeLinearKey, saveLinearKey, savedClient, stateFor, stageOf } from './linear.mjs';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));

function withHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-'));
  const old = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; fs.rmSync(home, { recursive: true, force: true }); });
  return path.join(home, '.claude', 'kickflip', 'linear.json');
}

test('the client reads the viewer and teams, creates projects and issues, and finds issues by identifier through the fetch it is given', async () => {
  const world = linearWorld();
  const linear = fakeLinear(world);
  const client = linearClient(world.key, { fetch: linear.fetch });
  assert.deepEqual(await client.viewer(), { viewer: { id: 'user-me', name: 'Love' }, workspace: 'Acme', url_key: 'acme' });
  assert.deepEqual((await client.teams()).map((t) => [t.key, t.name, t.projects.map((p) => p.name)]), [['ENG', 'Engineering', ['Backend Audit']], ['OPS', 'Ops', []]]);
  const project = await client.createProject('OPS', 'Hub board');
  assert.deepEqual([project.name, project.team], ['Hub board', 'OPS']);
  assert.deepEqual(linear.calls.at(-1).variables.input, { name: 'Hub board', teamIds: ['team-ops'] });
  const byId = await client.createIssue({ team: 'ENG', project: 'proj-audit', title: 'Rate limits', description: 'Why' });
  const byName = await client.createIssue({ team: 'ENG', project: 'backend audit', title: 'Second' });
  assert.deepEqual([byId.identifier, world.issues[byId.identifier].input], ['ENG-102', { teamId: 'team-eng', projectId: 'proj-audit', title: 'Rate limits', description: 'Why' }]);
  assert.equal(world.issues[byName.identifier].input.projectId, 'proj-audit');
  await assert.rejects(client.createIssue({ team: 'ENG', project: 'Nope', title: 'x' }), /no project Nope/);
  await assert.rejects(client.createIssue({ team: 'ZZZ', project: 'x', title: 'x' }), /no team ZZZ/);
  assert.deepEqual(await client.issue('ENG-102'), { identifier: 'ENG-102', team: 'ENG', assignee: null, state: { id: 's-todo', name: 'Todo', type: 'unstarted' } });
  assert.equal(await client.issue('ENG-9999'), null);
  await assert.rejects(linearClient('wrong', { fetch: linear.fetch }).viewer(), { message: 'Linear refused the key.', status: 400 });
  await assert.rejects(linearClient(world.key, { fetch: async () => { throw new Error('offline'); } }).viewer(), /Could not reach Linear: offline/);
});

test("a card's target maps to the team's workflow state by type and name, and a closed issue never reopens", async () => {
  const world = linearWorld();
  const [eng, ops] = world.teams;
  assert.deepEqual(['started', 'review', 'done', 'planned'].map((t) => stateFor(eng.states, t)?.name ?? null), ['In Progress', 'In Review', 'Done', null]);
  assert.deepEqual(['started', 'review', 'done'].map((t) => stateFor(ops.states, t)?.name ?? null), ['Doing', null, 'Shipped']);
  const reviewFirst = [{ id: 'r', name: 'Code Review', type: 'started', position: 1 }, { id: 'w', name: 'Working', type: 'started', position: 2 }];
  assert.deepEqual([stateFor(reviewFirst, 'started').id, stateFor(reviewFirst, 'review').id], ['w', 'r']);
  world.issues['ENG-1'] = { team: 'ENG', assignee: 'user-me', state: 's-todo' };
  world.issues['OPS-2'] = { team: 'OPS', assignee: 'user-me', state: 'o-todo' };
  const client = linearClient(world.key, { fetch: fakeLinear(world).fetch });
  assert.equal(await client.moveIssue('ENG-1', 'started'), 'In Progress');
  assert.equal(await client.moveIssue('ENG-1', 'started'), null);
  assert.equal(await client.moveIssue('ENG-1', 'review'), 'In Review');
  assert.equal(await client.moveIssue('ENG-1', 'done'), 'Done');
  assert.equal(await client.moveIssue('ENG-1', 'started'), null);
  assert.equal(world.issues['ENG-1'].state, 's-done');
  assert.equal(await client.moveIssue('OPS-2', 'review'), null);
  assert.equal(world.issues['OPS-2'].state, 'o-todo');
  await assert.rejects(client.moveIssue('ENG-404', 'done'), /no issue ENG-404/);
});

test('the stage order treats review as later than started and completed or canceled as done', () => {
  const states = [
    { type: 'backlog', name: 'Backlog' }, { type: 'triage', name: 'Triage' }, { type: 'unstarted', name: 'Todo' },
    { type: 'started', name: 'Working' }, { type: 'started', name: 'Code REVIEW' },
    { type: 'completed', name: 'Shipped' }, { type: 'canceled', name: 'Canceled' },
  ];
  assert.deepEqual(states.map(stageOf), [0, 0, 0, 1, 2, 3, 3]);
});

test('advanceIssue reads once and skips missing, unowned or later issues before looking up team states', async () => {
  const world = linearWorld();
  const linear = fakeLinear(world);
  const client = linearClient(world.key, { fetch: linear.fetch });
  world.issues['ENG-1'] = { team: 'ENG', assignee: 'someone-else', state: 's-todo' };
  world.issues['ENG-2'] = { team: 'ENG', assignee: 'user-me', state: 's-rev' };
  world.issues['ENG-3'] = { team: 'ENG', assignee: 'user-me', state: 's-cancel' };
  for (const id of ['ENG-404', 'ENG-1', 'ENG-2', 'ENG-3']) {
    linear.calls.length = 0;
    assert.equal(await client.advanceIssue(id, 'started', { owner: world.viewer.id }), null);
    assert.equal(linear.calls.length, 1);
    assert.ok(linear.calls[0].query.includes('issue(id'));
  }
  world.issues['OPS-1'] = { team: 'OPS', assignee: 'user-me', state: 'o-todo' };
  linear.calls.length = 0;
  assert.equal(await client.advanceIssue('OPS-1', 'review', { owner: world.viewer.id }), null);
  assert.equal(linear.calls.length, 2);
  assert.ok(!linear.calls.some((c) => c.query.includes('issueUpdate')));
});

test('the key is saved once Linear answers, as refused when Linear refuses it, in a mode 600 file, and its status names the workspace without the key', async (t) => {
  const file = withHome(t);
  const world = linearWorld();
  const { fetch } = fakeLinear(world);
  assert.deepEqual(linearStatus(), { set: false });
  for (const bad of ['', '   ', 'two words']) await assert.rejects(saveLinearKey(bad, { fetch }), { status: 400 });
  await assert.rejects(saveLinearKey(world.key, { fetch: async () => { throw new Error('offline'); } }), { status: 502 });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(await saveLinearKey('lin_api_wrong', { fetch }), { set: true, refused: true });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(await saveLinearKey(` ${world.key} `, { fetch }), { set: true, workspace: 'Acme', url_key: 'acme' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual([readLinearKey().key, readLinearKey().viewer], [world.key, { id: 'user-me', name: 'Love' }]);
  assert.doesNotMatch(JSON.stringify(linearStatus()), /lin_api/);
  const key = world.key;
  world.key = 'lin_api_rotated';
  await assert.rejects(savedClient({ fetch }).teams(), { message: 'Linear refused the key.' });
  assert.deepEqual(linearStatus(), { set: true, refused: true, workspace: 'Acme', url_key: 'acme' });
  world.key = key;
  await savedClient({ fetch }).teams();
  assert.deepEqual(linearStatus(), { set: true, workspace: 'Acme', url_key: 'acme' });
  assert.deepEqual(removeLinearKey(), { set: false });
  assert.equal(fs.existsSync(file), false);
});

test("the hub saves the Linear key from its settings form, serves only the workspace, lists teams and projects, and creates a project", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-linear-'));
  const web = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'manifest.json'), JSON.stringify({ version: 1, sites: {} }));
  const world = linearWorld();
  const linear = fakeLinear(world);
  const server = await linear.serve();
  const [port] = await freePorts(1);
  const hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(port), KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false', KICKFLIP_LINEAR_URL: server.url } });
  t.after(async () => { hub.kill(); await server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    let out = '';
    hub.stdout.on('data', (d) => { out += d; if (out.includes('hub on')) resolve(); });
    hub.once('exit', reject);
  });
  const base = `http://127.0.0.1:${port}`;
  const form = (body) => fetch(`${base}/_hub/settings/linear`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.deepEqual(await (await fetch(`${base}/_hub/api/linear`)).json(), { set: false });
  assert.equal((await (await fetch(`${base}/_hub/api/settings`)).json()).linear.summary, 'No key');
  assert.equal((await form('key=two%20words')).status, 400);
  const refused = await form('key=wrong');
  assert.equal(refused.status, 200);
  assert.deepEqual((await refused.json()).linear, { set: true, refused: true, title: 'Linear key', down: 'doesn’t work',
    sub: 'Linear refused the key. Make a new one in Linear › Settings › Security & access › Personal API keys and paste it here.',
    keys: { url: 'https://linear.app/settings/account/security', label: 'Linear › Settings › Security & access › Personal API keys' }, summary: 'Key doesn’t work' });
  assert.deepEqual(await (await fetch(`${base}/_hub/api/linear`)).json(), { set: true, refused: true });
  const saved = await form(`key=${world.key}`);
  assert.equal(saved.status, 200);
  const text = await saved.text();
  assert.doesNotMatch(text, /lin_api/);
  assert.deepEqual(JSON.parse(text).linear, { set: true, title: 'Acme workspace', sub: 'Key ••••••••', summary: 'Key set · Acme workspace' });
  assert.equal(fs.statSync(path.join(web, 'linear.json')).mode & 0o777, 0o600);
  const listed = await (await fetch(`${base}/_hub/api/linear`)).text();
  assert.doesNotMatch(listed, /lin_api/);
  assert.deepEqual(JSON.parse(listed), { set: true, workspace: 'Acme', url_key: 'acme', teams: [{ key: 'ENG', name: 'Engineering' }, { key: 'OPS', name: 'Ops' }],
    projects: [{ id: 'proj-audit', name: 'Backend Audit', team: 'ENG' }] });
  const create = (body, type = 'application/json') => fetch(`${base}/_hub/linear/projects`, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });
  assert.equal((await create({ team: 'eng', name: 'x' })).status, 400);
  assert.equal((await create({ team: 'OPS', name: 'Hub' }, 'text/plain')).status, 403);
  assert.deepEqual(await (await create({ team: 'OPS', name: 'Hub board' })).json(), { id: 'proj-101', name: 'Hub board', team: 'OPS' });
  world.key = 'lin_api_revoked';
  assert.deepEqual(await (await fetch(`${base}/_hub/api/linear`)).json(), { set: true, refused: true, workspace: 'Acme', url_key: 'acme', error: 'Linear refused the key.' });
  assert.equal((await (await fetch(`${base}/_hub/api/settings`)).json()).linear.summary, 'Key doesn’t work · Acme workspace');
  const calls = linear.calls.length;
  assert.deepEqual(await (await fetch(`${base}/_hub/api/linear`)).json(), { set: true, refused: true, workspace: 'Acme', url_key: 'acme' });
  assert.equal(linear.calls.length, calls);
  assert.equal((await form('remove=1')).status, 200);
  assert.equal(fs.existsSync(path.join(web, 'linear.json')), false);
  assert.equal((await create({ team: 'OPS', name: 'Again' })).status, 400);
});

test('a board on Linear falls back to internal tickets when the hub starts with no Linear key, and when Hub settings removes the key', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-linear-fallback-'));
  const web = path.join(home, '.claude', 'kickflip');
  const site = path.join(web, 'sites', 'app');
  const linearTickets = { source: 'linear', workspace: 'acme', team: 'ENG', project: 'proj-audit' };
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  const config = path.join(site, 'board.json');
  const wave = path.join(site, 'data', 'wave.json');
  fs.writeFileSync(config, JSON.stringify({ title: 'App', items: 'data/wave.json', slug: 'app', tickets: linearTickets }));
  fs.writeFileSync(wave, JSON.stringify({ title: 'App', items: [{ id: 'ENG-9', title: 'Old', ticket: 'ENG-9' }] }));
  const cards = fs.readFileSync(wave, 'utf8');
  fs.writeFileSync(path.join(web, 'manifest.json'), JSON.stringify({ version: 1, sites: { app: { dir: site, cmd: ['/usr/bin/false', 'board/server.mjs'] } } }));
  const world = linearWorld();
  const linear = fakeLinear(world);
  const server = await linear.serve();
  const [port] = await freePorts(1);
  const hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(port), KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false', KICKFLIP_LINEAR_URL: server.url } });
  t.after(async () => { hub.kill(); await server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  let out = '';
  await new Promise((resolve, reject) => {
    hub.stdout.on('data', (d) => { out += d; if (out.includes('hub on')) resolve(); });
    hub.once('exit', reject);
  });
  const tickets = () => JSON.parse(fs.readFileSync(config, 'utf8')).tickets;
  assert.deepEqual(tickets(), { source: 'internal', prefix: 'INT' });
  assert.match(out, /linear: \/app fell back to internal tickets: Hub has no Linear key/);
  const form = (body) => fetch(`http://127.0.0.1:${port}/_hub/settings/linear`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.equal((await form(`key=${world.key}`)).status, 200);
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), tickets: linearTickets }));
  assert.equal((await form('remove=1')).status, 200);
  assert.deepEqual(tickets(), { source: 'internal', prefix: 'INT' });
  assert.equal(fs.readFileSync(wave, 'utf8'), cards);
});
