import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { withFileLock } from '../hub/locks.mjs';

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

// Resolves once the board server child prints its listening line. A line it logs before that, such as a startup
// migration's, comes while it still writes its files under lock, so a test that stopped it there would leave the lock
// behind. Rejects with its stderr if it exits first.
export function boardListening(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    let errors = '';
    const read = (chunk) => {
      out += chunk;
      if (/^site on /m.test(out)) { child.stdout.off('data', read); resolve(); }
    };
    child.stdout.on('data', read);
    child.stderr?.on('data', (chunk) => { errors += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
  });
}

// docs/adr/2026-11-12-1110-a-test-waits-on-state-and-fails-only-at-5x-its-budget.md
// Polls predicate every 20 ms until it holds. budget is how long the wait should take: past it the wait warns and goes
// on, since a loaded host is slow, not wrong, and only past 5× the budget does it fail with message.
export async function until(predicate, message, budget = 30000) {
  const started = Date.now();
  while (!await predicate()) {
    assert.ok(Date.now() - started < 5 * budget, message);
    await setTimeout(20);
  }
  const took = Date.now() - started;
  if (took > budget) console.warn(`${message}: took ${took} ms, past its ${budget} ms budget`);
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

// A stand-in process's keep-alive, as script text: an interval that exits the stand-in once the test process that wrote
// it (pid) is gone, so a test file that is killed or times out leaves no stand-in running. It replaces
// setInterval(() => {}, 1000); a stand-in that ends on its own sooner adds it with .unref().
export const untilTestEnds = (pid = process.pid) => `setInterval(() => { try { process.kill(${pid}, 0); } catch { process.exit(0); } }, 1000)`;

// Records the test process as Claude Code session `session` under home, so a bin/wait-events.mjs it spawns there
// has a live owning session (hub/live.mjs sessionGone).
export function ownSession(home, session, pid = process.pid) {
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim();
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${pid}-${session}.json`), JSON.stringify({ pid, sessionId: session, cwd: home, procStart, kind: 'bg' }));
}

// A ps on a PATH of its own that answers as /bin/ps does, and while stall(true) hangs for 10 s, past live.mjs's ps
// timeout, as ps does on a heavily loaded Mac; a test sets KICKFLIP_PS_TIMEOUT_MS short to wait out that timeout fast.
// Given standIn {lstart, ppid}, it answers live.mjs's start-time and parent queries itself, without ps: every running
// pid started at lstart (ps -o lstart= text) with parent ppid, so a test's own load can't push a real ps past that
// timeout. → {bin: the folder to put first on PATH, stall(on), stalls(): how many
// calls have hung so far}
export function stallingPs(dir, standIn = null) {
  const bin = path.join(dir, 'stalling-ps');
  const flag = path.join(dir, 'ps-stalls');
  fs.mkdirSync(bin, { recursive: true });
  const answers = standIn ? [
    'if [ "$1" = -o ] && [ "$3" = -p ]; then',
    '  case "$2" in',
    `    lstart=) kill -0 "$4" 2>/dev/null || exit 1; echo '${standIn.lstart}'; exit 0 ;;`,
    `    ppid=) kill -0 "$4" 2>/dev/null || exit 1; echo ${standIn.ppid}; exit 0 ;;`,
    `    pid=,lstart=) IFS=,; for p in $4; do kill -0 "$p" 2>/dev/null && echo "$p ${standIn.lstart}"; done; exit 0 ;;`,
    '  esac',
    'fi',
  ] : [];
  const stalled = path.join(dir, 'ps-stalled');
  fs.writeFileSync(path.join(bin, 'ps'), ['#!/bin/sh', `[ -e '${flag}' ] && { echo >> '${stalled}'; exec sleep 10; }`, ...answers, 'exec /bin/ps "$@"', ''].join('\n'), { mode: 0o755 });
  return {
    bin,
    stall: (on) => (on ? fs.writeFileSync(flag, '') : fs.rmSync(flag, { force: true })),
    stalls: () => (fs.existsSync(stalled) ? fs.readFileSync(stalled, 'utf8').length : 0),
  };
}

// Slack's Web API for one user token: auth.test, conversations.open, chat.postMessage, reactions.add,
// conversations.history and conversations.replies, recording each call. world.dms maps a user id to the DM channel
// conversations.open answers; posts land in world.messages as the token's user, and reactions in world.reactions.
// say({channel, user, text, thread_ts}) adds another person's message → its ts. world.unheard answers the two reads
// missing_scope, as a token without im:history does.
export const slackWorld = () => ({
  token: 'xoxp-test-token', team: 'Acme', team_id: 'T1', user: 'love', user_id: 'U0', url: 'https://acme.slack.com/',
  dms: { U1: 'D1', U2: 'D2', U3: 'D3' }, messages: [], reactions: [],
});
export function fakeSlack(world) {
  const calls = [];
  let next = 1000;
  const say = ({ channel, user, text, thread_ts }) => {
    const ts = `${1792800000 + ++next}.000100`;
    world.messages.push({ channel, user, text, ...(thread_ts ? { thread_ts } : {}), ts });
    return ts;
  };
  const top = (m) => !m.thread_ts || m.thread_ts === m.ts;
  const repliesTo = (channel, ts) => world.messages.filter((m) => m.channel === channel && m.thread_ts === ts && m.ts !== ts);
  function answer(method, body, auth) {
    calls.push({ method, body });
    if (auth !== `Bearer ${world.token}`) return { ok: false, error: 'invalid_auth' };
    if (method === 'auth.test') return { ok: true, team: world.team, team_id: world.team_id, user: world.user, user_id: world.user_id, url: world.url };
    if (method === 'users.list') {
      if (world.missingScope) return { ok: false, error: 'missing_scope' };
      return { ok: true, members: world.people || [], response_metadata: { next_cursor: '' } };
    }
    if (method === 'emoji.list') {
      if (world.emojiMissingScope) return { ok: false, error: 'missing_scope' };
      return { ok: true, emoji: world.noEmoji ? {} : { claude_kickflip: 'https://emoji.example/kickflip.png' } };
    }
    if (method === 'conversations.open') {
      const channel = world.dms[body.users];
      return channel ? { ok: true, channel: { id: channel } } : { ok: false, error: 'user_not_found' };
    }
    if (method === 'chat.postMessage') return { ok: true, channel: body.channel, ts: say({ channel: body.channel, user: world.user_id, text: body.text, thread_ts: body.thread_ts }) };
    if ((method === 'conversations.history' || method === 'conversations.replies') && world.unheard) return { ok: false, error: 'missing_scope' };
    if (method === 'conversations.history') {
      const messages = world.messages.filter((m) => m.channel === body.channel && top(m) && Number(m.ts) >= Number(body.oldest || 0)).reverse().map((m) => {
        const replies = repliesTo(m.channel, m.ts);
        return { ...m, ...(replies.length ? { reply_count: replies.length, latest_reply: replies.at(-1).ts } : {}) };
      });
      return { ok: true, messages, has_more: false };
    }
    if (method === 'conversations.replies') {
      const parent = world.messages.find((m) => m.channel === body.channel && m.ts === body.ts);
      if (!parent) return { ok: false, error: 'thread_not_found' };
      return { ok: true, messages: [parent, ...repliesTo(body.channel, body.ts).filter((m) => Number(m.ts) > Number(body.oldest || 0))], has_more: false };
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
    say,
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

// Replaces an item file's text under the file's lock, by a rename, as the server writes it, so a write the server makes
// from an earlier read of the file can't land half over this one (docs/adr/2026-11-09-2230-a-settle-move-checks-its-snapshot-under-the-item-files-lock.md).
export async function putWave(file, text) {
  await withFileLock(file, () => {
    fs.writeFileSync(`${file}.test.tmp`, text);
    fs.renameSync(`${file}.test.tmp`, file);
  });
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const chromeInstalled = fs.existsSync(CHROME);

// Loads a page file at `width`px in headless Chrome and returns the JSON its inline script wrote into <pre id="probe"> as it
// parsed (no timer, so every dump holds it). Chrome under load can crash before it dumps, or exit non-zero after it has: its
// output is read on any exit, and a run that returned no probe is run once more. Assertions on the probe are never retried.
export async function dumpProbe(file, width) {
  let posted;
  for (let attempt = 0; attempt < 2 && !posted; attempt++) {
    const { stdout } = await promisify(execFile)(CHROME, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files', `--window-size=${width},900`,
      '--dump-dom', `file://${file}`], { encoding: 'utf8', timeout: 60000 }).catch((e) => ({ stdout: e.stdout || '' }));
    posted = /<pre id="probe">(.*?)<\/pre>/s.exec(stdout)?.[1];
  }
  assert.ok(posted, 'the page reported its layout');
  return JSON.parse(posted.replace(/&quot;/g, '"'));
}
