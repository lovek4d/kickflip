import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tempDir } from '../shared/temp-dir.mjs';

// docs/adr/2026-11-17-0601-migrations-run-once-per-ledger-from-one-list.md
const home = fs.realpathSync(tempDir('migration-ledger-'));
process.env.HOME = home;
const { MIGRATIONS, runMigrations, migrationsLeft } = await import('./migrations.mjs');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sites = path.join(home, '.claude', 'kickflip', 'sites');
const manifestFile = path.join(home, '.claude', 'kickflip', 'manifest.json');
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const board = (route) => ({ dir: path.join(sites, route), port: 4700, cmd: [process.execPath, path.join(home, 'kickflip', 'board', 'server.mjs'), path.join(sites, route)] });
const ledger = (route) => path.join(sites, route, 'data', 'migrated.json');
const quiet = () => { const lines = []; const errors = []; return { lines, errors, log: (l) => lines.push(l), error: (...e) => errors.push(e.join(' ')) }; };

// A migration that counts its runs, or throws while fail() says so.
const counted = (id, scope, { lines = [], fail = () => false } = {}) => {
  const m = { id, scope, runs: 0, run: async (ctx) => { m.runs++; m.ctx = ctx; if (fail()) throw new Error(`${id} broke`); return lines; } };
  return m;
};

test('a board runs each board migration once, recording its id in data/migrated.json, and skips what its ledger lists', async () => {
  const site = path.join(sites, 'once');
  const one = counted('one', 'board', { lines: ['one: 2 tasks moved'] });
  const two = counted('two', 'board');
  const hubOnly = counted('hub-only', 'hub');
  const list = [one, hubOnly, two];
  const out = quiet();

  assert.deepEqual(await runMigrations('board', { site, archived: 'reader', list, ...out }), ['one', 'two']);
  assert.deepEqual([one.runs, two.runs, hubOnly.runs], [1, 1, 0]);
  assert.deepEqual([one.ctx.site, one.ctx.archived], [site, 'reader']);
  assert.deepEqual(out.lines, ['one: 2 tasks moved']);
  assert.deepEqual(read(ledger('once')), { migrated: ['one', 'two'] });

  assert.deepEqual(await runMigrations('board', { site, list, ...out }), []);
  assert.deepEqual([one.runs, two.runs], [1, 1]);
});

test("a board migration that throws is reported and left off the ledger, the next still runs, and it runs again at the next start", async () => {
  const site = path.join(sites, 'broken');
  let broken = true;
  const bad = counted('bad', 'board', { fail: () => broken });
  const after = counted('after', 'board');
  const out = quiet();

  assert.deepEqual(await runMigrations('board', { site, list: [bad, after], ...out }), ['after']);
  assert.deepEqual(out.errors, ['bad migration failed: bad broke']);
  assert.deepEqual(read(ledger('broken')).migrated, ['after']);

  broken = false;
  assert.deepEqual(await runMigrations('board', { site, list: [bad, after], ...out }), ['bad']);
  assert.deepEqual([bad.runs, after.runs], [2, 1]);
  assert.deepEqual(read(ledger('broken')).migrated, ['after', 'bad']);
});

test("the hub runs each hub migration once on the manifest it holds locked, recording its id in the manifest's migrated list", async () => {
  write(manifestFile, { sites: { a: board('a') }, migrated: ['older'] });
  const mark = { id: 'mark', scope: 'hub', run: async ({ manifest }) => { manifest.sites.a.marked = true; return ['manifest: /a marked']; } };
  const boardOnly = counted('board-only', 'board');
  const out = quiet();

  assert.deepEqual(await runMigrations('hub', { list: [mark, boardOnly], ...out }), ['mark']);
  assert.deepEqual([read(manifestFile).sites.a.marked, read(manifestFile).migrated, boardOnly.runs], [true, ['older', 'mark'], 0]);
  assert.deepEqual(out.lines, ['manifest: /a marked']);

  const again = counted('mark', 'hub');
  assert.deepEqual(await runMigrations('hub', { list: [again], ...out }), []);
  assert.equal(again.runs, 0);
});

test('a hub with no boards in its manifest runs no hub migration and records none, so the first board it gets runs them', async () => {
  fs.rmSync(manifestFile, { force: true });
  const m = counted('first', 'hub');
  assert.deepEqual(await runMigrations('hub', { list: [m], ...quiet() }), []);
  assert.deepEqual([m.runs, fs.existsSync(manifestFile)], [0, false]);
});

test('migrationsLeft names, for each migration, the boards whose ledger lacks it, closed ones included, and the hub while the manifest does', async () => {
  write(manifestFile, { sites: { a: board('a'), b: board('b') }, closed: { old: { site: board('old'), title: 'Old', closed_at: '2026-11-01T00:00:00Z' } }, migrated: ['h1'] });
  write(ledger('a'), { migrated: ['b1', 'b2', 'b3'] });
  write(ledger('b'), { migrated: ['b1', 'b3'] });
  write(ledger('old'), { migrated: ['b1', 'b2'] });
  const list = [{ id: 'h1', scope: 'hub' }, { id: 'h2', scope: 'hub' }, { id: 'b1', scope: 'board' }, { id: 'b2', scope: 'board' }, { id: 'b3', scope: 'board' }];
  assert.deepEqual(await migrationsLeft(list), [
    { id: 'h1', scope: 'hub', left: [] },
    { id: 'h2', scope: 'hub', left: ['hub'] },
    { id: 'b1', scope: 'board', left: [] },
    { id: 'b2', scope: 'board', left: ['b'] },
    { id: 'b3', scope: 'board', left: ['old (closed)'] },
  ]);
});

test("the migration list has one entry per id, each a hub or board one, and a fresh board runs every board one once", async () => {
  assert.equal(new Set(MIGRATIONS.map((m) => m.id)).size, MIGRATIONS.length);
  assert.deepEqual(MIGRATIONS.filter((m) => !['hub', 'board'].includes(m.scope) || typeof m.run !== 'function'), []);
  const site = path.join(sites, 'fresh');
  write(path.join(site, 'board.json'), { title: 'Fresh', items: 'data/items.json', slug: 'fresh' });
  write(path.join(site, 'data', 'items.json'), { items: [] });
  const out = quiet();
  const boardIds = MIGRATIONS.filter((m) => m.scope === 'board').map((m) => m.id);
  assert.deepEqual(await runMigrations('board', { site, ...out }), boardIds);
  assert.deepEqual([out.errors, read(ledger('fresh')).migrated], [[], boardIds]);
});

test('the board server and the hub run their migrations only through runMigrations', () => {
  const server = fs.readFileSync(path.join(root, 'board', 'server.mjs'), 'utf8');
  const hub = fs.readFileSync(path.join(root, 'hub', 'hub.mjs'), 'utf8');
  assert.match(server, /runMigrations\('board'/);
  assert.match(hub, /runMigrations\('hub'/);
  for (const name of ['migrateFollowups', 'migrateStatuses', 'migratePhases', 'clearBuildPhases', 'migrateCreated', 'migrateGates', 'discussNewCards',
    'stageImplementAsks', 'splitSharedNotes', 'stripDeadFields']) assert.doesNotMatch(server, new RegExp(`\\b${name}\\b`), name);
  for (const name of ['migrateBoardRepos', 'migrateHubBoard', 'migrateWaveNames', 'migrateDropWaves']) assert.doesNotMatch(hub, new RegExp(`\\b${name}\\b`), name);
});

test('kickflip migrations prints each migration with the ledgers that lack it, the evidence its code can go', async () => {
  write(manifestFile, { sites: { a: board('a'), b: board('b') }, migrated: MIGRATIONS.filter((m) => m.scope === 'hub').map((m) => m.id) });
  const boardIds = MIGRATIONS.filter((m) => m.scope === 'board').map((m) => m.id);
  write(ledger('a'), { migrated: boardIds });
  write(ledger('b'), { migrated: boardIds.slice(1) });
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'kickflip.mjs'), 'migrations'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, MIGRATIONS.length);
  assert.equal(lines.find((l) => l.startsWith(`${boardIds[0]} `)), `${boardIds[0]} (board): not yet on /b`);
  assert.equal(lines.find((l) => l.startsWith('wave-names ')), 'wave-names (hub): every ledger lists it');
});
