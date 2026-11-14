import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';

const home = fs.realpathSync(tempDir('cellar-node-'));
process.env.HOME = home;
const { migrateCellarNode } = await import('./boards.mjs');
const { saveJSON, readManifest } = await import('./boards.mjs');
const { hubService } = await import('../shared/service.mjs');
const manifestFile = path.join(home, '.claude', 'kickflip', 'manifest.json');
const link = path.join(home, 'node-link');
fs.writeFileSync(link, '');
const cellar = '/opt/homebrew/Cellar/node/26.12.0/bin/node';
const keg = '/opt/homebrew/Cellar/node@22/22.1.0/bin/node';

test('a stored Cellar node in a site cmd and the login item file becomes the Homebrew link; others stay', async () => {
  saveJSON(manifestFile, { sites: {
    stale: { dir: '/a', cmd: [cellar, '/a/server.mjs'] },
    keg: { dir: '/b', cmd: [keg, '/b/server.mjs'] },
    nvm: { dir: '/c', cmd: ['/Users/x/.nvm/versions/node/v24/bin/node', '/c/server.mjs'] },
  } });
  const service = hubService({ home, platform: 'darwin' });
  fs.mkdirSync(path.dirname(service.file), { recursive: true });
  fs.writeFileSync(service.file, `<string>${cellar}</string><string>/opt/homebrew/Cellar/node/26.12.0/bin:/usr/bin</string><string>${keg}</string>`);
  const done = await migrateCellarNode({ link, file: service.file });
  assert.deepEqual(done, { routes: ['stale'], loginItem: true });
  const { sites } = readManifest();
  assert.deepEqual(sites.stale.cmd, [link, '/a/server.mjs']);
  assert.deepEqual(sites.keg.cmd, [keg, '/b/server.mjs']);
  assert.equal(sites.nvm.cmd[0], '/Users/x/.nvm/versions/node/v24/bin/node');
  assert.equal(fs.readFileSync(service.file, 'utf8'), `<string>${link}</string><string>${path.dirname(link)}:/usr/bin</string><string>${keg}</string>`);
  assert.deepEqual(await migrateCellarNode({ link, file: service.file }), { routes: [], loginItem: false });
});

test('with no Homebrew link nothing is rewritten, and a missing login item file is fine', async () => {
  saveJSON(manifestFile, { sites: { stale: { dir: '/a', cmd: [cellar, '/a/server.mjs'] } } });
  assert.deepEqual(await migrateCellarNode({ link: path.join(home, 'missing'), file: path.join(home, 'none.plist') }), { routes: [], loginItem: false });
  assert.equal(readManifest().sites.stale.cmd[0], cellar);
});
