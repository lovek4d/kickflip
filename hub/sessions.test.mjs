import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installLinks, installClaudeSettings, nodeBin } from '../bin/install.mjs';
import { hubService } from '../shared/service.mjs';
import { REVIEW_SKILLS } from '../shared/skills.mjs';
import { fakePs, stallingPs, untilTestEnds } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(tempDir('sessions-'));
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude-config');
// ps is the stand-in for the whole file, here and in every CLI it runs: each live record's process started at START.
const START = 'Thu Nov  5 00:00:00 2026';
const ps = stallingPs(home, { lstart: START, ppid: process.pid });
process.env.PATH = `${ps.bin}:${process.env.PATH}`;
const { checkSessions, RESUME_AFTER, COMEBACK_WAIT, BG_SETTINGS } = await import('./sessions.mjs');
const { WAIT_MS } = await import('./prompts.mjs');

const web = (...p) => path.join(home, '.claude', 'kickflip', ...p);
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = () => read(web('manifest.json'));
const boardCmd = (dir) => [process.execPath, path.join(SKILL, 'board', 'server.mjs'), dir];
const repo = path.join(home, 'repo');
const otherRepo = path.join(home, 'other');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(otherRepo, { recursive: true });

const fakeLog = path.join(home, 'claude-calls.jsonl');
const fakeClaude = path.join(home, 'bin', 'claude');
const agentsFile = path.join(home, 'agents.json');
const copyNext = path.join(home, 'copy-next');
const foregroundExit = path.join(home, 'foreground-exit');
process.env.KICKFLIP_CLAUDE = fakeClaude;
write(fakeClaude, `#!${process.execPath}
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
if (argv[0] === 'agents') { let list = []; try { list = JSON.parse(fs.readFileSync(${JSON.stringify(agentsFile)}, 'utf8')); } catch {} console.log(JSON.stringify(list)); process.exit(0); }
if (!argv.includes('--bg')) {
  fs.appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify({ argv, cwd: process.cwd(), isolation: process.env.CLAUDE_BG_ISOLATION ?? null, claudecode: process.env.CLAUDECODE ?? null }) + '\\n');
  console.log('foreground stdin: ' + fs.readFileSync(0, 'utf8'));
  console.error('foreground stderr');
  process.exit(fs.existsSync(${JSON.stringify(foregroundExit)}) ? Number(fs.readFileSync(${JSON.stringify(foregroundExit)}, 'utf8')) : 0);
}
const resumed = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : null;
const copy = fs.existsSync(${JSON.stringify(copyNext)});
if (copy) fs.unlinkSync(${JSON.stringify(copyNext)});
const id = resumed && !copy ? resumed : require('node:crypto').randomUUID();
if (id !== resumed) fs.writeFileSync(${JSON.stringify(path.join(home, '.claude', 'sessions'))} + '/fake-' + id + '.json', JSON.stringify({ pid: spawnSync('true').pid, sessionId: id, jobId: id.slice(0, 8), kind: 'bg' }));
fs.appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify({ argv, id, cwd: process.cwd(), isolation: process.env.CLAUDE_BG_ISOLATION, claudecode: process.env.CLAUDECODE ?? null }) + '\\n');
const lingering = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit', detached: true });
fs.appendFileSync(${JSON.stringify(fakeLog)} + '.pids', lingering.pid + '\\n');
lingering.unref();
if (resumed && id !== resumed) console.log('note: background session ' + resumed.slice(0, 8) + ' keeps its own saved options, so the flags you passed started a copy as ' + id.slice(0, 8) + '.');
console.log('backgrounded · ' + id.slice(0, 8) + ' · board');
console.log('  claude attach ' + id.slice(0, 8) + '    open in this terminal');
`);
fs.chmodSync(fakeClaude, 0o755);
// A stand-in tmux: logs each call; has-session finds a session while tmuxRunning exists, which new-session makes;
// attach-session prints its target and exits with attachExit's code.
const tmuxLog = path.join(home, 'tmux-calls.jsonl');
const tmuxRunning = path.join(home, 'tmux-running');
const attachExit = path.join(home, 'attach-exit');
const fakeTmux = path.join(home, 'bin', 'tmux');
process.env.KICKFLIP_TMUX = fakeTmux;
write(fakeTmux, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(tmuxLog)}, JSON.stringify({ argv, claudecode: process.env.CLAUDECODE ?? null }) + '\\n');
if (argv[0] === 'has-session') process.exit(fs.existsSync(${JSON.stringify(tmuxRunning)}) ? 0 : 1);
if (argv[0] === 'new-session') fs.writeFileSync(${JSON.stringify(tmuxRunning)}, '');
if (argv[0] === 'attach-session' || argv[0] === 'switch-client') {
  console.log((argv[0] === 'switch-client' ? 'switched ' : 'attached ') + argv[2]);
  process.exit(fs.existsSync(${JSON.stringify(attachExit)}) ? Number(fs.readFileSync(${JSON.stringify(attachExit)}, 'utf8')) : 0);
}
`);
fs.chmodSync(fakeTmux, 0o755);
const tmuxCalls = () => { try { return fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).argv); } catch { return []; } };
const noTmux = () => fs.rmSync(tmuxRunning, { force: true });
fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
const calls = () => { try { return fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

const sleepers = [];
const liveRecord = (sessionId, cwd) => {
  const c = spawn(process.execPath, ['-e', untilTestEnds()], { stdio: 'ignore' });
  sleepers.push(c);
  write(path.join(home, '.claude', 'sessions', `${c.pid}.json`), { pid: c.pid, sessionId, cwd, procStart: START, kind: 'interactive' });
  return c;
};

const cli = (args, { cwd = repo, input = '', entry = SKILL, env = {}, preload } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), path.join(entry, 'bin', 'kickflip.mjs'), ...args], {
    cwd, env: { ...process.env, HOME: home, KICKFLIP_CLAUDE: fakeClaude, KICKFLIP_HUB_PORT: '1', CLAUDECODE: '1', TMUX: '', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end(input);
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});
const json = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

after(() => {
  for (const c of sleepers) c.kill();
  try { for (const pid of fs.readFileSync(fakeLog + '.pids', 'utf8').trim().split('\n')) { try { process.kill(Number(pid)); } catch {} } } catch {}
  fs.rmSync(home, { recursive: true, force: true });
});

// The doctor lists the running clone's own .repos folder, so it runs from a copy of the code without it: the report
// then doesn't depend on which board clones the machine's checkout holds.
let doctorRoot;
function doctorClone() {
  if (!doctorRoot) {
    doctorRoot = path.join(home, 'doctor-clone');
    for (const dir of ['bin', 'board', 'hub', 'shared', 'hooks-plugin']) fs.cpSync(path.join(SKILL, dir), path.join(doctorRoot, dir), { recursive: true, filter: (file) => !file.endsWith('.test.mjs') });
  }
  return doctorRoot;
}

function doctorCLI(name, { healthy = false, installed = false } = {}) {
  const scratch = path.join(home, name);
  fs.mkdirSync(scratch);
  const log = path.join(scratch, 'commands.jsonl');
  const port = 19460;
  if (installed) {
    installLinks({ home: scratch, cloneRoot: doctorClone() });
    installClaudeSettings({ home: scratch });
    write(hubService({ home: scratch }).file, 'service');
  }
  const tailscale = path.join(scratch, 'doctor-bin', 'tailscale');
  if (healthy) {
    // doctor finds tailscale on PATH (../shared/tailscale.mjs); the patched spawnSync below answers for it.
    write(tailscale, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(tailscale, 0o755);
    write(path.join(scratch, '.codex', 'auth.json'), '{}');
    write(path.join(scratch, 'doctor-bin', 'codex'), '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(scratch, 'doctor-bin', 'codex'), 0o755);
    for (const name of REVIEW_SKILLS) write(path.join(scratch, '.claude', 'skills', name, 'SKILL.md'), `# ${name}\n`);
    // A healthy hub here has the tailnet on, so doctor checks Tailscale and --fix maps / (../shared/tailnet.mjs).
    write(path.join(scratch, '.claude', 'kickflip', 'settings.json'), JSON.stringify({ tailnet: true }));
  }
  const source = `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    cp.spawnSync = (bin, args, options) => {
      const command = bin === ${JSON.stringify(tailscale)} ? 'tailscale' : bin;
      // On macOS kickflip reaches brew's daemon as tailscale --socket <path> <args> (../shared/tailscale.mjs).
      const argv = command === 'tailscale' && args[0] === '--socket' ? args.slice(2) : args;
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([command, ...argv]) + '\\n');
      if (!['git', 'node', 'gh', 'tailscale', 'tmux', ...(process.platform === 'darwin' ? ['launchctl'] : ['systemctl', 'loginctl'])].includes(command)) throw new Error('unexpected command: ' + command);
      if (!${healthy}) return { status: 1, stdout: '', stderr: 'unavailable' };
      let stdout = command + ' version';
      if (command === 'launchctl') stdout = 'state = running';
      if (command === 'systemctl' && argv.join(' ') === '--user is-active kickflip-hub.service') stdout = 'active';
      if (command === 'loginctl' && argv.join(' ') === 'show-user ' + process.getuid() + ' --property=Linger') stdout = 'Linger=yes';
      if (command === 'tailscale' && argv[0] === 'status') stdout = JSON.stringify({ BackendState: 'Running', Self: { ID: 'n-doctor', HostName: 'doctor-host' } });
      if (command === 'tailscale' && argv.join(' ') === 'debug prefs') stdout = JSON.stringify({ OperatorUser: os.userInfo().username });
      if (command === 'tailscale' && argv[0] === 'serve' && argv[1] === 'status') stdout = JSON.stringify({ Web: { host: { Handlers: { '/': { Proxy: 'http://127.0.0.1:${port}' } } } } });
      return { status: 0, stdout, stderr: '' };
    };
    syncBuiltinESMExports();
    globalThis.fetch = async (url) => {
      if (url !== 'http://127.0.0.1:${port}/_hub/status.json') throw new Error('unexpected URL: ' + url);
      return { ok: ${healthy}, json: async () => ({ sites: [] }) };
    };
  `;
  return {
    scratch,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    run: (...args) => cli(args, { entry: doctorClone(), env: { HOME: scratch, PATH: path.join(scratch, 'doctor-bin'), KICKFLIP_TAILSCALE: '', KICKFLIP_HUB_PORT: String(port), KICKFLIP_CLAUDE: '/usr/bin/false' }, preload: 'data:text/javascript,' + encodeURIComponent(source) }),
  };
}

test('doctor CLI reports healthy setup as text and JSON with exit 0', async () => {
  const fixture = doctorCLI('doctor-ok', { healthy: true, installed: true });
  const report = await fixture.run('doctor');
  assert.equal(report.status, 0, report.stderr);
  assert.ok(report.stdout.trim().split('\n').every((line) => process.platform === 'darwin' ? line.startsWith('ok ') : /^(?:ok |note +macOS-only parts: )/.test(line)));
  const result = json(await fixture.run('doctor', '--json'));
  assert.ok(result.items.length > 0);
  assert.ok(result.items.every((item) => item.state === (process.platform !== 'darwin' && item.item === 'macOS-only parts' ? 'note' : 'ok')));
  if (process.platform === 'linux') assert.equal(result.items.find((item) => item.item === 'macOS-only parts').state, 'note');
  assert.equal(fixture.calls().filter((call) => call[0] === 'gh' && call[1] === 'auth' && call[2] === 'status').length, 2);
});

test('doctor CLI exits 1 on a broken HOME and prints commands', async () => {
  const fixture = doctorCLI('doctor-broken');
  const report = await fixture.run('doctor');
  assert.equal(report.status, 1, report.stderr);
  assert.match(report.stdout, /^yours +gh signed in: needs gh\n +→ gh auth login$/m);
  // tmux is optional: only a hub board's session runs in it.
  assert.match(report.stdout, new RegExp(`^optional +tmux: not installed; a hub board’s session \\(kickflip join --hub, kickflip hub\\) runs in it\n +→ ${process.platform === 'darwin' ? 'brew' : 'sudo apt'} install tmux$`, 'm'));
  assert.match(report.stdout, /^fixable +kickflip skill link: missing -> .*\n +→ kickflip doctor --fix$/m);
  const structured = await fixture.run('doctor', '--json');
  assert.equal(structured.status, 1);
  assert.ok(JSON.parse(structured.stdout).items.some((item) => item.state === 'yours'));
  assert.equal(fs.existsSync(path.join(fixture.scratch, '.claude', 'kickflip')), false);
  assert.equal(fs.existsSync(path.join(fixture.scratch, '.claude', 'settings.json')), false);
});

test('doctor --fix and init CLI run the same setup once and finish with a JSON report', async () => {
  for (const [name, args] of [['doctor-fix', ['doctor', '--fix']], ['doctor-init', ['init']]]) {
    const fixture = doctorCLI(name, { healthy: true });
    const result = await fixture.run(...args, '--json');
    assert.equal(result.status, 0, result.stderr);
    const { items } = JSON.parse(result.stdout);
    assert.ok(items.every((item) => item.state === (process.platform !== 'darwin' && item.item === 'macOS-only parts' ? 'note' : 'ok')));
    if (process.platform === 'linux') assert.equal(items.find((item) => item.item === 'macOS-only parts').state, 'note');
    const calls = fixture.calls();
    assert.equal(calls.filter((call) => process.platform === 'darwin' ? call[0] === 'launchctl' && call[1] === 'bootstrap' : call.join(' ') === 'systemctl --user restart kickflip-hub.service').length, 1);
    assert.equal(calls.filter(([command, sub, flag]) => command === 'tailscale' && sub === 'serve' && flag === '--bg').length, 1);
    assert.ok(fs.existsSync(path.join(fixture.scratch, '.claude', 'settings.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.scratch, '.claude', 'kickflip', 'settings.json'), 'utf8')).tailscale.node, 'n-doctor');
  }
});

// runDoctor's dry run is install.test.mjs's; this checks the CLI passes --dry-run through init, doctor --fix's first-run name.
test('init --dry-run CLI writes no setup and invokes no service', async () => {
  const fixture = doctorCLI('init-dry');
  const result = await fixture.run('init', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would leave Tailscale alone: the tailnet is off/);
  assert.deepEqual(fixture.calls(), []);
  assert.deepEqual(fs.readdirSync(fixture.scratch), []);
});

test('join records the session and its folder: --repo, else the live session\'s cwd, else the recorded one, else where join ran; a rejoin, or a --force takeover, keeps the label and folder it leaves out, and drops an old model', async () => {
  json(await cli(['join', '--name', 'notes', '--session', 's-notes', '--label', 'Notes']));
  assert.deepEqual(manifest().sites.notes.owner, { ...manifest().sites.notes.owner, session: 's-notes', label: 'Notes', repo });
  json(await cli(['join', '--name', 'notes', '--session', 's-notes', '--repo', otherRepo]));
  assert.deepEqual([manifest().sites.notes.owner.repo, manifest().sites.notes.owner.label], [otherRepo, 'Notes']);
  // docs/adr/2026-11-18-0800-models-and-land-tests-are-hub-settings-only.md: a board's old orchestrator model goes at
  // its next join.
  const m = manifest();
  m.sites.notes.owner.model = 'sonnet';
  write(web('manifest.json'), m);
  liveRecord('s-notes', path.join(repo, 'apps'));
  json(await cli(['join', '--name', 'notes', '--session', 's-notes']));
  assert.deepEqual([manifest().sites.notes.owner.repo, 'model' in manifest().sites.notes.owner], [path.join(repo, 'apps'), false]);
  const owner = () => { const o = manifest().sites.notes.owner; return [o.session, o.label, o.repo]; };
  json(await cli(['join', '--name', 'notes', '--session', 's-notes-2', '--force'], { cwd: otherRepo }));
  assert.deepEqual(owner(), ['s-notes-2', 'Notes', path.join(repo, 'apps')]);
  json(await cli(['join', '--name', 'notes', '--session', 's-notes-2'], { cwd: otherRepo }));
  assert.deepEqual(owner(), ['s-notes-2', 'Notes', path.join(repo, 'apps')]);
});

test('start runs claude --bg in the folder, in auto mode with isolation off, and records the new session as the owner', async () => {
  json(await cli(['join', '--name', 'Shop', '--session', 's-old', '--repo', repo]));
  const r = json(await cli(['start', 'shop', '--prompt', 'Pick up INT-9']));
  const [call] = calls();
  const { id } = call;
  assert.deepEqual(call.argv, ['--bg', '--name', 'Shop', '--permission-mode', 'auto', '--settings', BG_SETTINGS, '--model', 'opus', "/kickflip board 'Shop' Pick up INT-9"]);
  const settings = JSON.parse(BG_SETTINGS);
  assert.deepEqual(Object.keys(settings), ['worktree', 'permissions', 'hooks']);
  assert.deepEqual([settings.worktree, settings.permissions, Object.keys(settings.hooks)], [{ bgIsolation: 'none' }, { allow: ['Bash(kickflip doctor)'], deny: ['Workflow'] }, ['PermissionRequest', 'PermissionDenied', 'Stop']]);
  const [{ matcher: deniedMatcher, hooks: [denied, ...moreDenied] }] = settings.hooks.PermissionDenied;
  assert.deepEqual([deniedMatcher, denied.type, moreDenied], ['Bash', 'command', []]);
  assert.equal(denied.command, `"${nodeBin()}" "${path.join(SKILL, 'hub', 'permission-denied-hook.mjs')}"`);
  const [{ matcher, hooks: [hook, ...more] }] = settings.hooks.PermissionRequest;
  assert.deepEqual([matcher, hook.type, more], ['*', 'command', []]);
  assert.equal(hook.command, `"${nodeBin()}" "${path.join(SKILL, 'hub', 'permission-hook.mjs')}"`);
  assert.ok(hook.timeout * 1000 > WAIT_MS, `the hook's timeout ${hook.timeout}s must outlast its wait`);
  assert.deepEqual([call.cwd, call.isolation, call.claudecode], [repo, 'none', null]);
  assert.deepEqual([r.session, r.confirmed, r.repo, r.argv], [id, true, repo, [fakeClaude, ...call.argv]]);
  assert.deepEqual(manifest().sites.shop.owner, { session: id, label: 'Shop', since: manifest().sites.shop.owner.since, repo });
});

test('start on a route with no site waits in starting until that session joins', async () => {
  const before = calls().length;
  const pending = { title: 'Fresh board', repo: otherRepo, asked_at: new Date().toISOString() };
  const m = manifest();
  m.starting = { ...m.starting, fresh: pending };
  write(web('manifest.json'), m);
  const r = json(await cli(['start', 'fresh', '--repo', otherRepo]));
  const call = calls()[before];
  assert.deepEqual([call.argv.at(-1), call.cwd, call.argv[call.argv.indexOf('--model') + 1]], ["/kickflip board 'fresh'", otherRepo, 'opus']);
  assert.deepEqual(manifest().starting.fresh, { ...manifest().starting.fresh, session: r.session, repo: otherRepo });
  assert.deepEqual([manifest().starting.fresh.title, manifest().starting.fresh.asked_at, call.argv[2]], [pending.title, pending.asked_at, pending.title]);
  assert.equal(manifest().sites.fresh, undefined);
  assert.match((await cli(['sessions'])).stdout, new RegExp(`^/fresh  ${r.session}  not live  ${otherRepo}  \\(starting: not joined yet\\)$`, 'm'));
  json(await cli(['join', '--name', 'fresh', '--session', r.session], { cwd: otherRepo }));
  assert.deepEqual([manifest().sites.fresh.owner.session, manifest().sites.fresh.owner.repo, Boolean(manifest().starting.fresh.joined_at)], [r.session, otherRepo, true]);
});

test("start trusts a clone the hub made under its realpath before claude --bg, so a board that didn't start starts on a retry, and trusts no other folder", async (t) => {
  const copy = path.join(home, 'installed kickflip');
  for (const dir of ['bin', 'board', 'hub', 'shared', 'hooks-plugin']) fs.cpSync(path.join(SKILL, dir), path.join(copy, dir), { recursive: true, filter: (file) => !file.endsWith('.test.mjs') });
  const clone = web('repos', 'ever-cars', 'dev-setup');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  const link = path.join(home, 'dev-setup link');
  fs.symlinkSync(clone, link);
  const configFile = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
  write(configFile, { theme: 'dark', projects: { [otherRepo]: { allowedTools: ['Read'] } } });
  const saved = manifest();
  t.after(() => write(web('manifest.json'), saved));
  const m = manifest();
  m.starting = { ...m.starting, 'dev-setup': { title: 'Dev setup', repo: clone, error: 'claude --bg failed (1): Workspace not trusted.', asked_at: new Date().toISOString() } };
  write(web('manifest.json'), m);
  const before = calls().length;
  const r = json(await cli(['start', 'dev-setup', '--repo', link], { entry: copy }));
  assert.deepEqual([calls().length, calls()[before].cwd, r.session], [before + 1, clone, manifest().starting['dev-setup'].session]);
  assert.deepEqual(read(configFile), { theme: 'dark', projects: { [otherRepo]: { allowedTools: ['Read'] }, [clone]: { hasTrustDialogAccepted: true } } });
  const text = fs.readFileSync(configFile, 'utf8');
  for (const folder of [otherRepo, web('repos', 'ever-cars')]) json(await cli(['start', `plain-${path.basename(folder)}`, '--repo', folder], { entry: copy }));
  assert.equal(fs.readFileSync(configFile, 'utf8'), text);
});

test('resume runs claude --resume <id> --bg in the recorded folder, and start and resume refuse a live session', async () => {
  const { session } = manifest().sites.shop.owner;
  const before = calls().length;
  const r = json(await cli(['resume', 'shop']));
  const call = calls()[before];
  assert.deepEqual(call.argv.slice(0, -1), ['--resume', session, '--bg', '--name', 'Shop', '--permission-mode', 'auto', '--settings', BG_SETTINGS, '--model', 'opus']);
  assert.ok(call.argv.at(-1).startsWith("/kickflip board 'Shop'\n"));
  assert.match(call.argv.at(-1), new RegExp(`Rejoin the board as session ${session} `));
  assert.deepEqual([call.cwd, r.session, r.repo], [repo, session, repo]);
  liveRecord(session, repo);
  const refusals = [await cli(['resume', 'shop']), await cli(['start', 'shop'])];
  assert.deepEqual(refusals.map((x) => x.status), [3, 3]);
  assert.match(refusals[0].stderr, /is live \(in a terminal, pid \d+\)/);
  assert.equal(calls().length, before + 1);
  const none = await cli(['resume', 'nowhere']);
  assert.deepEqual([none.status, none.stderr.trim()], [1, 'kickflip: /nowhere has no recorded session']);
});

test('sessions prints one line per board: route, session, live or not, folder', async () => {
  write(path.join(home, 'boards', 'b1', 'board.json'), { title: 'B1' });
  write(path.join(home, 'boards', 'b2', 'board.json'), { title: 'B2' });
  const m = manifest();
  m.sites.b1 = { dir: path.join(home, 'boards', 'b1'), port: 1, cmd: boardCmd(path.join(home, 'boards', 'b1')), owner: { session: 's-b1', repo } };
  m.sites.b2 = { dir: path.join(home, 'boards', 'b2'), port: 2, cmd: boardCmd(path.join(home, 'boards', 'b2')) };
  write(web('manifest.json'), m);
  liveRecord('s-b1', repo);
  assert.deepEqual((await cli(['sessions'])).stdout.trim().split('\n'), [`/b1  s-b1  live (terminal)  ${repo}`, '/b2  no session  not live  no folder']);
  assert.deepEqual(json(await cli(['sessions', '--json']))[1], { route: 'b2', session: null, live: null, repo: null, starting: false });
});

test('resume wakes a background session in place with no flags, and records the id a copy comes back under, keeping its label and folder and carrying its watcher cursor', async () => {
  const dir = path.join(home, 'boards', 'audit');
  write(path.join(dir, 'board.json'), { title: 'Audit' });
  const id = crypto.randomUUID();
  const m = manifest();
  m.sites.audit = { dir, port: 3, cmd: boardCmd(dir), title: 'Audit', owner: { session: id, label: 'Audit', repo, since: '2026-10-30T00:00:00Z' } };
  write(web('manifest.json'), m);
  write(agentsFile, [{ id: id.slice(0, 8), sessionId: id, kind: 'background' }]);
  write(path.join(dir, 'data', `.watch-cursor-${id}.json`), { 'data/events.jsonl': 4 });
  const before = calls().length;
  const r = json(await cli(['resume', 'audit']));
  const call = calls()[before];
  assert.deepEqual(call.argv.slice(0, -1), ['--resume', id, '--bg']);
  assert.match(call.argv.at(-1), new RegExp(`^/kickflip board 'Audit'\\n[^]*as session ${id} `));
  assert.deepEqual([r.session, r.previous, r.confirmed, manifest().sites.audit.owner.session], [id, id, true, id]);
  write(copyNext, '');
  const copy = json(await cli(['resume', 'audit']));
  assert.notEqual(copy.session, id);
  assert.deepEqual([copy.previous, copy.confirmed], [id, true]);
  const { owner } = manifest().sites.audit;
  assert.deepEqual([owner.session, owner.label, owner.repo], [copy.session, 'Audit', repo]);
  assert.deepEqual(read(path.join(dir, 'data', `.watch-cursor-${copy.session}.json`)), { 'data/events.jsonl': 4 });
});

test("the hub wakes a board's session as soon as an event lands while it isn't running, once per outage and never while it is live, falls back after a few minutes for an event it never heard, then pushes once", async () => {
  const boards = {};
  const owners = { quiet: { session: 's-quiet', repo }, busy: { session: 's-busy', repo }, bare: { session: 's-bare' }, lost: { session: 's-lost', repo }, old: { session: 's-old', repo, since: '2026-10-29T00:00:00Z' } };
  const events = (route) => path.join(home, 'hub-boards', route, 'data', 'events.jsonl');
  for (const [route, owner] of Object.entries(owners)) {
    const dir = path.join(home, 'hub-boards', route);
    write(path.join(dir, 'board.json'), { title: route[0].toUpperCase() + route.slice(1) });
    write(events(route), '');
    boards[route] = { dir, port: 1, cmd: boardCmd(dir), owner };
  }
  const t0 = Date.parse('2026-10-29T12:00:00Z');
  const event = (route, min) => fs.appendFileSync(events(route), JSON.stringify({ id: crypto.randomUUID(), ts: new Date(t0 + min * 60_000).toISOString(), kind: 'ask' }) + '\n');
  const lines = (route) => ({ 'data/events.jsonl': fs.readFileSync(events(route), 'utf8').split('\n').filter(Boolean).length });
  event('old', -1);
  const m = { sites: boards };
  const listeningNow = new Set();
  const resumed = [];
  const pushed = [];
  const check = (min) => checkSessions({
    manifest: m, now: new Date(t0 + min * 60_000),
    live: () => new Map([['s-busy', { pid: 1, kind: 'interactive' }]]),
    listening: (b) => listeningNow.has(b.route),
    resume: async (route, mark) => { resumed.push([min, route, mark]); if (route === 'lost') throw new Error('no such session'); },
    push: async (msg, opts) => { pushed.push([min, msg.title, msg.tag, msg.body, opts.kind]); },
  });
  const comeback = COMEBACK_WAIT / 60_000;
  const resumeMin = RESUME_AFTER / 60_000;
  await check(0);
  assert.deepEqual(resumed, []);
  for (const route of ['quiet', 'busy', 'bare', 'lost']) event(route, 0.2);
  assert.deepEqual(await check(0.25), { resumed: ['quiet'], restarted: [], pushed: [], failed: ['lost: could not resume its session (no such session)'] });
  assert.deepEqual(resumed, [[0.25, 'quiet', { 'data/events.jsonl': 0 }], [0.25, 'lost', { 'data/events.jsonl': 0 }]]);
  await check(0.5);
  assert.deepEqual(pushed.map((p) => p.slice(0, 3)), [[0.5, "Lost's session didn't come back", 'resume-lost']]);
  assert.match(pushed[0][3], /couldn't resume it: no such session/);
  event('quiet', 1);
  await check(1.25);
  assert.equal(resumed.length, 2, 'one wake per outage');
  await check(resumeMin - 0.25);
  assert.equal(resumed.length, 2);
  await check(resumeMin);
  assert.deepEqual(resumed.at(-1), [resumeMin, 'old', { 'data/events.jsonl': 1 }]);
  await check(0.25 + comeback - 0.25);
  assert.equal(pushed.length, 1);
  await check(0.25 + comeback);
  assert.deepEqual(pushed.map((p) => p.slice(0, 3)).at(-1), [0.25 + comeback, "Quiet's session didn't come back", 'resume-quiet']);
  assert.deepEqual(pushed.map((p) => p[4]), ['fault', 'fault']);
  listeningNow.add('quiet');
  await check(10);
  assert.equal(read(web('resume-state.json')).quiet, undefined);
  listeningNow.delete('quiet');
  await check(11);
  const mark = lines('quiet');
  event('quiet', 11.1);
  await check(11.25);
  assert.deepEqual(resumed.at(-1), [11.25, 'quiet', mark]);
  assert.ok(resumed.every(([, route]) => route !== 'busy' && route !== 'bare'));
});

test('the wake resumes the session in place with a prompt naming its id, and winds its watcher cursor back to the lines it had when the hub saw it stopped', async () => {
  const dir = path.join(home, 'boards', 'wake');
  const file = path.join(dir, 'data', 'events.jsonl');
  write(path.join(dir, 'board.json'), { title: 'Wake' });
  const line = (n) => JSON.stringify({ id: `w${n}`, ts: new Date().toISOString(), kind: 'ask' }) + '\n';
  write(file, line(1));
  const id = crypto.randomUUID();
  const cursor = path.join(dir, 'data', `.watch-cursor-${id}.json`);
  write(cursor, { 'data/events.jsonl': 1 });
  const m = manifest();
  m.sites.wake = { dir, port: 4, cmd: boardCmd(dir), title: 'Wake', owner: { session: id, label: 'Wake', repo, since: '2026-10-30T00:00:00Z' } };
  write(web('manifest.json'), m);
  write(agentsFile, [{ id: id.slice(0, 8), sessionId: id, kind: 'background' }]);
  const check = () => checkSessions({ manifest: manifest(), live: () => new Map() });
  assert.deepEqual((await check()).resumed, []);
  fs.appendFileSync(file, line(2));
  write(cursor, { 'data/events.jsonl': 2 });
  const before = calls().length;
  assert.deepEqual((await check()).resumed, ['wake']);
  const [call] = calls().slice(before);
  assert.deepEqual(call.argv.slice(0, -1), ['--resume', id, '--bg']);
  assert.match(call.argv.at(-1), new RegExp(`^/kickflip board 'Wake'\\n[^]*as session ${id} `));
  assert.deepEqual([read(cursor), manifest().sites.wake.owner.session], [{ 'data/events.jsonl': 1 }, id]);
  assert.deepEqual((await check()).resumed, []);
  // docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md
  const logged = fs.readFileSync(path.join(dir, 'data', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(logged.map((e) => [e.call, e.result, e.reason, e.inputs.listening, e.inputs.live, e.inputs.asked]), [
    ['session-resume', 'resumed', "An event waited while the board's session wasn't listening.", false, false, false],
  ]);
});

test('the wake gives a session with no watcher cursor the mark as its cursor, for a watched file named __proto__', async () => {
  const dir = path.join(home, 'boards', 'proto-watch');
  const file = path.join(dir, '__proto__');
  write(path.join(dir, 'board.json'), { title: 'Proto watch' });
  const line = (n) => JSON.stringify({ id: `p${n}`, ts: new Date().toISOString(), kind: 'ask' }) + '\n';
  write(file, line(1));
  const id = crypto.randomUUID();
  const cursor = path.join(dir, 'data', `.watch-cursor-${id}.json`);
  const m = fs.existsSync(web('manifest.json')) ? manifest() : { sites: {} };
  m.sites['proto-watch'] = { dir, port: 5, cmd: boardCmd(dir), title: 'Proto watch', watch: ['__proto__'], owner: { session: id, label: 'Proto', repo, since: '2026-10-30T00:00:00Z' } };
  write(web('manifest.json'), m);
  write(agentsFile, [{ id: id.slice(0, 8), sessionId: id, kind: 'background' }]);
  const check = () => checkSessions({ manifest: manifest(), live: () => new Map() });
  await check();
  fs.appendFileSync(file, line(2));
  assert.ok((await check()).resumed.includes('proto-watch'));
  assert.deepEqual(Object.entries(read(cursor)), [['__proto__', 1]]);
});


test('the hub starts and resumes every board session with /kickflip board and its name: the title when it hyphenates to the route, else the route, quoted for its shell', async () => {
  const { startArgv, resumePrompt, hubArgv } = await import('./sessions.mjs');
  assert.equal(startArgv({ route: 'bob-s-board', name: "Bob's board" }).at(-1), "/kickflip board 'Bob'\\''s board'");
  const resumed = resumePrompt('ops', 'id-1', 'Operations');
  assert.ok(resumed.startsWith("/kickflip board 'ops'\n"), resumed);
  assert.match(resumed, /Rejoin the board as session id-1 and relaunch its watcher/);
  assert.ok(hubArgv({ route: 'dev-hub', title: 'Dev hub' }).at(-1).startsWith("/kickflip board 'Dev hub' --hub\n"));
  assert.ok(hubArgv({ route: 'dev-hub', title: 'Dev hub', id: 's-hub' }).at(-1).startsWith("/kickflip board 'Dev hub'\n"));
});

// One route runs the CLI end to end; the route lookups test below covers each property name in-process.
test('start, join and resume accept routes named after object properties', async () => {
  for (const [i, route] of ['constructor'].entries()) {
    const started = json(await cli(['start', route, '--repo', repo]));
    assert.equal(manifest().starting[route].session, started.session);
    json(await cli(['join', '--name', route, '--session', started.session, '--template', 'board', '--port', String(4650 + i)]));
    assert.equal(Object.hasOwn(manifest().starting, route), true, 'the joined route lands until it listens');
    assert.equal(manifest().sites[route].owner.session, started.session);
    const resumed = json(await cli(['resume', route]));
    assert.equal(resumed.session, started.session);
    assert.equal(manifest().sites[route].owner.session, resumed.session);
    assert.match((await cli(['sessions'])).stdout, new RegExp(`^/${route}  ${resumed.session}  not live`, 'm'));
  }
});

test('route lookups ignore inherited site and starting records, including __proto__', async () => {
  const { sessionOf, startingBoards } = await import('./sessions.mjs');
  const { routeRecord } = await import('./routes.mjs');
  for (const route of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const owner = { session: 's-own', repo };
    const sites = { [route]: { owner, title: route } };
    const starting = { [route]: { ...owner, title: route, asked_at: new Date().toISOString() } };
    assert.equal(routeRecord({}, route), undefined);
    assert.equal(sessionOf({ sites: {}, starting: {} }, route), null);
    assert.equal(sessionOf({ sites: Object.create(sites), starting: Object.create(starting) }, route), null);
    assert.equal(sessionOf({ sites, starting: {} }, route).session, 's-own');
    assert.equal(sessionOf({ sites: {}, starting }, route).session, 's-own');
    assert.equal(startingBoards({ sites: {}, starting })[0].route, route);
    assert.deepEqual(startingBoards({ sites, starting }), []);
  }
});

test('resume state starts a fresh outage and resumes once for object property routes', async () => {
  const routes = ['constructor', 'tostring', 'hasownproperty', 'valueof', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];
  const sites = Object.fromEntries(routes.map((route, i) => {
    const dir = path.join(home, 'resume-names', route);
    write(path.join(dir, 'board.json'), { title: route });
    return [route, { dir, port: 4800 + i, cmd: boardCmd(dir), owner: { session: route, repo, since: new Date().toISOString() } }];
  }));
  write(web('resume-state.json'), {});
  const resumed = [];
  const pushed = [];
  const at = Date.now();
  const check = (ms, listening = false) => checkSessions({ manifest: { sites }, now: new Date(at + ms), live: () => new Map(),
    listening: () => listening, resume: async (route) => { resumed.push(route); }, push: async (p) => { pushed.push(p.tag); } });
  assert.deepEqual(await check(0), { resumed: [], restarted: [], pushed: [], failed: [] });
  const state = read(web('resume-state.json'));
  for (const route of routes) {
    assert.equal(state[route].down_since, new Date(at).toISOString());
    write(path.join(sites[route].dir, 'data', 'events.jsonl'), JSON.stringify({ id: route, ts: new Date(at + 1).toISOString(), kind: 'ask', data: {} }) + '\n');
  }
  assert.deepEqual((await check(2)).resumed, routes);
  assert.deepEqual((await check(3)).resumed, []);
  assert.deepEqual((await check(COMEBACK_WAIT + 2)).pushed, routes);
  assert.deepEqual(resumed, routes);
  assert.deepEqual(pushed, routes.map((route) => `resume-${route}`));
  await check(COMEBACK_WAIT + 3, true);
  assert.deepEqual(read(web('resume-state.json')), {});
  const { checkListening } = await import('./boards.mjs');
  write(web('settings.json'), { notifications: { on: false } });
  write(web('deaf-state.json'), {});
  for (const site of Object.values(sites)) delete site.owner.repo;
  const listen = () => checkListening({ manifest: { sites }, now: new Date(at + 20 * 60_000), running: new Map() });
  assert.deepEqual((await listen()).pushed, routes);
  assert.deepEqual((await listen()).pushed, []);
  for (const route of routes) assert.equal(read(web('deaf-state.json'))[route].since, new Date(at + 1).toISOString());
});

const hubManifest = (owner) => {
  const dir = path.join(home, 'hub-board');
  const decoy = path.join(home, 'decoy-board');
  write(path.join(dir, 'board.json'), { title: 'Hub' });
  return { sites: {
    'hub-orchestrator': { dir: decoy, port: 2, cmd: boardCmd(decoy), owner: { session: 's-decoy', repo: otherRepo } },
    'dev-hub': { dir, port: 1, cmd: boardCmd(dir), owner, hub: true },
  } };
};
const flagged = () => Object.entries(manifest().sites).filter(([, s]) => s.hub).map(([route]) => route);

test('set --hub moves the hub flag to one board, --no-hub clears it, join --hub takes it and a later join keeps it', async () => {
  const page = { dir: repo, port: 3, cmd: [process.execPath, path.join(SKILL, 'starter', 'server.mjs')] };
  const dirA = path.join(home, 'flag-a');
  const dirB = path.join(home, 'flag-b');
  write(web('manifest.json'), { sites: { a: { dir: dirA, port: 1, cmd: boardCmd(dirA) }, b: { dir: dirB, port: 2, cmd: boardCmd(dirB), hub: true }, page } });
  assert.deepEqual(json(await cli(['set', 'a', '--hub'])), { route: 'a', icon: null, color: null, hub: true });
  assert.deepEqual(flagged(), ['a']);
  assert.equal(json(await cli(['set', 'a', '--icon', 'book'])).hub, true);
  assert.deepEqual(flagged(), ['a']);
  assert.equal(json(await cli(['set', 'a', '--no-hub'])).hub, false);
  assert.deepEqual(flagged(), []);
  json(await cli(['join', '--name', 'b', '--session', 's-b', '--hub']));
  assert.deepEqual(flagged(), ['b']);
  json(await cli(['join', '--name', 'b', '--session', 's-b']));
  assert.deepEqual(flagged(), ['b']);
  const notBoard = await cli(['set', 'page', '--hub']);
  assert.equal(notBoard.status, 2);
  assert.match(notBoard.stderr, /\/page is not a board/);
  const newPage = await cli(['join', '--name', 'new-page', '--session', 's-new', '--hub']);
  assert.equal(newPage.status, 2);
  assert.match(newPage.stderr, /\/new-page is not a board/);
  assert.equal(fs.existsSync(web('sites', 'new-page')), false);
  assert.equal(manifest().sites['new-page'], undefined);
  assert.equal((await cli(['set', 'a', '--hub', '--no-hub'])).status, 2);
  assert.deepEqual(flagged(), ['b']);
});

// The new-session call's claude argv, after `/usr/bin/env -u … [PATH=…] <claude>`.
const tmuxClaude = (argv) => argv.slice(argv.indexOf(fakeClaude) + 1);

test('hub starts the hub board owner in a tmux session in the foreground, in its folder on the hub Orchestrators choice with the phone hook, then attaches this terminal', async () => {
  const m = hubManifest({ session: 's-hub', repo });
  write(web('manifest.json'), m);
  noTmux();
  const before = [calls().length, tmuxCalls().length];
  const r = await cli(['hub', '--repo', otherRepo]);
  assert.deepEqual(r, { status: 0, stdout: 'attached =kickflip-dev-hub\n', stderr: '' });
  const made = tmuxCalls().slice(before[1]);
  assert.deepEqual(made.map((argv) => argv.slice(0, 6)), [['has-session', '-t', '=kickflip-dev-hub'], ['new-session', '-d', '-s', 'kickflip-dev-hub', '-c', repo], ['attach-session', '-t', '=kickflip-dev-hub']]);
  const [env, ...unset] = made[1].slice(6, made[1].indexOf(fakeClaude));
  assert.equal(env, '/usr/bin/env');
  assert.ok(unset.join(' ').includes('-u CLAUDECODE'));
  const argv = tmuxClaude(made[1]);
  assert.deepEqual(argv.slice(0, -1), ['--resume', 's-hub', '--name', 'Hub', '--permission-mode', 'auto', '--settings', BG_SETTINGS, '--model', 'opus']);
  assert.match(argv.at(-1), /You are the hub session/);
  assert.ok(argv.at(-1).includes(path.join(SKILL, 'docs', 'hub-session.md')));
  assert.ok(argv.at(-1).startsWith("/kickflip board 'dev-hub'\n"), 'a resumed hub session rejoins with no --hub, which its entry keeps');
  assert.equal(calls().length, before[0]);
  assert.deepEqual(manifest(), m);
});

test('while the hub board tmux session runs, hub only attaches to it and starts nothing, even with its session live', async () => {
  write(web('manifest.json'), hubManifest({ session: 's-hub', repo }));
  write(tmuxRunning, '');
  const before = tmuxCalls().length;
  const r = await cli(['hub']);
  assert.deepEqual([r.status, r.stdout], [0, 'attached =kickflip-dev-hub\n']);
  assert.deepEqual(tmuxCalls().slice(before).map((argv) => argv[0]), ['has-session', 'attach-session']);
  assert.equal((await cli(['hub'], { env: { TMUX: '/tmp/tmux-501/default,1,0' } })).stdout, 'switched =kickflip-dev-hub\n');
  const { hubSession } = await import('./sessions.mjs');
  const attached = [];
  const result = await hubSession({ manifest: hubManifest({ session: 's-hub', repo }), tmux: (argv) => ({ status: argv[0] === 'has-session' ? 0 : assert.fail(argv.join(' ')) }),
    attach: async (route) => { attached.push(route); return { status: 0 }; }, live: () => new Map([['s-hub', { pid: 1, kind: 'interactive' }]]) });
  assert.deepEqual([result, attached], [{ status: 0 }, ['dev-hub']]);
  noTmux();
});

test('hub starts fresh with no owner, in --repo or the cwd, with the join prompt and hub doc pointer', async () => {
  for (const options of [{ args: ['--repo', otherRepo], dir: otherRepo, owner: undefined }, { args: [], dir: repo, owner: {} }]) {
    write(web('manifest.json'), hubManifest(options.owner));
    noTmux();
    const before = tmuxCalls().length;
    const r = await cli(['hub', ...options.args]);
    assert.equal(r.status, 0, r.stderr);
    const started = tmuxCalls().slice(before).find((argv) => argv[0] === 'new-session');
    assert.equal(started[5], options.dir);
    const argv = tmuxClaude(started);
    assert.equal(argv.includes('--resume'), false);
    assert.ok(argv.at(-1).startsWith("/kickflip board 'dev-hub' --hub\n"));
    assert.match(argv.at(-1), /You are the hub session/);
    assert.ok(argv.at(-1).includes(path.join(SKILL, 'docs', 'hub-session.md')));
  }
  noTmux();
});

test('hub exits 2 with one line telling the owner to flag or join a hub board when no board has the flag', async () => {
  const before = calls().length;
  const page = { dir: repo, cmd: [process.execPath, path.join(SKILL, 'starter', 'server.mjs')] };
  const board = { dir: repo, cmd: boardCmd(repo), owner: { session: 's-hub', repo } };
  for (const m of [{ sites: {} }, { sites: { 'hub-orchestrator': page } }, { sites: { 'hub-orchestrator': board } }, { sites: { 'dev-hub': { ...page, hub: true } } },
    { sites: {}, starting: { 'hub-orchestrator': { session: 's-hub', repo } } }]) {
    write(web('manifest.json'), m);
    const r = await cli(['hub']);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'kickflip: No hub board is flagged; flag one with kickflip set <route> --hub, or run kickflip join --hub in its repo folder\n');
  }
  assert.equal(calls().length, before);
});

test("hub keeps tmux attach's exit code", async () => {
  for (const status of [7, 42]) {
    write(web('manifest.json'), hubManifest({ session: 's-hub', repo }));
    write(attachExit, String(status));
    const r = await cli(['hub']);
    assert.equal(r.status, status);
  }
  fs.rmSync(attachExit);
  noTmux();
});

test('hub uses injected tmux and attach runners and refuses a live owner or a missing recorded folder', async () => {
  const { hubSession } = await import('./sessions.mjs');
  const m = hubManifest({ session: 's-hub', repo });
  const ran = [];
  const tmux = (argv) => { ran.push(argv); return { status: argv[0] === 'has-session' ? 1 : 0, stdout: '', stderr: '' }; };
  const attach = async (route) => ({ status: 9, route });
  assert.deepEqual(await hubSession({ manifest: m, tmux, attach, live: () => new Map() }), { status: 9, route: 'dev-hub' });
  assert.deepEqual(ran.map((argv) => argv.slice(0, 6)), [['has-session', '-t', '=kickflip-dev-hub'], ['new-session', '-d', '-s', 'kickflip-dev-hub', '-c', repo]]);
  await assert.rejects(hubSession({ manifest: m, tmux, attach, live: () => new Map([['s-hub', { pid: 1, kind: 'interactive' }]]) }), { reason: 'live' });
  assert.equal(ran.length, 3);
  const refused = await hubSession({ manifest: m, tmux: (argv) => ({ status: argv[0] === 'has-session' ? 1 : 127, stdout: '', stderr: "tmux isn't installed" }), attach, live: () => new Map() }).catch((e) => e);
  assert.deepEqual([refused.reason, refused.message], ['failed', "tmux new-session failed (127): tmux isn't installed"]);
  noTmux();
  const before = tmuxCalls().length;
  m.sites['dev-hub'].owner.repo = path.join(home, 'gone');
  write(web('manifest.json'), m);
  const gone = await cli(['hub', '--repo', otherRepo]);
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /recorded folder .*gone/);
  delete m.sites['dev-hub'].owner.repo;
  write(web('manifest.json'), m);
  const r = await cli(['hub']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no folder recorded/);
  assert.deepEqual(tmuxCalls().slice(before).map((argv) => argv[0]), ['has-session', 'has-session']);
  assert.equal((await cli(['hub', '--repo', otherRepo])).status, 0);
  const started = tmuxCalls().find((argv, i) => i >= before && argv[0] === 'new-session');
  assert.deepEqual([started[5], tmuxClaude(started).slice(0, 2)], [otherRepo, ['--resume', 's-hub']]);
  noTmux();
});

test("a tap on an asleep board's page wakes its session at once with no event, once per outage, and never while it runs", async () => {
  const dir = path.join(home, 'tap-board');
  write(path.join(dir, 'board.json'), { title: 'Tap' });
  write(path.join(dir, 'data', 'events.jsonl'), '');
  const m = { sites: { tap: { dir, port: 1, cmd: boardCmd(dir), owner: { session: 's-tap', repo } } } };
  const resumed = [];
  let running = new Map();
  const check = (asked) => checkSessions({ manifest: m, asked: new Set(asked), live: () => running, listening: () => false,
    resume: async (route) => { resumed.push(route); }, push: async () => {} });
  fs.rmSync(web('resume-state.json'), { force: true });
  await check([]);
  assert.deepEqual(resumed, []);
  assert.deepEqual(await check(['tap']), { resumed: ['tap'], restarted: [], pushed: [], failed: [] });
  assert.ok(read(web('resume-state.json')).tap.resumed_at);
  await check(['tap']);
  assert.deepEqual(resumed, ['tap']);
  fs.rmSync(web('resume-state.json'));
  running = new Map([['s-tap', { pid: 1, kind: 'bg' }]]);
  await check(['tap']);
  assert.deepEqual(resumed, ['tap']);
  fs.rmSync(web('resume-state.json'), { force: true });
});

test("the hub restarts a running session that has idled without listening for 2 minutes, never while it is busy or something holds it, once per outage, logs each restart and whether it came back, and pushes only when it didn't", async () => {
  const { RESTART_AFTER } = await import('./sessions.mjs');
  const { readRestarts, autoRestartsFile } = await import('./auto-restarts.mjs');
  const { readAudit, boardAudit } = await import('../shared/audit.mjs');
  const sites = {};
  for (const route of ['deaf', 'held', 'broken']) {
    const dir = path.join(home, 'restart-boards', route);
    write(path.join(dir, 'board.json'), { title: route[0].toUpperCase() + route.slice(1) });
    write(path.join(dir, 'data', 'events.jsonl'), '');
    sites[route] = { dir, port: 1, cmd: boardCmd(dir), owner: { session: `s-${route}`, repo } };
  }
  fs.rmSync(web('resume-state.json'), { force: true });
  fs.rmSync(autoRestartsFile(), { force: true });
  const t0 = Date.parse('2026-11-15T12:00:00Z');
  const status = { deaf: 'busy', held: 'idle', broken: 'idle' };
  const listeningNow = new Set();
  const restarted = [];
  const pushed = [];
  let holds = 'a builder is open';
  const check = (min) => checkSessions({
    manifest: { sites }, now: new Date(t0 + min * 60_000),
    live: () => new Map(Object.entries(status).map(([route, s]) => [`s-${route}`, { pid: 1, kind: 'bg', status: s }])),
    listening: (b) => listeningNow.has(b.route),
    resume: async () => assert.fail('a running session is restarted, never resumed'),
    restart: async (route) => { restarted.push([min, route]); if (route === 'broken') throw new Error('claude stop failed'); },
    held: async (board, record) => { assert.equal(record.status, 'idle', 'only an idle session gets as far as its hold'); return board.route === 'held' ? holds : null; },
    push: async (msg) => { pushed.push([min, msg.title, msg.body]); },
    gateOf: () => ({ state: 'normal' }),
  });
  const after = RESTART_AFTER / 60_000;
  await check(0);
  await check(after - 0.25);
  assert.deepEqual(restarted, [], 'nothing restarts before 2 minutes');
  const first = await check(after);
  assert.deepEqual(restarted, [[after, 'broken']], 'a busy session waits, and a held one waits');
  assert.deepEqual([first.restarted, first.failed], [[], ['broken: could not restart its session (claude stop failed)']]);
  assert.deepEqual(readAudit(boardAudit(sites.held.dir)).map((e) => [e.call, e.result, e.reason]), [['session-restart', 'held', "Its session isn't listening, but a builder is open."]]);
  await check(after + 0.25);
  assert.equal(readAudit(boardAudit(sites.held.dir)).length, 1, 'a hold is logged once while its reason stays');
  assert.deepEqual(pushed, [[after + 0.25, "Broken's session didn't come back", "The hub couldn't restart it: claude stop failed"]], 'a failed restart pushes at once');

  status.deaf = 'idle';
  holds = null;
  assert.deepEqual((await check(after + 0.5)).restarted, ['deaf', 'held'], 'a busy session restarts once idle, a held one once nothing holds it');
  await check(after + 1);
  assert.equal(restarted.length, 3, 'one restart per outage');
  listeningNow.add('deaf');
  await check(after + 1.25);
  await check(after + 0.5 + COMEBACK_WAIT / 60_000);
  assert.deepEqual(pushed.slice(1), [[after + 0.5 + COMEBACK_WAIT / 60_000, "Held's session didn't come back", "The hub restarted it because it wasn't listening, and it still isn't."]]);
  assert.deepEqual(readRestarts().map((e) => [e.board, e.what, e.why, e.outcome, e.error]), [
    ['broken', 'session', 'not listening', 'failed', 'claude stop failed'],
    ['deaf', 'session', 'not listening', 'restarted', undefined],
    ['held', 'session', 'not listening', 'restarted', undefined],
    ['deaf', 'session', 'not listening', 'back', undefined],
    ['held', 'session', 'not listening', 'not back', undefined],
  ]);
  assert.equal(pushed.length, 2, 'a restart that worked pushes nothing');
  fs.rmSync(web('resume-state.json'), { force: true });
});

test('a session restart stops the running session, then resumes it in its folder with the rejoin prompt', async () => {
  const { restartSession } = await import('./sessions.mjs');
  const dir = path.join(home, 'restart-one');
  write(path.join(dir, 'board.json'), { title: 'Again' });
  const m = { sites: { again: { dir, port: 1, cmd: boardCmd(dir), owner: { session: 's-again', repo } } } };
  const steps = [];
  let running = new Map([['s-again', { pid: 1, sessionId: 's-again', kind: 'bg', jobId: 's-again' }]]);
  const r = await restartSession('again', {
    manifest: m, live: () => running,
    stop: async (record, { cwd }) => { steps.push(['stop', record.sessionId, cwd]); running = new Map(); },
    run: async (argv, { cwd }) => {
      if (argv[0] === 'agents') return { status: 0, stdout: JSON.stringify([{ sessionId: 's-again', kind: 'background' }]) };
      steps.push(['run', argv.slice(0, 3), cwd]);
      return { status: 0, stdout: '' };
    },
  });
  assert.deepEqual(steps, [['stop', 's-again', repo], ['run', ['--resume', 's-again', '--bg'], repo]]);
  assert.deepEqual([r.route, r.session, r.previous], ['again', 's-again', 's-again']);
});

// A hub board's session runs in a tmux session SIGTERM closes a moment later: a restart waits for it, and kills one that stays.
test("a hub board's session restart waits for its old tmux session to close before resuming, and kills one that never closes", async () => {
  const { restartSession } = await import('./sessions.mjs');
  const dir = path.join(home, 'restart-tmux');
  write(path.join(dir, 'board.json'), { title: 'Tmuxed' });
  const m = { sites: { tmuxed: { dir, port: 1, cmd: boardCmd(dir), hub: true, owner: { session: 's-tmuxed', repo } } } };
  const attempt = async (closesAfter) => {
    const steps = [];
    let polls = 0;
    let open = true;
    let running = new Map([['s-tmuxed', { pid: 1, sessionId: 's-tmuxed', kind: 'fg' }]]);
    const tmux = (argv) => {
      steps.push(argv[0]);
      if (argv[0] === 'has-session') { if (++polls > closesAfter) open = false; return { status: open ? 0 : 1, stdout: '', stderr: '' }; }
      if (argv[0] === 'kill-session') open = false;
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = await restartSession('tmuxed', { manifest: m, live: () => running, stop: async () => { running = new Map(); }, tmux, sleep: async () => {}, limit: 10 });
    return { steps, r };
  };
  const slow = await attempt(3);
  assert.deepEqual(slow.steps.filter((s) => s !== 'has-session'), ['new-session'], 'a slow exit is waited out, not killed');
  assert.ok(slow.steps.indexOf('new-session') >= 3);
  assert.equal(slow.r.session, 's-tmuxed');
  const stuck = await attempt(Infinity);
  assert.deepEqual(stuck.steps.filter((s) => s !== 'has-session'), ['kill-session', 'new-session']);
  assert.equal(stuck.steps.filter((s) => s === 'has-session').length >= 10, true);
});

test("while ps can't answer whether a session runs, the wake, the deaf push and the compact check wait for the next check, and start, resume, stop and hub refuse", async () => {
  const { stopSession, hubSession, compactFullContexts } = await import('./sessions.mjs');
  const { checkListening, listenState } = await import('./boards.mjs');
  const dir = path.join(home, 'unknown-board');
  write(path.join(dir, 'board.json'), { title: 'Unknown' });
  write(path.join(dir, 'data', 'events.jsonl'), JSON.stringify({ id: 'u1', ts: new Date(Date.now() - 3600_000).toISOString(), kind: 'ask' }) + '\n');
  const m = { sites: { unknown: { dir, port: 1, cmd: boardCmd(dir), owner: { session: 's-unknown', repo, since: '2026-10-30T00:00:00Z' } } } };
  const board = { route: 'unknown', dir, watch: ['data/events.jsonl'], owner: m.sites.unknown.owner };
  const outage = { unknown: { down_since: new Date(Date.now() - 3600_000).toISOString(), mark: { 'data/events.jsonl': 0 } } };
  write(web('resume-state.json'), outage);
  const nobody = { resume: async () => assert.fail('resumed'), push: async () => assert.fail('pushed') };
  assert.deepEqual(await checkSessions({ manifest: m, live: () => null, asked: new Set(['unknown']), listening: () => false, ...nobody }), { resumed: [], restarted: [], pushed: [], failed: [] });
  assert.deepEqual(read(web('resume-state.json')), outage, 'the outage and its mark are kept');
  const unknown = Object.assign(new Error('unknown'), { reason: 'unknown' });
  const tried = await checkSessions({ manifest: m, live: () => new Map(), asked: new Set(['unknown']), listening: () => false, resume: async () => { throw unknown; }, push: nobody.push });
  assert.equal(tried.failed.length, 1);
  assert.deepEqual([read(web('resume-state.json')).unknown.resumed_at, read(web('resume-state.json')).unknown.error], [undefined, undefined], 'the next check tries the resume again');
  write(web('deaf-state.json'), {});
  assert.deepEqual(await checkListening({ manifest: m, running: null }), { pushed: [], failed: [] });
  assert.deepEqual(read(web('deaf-state.json')), {});
  assert.deepEqual(await compactFullContexts({ manifest: m, running: null, tmux: () => assert.fail('ran tmux') }), { compacted: [], failed: [] });
  assert.equal(listenState(board, { running: null, wakes: {} }), 'asleep', 'with no watcher, an unknown session reads asleep, which pushes nothing');
  // This process stands for the watcher: its pid runs, and ps names it wait-events.mjs, or gives no answer, which
  // leaves it counted as the watcher.
  write(path.join(dir, 'data', 'watcher.json'), { pid: process.pid, since: new Date().toISOString() });
  const named = fakePs([{ pid: process.pid, args: 'node wait-events.mjs unknown s-unknown' }]);
  assert.equal(listenState(board, { running: null, wakes: {}, ps: named }), 'listening', 'a running watcher vouches for its session');
  assert.equal(listenState(board, { running: null, wakes: {}, ps: () => null }), 'listening', 'one ps gives no answer for still vouches');
  assert.equal(listenState(board, { running: null, wakes: {}, ps: fakePs([{ pid: process.pid, args: 'node other.mjs' }]) }), 'asleep', 'a reused pid does not');
  fs.rmSync(path.join(dir, 'data', 'watcher.json'));
  await assert.rejects(stopSession({ session: 's-unknown' }, { live: () => null, stop: async () => assert.fail('stopped') }), { reason: 'unknown' });
  await assert.rejects(hubSession({ manifest: hubManifest({ session: 's-hub', repo }), tmux: () => ({ status: 1 }), attach: async () => assert.fail('attached'), live: () => null }), { reason: 'unknown' });
  fs.rmSync(web('resume-state.json'), { force: true });

  // ps is asked only about a pid that runs.
  const session = liveRecord('s-unknown', repo);
  ps.stall(true);
  try {
    const before = calls().length;
    write(web('manifest.json'), { ...(fs.existsSync(web('manifest.json')) ? manifest() : {}), sites: { ...(fs.existsSync(web('manifest.json')) ? manifest().sites : {}), ...m.sites } });
    const refusals = [await cli(['resume', 'unknown']), await cli(['start', 'unknown'])];
    assert.deepEqual(refusals.map((x) => x.status), [1, 1]);
    for (const r of refusals) assert.match(r.stderr, /Couldn't tell whether session \S+ is live: ps gave no answer in time, as happens on a busy host\. Try again in a moment\./);
    assert.equal(calls().length, before, 'no second claude process');
    const listed = await cli(['sessions']);
    assert.match(listed.stdout, /^\/unknown  s-unknown  live unknown \(ps gave no answer\)  /m);
    delete m.sites.unknown;
    write(web('manifest.json'), { ...manifest(), sites: Object.fromEntries(Object.entries(manifest().sites).filter(([route]) => route !== 'unknown')) });
  } finally { ps.stall(false); session.kill(); }
});

test("the hub board's wake resumes its session in its tmux session, keeping its id, and refuses while that tmux session is open", async () => {
  const { resumeSession } = await import('./sessions.mjs');
  const m = hubManifest({ session: 's-hub', repo });
  write(web('manifest.json'), m);
  const ran = [];
  let open = false;
  const tmux = (argv) => { ran.push(argv); return { status: argv[0] === 'has-session' ? (open ? 0 : 1) : 0, stdout: '', stderr: '' }; };
  const r = await resumeSession('dev-hub', { manifest: m, tmux, live: () => new Map(), run: () => assert.fail('ran claude --bg') });
  assert.deepEqual([r.session, r.previous, r.repo], ['s-hub', 's-hub', repo]);
  assert.deepEqual(tmuxClaude(ran[1]).slice(0, 2), ['--resume', 's-hub']);
  assert.match(tmuxClaude(ran[1]).at(-1), /You are the hub session/);
  assert.equal(manifest().sites['dev-hub'].owner.session, 's-hub');
  open = true;
  await assert.rejects(resumeSession('dev-hub', { manifest: m, tmux, live: () => new Map() }), { reason: 'live' });
  assert.equal(ran.length, 3);
});

test('join, start and resume keep clone paths under the installed link across a clone move', async () => {
  const clone = path.join(home, 'dev', 'kickflip clone');
  for (const dir of ['bin', 'board', 'hub', 'shared', 'hooks-plugin']) fs.cpSync(path.join(SKILL, dir), path.join(clone, dir), { recursive: true, filter: (file) => !file.endsWith('.test.mjs') });
  const { installLinks } = await import('../bin/install.mjs');
  const [{ link }] = installLinks({ home, cloneRoot: clone });
  const dir = path.join(clone, 'test-board');
  const pendingRepo = path.join(clone, '.repos', 'owner', 'project');
  const entry = { dir, port: 0, cmd: [process.execPath, path.join(clone, 'board', 'server.mjs'), dir], owner: { session: 's-linked', repo: clone } };
  write(web('manifest.json'), { sites: { linked: entry }, starting: { pending: { repo: pendingRepo } }, closed: { saved: { site: structuredClone(entry) } } });
  json(await cli(['join', '--name', 'linked', '--session', 's-linked', '--template', 'board', '--items', path.join(clone, 'cards.json')], { cwd: clone, entry: link }));
  const saved = manifest();
  const storedDir = path.join(link, 'test-board');
  const storedCmd = [saved.sites.linked.cmd[0], path.join(link, 'board', 'server.mjs'), storedDir];
  assert.deepEqual(saved.sites.linked.cmd, storedCmd);
  assert.deepEqual([saved.sites.linked.dir, saved.sites.linked.owner.repo, saved.starting.pending.repo], [storedDir, link, path.join(link, '.repos', 'owner', 'project')]);
  assert.deepEqual([saved.closed.saved.site.dir, saved.closed.saved.site.cmd, saved.closed.saved.site.owner.repo], [storedDir, [process.execPath, ...storedCmd.slice(1)], link]);
  assert.equal(read(path.join(storedDir, 'board.json')).items, path.join(link, 'cards.json'));
  const started = json(await cli(['start', 'linked', '--repo', clone], { entry: link }));
  assert.equal(started.repo, link);
  assert.equal(manifest().sites.linked.owner.repo, link);
  const hook = JSON.parse(calls().at(-1).argv[calls().at(-1).argv.indexOf('--settings') + 1]).hooks.PermissionRequest[0].hooks[0];
  assert.equal(hook.command, `"${nodeBin()}" "${path.join(link, 'hub', 'permission-hook.mjs')}"`);
  const resumed = json(await cli(['resume', 'linked'], { entry: link }));
  assert.equal(resumed.repo, link);
  assert.ok(calls().at(-1).argv.at(-1).startsWith("/kickflip board 'linked'\n"));
  const moved = clone + '-moved';
  fs.renameSync(clone, moved);
  fs.unlinkSync(link);
  fs.symlinkSync(moved, link);
  assert.ok(fs.statSync(saved.sites.linked.cmd[1]).isFile());
  json(await cli(['join', '--name', 'linked', '--session', resumed.session, '--template', 'board'], { cwd: moved, entry: link }));
  assert.deepEqual(manifest().sites.linked.cmd, storedCmd);
});

test('a paused session wake holds only hub work events, then wakes for an owner or resumed usage', async () => {
  const dir = path.join(home, 'boards', 'paused');
  const file = path.join(dir, 'data', 'events.jsonl');
  write(path.join(dir, 'board.json'), { title: 'Paused' });
  write(file, '');
  write(path.join(dir, 'data', '.watch-cursor-paused.json'), { 'data/events.jsonl': 0 });
  const m = { sites: { paused: { dir, cmd: boardCmd(dir), watch: ['data/events.jsonl'], owner: { session: 'paused', repo, since: new Date(0).toISOString() } } } };
  const resumed = [];
  const check = (state = 'paused') => checkSessions({ manifest: m, now: new Date(), live: () => new Map(), listening: () => false, gateOf: (board) => { assert.equal(board.dir, dir, "each board's own gate, which reads its own pause"); return { state }; }, resume: async (route) => resumed.push(route), push: async () => assert.fail('no push expected') });
  await check();
  for (const kind of ['github-change', 'check-github', 'card-unblocked']) fs.appendFileSync(file, JSON.stringify({ kind, ts: new Date().toISOString() }) + '\n');
  await check();
  assert.deepEqual(resumed, []);
  assert.equal(read(web('resume-state.json')).paused.resumed_at, undefined);
  fs.appendFileSync(file, JSON.stringify({ kind: 'item-message', ts: new Date().toISOString() }) + '\n');
  await check();
  assert.deepEqual(resumed, ['paused']);
  fs.rmSync(web('resume-state.json'));
  write(file, JSON.stringify({ kind: 'github-change', ts: new Date().toISOString() }) + '\n');
  await check();
  fs.appendFileSync(file, JSON.stringify({ kind: 'usage-resumed', ts: new Date().toISOString() }) + '\n');
  await check('normal');
  assert.deepEqual(resumed, ['paused', 'paused']);
});

test('export bundles a board with its portable entry fields and the three hub settings once no builder is open, and import adds it to another host once with the join line that takes it over', async () => {
  const dir = path.join(home, 'boards', 'moving');
  const agent = path.join(dir, 'data', 'agents', 'M1.json');
  write(path.join(dir, 'board.json'), { title: 'Moving', items: 'data/items.json' });
  write(path.join(dir, 'data', 'items.json'), { title: 'Moving', items: [{ id: 'M1', title: 'One' }] });
  write(agent, { label: 'Builder', started: '2026-11-01T00:00:00Z' });
  write(path.join(dir, 'data', 'threads', 'moving__M1.jsonl'), '{"text":"hi"}\n');
  write(path.join(dir, 'data', '.watch-cursor-s-moving.json'), { 'data/events.jsonl': 3 });
  write(path.join(dir, 'data', 'watcher.json'), { pid: 1 });
  write(path.join(dir, 'public', 'prototype-x.html'), '<p>x</p>');
  const entry = { watch: ['data/events.jsonl'], created: '2026-10-29T00:00:00.000Z', title: 'Moving', description: 'Moves', icon: 'server', color: '#f97316', hub: true, github: 'o/r', branch: 'main' };
  write(web('manifest.json'), { sites: { moving: { dir, port: 4999, cmd: boardCmd(dir), ...entry, owner: { session: 's-moving', label: "Love's board", model: 'opus', since: '2026-10-29T00:00:00.000Z', repo }, updated: '2026-11-01T00:00:00.000Z', restart_at: 1 } } });
  const carried = { notifications: { on: true, weekends_off: true, snoozed_until: null }, quiet: { start: '23:00', end: '07:00', hold: true }, codexShare: 'off' };
  write(web('settings.json'), { ...carried, rules: [{ id: 'r1', text: 'Old rule' }], pauseAt: 80, keepGoing: { until: 'x' } });
  for (const f of ['secrets.json', 'slack.json']) write(web(f), { key: 'secret' });
  const file = path.join(home, 'moving.tgz');

  const open = await cli(['export', 'moving', '--out', file]);
  assert.equal(open.status, 1);
  assert.match(open.stderr, /a builder is open on \/moving: items\/M1 \(Builder\)/);
  assert.equal(fs.existsSync(file), false);
  write(agent, { label: 'Builder', started: '2026-11-01T00:00:00Z', done: '2026-11-01T01:00:00Z' });
  assert.deepEqual(json(await cli(['export', 'moving', '--out', file])), {
    route: 'moving', file, entry: ['title', 'description', 'icon', 'color', 'created', 'watch', 'hub', 'github', 'branch'],
    dropped: ['dir', 'port', 'cmd', 'owner', 'updated', 'restart_at'], settings: ['notifications', 'quiet', 'codexShare'],
  });
  const listed = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n').filter((l) => !l.endsWith('/')).sort();
  assert.deepEqual(listed, ['README.md', 'export.json', 'site/board.json', 'site/data/agents/M1.json', 'site/data/items.json', 'site/data/threads/moving__M1.jsonl', 'site/public/prototype-x.html'].map((f) => `kickflip-board/${f}`));
  assert.equal((await cli(['export', 'moving', '--out', file])).status, 2);

  const other = path.join(home, 'new-mac');
  const otherWeb = (...p) => path.join(other, '.claude', 'kickflip', ...p);
  const mine = path.join(other, 'mine');
  write(otherWeb('manifest.json'), { sites: { mine: { dir: mine, port: 4600, cmd: boardCmd(mine), hub: true } } });
  write(otherWeb('settings.json'), { codexShare: 'auto', rules: [{ id: 'r2', text: 'New rule' }], pauseAt: 70 });
  const imported = json(await cli(['import', file], { env: { HOME: other } }));
  const moved = otherWeb('sites', 'moving');
  const site = read(otherWeb('manifest.json')).sites.moving;
  assert.deepEqual(imported, { route: 'moving', dir: moved, port: site.port, settings: ['notifications', 'quiet', 'codexShare'], hub: false, join: "kickflip board Moving --session <this session's id> --label 'Love'\\''s board' --force" });
  const { hub, ...portable } = entry;
  assert.deepEqual(site, { ...portable, dir: moved, port: site.port, cmd: [nodeBin(), path.join(SKILL, 'board', 'server.mjs'), moved], updated: site.updated });
  assert.notEqual(site.port, 4600);
  assert.deepEqual(read(otherWeb('settings.json')), { ...carried, rules: [{ id: 'r2', text: 'New rule' }], pauseAt: 70 });
  assert.equal(fs.readFileSync(path.join(moved, 'data', 'threads', 'moving__M1.jsonl'), 'utf8'), '{"text":"hi"}\n');
  assert.deepEqual(fs.readdirSync(otherWeb()).sort(), ['manifest.json', 'settings.json', 'sites']);

  const again = await cli(['import', file], { env: { HOME: other } });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /\/moving already exists on this host/);
});
