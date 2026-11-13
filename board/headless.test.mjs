import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until, untilHeard, boardListening, untilTestEnds, killAndWait } from '../shared/test-helpers.mjs';
import { builderBrief, helperBrief, landerBrief, plannerBrief, rebaseBrief, visualBrief, reviveBuilders, stopAgents, agentMayRun, BOARD_CLI } from './headless.mjs';
import { briefFacts, archiveCards, builderProgress, readArchive, threadFile, writeBrief } from './store.mjs';
import { standardWords } from './commit-message.mjs';

// Stops each fake builder that logged its run, {argv, pid}, to seen, since a builder runs detached from the board
// server and outlives it.
function stopFakeBuilders(seen) {
  let runs = [];
  try { runs = fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  for (const { pid } of runs) try { process.kill(pid, 'SIGKILL'); } catch {}
}

// brief is the orchestrator's, which a grill, prototype or visual agent starts from; a builder's brief ignores it.
const card = { route: 'shop', key: 'w/A1', ref: 'ENG-1', title: 'Make it go', notes: '/s/waves/w/a1.md', worktree: '/wt/A1', base: 'main', rules: ['Use Node 22+'], thread: '/s/data/threads/w__A1.jsonl',
  brief: { heading: 'Brief for grill round 1', text: 'Settled: the footer folds.\nOpen: the phone layout.' } };

// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
test("a grill's, a prototype's and a visual agent's brief open with the orchestrator's brief, before the thread and notes, and none is written without one", () => {
  const briefs = [plannerBrief({ ...card, kind: 'grill', repo: '/r/shop' }), plannerBrief({ ...card, kind: 'prototype', repo: '/r/shop' }), visualBrief({ ...card, repo: '/r/shop', agent: 'visual-1' })];
  for (const [brief, what] of briefs.map((b, i) => [b, ['questions', 'takes', 'page'][i]])) {
    assert.ok(brief.includes(`Start from the orchestrator's brief, its notes section "Brief for grill round 1": what the discussion settled, what is still open, and what your ${what} should cover, with the files that matter. Read it before the thread and the notes:\n\nSettled: the footer folds.\nOpen: the phone layout.\n`), what);
    assert.ok(brief.indexOf('Settled: the footer folds.') < brief.indexOf('1. Run') && brief.indexOf('1. Run') < brief.indexOf(card.thread), what);
  }
  for (const write of [() => plannerBrief({ ...card, kind: 'grill', repo: '/r/shop', brief: undefined }), () => visualBrief({ ...card, repo: '/r/shop', agent: 'v', brief: null })]) {
    assert.throws(write, /no orchestrator's brief/);
  }
  assert.ok(!builderBrief(card).includes('Settled: the footer folds.'), "a builder's brief has none");
});

// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
test("a headless builder's brief names its card, notes, worktree and rules, and has it report, ask, record calls and finish with builder done", () => {
  const brief = builderBrief(card);
  const b = `node ${BOARD_CLI} --site shop`;
  for (const want of [
    'ENG-1', 'Make it go', '/s/waves/w/a1.md', 'Work only in /wt/A1', 'Use Node 22+',
    `${b} builder start w/A1 --kind build`, `${b} builder progress w/A1 --phase`, `${b} builder call w/A1`, `${b} builder ask w/A1`,
    `${b} builder asks w/A1`, `${b} builder done w/A1 --text`, "git -c core.commentChar=';' rebase main", 'Never push',
    `run the tests your change affects once, in the foreground, at the end, as \`${b} test --dir /wt/A1 --base main\``,
  ]) assert.ok(brief.includes(want), `the brief has ${want}`);
  assert.ok(!brief.includes('node --test'), 'the brief runs the affected tests, not the full suite');
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
    '"Rebasing onto main · resolving', `${b} test --dir /wt/A1 --base origin/main`,`${b} builder call w/A1 "Rebase failed in`, `${b} builder done w/A1 --text`, '--force-with-lease', 'Never push',
  ]) assert.ok(brief.includes(want), `the rebase brief has ${want}`);
  assert.ok(brief.indexOf('builder call') < brief.indexOf(`${b} builder done`), 'a failure is a call, before the finishing step');
});

test("a resumed builder's land brief speaks to the builder, says why the land needs it, and keeps the lander's steps and label", () => {
  const brief = landerBrief({ ...card, resumed: true, why: 'rebasing A1 onto main conflicts in a.txt' });
  const b = `node ${BOARD_CLI} --site shop`;
  assert.match(brief, /^The board resumes you, the builder of card ENG-1 .* to land your build: rebasing A1 onto main conflicts in a\.txt/);
  assert.ok(!brief.includes('You are the headless lander'));
  for (const want of [`${b} builder start w/A1 --kind build --label Lander --phase landing`, `${b} builder done w/A1 --text`, 'Never push']) assert.ok(brief.includes(want), `it has ${want}`);
  assert.match(rebaseBrief({ ...card, pr: 31, resumed: true }), /^The board resumes you, the builder of card ENG-1/);
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
  // docs/adr/2026-11-09-1100-the-board-owns-a-cards-notes-file.md: a planner hands its notes to the board as a draft.
  assert.ok(grill.includes(`${b} item notes w/A1 --heading "Grill (<MM/DD>)" --file <draft.md>`) && proto.includes(`${b} item notes w/A1 --heading "Prototype (<MM/DD>)" --file <draft.md>`));
  assert.ok(!(grill + proto).includes('--notes-file'));
  // docs/adr/2026-11-06-1700-a-boards-lessons-live-in-the-product.md: what a planner leaves open is a question, not a notes line.
  for (const brief of [grill, proto]) assert.ok(brief.includes('Anything you leave open becomes a question with question add, never only a line in the notes'));
  for (const brief of [grill, proto]) assert.ok(brief.includes("A question's text is one line of at most 100 characters") && brief.includes('which take markdown'));
  assert.ok(grill.includes(`${b} builder done w/A1`) && !grill.includes(`builder done w/A1 --text`));
  // docs/adr/2026-11-09-1300-a-prototype-round-is-take-files-unless-a-board-rule-asks-for-in-situ.md: take files by default.
  for (const want of ['Invoke the prototype skill with the Skill tool and build the round as take files', `${b} prototype add <topic> --card w/A1 --take <K>:<label>`, "repo's existing components", "Build in situ only where one of the board's rules asks for it"]) {
    assert.ok(proto.includes(want), `the prototype's brief has ${want}`);
  }
  assert.ok(proto.indexOf('--take <K>:<label> …`, write the take files') < proto.indexOf('prototype base'));
  assert.ok(!proto.includes('Only a repo whose app can'));
  // docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md: where a rule asks for in situ, a
  // round is a page in the base prototype worktree, recorded --served, that takes ?variant= and ?state= and the viewer's message.
  for (const want of [`${b} prototype base`, '--served <path>', '--state <key>:<label>', '?variant=', '?state=', 'KickflipPrototype.on', 'real components', 'mock data', 'prints "port <n>"']) {
    assert.ok(proto.includes(want), `the prototype's brief has ${want}`);
  }
  assert.match(proto, /write no output code in .*?\/r\/shop itself/);
  assert.ok(grill.includes('write no output code there'));
  // docs/adr/2026-11-12-1400-a-grill-ends-asking-to-implement-prototype-or-discuss.md: every grill ends with one
  // closing question, Implement, Prototype first or Keep discussing, which the board acts on.
  assert.ok(grill.includes('End every grill with one more question, "What next, given these answers?", whose options are implement (label "Implement"), prototype ("Prototype first") and discuss ("Keep discussing"), in that order, with "next_gate": true in its `question add --file` entry'));
  assert.ok(grill.includes('the board moves the card to staging on implement, to prototyping on prototype, or back to discussing on discuss'));
  assert.ok(grill.includes("Recommend implement when your questions settle the card and it doesn't change the hub's or a board's UI, prototype when it does") && grill.includes('Ask it even when it is your only question'));
  assert.ok(!grill.includes('prototype_gate') && !grill.includes('Prototype round first?'));
  assert.ok(!proto.includes('next_gate'));
  // docs/adr/2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md: a card that keeps its prototype answer is never asked again.
  for (const [prototype, moves] of [['yes', 'to prototyping'], ['no', 'to staging'], ['ran', 'to staging']]) {
    const kept = plannerBrief({ ...card, kind: 'grill', repo: '/r/shop', prototype });
    assert.ok(!kept.includes('next_gate') && !kept.includes('End every grill with one more question'), prototype);
    assert.ok(kept.includes(`The card keeps the owner's answer to its prototype question, ${prototype}, so ask no closing "What next, given these answers?" question: once every question you ask is answered, or as you finish when you ask none, the board moves the card ${moves}.`), prototype);
  }
  // docs/adr/2026-11-10-1600-tickets-are-made-at-ready.md: the grill never asks about a ticket, and says so.
  assert.ok(!grill.includes('ticket_gate') && !grill.includes('Create a ticket') && !proto.includes('ticket_gate'));
  assert.ok(grill.includes('Never ask whether to make a ticket: the board makes a card\'s ticket when it goes ready.'));
  // docs/adr/2026-11-07-1216-a-grill-can-propose-splitting-its-card-into-a-wave.md: a grill proposes a split as one question.
  assert.ok(grill.includes('separable parts') && grill.includes('"Split as proposed"') && grill.includes('"Keep as one card"'));
  assert.ok(grill.includes('ahead of the closing question'));
  // docs/adr/2026-11-09-2200-splits-and-waves-follow-vertical-slices-with-stated-conflicts.md: the slicing comes from /to-tickets, the conflicts are named per card.
  assert.ok(grill.includes('~/.claude/skills/to-tickets/SKILL.md') && grill.includes('step 3, "Draft vertical slices"'));
  assert.ok(grill.includes('the earlier proposed cards it waits on, or none'));
  assert.ok(grill.includes('only when it builds on that card or shares its seam'));
  assert.ok(!grill.includes('which cards build side by side'));
  assert.ok(!proto.includes('Split as proposed'));
  // A grill sets no ready itself: the gate's answer moves the card; the owner asking for prototypes ends it prototyping.
  assert.ok(grill.includes(`end the card \`${b} item set w/A1 --phase prototyping\` instead and skip the closing question`));
  assert.ok(grill.includes('never set it ready yourself'));
  assert.ok(grill.includes('never leave a Next that asks the owner to mark it ready'));
  assert.ok(!proto.includes('--phase ready'));
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

// docs/adr/2026-11-11-1100-every-agent-brief-names-the-cards-thread-file.md
test("every brief names the card's thread file, and a builder reads it with the notes, asks when it contradicts them, and reads it again in checking", () => {
  const t = '/s/data/threads/w__A1.jsonl';
  const briefs = {
    builder: builderBrief(card), lander: landerBrief(card), rebase: rebaseBrief({ ...card, pr: 3 }), helper: helperBrief({ ...card, agent: 'h', task: 'x', cwd: '/wt/A1' }),
    grill: plannerBrief({ ...card, kind: 'grill', repo: '/r/shop' }), visual: visualBrief({ ...card, repo: '/r/shop', agent: 'v' }),
  };
  for (const [name, brief] of Object.entries(briefs)) assert.ok(brief.includes(t), `the ${name} brief names the thread file`);
  const builder = briefs.builder;
  assert.ok(builder.includes('who: love') && builder.includes('the notes win') && builder.includes('that contradiction counts as blocked'), 'the notes win over the thread and the builder asks');
  assert.ok(builder.includes('Ask it only when you are blocked') && builder.includes('builder asks w/A1 --wait') && builder.includes('Found: <what>'), 'the brief asks only when blocked, waits with --wait, and files findings as calls');
  assert.ok(builder.includes('Read the thread again in checking'));
  assert.ok(!briefs.grill.includes('data/threads folder'), 'a planner gets the exact file, not the folder');
});

// docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md
test("a builder's and a planner's brief list the card's related cards with their notes, for context only; a lander's doesn't", () => {
  const links = [
    { relation: 'related', ref: 'ENG-2', title: 'Sort the lane', lane: 'Todo', notes: '/s/waves/w/a2.md', thread: '/s/data/threads/w__A2.jsonl' },
    { relation: 'parent', ref: 'ENG-3', title: 'The lane', lane: 'Done', notes: null, thread: '/s/data/threads/w__A3.jsonl' },
  ];
  for (const brief of [builderBrief({ ...card, links }), plannerBrief({ ...card, kind: 'grill', repo: '/r/shop', links })]) {
    for (const want of ['Related cards', "don't build their scope", 'ENG-2 "Sort the lane" (related, Todo): notes /s/waves/w/a2.md, thread /s/data/threads/w__A2.jsonl', 'ENG-3 "The lane" (parent, Done): no notes, thread /s/data/threads/w__A3.jsonl']) {
      assert.ok(brief.includes(want), `the brief has ${want}`);
    }
  }
  assert.ok(!builderBrief(card).includes('Related cards'), 'a card with no links has no Related cards line');
  assert.ok(!landerBrief({ ...card, links }).includes('Related cards'));
});

test("briefFacts gives a card's links: Related to set on either card, its Parent and its deps, each with its ref, title, lane and notes path", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-facts-'));
  try {
    const site = path.join(home, 'site');
    fs.mkdirSync(path.join(site, 'data'), { recursive: true });
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/items.json', slug: 't' }));
    fs.writeFileSync(path.join(site, 'data', 'items.json'), JSON.stringify({ title: 'T', items: [
      { id: 'A1', title: 'One', parent: 'P1', deps: ['D1'], related: ['R1'] },
      { id: 'R1', title: 'Rel', plan: 'r1.md' },
      { id: 'R2', title: 'Rel back', lane: 'review', related: ['t/A1'] },
      { id: 'P1', title: 'Par', lane: 'done', closed_at: '2026-11-01T10:00:00Z' },
      { id: 'D1', title: 'Dep', lane: 'progress' },
      { id: 'X1', title: 'Other' },
    ] }));
    const { links } = await briefFacts(site, 't/A1');
    assert.deepEqual(links, [
      { relation: 'parent', ref: 'P1', title: 'Par', lane: 'Done', notes: null, thread: threadFile(site, 't/P1') },
      { relation: 'depends on', ref: 'D1', title: 'Dep', lane: 'In Progress', notes: null, thread: threadFile(site, 't/D1') },
      { relation: 'related', ref: 'R1', title: 'Rel', lane: 'Todo', notes: path.join(site, 'data', 'r1.md'), thread: threadFile(site, 't/R1') },
      { relation: 'related', ref: 'R2', title: 'Rel back', lane: 'In Review', notes: null, thread: threadFile(site, 't/R2') },
    ]);
    assert.equal((await briefFacts(site, 't/A1')).thread, threadFile(site, 't/A1'));
    assert.deepEqual((await briefFacts(site, 't/X1')).links, []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("the server launches the builder for a tap and a pull instead of waking the session, and a lander once a handed-back card's calls are verified and no question is open", async () => {
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
  const boardJSON = (extra = {}) => fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't', ...extra }));
  boardJSON();
  fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [{ id: 'h4q', topic: 'item:t/H4', question: 'Which?', options: [{ id: 'A', label: 'This' }] }] }));
  fs.writeFileSync(path.join(data, 'h1.md'), '# H1\n');
  const lander = path.join(home, 'lander-wt');
  fs.mkdirSync(lander);
  const verified = { started: '2026-11-04T01:00:00.000Z', done: '2026-11-04T02:00:00.000Z', kind: 'claude', model: 'opus', calls: [{ at: '2026-11-04T01:30:00.000Z', text: 'Kept it small' }], handed_back: '2026-11-04T02:00:00.000Z', verified: { at: '2026-11-04T03:00:00.000Z' }, worktree: { path: lander, branch: 'H3', repo: clone } };
  fs.mkdirSync(path.join(data, 'agents'));
  fs.writeFileSync(path.join(data, 'agents', 'H3.json'), JSON.stringify(verified));
  fs.writeFileSync(path.join(data, 'agents', 'H4.json'), JSON.stringify({ ...verified, worktree: { ...verified.worktree, path: lander, branch: 'H4' } }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [
    { id: 'H1', title: 'feat: tapped', phase: 'staging', size: 'large', plan: 'h1.md' },
    { id: 'H2', title: 'feat: pulled', phase: 'staging', size: 'large' },
    { id: 'H3', title: 'Verified', lane: 'progress', next: "Verify the builder's judgment calls" },
    { id: 'H4', title: 'Asked', lane: 'progress', next: "Answer the builder's questions" },
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

    const tapped = await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'card-build', key: 't/H1' }) }).then((r) => r.json());
    assert.equal(tapped.id, null);
    const worktree = path.join(home, '.claude', 'kickflip', 'worktrees', 'H1');
    await until(() => runs().length === 2, 'the tapped builder launches');
    const built = runs()[1];
    assert.equal(built.cwd, fs.realpathSync(worktree));
    assert.deepEqual([built.argv[0], built.argv[2], built.argv[3], built.argv[4]], ['-p', '--permission-mode', 'auto', '--model']);
    assert.ok(built.argv[1].includes(path.join(data, 'h1.md')) && built.argv[1].includes('builder start t/H1 --kind build'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'agents', 'H1.json'), 'utf8')).dispatched, 'tap');
    const launchLog = JSON.parse(fs.readFileSync(path.join(data, 'agents', 'H1.json'), 'utf8')).session.log;
    assert.match(launchLog, /^builder-H1-.*\.log$/);
    assert.ok(!thread('H1').some((m) => /launched on/.test(m.text)), 'no launch message');
    const logs = path.join(home, '.claude', 'kickflip', 'logs');
    fs.writeFileSync(path.join(logs, launchLog), 'x'.repeat(300_000) + '\nlast line\n');
    const tail = await fetch(`${base}/api/log?file=${launchLog}`).then((r) => r.json());
    assert.equal(tail.truncated, true);
    assert.ok(tail.text.endsWith('last line\n') && tail.text.length < 262_144);
    for (const bad of ['../../site/board.json', '..%2F..%2Fsite%2Fboard.json', 'a/b.log', '.hidden.log', 'notes.txt', '']) assert.equal((await fetch(`${base}/api/log?file=${bad}`)).status, 400, bad);
    assert.equal((await fetch(`${base}/api/log?file=missing.log`)).status, 404);
    // The transcript reads the whole log, start included, from a byte offset.
    fs.writeFileSync(path.join(logs, launchLog), `${JSON.stringify({ type: 'system', subtype: 'init', model: 'm', cwd: '/wt' })}\n${'x'.repeat(300_000)}\nlast line\npart`);
    const whole = await fetch(`${base}/api/transcript?file=${launchLog}&from=0`).then((r) => r.json());
    assert.deepEqual(whole.rows.map((row) => row.body.slice(0, 9)), ['m in /wt', 'x'.repeat(9), 'last line']);
    assert.deepEqual([whole.stream, whole.finished, whole.size - whole.next], [true, false, 4]);
    const after = await fetch(`${base}/api/transcript?file=${launchLog}&from=${whole.next}`).then((r) => r.json());
    assert.deepEqual([after.rows, after.next], [[], whole.next]);
    for (const bad of ['file=a/b.log&from=0', `file=${launchLog}&from=-1`, `file=${launchLog}&from=x`, `file=${launchLog}`]) assert.equal((await fetch(`${base}/api/transcript?${bad}`)).status, 400, bad);
    assert.equal((await fetch(`${base}/api/transcript?file=missing.log&from=0`)).status, 404);
    assert.match(await fetch(`${base}/log.html`).then((r) => r.text()), /api\/log\?file=/);
    assert.deepEqual(log().filter((e) => e.kind === 'card-build'), []);

    // A card readied after the start is pulled with no switch to turn on.
    const items = JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8'));
    items.items.find((i) => i.id === 'H2').phase = 'ready';
    fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify(items));
    // The fake builders exit at once, so the minute check may relaunch the tapped one meanwhile: each wait names its run.
    const launches = (pattern) => runs().filter((r) => pattern.test(r.argv[1])).length;
    await untilHeard(() => launches(/builder start t\/H2 --kind build/) === 1, 'the pulled builder launches', path.join(data, 'nudge'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'agents', 'H2.json'), 'utf8')).dispatched, 'hub');
    assert.deepEqual(log().filter((e) => e.kind === 'card-pull' || e.kind === 'card-build'), []);

    // The owner's answer to H4's question lets its lander go, once.
    fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [{ id: 'h4q', topic: 'item:t/H4', question: 'Which?', options: [{ id: 'A', label: 'This' }], resolved: true, resolved_at: '2026-11-04T04:00:00.000Z' }] }));
    await untilHeard(() => launches(/builder done t\/H4 --text/) === 1, "H4's lander launches", path.join(data, 'nudge'));
    boardJSON({ title: 'Shop again' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual([launches(/builder done t\/H3 --text/), launches(/builder done t\/H4 --text/)], [1, 1], 'each verification gets one lander');
  } finally {
    await killAndWait(child);
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
  const boardJSON = (extra = {}) => fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't', ...extra }));
  boardJSON();
  fs.mkdirSync(path.join(data, 'agents'));
  fs.writeFileSync(path.join(data, 'agents', 'R1.json'), JSON.stringify({ label: 'Builder', kind: 'claude', model: 'opus', started: '2026-11-05T01:00:00.000Z', done: '2026-11-05T02:00:00.000Z', worktree: { path: built, branch: 'R1', repo: clone } }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [
    { id: 'R1', title: 'feat: built here', pr: 5 },
    { id: 'R2', title: 'feat: linked by hand', pr: 6 },
    { id: 'R3', title: 'Clean', pr: 7 },
  ] }));
  // The hub's check of each PR, which the board reads (server.mjs prViewOf).
  const view = (n, over) => ({ state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', checks: { total: 0, fail: 0, pending: 0, state: 'none' }, reviews: {}, headRefName: n === 6 ? 'by-hand' : `R${n - 4}`, ...over });
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'github-state.json'), JSON.stringify({ prs: {
    'owner/project#5': view(5, { isDraft: true, mergeable: 'CONFLICTING', headRefOid: 'a'.repeat(40) }),
    'owner/project#6': view(6, { mergeable: 'CONFLICTING', headRefOid: 'b'.repeat(40) }),
    'owner/project#7': view(7, { headRefOid: 'c'.repeat(40) }),
  } }));
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = path.join(home, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\n`);
  fs.chmodSync(fake, 0o755);
  const runs = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const read = (file) => JSON.parse(fs.readFileSync(path.join(data, file), 'utf8'));
  const [port] = await freePorts();
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], {
    env: { ...process.env, HOME: home, PORT: String(port), KICKFLIP_HUB_PORT: '1', KICKFLIP_CLAUDE: fake } });
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
    const items = read('items.json').items;
    assert.deepEqual(items.map((i) => i.rebase_run?.conflict ?? null), [`${'a'.repeat(40)}@main`, `${'b'.repeat(40)}@main`, null]);
    assert.deepEqual(Object.fromEntries(Object.entries(read('rebases.json')).map(([k, v]) => [k, v.conflict])), { 't/R1': `${'a'.repeat(40)}@main`, 't/R2': `${'b'.repeat(40)}@main` });
    const { items: cards } = await fetch(`http://127.0.0.1:${port}/api/board`).then((r) => r.json());
    assert.deepEqual(['t/R1', 't/R2'].map((k) => cards.find((c) => c.key === k).lane), ['review', 'review'], 'the run leaves the card in In Review');

    boardJSON({ title: 'Shop again' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(runs().length, 2, 'each conflict gets one run');
  } finally {
    await killAndWait(child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-04-2230-a-lander-the-pause-stopped-starts-again.md
test('a lander whose process is gone while its builder record is open (the usage pause ended it) is launched again, and board.mjs lander does the same by hand', async () => {
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
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree);
  const recordFile = path.join(data, 'agents', 'H3.json');
  const handedBack = { started: '2026-11-04T01:00:00.000Z', done: '2026-11-04T02:00:00.000Z', kind: 'claude', model: 'opus', calls: [{ at: '2026-11-04T01:30:00.000Z', text: 'Kept it small' }], handed_back: '2026-11-04T02:00:00.000Z', verified: { at: '2026-11-04T03:00:00.000Z' }, worktree: { path: worktree, branch: 'H3', repo: clone } };
  fs.writeFileSync(recordFile, JSON.stringify(handedBack));
  const waveFile = path.join(data, 'items.json');
  fs.writeFileSync(waveFile, JSON.stringify({ items: [{ id: 'H3', title: 'Verified', lane: 'progress', next: "Verify the builder's judgment calls" }] }));
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = path.join(home, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, '{}\\n');\n`);
  fs.chmodSync(fake, 0o755);
  const runs = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  const record = () => JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  // Handed back: the record closed marked handed_back, with no build open since.
  const handedBackAgain = () => typeof record().done === 'string' && typeof record().handed_back === 'string' && record().started !== handedBack.started;
  const [port] = await freePorts();
  const serve = async () => {
    const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], { env: { ...process.env, HOME: home, PORT: String(port), KICKFLIP_HUB_PORT: '1', KICKFLIP_CLAUDE: fake } });
    await boardListening(server);
    return server;
  };
  let child = await serve();
  try {
    await until(() => runs() === 1, 'the lander launches');
    // The lander started (its builder start reopens the record) and then its process went with the pause. Only once the server has tracked the
    // lander's process and that process is gone: a pass that still sees it alive relaunches nothing, and no change
    // follows to run another.
    const landers = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'landers.json'), 'utf8')); } catch { return {}; } };
    const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
    await until(() => Number.isInteger(landers()['t/H3']?.pid) && gone(landers()['t/H3'].pid), 'the lander is tracked and has exited');
    const building = () => {
      const { done: _, handed_back: __, ...open } = handedBack;
      fs.writeFileSync(recordFile, JSON.stringify({ ...open, started: new Date().toISOString() }));
      const w = JSON.parse(fs.readFileSync(waveFile, 'utf8')); w.items[0].next = 'Landing'; fs.writeFileSync(waveFile, JSON.stringify(w));
    };
    building();
    await untilHeard(() => runs() === 2, 'the stopped lander launches again', path.join(data, 'nudge'));
    assert.ok(handedBackAgain(), JSON.stringify(record()));
    // The one command does the same by hand, with the server stopped so its own pass cannot relaunch first.
    await killAndWait(child);
    building();
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'board.mjs');
    fs.mkdirSync(path.join(home, '.claude', 'kickflip', 'sites'), { recursive: true });
    fs.symlinkSync(site, path.join(home, '.claude', 'kickflip', 'sites', 'shop'));
    const out = execFileSync(process.execPath, [cli, '--site', 'shop', 'lander', 't/H3'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.match(out, /is handed back again/);
    assert.ok(handedBackAgain(), JSON.stringify(record()));
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'landers.json'), 'utf8'))['t/H3'], undefined);
    child = await serve();
    await until(() => runs() === 3, 'the relaunched lander launches');
  } finally {
    await killAndWait(child);
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

// docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md,
// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
test('a builder that exited on the usage limit keeps its one relaunch: it pauses, and a paused build is never relaunched', async () => {
  const reset = '2026-11-06T12:10:00.000Z';
  const launched = [];
  const limits = [];
  const launch = async ({ key }) => { launched.push(key); return { pid: 900 + launched.length, log: `/logs/${key}-2` }; };
  const tracked = {
    'w/A': { kind: 'claude', model: 'opus', pid: 1, relaunched: false, log: '/logs/A' },
    'w/B': { kind: 'claude', model: 'opus', pid: 2, relaunched: true, log: '/logs/B' },
    'w/C': { kind: 'claude', model: 'opus', pid: 3, relaunched: false, log: '/logs/C' },
  };
  const limitedUntil = (entry) => (entry.log === '/logs/C' ? null : reset);
  const opts = { launch, handBack: async () => assert.fail('nothing is handed back'), alive: () => false, limitedUntil, atLimit: async (card, at) => limits.push([card.key, at]) };
  const held = await reviveBuilders(tracked, new Set(Object.keys(tracked)), { ...opts, held: () => true });
  assert.deepEqual(launched, []);
  assert.deepEqual(limits, [['w/A', reset], ['w/B', reset]]);
  assert.deepEqual(held, { 'w/A': { ...tracked['w/A'], pid: null }, 'w/B': { ...tracked['w/B'], pid: null }, 'w/C': tracked['w/C'] });
  const later = await reviveBuilders(held, new Set(Object.keys(held)), { ...opts, paused: new Set(['w/A', 'w/B']) });
  assert.deepEqual(launched, ['w/C'], 'the paused ones wait for the board to resume them');
  assert.deepEqual([later['w/A'], later['w/B']], [held['w/A'], held['w/B']]);
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
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ id: 'R1', title: 'Revive me', lane: 'progress' }] }));
  fs.writeFileSync(path.join(data, 'agents', 'R1.json'), JSON.stringify({ started: '2026-11-04T01:00:00.000Z', kind: 'claude', model: 'opus', worktree: { path: wt, branch: 'R1', repo: wt } }));
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => dead.once('exit', resolve));
  fs.writeFileSync(path.join(data, 'headless-builders.json'), JSON.stringify({ 't/R1': { model: 'opus', pid: dead.pid, relaunched: false } }));
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = path.join(home, 'claude');
  // The relaunched builder stays alive a while, so the 50ms check leaves its entry at relaunched instead of handing it back.
  // It names its session as Claude's init event does, which the launch records on the card's builder record and thread line.
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + '\\n');\nconsole.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-R1' }));\n${untilTestEnds()};\n`);
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
    assert.match(JSON.parse(fs.readFileSync(path.join(data, 'agents', 'R1.json'), 'utf8')).session.log, /^builder-R1-.*\.log$/);
    // docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md
    const logged = fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.call === 'relaunch');
    assert.deepEqual({ ...logged, at: undefined }, { at: undefined, call: 'relaunch', key: 't/R1', result: 'relaunched', reason: 'Its builder exited with its record open, for the first time.', inputs: { model: 'opus', pid: dead.pid, relaunched: false } });
  } finally {
    await killAndWait(child);
    stopFakeBuilders(seen);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-05-2130-a-restarted-server-launches-the-build-its-pull-left-without-a-builder.md
test("a restarted server launches the builder of an In Progress card whose record is still dispatched and untracked, and leaves a planner and a tracked one alone", async () => {
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
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: ['C1', 'C2', 'C3', 'C4'].map((id) => ({ id, title: id, lane: 'progress' })) }));
  const record = (extra) => JSON.stringify({ started: '2026-11-05T04:42:41.000Z', kind: 'claude', model: 'opus', worktree: { path: wt, branch: 'x', repo: wt }, ...extra });
  fs.writeFileSync(path.join(data, 'agents', 'C1.json'), record({ dispatched: 'hub' }));
  fs.writeFileSync(path.join(data, 'agents', 'C2.json'), record({ dispatched: 'hub', kind: 'grill' }));
  fs.writeFileSync(path.join(data, 'agents', 'C3.json'), record({ dispatched: 'hub' }));
  fs.writeFileSync(path.join(data, 'agents', 'C4.json'), record({}));
  fs.writeFileSync(path.join(data, 'headless-builders.json'), JSON.stringify({ 't/C3': { model: 'opus', pid: process.pid, relaunched: false } }));
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = path.join(home, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + '\\n');\n${untilTestEnds()};\n`);
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
    await killAndWait(child);
    stopFakeBuilders(seen);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
// A local board over a git repo, its wave's items, and a fake claude at bin (by default one that logs each run).
// With init, the fake claude names its session as Claude's first stream-json line does, so its run log reads as a
// Claude run's; start's fastMinute runs the server's minute check every 50ms.
function oneLaunchBoard(items, bin, { init = false } = {}) {
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
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items }));
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = bin ?? path.join(home, 'claude');
  if (!bin) {
    fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\n${init ? "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }));\n" : ''}// Stays running, as a planner does until its own done: the board closes the record of a planner whose process is gone (docs/adr/2026-11-12-1000-a-planner-whose-process-is-gone-closes-at-once.md).\n${untilTestEnds()};\n`);
    fs.chmodSync(fake, 0o755);
  }
  const runs = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const events = () => (fs.existsSync(path.join(data, 'events.jsonl')) ? fs.readFileSync(path.join(data, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).kind) : []);
  const thread = (id) => (fs.existsSync(path.join(data, 'threads', `t__${id}.jsonl`)) ? fs.readFileSync(path.join(data, 'threads', `t__${id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse) : []);
  const record = (id) => JSON.parse(fs.readFileSync(path.join(data, 'agents', `${id}.json`), 'utf8'));
  const item = (id) => JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8')).items.find((i) => i.id === id);
  // The orchestrator's `item brief` on card id: its words, for an agent of kind.
  const brief = (id, kind, words) => {
    const draft = path.join(home, `brief-${id}-${kind}.md`);
    fs.writeFileSync(draft, words);
    return writeBrief(site, `t/${id}`, { kind, file: draft });
  };
  async function start({ fastMinute = false } = {}) {
    const [port] = await freePorts();
    const setup = path.join(home, 'setup.mjs');
    if (fastMinute) fs.writeFileSync(setup, 'const interval = globalThis.setInterval;\nglobalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60000 ? 50 : ms, ...args);\n');
    const child = spawn(process.execPath, [...(fastMinute ? ['--import', setup] : []), path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], { env: { ...process.env, HOME: home, PORT: String(port), KICKFLIP_HUB_PORT: '1', KICKFLIP_CLAUDE: fake } });
    await boardListening(child);
    const send = (kind, body) => fetch(`http://127.0.0.1:${port}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ...body }) }).then((r) => r.json());
    return { child, send };
  }
  // Stops the server and every agent it recorded, waits for each to exit (the server still writes under data/ while it
  // reacts to a dead agent), then removes the folder.
  async function cleanup(child, ...pids) {
    if (child) {
      const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    const agents = path.join(data, 'agents');
    const recorded = fs.existsSync(agents) ? fs.readdirSync(agents).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(agents, f), 'utf8')).session?.pid) : [];
    const all = [...recorded, ...pids].filter(Boolean);
    for (const pid of all) try { process.kill(pid, 'SIGKILL'); } catch {}
    await until(() => all.every((pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code !== 'EPERM'; } }), 'the agents exit');
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  return { home, site, data, clone, runs, events, thread, record, item, brief, start, cleanup };
}

// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
test("the owner's Grill and Prototype taps and a card arriving in Todo launch no planner but owe the orchestrator's brief, which launches it from the card, in the board's repo", async () => {
  const b = oneLaunchBoard([
    { id: 'G1', title: 'Grill me', phase: 'discussing' },
    { id: 'P1', title: 'Draw me', phase: 'discussing' },
    { id: 'Q1', title: 'Plan me' },
  ]);
  const { child, send } = await b.start();
  try {
    await send('grill-more', { key: 't/G1', text: 'Ask about the phone' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(b.runs().length, 0, 'the tap launches nothing');
    assert.deepEqual([b.item('G1').phase, b.item('G1').briefs.map((x) => [x.kind, x.ask, x.brief])], ['grilling', [['grill', { text: 'Ask about the phone' }, undefined]]]);
    const waitsFile = path.join(b.data, 'orchestrator-waits.json');
    await until(() => fs.existsSync(waitsFile) && JSON.parse(fs.readFileSync(waitsFile, 'utf8')).waits.some((w) => w.key === 't/G1' && w.kind === 'brief'), 'the brief waits on the orchestrator');

    await b.brief('G1', 'grill', 'Settled: the footer folds.\nOpen: the phone layout.');
    await untilHeard(() => b.runs().length === 1, 'the brief launches the grill', path.join(b.data, 'nudge'));
    const [grill] = b.runs();
    assert.equal(grill.cwd, fs.realpathSync(b.clone));
    assert.match(grill.argv[1], /builder start t\/G1 --kind grill/);
    assert.match(grill.argv[1], /grilling skill/);
    assert.match(grill.argv[1], /Start from the orchestrator's brief, its notes section "Brief for grill round 1"[^]*Settled: the footer folds\.\nOpen: the phone layout\.[^]*1\. Run/);
    assert.match(grill.argv[1], /The owner asked for this grill, writing: "Ask about the phone"/);
    assert.equal(grill.argv[grill.argv.indexOf('--model') + 1], 'opus');
    assert.deepEqual([b.record('G1').kind, b.record('G1').dispatched, b.record('G1').brief.brief.heading], ['grill', 'hub', 'Brief for grill round 1']);
    await until(() => b.record('G1').session?.log, 'the launch records its session');
    assert.match(b.record('G1').session.log, /^planner-G1-.*\.log$/);
    assert.deepEqual([b.item('G1').lane, b.item('G1').briefs], ['todo', undefined], 'a planner never starts the card, and its brief left the card');

    await send('prototype-request', { key: 't/P1' });
    await b.brief('P1', 'prototype', 'Two takes: a drawer and a sheet.');
    await untilHeard(() => b.runs().length === 2, 'the prototype launches', path.join(b.data, 'nudge'));
    const proto = b.runs()[1];
    assert.match(proto.argv[1], /builder start t\/P1 --kind prototype/);
    assert.match(proto.argv[1], /Two takes: a drawer and a sheet\./);
    assert.equal(proto.argv[proto.argv.indexOf('--model') + 1], 'sonnet');

    // With Auto implement on, the card that arrived in Todo with no planner yet owes its grill's brief; the planned ones don't.
    for (const id of ['G1', 'P1']) fs.writeFileSync(path.join(b.data, 'agents', `${id}.json`), JSON.stringify({ ...b.record(id), done: new Date().toISOString() }));
    fs.writeFileSync(path.join(b.site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
    await untilHeard(() => b.item('Q1').briefs?.length, 'the arrival owes a grill brief', path.join(b.data, 'nudge'));
    assert.deepEqual(b.item('Q1').briefs.map((x) => x.kind), ['grill']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(b.runs().length, 2, 'the arrival launches nothing by itself');
    assert.deepEqual(b.thread('Q1'), [], 'the arrival posts no thread line of its own');
    await b.brief('Q1', 'grill', 'Plan it.');
    await untilHeard(() => b.runs().length === 3, 'its brief launches the grill', path.join(b.data, 'nudge'));
    assert.match(b.runs()[2].argv[1], /builder start t\/Q1 --kind grill/);
    await until(() => b.record('Q1').session?.log, 'the launch records the run');
    assert.ok(!b.events().includes('card-plan'), 'the grill wakes no session');
    // A brief while the card's planner is open launches nothing more, until it finishes.
    await b.brief('Q1', 'grill', 'And the desktop.');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(b.runs().length, 3);
  } finally {
    await b.cleanup(child);
  }
});

// docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md
const usageAt = (home, used) => {
  const file = path.join(home, '.claude', 'kickflip', 'usage.json');
  const resets = new Date(Date.now() + 3600_000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ claude: { at: new Date(Date.now() - 600_000).toISOString(), five_hour: { used_percentage: used, resets_at: resets }, seven_day: { used_percentage: 20, resets_at: resets } } }));
};
const reportUsage = (home, used) => {
  const dir = path.join(home, '.claude', 'kickflip', 'logs');
  const newest = fs.readdirSync(dir).filter((n) => n.endsWith('.log')).sort().at(-1);
  const resetsAt = Math.round(Date.now() / 1000) + 3600;
  fs.appendFileSync(path.join(dir, newest), JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: used / 100, resetsAt, status: 'allowed' }, seven_day: { utilization: 0.2, resetsAt, status: 'allowed' } } } }) + '\n');
};

test('a grill briefed during a pause waits on the card and launches when the pause lifts', async () => {
  const b = oneLaunchBoard([{ id: 'G1', title: 'Grill me', phase: 'grilling' }]);
  usageAt(b.home, 95);
  const { child, send } = await b.start({ fastMinute: true });
  try {
    await send('grill-more', { key: 't/G1', text: 'One more thing' });
    await b.brief('G1', 'grill', 'Ask about the footer.');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(b.runs().length, 0, 'nothing launches while paused');
    assert.equal(b.item('G1').briefs[0].brief.heading, 'Brief for grill round 1', 'the brief waits on the card');
    fs.rmSync(path.join(b.home, '.claude', 'kickflip', 'usage.json'));
    await until(() => b.runs().length === 1, 'the grill launches once the pause lifts');
    assert.match(b.runs()[0].argv[1], /builder start t\/G1 --kind grill/);
    assert.match(b.runs()[0].argv[1], /One more thing/);
    assert.match(b.runs()[0].argv[1], /Ask about the footer\./);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(b.runs().length, 1, 'it launches once');
  } finally {
    await b.cleanup(child);
  }
});

test('within twice the buffer of the line the board starts one agent, and the next once that one has reported its usage', async () => {
  const b = oneLaunchBoard([{ id: 'A1', title: 'First', phase: 'grilling' }, { id: 'A2', title: 'Second', phase: 'grilling' }], undefined, { init: true });
  fs.writeFileSync(path.join(b.site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't', max_planners: 2 }));
  usageAt(b.home, 85);
  const { child } = await b.start({ fastMinute: true });
  try {
    for (const id of ['A1', 'A2']) await await b.brief(id, 'grill', `Grill ${id}.`);
    await untilHeard(() => b.runs().length === 1, 'the first grill launches', path.join(b.data, 'nudge'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(b.runs().length, 1, 'the second waits for the first run to report');
    reportUsage(b.home, 86);
    await until(() => b.runs().length === 2, 'the second grill launches once the first has reported');
  } finally {
    await b.cleanup(child);
  }
});

test('a build whose builder fails to launch goes back to Todo with the reason, and wakes no session', async () => {
  const b = oneLaunchBoard([{ id: 'F1', title: 'feat: fail me', phase: 'ready', size: 'large' }], path.join(os.tmpdir(), 'no-such-claude-here'));
  const { child, send } = await b.start();
  try {
    const tapped = await send('card-build', { key: 't/F1' });
    assert.equal(tapped.id, null);
    const last = b.thread('F1').at(-1);
    assert.equal(last.line, 'build-refused');
    assert.match(last.text, /^Couldn't start implementing: the launch failed: .*ENOENT/);
    assert.equal(b.item('F1').lane, 'todo', 'back in Todo');
    assert.ok(b.record('F1').done, 'its builder record is closed');
    assert.ok(!b.events().includes('card-build'));
  } finally {
    await b.cleanup(child);
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

// docs/adr/2026-11-12-2100-a-ps-with-no-answer-closes-no-planner.md
test('an agent may run when ps gave no answer, and not when ps answered without its pid', () => {
  const agent = { pid: 7, at: new Date().toISOString() };
  assert.equal(agentMayRun(agent, { starts: () => null }), true);
  assert.equal(agentMayRun(agent, { starts: () => new Map() }), false);
  assert.equal(agentMayRun(agent, { starts: () => new Map([[7, Date.parse(agent.at) - 5000]]) }), true);
});

// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
test("the owner's Hold pauses the card's running builder at its next progress report, and Resume carries on its own session", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-fake-'));
  const fake = path.join(home, 'claude');
  const seen = path.join(home, 'runs.jsonl');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\nconsole.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-' + process.pid }));\n${untilTestEnds()};\n`);
  fs.chmodSync(fake, 0o755);
  const runs = () => fs.readFileSync(seen, 'utf8').trim().split('\n').map(JSON.parse);
  const b = oneLaunchBoard([{ id: 'H1', title: 'feat: hold me', phase: 'ready', size: 'large' }], fake);
  const { child, send } = await b.start();
  let pid, resumed;
  try {
    await until(() => b.record('H1').session?.pid, 'the pull of the ready card records the agent pid');
    ({ pid } = b.record('H1').session);
    const session =b.record('H1').session.id;
    await send('card-hold', { key: 't/H1', hold: true });
    assert.doesNotThrow(() => process.kill(pid, 0), 'the builder runs on to its stopping point');
    assert.deepEqual({ done: b.record('H1').done, pause: b.record('H1').pause?.cause, lane: b.item('H1').lane }, { done: undefined, pause: 'held', lane: 'progress' }, `read the record ${JSON.stringify(b.record('H1'))}`);
    assert.deepEqual(b.thread('H1').at(-1).text, 'Held', 'nothing stopped, so no stop line');
    const old = process.env.HOME;
    process.env.HOME = b.home;
    try { assert.match((await builderProgress(b.site, 't/H1', 'Writing the test', { phase: 'building' })).lines[0], /^Paused: held\. Commit what you have now/); } finally { process.env.HOME = old; }
    assert.equal(b.thread('H1').at(-1).text, 'Paused at building: held. It resumes once you unhold it.');
    process.kill(pid, 'SIGKILL');
    await send('card-hold', { key: 't/H1', hold: false });
    await untilHeard(() => b.record('H1').session?.pid && b.record('H1').session.pid !== pid, 'the resume launches its session again', path.join(b.data, 'nudge'));
    resumed = b.record('H1').session.pid;
    const [, again] = runs();
    assert.deepEqual(again.argv.slice(0, 2), ['--resume', session]);
    assert.match(again.argv[3], /^The board paused your build of card H1, and the pause has cleared: unheld\. Carry on where you stopped/);
    assert.equal(again.cwd, fs.realpathSync(b.record('H1').worktree.path));
    assert.deepEqual([b.record('H1').pause, b.record('H1').done], [undefined, undefined]);
    assert.ok(b.thread('H1').some((t) => t.text === 'Resumed: unheld.'));
  } finally {
    await b.cleanup(child, pid, resumed);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md
test("Resume relaunches the grill a Hold stopped from the brief it ran on, and neither tap wakes a session", async () => {
  const b = oneLaunchBoard([{ id: 'G2', title: 'Grill me', phase: 'grilling' }]);
  const { child, send } = await b.start();
  try {
    await send('grill-more', { key: 't/G2', text: 'Ask about the footer' });
    await b.brief('G2', 'grill', 'Cover the footer on a phone.');
    await untilHeard(() => b.runs().length === 1, 'the grill launches', path.join(b.data, 'nudge'));
    assert.match(b.runs()[0].argv[1], /Ask about the footer/, 'the typed text goes to the planner');
    await send('card-hold', { key: 't/G2', hold: true });
    assert.ok(b.record('G2').done, 'the hold closed the grill');
    await send('card-hold', { key: 't/G2', hold: false });
    await until(() => b.runs().length === 2, 'the resume launches the grill again');
    assert.match(b.runs()[1].argv[1], /builder start t\/G2 --kind grill/);
    assert.match(b.runs()[1].argv[1], /Cover the footer on a phone\.[^]*Ask about the footer/, 'with its brief and the ask it answered');
  } finally {
    await b.cleanup(child);
  }
});

test('a stale lander entry for an archived Done card is dropped, and the card stays archived', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-lander-stale-'));
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'manifest.json'), JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main' } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ id: 'D1', title: 'Landed', lane: 'done', closed_at: '2026-11-01T00:00:00.000Z' }, { id: 'T1', title: 'Other', lane: 'todo' }] }));
  await archiveCards(site, [{ key: 't/D1', closed_at: '2026-11-01T00:00:00.000Z' }]);
  fs.writeFileSync(path.join(data, 'landers.json'), JSON.stringify({ 't/D1': { verified: 'v1', pid: 2 ** 22 + 12345 } }));
  const [port] = await freePorts();
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], { env: { ...process.env, HOME: home, PORT: String(port), KICKFLIP_HUB_PORT: '1' } });
  try {
    await boardListening(child);
    await until(() => !('t/D1' in JSON.parse(fs.readFileSync(path.join(data, 'landers.json'), 'utf8'))), 'the stale entry is dropped');
    assert.deepEqual((await readArchive(site)).map((a) => a.key), ['t/D1']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8')).items.map((i) => i.id), ['T1']);
  } finally {
    await killAndWait(child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
test("a visual agent's brief has it start as its own agent, read the card and thread, write one page, place it with visual add and finish, touching nothing else", () => {
  const b = `node ${BOARD_CLI} --site shop`;
  const brief = visualBrief({ ...card, repo: '/r/shop', agent: 'visual-e1', text: 'Draw the land queue' });
  for (const want of [
    'ENG-1', 'Make it go', '/s/waves/w/a1.md', `${b} builder start w/A1 --kind visual --agent visual-e1`, 'Draw the land queue',
    `${b} visual add w/A1 --file`, '--title', `${b} builder done w/A1 --agent visual-e1`, 'CDN', 'Never push',
  ]) assert.ok(brief.includes(want), `the visual brief has ${want}`);
  assert.ok(!brief.includes('question add') && !brief.includes('item set'), 'a visual posts no question and moves no card');
  assert.ok(brief.indexOf('visual add') < brief.indexOf(`${b} builder done`));
  assert.doesNotMatch(visualBrief({ ...card, repo: '/r/shop', agent: 'visual-e1' }), /The owner wrote/, 'with no text from the owner, the orchestrator\'s brief says what to draw');
});

// docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md
test('a new task launches no agent: it arrives as a New card that waits on the orchestrator, which sorts it', async () => {
  const b = oneLaunchBoard([{ id: 'A1', title: 'Filed', phase: 'grilling', lane: 'progress' }]);
  const { child, send } = await b.start();
  try {
    const { id } = await send('ask', { text: 'Make the header blue' });
    const filed = JSON.parse(fs.readFileSync(path.join(b.data, 'items.json'), 'utf8')).items.find((i) => i.from_ask === id);
    assert.deepEqual([filed.title, filed.lane, filed.phase], ['Make the header blue', 'todo', undefined]);
    const waitsFile = path.join(b.data, 'orchestrator-waits.json');
    await until(() => fs.existsSync(waitsFile) && JSON.parse(fs.readFileSync(waitsFile, 'utf8')).waits.some((w) => w.key === `t/${filed.id}` && w.kind === 'intake'), 'the intake wait');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(b.runs().length, 0);
    assert.equal(fs.existsSync(path.join(b.data, 'intake-runs.json')), false);
  } finally {
    await b.cleanup(child);
  }
});

test("the owner's visual request owes the orchestrator's visual brief, which launches a visual agent on Sonnet beside the card's build, as its own agent, and a second waits for the first to finish", async () => {
  const b = oneLaunchBoard([{ id: 'V1', title: 'Show me', lane: 'progress' }]);
  fs.mkdirSync(path.join(b.data, 'agents'), { recursive: true });
  const build = { kind: 'claude', model: 'opus', started: new Date().toISOString(), worktree: { path: b.clone } };
  fs.writeFileSync(path.join(b.data, 'agents', 'V1.json'), JSON.stringify(build));
  const { child, send } = await b.start();
  try {
    await send('visual-request', { key: 't/V1', text: 'Draw the queue' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(b.runs().length, 0, 'the tap launches nothing');
    assert.deepEqual([b.item('V1').lane, b.item('V1').briefs.map((x) => [x.kind, x.ask])], ['progress', [['visual', { text: 'Draw the queue' }]]]);
    await b.brief('V1', 'visual', 'The land queue as a flow, oldest first.');
    await untilHeard(() => b.runs().length === 1, 'the visual agent launches beside the build', path.join(b.data, 'nudge'));
    const [run] = b.runs();
    const agent = /--agent (visual-\d+)/.exec(run.argv[1])[1];
    assert.equal(run.cwd, fs.realpathSync(b.clone));
    assert.match(run.argv[1], new RegExp(`builder start t/V1 --kind visual --agent ${agent}`));
    assert.match(run.argv[1], /The land queue as a flow, oldest first\.[^]*Draw the queue/);
    assert.equal(run.argv[run.argv.indexOf('--model') + 1], 'sonnet');
    const visual = b.record(`V1@${agent}`);
    assert.deepEqual([visual.kind, visual.model, visual.dispatched, visual.brief.brief.heading], ['visual', 'sonnet', 'hub', 'Brief for visual round 1']);
    assert.deepEqual(b.record('V1'), build, "the build's record is untouched");
    await until(() => b.record(`V1@${agent}`).session?.log, 'the launch records the run');

    await b.brief('V1', 'visual', 'Now the review lane.');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(b.runs().length, 1, 'the second waits while the first runs');
    fs.writeFileSync(path.join(b.data, 'agents', `V1@${agent}.json`), JSON.stringify({ ...b.record(`V1@${agent}`), done: new Date().toISOString() }));
    await untilHeard(() => b.runs().length === 2, 'the second launches once the first is done', path.join(b.data, 'nudge'));
    assert.doesNotMatch(b.runs()[1].argv[1], new RegExp(`--agent ${agent}\\b`));
    assert.match(b.runs()[1].argv[1], /Now the review lane\./);
  } finally {
    await b.cleanup(child);
  }
});

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
test("a helper's brief gives it the task as its own agent, in its worktree when it writes, read-only otherwise, and has it hand back with done --text", () => {
  const b = `node ${BOARD_CLI} --site shop`;
  const writing = helperBrief({ ...card, agent: 'tests', task: 'Write the scroll tests in board/ui.test.mjs', writes: true, cwd: '/wt/A1-tests' });
  for (const want of [
    'ENG-1', 'Make it go', 'Write the scroll tests in board/ui.test.mjs', '/wt/A1-tests', `${b} builder start w/A1 --kind helper --agent tests`,
    `${b} builder progress w/A1 --agent tests --phase`, 'commit your work there', `${b} builder done w/A1 --agent tests --text`, 'Never push',
  ]) assert.ok(writing.includes(want), `the helper brief has ${want}`);
  assert.ok(!writing.includes('builder call') && !writing.includes('question add'), 'a helper records no calls and asks no questions');
  const reading = helperBrief({ ...card, agent: 'survey', task: 'Find every caller', writes: false, cwd: '/r/shop' });
  assert.match(reading, /change no files there and commit nothing/);
  assert.ok(!reading.includes('commit your work'));
  const build = builderBrief(card);
  for (const want of [`${b} agent launch w/A1 --name`, '--writes', `${b} agent wait w/A1 --name`, `${b} agent merge w/A1 --name`]) assert.ok(build.includes(want), `the builder brief has ${want}`);
});

// docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md
test("a builder's, a lander's and a writing helper's brief give the commit standard, the card's ref in a Refs trailer and never in the subject, and the builder titles a PR with --title", () => {
  const build = builderBrief(card);
  const helper = helperBrief({ ...card, agent: 'tests', task: 'x', writes: true, cwd: '/wt/A1-tests' });
  for (const brief of [build, helper, landerBrief(card)]) {
    assert.ok(brief.includes(standardWords('ENG-1')), brief);
    assert.ok(brief.includes('"Refs: ENG-1"'));
    assert.ok(!brief.includes('"ENG-1: <'), 'no subject starts with the ref');
  }
  assert.ok(build.includes(`--title "<type>(<scope>): <what the PR does>"`), build);
});

test('a writing helper waits while the board has no implementer slot free, launches once its spawner waits on it, in its own worktree off the card branch', async () => {
  const b = oneLaunchBoard([{ id: 'V1', title: 'Split me', lane: 'progress' }]);
  fs.writeFileSync(path.join(b.site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't', max_implementers: 1 }));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const cardTree = path.join(b.home, '.claude', 'kickflip', 'worktrees', 'V1');
  git(b.clone, 'worktree', 'add', '--quiet', '-b', 'V1', cardTree, 'main');
  fs.mkdirSync(path.join(b.data, 'agents'), { recursive: true });
  const main = { kind: 'claude', model: 'opus', started: new Date().toISOString(), worktree: { path: cardTree, branch: 'V1', repo: b.clone } };
  const write = (name, value) => fs.writeFileSync(path.join(b.data, 'agents', `${name}.json`), JSON.stringify(value));
  write('V1', main);
  const { child } = await b.start();
  try {
    write('V1@tests', { label: 'tests', kind: 'helper', task: 'Write the split tests', writes: true, model: 'sonnet', requested: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(b.runs().length, 0, 'the build holds the one slot, so the helper waits');
    assert.equal(b.record('V1@tests').started, undefined);
    write('V1', { ...main, waits: 'tests' });
    await until(() => b.runs().length === 1, 'the build waiting on its helper frees the slot');
    const [run] = b.runs();
    const tree = path.join(b.home, '.claude', 'kickflip', 'worktrees', 'V1-tests');
    assert.equal(run.cwd, fs.realpathSync(tree));
    assert.match(run.argv[1], /builder start t\/V1 --kind helper --agent tests/);
    assert.match(run.argv[1], /Write the split tests/);
    assert.equal(run.argv[run.argv.indexOf('--model') + 1], 'sonnet');
    const helper = b.record('V1@tests');
    assert.deepEqual([helper.kind, helper.dispatched, helper.task, helper.writes, helper.worktree.branch], ['helper', 'hub', 'Write the split tests', true, 'V1-tests']);
    assert.equal(git(tree, 'rev-parse', 'HEAD'), git(cardTree, 'rev-parse', 'HEAD'), "it branches from the card's branch");
    await until(() => b.record('V1@tests').session?.log, 'the launch records the run');
  } finally {
    await b.cleanup(child);
  }
});

