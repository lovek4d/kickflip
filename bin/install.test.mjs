import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installLinks } from './install.mjs';
import { cloneRoot } from '../shared/repos.mjs';

let home;
let root;
let skills;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kickflip-install-')));
  root = path.join(home, 'dev', 'kickflip clone');
  skills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(root, 'hooks-plugin'), { recursive: true });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const install = (options = {}) => installLinks({ home, cloneRoot: root, ...options });
const targets = () => [root, path.join(root, 'hooks-plugin')];
const links = () => ['join-web-ts', 'web-ts-hooks'].map((name) => path.join(skills, name));

test('install creates both links in a fresh HOME and a second install checks them', () => {
  const first = install();
  assert.deepEqual(first, links().map((link, i) => ({ link, target: targets()[i], created: true })));
  assert.deepEqual(links().map((link) => fs.readlinkSync(link)), targets());
  const before = links().map((link) => fs.lstatSync(link).ino);
  assert.deepEqual(install(), first.map((entry) => ({ ...entry, created: false })));
  assert.deepEqual(links().map((link) => fs.lstatSync(link).ino), before);
  assert.deepEqual(fs.readdirSync(home).sort(), ['.claude', 'dev']);
});

test('install accepts correct relative links and a clone root reached through a link', () => {
  fs.mkdirSync(skills, { recursive: true });
  links().forEach((link, i) => fs.symlinkSync(path.relative(skills, targets()[i]), link));
  const alias = path.join(home, 'alias');
  fs.symlinkSync(root, alias);
  assert.ok(install({ cloneRoot: alias }).every(({ created }) => !created));
  assert.deepEqual(links().map((link) => fs.realpathSync(link)), targets());
});

test('install accepts an injectable skills directory', () => {
  const skillsDir = path.join(home, 'custom skills');
  assert.deepEqual(install({ skillsDir }).map(({ link }) => link), ['join-web-ts', 'web-ts-hooks'].map((name) => path.join(skillsDir, name)));
  assert.equal(fs.existsSync(skills), false);
});

test('install refuses a real directory or file at either destination before creating any link', () => {
  for (const link of links()) {
    for (const directory of [true, false]) {
      fs.mkdirSync(skills, { recursive: true });
      if (directory) fs.mkdirSync(link);
      else fs.writeFileSync(link, 'keep');
      assert.throws(() => install(), /refusing to replace real path/);
      assert.deepEqual(fs.readdirSync(skills), [path.basename(link)]);
      if (!directory) assert.equal(fs.readFileSync(link, 'utf8'), 'keep');
      fs.rmSync(link, { recursive: true });
    }
  }
});

test('install leaves a real directory alone when it is the running clone itself', () => {
  const installedRoot = path.join(skills, 'join-web-ts');
  fs.mkdirSync(path.join(installedRoot, 'hooks-plugin'), { recursive: true });
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
    for (const link of links()) {
      fs.symlinkSync(target, link);
      assert.throws(() => install(), (error) => error.message.includes(`${link} -> ${target}`) && error.message.includes('remove that link explicitly'));
      assert.equal(fs.readlinkSync(link), target);
      assert.deepEqual(fs.readdirSync(skills), [path.basename(link)]);
      fs.unlinkSync(link);
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
