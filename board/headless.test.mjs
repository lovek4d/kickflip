import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until } from '../shared/test-helpers.mjs';
import { builderBrief, landerBrief, launchHeadless, reviveBuilders, BOARD_CLI } from './headless.mjs';

const card = { route: 'shop', key: 'w/A1', ref: 'ENG-1', title: 'Make it go', notes: '/s/waves/w/a1.md', worktree: '/wt/A1', base: 'main', rules: ['Use Node 22+'] };

// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
test("a headless builder's brief names its card, notes, worktree and rules, and has it report, ask, record calls and land itself", () => {
  const brief = builderBrief(card);
  const b = `node ${BOARD_CLI} --site shop`;
  for (const want of [
    'ENG-1', 'Make it go', '/s/waves/w/a1.md', 'Work only in /wt/A1', 'Use Node 22+',
    `${b} builder start w/A1 --kind build`, `${b} builder progress w/A1 --phase`, `${b} builder call w/A1`, `${b} builder ask w/A1`,
    `${b} builder asks w/A1`, `${b} land w/A1 --text`, `${b} builder done w/A1`, "git -c core.commentChar=';' rebase main", 'Never push',
  ]) assert.ok(brief.includes(want), `the brief has ${want}`);
  assert.ok(brief.indexOf('builder call') < brief.indexOf(`${b} land`), 'calls come before the land step');
  assert.match(builderBrief({ ...card, notes: null }), /no notes file/);
});

test("a lander's brief takes up the card's verified build, acts on the owner's answers, and lands it itself", () => {
  const brief = landerBrief({ ...card, answers: [{ ask: 'ask1', question: 'Keep the badge?', answer: 'Drop it: too loud' }] });
  const b = `node ${BOARD_CLI} --site shop`;
  for (const want of [`${b} builder start w/A1 --kind build`, 'ask1 "Keep the badge?": Drop it: too loud', "git -c core.commentChar=';' rebase main", `${b} land w/A1 --text`, 'Never push']) {
    assert.ok(brief.includes(want), `the lander's brief has ${want}`);
  }
});

test('launchHeadless runs claude -p in the worktree in auto mode on the model, detached, logging to a file, and rejects when claude does not start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-'));
  try {
    const out = path.join(dir, 'seen.json');
    const fake = path.join(dir, 'claude');
    fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), nested: process.env.CLAUDECODE ?? null }));\nconsole.log('ran');\n`);
    fs.chmodSync(fake, 0o755);
    const log = path.join(dir, 'logs', 'A1.log');
    const before = process.env.CLAUDECODE;
    process.env.CLAUDECODE = '1';
    let launched;
    try { launched = await launchHeadless({ bin: fake, cwd: dir, prompt: 'Build it.', model: 'sonnet', log }); } finally {
      if (before === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = before;
    }
    assert.ok(Number.isInteger(launched.pid));
    await until(() => fs.existsSync(out) && fs.readFileSync(log, 'utf8').includes('ran'), 'the fake claude runs');
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { argv: ['-p', 'Build it.', '--permission-mode', 'auto', '--model', 'sonnet'], cwd: fs.realpathSync(dir), nested: null });
    await assert.rejects(launchHeadless({ bin: path.join(dir, 'missing'), cwd: dir, prompt: 'x', model: 'opus', log }), /ENOENT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("on a board whose builders launch headless, the server launches the builder for a tap and a pull instead of waking the session, and a lander once a checking card's calls are verified and no question is open", async () => {
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
  const boardJSON = (extra = {}) => fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/wave.json', slug: 't', headless_builders: true, ...extra }));
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
    assert.match(landing.argv[1], /land t\/H3 --text/);
    assert.equal(thread('H3').at(-1).text.startsWith('Lander launched headless'), true);

    const tapped = await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'card-build', key: 't/H1' }) }).then((r) => r.json());
    assert.equal(tapped.id, null);
    const worktree = path.join(home, '.claude', 'kickflip', 'worktrees', 'H1');
    await until(() => runs().length === 2, 'the tapped builder launches');
    const built = runs()[1];
    assert.equal(built.cwd, fs.realpathSync(worktree));
    assert.deepEqual([built.argv[0], built.argv[2], built.argv[3], built.argv[4]], ['-p', '--permission-mode', 'auto', '--model']);
    assert.ok(built.argv[1].includes(path.join(data, 'h1.md')) && built.argv[1].includes('builder start t/H1 --kind build'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'agents', 'H1.json'), 'utf8')).dispatched, 'tap');
    assert.match(thread('H1').at(-1).text, /^Builder launched headless/);
    assert.deepEqual(log().filter((e) => e.kind === 'card-build'), []);

    boardJSON({ auto_pull: true });
    await until(() => runs().length === 3, 'the pulled builder launches');
    assert.match(runs()[2].argv[1], /builder start t\/H2 --kind build/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'agents', 'H2.json'), 'utf8')).dispatched, 'hub');
    assert.deepEqual(log().filter((e) => e.kind === 'card-pull' || e.kind === 'card-build'), []);

    // The owner's answer to H4's question lets its lander go, once.
    fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [{ id: 'h4q', topic: 'item:t/H4', question: 'Which?', options: [{ id: 'A', label: 'This' }], resolved: true, resolved_at: '2026-11-04T04:00:00.000Z' }] }));
    await until(() => runs().length === 4, "H4's lander launches");
    assert.match(runs()[3].argv[1], /land t\/H4 --text/);
    boardJSON({ auto_pull: true, title: 'Shop again' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(runs().length, 4, 'each verification gets one lander');
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
