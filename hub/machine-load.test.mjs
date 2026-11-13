// docs/adr/2026-11-13-0026-the-busy-hub-row-opens-whats-loading-the-host.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etimeSeconds, parsePs, loadGroups, shortCommand, stopOrphan, machineLoad } from './machine-load.mjs';

const UID = 501;
const DAY = 86400;
// ps -axo pid=,ppid=,uid=,etime=,pcpu=,command=
const PS = `
    1     0     0 10-00:00:00   0.0 /sbin/launchd
  100     1   501 2-00:00:00   6.3 /opt/homebrew/bin/node /Users/me/.claude/skills/kickflip/hub/hub.mjs
  110   100   501 1-23:00:00   1.0 node /Users/me/.claude/kickflip/sites/hub/board/server.mjs --port 4410
  120   110   501    48:00   2.0 claude -p You are the headless builder for card T-171
  121   120   501    12:00   1.5 /bin/zsh -c node --test hub/hub.test.mjs
  122   121   501    12:00  60.0 node --test hub/hub.test.mjs
  123   122   501    11:00  36.0 node /tmp/x/hub/hub.test.mjs
  130   110   501    31:00  14.0 claude -p You are the prototype planner for T-186
  200     1   501 09:00:00   3.0 claude
  210   200   501    04:00  41.0 node --test board/domain.test.mjs
 4127     1   501 5-02:00:00 200.0 node --test board/server.test.mjs
 4128  4127   501 5-02:00:00  12.0 node /tmp/y/board/server.test.mjs
 5530     1   501 3-01:00:00  38.0 node board/server.mjs --port 4431
 5600     1   501    05:00  80.0 node board/server.mjs --port 4433
 5700     1     0 4-00:00:00  50.0 node /usr/local/lib/root-service.mjs
 5800     1   501 6-00:00:00  20.0 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new about:blank
  300     1   501 2-00:00:00  18.0 /System/Library/Frameworks/CoreServices.framework/mds_stores
  301     1   501 2-00:00:00   4.0 /usr/sbin/cfprefsd agent
`;

const context = {
  uid: UID,
  keep: new Set([100]),
  builders: new Map([[120, { label: 'T-171 build', board: 'Hub Orchestrator' }], [130, { label: 'T-186 prototype', board: 'Hub Orchestrator' }]]),
  sessions: new Map([[200, { label: 'Hub Orchestrator', owner: 'orchestrator' }]]),
};

test('ps elapsed times read as seconds', () => {
  assert.deepEqual(['00:07', '48:00', '09:00:00', '5-02:00:00'].map(etimeSeconds), [7, 2880, 32400, 5 * DAY + 7200]);
});

test('ps rows parse with their command whole', () => {
  const procs = parsePs(PS);
  assert.deepEqual(procs.find((p) => p.pid === 4127), { pid: 4127, ppid: 1, uid: 501, age: 5 * DAY + 7200, cpu: 200, command: 'node --test board/server.test.mjs' });
  assert.equal(procs.find((p) => p.pid === 5800).command, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new about:blank');
});

test('a command shortens to its program name, the home folder as ~, and 80 characters', () => {
  assert.equal(shortCommand('/opt/homebrew/bin/node /Users/me/x.mjs --port 1', '/Users/me'), 'node ~/x.mjs --port 1');
  assert.equal(shortCommand('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless', '/Users/me'), 'Google Chrome --headless');
  assert.equal(shortCommand(`node ${'a'.repeat(100)}`, '/Users/me').length, 80);
  assert.match(shortCommand(`node ${'a'.repeat(100)}`, '/Users/me'), /…$/);
  assert.equal(shortCommand('claude -p line one\\012line two', '/Users/me'), 'claude -p line one line two');
});

test('processes sort into orphans, test suites, Claude sessions, builders and planners, and other, each row taking its children’s CPU', () => {
  const groups = loadGroups(parsePs(PS), { ...context, home: '/Users/me' });
  const rows = Object.fromEntries(groups.map((g) => [g.key, g.rows.map((r) => [r.pid, r.cmd, r.cpu, r.owner])]));
  assert.deepEqual(groups.map((g) => [g.key, g.title]), [
    ['orphan', 'Looks orphaned, older than a day'], ['suite', 'Test suites'], ['session', 'Claude sessions'], ['builder', 'Builders and planners'], ['other', 'Other'],
  ]);
  // Older than a day, left to launchd, a node process of this user's that isn't the hub: a stray suite and a stray
  // server; the suite's own child is its CPU, not a suite of its own. A young server, root's and Chrome are not orphans.
  assert.deepEqual(rows.orphan, [[4127, 'node --test board/server.test.mjs', 212, 'no board or session'], [5530, 'node board/server.mjs --port 4431', 38, 'no board or session']]);
  // A suite under a builder or a session names it; its child test files are its CPU; the shell that ran it is the builder's.
  assert.deepEqual(rows.suite, [[122, 'node --test hub/hub.test.mjs', 96, 'T-171 build'], [210, 'node --test board/domain.test.mjs', 41, 'Hub Orchestrator']]);
  assert.deepEqual(rows.session, [[200, 'Hub Orchestrator', 3, 'orchestrator']]);
  assert.deepEqual(rows.builder, [[130, 'T-186 prototype', 14, 'Hub Orchestrator'], [120, 'T-171 build', 3.5, 'Hub Orchestrator']]);
  // Other: what no group holds at 10% CPU or more, the busiest first, five at most.
  assert.deepEqual(rows.other.map(([pid, , cpu]) => [pid, cpu]), [[5600, 80], [5700, 50], [5800, 20], [300, 18]]);
  assert.equal(rows.other[3][1], 'mds_stores');
  assert.equal(groups.find((g) => g.key === 'orphan').rows[0].age, 5 * DAY + 7200);
});

test('a group with no rows is left out, and a calm Mac may have none', () => {
  const calm = parsePs(`
    1     0     0 10-00:00:00   0.0 /sbin/launchd
  200     1   501 09:00:00   3.0 claude
`);
  assert.deepEqual(loadGroups(calm, { ...context, home: '/Users/me' }).map((g) => g.key), ['session']);
  assert.deepEqual(loadGroups([], { ...context, home: '/Users/me' }), []);
});

test('Stop ends an orphan and its children, and refuses any process that no longer looks orphaned', async () => {
  const signals = [];
  const audits = [];
  const deps = { ...context, home: '/Users/me', ps: () => PS, kill: (pid, sig) => signals.push([pid, sig]), audit: (entry) => audits.push(entry) };
  assert.deepEqual(await stopOrphan(4127, deps), { stopped: [4127, 4128] });
  assert.deepEqual(signals, [[4127, 'SIGTERM'], [4128, 'SIGTERM']]);
  assert.equal(audits[0].call, 'machine-stop');
  assert.match(audits[0].reason, /node --test board\/server\.test\.mjs/);
  for (const pid of [5600, 122, 100, 999]) {
    await assert.rejects(stopOrphan(pid, deps), (e) => e.status === 409 && /no longer looks orphaned/.test(e.message));
  }
  assert.equal(signals.length, 2, 'nothing else was signalled');
  await assert.rejects(stopOrphan(4127, { ...deps, ps: () => null }), (e) => e.status === 503 && /ps gave no answer/.test(e.message));
});

test('the sheet’s data carries the load now and over the hour, the cores, and the groups, or null groups when ps gave no answer', async () => {
  const samples = [{ at: '2026-11-12T01:00:00Z', load: 40 }, { at: '2026-11-12T01:01:00Z', load: 50 }];
  const base = { ...context, home: '/Users/me', ps: () => PS, samples: () => samples, reading: () => ({ load: 58.04, cores: 10 }) };
  const data = await machineLoad(base);
  assert.equal(data.load, 58.04);
  assert.equal(data.cores, 10);
  assert.equal(data.average, 45);
  assert.deepEqual(data.samples, samples);
  assert.equal(data.groups[0].key, 'orphan');
  assert.equal((await machineLoad({ ...base, ps: () => null })).groups, null);
  assert.equal((await machineLoad({ ...base, samples: () => [] })).average, null);
});
