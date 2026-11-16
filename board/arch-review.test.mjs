import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBoard } from '../shared/test-helpers.mjs';
import { REVIEW_SKILLS } from '../shared/skills.mjs';

const serverFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');

const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
// The server's clock, which names each review.
const today = new Date(2026, 10, 13, 12);
const stamp = '20261113';
const title = 'Architecture Nov 13';

// A board over the scratch HOME, emptied for each test, with the board in the hub's manifest, run in process.
async function boardServer(t, { items = 'data/items.json', site: entry = {}, skills = true } = {}) {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  const site = path.join(home, '.claude', 'kickflip', 'sites', 'app');
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'App', items, slug: 'app' }));
  fs.writeFileSync(path.join(site, 'data', 'owner.json'), '{"items":[]}');
  fs.writeFileSync(path.join(site, 'data', 'items.json'), JSON.stringify({ title: 'App', items: [{ id: 'INT-7', title: 'Older', lane: 'done', closed_at: '2026-11-01T10:00:00Z' }, { id: 'GC', title: 'Lettered', phase: 'discussing' }] }));
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'manifest.json'), JSON.stringify({ sites: {
    app: { dir: site, cmd: ['node', serverFile], github: 'owner/app-repo', branch: 'main', owner: { session: 's1', repo: path.join(home, 'repos', 'app-repo') }, ...entry },
  } }));
  if (skills) for (const name of REVIEW_SKILLS) {
    fs.mkdirSync(path.join(home, '.claude', 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  const { base, changed, settled } = await startBoard(t, { site, now: () => today });
  return {
    home, site, base,
    // A write to the site's file, told to the server as a store write is.
    sees: async (file) => { changed(file); await settled(); },
    // The hub's check of each PR, as board/server.mjs reads it (hub/github.mjs summarize).
    checked: (prs) => fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'github-state.json'), JSON.stringify({ prs })),
    arch: async () => (await (await fetch(`${base}/api/board`)).json()).arch,
    run: async () => { const r = await fetch(`${base}/api/arch-review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: r.status, body: await r.json() }; },
    events: () => (fs.existsSync(path.join(site, 'data', 'events.jsonl')) ? fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
  };
}

test('Run makes the audit card, wakes the session, and while that review is open runs again only point at its card; built counts its Children that landed', async (t) => {
  const b = await boardServer(t);
  assert.deepEqual(await b.arch(), { repo: 'app-repo', waits: null, last: null });

  const first = await b.run();
  assert.equal(first.status, 200);
  assert.equal(first.body.key, 'app/T-1');
  const itemFile = readJSON(path.join(b.site, 'data', 'items.json'));
  assert.deepEqual(itemFile.items.at(-1).title, 'Architecture review of app-repo');
  assert.equal('waves' in itemFile, false);
  assert.match(fs.readFileSync(path.join(b.site, 'data', 'threads', 'app__T-1.jsonl'), 'utf8'), /Started an architecture review of app-repo; its report becomes the notes/);
  const [event] = b.events();
  assert.equal(event.id, first.body.id);
  assert.deepEqual([event.kind, event.data], ['arch-review', { key: 'app/T-1', repo: path.join(b.home, 'repos', 'app-repo'), github: 'owner/app-repo', branch: 'main' }]);
  let { last } = await b.arch();
  assert.deepEqual(last, { key: 'app/T-1', ref: 'T-1', title, at: last.at, open: true, running: true, findings: 0, built: 0 });

  const again = await b.run();
  assert.deepEqual(again, { status: 200, body: { key: 'app/T-1', ref: 'T-1', existing: true } });
  assert.equal(b.events().length, 1);

  const owner = { items: [{ id: 'f1', topic: 'item:app/T-1', question: 'Split the store?', options: [{ id: 'A', label: 'Split' }, { id: 'skip', label: 'Skip' }] },
    { id: 'f2', topic: 'item:app/T-1', question: 'Merge the readers?', options: [{ id: 'A', label: 'Merge' }, { id: 'skip', label: 'Skip' }] }] };
  fs.writeFileSync(path.join(b.site, 'data', 'owner.json'), JSON.stringify(owner));
  await b.sees('data/owner.json');
  ({ last } = await b.arch());
  assert.deepEqual([last.open, last.running, last.findings], [true, false, 2]);

  const done = readJSON(path.join(b.site, 'data', 'items.json'));
  Object.assign(done.items.find((it) => it.id === 'T-1'), { lane: 'done', closed_at: new Date().toISOString() });
  // INT-10 never landed: its one PR closed unmerged, so it isn't built.
  b.checked({ 'owner/app-repo#10': { state: 'CLOSED', isDraft: false, checks: { total: 0, fail: 0, pending: 0, state: 'none' }, reviews: {} } });
  done.items.push({ id: 'INT-9', title: 'Split the store', lane: 'done', closed_at: new Date().toISOString(), parent: 'app/T-1' },
    { id: 'INT-10', title: 'Merge the readers', lane: 'done', closed_at: new Date().toISOString(), prs: [{ number: 10 }], parent: 'app/T-1' });
  fs.writeFileSync(path.join(b.site, 'data', 'items.json'), JSON.stringify(done));
  await b.sees('data/items.json');
  ({ last } = await b.arch());
  assert.deepEqual([last.open, last.running, last.findings, last.built], [false, false, 2, 1]);

  const next = await b.run();
  assert.deepEqual([next.status, next.body.key, next.body.existing], [200, 'app/T-2', false]);
  assert.equal((await b.arch()).last.built, 0);
});

test('arch file files each answered finding as a Child of the audit card that waits on it, resolves skips, and closes the audit once every finding is settled', async (t) => {
  const b = await boardServer(t);
  assert.equal((await b.run()).status, 200);
  const option = (label, extra = {}) => ({ id: 'A', label, ...extra });
  const finding = (id, question, label, extra) => ({ id, topic: 'item:app/T-1', question, options: [option(label, extra), { id: 'skip', label: 'Skip' }] });
  fs.writeFileSync(path.join(b.site, 'data', 'owner.json'), JSON.stringify({ items: [
    finding('f1', 'Split the store?', 'Split the store', { detail: 'Move the readers out.', practice: ['Readers own their files.'] }),
    finding('f2', 'Merge the readers?', 'Merge the readers'),
    finding('f3', 'Drop the cache?', 'Drop the cache'),
  ] }));
  const answer = (id, choice, note = '') => fs.appendFileSync(path.join(b.site, 'data', 'events.jsonl'), JSON.stringify({ id: `answer-${id}`, ts: new Date().toISOString(), kind: 'owner-answer', data: { id, choice, note } }) + '\n');
  const file = () => {
    const r = spawnSync(process.execPath, [path.join(path.dirname(serverFile), 'bin', 'board.mjs'), '--site', 'app', 'arch', 'file', 'app/T-1'], { env: { ...process.env, HOME: b.home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split('\n');
  };
  const itemFile = () => readJSON(path.join(b.site, 'data', 'items.json'));
  const resolved = () => Object.fromEntries(readJSON(path.join(b.site, 'data', 'owner.json')).items.map((q) => [q.id, q.resolved]));
  answer('f1', 'A', 'Keep the API.');
  answer('f2', 'skip');
  assert.deepEqual(file(), ['findings of T-1 filed', 'filed: T-2 from f1', 'skipped: f2', 'waiting: f3']);
  const filed = itemFile().items.find((it) => it.id === 'T-2');
  assert.deepEqual([filed.title, fs.readFileSync(path.join(b.site, 'data', filed.plan), 'utf8'), filed.deps, filed.parent], ['Split the store', "# Split the store\n\nMove the readers out.\n\n- Readers own their files.\n\nOwner's note: Keep the API.\n\nFrom the finding: Split the store?\n", ['T-1'], 'app/T-1']);
  assert.deepEqual(resolved(), { f1: 'Filed as T-2.', f2: 'Skipped.', f3: undefined });
  answer('f3', 'A');
  assert.deepEqual(file().slice(0, 2), ['findings of T-1 filed', 'filed: T-3 from f3']);
  const third = itemFile().items.find((it) => it.id === 'T-3');
  assert.deepEqual([third.deps, third.parent, 'waves' in itemFile()], [['T-1'], 'app/T-1', false]);
  const audit = itemFile().items.find((it) => it.id === 'T-1');
  assert.equal(audit.lane, 'done');
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.site, 'data', 'threads', 'app__T-1.jsonl'), 'utf8').trim().split('\n').at(-1)).text, 'Every finding is settled: filed T-2, T-3.');
});

test('a review waits, saying why, while the mattpocock skills are missing', async (t) => {
  const b = await boardServer(t, { skills: false });
  const { waits } = await b.arch();
  assert.equal(waits, 'Architecture reviews wait on improve-codebase-architecture, codebase-design, grilling and prototype from mattpocock/skills, which aren’t installed. Run kickflip doctor --fix on the host to add them.');
  assert.deepEqual(await b.run(), { status: 409, body: { error: waits } });
  assert.deepEqual(b.events(), []);
  assert.equal(readJSON(path.join(b.site, 'data', 'items.json')).items.length, 2);
});

test("a board on the kickflip clone, as the hub board is, names its review's scope: the clone's code and model, and the live data's shapes", async (t) => {
  const b = await boardServer(t, { site: { hub: true, local: true, owner: { session: 's1', repo: path.resolve(serverFile, '..', '..') } } });
  assert.equal((await b.run()).status, 200);
  const { data } = b.events()[0];
  assert.deepEqual(data.scope.paths, ['hub/', 'board/', 'shared/', 'CONTEXT.md', 'docs/adr/']);
  assert.ok(data.scope.data.includes('~/.claude/kickflip/manifest.json'));
  assert.equal(data.repo, path.resolve(serverFile, '..', '..'));
});

test('on a board over ~/.claude/waves the review is an item file of its own', async (t) => {
  const b = await boardServer(t, { items: 'waves' });
  const r = await b.run();
  assert.deepEqual([r.status, r.body.key], [200, `arch-${stamp}/audit`]);
  const wave = readJSON(path.join(b.home, '.claude', 'waves', `arch-${stamp}`, 'wave.json'));
  assert.deepEqual([wave.title, wave.repo, wave.items.map((it) => it.title)], [title, 'owner/app-repo', ['Architecture review of app-repo']]);
  assert.equal(b.events()[0].data.file, `arch-${stamp}`);
  assert.equal((await b.arch()).last.running, true);
});
