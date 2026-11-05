import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

export async function freePorts(count = 1) {
  const servers = [];
  try {
    const ports = [];
    for (let i = 0; i < count; i++) {
      const server = net.createServer();
      servers.push(server);
      await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
      ports.push(server.address().port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

export async function until(predicate, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await setTimeout(20);
  }
}

// docs/adr/2026-11-04-0349-the-board-is-built-once-per-data-version.md: a board server sees a write made outside it once
// its file watcher reports it. Runs write, then waits until the board served at base is no longer the one before it.
export async function boardSees(base, write) {
  const version = async () => (await (await fetch(`${base}/api/board`)).json()).version;
  const before = await version();
  await write();
  await until(async () => (await version()) !== before, 'the board server sees the write');
}

// A stand-in for Linear's GraphQL API over world {key, viewer, org, teams: [{id, key, name, states, projects}], issues:
// {<identifier>: {team, assignee, state}}}, answering by the operation each query names. fetch replaces the global
// one; serve() puts the same API on a loopback port for a hub's KICKFLIP_LINEAR_URL.
export function fakeLinear(world) {
  const calls = [];
  let next = 100;
  const teamOf = (match) => world.teams.find(match);
  const stateOf = (team, id) => team.states.find((s) => s.id === id);
  function answer({ query, variables = {} }, auth) {
    calls.push({ query, variables });
    if (auth !== world.key) return [401, { errors: [{ message: 'Authentication required', extensions: { type: 'authentication error' } }] }];
    const ok = (data) => [200, { data }];
    if (query.includes('viewer')) return ok({ viewer: world.viewer, organization: world.org });
    if (query.includes('projectCreate')) {
      const team = teamOf((t) => t.id === variables.input.teamIds[0]);
      const project = { id: `proj-${++next}`, name: variables.input.name };
      team.projects.push(project);
      return ok({ projectCreate: { success: true, project } });
    }
    if (query.includes('issueCreate')) {
      const team = teamOf((t) => t.id === variables.input.teamId);
      const identifier = `${team.key}-${++next}`;
      world.issues[identifier] = { team: team.key, assignee: null, state: team.states[0].id, input: variables.input };
      return ok({ issueCreate: { success: true, issue: { identifier, url: `https://linear.app/${world.org.urlKey}/issue/${identifier}` } } });
    }
    if (query.includes('issueUpdate')) {
      world.issues[variables.id].state = variables.stateId;
      return ok({ issueUpdate: { success: true } });
    }
    if (query.includes('issue(id')) {
      const issue = world.issues[variables.id];
      if (!issue) return [200, { errors: [{ message: 'Entity not found: Issue', extensions: { type: 'not found' } }] }];
      const team = teamOf((t) => t.key === issue.team);
      const { id, name, type } = stateOf(team, issue.state);
      return ok({ issue: { identifier: variables.id, team: { key: team.key }, assignee: issue.assignee ? { id: issue.assignee } : null, state: { id, name, type } } });
    }
    const shape = (t) => ({ id: t.id, key: t.key, name: t.name, states: { nodes: t.states }, projects: { nodes: t.projects } });
    if (query.includes('teams(filter')) return ok({ teams: { nodes: world.teams.filter((t) => t.key === variables.key).map(shape) } });
    if (query.includes('teams(first') && query.includes('projects(first')) return [400, { errors: [{ message: 'Query too complex' }] }];
    if (query.includes('teams(first')) return ok({ teams: { nodes: world.teams.map(shape) } });
    if (query.includes('team(id')) return ok({ team: shape(teamOf((t) => t.id === variables.id)) });
    return [400, { errors: [{ message: `unknown query ${query}` }] }];
  }
  return {
    calls,
    async fetch(url, init) {
      const [status, body] = answer(JSON.parse(init.body), init.headers.authorization);
      return { ok: status === 200, status, json: async () => body };
    },
    async serve() {
      const http = await import('node:http');
      const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const [status, out] = answer(JSON.parse(body), req.headers.authorization);
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return { url: `http://127.0.0.1:${server.address().port}/graphql`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
    },
  };
}

export const linearWorld = () => ({
  key: 'lin_api_test_key',
  viewer: { id: 'user-me', name: 'Love' },
  org: { name: 'Acme', urlKey: 'acme' },
  teams: [
    { id: 'team-eng', key: 'ENG', name: 'Engineering', projects: [{ id: 'proj-audit', name: 'Backend Audit' }], states: [
      { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 }, { id: 's-prog', name: 'In Progress', type: 'started', position: 2 },
      { id: 's-rev', name: 'In Review', type: 'started', position: 3 }, { id: 's-done', name: 'Done', type: 'completed', position: 4 },
      { id: 's-cancel', name: 'Canceled', type: 'canceled', position: 5 }] },
    { id: 'team-ops', key: 'OPS', name: 'Ops', projects: [], states: [
      { id: 'o-todo', name: 'Todo', type: 'unstarted', position: 1 }, { id: 'o-doing', name: 'Doing', type: 'started', position: 2 },
      { id: 'o-shipped', name: 'Shipped', type: 'completed', position: 3 }] },
  ],
  issues: {},
});

// Records the test process as Claude Code session `session` under home, so a bin/wait-events.mjs it spawns there
// has a live owning session (hub/live.mjs sessionGone).
export function ownSession(home, session, pid = process.pid) {
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim();
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${pid}-${session}.json`), JSON.stringify({ pid, sessionId: session, cwd: home, procStart, kind: 'bg' }));
}

// A ps on a PATH of its own that answers as /bin/ps does, and while stall(true) hangs past live.mjs's 3 s timeout, as
// ps does on a heavily loaded Mac. → {bin: the folder to put first on PATH, stall(on)}
export function stallingPs(dir) {
  const bin = path.join(dir, 'stalling-ps');
  const flag = path.join(dir, 'ps-stalls');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\n[ -e '${flag}' ] && exec sleep 10\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  return { bin, stall: (on) => (on ? fs.writeFileSync(flag, '') : fs.rmSync(flag, { force: true })) };
}

// Slack's Web API for one user token: auth.test, conversations.open, chat.postMessage and reactions.add, recording
// each call. world.dms maps a user id to the DM channel conversations.open answers; posts land in world.messages and
// reactions in world.reactions.
export const slackWorld = () => ({
  token: 'xoxp-test-token', team: 'Acme', team_id: 'T1', user: 'love', user_id: 'U0', url: 'https://acme.slack.com/',
  dms: { U1: 'D1', U2: 'D2', U3: 'D3' }, messages: [], reactions: [],
});
export function fakeSlack(world) {
  const calls = [];
  let next = 1000;
  function answer(method, body, auth) {
    calls.push({ method, body });
    if (auth !== `Bearer ${world.token}`) return { ok: false, error: 'invalid_auth' };
    if (method === 'auth.test') return { ok: true, team: world.team, team_id: world.team_id, user: world.user, user_id: world.user_id, url: world.url };
    if (method === 'conversations.open') {
      const channel = world.dms[body.users];
      return channel ? { ok: true, channel: { id: channel } } : { ok: false, error: 'user_not_found' };
    }
    if (method === 'chat.postMessage') {
      const ts = `${1792800000 + ++next}.000100`;
      world.messages.push({ channel: body.channel, text: body.text, ...(body.thread_ts ? { thread_ts: body.thread_ts } : {}), ts });
      return { ok: true, channel: body.channel, ts };
    }
    if (method === 'reactions.add') {
      if (world.reactions.some((r) => r.channel === body.channel && r.timestamp === body.timestamp && r.name === body.name)) return { ok: false, error: 'already_reacted' };
      world.reactions.push({ channel: body.channel, timestamp: body.timestamp, name: body.name });
      return { ok: true };
    }
    return { ok: false, error: 'unknown_method' };
  }
  return {
    calls,
    async fetch(url, init) {
      return { ok: true, status: 200, json: async () => answer(String(url).split('/').at(-1), JSON.parse(init.body || '{}'), init.headers.authorization) };
    },
    async serve() {
      const http = await import('node:http');
      const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const out = answer(req.url.split('/').at(-1), JSON.parse(body || '{}'), req.headers.authorization);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return { url: `http://127.0.0.1:${server.address().port}/api`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
    },
  };
}
