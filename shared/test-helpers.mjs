import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { before, after } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { lockWaits, withFileLock } from '../hub/locks.mjs';
import { chromePath, openTab, startChrome } from './chrome.mjs';
import { tempDir } from './temp-dir.mjs';

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

// docs/adr/2026-11-13-2210-the-board-server-starts-in-process-and-tests-await-settled.md
// The board server in this process, listening on a port the OS picks, closed after test t; options go to
// board/server.mjs startServer. base is its address. Import shared/scratch-home.mjs first, as the server reads HOME.
export async function startBoard(t, options) {
  const { startServer } = await import('../board/server.mjs');
  const board = await startServer(options);
  t.after(() => board.close());
  return { ...board, base: `http://127.0.0.1:${board.server.address().port}` };
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

// docs/adr/2026-11-13-0045-a-test-waiting-on-the-board-to-hear-a-write-writes-again-until-it-acts.md
// Waits as until does for a board server to act on a write its file watch hears. A busy Mac's watch can hold events
// back past the wait's budget or drop them, so every 2 s until predicate holds it writes nudge, a file under the
// server's watch that no board reads: each write is one more event that has the server read the board again.
export async function untilHeard(predicate, message, nudge, budget = 30000) {
  const started = Date.now();
  let writes = 0;
  await until(async () => {
    if (await predicate()) return true;
    if (Date.now() - started >= (writes + 1) * 2000) fs.writeFileSync(nudge, String(++writes));
    return false;
  }, message, budget).catch((e) => { e.message = `${e.message}, over ${writes} nudges`; throw e; });
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
// Stops a spawned child and resolves once it has exited, so a rmSync after it never races the child's last writes.
export function killAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
}

export const untilTestEnds = (pid = process.pid) => `setInterval(() => { try { process.kill(${pid}, 0); } catch { process.exit(0); } }, 1000)`;

// Records the test process as Claude Code session `session` under home, so a bin/wait-events.mjs it spawns there
// has a live owning session (hub/live.mjs sessionGone).
export function ownSession(home, session, pid = process.pid) {
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim();
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${pid}-${session}.json`), JSON.stringify({ pid, sessionId: session, cwd: home, procStart, kind: 'bg' }));
}

// A ps on a PATH of its own, for code a test runs in another process, that answers as /bin/ps does, and while
// stall(true) gives no answer at once (it kills itself), which live.mjs's ps() reads as it reads a ps that timed out on
// a heavily loaded Mac. Given standIn {lstart, ppid}, it answers live.mjs's start-time and parent queries itself,
// without ps: every running pid started at lstart (ps -o lstart= text) with parent ppid, so a test's own load can't
// push a real ps past that timeout. → {bin: the folder to put first on PATH, stall(on), stalls(): how many calls have
// given no answer so far}
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
  fs.writeFileSync(path.join(bin, 'ps'), ['#!/bin/sh', `[ -e '${flag}' ] && { echo >> '${stalled}'; kill -9 $$; }`, ...answers, 'exec /bin/ps "$@"', ''].join('\n'), { mode: 0o755 });
  return {
    bin,
    stall: (on) => (on ? fs.writeFileSync(flag, '') : fs.rmSync(flag, { force: true })),
    stalls: () => (fs.existsSync(stalled) ? fs.readFileSync(stalled, 'utf8').length : 0),
  };
}

// Resolves the next time a withFileLock in this process finds file's lock held and waits for it (hub/locks.mjs
// lockWaits). Call it before the step that makes the writer wait.
export const lockWaited = (file) => new Promise((resolve) => {
  const heard = (waited) => { if (waited === file) { lockWaits.off('wait', heard); resolve(); } };
  lockWaits.on('wait', heard);
});

// A ps for the ps option of hub/live.mjs and board/headless.mjs stopRuns, answering from rows, each {pid, ppid, pgid,
// args, start (ms)}, as /bin/ps answers with TZ=UTC: the rows -p names (every row for -A), one line each holding the
// -o fields asked for. rows is read at each call, so a test can add to it as it starts processes.
export function fakePs(rows) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const lstart = (ms) => {
    const d = new Date(ms);
    return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()}`;
  };
  const field = (row, name) => (name === 'lstart' ? lstart(row.start) : name === 'command' ? row.args : row[name]);
  return (argv) => {
    const fields = argv[argv.indexOf('-o') + 1].split(',').map((f) => f.replace(/=$/, ''));
    const pids = argv.includes('-A') ? null : argv[argv.indexOf('-p') + 1].split(',').map(Number);
    return rows.filter((r) => !pids || pids.includes(r.pid)).map((r) => `${fields.map((f) => field(r, f)).join(' ')}\n`).join('');
  };
}

// Slack's Web API for one user token: auth.test, conversations.open, chat.postMessage, chat.update, reactions.add,
// conversations.history and conversations.replies, recording each call. world.dms maps a user id to the DM channel
// conversations.open answers; posts land in world.messages as the token's user, with their attachments, and reactions
// in world.reactions; an update keeps a message's attachments unless it passes new ones, as Slack does.
// say({channel, user, text, thread_ts, attachments}) adds another person's message → its ts. world.unheard answers the two reads
// missing_scope, as a token without im:history does.
export const slackWorld = () => ({
  token: 'xoxp-test-token', team: 'Acme', team_id: 'T1', user: 'love', user_id: 'U0', url: 'https://acme.slack.com/',
  dms: { U1: 'D1', U2: 'D2', U3: 'D3' }, messages: [], reactions: [],
});
export function fakeSlack(world) {
  const calls = [];
  let next = 1000;
  const say = ({ channel, user, text, thread_ts, attachments }) => {
    const ts = `${1792800000 + ++next}.000100`;
    world.messages.push({ channel, user, text, ...(thread_ts ? { thread_ts } : {}), ts, ...(attachments ? { attachments } : {}) });
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
    if (method === 'chat.postMessage') return { ok: true, channel: body.channel, ts: say({ channel: body.channel, user: world.user_id, text: body.text, thread_ts: body.thread_ts, attachments: body.attachments }) };
    if (method === 'chat.update') {
      const message = world.messages.find((m) => m.channel === body.channel && m.ts === body.ts);
      if (world.updateError) return { ok: false, error: world.updateError };
      if (!message) return { ok: false, error: 'message_not_found' };
      message.text = body.text;
      if (body.attachments) message.attachments = body.attachments;
      return { ok: true, channel: body.channel, ts: body.ts };
    }
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

export const chromeInstalled = fs.existsSync(chromePath());

// docs/adr/2026-11-13-1030-render-and-layout-tests-share-one-chrome-per-file.md
// One headless Chrome for the calling test file, started before its tests and stopped after them; each page a test loads
// gets a tab of its own. → {probe(url, width), port}
export function sharedChrome() {
  let chrome;
  const result = { get port() { return chrome.port; } };
  before(async () => {
    if (!chromeInstalled) return;
    chrome = await startChrome(tempDir('shared-chrome-'), ['--allow-file-access-from-files']);
  });
  after(async () => { await chrome?.stop(); });
  // Loads url at `width`px and returns the JSON the page writes into <pre id="probe">, once it is there.
  result.probe = async (url, width) => {
    const tab = await openTab(chrome.port);
    try {
      await tab.cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await tab.cdp('Page.navigate', { url });
      let posted;
      await until(async () => {
        posted = (await tab.cdp('Runtime.evaluate', { expression: `document.getElementById('probe')?.textContent`, returnByValue: true })).result.value;
        return posted;
      }, 'the page reported its layout', 10000);
      return JSON.parse(posted);
    } finally { await tab.close(); }
  };
  return result;
}
