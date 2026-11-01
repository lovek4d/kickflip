import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installLinks, installClaudeSettings, uninstallStatusLine, storedPath } from './install.mjs';
import { cloneRoot } from '../shared/repos.mjs';

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
const targets = () => [root, path.join(skills, 'join-web-ts', 'hooks-plugin'), path.join(skills, 'join-web-ts', 'bin', 'statusline.mjs')];
const skillLinks = () => ['join-web-ts', 'web-ts-hooks'].map((name) => path.join(skills, name));
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
  assert.deepEqual(install({ skillsDir }).map(({ link }) => link), [...['join-web-ts', 'web-ts-hooks'].map((name) => path.join(skillsDir, name)), statusline()]);
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
  const installedRoot = path.join(skills, 'join-web-ts');
  fs.mkdirSync(path.join(installedRoot, 'hooks-plugin'), { recursive: true });
  fs.mkdirSync(path.join(installedRoot, 'bin'));
  fs.copyFileSync(path.join(root, 'bin', 'statusline.mjs'), path.join(installedRoot, 'bin', 'statusline.mjs'));
  const result = install({ cloneRoot: installedRoot });
  assert.equal(result[0].created, false);
  assert.equal(fs.lstatSync(installedRoot).isSymbolicLink(), false);
  assert.equal(fs.realpathSync(path.join(skills, 'web-ts-hooks')), path.join(installedRoot, 'hooks-plugin'));
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
  const proto = path.join(home, '.claude', 'web-ts', 'sites', 'hub', 'statusline-proto.sh');
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
  assert.match(plugin.hooks.SubagentStop[0].hooks[0].command, /join-web-ts\/board\/bin\/builder-stop-hook.mjs/);
  assert.equal(plugin.hooks.SubagentStop[0].hooks[0].async, true);
  const hubSettings = path.join(home, '.claude', 'web-ts', 'settings.json');
  fs.mkdirSync(path.dirname(hubSettings), { recursive: true });
  for (const event of ['UserPromptSubmit', 'SessionStart']) {
    const { command } = plugin.hooks[event][0].hooks[0];
    assert.match(command, /\$HOME\/\.claude\/skills\/join-web-ts\//);
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

test('install checks the hooks source before creating links', () => {
  fs.rmdirSync(path.join(root, 'hooks-plugin'));
  assert.throws(() => install(), /not a directory/);
  assert.equal(fs.existsSync(skills), false);
});

test('the install command refuses conflicting links before touching launchd or hub state', () => {
  fs.mkdirSync(skills, { recursive: true });
  const link = path.join(skills, 'join-web-ts');
  fs.symlinkSync(root, link);
  const result = spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'web-ts.mjs'), 'install', '--force'], {
    env: { ...process.env, HOME: home, PATH: path.join(home, 'no-bin') }, encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /^web-ts: refusing to replace link/);
  assert.equal(fs.readlinkSync(link), root);
  assert.equal(fs.existsSync(path.join(home, 'Library')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'web-ts')), false);
});

test('the install command configures links and settings before launchd and reports reruns', () => {
  // An empty PATH prevents launchctl and tailscale from running. Install stops at bootstrap,
  // before its first connection attempt, after making the setup we want to inspect.
  fs.mkdirSync(path.dirname(statusline()), { recursive: true });
  fs.symlinkSync(path.join(home, 'old-dotfiles-statusline'), statusline());
  writeSettings({ keep: 'untouched', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/no-paths.py' }] }] } });
  const run = () => spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'web-ts.mjs'), 'install'], {
    env: { ...process.env, HOME: home, PATH: path.join(home, 'no-bin'), WEB_TS_HUB_PORT: '1' }, encoding: 'utf8',
  });
  const first = run();
  assert.equal(first.status, 1);
  assert.match(first.stderr, /spawnSync launchctl ENOENT/);
  assert.match(first.stdout, /linked .*skills\/join-web-ts/);
  assert.match(first.stdout, /linked .*skills\/web-ts-hooks/);
  assert.match(first.stdout, /linked .*statusline.sh -> .*skills\/join-web-ts\/bin\/statusline.mjs/);
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
  const result = spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'web-ts.mjs'), 'uninstall'], {
    env: { ...process.env, HOME: home, PATH: path.join(home, 'no-bin'), WEB_TS_HUB_PORT: '1' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith(`removed ${statusline()}\n`));
  assert.equal(fs.existsSync(statusline()), false);
  assert.ok(skillLinks().every((link) => fs.existsSync(link)));
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before);
});
