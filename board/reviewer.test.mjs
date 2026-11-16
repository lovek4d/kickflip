// docs/adr/2026-11-16-2300-review-in-a-thread-launches-a-reviewer.md
// /review in a card's thread: the card owes the orchestrator a reviewer brief on any open lane, the board launches a
// reviewer beside whatever else runs, reviewing the diff once a worktree holds one and the plan before, which shows as
// a grey Reviewer row in the thread and on the card, and posts its findings as one ranked message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { buildBoard, briefsDue, threadOf, REVIEWER, plans } from './domain.mjs';
import { reviewerBrief, BOARD_CLI } from './headless.mjs';
import { board, home, site, read, write, lines } from './board-fixture.mjs';
import { ON_CARD, PLAIN, recordOnly } from '../bin/event-lines.mjs';
import { fixedDate } from '../shared/fixed-clock.mjs';
import { footerOf } from './domain.mjs';

const at = (m) => `2026-11-16T10:${String(m).padStart(2, '0')}:00.000Z`;
const briefed = (kind) => ({ kind, at: at(1), brief: { heading: `Brief for ${kind} round 1`, text: 'Attack the land path', at: at(2) } });

test('a reviewer is a planner kind: it writes no code, so it never starts a card', () => {
  assert.equal(REVIEWER, 'reviewer');
  assert.equal(plans({ kind: REVIEWER }), true);
});

test('briefsDue launches a written reviewer brief on any open card beside anything but another reviewer', () => {
  const card = (key, briefs, more = {}) => ({ key, lane: 'progress', kind: 'work', agents: [], briefs, ...more });
  const running = (kind) => ({ kind, started: at(3), done: null });
  const items = [
    card('w/R1', [briefed(REVIEWER)], { agents: [running('claude'), running('visual')] }),
    card('w/R2', [briefed(REVIEWER)], { lane: 'todo', agents: [running('grill')] }),
    card('w/R3', [briefed(REVIEWER)], { agents: [running(REVIEWER)] }),
    card('w/R4', [{ kind: REVIEWER, at: at(1) }]),
    card('w/R5', [briefed(REVIEWER)], { lane: 'done' }),
    // A reviewer running doesn't hold back the card's grill.
    card('w/G1', [briefed('grill')], { lane: 'todo', phase: 'grilling', agents: [running(REVIEWER)] }),
  ];
  assert.deepEqual(briefsDue(items), [{ key: 'w/R1', kind: REVIEWER }, { key: 'w/R2', kind: REVIEWER }, { key: 'w/G1', kind: 'grill' }]);
});

const built = (item, agents) => buildBoard({ fromWaves: false, events: [], owner: {}, prs: {}, now: Date.parse(at(30)),
  files: [{ slug: 'w', agents: agents ? { A1: agents } : {}, itemFile: { internal: true, items: [{ id: 'A1', title: 'feat: one', lane: 'progress', ...item }] } }] }).items[0];

test('a card owing a reviewer brief waits on the orchestrator to write it in any open lane', () => {
  const review = built({ lane: 'review', briefs: [{ kind: REVIEWER, at: at(5) }] });
  assert.equal(review.orchestrator?.kind, 'brief', 'In Review too');
  const it = built({ briefs: [{ kind: REVIEWER, at: at(5), ask: { text: 'Look at the races' } }] }, { main: { kind: 'claude', model: 'opus', started: at(4) } });
  const wait = [it.orchestrator, ...it.moreWaits].find((w) => w?.kind === 'brief');
  assert.deepEqual([it.briefing, it.planning], [null, null], "the card's status line stays its work's");
  assert.ok(wait, 'the brief is owed past Todo');
  assert.match(wait.next, /item brief w\/A1 --kind reviewer --file <draft\.md>/);
  assert.match(wait.next, /what the review should cover/);
});

test("a running reviewer gives the card its grey Reviewer row and leaves the build's line as it is", () => {
  const agents = {
    main: { kind: 'claude', model: 'opus', started: at(4) },
    'reviewer-1': { kind: REVIEWER, model: 'opus', started: at(20), target: 'diff' },
  };
  const it = built({}, agents);
  assert.deepEqual(it.reviewer, { target: 'diff', since: at(20) });
  assert.equal(it.builder.planner, false, "the build's line stays the build's");
  assert.equal(built({}, { ...agents, 'reviewer-1': { ...agents['reviewer-1'], done: at(25) } }).reviewer, null);
  assert.deepEqual(built({ lane: 'todo' }, { 'reviewer-1': { kind: REVIEWER, started: at(20), target: 'plan' } }).reviewer, { target: 'plan', since: at(20) });
});

test("the thread names a reviewer's run Reviewer with what it reviews, grey, and passes its findings message through", () => {
  const agents = { 'reviewer-1': { kind: REVIEWER, model: 'opus', started: at(20), target: 'plan' } };
  const findings = [{ severity: 'high', at: 'board/server.mjs:12', text: 'Two lands interleave.' }];
  const msgs = threadOf('w/A1', { agents, lines: [{ ts: at(22), who: 'reviewer', kind: REVIEWER, text: '1 finding on the plan', findings }] });
  const started = msgs.find((m) => m.kind === 'agent');
  assert.deepEqual([started.agent, started.reviewer, started.planner], ['Reviewer', 'plan', undefined]);
  const posted = msgs.find((m) => m.kind === REVIEWER);
  assert.deepEqual([posted.who, posted.text, posted.findings], ['reviewer', '1 finding on the plan', findings]);
});

// The CLI and store, on the audit board (data/items.json, task A1).
const audit = (...p) => site('audit', ...p);
const a1 = () => read(audit('data', 'items.json')).items.find((i) => i.id === 'A1');
async function store() {
  process.env.HOME = home;
  return import('./store.mjs');
}
const inProgress = () => {
  const file = read(audit('data', 'items.json'));
  write(audit('data', 'items.json'), { ...file, items: file.items.map((i) => (i.id === 'A1' ? { ...i, lane: 'progress', title: 'feat(board): one' } : i)) });
};

test('a Review tap on an In Progress card owes the reviewer brief and moves nothing; item brief --kind reviewer writes it there', async () => {
  const s = await store();
  inProgress();
  await s.planAgain(audit(), 'audit/A1', REVIEWER, { text: 'Look at the races' });
  assert.deepEqual([a1().lane, a1().phase, a1().briefs.map((b) => [b.kind, b.ask])], ['progress', undefined, [[REVIEWER, { text: 'Look at the races' }]]]);
  const draft = path.join(home, 'brief.md');
  fs.writeFileSync(draft, 'Attack the land path.');
  const r = await board('item', 'brief', 'audit/A1', '--kind', REVIEWER, '--file', draft, '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.match(r.out, /the board launches its reviewer from it/);
  assert.deepEqual([a1().lane, a1().briefs[0].brief.heading], ['progress', 'Brief for reviewer round 1']);
  assert.equal(fs.existsSync(audit('data', 'threads', 'audit__A1.jsonl')), false, "the owner's /review wrote that line, so the brief adds no started line");
});

test('a reviewer brief nobody asked for reads "Review started" under the magnifying glass', async () => {
  await store();
  inProgress();
  const draft = path.join(home, 'brief.md');
  fs.writeFileSync(draft, 'Attack the land path.');
  await board('item', 'brief', 'audit/A1', '--kind', REVIEWER, '--file', draft, '--site', 'audit');
  assert.deepEqual(lines(audit('data', 'threads', 'audit__A1.jsonl')).filter((l) => l.command === 'reviewer-started').map((l) => [l.who, l.text]), [['claude', 'Review started']]);
  assert.equal(ui.MARK_ICONS['Review started'], ui.MARK_ICONS['Review requested']);
});

test("the board's start of a reviewer reviews the diff while the card's worktree is there, else the plan", async () => {
  const s = await store();
  inProgress();
  const draft = path.join(home, 'brief.md');
  fs.writeFileSync(draft, 'Attack it.');
  await board('item', 'brief', 'audit/A1', '--kind', REVIEWER, '--file', draft, '--site', 'audit');
  const plan = await s.startReviewer(audit(), 'audit/A1');
  assert.match(plan.agent, /^reviewer-\d+$/);
  assert.equal(plan.target, 'plan');
  const record = () => read(audit('data', 'agents', `A1@${plan.agent}.json`));
  assert.deepEqual([record().kind, record().target, record().dispatched, record().model], [REVIEWER, 'plan', 'hub', 'opus']);
  // Its own builder start keeps what it reviews.
  assert.equal((await board('builder', 'start', 'audit/A1', '--kind', REVIEWER, '--agent', plan.agent, '--site', 'audit')).code, 0);
  assert.equal(record().target, 'plan');
  assert.equal(await s.startReviewer(audit(), 'audit/A1'), null, 'one reviewer at a time on a card');
  await board('builder', 'done', 'audit/A1', '--agent', plan.agent, '--site', 'audit');

  const wt = path.join(home, 'wt-A1');
  fs.mkdirSync(wt, { recursive: true });
  write(audit('data', 'agents', 'A1.json'), { kind: 'claude', model: 'opus', started: at(1), worktree: { path: wt, branch: 'A1' } });
  await board('item', 'brief', 'audit/A1', '--kind', REVIEWER, '--file', draft, '--site', 'audit');
  const diff = await s.startReviewer(audit(), 'audit/A1');
  assert.equal(diff.target, 'diff');
  assert.equal(read(audit('data', 'agents', `A1@${diff.agent}.json`)).target, 'diff');
});

test('reviewer post writes the findings as one Reviewer message, most severe first, and refuses a malformed list', async () => {
  await store();
  inProgress();
  write(audit('data', 'agents', 'A1@reviewer-1.json'), { kind: REVIEWER, model: 'opus', started: at(1), target: 'diff' });
  const file = path.join(home, 'findings.json');
  const post = (value) => { fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return board('reviewer', 'post', 'audit/A1', '--file', file, '--site', 'audit'); };
  const r = await post([
    { severity: 'low', at: 'board/a.mjs:3', text: 'A read twice.' },
    { severity: 'high', at: 'board/b.mjs:9', text: 'Two lands interleave.' },
    { severity: 'medium', text: 'The notes and the code disagree on the order.' },
    { severity: 'high', at: 'board/c.mjs:1', text: 'The lock is never released.' },
  ]);
  assert.deepEqual([r.code, r.err], [0, '']);
  const posted = lines(audit('data', 'threads', 'audit__A1.jsonl')).filter((m) => m.kind === REVIEWER);
  assert.equal(posted.length, 1);
  assert.deepEqual([posted[0].who, posted[0].text], ['reviewer', '4 findings on the diff, most severe first']);
  assert.deepEqual(posted[0].findings.map((f) => f.text), ['Two lands interleave.', 'The lock is never released.', 'The notes and the code disagree on the order.', 'A read twice.']);
  assert.equal(posted[0].findings[2].at, undefined);

  assert.equal((await post([])).code, 0);
  assert.equal(lines(audit('data', 'threads', 'audit__A1.jsonl')).filter((m) => m.kind === REVIEWER).at(-1).text, 'No findings on the diff');
  assert.match((await post([{ severity: 'critical', text: 'x' }])).err, /severity high, medium or low/);
  assert.match((await post([{ severity: 'low', text: '' }])).err, /text/);
  assert.match((await post('{nope')).err, /JSON/);
  assert.match((await post({ findings: [] })).err, /a JSON list/);
});

const brief = { heading: 'Brief for reviewer round 1', text: 'Attack the land path.' };
const card = { route: 'shop', key: 'w/A1', ref: 'ENG-1', title: 'Make it go', notes: '/s/waves/w/a1.md', thread: '/s/data/threads/w__A1.jsonl', repo: '/r/shop', base: 'main', agent: 'reviewer-1', brief };

test("a reviewer's brief opens with the orchestrator's, reviews the worktree's diff or the plan, and posts with reviewer post", () => {
  const b = `node ${BOARD_CLI} --site shop`;
  const diff = reviewerBrief({ ...card, target: 'diff', worktree: '/wt/A1', text: 'Look at the races' });
  assert.ok(diff.indexOf('Attack the land path.') < diff.indexOf('1. Run'));
  for (const want of [`${b} builder start w/A1 --kind reviewer --agent reviewer-1`, 'git -C /wt/A1 diff main', `${b} reviewer post w/A1 --file`, `${b} builder done w/A1 --agent reviewer-1`, 'Look at the races', '/s/waves/w/a1.md', card.thread]) {
    assert.ok(diff.includes(want), want);
  }
  const plan = reviewerBrief({ ...card, target: 'plan' });
  assert.ok(!plan.includes('git -C'), 'a plan review reads no diff');
  assert.match(plan, /review the plan/i);
  assert.throws(() => reviewerBrief({ ...card, target: 'plan', brief: null }), /no orchestrator's brief/);
});

test("a review-request wakes no session and has the watcher's line", () => {
  const e = { id: 'e1', ts: at(1), kind: 'review-request', data: { key: 'w/A1' } };
  assert.equal(recordOnly(JSON.stringify(e)), true);
  assert.ok(Object.hasOwn(ON_CARD, 'review-request') || Object.hasOwn(PLAIN, 'review-request'));
});

// The page's helpers, in a sandbox as ui.test.mjs loads them.
const NOW = Date.parse(at(30));
const context = vm.createContext({ Date: fixedDate(() => NOW), location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout, AbortController });
for (const file of ['ui-icon-text.js', 'ui.js', 'ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js', 'ui-threads.js', 'ui-markdown.js']) {
  vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
}
const ui = context.BoardUI;
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

test('/review is a thread request word, never a New task one', () => {
  assert.deepEqual({ ...ui.slashOf('/review the races', { thread: true }) }, { flag: 'review', text: 'the races' });
  assert.deepEqual({ ...ui.slashOf('/review the races') }, { flag: null, text: '/review the races' });
  assert.equal(ui.slashOf('/grill it', { thread: true }).flag, 'grill');
  assert.ok(ui.MARK_ICONS['Review requested']);
});

test('the thread draws a running reviewer as one grey Reviewer row with what it reviews and for how long, and its findings as one ranked message, the top three shown', () => {
  const agents = { 'reviewer-1': { kind: REVIEWER, model: 'opus', started: at(20), target: 'diff' } };
  const running = ui.threadMessages(threadOf('w/A1', { agents }));
  assert.match(running, /class="msg status-line [^"]*reviewer/);
  assert.doesNotMatch(running, /planner/);
  assert.match(textOf(running), /Reviewer · Reviewing the diff \(10m\)/);
  const findings = ['high', 'high', 'medium', 'low', 'low'].map((severity, i) => ({ severity, at: `board/x.mjs:${i + 1}`, text: `Finding ${i + 1}.` }));
  const done = { ...agents, 'reviewer-1': { ...agents['reviewer-1'], done: at(25) } };
  const html = ui.threadMessages(threadOf('w/A1', { agents: done, lines: [{ ts: at(25), who: 'reviewer', kind: REVIEWER, text: '5 findings on the diff, most severe first', findings }] }));
  assert.match(textOf(html), /Reviewer · finished/);
  const message = html.slice(html.indexOf('class="msg reviewer'));
  assert.match(message, /<div class="who">Reviewer<\/div>/);
  assert.match(textOf(message), /5 findings on the diff, most severe first high board\/x\.mjs:1 Finding 1\. high board\/x\.mjs:2 Finding 2\. medium board\/x\.mjs:3 Finding 3\. Show all 5/);
  assert.ok(message.indexOf('Finding 4.') > message.indexOf('<details'), 'the rest fold under Show all');
});

test("the card shows a running reviewer as a grey Reviewer row under its status line", () => {
  const it = { key: 'w/A1', kind: 'work', lane: 'progress', title: 'feat: one', ref: 'A1', agents: [], blockedBy: [], reviewer: { target: 'plan', since: at(28) }, next: 'Land it' };
  const html = ui.workLines({ footer: footerOf(it), ...it });
  assert.match(html, /<div class="line3 sub agent waiting-gray reviewer">[^]*Reviewer · Reviewing the plan \(2m\)(<\/span>)?<\/div>/);
});
