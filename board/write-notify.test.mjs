import { home } from '../shared/scratch-home.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { freePorts } from '../shared/test-helpers.mjs';

// docs/adr/2026-11-16-0312-a-store-write-tells-its-board-server.md
// A board server here runs with no file watch, so it hears a write only by the store's notification.
const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(SKILL, 'board', 'bin', 'board.mjs');
const manifestFile = path.join(home, '.claude', 'kickflip', 'manifest.json');
const siteOf = (route) => path.join(home, '.claude', 'kickflip', 'sites', route);
const run = promisify(execFile);
let store, startServer;
const servers = [];

function makeSite(route) {
  const site = siteOf(route);
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: route, items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(site, 'data', 'items.json'), JSON.stringify({ items: [{ id: 'a', title: 'feat(board): seed', lane: 'todo' }] }));
  fs.writeFileSync(path.join(site, 'data', 'owner.json'), '{"items":[]}');
  return site;
}
function writeManifest(sites) {
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify({ sites: Object.fromEntries(Object.entries(sites).map(([route, port]) =>
    [route, { dir: siteOf(route), port, cmd: [process.execPath, path.join(SKILL, 'board', 'server.mjs'), siteOf(route)] }])) }));
}
async function serve(route) {
  const site = makeSite(route);
  const board = await startServer({ site, signedIn: () => true });
  servers.push(board);
  await board.settled();
  return { site, board, base: `http://127.0.0.1:${board.server.address().port}` };
}
const titles = async (base) => (await (await fetch(`${base}/api/board`)).json()).items.map((i) => i.title);

before(async () => {
  process.env.KICKFLIP_CLAUDE = 'true';
  process.env.KICKFLIP_CODEX = 'true';
  store = await import('./store.mjs');
  ({ startServer } = await import('./server.mjs'));
});
after(async () => { for (const b of servers) await b.close(); });

test('a CLI write reaches its board server by a POST to the port in the manifest, with no file watch', async () => {
  const { base, board } = await serve('cli');
  writeManifest({ cli: board.server.address().port });
  assert.deepEqual(await titles(base), ['feat(board): seed']);
  await run(process.execPath, [CLI, '--site', 'cli', 'item', 'add', 't', '--title', 'feat(board): heard by notification', '--relate', 't/a', '--blocked', '--notes', 'Filed by a test.'], { env: { ...process.env, HOME: home } });
  // The CLI ends only once its POSTs are answered, and the server signals before it answers.
  await board.settled();
  assert.ok((await titles(base)).includes('feat(board): heard by notification'));
});

test("a write in the board server's own process reaches it with no POST", async () => {
  const { site, base, board } = await serve('inproc');
  // The manifest names no port for this board, so only the in-process notification can reach it.
  writeManifest({});
  assert.deepEqual(await titles(base), ['feat(board): seed']);
  await store.addItem(site, 't', { title: 'feat(board): heard in process' });
  await board.settled();
  assert.ok((await titles(base)).includes('feat(board): heard in process'));
});

test("a write to an item file outside the board's data/ is told to its board's port", async () => {
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const items = path.join(repo, 'items.json');
  fs.writeFileSync(items, JSON.stringify({ items: [{ id: 'a', title: 'feat(board): seed', lane: 'todo' }] }));
  const site = makeSite('repo-held');
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'repo-held', items, slug: 't' }));
  // A stand-in for the board's server, recording each file it is told of.
  const told = [];
  const stand = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    told.push({ path: req.url, file: JSON.parse(body).file });
    res.writeHead(204).end();
  });
  stand.listen(0, '127.0.0.1');
  await once(stand, 'listening');
  try {
    writeManifest({ 'repo-held': stand.address().port });
    await run(process.execPath, [CLI, '--site', 'repo-held', 'item', 'add', 't', '--title', 'feat(board): told from the repo', '--relate', 't/a', '--blocked', '--notes', 'Filed by a test.'], { env: { ...process.env, HOME: home } });
    assert.ok(told.some((t) => t.path === '/_claude/changed' && t.file === items), `told ${JSON.stringify(told)}`);
  } finally { stand.close(); }
});

test('a write whose board server is down succeeds', async () => {
  makeSite('down');
  const [port] = await freePorts();
  writeManifest({ down: port });
  const { stdout } = await run(process.execPath, [CLI, '--site', 'down', 'item', 'add', 't', '--title', 'feat(board): no one listening', '--relate', 't/a', '--blocked', '--notes', 'Filed by a test.'], { env: { ...process.env, HOME: home } });
  assert.match(stdout, /t\//);
  assert.ok(JSON.parse(fs.readFileSync(path.join(siteOf('down'), 'data', 'items.json'), 'utf8')).items.some((i) => i.title === 'feat(board): no one listening'));
});
