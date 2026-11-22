import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInstall, installLinks, installClaudeSettings, removeRetiredState, uninstallStatusLine, storedPath, nodeBin, WATCHER_STOP } from './install.mjs';
import { tailnetUrl } from '../shared/tailnet.mjs';
import { hubService } from '../shared/service.mjs';
import { cloneRoot } from '../shared/repos.mjs';
import { doctorReport, doctorLines, runDoctor } from './doctor.mjs';
import { tempDir } from '../shared/temp-dir.mjs';
import { DARWIN_SOCKET } from '../shared/tailscale.mjs';

const CLI = { kind: 'cli', cli: 'tailscale' };

let home;
let root;
let skills;
beforeEach(() => {
  home = fs.realpathSync(tempDir('kickflip-install-'));
  root = path.join(home, 'dev', 'kickflip clone');
  skills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(root, 'hooks-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'statusline.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
});

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
const watcherStop = { hooks: [{ type: 'command', command: WATCHER_STOP }] };
const addedStop = () => `added the watcher Stop hook to ${settingsFile()} -> ${WATCHER_STOP}`;
const autoCompact = () => `turned on autoCompactEnabled in ${settingsFile()}`;

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

test('settings adds only statusLine, the watcher Stop hook and autoCompactEnabled, writes two-space JSON atomically and is unchanged on rerun', () => {
  const original = { permissions: { allow: ['Bash(node:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] }, enabledPlugins: { example: true } };
  writeSettings(original);
  const inode = fs.statSync(settingsFile()).ino;
  fs.chmodSync(settingsFile(), 0o640);
  assert.deepEqual(configure(), [`set statusLine in ${settingsFile()} -> ${statusline()}`, addedStop(), autoCompact()]);
  const expected = { ...original, hooks: { Stop: [...original.hooks.Stop, watcherStop] }, statusLine: { type: 'command', command: statusline() }, autoCompactEnabled: true };
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
  assert.deepEqual(readSettings(), { statusLine: { type: 'command', command: statusline() }, hooks: { Stop: [watcherStop] }, autoCompactEnabled: true });
  for (const statusLine of [{ type: 'command', command: 'my-status', padding: 2 }, null, false]) {
    writeSettings({ statusLine, keep: 1, hooks: { Stop: [watcherStop] }, autoCompactEnabled: true });
    const before = fs.readFileSync(settingsFile(), 'utf8');
    assert.deepEqual(configure(), [`kept existing statusLine in ${settingsFile()}; it points elsewhere`]);
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before);
  }
});

test('settings turns autoCompactEnabled on when it is false or missing and leaves the rest of the file alone', () => {
  for (const autoCompactEnabled of [false, undefined, 'yes']) {
    writeSettings({ statusLine: { type: 'command', command: statusline() }, hooks: { Stop: [watcherStop] }, keep: 1, ...(autoCompactEnabled === undefined ? {} : { autoCompactEnabled }) });
    assert.deepEqual(configure(), [autoCompact()]);
    assert.deepEqual(readSettings(), { statusLine: { type: 'command', command: statusline() }, hooks: { Stop: [watcherStop] }, keep: 1, autoCompactEnabled: true });
    assert.deepEqual(configure(), []);
  }
});

test('settings preserves its existing statusLine options and recognizes home-based commands', () => {
  for (const command of [statusline(), '~/.claude/statusline.sh', '"$HOME/.claude/statusline.sh"', '"${HOME}/.claude/statusline.sh"']) {
    const original = { statusLine: { type: 'command', command, padding: 3, refreshInterval: 5 }, hooks: { Stop: [watcherStop] }, autoCompactEnabled: true };
    writeSettings(original);
    assert.deepEqual(configure(), []);
    assert.deepEqual(readSettings(), original);
  }
});

test('settings removes only stale no-paths commands and retains other hooks and group options', () => {
  const staleCommands = [`python3 "${path.join(home, '.claude', 'hooks', 'no-paths.py')}"`, 'python3 ~/.claude/hooks/no-paths.py', '"$HOME/.claude/hooks/no-paths.py"', 'python3 "${HOME}/.claude/hooks/no-paths.py"'];
  const keep = { type: 'command', command: '/somewhere-else/no-paths.py', timeout: 4 };
  const mentioned = { type: 'command', command: 'echo "~/.claude/hooks/no-paths.py"' };
  writeSettings({ statusLine: { type: 'command', command: statusline() }, keep: true, autoCompactEnabled: true, hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: staleCommands[0] }, keep, mentioned] },
      { matcher: 'Read', hooks: staleCommands.slice(1).map((command) => ({ type: 'command', command })) },
      { matcher: 'Write', hooks: [] }],
    Stop: [{ hooks: [{ type: 'command', command: 'cc-status' }, { type: 'command', command: 'node ~/.claude/skills/kickflip/hooks-plugin/hooks/watcher-stop.mjs', timeout: 5 }] }],
  } });
  const notes = configure();
  assert.deepEqual(notes, staleCommands.map((command) => `removed stale hook PreToolUse: ${command}`));
  assert.deepEqual(readSettings().hooks, { PreToolUse: [{ matcher: 'Bash', hooks: [keep, mentioned] }, { matcher: 'Write', hooks: [] }], Stop: [{ hooks: [{ type: 'command', command: 'cc-status' }, { type: 'command', command: 'node ~/.claude/skills/kickflip/hooks-plugin/hooks/watcher-stop.mjs', timeout: 5 }] }] });
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
  assert.deepEqual(readSettings().hooks, { ...hooks, Stop: [watcherStop] });
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

test('plugin keeps builder-stop and runs the Codex share hook for both events through the skills link, saying Off while Codex is not usable and Auto when unset', () => {
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
  const said = { auto: /builder pick <key>.*Opus builders take over until it resets/, always: /builder pick <key>.*pause that work until the usage-reset probe answers/ };
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
        if (share === 'off') assert.equal(result.stdout, "The hub's Codex setting is off: Claude builds and reviews, whatever an earlier turn said. Before each build, run `board.mjs builder pick <key>`; builder start refuses any other kind.\n", `${usable} ${mode}`);
        else {
          assert.equal(result.stdout.split('\n').length, 2);
          assert.match(result.stdout, share === 'auto' ? /^The hub's Codex setting is auto: run as codex-share auto\. / : /^The hub's Codex setting is always on: run as codex-share on\. /);
          assert.match(result.stdout, said[share], `${usable} ${mode}`);
        }
      }
    }
  }
});

test('the login item restarts under its label and reports when it does not start', async () => {
  const agents = path.join(home, 'Library', 'LaunchAgents');
  const file = path.join(agents, 'local.claude.kickflip-hub.plist');
  const calls = [];
  const installLoginItem = ({ run, wait, dryRun }) => hubService({ platform: 'darwin', home, uid: 501, run: (command, argv) => run(argv) }).install('new plist', { wait, dryRun });
  const options = (bootstrap) => ({ wait: async () => {}, run: (argv) => { calls.push(argv.join(' ')); return argv[0] === 'bootstrap' ? bootstrap(argv) : { status: 3, error: 'not loaded' }; } });
  assert.deepEqual(await installLoginItem({ ...options(() => ({ status: 0 })), dryRun: true }), [`would write ${file} and start gui/501/local.claude.kickflip-hub`]);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(agents), false);

  await assert.rejects(installLoginItem(options(() => ({ status: 5, error: 'Bootstrap failed: 5' }))), { message: 'Bootstrap failed: 5' });
  assert.deepEqual(calls, ['bootout gui/501/local.claude.kickflip-hub', `bootstrap gui/501 ${file}`]);

  calls.length = 0;
  assert.deepEqual(await installLoginItem(options(() => ({ status: 0 }))), [`started gui/501/local.claude.kickflip-hub from ${file}`]);
  assert.deepEqual(calls, ['bootout gui/501/local.claude.kickflip-hub', `bootstrap gui/501 ${file}`]);
  assert.deepEqual(fs.readdirSync(agents), [path.basename(file)]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new plist');
});

test('install checks the hooks source before creating links', () => {
  fs.rmdirSync(path.join(root, 'hooks-plugin'));
  assert.throws(() => install(), /not a directory/);
  assert.equal(fs.existsSync(skills), false);
});

test('the init command refuses conflicting links before touching launchd or hub state', () => {
  fs.mkdirSync(skills, { recursive: true });
  const link = path.join(skills, 'kickflip');
  fs.symlinkSync(root, link);
  const result = spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'kickflip.mjs'), 'init', '--force'], {
    env: { ...process.env, HOME: home, KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false', PATH: path.join(home, 'no-bin'), KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /^kickflip: refusing to replace link/);
  assert.equal(fs.readlinkSync(link), root);
  assert.equal(fs.existsSync(path.join(home, 'Library')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'kickflip')), false);
});

test('the init command configures links and settings before the hub service and reports reruns', () => {
  fs.mkdirSync(path.dirname(statusline()), { recursive: true });
  fs.symlinkSync(path.join(home, 'old-dotfiles-statusline'), statusline());
  writeSettings({ keep: 'untouched', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/no-paths.py' }] }] } });
  const run = () => spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'kickflip.mjs'), 'init'], {
    env: { ...process.env, HOME: home, KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false', PATH: path.join(home, 'no-bin'), KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8',
  });
  const first = run();
  assert.equal(first.status, 1);
  assert.match(first.stderr, process.platform === 'darwin' ? /spawnSync launchctl ENOENT/ : /systemctl --user daemon-reload: spawnSync systemctl ENOENT/);
  assert.match(first.stdout, /linked .*skills\/kickflip/);
  assert.match(first.stdout, /linked .*skills\/kickflip-hooks/);
  assert.match(first.stdout, /linked .*statusline.sh -> .*skills\/kickflip\/bin\/statusline.mjs/);
  assert.match(first.stdout, /set statusLine in/);
  assert.match(first.stdout, /removed stale hook PreToolUse: python3 ~\/\.claude\/hooks\/no-paths.py/);
  assert.match(first.stdout, /added the watcher Stop hook to/);
  assert.match(first.stdout, /turned on autoCompactEnabled in/);
  assert.deepEqual(readSettings(), { keep: 'untouched', hooks: { PreToolUse: [], Stop: [watcherStop] }, statusLine: { type: 'command', command: statusline() }, autoCompactEnabled: true });
  const inode = fs.statSync(settingsFile()).ino;
  const second = run();
  assert.equal(second.status, 1);
  assert.equal(second.stdout.split('\n').filter((line) => line.startsWith('checked ')).length, 3);
  assert.doesNotMatch(second.stdout, /^(?:linked |set statusLine|removed stale|added the watcher|turned on)/m);
  assert.equal(fs.statSync(settingsFile()).ino, inode);
});

test('the update command installs the latest package into the prefix that owns the install before restarting the hub, refuses a clone and an install outside a prefix', () => {
  const prefix = path.join(home, 'prefix');
  const root = path.join(prefix, 'lib', 'node_modules', '@lovek4d', 'kickflip');
  fs.mkdirSync(root, { recursive: true });
  for (const dir of ['bin', 'board', 'hub', 'shared', 'starter', 'hooks-plugin']) {
    fs.cpSync(path.join(cloneRoot(), dir), path.join(root, dir), { recursive: true, filter: (file) => !file.endsWith('.test.mjs') });
  }
  const tools = path.join(home, 'tools');
  const log = path.join(home, 'calls.log');
  const manager = process.platform === 'darwin' ? 'launchctl' : 'systemctl';
  fs.mkdirSync(tools);
  const stub = (name, extra = '') => fs.writeFileSync(path.join(tools, name), `#!/bin/sh\nprintf '%s\\n' '${name}'" $*" >> "$KICKFLIP_TEST_LOG"\n${extra}exit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.4.2"}');
  stub(manager);
  stub('npm', `printf '{"version":"0.4.3"}' > '${path.join(root, 'package.json')}'\n`);
  const kickflip = (folder, command, ...flags) => spawnSync(process.execPath, [path.join(folder, 'bin', 'kickflip.mjs'), command, ...flags], {
    env: { ...process.env, HOME: home, PATH: tools, KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false', KICKFLIP_TEST_LOG: log }, encoding: 'utf8',
  });
  const run = (folder) => kickflip(folder, 'update');
  const restartCall = process.platform === 'darwin' ? `launchctl kickstart -k gui/${process.getuid()}/local.claude.kickflip-hub` : 'systemctl --user restart kickflip-hub.service';
  const installed = run(root);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.stdout, '0.4.2 > 0.4.3\nrestarted the hub\n');
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
    `npm i -g --prefix ${prefix} @lovek4d/kickflip@latest`,
    restartCall,
  ]);
  fs.unlinkSync(log);
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.4.3"}');
  stub('npm', `printf '{"version":"0.4.4"}' > '${path.join(root, 'package.json')}'\n`);
  const pulled = kickflip(root, 'update', '--no-restart');
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.equal(pulled.stdout, '0.4.3 > 0.4.4\n');
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [`npm i -g --prefix ${prefix} @lovek4d/kickflip@latest`]);
  fs.unlinkSync(log);
  stub('npm');
  const unchanged = run(root);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(unchanged.stdout, 'no new version available\n');
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [`npm i -g --prefix ${prefix} @lovek4d/kickflip@latest`]);
  fs.unlinkSync(log);
  const restarted = kickflip(root, 'restart');
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(restarted.stdout, 'restarted the hub\n');
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [restartCall]);
  fs.unlinkSync(log);
  const stray = path.join(home, 'stray');
  fs.cpSync(root, stray, { recursive: true });
  const outside = run(stray);
  assert.equal(outside.status, 1, outside.stderr);
  assert.ok(outside.stderr.includes('the npm prefix that owns it is unknown'));
  assert.equal(fs.existsSync(log), false);
  const clone = run(cloneRoot());
  assert.equal(clone.status, 2, clone.stderr);
  assert.ok(clone.stderr.includes(`${cloneRoot()} is a clone; update it with git pull`));
  assert.equal(fs.existsSync(log), false);
});

test('the uninstall command removes the owned status-line link and preserves skill links and settings', () => {
  installLinks({ home, cloneRoot: cloneRoot() });
  configure();
  const before = fs.readFileSync(settingsFile(), 'utf8');
  const result = spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'kickflip.mjs'), 'uninstall'], {
    env: { ...process.env, HOME: home, KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false', PATH: path.join(home, 'no-bin'), KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith(`removed ${statusline()}\n`));
  assert.equal(fs.existsSync(statusline()), false);
  assert.ok(skillLinks().every((link) => fs.existsSync(link)));
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before);
});

test('uninstall unmaps / only on the recorded daemon, and leaves it mapped with the fault when another daemon answers', () => {
  const stub = path.join(home, 'ts-bin', 'tailscale');
  const log = path.join(home, 'ts-calls');
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> '${log}'\necho '{"BackendState":"Running","Self":{"ID":"nBrew","HostName":"brew-mac"}}'\n`, { mode: 0o755 });
  const record = (node) => {
    fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'settings.json'), JSON.stringify({ tailnet: true, tailscale: { kind: 'cli', cli: stub, node } }));
  };
  const uninstall = () => spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'kickflip.mjs'), 'uninstall'], {
    env: { ...process.env, HOME: home, KICKFLIP_TAILSCALE: '', KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false', PATH: path.join(home, 'no-bin'), KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8',
  });
  record('nApp');
  const refused = uninstall();
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.stdout, /; tailscale \/ left mapped: Tailscale's recorded daemon isn't running \(brew-mac answered in its place\); start it, or run kickflip doctor --fix to pick again\./);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['status --json']);
  fs.rmSync(log);
  record('nBrew');
  const unmapped = uninstall();
  assert.match(unmapped.stdout, /; tailscale \/ unmapped\./);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['status --json', 'serve --https=443 --set-path=/ off', 'serve status --json']);
});

const CLONE_CONFIG = '-c credential.helper= -c credential.https://github.com.helper=!gh auth git-credential';
const SKILLS_TREE = 'gh api repos/mattpocock/skills/git/trees/HEAD?recursive=1 --jq .tree[] | select(.type == "tree") | .path + " " + .sha';
const SKILL_FOLDERS = { 'improve-codebase-architecture': 'skills/engineering', 'codebase-design': 'skills/engineering', grilling: 'skills/productivity', prototype: 'skills/engineering' };
// Installs the review skills as the skills CLI does, a SKILL.md each and a lock entry with the folder's tree sha.
function reviewSkills(names = Object.keys(SKILL_FOLDERS)) {
  const lock = { version: 3, skills: {} };
  for (const name of names) {
    fs.mkdirSync(path.join(skills, name), { recursive: true });
    fs.writeFileSync(path.join(skills, name, 'SKILL.md'), `# ${name}\n`);
    lock.skills[name] = { source: 'mattpocock/skills', sourceType: 'github', skillPath: `${SKILL_FOLDERS[name]}/${name}/SKILL.md`, skillFolderHash: `sha-${name}` };
  }
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', '.skill-lock.json'), JSON.stringify(lock));
  return Object.keys(SKILL_FOLDERS).map((name) => `${SKILL_FOLDERS[name]}/${name} sha-${name}`).join('\n') + '\n';
}

function healthyDoctor() {
  install();
  configure();
  const tree = reviewSkills();
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
  const plist = path.join(home, 'Library', 'LaunchAgents', 'local.claude.kickflip-hub.plist');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, 'plist');
  const port = 19460;
  const site = { route: 'shop', state: 'up', port: 19461, owner: { label: 'Shop owner', session: 's-shop' }, title: 'Shop board' };
  const appRepo = path.join(home, 'dev', 'app');
  const boardCmd = ['node', path.join(root, 'board', 'server.mjs')];
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'manifest.json'), JSON.stringify({ sites: {
    app: { dir: path.join(home, 'sites', 'app'), cmd: boardCmd, github: 'owner/app', owner: { session: 's-app', repo: appRepo } },
    hub: { dir: path.join(home, 'sites', 'hub'), cmd: boardCmd, hub: true, owner: { session: 's-hub', repo: root } },
    page: { dir: path.join(home, 'sites', 'page'), owner: { repo: appRepo } },
  } }));
  const responses = new Map([
    [`git -C ${appRepo} ls-remote --exit-code origin HEAD`, `${'b'.repeat(40)}\tHEAD`],
    ['git --version', 'git version 2.50.0'],
    ['node --version', 'v24.0.0'],
    ['gh --version', 'gh version 2.80.0'],
    ['gh auth status', 'Logged in'],
    ['gh repo list --limit 1 --json nameWithOwner --jq .[0].nameWithOwner', 'owner/private\n'],
    [`git ${CLONE_CONFIG} ls-remote https://github.com/owner/private.git HEAD`, `${'a'.repeat(40)}\tHEAD`],
    ['tailscale version', '1.90.0'],
    ['tailscale status --json', JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tail.ts.net.' } })],
    ['tailscale serve status --json', JSON.stringify({ Web: { 'mac.tail.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } })],
    ['launchctl print gui/501/local.claude.kickflip-hub', 'state = running'],
    ['tmux -V', 'tmux 3.5a'],
    [SKILLS_TREE, tree],
    [`mdfind -onlyin ${path.join(home, '.claude')} kMDItemFSName == "manifest.json"`, path.join(home, '.claude', 'skills', 'other', 'manifest.json') + '\n'],
  ].map(([key, stdout]) => [key, { status: 0, stdout }]));
  const calls = [];
  const env = { PATH: path.join(home, 'doctor-bin'), HOME: home, KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false' };
  fs.mkdirSync(env.PATH);
  fs.writeFileSync(path.join(env.PATH, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const options = { home, cloneRoot: root, port, uid: 501, env, platform: 'darwin', tailnet: true, tailscale: CLI, others: [],
    run: (command, argv, passed) => {
      assert.deepEqual(passed.env, command === 'git' && argv.includes('ls-remote') ? { ...env, GIT_TERMINAL_PROMPT: '0' } : env);
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
  return { options, responses, calls, plist, site, appRepo };
}

const pick = (items, name) => items.find((entry) => entry.item === name);

test('doctor reports every healthy item and the old hub, Tailscale and site details without running login tools', async () => {
  const { options, calls, appRepo } = healthyDoctor();
  const items = await doctorReport(options);
  assert.deepEqual(items.map(({ group, item }) => `${group} ${item}`), [
    'prereqs git', 'prereqs node on Claude’s PATH', 'prereqs gh', 'prereqs gh signed in', 'prereqs GitHub clone', 'prereqs Tailscale', 'prereqs Tailscale signed in', 'prereqs tmux', 'prereqs Codex', 'prereqs mattpocock skills',
    'setup kickflip skill link', 'setup kickflip-hooks link', 'setup ~/.claude/statusline.sh', 'setup settings.json statusLine', 'setup settings.json watcher Stop hook', 'setup settings.json autoCompactEnabled', 'setup hub login item', 'setup Spotlight',
    'hub hub', 'hub tailscale /', 'hub try ports', 'hub /shop', 'hub /app repo',
  ]);
  assert.ok(items.every((item) => item.state === 'ok' && item.fix === null));
  assert.deepEqual(doctorLines(items).slice(-5), [
    'ok       hub: running on 127.0.0.1:19460',
    'ok       tailscale /: http://127.0.0.1:19460',
    'ok       try ports: none',
    'ok       /shop: up  port 19461  owner Shop owner  Shop board',
    `ok       /app repo: git reaches owner/app from ${appRepo}`,
  ]);
  assert.ok(calls.includes('gh auth status'));
  assert.equal(pick(items, 'mattpocock skills').detail, 'improve-codebase-architecture, codebase-design, grilling, prototype installed and current');
  assert.equal(pick(items, 'GitHub clone').detail, 'git reaches owner/private over https');
  assert.ok(!calls.some((call) => /^(?:codex|claude) | login$| bootstrap | bootout /.test(call)));
  assert.deepEqual(await runDoctor({ ...options, write: () => {} }), { items, exitCode: 0 });
});

test("doctor on macOS reads Spotlight as yours while it indexes kickflip's manifest, with the Privacy step; Linux has no item", async () => {
  const { options, responses } = healthyDoctor();
  const probe = `mdfind -onlyin ${path.join(home, '.claude')} kMDItemFSName == "manifest.json"`;
  assert.deepEqual(pick(await doctorReport(options), 'Spotlight'), { group: 'setup', item: 'Spotlight', state: 'ok', detail: 'skips ~/.claude/kickflip', fix: null });
  responses.set(probe, { status: 0, stdout: path.join(home, '.claude', 'kickflip', 'manifest.json') + '\n' });
  assert.deepEqual(pick(await doctorReport(options), 'Spotlight'), { group: 'setup', item: 'Spotlight', state: 'yours',
    detail: 'indexes ~/.claude/kickflip, so every builder worktree drives its CPU up; kickflip doctor --fix can’t change that',
    fix: 'System Settings › Spotlight › Search Privacy (or Spotlight › Privacy): add ~/.claude/kickflip' });
  assert.equal(pick(await doctorReport({ ...options, platform: 'linux' }), 'Spotlight'), undefined);
});

// Board clones in the old places: the running clone's .repos, and another clone's .repos a closed board recorded; one
// in the clone home and a folder that isn't a clone are not old clones.
function oldClones() {
  const doctor = healthyDoctor();
  const clone = (...parts) => { const dir = path.join(...parts); fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); return dir; };
  const used = clone(root, '.repos', 'owner', 'project');
  const remote = clone(root, '.repos', 'gitlab.com', 'group', 'sub', 'tool');
  const other = clone(home, 'old kickflip', '.repos', 'acme', 'app');
  clone(home, '.claude', 'kickflip', 'repos', 'owner', 'project');
  fs.mkdirSync(path.join(root, '.repos', 'owner', 'not-a-clone', 'src'), { recursive: true });
  const file = path.join(home, '.claude', 'kickflip', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.sites.page.owner.repo = path.join(skills, 'kickflip', '.repos', 'owner', 'project');
  manifest.closed = { gone: { site: { dir: path.join(home, 'sites', 'gone'), owner: { repo: other } } } };
  fs.writeFileSync(file, JSON.stringify(manifest));
  return { ...doctor, used, remote, other };
}

test('doctor lists each board clone in an old place that no board uses, without failing', async () => {
  const { options, remote } = oldClones();
  const { items, exitCode } = await runDoctor({ ...options, write: () => {} });
  const clones = path.join(home, '.claude', 'kickflip', 'repos');
  assert.deepEqual(items.filter((entry) => entry.item === 'old board clone'), [
    { group: 'hub', item: 'old board clone', state: 'optional', detail: `${remote} is in an old place and no board uses it; board clones now live in ${clones}`, fix: 'kickflip doctor --fix' },
  ]);
  assert.equal(exitCode, 0);
});

test('doctor --fix asks only about old board clones no board uses and removes the ones answered yes; with no one to ask it removes none', async () => {
  const { options, used, remote, other } = oldClones();
  const questions = [];
  const ask = async (question) => { questions.push(question); return 'y'; };
  const output = [];
  const result = await runDoctor({ ...options, fix: true, install: async () => {}, ask, write: (line) => output.push(line) });
  assert.deepEqual(questions, [`Remove the old board clone ${remote}? (y/N) `]);
  assert.deepEqual([used, remote, other].map((dir) => fs.existsSync(dir)), [true, false, true]);
  assert.ok(output.includes(`removed ${remote}`));
  assert.deepEqual(result.items.filter((entry) => entry.item === 'old board clone'), []);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'kickflip', 'repos', 'owner', 'project', '.git')));
  assert.ok(fs.existsSync(path.join(root, '.repos', 'owner', 'not-a-clone', 'src')));

  fs.mkdirSync(path.join(remote, '.git'), { recursive: true });
  const quiet = await runDoctor({ ...options, fix: true, install: async () => {}, write: () => {} });
  assert.ok(fs.existsSync(remote));
  assert.equal(quiet.items.filter((entry) => entry.item === 'old board clone').length, 1);
  const dry = [];
  await runDoctor({ ...options, fix: true, dryRun: true, install: async () => {}, ask: () => assert.fail('asked in a dry run'), write: (line) => dry.push(line) });
  assert.deepEqual(dry, [`would ask to remove the old board clone ${remote}`]);
  assert.ok(fs.existsSync(remote));
});

test('doctor names a missing or out-of-date review skill as optional with the skills CLI command that fixes it', async () => {
  const { options, responses } = healthyDoctor();
  responses.set(SKILLS_TREE, { status: 0, stdout: responses.get(SKILLS_TREE).stdout.replace('sha-grilling', 'sha-newer') });
  let report = await runDoctor({ ...options, write: () => {} });
  assert.deepEqual(pick(report.items, 'mattpocock skills'), { group: 'prereqs', item: 'mattpocock skills', state: 'optional', detail: 'grilling out of date with mattpocock/skills', fix: 'npx skills update grilling -g -y' });
  assert.equal(report.exitCode, 0);
  fs.rmSync(path.join(skills, 'prototype'), { recursive: true });
  fs.rmSync(path.join(skills, 'codebase-design'), { recursive: true });
  report = await runDoctor({ ...options, write: () => {} });
  assert.deepEqual(pick(report.items, 'mattpocock skills'), { group: 'prereqs', item: 'mattpocock skills', state: 'optional', detail: 'codebase-design, prototype not installed; architecture reviews need them',
    fix: 'npx skills add mattpocock/skills -g -y -a claude-code --skill codebase-design prototype' });
  assert.equal(report.exitCode, 0);
});

for (const name of ['kickflip skill link', 'kickflip-hooks link', '~/.claude/statusline.sh', 'settings.json statusLine', 'settings.json watcher Stop hook', 'settings.json autoCompactEnabled', 'hub login item', 'hub', 'tailscale /']) {
  test(`doctor marks ${name} fixable and gives the shared fix command`, async () => {
    const { options, responses, plist } = healthyDoctor();
    if (name === 'kickflip skill link') fs.unlinkSync(skillLinks()[0]);
    if (name === 'kickflip-hooks link') fs.unlinkSync(skillLinks()[1]);
    if (name === '~/.claude/statusline.sh') fs.unlinkSync(statusline());
    if (name === 'settings.json statusLine') fs.unlinkSync(settingsFile());
    if (name === 'settings.json watcher Stop hook') writeSettings({ ...readSettings(), hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cc-status' }] }] } });
    if (name === 'settings.json autoCompactEnabled') writeSettings({ ...readSettings(), autoCompactEnabled: false });
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
  ['Tailscale', 'tailscale version', 'https://tailscale.com/download'],
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

test('doctor marks a board repo yours when git’s own login can’t reach its origin, while GitHub clone still passes', async () => {
  const { options, responses, appRepo } = healthyDoctor();
  const check = `git -C ${appRepo} ls-remote --exit-code origin HEAD`;
  responses.set(check, { status: 128, stdout: '', error: 'remote: Repository not found.' });
  const { items, exitCode } = await runDoctor({ ...options, write: () => {} });
  assert.deepEqual(pick(items, '/app repo'), { group: 'hub', item: '/app repo', state: 'yours',
    detail: `git can’t reach owner/app from ${appRepo}: remote: Repository not found.`, fix: "git's github.com login can't see owner/app; run gh auth setup-git" });
  assert.equal(pick(items, 'GitHub clone').state, 'ok');
  assert.equal(exitCode, 1);
  responses.set(check, { status: 1, stdout: '', error: 'spawnSync git ETIMEDOUT' });
  assert.equal(pick(await doctorReport(options), '/app repo').fix, `run git -C ${appRepo} fetch origin to see the whole error`);
});

test('doctor marks GitHub clone yours when git can’t reach GitHub over https, checking a public repo when gh is signed out', async () => {
  const { options, responses } = healthyDoctor();
  responses.set(`git ${CLONE_CONFIG} ls-remote https://github.com/owner/private.git HEAD`, { status: 128, stdout: '', error: "fatal: unable to access 'https://github.com/owner/private.git/': Could not resolve host: github.com" });
  const { items, exitCode } = await runDoctor({ ...options, write: () => {} });
  assert.deepEqual(pick(items, 'GitHub clone'), { group: 'prereqs', item: 'GitHub clone', state: 'yours',
    detail: "git can’t reach owner/private over https: fatal: unable to access 'https://github.com/owner/private.git/': Could not resolve host: github.com", fix: 'gh auth refresh -h github.com, then kickflip doctor' });
  assert.equal(exitCode, 1);
  responses.set('gh auth status', { status: 1, stdout: '', error: 'not logged in' });
  responses.set(`git ${CLONE_CONFIG} ls-remote https://github.com/cli/cli.git HEAD`, { status: 0, stdout: `${'a'.repeat(40)}\tHEAD` });
  assert.deepEqual(pick(await doctorReport(options), 'GitHub clone'), { group: 'prereqs', item: 'GitHub clone', state: 'ok', detail: 'git reaches cli/cli over https', fix: null });
});

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
    assert.equal(pick(await doctorReport(options), 'settings.json watcher Stop hook').state, 'yours');
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

test('the shared install steps run links, settings, launchd and Tailscale once with injected services', async () => {
  const state = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'manifest.json'), JSON.stringify({ sites: { shop: { port: 19461 } } }));
  const calls = [];
  const waits = [];
  const logs = [];
  const port = 19460;
  await runInstall({ home, cloneRoot: root, port, uid: 501, platform: 'darwin', tailnet: true, tailscale: CLI, wait: async (ms) => waits.push(ms), log: (line) => logs.push(line),
    fetch: async (url) => {
      assert.equal(url, `http://127.0.0.1:${port}/_hub/status.json`);
      return { ok: true, json: async () => ({ sites: [] }) };
    },
    run: (command, argv) => {
      calls.push([command, ...argv]);
      assert.equal(fs.realpathSync(skillLinks()[0]), root);
      assert.equal(readSettings().statusLine.command, statusline());
      if (argv.join(' ') === 'serve status --json') return { status: 0, stdout: JSON.stringify({ Web: { host: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` }, '/shop/': {}, '/unrelated': {} } } } }) };
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, [
    ['npx', '--yes', 'skills', 'add', 'mattpocock/skills', '-g', '-y', '-a', 'claude-code', '--skill', 'improve-codebase-architecture', 'codebase-design', 'grilling', 'prototype'],
    ['launchctl', 'bootout', 'gui/501/local.claude.kickflip-hub'],
    ['launchctl', 'bootstrap', 'gui/501', path.join(home, 'Library', 'LaunchAgents', 'local.claude.kickflip-hub.plist')],
    ['tailscale', 'serve', '--bg', '19460'],
    ['tailscale', 'serve', 'status', '--json'],
    ['tailscale', 'serve', '--https=443', '--set-path=/shop/', 'off'],
  ]);
  assert.deepEqual(waits, [500, 300]);
  assert.ok(logs.includes('added improve-codebase-architecture, codebase-design, grilling, prototype from mattpocock/skills'));
  const plist = fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', 'local.claude.kickflip-hub.plist'), 'utf8');
  assert.ok(plist.includes(path.join(skills, 'kickflip', 'hub', 'hub.mjs')));
  assert.match(plist, /<key>KICKFLIP_HUB_PORT<\/key><string>19460<\/string>/);
});

test('on Linux the shared install steps start a systemd user unit in place of a login item', async () => {
  reviewSkills();
  const calls = [];
  await runInstall({ home, cloneRoot: root, port: 19460, uid: 1000, platform: 'linux', tailnet: true, tailscale: CLI, wait: async () => {}, log: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ sites: [] }) }),
    run: (command, argv) => {
      calls.push([command, ...argv].join(' '));
      return { status: 0, stdout: argv.join(' ') === 'serve status --json' ? '{}' : '' };
    },
  });
  assert.deepEqual(calls, [
    'systemctl --user daemon-reload',
    'systemctl --user enable kickflip-hub.service',
    'systemctl --user restart kickflip-hub.service',
    'tailscale serve --bg 19460',
    'tailscale serve status --json',
  ]);
  const unit = fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'kickflip-hub.service'), 'utf8');
  assert.match(unit, /^ExecStart=".+" "(.+)"$/m);
  assert.equal(/^ExecStart=".+" "(.+)"$/m.exec(unit)[1], path.join(skills, 'kickflip', 'hub', 'hub.mjs'));
  assert.match(unit, /^Environment=KICKFLIP_HUB_PORT=19460$/m);
  assert.equal(fs.existsSync(path.join(home, 'Library')), false);
});

test('on Linux doctor names apt, npm for Codex, and the systemd service with its linger note', async () => {
  const bin = path.join(home, 'linux-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\necho inactive\nexit 3\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'loginctl'), '#!/bin/sh\necho Linger=no\n', { mode: 0o755 });
  const items = await doctorReport({ home, cloneRoot: root, port: 1, uid: 1000, platform: 'linux', tailnet: true, env: { PATH: bin }, fetch: async () => { throw new Error('offline'); } });
  assert.deepEqual(['git', 'gh', 'Tailscale', 'Codex', 'tailscale /'].map((name) => pick(items, name).fix),
    ['sudo apt install git', 'sudo apt install gh', 'curl -fsSL https://tailscale.com/install.sh | sh', 'npm i -g @openai/codex', 'curl -fsSL https://tailscale.com/install.sh | sh']);
  assert.equal(pick(items, 'hub login item'), undefined);
  assert.deepEqual(pick(items, 'hub service'), { group: 'setup', item: 'hub service', state: 'fixable', detail: 'not installed', fix: 'kickflip doctor --fix' });
  assert.deepEqual(pick(items, 'hub without a login'), { group: 'setup', item: 'hub without a login', state: 'optional', detail: 'the hub stops when your last login session ends', fix: 'sudo loginctl enable-linger "$USER"' });
  assert.equal(pick(items, 'macOS-only parts').state, 'note');
  assert.ok(!doctorLines(items).some((line) => /\bbrew\b|launchctl/.test(line)));
});

test('doctor --fix --dry-run and install preview all steps without runners, network or HOME writes', async () => {
  fs.mkdirSync(skills, { recursive: true });
  const before = fs.readdirSync(skills).sort();
  const output = [];
  const result = await runDoctor({ fix: true, dryRun: true, home, cloneRoot: root, port: 19460, write: (line) => output.push(line), run: () => assert.fail('ran command'), fetch: () => assert.fail('fetched'), wait: () => assert.fail('waited') });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(fs.readdirSync(skills).sort(), before);
  assert.equal(fs.existsSync(settingsFile()), false);
  assert.equal(fs.existsSync(path.join(home, 'Library')), false);
  assert.ok(output.includes('would leave Tailscale alone: the tailnet is off'));
});

test('the installed usage hook reminds sessions, denies only new agents while paused and stays silent on errors', () => {
  installLinks({ home, cloneRoot: cloneRoot() });
  const plugin = JSON.parse(fs.readFileSync(path.join(cloneRoot(), 'hooks-plugin', 'hooks', 'hooks.json'), 'utf8'));
  const usageHook = (event) => plugin.hooks[event].flatMap((g) => g.hooks).find((h) => h.command.includes('/usage-gate.mjs')).command;
  assert.equal(plugin.hooks.PreToolUse.find((g) => g.hooks.some((h) => h.command === usageHook('PreToolUse'))).matcher, 'Agent|Task');
  const until = new Date(Date.now() + 3600_000).toISOString();
  const dir = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ claude: { at: new Date().toISOString(), five_hour: { used_percentage: 91, resets_at: until } } }));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const run = (event, input = {}) => {
    const result = spawnSync('/bin/sh', ['-c', usageHook(event)], { env: { ...process.env, HOME: home, PATH: bin }, input: typeof input === 'string' ? input : JSON.stringify({ hook_event_name: event, ...input }), encoding: 'utf8' });
    assert.deepEqual([result.status, result.stderr], [0, '']);
    return result.stdout;
  };
  for (const event of ['SessionStart', 'UserPromptSubmit']) assert.match(run(event), /Running steps finish; builders and agents are held until/);
  for (const tool_name of ['Agent', 'Task']) {
    const out = JSON.parse(run('PreToolUse', { tool_name })).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /The owner can tap Keep going on the Hub page/);
  }
  assert.equal(run('PreToolUse', { tool_name: 'Bash' }), '');
  assert.equal(run('PreToolUse', '{'), '');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ keepGoing: { window: 'five_hour', until } }));
  assert.match(run('SessionStart'), /Keep going is on: work runs past the pause line until .* spending usage/);
  assert.equal(run('PreToolUse', { tool_name: 'Agent' }), '');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ pauseAt: 100 }));
  assert.equal(run('SessionStart'), '');
  fs.writeFileSync(path.join(dir, 'usage.json'), '{');
  assert.equal(run('UserPromptSubmit'), '');
});


test('doctor lists in-range try mappings with board and card or main, while checking only 443 for the hub root', async () => {
  const { options, responses, site } = healthyDoctor();
  site.dir = path.join(home, 'shop');
  fs.mkdirSync(path.join(site.dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site.dir, 'data/try.json'), JSON.stringify({ main_port: 8500, cards: { 'w/A1': { https: 8501 } } }));
  responses.set('tailscale serve status --json', { status: 0, stdout: JSON.stringify({
    TCP: { 443: {}, 8500: {}, 8501: {}, 8600: {} },
    Web: {
      'mac.ts.net:8500': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5000' } } },
      'mac.ts.net:8501': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5001' } } },
      'mac.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:19460' } } },
    },
  }) });
  const items = await doctorReport(options);
  assert.equal(pick(items, 'tailscale /').state, 'ok');
  assert.deepEqual(pick(items, 'try ports'), { group: 'hub', item: 'try ports', state: 'ok', detail: '8500 → http://127.0.0.1:5000 (/shop main); 8501 → http://127.0.0.1:5001 (/shop w/A1)', fix: null });
});

test('Linux doctor requires the current non-root user as Tailscale operator', async () => {
  const { options, responses, calls } = healthyDoctor();
  for (const operator of ['someone', 'love', '']) {
    responses.set('tailscale debug prefs', { status: 0, stdout: JSON.stringify({ OperatorUser: operator }) });
    const items = await doctorReport({ ...options, platform: 'linux', username: 'love' });
    const row = pick(items, 'Tailscale operator');
    assert.equal(row.state, operator === 'love' ? 'ok' : 'yours');
    assert.equal(row.fix, operator === 'love' ? null : 'sudo tailscale set --operator=$USER');
  }
  calls.length = 0;
  assert.equal(pick(await doctorReport({ ...options, platform: 'linux', uid: 0 }), 'Tailscale operator'), undefined);
  assert.equal(calls.includes('tailscale debug prefs'), false);
  assert.equal(pick(await doctorReport(options), 'Tailscale operator'), undefined);
});

test('tailnetUrl gives the hub or a site at this host’s tailnet name, and says why when Tailscale or HTTPS is off', () => {
  const calls = [];
  const runner = (status) => (command, argv) => {
    calls.push([command, ...argv].join(' '));
    return status === null ? { status: 1, stdout: '', error: 'spawnSync tailscale ENOENT' } : { status: 0, stdout: JSON.stringify(status) };
  };
  const on = { BackendState: 'Running', CertDomains: ['mac.tailnet-name.ts.net'], Self: { DNSName: 'mac.tailnet-name.ts.net.' } };
  const url = (route, status) => tailnetUrl(route, { run: runner(status), tailscale: CLI });
  assert.equal(url(undefined, on), 'https://mac.tailnet-name.ts.net/');
  assert.equal(url('kickflip', on), 'https://mac.tailnet-name.ts.net/kickflip/');
  assert.deepEqual([...new Set(calls)], ['tailscale status --json']);
  assert.throws(() => url(undefined, null), /^Error: Tailscale isn't running on this host/);
  assert.throws(() => url(undefined, { ...on, BackendState: 'Stopped' }), /^Error: Tailscale isn't running on this host/);
  assert.throws(() => url(undefined, { ...on, CertDomains: null }), /^Error: HTTPS isn't on for this tailnet/);
  calls.length = 0;
  assert.throws(() => tailnetUrl(undefined, { run: runner(on), tailscale: null, platform: 'darwin' }),
    /^Error: Tailscale isn't installed on this host; install Tailscale from https:\/\/tailscale\.com\/download, or brew install --cask tailscale-app$/);
  assert.deepEqual(calls, []);
  assert.equal(tailnetUrl('kickflip', { run: runner(on), tailscale: APP }), 'https://mac.tailnet-name.ts.net/kickflip/');
  assert.deepEqual(calls, [`${APP_CLI} status --json`]);
  calls.length = 0;
  assert.equal(tailnetUrl('kickflip', { run: runner(on), tailscale: BREW }), 'https://mac.tailnet-name.ts.net/kickflip/');
  assert.deepEqual(calls, [`${BREW_CLI} --socket ${DARWIN_SOCKET} status --json`]);
});

test('tailnetUrl refuses when another daemon answers for the recorded one, naming that machine and the re-pick', () => {
  const run = () => ({ status: 0, stdout: JSON.stringify({ BackendState: 'Running', CertDomains: ['brew.ts.net'], Self: { ID: 'nBrew', HostName: 'brew-mac', DNSName: 'brew.ts.net.' } }) });
  assert.throws(() => tailnetUrl(undefined, { run, tailscale: { ...APP, node: 'nApp' } }),
    /^Error: Tailscale's recorded daemon isn't running \(brew-mac answered in its place\); start it, or run kickflip doctor --fix to pick again$/);
  assert.equal(tailnetUrl(undefined, { run, tailscale: { ...BREW, node: 'nBrew' } }), 'https://brew.ts.net/');
});

const APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const APP = { kind: 'app', cli: APP_CLI };
const BREW_CLI = '/opt/homebrew/bin/tailscale';
const BREW = { kind: 'tailscaled', cli: BREW_CLI, socket: DARWIN_SOCKET };
// healthyDoctor's tailscale responses, as daemon answers them.
const through = (responses, daemon) => {
  const prefix = [daemon.cli, ...(daemon.socket ? ['--socket', daemon.socket] : [])].join(' ');
  for (const [key, value] of [...responses]) if (key.startsWith('tailscale ')) responses.set(key.replace('tailscale', prefix), value);
};

for (const [daemon, label, prefix] of [[APP, `the Tailscale app, ${APP_CLI}`, APP_CLI], [BREW, `tailscaled, ${BREW_CLI} --socket ${DARWIN_SOCKET}`, `${BREW_CLI} --socket ${DARWIN_SOCKET}`]]) {
  test(`doctor names the chosen daemon and its machine, and runs every check through it: ${daemon.kind}`, async () => {
    const { options, responses, calls } = healthyDoctor();
    through(responses, daemon);
    const items = await doctorReport({ ...options, tailscale: daemon });
    assert.deepEqual(pick(items, 'Tailscale'), { group: 'prereqs', item: 'Tailscale', state: 'ok', detail: `1.90.0 (${label}) on mac`, fix: null });
    assert.equal(pick(items, 'tailscale /').state, 'ok');
    assert.ok(calls.some((call) => call.startsWith(`${prefix} serve status`)));
    assert.ok(!calls.some((call) => call.startsWith('tailscale ')));
  });
}

test('doctor’s Tailscale line notes another running daemon and its machine, and stays ok', async () => {
  const { options, responses } = healthyDoctor();
  through(responses, APP);
  const items = await doctorReport({ ...options, tailscale: APP, others: [{ daemon: BREW, machine: 'brew-mac' }] });
  assert.deepEqual(pick(items, 'Tailscale'), { group: 'prereqs', item: 'Tailscale', state: 'ok',
    detail: `1.90.0 (the Tailscale app, ${APP_CLI}) on mac; also running: tailscaled, ${BREW_CLI} --socket ${DARWIN_SOCKET} on brew-mac`, fix: null });
  assert.equal(pick(items, 'Tailscale signed in').state, 'ok');
});

test('with the recorded daemon down, doctor stays on it and faults, and doctor --fix picks again', async () => {
  const { options, responses, calls } = healthyDoctor();
  through(responses, APP);
  // The app is quit, so its CLI falls through to brew's socket and answers as brew's node.
  responses.set(`${APP_CLI} status --json`, { status: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { ID: 'nBrew', HostName: 'brew-mac', DNSName: 'brew.ts.net.' } }) });
  const items = await doctorReport({ ...options, tailscale: { ...APP, node: 'nApp' }, others: [{ daemon: BREW, machine: 'brew-mac' }] });
  assert.deepEqual(pick(items, 'Tailscale signed in'), { group: 'prereqs', item: 'Tailscale signed in', state: 'fixable',
    detail: 'the recorded daemon isn’t running; brew-mac answered in its place', fix: 'kickflip doctor --fix' });
  assert.equal(pick(items, 'Tailscale').detail, `1.90.0 (the Tailscale app, ${APP_CLI}); also running: tailscaled, ${BREW_CLI} --socket ${DARWIN_SOCKET} on brew-mac`);
  assert.deepEqual(pick(items, 'tailscale /'), { group: 'hub', item: 'tailscale /', state: 'fixable', detail: `nothing (expected the hub on ${options.port})`, fix: 'kickflip doctor --fix' });
  // Nothing is read from the daemon that answered in its place.
  assert.ok(!calls.some((call) => call.includes('serve status')));
  // Down with nothing else running: start it.
  responses.set(`${APP_CLI} status --json`, { status: 1, stdout: '' });
  const alone = await doctorReport({ ...options, tailscale: { ...APP, node: 'nApp' } });
  assert.deepEqual(pick(alone, 'Tailscale signed in'), { group: 'prereqs', item: 'Tailscale signed in', state: 'yours', detail: 'not connected', fix: 'tailscale up' });
});

test('install picks the daemon again and records it in the hub’s settings, and maps / through it', async () => {
  const bin = path.join(home, 'ts-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tailscale'), `#!/bin/sh\necho '{"BackendState":"Running","Self":{"ID":"nLinux"}}'\n`, { mode: 0o755 });
  const settingsFile = path.join(home, '.claude', 'kickflip', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ claudeModel: 'auto', tailscale: { kind: 'cli', cli: '/gone/tailscale', node: 'nOld' } }));
  const calls = [];
  await runInstall({ home, cloneRoot: root, port: 19460, uid: 1000, platform: 'linux', tailnet: true, env: { PATH: bin }, wait: async () => {}, log: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ sites: [] }) }),
    run: (command, argv) => { calls.push([command, ...argv].join(' ')); return { status: 0, stdout: '{}' }; },
  });
  const cli = path.join(bin, 'tailscale');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { claudeModel: 'auto', tailscale: { kind: 'cli', cli, node: 'nLinux' } });
  // The recorded node is checked before / is mapped.
  assert.deepEqual(calls.filter((call) => call.includes('tailscale')), [`${cli} status --json`, `${cli} serve --bg 19460`, `${cli} serve status --json`]);
});

test('with no tailscale anywhere, doctor says so once, runs nothing and names the download page on macOS', async () => {
  const { options, calls } = healthyDoctor();
  const items = await doctorReport({ ...options, tailscale: null });
  assert.deepEqual(pick(items, 'Tailscale'), { group: 'prereqs', item: 'Tailscale', state: 'yours', detail: 'not on this session’s PATH or in Applications', fix: 'install Tailscale from https://tailscale.com/download, or brew install --cask tailscale-app' });
  assert.equal(pick(items, 'Tailscale signed in').detail, 'needs Tailscale');
  assert.equal(pick(items, 'tailscale /').state, 'yours');
  assert.equal(pick(items, 'tailscale /').fix, 'install Tailscale from https://tailscale.com/download, or brew install --cask tailscale-app');
  assert.ok(!calls.some((call) => /tailscale /i.test(call)));
});

test('with no tailscale, install still starts the hub and skips only the mapping, with the reason and the fix', async () => {
  const calls = [];
  const logs = [];
  const port = 19460;
  await runInstall({ home, cloneRoot: root, port, uid: 501, platform: 'darwin', tailnet: true, tailscale: null, wait: async () => {}, log: (line) => logs.push(line),
    fetch: async () => ({ ok: true, json: async () => ({ sites: [] }) }),
    run: (command, argv) => { calls.push([command, ...argv].join(' ')); return { status: 0, stdout: '' }; },
  });
  assert.ok(calls.includes(`launchctl bootstrap gui/501 ${path.join(home, 'Library', 'LaunchAgents', 'local.claude.kickflip-hub.plist')}`));
  assert.ok(!calls.some((call) => /tailscale/i.test(call)));
  assert.equal(logs.at(-1), "skipped mapping tailscale / to the hub: Tailscale isn't installed on this host; install Tailscale from https://tailscale.com/download, or brew install --cask tailscale-app");
});

test('with the app recorded and quit, install refuses to map / with the recorded-daemon fault, and serves nothing on the daemon that answered', async () => {
  const calls = [];
  await assert.rejects(runInstall({ home, cloneRoot: root, port: 19460, uid: 501, platform: 'darwin', tailnet: true, tailscale: { ...APP, node: 'nApp' }, wait: async () => {}, log: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ sites: [] }) }),
    run: (command, argv) => {
      calls.push([command, ...argv].join(' '));
      return { status: 0, stdout: argv.join(' ') === 'status --json' ? JSON.stringify({ BackendState: 'Running', Self: { ID: 'nBrew', HostName: 'brew-mac' } }) : '{}' };
    },
  }), /^Error: Tailscale's recorded daemon isn't running \(brew-mac answered in its place\); start it, or run kickflip doctor --fix to pick again$/);
  assert.deepEqual(calls.filter((call) => call.includes(APP_CLI)), [`${APP_CLI} status --json`]);
});

test('install maps the hub through the chosen daemon, the GUI app’s or brew’s with its socket', async () => {
  for (const [daemon, prefix] of [[APP, APP_CLI], [BREW, `${BREW_CLI} --socket ${DARWIN_SOCKET}`]]) {
    const calls = [];
    await runInstall({ home, cloneRoot: root, port: 19460, uid: 501, platform: 'darwin', tailnet: true, tailscale: daemon, wait: async () => {}, log: () => {},
      fetch: async () => ({ ok: true, json: async () => ({ sites: [] }) }),
      run: (command, argv) => { calls.push([command, ...argv].join(' ')); return { status: 0, stdout: '{}' }; },
    });
    assert.deepEqual(calls.filter((call) => /tailscale/i.test(call)), [`${prefix} serve --bg 19460`, `${prefix} serve status --json`]);
  }
});

test('nodeBin names the Homebrew link only when the running node is the Cellar node', () => {
  const link = path.join(home, 'node-link');
  fs.writeFileSync(link, '');
  const cellar = '/opt/homebrew/Cellar/node/26.12.0/bin/node';
  assert.equal(nodeBin(cellar, link), link);
  assert.equal(nodeBin(cellar, path.join(home, 'missing')), cellar);
  assert.equal(nodeBin('/Users/x/.nvm/versions/node/v24/bin/node', link), '/Users/x/.nvm/versions/node/v24/bin/node');
});

// An npm install, <prefix>/lib/node_modules/@lovek4d/kickflip, with the prefix's node when withNode.
function npmInstall(prefix, withNode = true) {
  const pkg = path.join(prefix, 'lib', 'node_modules', '@lovek4d', 'kickflip');
  fs.mkdirSync(path.join(pkg, 'hooks-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'bin'));
  fs.writeFileSync(path.join(pkg, 'bin', 'statusline.mjs'), '#!/usr/bin/env node\n');
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  if (withNode) fs.writeFileSync(path.join(prefix, 'bin', 'node'), '');
  return pkg;
}

function serviceNode(options, node) {
  const service = hubService({ platform: options.platform, home, uid: 501 });
  fs.mkdirSync(path.dirname(service.file), { recursive: true });
  fs.writeFileSync(service.file, service.definition({ node, entry: '/x/hub.mjs', state: '/x', port: 1, log: '/x/log' }));
  return service;
}

test('doctor flags a hub service whose node is not the one owning the installed package, and --fix names the owning node', async () => {
  const { options } = healthyDoctor();
  const homebrew = path.join(home, 'opt', 'homebrew');
  const nvm = path.join(home, '.nvm', 'versions', 'node', 'v24');
  const pkg = npmInstall(nvm);
  npmInstall(homebrew);
  const check = async (node, cloneRoot) => {
    serviceNode(options, node);
    return pick(await doctorReport({ ...options, cloneRoot }), 'hub service node');
  };
  assert.deepEqual(await check(path.join(nvm, 'bin', 'node'), pkg), { group: 'setup', item: 'hub service node', state: 'ok', detail: `${path.join(nvm, 'bin', 'node')} owns the installed kickflip`, fix: null });
  const other = await check(path.join(homebrew, 'bin', 'node'), pkg);
  assert.equal(other.state, 'fixable');
  assert.equal(other.fix, 'kickflip doctor --fix');
  assert.ok(other.detail.includes(`doesn’t own the installed kickflip, which npm keeps under ${nvm}`));
  const gone = await check(path.join(home, '.nvm', 'versions', 'node', 'v22', 'bin', 'node'), pkg);
  assert.equal(gone.state, 'fixable');
  assert.ok(gone.detail.includes('is missing') && gone.detail.includes(path.join(nvm, 'bin', 'node')));
  assert.equal((await check(path.join(homebrew, 'bin', 'node'), root)).state, 'ok');
  fs.rmSync(hubService({ platform: 'darwin', home, uid: 501 }).file);
  assert.equal(pick(await doctorReport({ ...options, cloneRoot: pkg }), 'hub service node'), undefined);
});

test('doctor reads a systemd unit’s node the same way', async () => {
  const { options } = healthyDoctor();
  const nvm = path.join(home, '.nvm', 'versions', 'node', 'v24');
  const pkg = npmInstall(nvm);
  const linux = { ...options, platform: 'linux', cloneRoot: pkg };
  serviceNode(linux, '/usr/bin/node');
  const service = hubService({ platform: 'linux', home, uid: 501 });
  assert.equal(service.node(), '/usr/bin/node');
  const responses = { status: 0, stdout: 'active\n' };
  const run = (command, argv, passed) => (command === 'systemctl' ? responses : options.run(command, argv, passed));
  assert.equal(pick(await doctorReport({ ...linux, run }), 'hub service node').state, 'fixable');
});

test('install writes the node that owns the install into the service, and a clone keeps the running node', async () => {
  const nvm = path.join(home, '.nvm', 'versions', 'node', 'v24');
  const pkg = npmInstall(nvm);
  const written = [];
  const run = (command, argv) => ({ status: 0, stdout: '', error: '' });
  const wait = async () => {};
  const fetch = async () => ({ ok: true, json: async () => ({ sites: [] }) });
  await runInstall({ home, cloneRoot: pkg, platform: 'darwin', uid: 501, run, wait, fetch, tailscale: null, log: (line) => written.push(line) });
  assert.equal(hubService({ platform: 'darwin', home, uid: 501 }).node(), path.join(nvm, 'bin', 'node'));
  fs.rmSync(skills, { recursive: true });
  fs.rmSync(statusline());
  await runInstall({ home, cloneRoot: root, platform: 'darwin', uid: 501, run, wait, fetch, tailscale: null, log: () => {} });
  assert.equal(hubService({ platform: 'darwin', home, uid: 501 }).node(), nodeBin());
});

test('with the tailnet off, install starts the hub, runs no tailscale and leaves an existing mapping alone, naming the local address', async () => {
  const calls = [];
  const logs = [];
  await runInstall({ home, cloneRoot: root, port: 19460, uid: 501, platform: 'darwin', wait: async () => {}, log: (line) => logs.push(line),
    fetch: async () => ({ ok: true, json: async () => ({ sites: [] }) }),
    run: (command, argv) => { calls.push([command, ...argv].join(' ')); return { status: 0, stdout: '' }; },
  });
  assert.ok(calls.includes(`launchctl bootstrap gui/501 ${path.join(home, 'Library', 'LaunchAgents', 'local.claude.kickflip-hub.plist')}`));
  assert.ok(!calls.some((call) => /tailscale/i.test(call)));
  assert.equal(logs.at(-1), 'the tailnet is off: the hub serves this host at http://127.0.0.1:19460/; kickflip tailnet on adds it to your tailnet');
  const dry = [];
  await runInstall({ home, cloneRoot: root, port: 19460, uid: 501, platform: 'darwin', dryRun: true, log: (line) => dry.push(line), run: () => ({ status: 0, stdout: '' }) });
  assert.equal(dry.at(-1), 'would leave Tailscale alone: the tailnet is off');
});

test('with the tailnet off, doctor shows one optional Tailnet row with the command and runs no tailscale', async () => {
  const { options, calls } = healthyDoctor();
  const items = await doctorReport({ ...options, tailnet: false, tailscale: undefined, others: undefined });
  assert.deepEqual(pick(items, 'Tailnet'), { group: 'prereqs', item: 'Tailnet', state: 'optional', detail: 'off; the hub serves this host only, at http://127.0.0.1:19460/', fix: 'kickflip tailnet on' });
  for (const name of ['Tailscale', 'Tailscale signed in', 'tailscale /', 'try ports']) assert.equal(pick(items, name), undefined, name);
  assert.ok(!calls.some((call) => /tailscale/i.test(call)));
});

test('with the tailnet off, uninstall runs no tailscale and leaves / as it is', () => {
  const stub = path.join(home, 'ts-bin', 'tailscale');
  const log = path.join(home, 'ts-calls');
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> '${log}'\necho '{}'\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'settings.json'), JSON.stringify({ tailscale: { kind: 'cli', cli: stub, node: 'n1' } }));
  const result = spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'kickflip.mjs'), 'uninstall'], {
    env: { ...process.env, HOME: home, KICKFLIP_TAILSCALE: '', KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false', PATH: path.join(home, 'no-bin'), KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /tailscale/);
  assert.equal(fs.existsSync(log), false);
});

test('kickflip url and kickflip tailnet status name this host’s address while the tailnet is off, and run no tailscale', () => {
  const stub = path.join(home, 'ts-bin', 'tailscale');
  const log = path.join(home, 'ts-calls');
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> '${log}'\necho '{}'\n`, { mode: 0o755 });
  const kickflip = (...args) => spawnSync(process.execPath, [path.join(cloneRoot(), 'bin', 'kickflip.mjs'), ...args], {
    env: { ...process.env, HOME: home, KICKFLIP_TAILSCALE: stub, KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false', PATH: path.join(home, 'no-bin'), KICKFLIP_HUB_PORT: '19460' }, encoding: 'utf8',
  });
  assert.equal(kickflip('url').stdout, 'http://127.0.0.1:19460/\n');
  assert.equal(kickflip('tailnet').stdout, 'off: the hub serves this host only, at http://127.0.0.1:19460/; kickflip tailnet on adds it to your tailnet\n');
  assert.equal(kickflip('tailnet', 'status').stdout, 'off: the hub serves this host only, at http://127.0.0.1:19460/; kickflip tailnet on adds it to your tailnet\n');
  const bad = kickflip('tailnet', 'maybe');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /tailnet takes on, off or status/);
  assert.equal(fs.existsSync(log), false);
});

test('removeRetiredState removes the unused test.queue and leaves the live queues', () => {
  const kick = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(path.join(kick, 'test.queue'), { recursive: true });
  fs.writeFileSync(path.join(kick, 'test.queue', '1-2-3'), '');
  fs.mkdirSync(path.join(kick, 'land.queue'));
  assert.deepEqual(removeRetiredState({ home }), [`removed ${path.join(kick, 'test.queue')}`]);
  assert.equal(fs.existsSync(path.join(kick, 'test.queue')), false);
  assert.equal(fs.existsSync(path.join(kick, 'land.queue')), true);
  assert.deepEqual(removeRetiredState({ home }), []);
});
