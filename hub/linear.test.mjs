import { web, write, inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeLinear, linearWorld } from '../shared/test-helpers.mjs';
import { linearClient, linearStatus, readLinearKey, removeLinearKey, saveLinearKey, savedClient, stateFor, stageOf } from './linear.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

function withHome(t) {
  const home = tempDir('linear-');
  const old = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; });
  return path.join(home, '.claude', 'kickflip', 'secrets.json');
}
const linearIn = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).linear; } catch { return undefined; } };

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
  const move = async (id, target) => client.moveIssue(await client.issue(id), target);
  assert.equal(await move('ENG-1', 'started'), 'In Progress');
  assert.equal(await move('ENG-1', 'started'), null);
  assert.equal(await move('ENG-1', 'review'), 'In Review');
  assert.equal(await move('ENG-1', 'done'), 'Done');
  assert.equal(await move('ENG-1', 'started'), null);
  assert.equal(world.issues['ENG-1'].state, 's-done');
  assert.equal(await move('OPS-2', 'review'), null);
  assert.equal(world.issues['OPS-2'].state, 'o-todo');
  assert.equal(await client.issue('ENG-404'), null);
});

test('the stage order treats review as later than started and completed or canceled as done', () => {
  const states = [
    { type: 'backlog', name: 'Backlog' }, { type: 'triage', name: 'Triage' }, { type: 'unstarted', name: 'Todo' },
    { type: 'started', name: 'Working' }, { type: 'started', name: 'Code REVIEW' },
    { type: 'completed', name: 'Shipped' }, { type: 'canceled', name: 'Canceled' },
  ];
  assert.deepEqual(states.map(stageOf), [0, 0, 0, 1, 2, 3, 3]);
});

test('moveIssue skips an issue already there or past the target without a call, and a team with no such state before mutating', async () => {
  const world = linearWorld();
  const linear = fakeLinear(world);
  const client = linearClient(world.key, { fetch: linear.fetch });
  world.issues['ENG-2'] = { team: 'ENG', assignee: 'user-me', state: 's-rev' };
  world.issues['ENG-3'] = { team: 'ENG', assignee: 'user-me', state: 's-cancel' };
  for (const id of ['ENG-2', 'ENG-3']) {
    const issue = await client.issue(id);
    linear.calls.length = 0;
    assert.equal(await client.moveIssue(issue, 'started'), null);
    assert.equal(linear.calls.length, 0);
  }
  world.issues['OPS-1'] = { team: 'OPS', assignee: 'user-me', state: 'o-todo' };
  const issue = await client.issue('OPS-1');
  linear.calls.length = 0;
  assert.equal(await client.moveIssue(issue, 'review'), null);
  assert.equal(linear.calls.length, 1);
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
  assert.equal(linearIn(file), undefined);
});

test('a linear.json from before secrets.json moves in on the first read, keeping any Slack token beside it', (t) => {
  const file = withHome(t);
  const legacy = path.join(path.dirname(file), 'linear.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ slack: { token: 'xoxp-kept' } }));
  fs.writeFileSync(legacy, JSON.stringify({ key: 'lin_api_old', workspace: 'Acme', url_key: 'acme' }));
  assert.deepEqual(linearStatus(), { set: true, workspace: 'Acme', url_key: 'acme' });
  assert.equal(fs.existsSync(legacy), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { slack: { token: 'xoxp-kept' }, linear: { key: 'lin_api_old', workspace: 'Acme', url_key: 'acme' } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("the hub saves the Linear key from its settings form, serves only the workspace, lists teams and projects, and creates a project", async (t) => {
  fs.rmSync(web, { recursive: true, force: true });
  write(path.join(web, 'manifest.json'), { version: 1, sites: {} });
  const world = linearWorld();
  const linear = fakeLinear(world);
  const server = await linear.serve();
  t.after(() => server.close());
  process.env.KICKFLIP_LINEAR_URL = server.url;
  const { base } = await inProcessHub(t);
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
  assert.equal(fs.statSync(path.join(web, 'secrets.json')).mode & 0o777, 0o600);
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(web, 'secrets.json'), 'utf8')).linear, undefined);
  assert.equal((await create({ team: 'OPS', name: 'Again' })).status, 400);
});

test('a board on Linear falls back to no ticket source when the hub starts with no Linear key, and when Hub settings removes the key', async (t) => {
  fs.rmSync(web, { recursive: true, force: true });
  const site = path.join(web, 'sites', 'app');
  const linearTickets = { source: 'linear', workspace: 'acme', team: 'ENG', project: 'proj-audit' };
  const config = path.join(site, 'board.json');
  const wave = path.join(site, 'data', 'items.json');
  write(config, { title: 'App', items: 'data/items.json', slug: 'app', tickets: linearTickets });
  write(wave, { title: 'App', items: [{ id: 'ENG-9', title: 'Old', ticket: 'ENG-9' }] });
  const cards = fs.readFileSync(wave, 'utf8');
  write(path.join(web, 'manifest.json'), { version: 1, sites: { app: { dir: site, cmd: ['/usr/bin/false', 'board/server.mjs'] } } });
  const world = linearWorld();
  const linear = fakeLinear(world);
  const server = await linear.serve();
  t.after(() => server.close());
  process.env.KICKFLIP_LINEAR_URL = server.url;
  const hub = await inProcessHub(t);
  const tickets = () => JSON.parse(fs.readFileSync(config, 'utf8')).tickets;
  assert.equal(tickets(), undefined);
  assert.ok(hub.lines.includes('linear: /app fell back to no ticket source: Hub has no Linear key'), hub.lines.join('\n'));
  const form = (body) => fetch(`${hub.base}/_hub/settings/linear`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.equal((await form(`key=${world.key}`)).status, 200);
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), tickets: linearTickets }));
  assert.equal((await form('remove=1')).status, 200);
  assert.equal(tickets(), undefined);
  assert.equal(fs.readFileSync(wave, 'utf8'), cards);
});

test('teams come A–Z by key and each team lists only its open projects A–Z by name, numbers by value', async () => {
  const world = linearWorld();
  world.teams.reverse();
  world.teams.find((t) => t.key === 'ENG').projects = [
    { id: 'a', name: 'zeta', status: { type: 'started' } }, { id: 'b', name: 'Alpha 10', status: { type: 'planned' } },
    { id: 'c', name: 'Alpha 2' }, { id: 'd', name: 'Beta', status: { type: 'completed' } }, { id: 'e', name: 'Gamma', status: { type: 'canceled' } },
    { id: 'f', name: 'beta two', status: { type: 'paused' } },
  ];
  const teams = await linearClient(world.key, { fetch: fakeLinear(world).fetch }).teams();
  assert.deepEqual(teams.map((t) => t.key), ['ENG', 'OPS']);
  assert.deepEqual(teams[0].projects.map((p) => p.name), ['Alpha 2', 'Alpha 10', 'beta two', 'zeta']);
});
