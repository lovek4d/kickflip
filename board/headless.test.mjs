import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until } from '../shared/test-helpers.mjs';
import { builderBrief, landerBrief, plannerBrief, reviveBuilders, BOARD_CLI } from './headless.mjs';

const card = { route: 'shop', key: 'w/A1', ref: 'ENG-1', title: 'Make it go', notes: '/s/waves/w/a1.md', worktree: '/wt/A1', base: 'main', rules: ['Use Node 22+'] };

// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
test("a headless builder's brief names its card, notes, worktree and rules, and has it report, ask, record calls and finish with builder done", () => {
  const brief = builderBrief(card);
  const b = `node ${BOARD_CLI} --site shop`;
  for (const want of [
    'ENG-1', 'Make it go', '/s/waves/w/a1.md', 'Work only in /wt/A1', 'Use Node 22+',
    `${b} builder start w/A1 --kind build`, `${b} builder progress w/A1 --phase`, `${b} builder call w/A1`, `${b} builder ask w/A1`,
    `${b} builder asks w/A1`, `${b} builder done w/A1 --text`, "git -c core.commentChar=';' rebase main", 'Never push',
  ]) assert.ok(brief.includes(want), `the brief has ${want}`);
  for (const phase of ['reading', 'building', 'testing', 'checking', 'landing']) assert.ok(brief.includes(`- ${phase}:`), `the brief says what ${phase} means`);
  assert.ok(brief.includes("don't start the text with it"), 'the brief says not to lead with the phase word');
  assert.ok(!brief.includes(`${b} land`), 'done finishes the card, so the brief never runs land');
  assert.ok(brief.indexOf('builder call') < brief.indexOf(`${b} builder done`), 'calls come before the finishing step');
  assert.match(builderBrief({ ...card, notes: null }), /no notes file/);
});

test("a lander's brief takes up the card's verified build, acts on the owner's answers, and finishes it with builder done", () => {
  const brief = landerBrief({ ...card, answers: [{ ask: 'ask1', question: 'Keep the badge?', answer: 'Drop it: too loud' }] });
  const b = `node ${BOARD_CLI} --site shop`;
  for (const want of [`${b} builder start w/A1 --kind build`, 'ask1 "Keep the badge?": Drop it: too loud', "git -c core.commentChar=';' rebase main", `${b} builder done w/A1 --text`, 'Never push']) {
    assert.ok(brief.includes(want), `the lander's brief has ${want}`);
  }
  assert.ok(brief.includes("don't start the text with it"), 'the lander brief says not to lead with the phase word');
});

// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
test("a headless planner's brief names its card and its notes so far, spells its steps out with the skill only an optional extra, and has it start, post questions and finish", () => {
  const b = `node ${BOARD_CLI} --site shop`;
  const grill = plannerBrief({ ...card, kind: 'grill', repo: '/r/shop' });
  for (const want of ['ENG-1', 'Make it go', '/s/waves/w/a1.md', 'grilling skill', `${b} builder start w/A1 --kind grill`, `${b} question add`, `${b} builder done w/A1`, 'docs/adr', 'Never push']) {
    assert.ok(grill.includes(want), `the grill's brief has ${want}`);
  }
  const proto = plannerBrief({ ...card, notes: null, kind: 'prototype', repo: '/r/shop', question: 'a1-look', note: 'Bigger', choice: 'B' });
  for (const want of ['prototype skill', `${b} builder start w/A1 --kind prototype`, `${b} prototype add`, 'a1-look', 'Bigger', 'B']) {
    assert.ok(proto.includes(want), `the prototype's brief has ${want}`);
  }
  assert.ok(!proto.includes('/s/waves/w/a1.md'));
  // docs/adr/2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md: a grill offers the prototype round.
  assert.match(grill, /When the card changes the hub's or a board's UI, end with one more question asking for a prototype round/);
  assert.ok(!proto.includes('one more question asking for a prototype round'));
  // docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md: Codex has no skills, so they're named only as extras.
  assert.ok(grill.includes('If you have the grilling skill') && proto.includes('If you have the prototype skill'));
  assert.ok(!/Follow the (grilling|prototype) skill/.test(grill + proto));
});

test("the server launches the builder for a tap and a pull instead of waking the session, and a lander once a checking card's calls are verified and no question is open", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-server-'));
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'threads'), { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const origin = path.join(home, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '--quiet', '-b', 'main');
  git(origin, 'config', 'user.name', 'Test');
  git(origin, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(origin, 'a.txt'), 'a\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '--quiet', '-m', 'base');
  const clone = path.join(home, 'clone');
  git(home, 'clone', '--quiet', origin, clone);
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: clone } } } }));
  const boardJSON = (extra = {}) => fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/wave.json', slug: 't', ...extra }));
  boardJSON();
  fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [{ id: 'h4q', topic: 'item:t/H4', question: 'Which?', options: [{ id: 'A', label: 'This' }] }] }));
  fs.writeFileSync(path.join(data, 'h1.md'), '# H1\n');
  const lander = path.join(home, 'lander-wt');
  fs.mkdirSync(lander);
  const verified = { started: '2026-11-04T01:00:00.000Z', done: '2026-11-04T02:00:00.000Z', kind: 'claude', model: 'opus', calls: [{ at: '2026-11-04T01:30:00.000Z', text: 'Kept it small' }], verified: { at: '2026-11-04T03:00:00.000Z' }, worktree: { path: lander, branch: 'H3', repo: clone } };
  fs.mkdirSync(path.join(data, 'agents'));
  fs.writeFileSync(path.join(data, 'agents', 'H3.json'), JSON.stringify(verified));
  fs.writeFileSync(path.join(data, 'agents', 'H4.json'), JSON.stringify({ ...verified, worktree: { ...verified.worktree, path: lander, branch: 'H4' } }));
  fs.writeFileSync(path.join(data, 'wave.json'), JSON.stringify({ items: [
    { id: 'H1', title: 'Tapped', state: 'ready', size: 'large', plan: 'h1.md' },
    { id: 'H2', title: 'Pulled', state: 'ready', size: 'large' },
    { id: 'H3', title: 'Verified', status: 'checking', next: "Verify the builder's judgment calls" },
    { id: 'H4', title: 'Asked', status: 'checking', next: "Answer the builder's questions" },
  ] }));
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = path.join(home, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\n`);
  fs.chmodSync(fake, 0o755);
  const runs = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const log = () => (fs.existsSync(path.join(data, 'events.jsonl')) ? fs.readFileSync(path.join(data, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const thread = (id) => fs.readFileSync(path.join(data, 'threads', `t__${id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const [port] = await freePorts();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], { env: { ...process.env, HOME: home, PORT: String(port), KICKFLIP_HUB_PORT: '1', KICKFLIP_CLAUDE: fake } });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', reject); });
    // The verified card with no open question gets one lander; the one whose deferred ask waits on the owner gets none yet.
    await until(() => runs().length === 1, 'the lander launches');
    const [landing] = runs();
    assert.equal(landing.cwd, fs.realpathSync(lander));
    assert.match(landing.argv[1], /builder done t\/H3 --text/);
    assert.equal(thread('H3').at(-1).text.startsWith('Lander launched on '), true);

    const tapped = await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'card-build', key: 't/H1' }) }).then((r) => r.json());
    assert.equal(tapped.id, null);
    const worktree = path.join(home, '.claude', 'kickflip', 'worktrees', 'H1');
    await until(() => runs().length === 2, 'the tapped builder launches');
    const built = runs()[1];
    assert.equal(built.cwd, fs.realpathSync(worktree));
    assert.deepEqual([built.argv[0], built.argv[2], built.argv[3], built.argv[4]], ['-p', '--permission-mode', 'auto', '--model']);
    assert.ok(built.argv[1].includes(path.join(data, 'h1.md')) && built.argv[1].includes('builder start t/H1 --kind build'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'agents', 'H1.json'), 'utf8')).dispatched, 'tap');
        const launch = thread('H1').at(-1);
    assert.match(launch.text, /^Builder launched on Claude (Opus|Sonnet) in .*H1\.$/);
    assert.match(launch.log, /^builder-H1-.*\.log$/);
    const logs = path.join(home, '.claude', 'kickflip', 'logs');
    fs.writeFileSync(path.join(logs, launch.log), 'x'.repeat(300_000) + '\nlast line\n');
    const tail = await fetch(`${base}/api/log?file=${launch.log}`).then((r) => r.json());
    assert.equal(tail.truncated, true);
    assert.ok(tail.text.endsWith('last line\n') && tail.text.length < 262_144);
    for (const bad of ['../../site/board.json', '..%2F..%2Fsite%2Fboard.json', 'a/b.log', '.hidden.log', 'notes.txt', '']) assert.equal((await fetch(`${base}/api/log?file=${bad}`)).status, 400, bad);
    assert.equal((await fetch(`${base}/api/log?file=missing.log`)).status, 404);
    assert.match(await fetch(`${base}/log.html`).then((r) => r.text()), /api\/log\?file=/);
    assert.deepEqual(log().filter((e) => e.kind === 'card-build'), []);

    // As the owner's switch does, so the settings event wakes the server's Auto check (board.json itself isn't watched).
    assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_pull: true }) })).status, 200);
    await until(() => runs().length === 3, 'the pulled builder launches');
    assert.match(runs()[2].argv[1], /builder start t\/H2 --kind build/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'agents', 'H2.json'), 'utf8')).dispatched, 'hub');
    assert.deepEqual(log().filter((e) => e.kind === 'card-pull' || e.kind === 'card-build'), []);

    // The owner's answer to H4's question lets its lander go, once.
    fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [{ id: 'h4q', topic: 'item:t/H4', question: 'Which?', options: [{ id: 'A', label: 'This' }], resolved: true, resolved_at: '2026-11-04T04:00:00.000Z' }] }));
    await until(() => runs().length === 4, "H4's lander launches");
    assert.match(runs()[3].argv[1], /builder done t\/H4 --text/);
    boardJSON({ auto_pull: true, title: 'Shop again' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(runs().length, 4, 'each verification gets one lander');
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-04-2230-a-lander-the-pause-stopped-starts-again.md
test('a lander whose process is gone while its card reads building (the usage pause ended it) is launched again, and board.mjs lander does the same by hand', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-lander-'));
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const clone = path.join(home, 'clone');
  fs.mkdirSync(clone);
  git(clone, 'init', '--quiet', '-b', 'main');
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: clone } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/wave.json', slug: 't' }));
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(data, 'agents', 'H3.json'), JSON.stringify({ started: '2026-11-04T01:00:00.000Z', done: '2026-11-04T02:00:00.000Z', kind: 'claude', model: 'opus', calls: [{ at: '2026-11-04T01:30:00.000Z', text: 'Kept it small' }], verified: { at: '2026-11-04T03:00:00.000Z' }, worktree: { path: worktree, branch: 'H3', repo: clone } }));
  const waveFile = path.join(data, 'wave.json');
  fs.writeFileSync(waveFile, JSON.stringify({ items: [{ id: 'H3', title: 'Verified', status: 'checking', next: "Verify the builder's judgment calls" }] }));
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = path.join(home, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, '{}\\n');\n`);
  fs.chmodSync(fake, 0o755);
  const runs = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  const status = () => JSON.parse(fs.readFileSync(waveFile, 'utf8')).items[0].status;
  const [port] = await freePorts();
  const serve = async () => {
    const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], { env: { ...process.env, HOME: home, PORT: String(port), KICKFLIP_HUB_PORT: '1', KICKFLIP_CLAUDE: fake } });
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('exit', reject); });
    return server;
  };
  let child = await serve();
  try {
    await until(() => runs() === 1, 'the lander launches');
    // The lander started (building) and then its process went with the pause.
    const building = () => { const w = JSON.parse(fs.readFileSync(waveFile, 'utf8')); w.items[0].status = 'building'; fs.writeFileSync(waveFile, JSON.stringify(w)); };
    building();
    await until(() => runs() === 2, 'the stopped lander launches again');
    assert.equal(status(), 'checking');
    // The one command does the same by hand, with the server stopped so its own pass cannot relaunch first.
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    building();
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'board.mjs');
    fs.mkdirSync(path.join(home, '.claude', 'kickflip', 'sites'), { recursive: true });
    fs.symlinkSync(site, path.join(home, '.claude', 'kickflip', 'sites', 'shop'));
    const out = execFileSync(process.execPath, [cli, '--site', 'shop', 'lander', 't/H3'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.match(out, /back at checking/);
    assert.equal(status(), 'checking');
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'landers.json'), 'utf8'))['t/H3'], undefined);
    child = await serve();
    await until(() => runs() === 3, 'the relaunched lander launches');
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-04-1010-a-dead-headless-builder-is-relaunched-once.md
test('a headless builder whose process exited with its record open is relaunched once, then handed back; one held by the pause launches when asked; a closed record drops', async () => {
  const launched = [];
  const handed = [];
  const launch = async ({ key, model }) => { launched.push(key); return { pid: 900 + launched.length }; };
  const handBack = async (card) => { handed.push(card); };
  const alive = (pid) => pid === 1;
  const open = new Set(['w/A', 'w/B', 'w/C', 'w/D']);
  const tracked = {
    'w/A': { model: 'opus', pid: 1, relaunched: false },
    'w/B': { model: 'sonnet', pid: 2, relaunched: false },
    'w/C': { model: 'opus', pid: 3, relaunched: true },
    'w/D': { model: 'opus', pid: null, relaunched: false },
    'w/E': { model: 'opus', pid: 4, relaunched: false },
  };
  const next = await reviveBuilders(tracked, open, { launch, handBack, alive });
  assert.deepEqual(launched, ['w/B', 'w/D']);
  assert.deepEqual(handed, [{ key: 'w/C', model: 'opus' }]);
  assert.deepEqual(next, {
    'w/A': tracked['w/A'],
    'w/B': { model: 'sonnet', pid: 901, relaunched: true },
    'w/D': { model: 'opus', pid: 902, relaunched: false },
  });
});

// docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md
test("a tracked builder whose kind its usage holds waits, launched or not, while the other kind's builders revive", async () => {
  const launched = [];
  const launch = async ({ key }) => { launched.push(key); return { pid: 900 + launched.length }; };
  const tracked = {
    'w/A': { kind: 'codex', pid: null, relaunched: false },
    'w/B': { kind: 'codex', pid: 2, relaunched: false },
    'w/C': { kind: 'claude', model: 'opus', pid: null, relaunched: false },
  };
  const next = await reviveBuilders(tracked, new Set(Object.keys(tracked)), { launch, handBack: async () => assert.fail('nothing is handed back'), alive: () => false, held: (kind) => kind === 'codex' });
  assert.deepEqual(launched, ['w/C']);
  assert.deepEqual(next, { 'w/A': tracked['w/A'], 'w/B': tracked['w/B'], 'w/C': { kind: 'claude', model: 'opus', pid: 901, relaunched: false } });
});

// docs/adr/2026-11-04-1010-a-dead-headless-builder-is-relaunched-once.md
test("the server's minute check relaunches a tracked headless builder whose process died with its record open", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-revive-'));
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(data, 'threads'));
  const wt = path.join(home, 'wt');
  fs.mkdirSync(wt);
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: wt } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/wave.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'wave.json'), JSON.stringify({ items: [{ id: 'R1', title: 'Revive me', status: 'building' }] }));
  fs.writeFileSync(path.join(data, 'agents', 'R1.json'), JSON.stringify({ started: '2026-11-04T01:00:00.000Z', kind: 'claude', model: 'opus', worktree: { path: wt, branch: 'R1', repo: wt } }));
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => dead.once('exit', resolve));
  fs.writeFileSync(path.join(data, 'headless-builders.json'), JSON.stringify({ 't/R1': { model: 'opus', pid: dead.pid, relaunched: false } }));
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = path.join(home, 'claude');
  // The relaunched builder stays alive a while, so the 50ms check leaves its entry at relaunched instead of handing it back.
  // It names its session as Claude's init event does, which the launch records on the card's builder record and thread line.
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');\nconsole.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-R1' }));\nsetTimeout(() => {}, 5000);\n`);
  fs.chmodSync(fake, 0o755);
  const setup = path.join(home, 'setup.mjs');
  fs.writeFileSync(setup, `
    const interval = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60000 ? 50 : ms, ...args);
  `);
  const [port] = await freePorts();
  const child = spawn(process.execPath, ['--import', setup, path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], { env: { ...process.env, HOME: home, PORT: String(port), KICKFLIP_HUB_PORT: '1', KICKFLIP_CLAUDE: fake } });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', reject); });
    await until(() => fs.existsSync(seen), 'the dead builder is relaunched');
    assert.match(JSON.parse(fs.readFileSync(seen, 'utf8').trim().split('\n')[0]).argv[1], /builder start t\/R1 --kind build/);
    await until(() => JSON.parse(fs.readFileSync(path.join(data, 'headless-builders.json'), 'utf8'))['t/R1']?.relaunched === true, 'the relaunch is tracked');
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'agents', 'R1.json'), 'utf8')).session.id, 'sess-R1');
    const lines = fs.readFileSync(path.join(data, 'threads', 't__R1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.match(lines.at(-1).text, new RegExp(`^Builder launched on Claude Opus in ${wt}, session sess-R1\\.$`));
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
// A local board over a git repo, its wave's items, and a fake claude at bin (by default one that logs each run).
function oneLaunchBoard(items, bin) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-one-'));
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'threads'), { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const clone = path.join(home, 'clone');
  fs.mkdirSync(clone);
  git(clone, 'init', '--quiet', '-b', 'main');
  git(clone, 'config', 'user.name', 'Test');
  git(clone, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(clone, 'a.txt'), 'a\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '--quiet', '-m', 'base');
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], branch: 'main', local: true, owner: { repo: clone } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/wave.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'wave.json'), JSON.stringify({ items }));
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = bin ?? path.join(home, 'claude');
  if (!bin) {
    fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\n`);
    fs.chmodSync(fake, 0o755);
  }
  const runs = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const events = () => (fs.existsSync(path.join(data, 'events.jsonl')) ? fs.readFileSync(path.join(data, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).kind) : []);
  const thread = (id) => fs.readFileSync(path.join(data, 'threads', `t__${id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const record = (id) => JSON.parse(fs.readFileSync(path.join(data, 'agents', `${id}.json`), 'utf8'));
  const item = (id) => JSON.parse(fs.readFileSync(path.join(data, 'wave.json'), 'utf8')).items.find((i) => i.id === id);
  async function start() {
    const [port] = await freePorts();
    const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], { env: { ...process.env, HOME: home, PORT: String(port), KICKFLIP_HUB_PORT: '1', KICKFLIP_CLAUDE: fake } });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', reject); });
    const send = (kind, body) => fetch(`http://127.0.0.1:${port}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ...body }) }).then((r) => r.json());
    return { child, send };
  }
  return { home, site, data, clone, runs, events, thread, record, item, start };
}

test("the server launches a planner for the owner's Grill and Prototype taps and for a card arriving in Todo, from the card, in the board's repo", async () => {
  const b = oneLaunchBoard([
    { id: 'G1', title: 'Grill me', state: 'grilling' },
    { id: 'P1', title: 'Draw me', state: 'prototyping' },
    { id: 'Q1', title: 'Plan me' },
  ]);
  const { child, send } = await b.start();
  try {
    await send('grill-more', { key: 't/G1' });
    await until(() => b.runs().length === 1, 'the grill launches');
    const [grill] = b.runs();
    assert.equal(grill.cwd, fs.realpathSync(b.clone));
    assert.match(grill.argv[1], /builder start t\/G1 --kind grill/);
    assert.match(grill.argv[1], /grilling skill/);
    assert.equal(grill.argv[grill.argv.indexOf('--model') + 1], 'opus');
    assert.deepEqual([b.record('G1').kind, b.record('G1').dispatched], ['grill', 'hub']);
    assert.match(b.thread('G1').at(-1).text, /^Planner launched on Claude Opus in .*clone\.$/);
    assert.equal(b.item('G1').status, undefined, 'a planner never starts the card');

    await send('prototype-request', { key: 't/P1' });
    await until(() => b.runs().length === 2, 'the prototype launches');
    const proto = b.runs()[1];
    assert.match(proto.argv[1], /builder start t\/P1 --kind prototype/);
    assert.equal(proto.argv[proto.argv.indexOf('--model') + 1], 'sonnet');

    // With Auto implement on, the card that arrived in Todo with no planner yet gets its grill; the planned ones don't.
    for (const id of ['G1', 'P1']) fs.writeFileSync(path.join(b.data, 'agents', `${id}.json`), JSON.stringify({ ...b.record(id), done: new Date().toISOString() }));
    fs.writeFileSync(path.join(b.site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/wave.json', slug: 't', auto_pull: true }));
    await until(() => b.runs().length === 3, 'the arrival launches a grill');
    assert.match(b.runs()[2].argv[1], /builder start t\/Q1 --kind grill/);
    assert.deepEqual(b.thread('Q1').map((t) => t.text.replace(/ in \/.*/, '')), ['Landed in Todo, so the board started its grill.', 'Planner launched on Claude Opus']);
    assert.ok(!b.events().includes('card-plan'), 'the grill wakes no session');
    // A tap while the card's planner is open launches nothing more.
    await send('grill-more', { key: 't/Q1' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(b.runs().length, 3);
  } finally {
    child.kill();
    fs.rmSync(b.home, { recursive: true, force: true });
  }
});

test('a build whose builder fails to launch goes back to Todo with the reason, and wakes no session', async () => {
  const b = oneLaunchBoard([{ id: 'F1', title: 'Fail me', state: 'ready', size: 'large' }], path.join(os.tmpdir(), 'no-such-claude-here'));
  const { child, send } = await b.start();
  try {
    const tapped = await send('card-build', { key: 't/F1' });
    assert.equal(tapped.id, null);
    const last = b.thread('F1').at(-1);
    assert.equal(last.kind, 'build-refused');
    assert.match(last.text, /^Couldn't start implementing: the launch failed \(.*ENOENT.*\)\. Tap Implement to try again\.$/);
    assert.equal(b.item('F1').status, undefined, 'back in Todo');
    assert.ok(b.record('F1').done, 'its builder record is closed');
    assert.ok(!b.events().includes('card-build'));
  } finally {
    child.kill();
    fs.rmSync(b.home, { recursive: true, force: true });
  }
});
