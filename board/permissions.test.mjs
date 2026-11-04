import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PERMISSIONS, permissionFor, permissionsView, readPermissions, recordRefusal, setPermission, settingsFile } from './permissions.mjs';

const scratch = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-permissions-'));
  const folder = path.join(root, 'repo');
  const site = path.join(root, 'site');
  fs.mkdirSync(folder);
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  return { root, folder, site };
};
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const bash = (command, event = 'PermissionDenied') => ({ hook_event_name: event, tool_name: 'Bash', tool_input: { command } });

test('the switches are the fixed list, each naming the rule it writes', () => {
  assert.deepEqual(PERMISSIONS.map((p) => [p.name, p.rule]), [
    ['Push main after a land', 'Bash(git push origin main)'],
    ['Push release tags', 'Bash(git push origin v*)'],
    ['Open draft PRs', 'Bash(gh pr create --draft *)'],
  ]);
});

test('a switch writes its rule into a folder with no settings file and creates .claude', async () => {
  const { root, folder, site } = scratch();
  try {
    assert.deepEqual(await readPermissions(folder), { pushMain: false, pushTags: false, draftPr: false });
    assert.deepEqual(await setPermission(folder, site, 'pushTags', true), { pushMain: false, pushTags: true, draftPr: false });
    assert.deepEqual(read(settingsFile(folder)), { permissions: { allow: ['Bash(git push origin v*)'] } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("switching merges with what's there and off removes only its own rule", async () => {
  const { root, folder, site } = scratch();
  try {
    fs.mkdirSync(path.join(folder, '.claude'));
    const mine = { env: { A: '1' }, permissions: { allow: ['Bash(npm test)', 'Bash(git push origin main)'], deny: ['Bash(rm -rf *)'] } };
    fs.writeFileSync(settingsFile(folder), JSON.stringify(mine));
    assert.deepEqual(await readPermissions(folder), { pushMain: true, pushTags: false, draftPr: false });
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
    await assert.rejects(setPermission(folder, site, 'pushTags', true), /isn’t a JSON object/);
    assert.equal(fs.readFileSync(settingsFile(folder), 'utf8'), '{ broken');
    fs.writeFileSync(settingsFile(folder), '{"permissions": []}');
    await assert.rejects(setPermission(folder, site, 'pushTags', true), /permissions isn’t an object/);
    await assert.rejects(setPermission(folder, site, 'rmEverything', true), /Send \{id, on\}/);
    await assert.rejects(setPermission(folder, site, 'pushTags', 'yes'), /Send \{id, on\}/);
    await assert.rejects(readPermissions(''), /no repo folder recorded/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a command matches the switch whose rule allows it, with * for any run of characters', () => {
  assert.equal(permissionFor('git push origin v0.9.0')?.id, 'pushTags');
  assert.equal(permissionFor('git push origin main')?.id, 'pushMain');
  assert.equal(permissionFor('gh pr create --draft --title x')?.id, 'draftPr');
  assert.equal(permissionFor('git push origin main --force')?.id, undefined);
  assert.equal(permissionFor('gh pr create --title x'), null);
  assert.equal(permissionFor(undefined), null);
});

test('a refusal shows under its switch only while it is on, and a change to that switch clears it', async () => {
  const { root, folder, site } = scratch();
  try {
    assert.equal(await recordRefusal(folder, site, bash('git push origin v1.0.0')), null, 'off: nothing to note');
    await setPermission(folder, site, 'pushTags', true);
    assert.equal(await recordRefusal(folder, site, bash('npm publish')), null);
    assert.equal(await recordRefusal(folder, site, { tool_name: 'Edit', tool_input: { file_path: '/x' } }), null);
    const at = new Date('2026-11-03T20:00:00Z');
    assert.equal(await recordRefusal(folder, site, bash('git push origin v1.0.0'), at), 'pushTags');
    const view = await permissionsView(folder, site, true);
    assert.equal(view.owner, true);
    assert.equal(view.file, settingsFile(folder));
    assert.deepEqual(view.permissions.map((p) => [p.id, p.on, p.refused]), [
      ['pushMain', false, null],
      ['pushTags', true, { command: 'git push origin v1.0.0', how: 'denied', at: at.toISOString() }],
      ['draftPr', false, null],
    ]);
    await recordRefusal(folder, site, bash('git push origin v1.0.1', 'PermissionRequest'), at);
    assert.equal((await permissionsView(folder, site, false)).permissions[1].refused.how, 'asked');
    await setPermission(folder, site, 'pushTags', true);
    assert.equal((await permissionsView(folder, site, false)).permissions[1].refused, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
