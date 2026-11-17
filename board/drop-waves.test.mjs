import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';

const home = fs.realpathSync(tempDir('drop-waves-'));
process.env.HOME = home;
const { MIGRATIONS, runMigrations } = await import('./migrations.mjs');
// The hub's drop-waves migration through the runner, as a starting hub runs it. → the lines it logged
const migrateDropWaves = async () => { const lines = []; await runMigrations('hub', { list: MIGRATIONS.filter((m) => m.id === 'drop-waves'), log: (l) => lines.push(l) }); return lines; };

const sites = path.join(home, '.claude', 'kickflip', 'sites');
const manifestFile = path.join(home, '.claude', 'kickflip', 'manifest.json');
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const board = (route) => ({ dir: path.join(sites, route), port: 4700, cmd: [process.execPath, path.join(home, 'kickflip', 'board', 'server.mjs'), path.join(sites, route)] });
const at = (route, ...p) => path.join(sites, route, ...p);

// docs/adr/2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping.md
test("a starting hub drops every board's waves once: a wave:<slug> dep becomes the cards the wave held, and each card keeps its deps, Parent and Related to", async () => {
  write(manifestFile, { sites: { hub: board('hub'), plain: board('plain') }, migrated: ['wave-names'] });
  write(at('hub', 'board.json'), { title: 'Hub', items: 'data/items.json', slug: 'hub' });
  const items = [
    { id: 'A1', title: 'One' },
    { id: 'A2', title: 'Two', deps: ['A1'], parent: 'hub/A0', related: ['hub/A3'] },
    { id: 'A3', title: 'Three', deps: ['wave:mon', 'A2'] },
    { id: 'A4', title: 'Four', deps: ['wave:steps'] },
  ];
  write(at('hub', 'data', 'items.json'), { title: 'Hub', items, waves: [
    { slug: 'mon', title: 'Monitor', goal: 'G', items: ['A1', 'A2'], created: '2026-11-01T00:00:00Z' },
    { slug: 'steps', title: 'Steps', goal: 'G', phases: [['A1'], ['A3']] },
  ] });
  write(at('plain', 'board.json'), { title: 'Plain', items: 'data/items.json', slug: 'p' });
  write(at('plain', 'data', 'items.json'), { items: [{ id: 'P1', title: 'Plain' }] });
  const plainBefore = fs.readFileSync(at('plain', 'data', 'items.json'), 'utf8');

  assert.deepEqual(await migrateDropWaves(), ['boards: waves dropped on /hub']);
  const after = read(at('hub', 'data', 'items.json'));
  assert.equal('waves' in after, false);
  assert.deepEqual(after.items, [
    { id: 'A1', title: 'One' },
    { id: 'A2', title: 'Two', deps: ['A1'], parent: 'hub/A0', related: ['hub/A3'] },
    { id: 'A3', title: 'Three', deps: ['A1', 'A2'] },
    { id: 'A4', title: 'Four', deps: ['A1', 'A3'] },
  ]);
  assert.equal(fs.readFileSync(at('plain', 'data', 'items.json'), 'utf8'), plainBefore, 'a board with no waves is left as it is');
  assert.deepEqual(read(manifestFile).migrated, ['wave-names', 'drop-waves']);

  // Once: a waves record written after it is left for no one to read.
  write(at('hub', 'data', 'items.json'), { ...after, waves: [{ slug: 'late', title: 'Late', goal: 'G', items: ['A1'] }] });
  assert.deepEqual(await migrateDropWaves(), []);
  assert.equal(read(at('hub', 'data', 'items.json')).waves.length, 1);
});
