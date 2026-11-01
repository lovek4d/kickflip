import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { installLinks, installClaudeSettings, installLoginItem, migrateHome, uninstallStatusLine, storedPath } from './install.mjs';
import { cloneRoot } from '../shared/repos.mjs';
import { freePorts } from '../shared/test-helpers.mjs';
import { boardAt } from '../hub/boards.mjs';

let home;
let root;
let skills;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kickflip-install-')));
  root = path.join(home, 'dev', 'kickflip clone');
  skills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(root, 'hooks-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'statusline.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const install = (options = {}) => installLinks({ home, cloneRoot: root, ...options });
const targets = () => [root, path.join(skills, 'kickflip', 'hooks-plugin'), path.join(skills, 'kickflip', 'bin', 'statusline.mjs')];
const skillLinks = () => ['kickflip', 'kickflip-hooks'].map((name) => path.join(skills, name));
const statusline = () => path.join(home, '.claude', 'statusline.sh');
const links = () => [...skillLinks(), statusline()];
const settingsFile = () => path.join(home, '.claude', 'settings.json');
const writeSettings = (value) => {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(value, null, 2) + '\n');
};
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
const configure = () => installClaudeSettings({ home });

test('stored paths name the link for the clone and its descendants and preserve other paths', () => {
  install();
  const stored = (file) => storedPath(file, { home, cloneRoot: root });
  assert.equal(stored(root), links()[0]);
  assert.equal(stored(path.join(root, 'board', 'server.mjs')), path.join(links()[0], 'board', 'server.mjs'));
  assert.equal(stored(path.join(root, '.repos', 'owner', 'project')), path.join(links()[0], '.repos', 'owner', 'project'));
  for (const file of [home, root + '-other/server.mjs', links()[0], 'relative.mjs', 'node', '', undefined]) assert.equal(stored(file), file);
  assert.equal(storedPath(path.join(root, 'bin'), { cloneRoot: root, skillsDir: path.join(home, 'unlinked skills') }), path.join(root, 'bin'));
  assert.equal(storedPath(root, { cloneRoot: root, skillsDir: path.relative(process.cwd(), skills) }), links()[0]);
  const moved = root + '-moved';
  fs.renameSync(root, moved);
  fs.unlinkSync(links()[0]);
  fs.symlinkSync(moved, links()[0]);
  assert.equal(storedPath(path.join(moved, 'board', 'server.mjs'), { home, cloneRoot: moved }), path.join(links()[0], 'board', 'server.mjs'));
  assert.equal(fs.realpathSync(links()[1]), path.join(moved, 'hooks-plugin'));
});

test('install creates skill, plugin and executable status-line links in a fresh HOME and checks them on rerun', () => {
  const first = install();
  assert.deepEqual(first, links().map((link, i) => ({ link, target: targets()[i], created: true })));
  assert.deepEqual(links().map((link) => fs.readlinkSync(link)), targets());
  const before = links().map((link) => fs.lstatSync(link).ino);
  assert.deepEqual(install(), first.map((entry) => ({ ...entry, created: false })));
  assert.deepEqual(links().map((link) => fs.lstatSync(link).ino), before);
  assert.deepEqual(fs.readdirSync(home).sort(), ['.claude', 'dev']);
  fs.accessSync(statusline(), fs.constants.X_OK);
});

test('install accepts correct relative links and a clone root reached through a link', () => {
  fs.mkdirSync(skills, { recursive: true });
  links().forEach((link, i) => fs.symlinkSync(path.relative(path.dirname(link), targets()[i]), link));
  const alias = path.join(home, 'alias');
  fs.symlinkSync(root, alias);
  assert.ok(install({ cloneRoot: alias }).every(({ created }) => !created));
  assert.deepEqual(links().map((link) => fs.realpathSync(link)), [root, path.join(root, 'hooks-plugin'), path.join(root, 'bin', 'statusline.mjs')]);
  fs.unlinkSync(links()[1]);
  fs.symlinkSync(path.join(root, 'hooks-plugin'), links()[1]);
  assert.ok(install().every(({ created }) => !created));
  assert.equal(fs.readlinkSync(links()[1]), path.join(root, 'hooks-plugin'));
});

test('install accepts an injectable skills directory', () => {
  const skillsDir = path.join(home, 'custom skills');
  assert.deepEqual(install({ skillsDir }).map(({ link }) => link), [...['kickflip', 'kickflip-hooks'].map((name) => path.join(skillsDir, name)), statusline()]);
  assert.equal(fs.existsSync(skills), false);
});

test('install refuses a real directory or file at any destination before creating any link', () => {
  for (const link of links()) {
    for (const directory of [true, false]) {
      fs.mkdirSync(skills, { recursive: true });
      if (directory) fs.mkdirSync(link);
      else fs.writeFileSync(link, 'keep');
      assert.throws(() => install(), /refusing to replace real path/);
      assert.deepEqual(fs.readdirSync(skills), link === statusline() ? [] : [path.basename(link)]);
      if (!directory) assert.equal(fs.readFileSync(link, 'utf8'), 'keep');
      fs.rmSync(link, { recursive: true });
    }
  }
});

test('install leaves a real directory alone when it is the running clone itself', () => {
  const installedRoot = path.join(skills, 'kickflip');
  fs.mkdirSync(path.join(installedRoot, 'hooks-plugin'), { recursive: true });
  fs.mkdirSync(path.join(installedRoot, 'bin'));
  fs.copyFileSync(path.join(root, 'bin', 'statusline.mjs'), path.join(installedRoot, 'bin', 'statusline.mjs'));
  const result = install({ cloneRoot: installedRoot });
  assert.equal(result[0].created, false);
  assert.equal(fs.lstatSync(installedRoot).isSymbolicLink(), false);
  assert.equal(fs.realpathSync(path.join(skills, 'kickflip-hooks')), path.join(installedRoot, 'hooks-plugin'));
});

test('install refuses wrong and dangling links with instructions and preserves them', () => {
  fs.mkdirSync(skills, { recursive: true });
  const wrong = path.join(home, 'other clone');
  fs.mkdirSync(wrong);
  for (const target of [wrong, path.join(home, 'missing')]) {
    for (const link of skillLinks()) {
      fs.symlinkSync(target, link);
      assert.throws(() => install(), (error) => error.message.includes(`${link} -> ${target}`) && error.message.includes('remove that link explicitly'));
      assert.equal(fs.readlinkSync(link), target);
      assert.deepEqual(fs.readdirSync(skills), [path.basename(link)]);
      fs.unlinkSync(link);
    }
  }
});

test('install replaces a dangling dotfiles status line, a site prototype and a link directly to kickflip', () => {
  fs.mkdirSync(path.dirname(statusline()), { recursive: true });
  const proto = path.join(home, '.claude', 'kickflip', 'sites', 'hub', 'statusline-proto.sh');
  fs.mkdirSync(path.dirname(proto), { recursive: true });
  fs.writeFileSync(proto, '#!/bin/sh\n', { mode: 0o755 });
  for (const target of [path.join(home, 'dev', 'dotfiles', 'statusline.sh'), proto, path.join(root, 'bin', 'statusline.mjs')]) {
    fs.symlinkSync(target, statusline());
    assert.equal(install()[2].replaced, true);
    assert.equal(fs.readlinkSync(statusline()), targets()[2]);
    assert.equal(install()[2].replaced, undefined);
    fs.unlinkSync(statusline());
  }
});

test('install refuses another working status-line link before making skill links', () => {
  fs.mkdirSync(path.dirname(statusline()), { recursive: true });
  const other = path.join(home, 'other.mjs');
  fs.writeFileSync(other, 'keep');
  fs.symlinkSync(other, statusline());
  assert.throws(() => install(), /refusing to replace link.*statusline.sh/);
  assert.equal(fs.readlinkSync(statusline()), other);
  assert.equal(fs.existsSync(skills), false);
});

test('settings adds only statusLine, writes two-space JSON atomically and is unchanged on rerun', () => {
  const original = { permissions: { allow: ['Bash(node:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] }, enabledPlugins: { example: true } };
  writeSettings(original);
  const inode = fs.statSync(settingsFile()).ino;
  fs.chmodSync(settingsFile(), 0o640);
  assert.deepEqual(configure(), [`set statusLine in ${settingsFile()} -> ${statusline()}`]);
  const expected = { ...original, statusLine: { type: 'command', command: statusline() } };
  assert.deepEqual(readSettings(), expected);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), JSON.stringify(expected, null, 2) + '\n');
  assert.notEqual(fs.statSync(settingsFile()).ino, inode);
  assert.equal(fs.statSync(settingsFile()).mode & 0o777, 0o640);
  const stat = fs.statSync(settingsFile());
  assert.deepEqual(configure(), []);
  assert.equal(fs.statSync(settingsFile()).ino, stat.ino);
  assert.equal(fs.statSync(settingsFile()).mtimeMs, stat.mtimeMs);
  assert.deepEqual(fs.readdirSync(path.dirname(settingsFile())), ['settings.json']);
});

test('settings creates a missing file and leaves an existing statusLine untouched with a note', () => {
  configure();
  assert.deepEqual(readSettings(), { statusLine: { type: 'command', command: statusline() } });
  for (const statusLine of [{ type: 'command', command: 'my-status', padding: 2 }, null, false]) {
    writeSettings({ statusLine, keep: 1 });
    const before = fs.readFileSync(settingsFile(), 'utf8');
    assert.deepEqual(configure(), [`kept existing statusLine in ${settingsFile()}; it points elsewhere`]);
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before);
  }
});

test('settings preserves its existing statusLine options and recognizes home-based commands', () => {
  for (const command of [statusline(), '~/.claude/statusline.sh', '"$HOME/.claude/statusline.sh"', '"${HOME}/.claude/statusline.sh"']) {
    const original = { statusLine: { type: 'command', command, padding: 3, refreshInterval: 5 } };
    writeSettings(original);
    assert.deepEqual(configure(), []);
    assert.deepEqual(readSettings(), original);
  }
});

test('settings removes only stale no-paths commands and retains other hooks and group options', () => {
  const staleCommands = [`python3 "${path.join(home, '.claude', 'hooks', 'no-paths.py')}"`, 'python3 ~/.claude/hooks/no-paths.py', '"$HOME/.claude/hooks/no-paths.py"', 'python3 "${HOME}/.claude/hooks/no-paths.py"'];
  const keep = { type: 'command', command: '/somewhere-else/no-paths.py', timeout: 4 };
  const mentioned = { type: 'command', command: 'echo "~/.claude/hooks/no-paths.py"' };
  writeSettings({ statusLine: { type: 'command', command: statusline() }, keep: true, hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: staleCommands[0] }, keep, mentioned] },
      { matcher: 'Read', hooks: staleCommands.slice(1).map((command) => ({ type: 'command', command })) },
      { matcher: 'Write', hooks: [] }],
    Stop: [{ hooks: [{ type: 'command', command: 'cc-status' }] }],
  } });
  const notes = configure();
  assert.deepEqual(notes, staleCommands.map((command) => `removed stale hook PreToolUse: ${command}`));
  assert.deepEqual(readSettings().hooks, { PreToolUse: [{ matcher: 'Bash', hooks: [keep, mentioned] }, { matcher: 'Write', hooks: [] }], Stop: [{ hooks: [{ type: 'command', command: 'cc-status' }] }] });
  assert.equal(readSettings().keep, true);
  const before = fs.statSync(settingsFile());
  assert.deepEqual(configure(), []);
  assert.equal(fs.statSync(settingsFile()).ino, before.ino);
});

test('settings keeps no-paths when the script exists and refuses invalid JSON without overwriting', () => {
  fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'hooks', 'no-paths.py'), 'keep');
  const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/no-paths.py' }] }] };
  writeSettings({ hooks });
  configure();
  assert.deepEqual(readSettings().hooks, hooks);
  fs.writeFileSync(settingsFile(), '{broken');
  assert.throws(configure, SyntaxError);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), '{broken');
});

test('status-line command runs through the installed executable link even with spaces and quotes in HOME', () => {
  const specialHome = path.join(home, "space and ' quote");
  installLinks({ home: specialHome, cloneRoot: cloneRoot() });
  installClaudeSettings({ home: specialHome });
  const file = path.join(specialHome, '.claude', 'settings.json');
  const { statusLine } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = spawnSync('/bin/sh', ['-c', statusLine.command], { input: '{"model":{"display_name":"Opus"}}', env: { ...process.env, HOME: specialHome }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Opus\n');
  const stat = fs.statSync(file);
  assert.deepEqual(installClaudeSettings({ home: specialHome }), []);
  assert.equal(fs.statSync(file).ino, stat.ino);
});

test('uninstall removes only kickflip status-line links, including its dangling link, and keeps settings', () => {
  install();
  configure();
  const uninstall = () => uninstallStatusLine({ home, cloneRoot: root });
  assert.equal(uninstall(), true);
  assert.equal(uninstall(), false);
  assert.equal(fs.existsSync(settingsFile()), true);
  assert.ok(skillLinks().every((link) => fs.existsSync(link)));
  fs.symlinkSync(targets()[2], statusline());
  fs.unlinkSync(path.join(root, 'bin', 'statusline.mjs'));
  assert.equal(uninstall(), true);
  fs.symlinkSync(path.join(home, 'other-dangling'), statusline());
  assert.equal(uninstall(), false);
  fs.unlinkSync(statusline());
  fs.writeFileSync(statusline(), 'keep');
  assert.equal(uninstall(), false);
  assert.equal(fs.readFileSync(statusline(), 'utf8'), 'keep');
});

test('plugin keeps builder-stop and runs the Codex share hook for both events through the skills link', () => {
  installLinks({ home, cloneRoot: cloneRoot() });
  const plugin = JSON.parse(fs.readFileSync(path.join(cloneRoot(), 'hooks-plugin', 'hooks', 'hooks.json'), 'utf8'));
  assert.match(plugin.hooks.SubagentStop[0].hooks[0].command, /kickflip\/board\/bin\/builder-stop-hook.mjs/);
  assert.equal(plugin.hooks.SubagentStop[0].hooks[0].async, true);
  const hubSettings = path.join(home, '.claude', 'kickflip', 'settings.json');
  fs.mkdirSync(path.dirname(hubSettings), { recursive: true });
  for (const event of ['UserPromptSubmit', 'SessionStart']) {
    const { command } = plugin.hooks[event][0].hooks[0];
    assert.match(command, /\$HOME\/\.claude\/skills\/kickflip\//);
    for (const mode of [undefined, 'auto', 'always', 'off', 'unknown', 'broken']) {
      if (mode === undefined) fs.rmSync(hubSettings, { force: true });
      else fs.writeFileSync(hubSettings, mode === 'broken' ? '{' : JSON.stringify({ codexShare: mode }));
      const result = spawnSync('/bin/sh', ['-c', command], { input: '{}', env: { ...process.env, HOME: home }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      if (mode === 'auto' || mode === 'always') {
        assert.equal(result.stdout.split('\n').length, 2);
        assert.match(result.stdout, /unless this session's codex-share-mode file says otherwise/);
        assert.match(result.stdout, mode === 'auto' ? /Opus builders take over until it resets/ : /pause that work until the usage-reset probe answers/);
      } else assert.equal(result.stdout, '');
    }
  }
});

function oldShape(h, clone = root) {
  const state = path.join(h, '.claude', 'web-ts');
  const sk = path.join(h, '.claude', 'skills');
  fs.mkdirSync(path.join(state, 'sites', 'demo', 'data'), { recursive: true });
  fs.mkdirSync(path.join(state, 'worktrees', 'INT-1'), { recursive: true });
  fs.writeFileSync(path.join(state, 'manifest.json'), JSON.stringify({ version: 1, sites: {}, closed: { demo: { site: { dir: path.join(state, 'sites', 'demo'), cmd: ['node', path.join(sk, 'join-web-ts', 'board', 'server.mjs')] } } } }));
  fs.writeFileSync(path.join(state, 'settings.json'), JSON.stringify({ codexShare: 'auto' }));
  fs.mkdirSync(sk, { recursive: true });
  fs.symlinkSync(clone, path.join(sk, 'join-web-ts'));
  fs.symlinkSync(path.join(sk, 'join-web-ts', 'hooks-plugin'), path.join(sk, 'web-ts-hooks'));
  fs.symlinkSync(path.join(sk, 'join-web-ts', 'bin', 'statusline.mjs'), path.join(h, '.claude', 'statusline.sh'));
  return state;
}

function assertMigrated(h, clone = root) {
  const sk = path.join(h, '.claude', 'skills');
  assert.equal(fs.readlinkSync(path.join(h, '.claude', 'web-ts')), 'kickflip');
  assert.equal(fs.lstatSync(path.join(h, '.claude', 'kickflip')).isDirectory(), true);
  assert.equal(fs.readlinkSync(path.join(sk, 'kickflip')), clone);
  assert.equal(fs.readlinkSync(path.join(sk, 'join-web-ts')), clone);
  assert.equal(fs.readlinkSync(path.join(sk, 'kickflip-hooks')), path.join(sk, 'kickflip', 'hooks-plugin'));
  assert.equal(fs.existsSync(path.join(sk, 'web-ts-hooks')), false);
  assert.equal(fs.readlinkSync(path.join(h, '.claude', 'statusline.sh')), path.join(sk, 'kickflip', 'bin', 'statusline.mjs'));
}

test('migration moves the web-ts state folder and links once, and every old path keeps working', () => {
  const state = oldShape(home);
  const moved = migrateHome({ home });
  assert.deepEqual(moved.conflicts, []);
  assert.equal(moved.steps.length, 5);
  assertMigrated(home);
  const kept = JSON.parse(fs.readFileSync(path.join(state, 'manifest.json'), 'utf8'));
  assert.deepEqual(kept, JSON.parse(fs.readFileSync(path.join(home, '.claude', 'kickflip', 'manifest.json'), 'utf8')));
  assert.equal(fs.realpathSync(kept.closed.demo.site.dir), path.join(home, '.claude', 'kickflip', 'sites', 'demo'));
  assert.equal(boardAt(path.join(home, '.claude', 'kickflip', 'sites', 'demo'), { sites: { demo: kept.closed.demo.site } })?.route, 'demo');
  assert.equal(fs.realpathSync(path.join(state, 'worktrees', 'INT-1')), path.join(home, '.claude', 'kickflip', 'worktrees', 'INT-1'));
  assert.deepEqual(migrateHome({ home }), { steps: [], conflicts: [] });
  assert.ok(installLinks({ home, cloneRoot: root }).every(({ created, replaced }) => !created && !replaced));
});

test('a migration dry run changes nothing, and a running site keeps writing through its open file', () => {
  const state = oldShape(home);
  const plan = migrateHome({ home, dryRun: true });
  assert.ok(plan.steps.every((step) => step.startsWith('would ')), plan.steps.join('\n'));
  assert.equal(plan.steps.length, 5);
  assert.equal(fs.lstatSync(state).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(skills).sort(), ['join-web-ts', 'web-ts-hooks']);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'kickflip')), false);
  const events = fs.openSync(path.join(state, 'sites', 'demo', 'data', 'events.jsonl'), 'a');
  migrateHome({ home });
  fs.writeSync(events, 'after the move\n');
  fs.closeSync(events);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'kickflip', 'sites', 'demo', 'data', 'events.jsonl'), 'utf8'), 'after the move\n');
});

test('migration leaves both state folders alone when both exist', () => {
  const state = oldShape(home);
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'));
  const { conflicts } = migrateHome({ home });
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /both folders/);
  assert.equal(fs.lstatSync(state).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude', 'kickflip')), []);
});

test('the login item replaces the old label, and puts the old one back when the new one does not start', async () => {
  const agents = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  const old = path.join(agents, 'local.claude.web-ts-hub.plist');
  const file = path.join(agents, 'local.claude.kickflip-hub.plist');
  fs.writeFileSync(old, 'old plist');
  const calls = [];
  const options = (bootstrap) => ({ plist: 'new plist', launchAgentsDir: agents, uid: 501, wait: async () => {}, run: (argv) => { calls.push(argv.join(' ')); return argv[0] === 'bootstrap' ? bootstrap(argv) : { status: 3, error: 'not loaded' }; } });
  assert.deepEqual(await installLoginItem({ ...options(() => ({ status: 0 })), dryRun: true }), [`would stop gui/501/local.claude.web-ts-hub and remove ${old}`, `would write ${file} and start gui/501/local.claude.kickflip-hub`]);
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readdirSync(agents), [path.basename(old)]);

  await assert.rejects(installLoginItem(options((argv) => (argv[2] === file ? { status: 5, error: 'Bootstrap failed: 5' } : { status: 0 }))), { message: 'Bootstrap failed: 5; restarted gui/501/local.claude.web-ts-hub from ' + old });
  assert.deepEqual(calls, ['bootout gui/501/local.claude.web-ts-hub', 'bootout gui/501/local.claude.kickflip-hub', `bootstrap gui/501 ${file}`, `bootstrap gui/501 ${old}`]);
  assert.deepEqual(fs.readdirSync(agents), [path.basename(old)]);
  assert.equal(fs.readFileSync(old, 'utf8'), 'old plist');

  calls.length = 0;
  assert.deepEqual(await installLoginItem(options(() => ({ status: 0 }))), [`stopped gui/501/local.claude.web-ts-hub and removed ${old}`, `started gui/501/local.claude.kickflip-hub from ${file}`]);
  assert.deepEqual(calls, ['bootout gui/501/local.claude.web-ts-hub', 'bootout gui/501/local.claude.kickflip-hub', `bootstrap gui/501 ${file}`]);
  assert.deepEqual(fs.readdirSync(agents), [path.basename(file)]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new plist');

  calls.length = 0;
  assert.deepEqual(await installLoginItem(options(() => ({ status: 0 }))), [`started gui/501/local.claude.kickflip-hub from ${file}`]);
  assert.deepEqual(calls, ['bootout gui/501/local.claude.kickflip-hub', `bootstrap gui/501 ${file}`]);
});

test('the install command moves an old-named Mac before launchd, and --dry-run changes nothing', () => {
  const state = oldShape(home, cloneRoot());
  const agents = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'local.claude.web-ts-hub.plist'), 'old plist');
  const run = (...flags) => spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'kickflip.mjs'), 'install', ...flags], {
    env: { ...process.env, HOME: home, PATH: path.join(home, 'no-bin'), KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8',
  });
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^would move .*\.claude\/web-ts -> .*\.claude\/kickflip/m);
  assert.match(dry.stdout, /^would stop gui\/\d+\/local\.claude\.web-ts-hub/m);
  assert.equal(fs.lstatSync(state).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(skills).sort(), ['join-web-ts', 'web-ts-hooks']);
  assert.deepEqual(fs.readdirSync(agents), ['local.claude.web-ts-hub.plist']);

  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /spawnSync launchctl ENOENT; could not restart gui\/\d+\/local\.claude\.web-ts-hub/);
  assert.match(result.stdout, /^moved .*\.claude\/web-ts -> .*\.claude\/kickflip/m);
  assertMigrated(home, cloneRoot());
  assert.deepEqual(fs.readdirSync(agents), ['local.claude.web-ts-hub.plist']);
});

test('the hub, the board CLI and the status line each move an old-named HOME before touching state', async () => {
  const [port] = await freePorts();
  const run = (h, file, args, input = '') => spawnSync(process.execPath, [path.join(cloneRoot(), ...file), ...args], { env: { ...process.env, HOME: h, KICKFLIP_HUB_PORT: String(port), KICKFLIP_CLAUDE: '/usr/bin/false' }, input, encoding: 'utf8' });
  const homes = ['board', 'statusline', 'hub'].map((name) => path.join(home, name));
  for (const h of homes) oldShape(h, cloneRoot());

  assert.equal(run(homes[0], ['board', 'bin', 'board.mjs'], ['--help']).status, 0);
  assertMigrated(homes[0], cloneRoot());

  const line = run(homes[1], ['bin', 'statusline.mjs'], [], JSON.stringify({ model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 5 } } }));
  assert.equal(line.stdout, 'Opus  5h 5%\n');
  assertMigrated(homes[1], cloneRoot());
  assert.ok(fs.existsSync(path.join(homes[1], '.claude', 'kickflip', 'usage.json')));

  const hub = spawn(process.execPath, [path.join(cloneRoot(), 'hub', 'hub.mjs')], { env: { ...process.env, HOME: homes[2], KICKFLIP_HUB_PORT: String(port), KICKFLIP_CLAUDE: '/usr/bin/false' } });
  const exited = new Promise((resolve) => hub.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      let stdout = '';
      hub.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.includes('hub on')) resolve(); });
      hub.once('exit', (code) => reject(new Error(`hub exited ${code}`)));
    });
  } finally {
    hub.kill();
    await exited;
  }
  assertMigrated(homes[2], cloneRoot());
});

test('install checks the hooks source before creating links', () => {
  fs.rmdirSync(path.join(root, 'hooks-plugin'));
  assert.throws(() => install(), /not a directory/);
  assert.equal(fs.existsSync(skills), false);
});

test('the install command refuses conflicting links before touching launchd or hub state', () => {
  fs.mkdirSync(skills, { recursive: true });
  const link = path.join(skills, 'kickflip');
  fs.symlinkSync(root, link);
  const result = spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'kickflip.mjs'), 'install', '--force'], {
    env: { ...process.env, HOME: home, PATH: path.join(home, 'no-bin') }, encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /^kickflip: refusing to replace link/);
  assert.equal(fs.readlinkSync(link), root);
  assert.equal(fs.existsSync(path.join(home, 'Library')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'kickflip')), false);
});

test('the install command configures links and settings before launchd and reports reruns', () => {
  // An empty PATH prevents launchctl and tailscale from running. Install stops at bootstrap,
  // before its first connection attempt, after making the setup we want to inspect.
  fs.mkdirSync(path.dirname(statusline()), { recursive: true });
  fs.symlinkSync(path.join(home, 'old-dotfiles-statusline'), statusline());
  writeSettings({ keep: 'untouched', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/no-paths.py' }] }] } });
  const run = () => spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'kickflip.mjs'), 'install'], {
    env: { ...process.env, HOME: home, PATH: path.join(home, 'no-bin'), KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8',
  });
  const first = run();
  assert.equal(first.status, 1);
  assert.match(first.stderr, /spawnSync launchctl ENOENT/);
  assert.match(first.stdout, /linked .*skills\/kickflip/);
  assert.match(first.stdout, /linked .*skills\/kickflip-hooks/);
  assert.match(first.stdout, /linked .*statusline.sh -> .*skills\/kickflip\/bin\/statusline.mjs/);
  assert.match(first.stdout, /set statusLine in/);
  assert.match(first.stdout, /removed stale hook PreToolUse: python3 ~\/\.claude\/hooks\/no-paths.py/);
  assert.deepEqual(readSettings(), { keep: 'untouched', hooks: { PreToolUse: [] }, statusLine: { type: 'command', command: statusline() } });
  const inode = fs.statSync(settingsFile()).ino;
  const second = run();
  assert.equal(second.status, 1);
  assert.equal(second.stdout.split('\n').filter((line) => line.startsWith('checked ')).length, 3);
  assert.doesNotMatch(second.stdout, /linked |set statusLine|removed stale/);
  assert.equal(fs.statSync(settingsFile()).ino, inode);
});

test('the uninstall command removes the owned status-line link and preserves skill links and settings', () => {
  installLinks({ home, cloneRoot: cloneRoot() });
  configure();
  const before = fs.readFileSync(settingsFile(), 'utf8');
  const result = spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'kickflip.mjs'), 'uninstall'], {
    env: { ...process.env, HOME: home, PATH: path.join(home, 'no-bin'), KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith(`removed ${statusline()}\n`));
  assert.equal(fs.existsSync(statusline()), false);
  assert.ok(skillLinks().every((link) => fs.existsSync(link)));
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before);
});
