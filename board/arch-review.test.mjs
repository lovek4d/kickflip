import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, boardListening, until } from '../shared/test-helpers.mjs';
import { REVIEW_SKILLS } from '../shared/skills.mjs';

const serverFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
const children = [];
after(() => { for (const child of children) child.kill(); });

const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const today = new Date();
const stamp = today.toLocaleDateString('en-CA').replaceAll('-', '');
const title = `Architecture ${today.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

async function boardServer({ items = 'data/items.json', site: entry = {}, skills = true } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arch-review-')));
  const site = path.join(home, '.claude', 'kickflip', 'sites', 'app');
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'App', items, slug: 'app' }));
  fs.writeFileSync(path.join(site, 'data', 'owner.json'), '{"items":[]}');
  fs.writeFileSync(path.join(site, 'data', 'items.json'), JSON.stringify({ title: 'App', items: [{ id: 'INT-7', title: 'Older', lane: 'done', closed_at: '2026-11-01T10:00:00Z' }, { id: 'GC', title: 'Lettered' }] }));
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'manifest.json'), JSON.stringify({ sites: {
    app: { dir: site, cmd: ['node', serverFile], github: 'owner/app-repo', branch: 'main', owner: { session: 's1', repo: path.join(home, 'repos', 'app-repo') }, ...entry },
  } }));
  if (skills) for (const name of REVIEW_SKILLS) {
    fs.mkdirSync(path.join(home, '.claude', 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  const [port] = await freePorts();
  // gh answers the server's pr view from <gh>/<n>.json, and fails for a PR with none.
  const gh = path.join(home, 'fake-gh');
  fs.mkdirSync(gh);
  fs.writeFileSync(path.join(gh, 'gh'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst [cmd, verb, n] = process.argv.slice(2);\nconst file = ${JSON.stringify(gh)} + '/' + n + '.json';\nif (cmd !== 'pr' || verb !== 'view' || !fs.existsSync(file)) process.exit(1);\nprocess.stdout.write(fs.readFileSync(file, 'utf8'));\n`);
  fs.chmodSync(path.join(gh, 'gh'), 0o755);
  const child = spawn(process.execPath, [serverFile, site], { env: { ...process.env, HOME: home, PORT: String(port), PATH: `${gh}:${process.env.PATH}` } });
  children.push(child);
  await boardListening(child);
  const base = `http://127.0.0.1:${port}`;
  return {
    home, site, base, gh,
    arch: async () => (await (await fetch(`${base}/api/board`)).json()).arch,
    run: async () => { const r = await fetch(`${base}/api/arch-review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: r.status, body: await r.json() }; },
    events: () => (fs.existsSync(path.join(site, 'data', 'events.jsonl')) ? fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
  };
}

test('Run makes a wave whose first card is the audit, wakes the session, and while that review is open runs again only point at its card', async () => {
  const b = await boardServer();
  assert.deepEqual(await b.arch(), { repo: 'app-repo', waits: null, last: null });

  const first = await b.run();
  assert.equal(first.status, 200);
  assert.equal(first.body.key, 'app/INT-1');
  const itemFile = readJSON(path.join(b.site, 'data', 'items.json'));
  assert.deepEqual(itemFile.items.at(-1).title, 'Architecture review of app-repo');
  assert.deepEqual(itemFile.waves.map((l) => [l.slug, l.title, l.phases]), [[`arch-${stamp}`, title, [['INT-1']]]]);
  assert.match(fs.readFileSync(path.join(b.site, 'data', 'threads', 'app__INT-1.jsonl'), 'utf8'), /Started an architecture review of app-repo; its report becomes the notes/);
  const [event] = b.events();
  assert.equal(event.id, first.body.id);
  assert.deepEqual([event.kind, event.data], ['arch-review', { key: 'app/INT-1', repo: path.join(b.home, 'repos', 'app-repo'), github: 'owner/app-repo', branch: 'main', wave: `arch-${stamp}` }]);
  let { last } = await b.arch();
  assert.deepEqual(last, { key: 'app/INT-1', ref: 'INT-1', wave: title, at: last.at, open: true, running: true, findings: 0, built: 0 });

  const again = await b.run();
  assert.deepEqual(again, { status: 200, body: { key: 'app/INT-1', ref: 'INT-1', existing: true } });
  assert.equal(b.events().length, 1);

  const owner = { items: [{ id: 'f1', topic: 'item:app/INT-1', question: 'Split the store?', options: [{ id: 'A', label: 'Split' }, { id: 'skip', label: 'Skip' }] },
    { id: 'f2', topic: 'item:app/INT-1', question: 'Merge the readers?', options: [{ id: 'A', label: 'Merge' }, { id: 'skip', label: 'Skip' }] }] };
  // Each wait is for the review itself, not any new version: the server marking new cards read moves the version too.
  fs.writeFileSync(path.join(b.site, 'data', 'owner.json'), JSON.stringify(owner));
  await until(async () => ({ last } = await b.arch()).last.findings === 2, "the board sees the review's findings");
  assert.deepEqual([last.open, last.running, last.findings], [true, false, 2]);

  const done = readJSON(path.join(b.site, 'data', 'items.json'));
  Object.assign(done.items.find((it) => it.id === 'INT-1'), { lane: 'done', closed_at: new Date().toISOString() });
  // INT-10 never landed: its one PR closed unmerged, so it isn't built.
  fs.writeFileSync(path.join(b.gh, '10.json'), JSON.stringify({ number: 10, state: 'CLOSED', isDraft: false, statusCheckRollup: [], latestReviews: [] }));
  done.items.push({ id: 'INT-9', title: 'Split the store', lane: 'done', closed_at: new Date().toISOString() }, { id: 'INT-10', title: 'Merge the readers', lane: 'done', closed_at: new Date().toISOString(), prs: [{ number: 10 }] });
  done.waves[0].phases.push(['INT-9'], ['INT-10']);
  fs.writeFileSync(path.join(b.site, 'data', 'items.json'), JSON.stringify(done));
  await until(async () => ({ last } = await b.arch()).last.open === false, 'the board sees the review closed');
  assert.deepEqual([last.open, last.running, last.findings, last.built], [false, false, 2, 1]);

  const next = await b.run();
  assert.deepEqual([next.status, next.body.key, next.body.existing], [200, 'app/INT-2', false]);
  assert.equal(readJSON(path.join(b.site, 'data', 'items.json')).waves.at(-1).slug, `arch-${stamp}-2`);
});

test('arch file files each answered finding as a card in the review, resolves skips, and closes the audit once every finding is settled', async () => {
  const b = await boardServer();
  assert.equal((await b.run()).status, 200);
  const option = (label, extra = {}) => ({ id: 'A', label, ...extra });
  const finding = (id, question, label, extra) => ({ id, topic: 'item:app/INT-1', question, options: [option(label, extra), { id: 'skip', label: 'Skip' }] });
  fs.writeFileSync(path.join(b.site, 'data', 'owner.json'), JSON.stringify({ items: [
    finding('f1', 'Split the store?', 'Split the store', { detail: 'Move the readers out.', practice: ['Readers own their files.'] }),
    finding('f2', 'Merge the readers?', 'Merge the readers'),
    finding('f3', 'Drop the cache?', 'Drop the cache'),
  ] }));
  const answer = (id, choice, note = '') => fs.appendFileSync(path.join(b.site, 'data', 'events.jsonl'), JSON.stringify({ id: `answer-${id}`, ts: new Date().toISOString(), kind: 'owner-answer', data: { id, choice, note } }) + '\n');
  const file = () => {
    const r = spawnSync(process.execPath, [path.join(path.dirname(serverFile), 'bin', 'board.mjs'), '--site', 'app', 'arch', 'file', 'app/INT-1'], { env: { ...process.env, HOME: b.home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split('\n');
  };
  const itemFile = () => readJSON(path.join(b.site, 'data', 'items.json'));
  const resolved = () => Object.fromEntries(readJSON(path.join(b.site, 'data', 'owner.json')).items.map((q) => [q.id, q.resolved]));
  answer('f1', 'A', 'Keep the API.');
  answer('f2', 'skip');
  assert.deepEqual(file(), ['findings of INT-1 filed', 'filed: INT-2 from f1', 'skipped: f2', 'waiting: f3']);
  const filed = itemFile().items.find((it) => it.id === 'INT-2');
  assert.deepEqual([filed.title, fs.readFileSync(path.join(b.site, 'data', filed.plan), 'utf8'), filed.deps], ['Split the store', "# Split the store\n\nMove the readers out.\n\n- Readers own their files.\n\nOwner's note: Keep the API.\n\nFrom the finding: Split the store?\n", ['INT-1']]);
  assert.deepEqual(itemFile().waves[0].phases, [['INT-1'], ['INT-2']]);
  assert.deepEqual(resolved(), { f1: 'Filed as INT-2.', f2: 'Skipped.', f3: undefined });
  answer('f3', 'A');
  assert.deepEqual(file().slice(0, 2), ['findings of INT-1 filed', 'filed: INT-3 from f3']);
  assert.deepEqual(itemFile().waves[0].phases, [['INT-1'], ['INT-2'], ['INT-3']]);
  const audit = itemFile().items.find((it) => it.id === 'INT-1');
  assert.equal(audit.lane, 'done');
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.site, 'data', 'threads', 'app__INT-1.jsonl'), 'utf8').trim().split('\n').at(-1)).text, 'Every finding is settled: filed INT-2, INT-3.');
});

test('a review waits, saying why, while the mattpocock skills are missing', async () => {
  const b = await boardServer({ skills: false });
  const { waits } = await b.arch();
  assert.equal(waits, 'Architecture reviews wait on improve-codebase-architecture, codebase-design, grilling and prototype from mattpocock/skills, which aren’t installed. Run kickflip doctor --fix on the host to add them.');
  assert.deepEqual(await b.run(), { status: 409, body: { error: waits } });
  assert.deepEqual(b.events(), []);
  assert.equal(readJSON(path.join(b.site, 'data', 'items.json')).items.length, 2);
});

test("a board on the kickflip clone, as the hub board is, names its review's scope: the clone's code and model, and the live data's shapes", async () => {
  const b = await boardServer({ site: { hub: true, local: true, owner: { session: 's1', repo: path.resolve(serverFile, '..', '..') } } });
  assert.equal((await b.run()).status, 200);
  const { data } = b.events()[0];
  assert.deepEqual(data.scope.paths, ['hub/', 'board/', 'shared/', 'CONTEXT.md', 'docs/adr/']);
  assert.ok(data.scope.data.includes('~/.claude/kickflip/manifest.json'));
  assert.equal(data.repo, path.resolve(serverFile, '..', '..'));
});

test('on a board over ~/.claude/waves the review is an item file of its own', async () => {
  const b = await boardServer({ items: 'waves' });
  const r = await b.run();
  assert.deepEqual([r.status, r.body.key], [200, `arch-${stamp}/audit`]);
  const wave = readJSON(path.join(b.home, '.claude', 'waves', `arch-${stamp}`, 'wave.json'));
  assert.deepEqual([wave.title, wave.repo, wave.items.map((it) => it.title)], [title, 'owner/app-repo', ['Architecture review of app-repo']]);
  assert.deepEqual([b.events()[0].data.file, b.events()[0].data.wave], [`arch-${stamp}`, undefined]);
  assert.equal((await b.arch()).last.running, true);
});
