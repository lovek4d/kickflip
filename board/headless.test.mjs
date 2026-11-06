import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until, boardListening, untilTestEnds } from '../shared/test-helpers.mjs';
import { builderBrief, landerBrief, plannerBrief, rebaseBrief, reviveBuilders, stopAgents, BOARD_CLI } from './headless.mjs';
import { briefFacts } from './store.mjs';

// Stops each fake builder that logged its run, {argv, pid}, to seen, since a builder runs detached from the board
// server and outlives it.
function stopFakeBuilders(seen) {
  let runs = [];
  try { runs = fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  for (const { pid } of runs) try { process.kill(pid, 'SIGKILL'); } catch {}
}

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

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
test("a rebase run's brief takes up the card, rebases its PR's branch onto origin's base keeping both sides, reruns the suite and finishes with builder done, handing a failure back as a call", () => {
  const brief = rebaseBrief({ ...card, pr: 31 });
  const b = `node ${BOARD_CLI} --site shop`;
  for (const want of [
    `${b} builder start w/A1 --kind build --label Rebase --phase building --progress "Rebase run started · fetching main"`,
    'PR #31', 'Work only in /wt/A1', 'git fetch origin', "git -c core.commentChar=';' rebase origin/main", "keeping both sides' intent",
    '"Rebasing onto main · resolving', `${b} builder call w/A1 "Rebase failed in`, `${b} builder done w/A1 --text`, '--force-with-lease', 'Never push',
  ]) assert.ok(brief.includes(want), `the rebase brief has ${want}`);
  assert.ok(brief.indexOf('builder call') < brief.indexOf(`${b} builder done`), 'a failure is a call, before the finishing step');
});

test("a lander's brief takes up the card's verified build, acts on the owner's answers, and finishes it with builder done", () => {
  const brief = landerBrief({ ...card, answers: [{ ask: 'ask1', question: 'Keep the badge?', answer: 'Drop it: too loud' }] });
  const b = `node ${BOARD_CLI} --site shop`;
  for (const want of [`${b} builder start w/A1 --kind build`, 'ask1 "Keep the badge?": Drop it: too loud', "git -c core.commentChar=';' rebase main", `${b} builder done w/A1 --text`, 'Never push']) {
    assert.ok(brief.includes(want), `the lander's brief has ${want}`);
  }
  assert.ok(brief.includes("don't start the text with it"), 'the lander brief says not to lead with the phase word');
  // Its start posts the landing line, so the card reads landing from the lander's first second.
  assert.ok(brief.includes(`${b} builder start w/A1 --kind build --label Lander --phase landing --progress "taking up the verified build"`), 'the lander starts on landing');
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
  // docs/adr/2026-11-06-0130-every-grill-ends-with-a-prototype-question-the-board-acts-on.md: every grill ends with the gate.
  assert.match(grill, /End every grill with one more question, "Prototype round first\?", whose options are yes and no, with "prototype_gate": true/);
  assert.ok(grill.includes('Recommend yes when the card changes the hub\'s or a board\'s UI, no otherwise') && grill.includes('Ask it even when it is your only question'));
  assert.ok(!proto.includes('prototype_gate'));
  // A grill sets no ready itself: the gate's answer moves the card; the owner asking for prototypes ends it prototyping.
  assert.ok(grill.includes(`end the card \`${b} item set w/A1 --state prototyping\` instead and skip the prototype question`));
  assert.ok(grill.includes('never set it ready yourself'));
  assert.ok(grill.includes('never leave a Next that asks the owner to mark it ready'));
  assert.ok(!proto.includes('--state ready'));
  // docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md: Codex has no skills, so they're named only as extras.
  assert.ok(grill.includes('Invoke the grilling skill with the Skill tool') && proto.includes('Invoke the prototype skill with the Skill tool'));
  assert.ok(!/Follow the (grilling|prototype) skill/.test(grill + proto));
  // docs/adr/2026-11-05-0930-planners-run-the-skills-from-one-engineered-prompt.md: one round, board questions not chat, rules labelled.
  assert.ok(grill.includes('as one round') && grill.includes('never into the chat') && grill.includes('after the round, finish'));
  assert.ok(proto.includes('never asking in the chat'));
  const ruled = plannerBrief({ ...card, kind: 'grill', repo: '/r/shop', rules: ['Push main after every land'] });
  assert.match(ruled, /Rules from the hub and this board, written for the orchestrator:/);
  assert.ok(ruled.includes('- Push main after every land'));
  assert.ok(builderBrief({ ...card, rules: ['x'] }).includes('Rules from the hub and this board:\n- x'), "a builder's rules aren't relabelled");
});

// docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md
test("a builder's and a planner's brief list the card's related cards with their notes, for context only; a lander's doesn't", () => {
  const links = [
    { relation: 'related', ref: 'ENG-2', title: 'Sort the lane', status: 'planned', notes: '/s/waves/w/a2.md' },
    { relation: 'parent', ref: 'ENG-3', title: 'The lane', status: 'done', notes: null },
  ];
  for (const brief of [builderBrief({ ...card, links }), plannerBrief({ ...card, kind: 'grill', repo: '/r/shop', links })]) {
    for (const want of ['Related cards', "don't build their scope", 'ENG-2 "Sort the lane" (related, planned): /s/waves/w/a2.md', 'ENG-3 "The lane" (parent, done): no notes']) {
      assert.ok(brief.includes(want), `the brief has ${want}`);
    }
  }
  assert.ok(!builderBrief(card).includes('Related cards'), 'a card with no links has no Related cards line');
  assert.ok(!landerBrief({ ...card, links }).includes('Related cards'));
});

test("briefFacts gives a card's links: Related to set on either card, its Parent and its deps, each with its ref, title, status and notes path", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-facts-'));
  try {
    const site = path.join(home, 'site');
    fs.mkdirSync(path.join(site, 'data'), { recursive: true });
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/wave.json', slug: 't' }));
    fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ title: 'T', items: [
      { id: 'A1', title: 'One', parent: 'P1', deps: ['D1'], related: ['R1'] },
      { id: 'R1', title: 'Rel', status: 'planned', plan: 'r1.md' },
      { id: 'R2', title: 'Rel back', status: 'building', related: ['t/A1'] },
      { id: 'P1', title: 'Par', status: 'done' },
      { id: 'D1', title: 'Dep', status: 'building' },
      { id: 'X1', title: 'Other' },
    ] }));
    const { links } = await briefFacts(site, 't/A1');
    assert.deepEqual(links, [
      { relation: 'parent', ref: 'P1', title: 'Par', status: 'done', notes: null },
      { relation: 'depends on', ref: 'D1', title: 'Dep', status: 'building', notes: null },
      { relation: 'related', ref: 'R1', title: 'Rel', status: 'planned', notes: path.join(site, 'data', 'r1.md') },
      { relation: 'related', ref: 'R2', title: 'Rel back', status: 'building', notes: null },
    ]);
    assert.deepEqual((await briefFacts(site, 't/X1')).links, []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
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
    await boardListening(child);
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

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
test("the server starts a rebase run on each card whose open PR conflicts, in its worktree or one made from the PR's branch, once per conflict", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-server-'));
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
  git(origin, 'checkout', '--quiet', '-b', 'by-hand');
  fs.writeFileSync(path.join(origin, 'b.txt'), 'by hand\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '--quiet', '-m', 'R2 by hand');
  git(origin, 'checkout', '--quiet', 'main');
  const clone = path.join(home, 'clone');
  git(home, 'clone', '--quiet', origin, clone);
  const built = path.join(home, 'wt-R1');
  git(clone, 'worktree', 'add', '--quiet', '-b', 'R1', built, 'origin/main');
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: clone } } } }));
  const boardJSON = (extra = {}) => fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/wave.json', slug: 't', ...extra }));
  boardJSON();
  fs.mkdirSync(path.join(data, 'agents'));
  fs.writeFileSync(path.join(data, 'agents', 'R1.json'), JSON.stringify({ label: 'Builder', kind: 'claude', model: 'opus', started: '2026-11-05T01:00:00.000Z', done: '2026-11-05T02:00:00.000Z', worktree: { path: built, branch: 'R1', repo: clone } }));
  fs.writeFileSync(path.join(data, 'wave.json'), JSON.stringify({ items: [
    { id: 'R1', title: 'Built here', pr: 5 },
    { id: 'R2', title: 'Linked by hand', pr: 6 },
    { id: 'R3', title: 'Clean', pr: 7 },
  ] }));
  // gh answers the board's own `gh pr view <n> --json …` (server.mjs ghPR) from this map, and nothing else.
  const ghDir = path.join(home, 'gh');
  fs.mkdirSync(ghDir);
  const view = (n, over) => ({ number: n, state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', statusCheckRollup: [], headRefName: n === 6 ? 'by-hand' : `R${n - 4}`, ...over });
  fs.writeFileSync(path.join(ghDir, 'prs.json'), JSON.stringify({
    5: view(5, { isDraft: true, mergeable: 'CONFLICTING', headRefOid: 'a'.repeat(40) }),
    6: view(6, { mergeable: 'CONFLICTING', headRefOid: 'b'.repeat(40) }),
    7: view(7, { headRefOid: 'c'.repeat(40) }),
  }));
  fs.writeFileSync(path.join(ghDir, 'gh'), `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nconst prs = require(${JSON.stringify(path.join(ghDir, 'prs.json'))});\nif (a[0] === 'pr' && a[1] === 'view' && prs[a[2]]) console.log(JSON.stringify(prs[a[2]])); else process.exit(1);\n`);
  fs.chmodSync(path.join(ghDir, 'gh'), 0o755);
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = path.join(home, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\n`);
  fs.chmodSync(fake, 0o755);
  const runs = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const read = (file) => JSON.parse(fs.readFileSync(path.join(data, file), 'utf8'));
  const [port] = await freePorts();
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], {
    env: { ...process.env, HOME: home, PORT: String(port), KICKFLIP_HUB_PORT: '1', KICKFLIP_CLAUDE: fake, PATH: `${ghDir}:${process.env.PATH}` } });
  try {
    await boardListening(child);
    await until(() => runs().length === 2, 'both rebase runs launch');
    const byCard = Object.fromEntries(runs().map((r) => [/builder start t\/(R\d)/.exec(r.argv[1])[1], r]));
    assert.deepEqual(Object.keys(byCard).sort(), ['R1', 'R2'], 'the clean PR gets none');
    assert.equal(byCard.R1.cwd, fs.realpathSync(built));
    assert.ok(byCard.R1.argv[1].includes('builder start t/R1 --kind build --label Rebase') && byCard.R1.argv[1].includes('PR #5'));
    const made = path.join(home, '.claude', 'kickflip', 'worktrees', 'R2');
    assert.equal(byCard.R2.cwd, fs.realpathSync(made));
    assert.equal(git(made, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'by-hand'), "the hand-linked PR's worktree is made from its branch");
    assert.deepEqual([read('agents/R1.json').label, read('agents/R1.json').dispatched, read('agents/R1.json').done], ['Rebase', 'hub', undefined]);
    const items = read('wave.json').items;
    assert.deepEqual(items.map((i) => i.rebase_run?.conflict ?? null), [`${'a'.repeat(40)}@main`, `${'b'.repeat(40)}@main`, null]);
    assert.deepEqual(Object.fromEntries(Object.entries(read('rebases.json')).map(([k, v]) => [k, v.conflict])), { 't/R1': `${'a'.repeat(40)}@main`, 't/R2': `${'b'.repeat(40)}@main` });
    const { items: cards } = await fetch(`http://127.0.0.1:${port}/api/board`).then((r) => r.json());
    assert.deepEqual(['t/R1', 't/R2'].map((k) => cards.find((c) => c.key === k).lane), ['review', 'review'], 'the run leaves the card in In Review');

    boardJSON({ title: 'Shop again' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(runs().length, 2, 'each conflict gets one run');
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
    await boardListening(server);
    return server;
  };
  let child = await serve();
  try {
    await until(() => runs() === 1, 'the lander launches');
    // The lander started (building) and then its process went with the pause. Only once the server has tracked the
    // lander's process and that process is gone: a pass that still sees it alive relaunches nothing, and no change
    // follows to run another.
    const landers = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'landers.json'), 'utf8')); } catch { return {}; } };
    const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
    await until(() => Number.isInteger(landers()['t/H3']?.pid) && gone(landers()['t/H3'].pid), 'the lander is tracked and has exited');
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
    'w/C': { ...tracked['w/C'], handedBack: true },
    'w/D': { model: 'opus', pid: 902, relaunched: false },
  });
  // A handed-back build stays tracked, so its card reads stopped, and is handed back only once.
  const again = await reviveBuilders({ 'w/C': next['w/C'] }, open, { launch, handBack, alive });
  assert.deepEqual([again, handed.length, launched.length], [{ 'w/C': next['w/C'] }, 1, 2]);
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
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + '\\n');\nconsole.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-R1' }));\nsetTimeout(() => {}, 5000);\n${untilTestEnds()}.unref();\n`);
  fs.chmodSync(fake, 0o755);
  const setup = path.join(home, 'setup.mjs');
  fs.writeFileSync(setup, `
    const interval = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60000 ? 50 : ms, ...args);
  `);
  const [port] = await freePorts();
  const child = spawn(process.execPath, ['--import', setup, path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], { env: { ...process.env, HOME: home, PORT: String(port), KICKFLIP_HUB_PORT: '1', KICKFLIP_CLAUDE: fake } });
  try {
    await boardListening(child);
    // Until the fake builder has written its whole first line, not just created the file.
    await until(() => fs.existsSync(seen) && fs.readFileSync(seen, 'utf8').includes('\n'), 'the dead builder is relaunched');
    assert.match(JSON.parse(fs.readFileSync(seen, 'utf8').trim().split('\n')[0]).argv[1], /builder start t\/R1 --kind build/);
    await until(() => JSON.parse(fs.readFileSync(path.join(data, 'headless-builders.json'), 'utf8'))['t/R1']?.relaunched === true, 'the relaunch is tracked');
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'agents', 'R1.json'), 'utf8')).session.id, 'sess-R1');
    const lines = fs.readFileSync(path.join(data, 'threads', 't__R1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // Found among the lines, since past the fake builder's 5 s the check hands the build back with a line of its own.
    assert.match(lines.find((l) => l.text.startsWith('Builder launched'))?.text ?? '', new RegExp(`^Builder launched on Claude Opus in ${wt}, session sess-R1\\.$`));
    // docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md
    const logged = fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.call === 'relaunch');
    assert.deepEqual({ ...logged, at: undefined }, { at: undefined, call: 'relaunch', key: 't/R1', result: 'relaunched', reason: 'Its builder exited with its record open, for the first time.', inputs: { model: 'opus', pid: dead.pid, relaunched: false } });
  } finally {
    child.kill();
    stopFakeBuilders(seen);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-05-2130-a-restarted-server-launches-the-build-its-pull-left-without-a-builder.md
test("a restarted server launches the builder of a building card whose record is still dispatched and untracked, and leaves a planner and a tracked one alone", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-cutoff-'));
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
  fs.writeFileSync(path.join(data, 'wave.json'), JSON.stringify({ items: ['C1', 'C2', 'C3', 'C4'].map((id) => ({ id, title: id, status: 'building' })) }));
  const record = (extra) => JSON.stringify({ started: '2026-11-05T04:42:41.000Z', kind: 'claude', model: 'opus', worktree: { path: wt, branch: 'x', repo: wt }, ...extra });
  fs.writeFileSync(path.join(data, 'agents', 'C1.json'), record({ dispatched: 'hub' }));
  fs.writeFileSync(path.join(data, 'agents', 'C2.json'), record({ dispatched: 'hub', kind: 'grill' }));
  fs.writeFileSync(path.join(data, 'agents', 'C3.json'), record({ dispatched: 'hub' }));
  fs.writeFileSync(path.join(data, 'agents', 'C4.json'), record({}));
  fs.writeFileSync(path.join(data, 'headless-builders.json'), JSON.stringify({ 't/C3': { model: 'opus', pid: process.pid, relaunched: false } }));
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = path.join(home, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + '\\n');\nsetTimeout(() => {}, 5000);\n${untilTestEnds()}.unref();\n`);
  fs.chmodSync(fake, 0o755);
  const [port] = await freePorts();
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], { env: { ...process.env, HOME: home, PORT: String(port), KICKFLIP_HUB_PORT: '1', KICKFLIP_CLAUDE: fake } });
  try {
    await boardListening(child);
    await until(() => fs.existsSync(seen) && fs.readFileSync(seen, 'utf8').includes('\n'), 'the cut-off builder launches');
    await until(() => JSON.parse(fs.readFileSync(path.join(data, 'headless-builders.json'), 'utf8'))['t/C1']?.relaunched === false, 'the launch is tracked');
    const runs = fs.readFileSync(seen, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(runs.length, 1);
    assert.match(runs[0].argv[1], /builder start t\/C1 --kind build/);
  } finally {
    child.kill();
    stopFakeBuilders(seen);
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
    await boardListening(child);
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
    await until(() => b.thread('Q1').length === 2, 'the launch line follows the run');
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

// docs/adr/2026-11-05-0900-done-and-hold-stop-the-cards-headless-builder.md
test('stopAgents signals only the agents whose process started when their session was recorded, then kills what lingers', async () => {
  const at = '2026-11-05T10:00:00.000Z';
  const sent = [];
  const starts = (pids) => new Map(pids.map((p) => [p, p === 3 ? Date.parse('2026-11-01T00:00:00Z') : Date.parse(at) - 5000]));
  const n = stopAgents([{ pid: 1, at }, { pid: 2, at }, { pid: 3, at }, { pid: null, at: null }], { starts, kill: (pid, sig) => sent.push([pid, sig]), killAfter: 10 });
  assert.equal(n, 2, 'pid 3 started long before the session, so it is a reused pid; the record with no pid only closes');
  assert.deepEqual(sent, [[1, 'SIGTERM'], [2, 'SIGTERM']]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(sent.slice(2), [[1, 'SIGKILL'], [2, 'SIGKILL']]);
  assert.equal(stopAgents([{ pid: 9, at }], { starts: () => null, kill: () => assert.fail('ps gave no answer') }), 0);
});

test("the owner's Hold kills the card's running builder, closes its record and says so in the thread", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-fake-'));
  const fake = path.join(home, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-' + process.pid }));\n${untilTestEnds()};\n`);
  fs.chmodSync(fake, 0o755);
  const b = oneLaunchBoard([{ id: 'H1', title: 'Hold me', state: 'ready', size: 'large' }], fake);
  const { child, send } = await b.start();
  let pid;
  try {
    await send('card-build', { key: 't/H1' });
    await until(() => b.record('H1').session?.pid, 'the launch records the agent pid');
    ({ pid } = b.record('H1').session);
    assert.doesNotThrow(() => process.kill(pid, 0), 'the agent runs');
    await send('card-hold', { key: 't/H1', hold: true });
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'the hold stops the agent');
    assert.ok(b.record('H1').done, 'its record closed, so nothing relaunches it');
    assert.deepEqual(b.thread('H1').slice(-2).map((t) => t.text), ['Held.', 'Stopped its builder.']);
  } finally {
    child.kill();
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    fs.rmSync(b.home, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
