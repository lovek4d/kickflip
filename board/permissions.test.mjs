import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PERMISSIONS, followScriptsHome, permissionFor, permissionsView, readPermissions, recordRefusal, setPermission, settingsFile } from './permissions.mjs';
import { writeScript } from './build-script.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const scratch = () => {
  const root = tempDir('board-permissions-');
  const folder = path.join(root, 'repo');
  const site = path.join(root, 'site');
  fs.mkdirSync(folder);
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  return { root, folder, site };
};
// Makes folder a git repo whose HEAD holds an executable .kickflip/release.
const releaseScriptIn = (folder) => {
  const git = (...args) => execFileSync('git', ['-C', folder, ...args], { stdio: 'ignore' });
  git('init', '--quiet');
  fs.mkdirSync(path.join(folder, '.kickflip'));
  fs.writeFileSync(path.join(folder, '.kickflip', 'release'), '#!/bin/sh\n', { mode: 0o755 });
  git('add', '.kickflip');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'release script');
};
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const bash = (command, event = 'PermissionDenied') => ({ hook_event_name: event, tool_name: 'Bash', tool_input: { command } });

test('the switches are the fixed list, each naming the rule it writes', () => {
  assert.deepEqual(PERMISSIONS.map((p) => [p.name, p.rule]), [
    ['Push main after a land', 'Bash(git push origin main)'],
    ['Run release script', 'Bash(.kickflip/release *)'],
    ['Open draft PRs', 'Bash(gh pr create --draft *)'],
    ['Approve PRs', 'Bash(gh pr review *)'],
  ]);
});

test('a switch writes its rule into a folder with no settings file and creates .claude', async () => {
  const { root, folder, site } = scratch();
  try {
    releaseScriptIn(folder);
    assert.deepEqual(await readPermissions(folder), { pushMain: false, runRelease: false, draftPr: false, approvePr: false });
    assert.deepEqual(await setPermission(folder, site, 'runRelease', true), { pushMain: false, runRelease: true, draftPr: false, approvePr: false });
    assert.deepEqual(read(settingsFile(folder)), { permissions: { allow: ['Bash(.kickflip/release *)'] } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("switching merges with what's there and off removes only its own rule", async () => {
  const { root, folder, site } = scratch();
  try {
    fs.mkdirSync(path.join(folder, '.claude'));
    const mine = { env: { A: '1' }, permissions: { allow: ['Bash(npm test)', 'Bash(git push origin main)'], deny: ['Bash(rm -rf *)'] } };
    fs.writeFileSync(settingsFile(folder), JSON.stringify(mine));
    assert.deepEqual(await readPermissions(folder), { pushMain: true, runRelease: false, draftPr: false, approvePr: false });
    await setPermission(folder, site, 'draftPr', true);
    assert.deepEqual(read(settingsFile(folder)), { ...mine, permissions: { ...mine.permissions, allow: [...mine.permissions.allow, 'Bash(gh pr create --draft *)'] } });
    await setPermission(folder, site, 'pushMain', false);
    await setPermission(folder, site, 'pushMain', false);
    assert.deepEqual(read(settingsFile(folder)), { ...mine, permissions: { ...mine.permissions, allow: ['Bash(npm test)', 'Bash(gh pr create --draft *)'] } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a settings file that is not a JSON object stays as it is, and a bad switch is refused', async () => {
  const { root, folder, site } = scratch();
  try {
    fs.mkdirSync(path.join(folder, '.claude'));
    fs.writeFileSync(settingsFile(folder), '{ broken');
    await assert.rejects(setPermission(folder, site, 'runRelease', true), /isn’t a JSON object/);
    assert.equal(fs.readFileSync(settingsFile(folder), 'utf8'), '{ broken');
    fs.writeFileSync(settingsFile(folder), '{"permissions": []}');
    await assert.rejects(setPermission(folder, site, 'runRelease', true), /permissions isn’t an object/);
    await assert.rejects(setPermission(folder, site, 'rmEverything', true), /Send \{id, on\}/);
    await assert.rejects(setPermission(folder, site, 'runRelease', 'yes'), /Send \{id, on\}/);
    await assert.rejects(readPermissions(''), /no repo folder recorded/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a command matches the switch whose rule allows it, with * for any run of characters', () => {
  assert.equal(permissionFor('.kickflip/release ship 0.9.0 abc123')?.id, 'runRelease');
  assert.equal(permissionFor('git push origin v0.9.0'), null);
  assert.equal(permissionFor('git push origin main')?.id, 'pushMain');
  assert.equal(permissionFor('gh pr create --draft --title x')?.id, 'draftPr');
  assert.equal(permissionFor('gh pr review 3808 --repo Ever-Cars/evercars-backend --approve --body "ok"')?.id, 'approvePr');
  assert.equal(permissionFor('git push origin main --force')?.id, undefined);
  assert.equal(permissionFor('gh pr create --title x'), null);
  assert.equal(permissionFor(undefined), null);
});

test('a refusal shows under its switch only while it is on, and a change to that switch clears it', async () => {
  const { root, folder, site } = scratch();
  try {
    releaseScriptIn(folder);
    assert.equal(await recordRefusal(folder, site, bash('.kickflip/release ship 1.0.0 abc')), null, 'off: nothing to note');
    await setPermission(folder, site, 'runRelease', true);
    assert.equal(await recordRefusal(folder, site, bash('npm publish')), null);
    assert.equal(await recordRefusal(folder, site, { tool_name: 'Edit', tool_input: { file_path: '/x' } }), null);
    const at = new Date('2026-11-03T20:00:00Z');
    assert.equal(await recordRefusal(folder, site, bash('.kickflip/release ship 1.0.0 abc'), at), 'runRelease');
    const view = await permissionsView(folder, site);
    assert.equal(view.file, settingsFile(folder));
    assert.deepEqual(view.permissions.map((p) => [p.id, p.on, p.refused, p.unavailable]), [
      ['pushMain', false, null, null],
      ['runRelease', true, { command: '.kickflip/release ship 1.0.0 abc', how: 'denied', at: at.toISOString() }, null],
      ['draftPr', false, null, null],
      ['approvePr', false, null, null],
    ]);
    await recordRefusal(folder, site, bash('.kickflip/release ship 1.0.1 abc', 'PermissionRequest'), at);
    assert.equal((await permissionsView(folder, site)).permissions[1].refused.how, 'asked');
    await setPermission(folder, site, 'runRelease', true);
    assert.equal((await permissionsView(folder, site)).permissions[1].refused, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md
test("Run release script can't be turned on in a repo with no .kickflip/release, and says so; it can still be turned off", async () => {
  const { root, folder, site } = scratch();
  try {
    fs.mkdirSync(path.join(folder, '.claude'));
    fs.writeFileSync(settingsFile(folder), JSON.stringify({ permissions: { allow: ['Bash(.kickflip/release *)'] } }));
    const row = async () => (await permissionsView(folder, site)).permissions.find((p) => p.id === 'runRelease');
    assert.deepEqual([(await row()).on, (await row()).unavailable], [true, 'No .kickflip/release in this repo']);
    assert.equal('needsReleaseScript' in (await row()), false);
    assert.deepEqual(await setPermission(folder, site, 'runRelease', false), { pushMain: false, runRelease: false, draftPr: false, approvePr: false });
    await assert.rejects(setPermission(folder, site, 'runRelease', true), /No \.kickflip\/release in this repo, so Run release script stays off\.$/);
    assert.deepEqual(read(settingsFile(folder)), { permissions: { allow: [] } });
    releaseScriptIn(folder);
    assert.equal((await row()).unavailable, null);
    assert.equal((await setPermission(folder, site, 'runRelease', true)).runRelease, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md
test("on a board whose scripts are in kickflip, Run release script needs the site's scripts/release, writes a rule naming it, and follows a move of the scripts' home", async () => {
  const { root, folder, site } = scratch();
  try {
    releaseScriptIn(folder);
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ scripts: 'kickflip' }));
    const kickflipRule = `Bash(${path.join(site, 'scripts', 'release')} *)`;
    const row = async () => (await permissionsView(folder, site)).permissions.find((p) => p.id === 'runRelease');
    assert.deepEqual([(await row()).unavailable, (await row()).rule], [`No ${path.join(site, 'scripts', 'release')} in kickflip`, kickflipRule], "the repo's script doesn't count");
    await assert.rejects(setPermission(folder, site, 'runRelease', true), /in kickflip, so Run release script stays off\.$/);
    writeScript(site, 'release', '#!/bin/sh\n');
    assert.equal((await setPermission(folder, site, 'runRelease', true)).runRelease, true);
    assert.deepEqual(read(settingsFile(folder)), { permissions: { allow: [kickflipRule] } });
    assert.equal(permissionFor(`${path.join(site, 'scripts', 'release')} ship 1.0.0 abc`, site)?.id, 'runRelease');
    assert.equal(permissionFor('.kickflip/release ship 1.0.0 abc', site), null);
    assert.equal(await recordRefusal(folder, site, bash(`${path.join(site, 'scripts', 'release')} ship 1.0.0 abc`)), 'runRelease');

    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({}));
    await followScriptsHome(folder, site, 'kickflip');
    assert.deepEqual(read(settingsFile(folder)), { permissions: { allow: ['Bash(.kickflip/release *)'] } });
    assert.equal((await readPermissions(folder, site)).runRelease, true, 'still on, for the repo script');
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ scripts: 'kickflip' }));
    await followScriptsHome(folder, site, 'repo');
    assert.deepEqual(read(settingsFile(folder)), { permissions: { allow: [kickflipRule] } });
    await setPermission(folder, site, 'runRelease', false);
    await followScriptsHome(folder, site, 'repo');
    assert.deepEqual(read(settingsFile(folder)), { permissions: { allow: [] } }, 'an off switch stays off');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
