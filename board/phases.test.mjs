// docs/adr/2026-11-11-1200-every-lane-has-phases.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { at, site, write, read, lines, board, wave } from './board-fixture.mjs';
import { moveCard, migratePhases } from './store.mjs';
import { buildBoard, movesOf, PHASES } from './domain.mjs';

const auditItem = (id = 'A1') => read(site('audit', 'data', 'items.json')).items.find((i) => i.id === id);
const auditThread = (id = 'A1') => { try { return lines(site('audit', 'data', 'threads', `audit__${id}.jsonl`)); } catch { return []; } };
const moveLines = (id) => auditThread(id).filter((m) => m.kind === 'move').map((m) => m.text);

test("each lane's phases, in order: Todo's, the five build steps, In Review's and Done's", async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(PHASES)), {
    todo: ['new', 'discussing', 'grilling', 'prototyping', 'staging', 'ready'],
    progress: ['reading', 'building', 'testing', 'checking', 'landing'],
    review: ['draft', 'reviewers', 'merge', 'stale'],
    done: ['merged', 'closed'],
  });
});

test('item add and item set take --phase, store it as phase, and refuse --state naming --phase', async () => {
  const added = await board('item', 'add', 'audit/B2', '--site', 'audit', '--title', 'feat: two', '--phase', 'grilling');
  assert.equal(added.code, 0, added.err);
  assert.deepEqual([auditItem('B2').phase, 'state' in auditItem('B2')], ['grilling', false]);
  for (const args of [['item', 'set', 'audit/B2', '--state', 'prototyping'], ['item', 'add', 'audit/B3', '--title', 'feat: three', '--state', 'grilling']]) {
    const r = await board(...args, '--site', 'audit');
    assert.equal(r.code, 1);
    assert.match(r.err, /^--state is now --phase/);
  }
  assert.equal((await board('item', 'set', 'audit/B2', '--site', 'audit', '--phase', 'prototyping')).code, 0);
  assert.equal(auditItem('B2').phase, 'prototyping');
});

test("--phase sets only a Todo card's phase", async () => {
  assert.equal((await board('item', 'add', 'audit/B2', '--site', 'audit', '--title', 'feat: two', '--phase', 'grilling')).code, 0);
  assert.equal((await board('builder', 'start', 'audit/B2', '--site', 'audit', '--kind', 'claude')).code, 0);
  const r = await board('item', 'set', 'audit/B2', '--site', 'audit', '--phase', 'grilling');
  assert.equal(r.code, 1);
  assert.match(r.err, /--phase sets a Todo card's phase; audit\/B2 is In Progress/);
});

test('moveCard writes the lane and its phase together; a phase change inside a lane writes no line', async () => {
  const dir = site('audit');
  await moveCard(dir, 'audit/A1', 'todo', 'nothing builds it');
  assert.equal(await moveCard(dir, 'audit/A1', 'progress', 'a build started', 'reading'), 'Moved to In Progress: a build started');
  assert.deepEqual([auditItem().lane, auditItem().phase], ['progress', 'reading']);
  assert.equal(await moveCard(dir, 'audit/A1', 'progress', 'a build started', 'testing'), null);
  assert.deepEqual([auditItem().lane, auditItem().phase], ['progress', 'testing']);
  assert.equal(await moveCard(dir, 'audit/A1', 'progress', 'a build started', 'testing'), null);
  assert.equal(await moveCard(dir, 'audit/A1', 'review', 'PR #5 opened', 'draft'), 'Moved to In Review: PR #5 opened');
  assert.equal(await moveCard(dir, 'audit/A1', 'review', 'x', 'reviewers'), null);
  assert.equal(auditItem().phase, 'reviewers');
  assert.deepEqual(moveLines('A1'), ['Moved to In Progress: a build started', 'Moved to In Review: PR #5 opened']);
  await assert.rejects(moveCard(dir, 'audit/A1', 'review', 'x', 'closing'), /no In Review phase "closing"/);
});

test("the store's own moves write the phase: a build's start reads reading, a block that leaves it in place, a close merged or closed", async () => {
  write(site('audit', 'data', 'items.json'), { ...wave(), items: [{ id: 'A1', title: 'feat: one', lane: 'todo', phase: 'ready' }, { id: 'A2', title: 'feat: two', lane: 'todo', phase: 'ready' }, { id: 'A4', title: 'feat: four', lane: 'progress', phase: 'testing' }] });
  assert.equal((await board('builder', 'start', 'audit/A1', '--site', 'audit', '--kind', 'claude')).code, 0);
  assert.deepEqual([auditItem().lane, auditItem().phase], ['progress', 'reading']);
  write(site('audit', 'data', 'agents', 'A4.json'), { kind: 'claude', started: '2026-11-04T09:00:00Z', done: '2026-11-04T10:00:00Z', handed_back: '2026-11-04T10:00:00Z' });
  const blocked = await board('item', 'set', 'audit/A4', '--site', 'audit', '--blocked-until', 'the API ships');
  assert.equal(blocked.code, 0, blocked.err);
  assert.deepEqual([auditItem('A4').lane, auditItem('A4').phase], ['progress', 'testing'], 'a handed-back card stays where it is');
  assert.equal((await board('item', 'set', 'audit/A2', '--site', 'audit', '--done', '--text', 'Dropped: superseded.')).code, 0);
  assert.deepEqual([auditItem('A2').lane, auditItem('A2').phase], ['done', 'closed']);
});

test('a merge closes the card merged', async () => {
  write(site('audit', 'data', 'items.json'), { ...wave(), items: [{ id: 'A3', title: 'Three', lane: 'review', phase: 'reviewers', prs: [{ number: 5 }] }] });
  const { setItem } = await import('./store.mjs');
  await setItem(site('audit'), 'audit/A3', { merged: [{ number: 5 }], force: true });
  assert.deepEqual([auditItem('A3').lane, auditItem('A3').phase], ['done', 'merged']);
});

test("the phase migration renames each card's state to phase and gives a Done card merged or closed, in the wave files and the archive", async () => {
  write(site('audit', 'data', 'items.json'), { ...wave(), items: [
    { id: 'T1', title: 'Todo', lane: 'todo', state: 'staging' },
    { id: 'T2', title: 'New', lane: 'todo' },
    { id: 'M1', title: 'Merged PR', lane: 'done', state: 'ready', prs: [{ number: 5, merged_at: '2026-11-01T09:00:00Z' }] },
    { id: 'X1', title: 'Closed PR', lane: 'done', prs: [{ number: 6 }] },
    { id: 'L1', title: 'Landed', lane: 'done' },
    { id: 'D1', title: 'Dropped', lane: 'done' },
  ] });
  write(site('audit', 'data', 'agents', 'L1.json'), { kind: 'claude', started: '2026-11-04T09:00:00Z', done: '2026-11-04T10:00:00Z' });
  write(site('audit', 'data', 'done-archive.json'), { cards: [{ key: 'audit/Z1', closed_at: '2026-10-01T00:00:00Z', item: { id: 'Z1', title: 'Old', lane: 'done', state: 'ready', prs: [{ number: 2, merged_at: '2026-10-01T00:00:00Z' }] } }] });
  const said = await migratePhases(site('audit'));
  assert.equal(said.length, 2);
  const items = Object.fromEntries(read(site('audit', 'data', 'items.json')).items.map((i) => [i.id, i]));
  assert.deepEqual(Object.fromEntries(Object.entries(items).map(([id, i]) => [id, [i.phase, 'state' in i]])), {
    T1: ['staging', false], T2: [undefined, false], M1: ['merged', false], X1: ['closed', false], L1: ['merged', false], D1: ['closed', false],
  });
  assert.deepEqual(read(site('audit', 'data', 'done-archive.json')).cards[0].item.phase, 'merged');
  assert.deepEqual(await migratePhases(site('audit')), []);
});

const built = (items, agents = {}, prs = {}, extra = {}) => buildBoard({ fromWaves: true, files: [{ slug: 'w', agents, itemFile: { repo: 'o/r', items } }], prs, owner: {}, events: [], ...extra });
const phases = (b) => Object.fromEntries(b.items.filter((i) => i.kind === 'work').map((i) => [i.id, [i.lane, i.phase]]));
const pr = (extra = {}) => ({ state: 'OPEN', isDraft: false, checks: { state: 'pass' }, reviews: {}, ...extra });

test("the board gives each card its lane's phase: Todo's stored, the build's step, the review's wait, and how it closed", async () => {
  const open = { started: '2026-11-04T09:00:00Z', kind: 'claude' };
  const checked = { started: '2026-11-04T09:00:00Z', done: '2026-11-04T10:00:00Z', handed_back: '2026-11-04T10:00:00Z', kind: 'claude' };
  const b = built([
    { id: 'N1', title: 'New', lane: 'todo' },
    { id: 'G1', title: 'Grilling', lane: 'todo', phase: 'grilling' },
    { id: 'S1', title: 'Staging', lane: 'todo', phase: 'staging' },
    { id: 'P1', title: 'Building', lane: 'progress', phase: 'reading' },
    { id: 'C1', title: 'Checking', lane: 'progress', phase: 'testing' },
    { id: 'R1', title: 'Draft', lane: 'review', prs: [{ number: 1 }] },
    { id: 'R2', title: 'Reviewers', lane: 'review', prs: [{ number: 2 }], reviewers: [{ name: 'Quinn', github: 'quinn' }] },
    { id: 'R3', title: 'Merge', lane: 'review', prs: [{ number: 3 }] },
    { id: 'D1', title: 'Merged', lane: 'done', phase: 'merged', closed_at: '2026-11-04T08:00:00Z' },
    { id: 'D2', title: 'Closed', lane: 'done', phase: 'closed', closed_at: '2026-11-04T08:00:00Z' },
  ], { P1: { main: open }, C1: { main: checked } }, { 'o/r#1': pr({ isDraft: true }), 'o/r#2': pr({ reviewDecision: 'REVIEW_REQUIRED' }), 'o/r#3': pr({ reviewDecision: 'APPROVED' }) });
  assert.deepEqual(phases(b), {
    N1: ['todo', 'new'], G1: ['todo', 'grilling'], S1: ['todo', 'staging'],
    P1: ['progress', 'reading'], C1: ['progress', 'checking'],
    R1: ['review', 'draft'], R2: ['review', 'reviewers'], R3: ['review', 'merge'],
    D1: ['done', 'merged'], D2: ['done', 'closed'],
  });
});

test("an In Progress card's phase is its builder's step; a review past seven days is stale; a merged PR not yet closed reads merged", async () => {
  const thread = [{ ts: '2026-11-04T09:05:00Z', kind: 'status', who: 'claude', text: 'Running the suite', phase: 'testing' }];
  const b = built([
    { id: 'P1', title: 'Testing', lane: 'progress', phase: 'reading' },
    { id: 'M1', title: 'Merged', lane: 'review', prs: [{ number: 4 }] },
  ], { P1: { main: { started: '2026-11-04T09:00:00Z', kind: 'claude' } } }, { 'o/r#4': { state: 'MERGED', mergedAt: '2026-11-04T09:00:00Z' } }, { threads: { 'w/P1': thread } });
  assert.deepEqual(phases(b), { P1: ['progress', 'testing'], M1: ['done', 'merged'] });
});

test('the settle pass writes each In Progress and In Review phase change quietly, carries the phase on a lane move, and leaves Todo and Done phases to their writers', async () => {
  const open = { started: '2026-11-04T09:00:00Z', kind: 'claude' };
  const b = built([
    { id: 'P1', title: 'Building', lane: 'todo', phase: 'ready' },
    { id: 'P2', title: 'Same', lane: 'progress', phase: 'reading' },
    { id: 'R1', title: 'Approved', lane: 'review', phase: 'reviewers', prs: [{ number: 7 }] },
    { id: 'T1', title: 'Todo', lane: 'todo' },
    { id: 'D1', title: 'Done', lane: 'done', closed_at: '2026-11-04T08:00:00Z' },
  ], { P1: { main: open }, P2: { main: open } }, { 'o/r#7': pr({ reviewDecision: 'APPROVED' }) });
  assert.deepEqual(movesOf(b).map((m) => [m.key, m.to, m.phase, m.why]).sort(), [
    ['w/P1', 'progress', 'reading', 'a build started'],
    ['w/R1', 'review', 'merge', 'Approved, Merge shows once CI and the merge state allow'],
  ]);
});

// The page's card markup (ui-cards.js), run as the page runs it.
const context = vm.createContext({ location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout });
for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
const ui = context.BoardUI;
const card = (it) => ui.workLines({ key: 'w/A1', id: 'A1', kind: 'work', ref: '#1', title: 'One', sortAt: '2020-01-01T10:00:00.000Z', deps: [], blockedBy: [], reviewers: [], review: {}, pr: null, builder: null, next: null, ...it });
const phaseWord = (html) => [...html.matchAll(/<span class="card-phase ph-(\w+)">([^<]+)<\/span>/g)].map((m) => [m[2], m[1]]);

test("Todo, In Review and Done end a card's last line with its phase word, toned by who acts next; In Progress shows only its bar", async () => {
  const words = [
    ['todo', 'grilling', 'grilling', 'info'], ['todo', 'prototyping', 'prototyping', 'info'],
    ['todo', 'staging', 'staging', 'notice'], ['todo', 'ready', 'ready', 'success'],
    ['review', 'draft', 'draft', 'quiet'], ['review', 'reviewers', 'pending review', 'notice'], ['review', 'merge', 'pending merge', 'notice'], ['review', 'stale', 'stale', 'quiet'],
    ['done', 'merged', 'merged', 'merged'], ['done', 'closed', 'closed', 'quiet'],
  ];
  for (const [lane, phase, word, tone] of words) {
    const html = card({ lane, phase, ready: phase === 'ready', staging: phase === 'staging', stale: phase === 'stale' });
    assert.deepEqual(phaseWord(html), [[word, tone]], `${lane} ${phase}`);
    assert.doesNotMatch(html, /phase-bars/, `${lane} ${phase}`);
  }
  const progress = card({ lane: 'progress', phase: 'building', builder: { phase: 'building', progress: 'Writing it', at: '2020-01-01T10:00:00.000Z', alive: true } });
  assert.deepEqual(phaseWord(card({ lane: 'todo', phase: 'new' })), [], 'a New card draws no phase pill');
  assert.deepEqual(phaseWord(progress), []);
  assert.match(progress, /phase-bars/);
});

test('a stale review reads one stale; a blocked ready card shows ready, then its block; a grilling card shows its word and no dashes', async () => {
  assert.equal(card({ lane: 'review', phase: 'stale', stale: true }).match(/stale</g).length, 1);
  const footerWords = (html) => html.match(/<div class="line6 sub card-time">(.*?)<\/div>/)[1].replace(/<[^>]+>/g, '');
  const blockedBy = [{ key: 'w/B1', ref: '#2' }];
  const blockedReady = card({ lane: 'todo', phase: 'ready', ready: false, blocked: true, blockedBy });
  assert.deepEqual(phaseWord(blockedReady), [['ready', 'success']]);
  assert.match(footerWords(blockedReady), / · ready · blocked by #2$/);
  assert.match(footerWords(card({ lane: 'todo', phase: 'ready', ready: false, held: true })), / · ready · held/);
  assert.match(footerWords(card({ lane: 'todo', phase: 'staging', staging: true, blocked: true, blockedBy })), / · staging · blocked by #2$/);
  const grilling = card({ lane: 'todo', phase: 'grilling', builder: { planner: true, kind: 'grill', progress: 'Reading', at: '2020-01-01T10:00:00.000Z', alive: true } });
  assert.deepEqual(phaseWord(grilling), [['grilling', 'info']]);
  assert.doesNotMatch(grilling, /phase-bars/);
});

test('new messages read bold blue in every lane; Action needed is the only orange', async () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.card-alert \{ font-weight: 600; \}/);
  assert.match(css, /\.card-alert \.card-action \{ color: var\(--color-notice\); \}/);
  assert.match(css, /\.card-alert \.card-unread \{ color: var\(--color-info\); \}/);
  assert.doesNotMatch(css, /\.lane\[data-lane="done"\] \.card-alert/);
});

test('each phase tone takes its colour from shared/colors.css', async () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  for (const [tone, colour] of [['quiet', 'quiet'], ['info', 'info'], ['notice', 'notice'], ['success', 'success'], ['merged', 'merged']]) {
    assert.match(css, new RegExp(`\\.card-phase\\.ph-${tone} \\{ color: var\\(--color-${colour}\\); \\}`));
  }
});
