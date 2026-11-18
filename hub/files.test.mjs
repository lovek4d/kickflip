import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { serveFiles, realFileUnder } from './files.mjs';

const root = path.join(home, 'served');
const outside = path.join(home, 'outside');
fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
fs.mkdirSync(path.join(outside, 'dir'), { recursive: true });
fs.writeFileSync(path.join(root, 'ok.txt'), 'inside');
fs.writeFileSync(path.join(root, 'sub', 'a.js'), 'inner');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
fs.writeFileSync(path.join(outside, 'x.js'), 'secret js');
fs.writeFileSync(path.join(outside, 'dir', 'index.html'), 'secret index');
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
fs.symlinkSync(path.join(outside, 'dir'), path.join(root, 'linkdir'));
fs.symlinkSync(path.join(outside, 'x.js'), path.join(root, 'asset.js'));
fs.mkdirSync(path.join(root, 'idx'));
fs.symlinkSync(path.join(outside, 'dir', 'index.html'), path.join(root, 'idx', 'index.html'));
fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'inlink'));

async function get(rest) {
  const out = { code: 0, body: '' };
  const res = { writeHead(code) { out.code = code; }, end(b) { out.body = b ? String(b) : ''; } };
  await serveFiles({ method: 'GET' }, res, { dir: root, rest, prefix: '/p' });
  return out;
}

test('a plain file under the root is served', async () => {
  assert.deepEqual(await get('/ok.txt'), { code: 200, body: 'inside' });
});
test('a file symlink out of the root is refused', async () => assert.equal((await get('/link.txt')).code, 404));
test('a directory symlink out of the root is refused, with or without its index', async () => {
  assert.equal((await get('/linkdir/')).code, 404);
  assert.equal((await get('/linkdir/index.html')).code, 404);
});
test('a symlinked index.html out of the root is refused', async () => assert.equal((await get('/idx/')).code, 404));
test('a .js asset symlinked out of the root is refused', async () => assert.equal((await get('/asset.js')).code, 404));
test('a symlink that stays inside the root is served', async () => {
  assert.deepEqual(await get('/inlink/a.js'), { code: 200, body: 'inner' });
});
test('realFileUnder follows a symlinked root and refuses a missing file', async () => {
  const via = path.join(home, 'via');
  fs.symlinkSync(root, via);
  assert.equal(await realFileUnder(via, path.join(via, 'ok.txt')), fs.realpathSync(path.join(root, 'ok.txt')));
  assert.equal(await realFileUnder(root, path.join(root, 'nope')), null);
});
