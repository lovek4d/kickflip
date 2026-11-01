import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runInstall, installLinks, installClaudeSettings, installLoginItem, migrateHome, uninstallStatusLine, storedPath } from './install.mjs';
import { cloneRoot } from '../shared/repos.mjs';
import { freePorts } from '../shared/test-helpers.mjs';
import { boardAt } from '../hub/boards.mjs';
import { doctorReport, doctorLines, runDoctor } from './doctor.mjs';

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

test('plugin keeps builder-stop and runs the Codex share hook for both events through the skills link, Off while Codex is not usable and Auto when unset', () => {
  installLinks({ home, cloneRoot: cloneRoot() });
  const plugin = JSON.parse(fs.readFileSync(path.join(cloneRoot(), 'hooks-plugin', 'hooks', 'hooks.json'), 'utf8'));
  assert.match(plugin.hooks.SubagentStop[0].hooks[0].command, /kickflip\/board\/bin\/builder-stop-hook.mjs/);
  assert.equal(plugin.hooks.SubagentStop[0].hooks[0].async, true);
  const hubSettings = path.join(home, '.claude', 'kickflip', 'settings.json');
  fs.mkdirSync(path.dirname(hubSettings), { recursive: true });
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const auth = path.join(home, '.codex', 'auth.json');
  const said = { auto: /Opus builders take over until it resets/, always: /pause that work until the usage-reset probe answers/ };
  for (const event of ['UserPromptSubmit', 'SessionStart']) {
    const { command } = plugin.hooks[event][0].hooks[0];
    assert.match(command, /\$HOME\/\.claude\/skills\/kickflip\//);
    for (const usable of ['not installed', 'not logged in', 'usable']) {
      fs.rmSync(path.join(bin, 'codex'), { force: true });
      fs.rmSync(path.dirname(auth), { recursive: true, force: true });
      if (usable !== 'not installed') fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      if (usable === 'usable') { fs.mkdirSync(path.dirname(auth)); fs.writeFileSync(auth, '{}'); }
      for (const mode of [undefined, 'auto', 'always', 'off', 'unknown', 'broken']) {
        if (mode === undefined) fs.rmSync(hubSettings, { force: true });
        else fs.writeFileSync(hubSettings, mode === 'broken' ? '{' : JSON.stringify({ codexShare: mode }));
        const result = spawnSync('/bin/sh', ['-c', command], { input: '{}', env: { ...process.env, HOME: home, PATH: bin }, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        const share = usable !== 'usable' || mode === 'off' ? 'off' : mode === 'always' ? 'always' : 'auto';
        if (share === 'off') assert.equal(result.stdout, '', `${usable} ${mode}`);
        else {
          assert.equal(result.stdout.split('\n').length, 2);
          assert.match(result.stdout, /unless this session's codex-share-mode file says otherwise/);
          assert.match(result.stdout, said[share], `${usable} ${mode}`);
        }
      }
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
    env: { ...process.env, HOME: home, KICKFLIP_CLAUDE: '/usr/bin/false', PATH: path.join(home, 'no-bin'), KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8',
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
    env: { ...process.env, HOME: home, KICKFLIP_CLAUDE: '/usr/bin/false', PATH: path.join(home, 'no-bin'), KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /^kickflip: refusing to replace link/);
  assert.equal(fs.readlinkSync(link), root);
  assert.equal(fs.existsSync(path.join(home, 'Library')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'kickflip')), false);
});

test('the install command configures links and settings before launchd and reports reruns', () => {
  fs.mkdirSync(path.dirname(statusline()), { recursive: true });
  fs.symlinkSync(path.join(home, 'old-dotfiles-statusline'), statusline());
  writeSettings({ keep: 'untouched', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/no-paths.py' }] }] } });
  const run = () => spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'kickflip.mjs'), 'install'], {
    env: { ...process.env, HOME: home, KICKFLIP_CLAUDE: '/usr/bin/false', PATH: path.join(home, 'no-bin'), KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8',
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
  assert.doesNotMatch(second.stdout, /^(?:linked |set statusLine|removed stale)/m);
  assert.equal(fs.statSync(settingsFile()).ino, inode);
});

test('the uninstall command removes the owned status-line link and preserves skill links and settings', () => {
  installLinks({ home, cloneRoot: cloneRoot() });
  configure();
  const before = fs.readFileSync(settingsFile(), 'utf8');
  const result = spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'kickflip.mjs'), 'uninstall'], {
    env: { ...process.env, HOME: home, KICKFLIP_CLAUDE: '/usr/bin/false', PATH: path.join(home, 'no-bin'), KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith(`removed ${statusline()}\n`));
  assert.equal(fs.existsSync(statusline()), false);
  assert.ok(skillLinks().every((link) => fs.existsSync(link)));
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before);
});

function healthyDoctor() {
  install();
  configure();
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
  const plist = path.join(home, 'Library', 'LaunchAgents', 'local.claude.kickflip-hub.plist');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, 'plist');
  const port = 19460;
  const site = { route: 'shop', state: 'up', port: 19461, owner: { label: 'Shop owner', session: 's-shop' }, title: 'Shop board' };
  const responses = new Map([
    ['git --version', 'git version 2.50.0'],
    ['node --version', 'v24.0.0'],
    ['gh --version', 'gh version 2.80.0'],
    ['gh auth status', 'Logged in'],
    ['tailscale version', '1.90.0'],
    ['tailscale status --json', JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tail.ts.net.' } })],
    ['tailscale serve status --json', JSON.stringify({ Web: { 'mac.tail.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } })],
    ['launchctl print gui/501/local.claude.kickflip-hub', 'state = running'],
  ].map(([key, stdout]) => [key, { status: 0, stdout }]));
  const calls = [];
  const env = { PATH: path.join(home, 'doctor-bin'), HOME: home, KICKFLIP_CLAUDE: '/usr/bin/false' };
  fs.mkdirSync(env.PATH);
  fs.writeFileSync(path.join(env.PATH, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const options = { home, cloneRoot: root, port, uid: 501, env,
    run: (command, argv, passed) => {
      assert.equal(passed.env, env);
      const key = [command, ...argv].join(' ');
      calls.push(key);
      assert.ok(responses.has(key), key);
      return responses.get(key);
    },
    fetch: async (url) => {
      assert.equal(url, `http://127.0.0.1:${port}/_hub/status.json`);
      return { ok: true, json: async () => ({ sites: [site] }) };
    },
  };
  return { options, responses, calls, plist, site };
}

const pick = (items, name) => items.find((entry) => entry.item === name);

test('doctor reports every healthy item and the old hub, Tailscale and site details without running login tools', async () => {
  const { options, calls } = healthyDoctor();
  const items = await doctorReport(options);
  assert.deepEqual(items.map(({ group, item }) => `${group} ${item}`), [
    'prereqs git', 'prereqs node on Claude’s PATH', 'prereqs gh', 'prereqs gh signed in', 'prereqs Tailscale', 'prereqs Tailscale signed in', 'prereqs Codex',
    'setup kickflip skill link', 'setup kickflip-hooks link', 'setup ~/.claude/statusline.sh', 'setup settings.json statusLine', 'setup hub login item',
    'hub hub', 'hub tailscale /', 'hub /shop',
  ]);
  assert.ok(items.every((item) => item.state === 'ok' && item.fix === null));
  assert.deepEqual(doctorLines(items).slice(-3), [
    'ok       hub: running on 127.0.0.1:19460',
    'ok       tailscale /: http://127.0.0.1:19460',
    'ok       /shop: up  port 19461  owner Shop owner  Shop board',
  ]);
  assert.ok(calls.includes('gh auth status'));
  assert.ok(!calls.some((call) => /^(?:codex|claude) | login$| bootstrap | bootout /.test(call)));
  assert.deepEqual(await runDoctor({ ...options, write: () => {} }), { items, exitCode: 0 });
});

for (const name of ['kickflip skill link', 'kickflip-hooks link', '~/.claude/statusline.sh', 'settings.json statusLine', 'hub login item', 'hub', 'tailscale /']) {
  test(`doctor marks ${name} fixable and gives the shared fix command`, async () => {
    const { options, responses, plist } = healthyDoctor();
    if (name === 'kickflip skill link') fs.unlinkSync(skillLinks()[0]);
    if (name === 'kickflip-hooks link') fs.unlinkSync(skillLinks()[1]);
    if (name === '~/.claude/statusline.sh') fs.unlinkSync(statusline());
    if (name === 'settings.json statusLine') fs.unlinkSync(settingsFile());
    if (name === 'hub login item') fs.unlinkSync(plist);
    if (name === 'hub') options.fetch = async () => { throw new Error('offline'); };
    if (name === 'tailscale /') responses.set('tailscale serve status --json', { status: 0, stdout: '{}' });
    const { items, exitCode } = await runDoctor({ ...options, write: () => {} });
    const item = pick(items, name);
    assert.equal(item.state, 'fixable');
    assert.equal(exitCode, 1);
    const lines = doctorLines([item]);
    assert.ok(lines[0].startsWith(`fixable  ${name}: `));
    assert.equal(lines[1], '         → kickflip doctor --fix');
  });
}

for (const [name, command, fix] of [
  ['git', 'git --version', 'xcode-select --install'],
  ['node on Claude’s PATH', 'node --version', 'restart Claude Code'],
  ['gh', 'gh --version', 'brew install gh'],
  ['gh signed in', 'gh auth status', 'gh auth login'],
  ['Tailscale', 'tailscale version', 'brew install --cask tailscale'],
  ['Tailscale signed in', 'tailscale status --json', 'tailscale up'],
]) {
  test(`doctor marks ${name} yours and gives the person's command`, async () => {
    const { options, responses } = healthyDoctor();
    responses.set(command, { status: 1, stdout: '', error: 'unavailable' });
    const { items, exitCode } = await runDoctor({ ...options, write: () => {} });
    const item = pick(items, name);
    assert.equal(item.state, 'yours');
    assert.ok(item.fix.includes(fix));
    if (name === 'node on Claude’s PATH') assert.match(item.detail, /\/doctor-bin/);
    assert.equal(exitCode, 1);
    const lines = doctorLines([item]);
    assert.ok(lines[0].startsWith(`yours    ${name}: `));
    assert.equal(lines[1], `         → ${item.fix}`);
  });
}

test('doctor marks Codex optional while it is not installed or not logged in, with the command for each, and still exits 0', async () => {
  const { options } = healthyDoctor();
  fs.unlinkSync(path.join(home, '.codex', 'auth.json'));
  for (const [detail, fix] of [['not logged in', 'codex login'], ['not installed', 'brew install --cask codex']]) {
    if (fix !== 'codex login') fs.unlinkSync(path.join(options.env.PATH, 'codex'));
    const { items, exitCode } = await runDoctor({ ...options, write: () => {} });
    const item = pick(items, 'Codex');
    assert.deepEqual([item.state, item.detail, item.fix, exitCode], ['optional', `${detail}; Codex builds and reviews need it`, fix, 0]);
    assert.deepEqual(doctorLines([item]), [`optional Codex: ${item.detail}`, `         → ${fix}`]);
  }
});

test('doctor reports foreign status-line files, links and choices as yours, preserving them', async () => {
  const { options } = healthyDoctor();
  const foreign = path.join(home, 'other-statusline');
  fs.writeFileSync(foreign, 'keep');
  for (const isLink of [false, true]) {
    fs.unlinkSync(statusline());
    if (isLink) fs.symlinkSync(foreign, statusline());
    else fs.writeFileSync(statusline(), 'keep');
    const item = pick(await doctorReport(options), '~/.claude/statusline.sh');
    assert.equal(item.state, 'yours');
    assert.match(item.detail, isLink ? /^links to .*other-statusline, not kickflip$/ : /^a real file, not kickflip’s link$/);
    assert.ok(item.fix.startsWith(isLink ? 'rm ' : 'mv '));
    assert.match(item.fix, /kickflip doctor --fix$/);
    assert.equal(fs.readFileSync(statusline(), 'utf8'), 'keep');
    assert.throws(() => install(), /refusing to replace/);
  }
  writeSettings({ statusLine: { type: 'command', command: 'other-tool' }, keep: 1 });
  const before = fs.readFileSync(settingsFile(), 'utf8');
  const item = pick(await doctorReport(options), 'settings.json statusLine');
  assert.equal(item.state, 'yours');
  assert.match(item.fix, /remove statusLine from.*settings.json.*doctor --fix/);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before);
});

test('doctor agrees with install about foreign skill links and replaceable status lines', async () => {
  const { options } = healthyDoctor();
  for (const [i, name] of ['kickflip skill link', 'kickflip-hooks link'].entries()) {
    const link = skillLinks()[i];
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(home, 'missing'), link);
    const item = pick(await doctorReport(options), name);
    assert.equal(item.state, 'yours');
    assert.match(item.fix, /^rm /);
    assert.throws(() => install(), /refusing to replace link/);
    fs.unlinkSync(link);
    fs.symlinkSync(targets()[i], link);
    install();
  }
  const proto = path.join(home, '.claude', 'kickflip', 'sites', 'hub', 'prototype.mjs');
  fs.mkdirSync(path.dirname(proto), { recursive: true });
  fs.writeFileSync(proto, 'prototype');
  for (const target of [proto, path.join(home, 'missing')]) {
    fs.unlinkSync(statusline());
    fs.symlinkSync(target, statusline());
    assert.equal(pick(await doctorReport(options), '~/.claude/statusline.sh').state, 'fixable');
    assert.equal(install()[2].replaced, true);
  }
});

test('doctor keeps reporting after bad settings, stopped login items, malformed Tailscale or a failed hub response', async () => {
  const { options, responses } = healthyDoctor();
  for (const value of ['{broken', 'null', '[]']) {
    fs.writeFileSync(settingsFile(), value);
    assert.equal(pick(await doctorReport(options), 'settings.json statusLine').state, 'yours');
  }
  for (const stdout of ['state = waiting', 'state = exited']) {
    responses.set('launchctl print gui/501/local.claude.kickflip-hub', { status: 0, stdout });
    assert.equal(pick(await doctorReport(options), 'hub login item').state, 'fixable');
  }
  responses.set('tailscale status --json', { status: 0, stdout: '{bad' });
  assert.equal(pick(await doctorReport(options), 'Tailscale signed in').state, 'yours');
  responses.set('tailscale status --json', { status: 1, stdout: JSON.stringify({ BackendState: 'Running' }) });
  assert.equal(pick(await doctorReport(options), 'Tailscale signed in').state, 'yours');
  for (const response of [{ ok: false, json: async () => ({ sites: [] }) }, { ok: true, json: async () => ({ unrelated: true }) }]) {
    options.fetch = async () => response;
    assert.equal(pick(await doctorReport(options), 'hub').state, 'fixable');
  }
});

test('doctor checks the root proxy destination, preserves other mount details and requires Tailscale sign-in first', async () => {
  const { options, responses } = healthyDoctor();
  for (const proxy of ['http://remote.example:19460', 'http://127.0.0.1:19460/wrong', 'http://127.0.0.1:19460/?wrong', 'http://127.0.0.1:4501']) {
    responses.set('tailscale serve status --json', { status: 0, stdout: JSON.stringify({ Web: { host: { Handlers: { '/': { Proxy: proxy }, '/old': { Proxy: 'http://127.0.0.1:19461' } } } } }) });
    const item = pick(await doctorReport(options), 'tailscale /');
    assert.equal(item.state, 'fixable');
    assert.match(item.detail, /other mounts: \/old/);
  }
  responses.set('tailscale status --json', { status: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }) });
  const item = pick(await doctorReport(options), 'tailscale /');
  assert.equal(item.state, 'yours');
  assert.equal(item.fix, 'tailscale up');
});

test('doctor notes a down site the running hub restarts, and marks sites fixable from the manifest while the hub is down', async () => {
  const { options, site } = healthyDoctor();
  site.state = 'down';
  site.owner = { session: 'session-fallback' };
  const report = await runDoctor({ ...options, write: () => {} });
  const down = pick(report.items, '/shop');
  assert.equal(down.state, 'note');
  assert.equal(down.fix, null);
  assert.equal(down.detail, 'down  port 19461  owner session-fallback  Shop board; the hub restarts it, see kickflip logs shop');
  assert.equal(report.exitCode, 0);
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: site } }));
  options.fetch = async () => { throw new Error('offline'); };
  const fallback = pick(await doctorReport(options), '/shop');
  assert.equal(fallback.state, 'fixable');
  assert.match(fallback.detail, /^hub not running/);
  fs.writeFileSync(manifest, '{bad');
  assert.equal(pick(await doctorReport(options), 'site manifest').state, 'yours');
});

test('doctor --json emits only {items} with the same exit codes', async () => {
  const { options } = healthyDoctor();
  const output = [];
  const ok = await runDoctor({ ...options, json: true, write: (line) => output.push(line) });
  assert.equal(output.length, 1);
  assert.deepEqual(JSON.parse(output[0]), { items: ok.items });
  assert.deepEqual(Object.keys(ok.items[0]), ['group', 'item', 'state', 'detail', 'fix']);
  assert.equal(ok.exitCode, 0);
  fs.unlinkSync(settingsFile());
  output.length = 0;
  const broken = await runDoctor({ ...options, json: true, write: (line) => output.push(line) });
  assert.deepEqual(JSON.parse(output[0]), { items: broken.items });
  assert.equal(broken.exitCode, 1);
});

test('doctor --fix invokes install once then prints its new report, even after an install failure', async () => {
  const { options } = healthyDoctor();
  fs.unlinkSync(statusline());
  const output = [];
  let count = 0;
  const installSteps = async (passed) => {
    assert.equal(passed.home, home);
    assert.equal(passed.dryRun, false);
    count++;
    install();
  };
  const result = await runDoctor({ ...options, fix: true, install: installSteps, write: (line) => output.push(line) });
  assert.equal(count, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(output.length, 1);
  assert.match(output[0], /^ok {7}~\/.claude\/statusline.sh: linked/m);
  const errors = [];
  const failed = await runDoctor({ ...options, fix: true, json: true, install: async () => { throw new Error('refused'); }, write: (line) => output.push(line), error: (line) => errors.push(line) });
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(errors, ['kickflip: refused']);
  assert.deepEqual(JSON.parse(output.at(-1)), { items: failed.items });
});

test('the shared install steps run migration, links, settings, launchd and Tailscale once with injected services', async () => {
  const state = oldShape(home, root);
  fs.writeFileSync(path.join(state, 'manifest.json'), JSON.stringify({ sites: { shop: { port: 19461 } } }));
  const calls = [];
  const waits = [];
  const logs = [];
  const port = 19460;
  await runInstall({ home, cloneRoot: root, port, uid: 501, wait: async (ms) => waits.push(ms), log: (line) => logs.push(line),
    fetch: async (url) => {
      assert.equal(url, `http://127.0.0.1:${port}/_hub/status.json`);
      return { ok: true, json: async () => ({ sites: [] }) };
    },
    run: (command, argv) => {
      calls.push([command, ...argv]);
      assert.equal(fs.lstatSync(state).isSymbolicLink(), true);
      assert.equal(fs.realpathSync(skillLinks()[0]), root);
      assert.equal(readSettings().statusLine.command, statusline());
      if (argv.join(' ') === 'serve status --json') return { status: 0, stdout: JSON.stringify({ Web: { host: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` }, '/shop/': {}, '/unrelated': {} } } } }) };
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, [
    ['launchctl', 'bootout', 'gui/501/local.claude.kickflip-hub'],
    ['launchctl', 'bootstrap', 'gui/501', path.join(home, 'Library', 'LaunchAgents', 'local.claude.kickflip-hub.plist')],
    ['tailscale', 'serve', '--bg', '19460'],
    ['tailscale', 'serve', 'status', '--json'],
    ['tailscale', 'serve', '--https=443', '--set-path=/shop/', 'off'],
  ]);
  assert.deepEqual(waits, [500, 300]);
  assert.equal(logs.filter((line) => line.startsWith('moved ')).length, 1);
  const plist = fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', 'local.claude.kickflip-hub.plist'), 'utf8');
  assert.ok(plist.includes(path.join(skills, 'kickflip', 'hub', 'hub.mjs')));
  assert.match(plist, /<key>KICKFLIP_HUB_PORT<\/key><string>19460<\/string>/);
});

test('doctor --fix --dry-run and install preview all steps without runners, network or HOME writes', async () => {
  oldShape(home, root);
  const before = fs.readdirSync(skills).sort();
  const output = [];
  const result = await runDoctor({ fix: true, dryRun: true, home, cloneRoot: root, port: 19460, write: (line) => output.push(line), run: () => assert.fail('ran command'), fetch: () => assert.fail('fetched'), wait: () => assert.fail('waited') });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(fs.readdirSync(skills).sort(), before);
  assert.ok(fs.lstatSync(path.join(home, '.claude', 'web-ts')).isDirectory());
  assert.equal(fs.existsSync(settingsFile()), false);
  assert.equal(fs.existsSync(path.join(home, 'Library')), false);
  assert.ok(output.some((line) => line.startsWith('would map tailscale /')));
});
