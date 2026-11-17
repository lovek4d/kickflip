import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';

const home = fs.realpathSync(tempDir('wave-names-'));
process.env.HOME = home;
const { MIGRATIONS, runMigrations } = await import('./migrations.mjs');
// The hub's wave-names migration through the runner, as a starting hub runs it. → the lines it logged
const migrateWaveNames = async () => { const lines = []; await runMigrations('hub', { list: MIGRATIONS.filter((m) => m.id === 'wave-names'), log: (l) => lines.push(l) }); return lines; };

const sites = path.join(home, '.claude', 'kickflip', 'sites');
const manifestFile = path.join(home, '.claude', 'kickflip', 'manifest.json');
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const board = (route) => ({ dir: path.join(sites, route), port: 4700, cmd: [process.execPath, path.join(home, 'kickflip', 'board', 'server.mjs'), path.join(sites, route)] });
const at = (route, ...p) => path.join(sites, route, ...p);

test("a starting hub renames every board's lineups to waves and its wave file to its item file once, keeping each card's key", async () => {
  write(manifestFile, { sites: { plain: board('plain'), hub: board('hub') }, migrated: ['hub-local'] });
  write(at('plain', 'board.json'), { title: 'Plain', items: 'data/wave.json' });
  write(at('plain', 'data', 'wave.json'), { items: [{ id: 'A1', title: 'One' }, { id: 'A2', title: 'Two' }], lineups: [{ slug: 'mon', title: 'Monitor', goal: 'Watch', phases: [['A1'], ['A2']] }] });
  write(at('plain', 'data', 'lineup-mon.md'), 'Why the wave\n');
  write(at('plain', 'data', 'owner.json'), { topics: [{ id: 'kept', title: 'Kept' }], items: [{ id: 'q1', topic: 'lineup:mon' }, { id: 'q2', topic: 'wave:wave' }, { id: 'q3', topic: 'item:wave/A1', question: 'lineup:mon stays inside a sentence' }] });
  write(at('plain', 'data', 'staged-questions.json'), { 'wave/A1': [{ id: 'q4', topic: 'lineup:mon' }] });
  write(at('plain', 'data', 'done-archive.json'), { cards: [{ key: 'wave/A0', wave: 'wave', closed_at: '2026-11-01T00:00:00Z', item: { id: 'A0', title: 'Zero' }, questions: [{ id: 'q5', topic: 'lineup:mon' }], asks: [] }] });
  write(at('plain', 'data', 'arch-reviews.json'), { reviews: [{ key: 'wave/A1', wave: 'mon', lineup: true, title: 'Architecture', at: '2026-11-01T00:00:00Z' }, { key: 'wave/A2', wave: 'wave', lineup: false, title: 'Older', at: '2026-10-01T00:00:00Z' }] });
  write(at('hub', 'board.json'), { title: 'Hub', items: 'data/wave.json', slug: 'hub' });
  write(at('hub', 'data', 'wave.json'), { items: [{ id: 'GH-1', title: 'One' }] });

  assert.deepEqual(await migrateWaveNames(), ['boards: lineups renamed to waves and wave files to item files on /plain, /hub']);

  assert.deepEqual(read(at('plain', 'board.json')), { title: 'Plain', items: 'data/items.json', slug: 'wave' });
  assert.equal(fs.existsSync(at('plain', 'data', 'wave.json')), false);
  const items = read(at('plain', 'data', 'items.json'));
  assert.deepEqual([items.waves, 'lineups' in items], [[{ slug: 'mon', title: 'Monitor', goal: 'Watch', phases: [['A1'], ['A2']] }], false]);
  assert.equal(fs.existsSync(at('plain', 'data', 'lineup-mon.md')), false);
  assert.equal(fs.readFileSync(at('plain', 'data', 'wave-mon.md'), 'utf8'), 'Why the wave\n');
  assert.deepEqual(read(at('plain', 'data', 'owner.json')).items.map((q) => q.topic), ['wave:mon', 'file:wave', 'item:wave/A1']);
  assert.equal(read(at('plain', 'data', 'owner.json')).items[2].question, 'lineup:mon stays inside a sentence');
  assert.deepEqual(read(at('plain', 'data', 'staged-questions.json')), { 'wave/A1': [{ id: 'q4', topic: 'wave:mon' }] });
  const [archived] = read(at('plain', 'data', 'done-archive.json')).cards;
  assert.deepEqual([archived.file, 'wave' in archived, archived.questions[0].topic], ['wave', false, 'wave:mon']);
  assert.deepEqual(read(at('plain', 'data', 'arch-reviews.json')).reviews.map(({ key, wave, file }) => ({ key, wave, file })),
    [{ key: 'wave/A1', wave: 'mon', file: undefined }, { key: 'wave/A2', wave: undefined, file: 'wave' }]);

  assert.deepEqual(read(at('hub', 'board.json')), { title: 'Hub', items: 'data/items.json', slug: 'hub' });
  assert.deepEqual(read(at('hub', 'data', 'items.json')).items, [{ id: 'GH-1', title: 'One' }]);
  assert.deepEqual(read(manifestFile).migrated, ['hub-local', 'wave-names']);

  write(at('plain', 'data', 'items.json'), { items: [], lineups: [{ slug: 'again' }] });
  assert.deepEqual(await migrateWaveNames(), []);
  assert.deepEqual(read(at('plain', 'data', 'items.json')).lineups, [{ slug: 'again' }]);
});
