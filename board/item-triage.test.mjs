// docs/adr/2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md: item triage is the
// orchestrator's first move on a new task, from what it knows of the board, and the intake wait names the cards the
// task likely relates to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBoard, orchestratorWaits, relatedCandidates } from './domain.mjs';
import { board, home, site, read, write, lines, ticketCli } from './board-fixture.mjs';

const audit = (...p) => site('audit', ...p);
const auditEvents = (...events) => fs.appendFileSync(audit('data', 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
const ask = (id, text = 'Fix the header\nIt jumps on scroll', data = {}) => ({ id, ts: '2026-11-15T07:00:00Z', kind: 'ask', data: { text, ...data } });
async function fileAsk(id) {
  process.env.HOME = home;
  const store = await import('./store.mjs');
  return store.fileAsk(audit(), id);
}
const item = (id) => read(audit('data', 'items.json')).items.find((i) => i.id === id);
const messages = (id) => (!fs.existsSync(audit('data', 'threads', `audit__${id}.jsonl`)) ? [] : lines(audit('data', 'threads', `audit__${id}.jsonl`))).filter((m) => !m.kind && !m.command).map((m) => m.text);

test('item triage sorts a New task in one call: its title, phase, links and ticket, and and nothing in its thread', async () => {
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  const r = await board('item', 'triage', key, '--title', 'fix(board): the header jumps on scroll', '--phase', 'discussing', '--relate', 'A1', '--blocked-by', 'ENG-1', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.match(r.out, /T-1: triaged discussing/);
  const t = item('T-1');
  assert.deepEqual([t.title, t.phase, t.related, t.deps, t.triaged.phase], ['fix(board): the header jumps on scroll', 'discussing', ['audit/A1'], ['ENG-1'], 'discussing']);
  assert.ok(t.sorted_at, 'the New strip reads it ingested');
  assert.deepEqual(messages('T-1'), [], 'the owner\'s message is alone in the thread');
  assert.match((await board('item', 'triage', key, '--title', 'fix: x', '--phase', 'grilling', '--text', 'hello', '--site', 'audit')).err, /sorted/);
  // Sorted, it reads as a task, and nothing waits on its intake.
  const b = buildBoard({ now: Date.parse('2026-11-15T07:01:00Z'), events: [ask('a1')], files: [{ slug: 'audit', agents: {}, itemFile: read(audit('data', 'items.json')) }], prs: {}, owner: {} });
  const card = b.items.find((i) => i.key === key);
  assert.deepEqual([Boolean(card.isNew), card.phase], [false, 'discussing']);
  assert.equal(orchestratorWaits(b).some((w) => w.kind === 'intake'), false);
  // A sorted task has nothing left to triage.
  assert.match((await board('item', 'triage', key, '--title', 'fix: x', '--phase', 'grilling', '--site', 'audit')).err, /audit\/T-1 is sorted \(discussing\)/);
});

test('item triage needs a title and a phase it can give, and --fold-into goes alone', async () => {
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  assert.match((await board('item', 'triage', key, '--phase', 'discussing', '--site', 'audit')).err, /needs --title/);
  assert.match((await board('item', 'triage', key, '--title', 'fix: x', '--site', 'audit')).err, /needs --title/);
  assert.match((await board('item', 'triage', key, '--title', 'fix: x', '--phase', 'ready', '--site', 'audit')).err, /--phase takes discussing, grilling, prototyping, visual; ready follows the investigation/);
  assert.match((await board('item', 'triage', key, '--fold-into', 'audit/A1', '--phase', 'discussing', '--site', 'audit')).err, /--fold-into .* takes only --text/);
  assert.deepEqual([item('T-1').phase, fs.existsSync(audit('data', 'threads', 'audit__T-1.jsonl'))], [undefined, false], 'a refusal writes nothing');
});

test('item triage --phase visual sorts the task discussing for the visual\'s brief, and grilling leaves it to arrive for its grill', async () => {
  auditEvents(ask('a1'), ask('a2', 'Try a darker header'));
  const k1 = await fileAsk('a1');
  const k2 = await fileAsk('a2');
  assert.equal((await board('item', 'triage', k1, '--title', 'feat(board): sketch the header', '--phase', 'visual', '--site', 'audit')).code, 0);
  assert.deepEqual([item('T-1').phase, messages('T-1')], ['discussing', []]);
  assert.equal((await board('item', 'triage', k2, '--title', 'feat(board): a darker header', '--phase', 'grilling', '--site', 'audit')).code, 0);
  assert.deepEqual([item('T-2').phase, messages('T-2')], ['grilling', []]);
});

test('item triage --parent --split sets the Parent and copies its gates', async () => {
  const items = read(audit('data', 'items.json'));
  items.items.find((i) => i.id === 'A1').gates = { prototype: 'Take B' };
  write(audit('data', 'items.json'), items);
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  assert.equal((await board('item', 'triage', key, '--title', 'feat(board): the header half', '--phase', 'discussing', '--parent', 'A1', '--split', '--site', 'audit')).code, 0);
  assert.deepEqual([item('T-1').parent, item('T-1').gates], ['audit/A1', { prototype: 'Take B' }]);
  assert.deepEqual(messages('T-1'), []);
});

test('item triage --fold-into merges a duplicate New task into the other task, with a line on both', async () => {
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  const r = await board('item', 'triage', key, '--fold-into', 'audit/A1', '--text', 'same as the header work', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(item('T-1'), undefined);
  assert.deepEqual(read(audit('data', 'ask-links.json')), { links: { a1: 'audit/A1' } });
  assert.deepEqual(lines(audit('data', 'threads', 'ask__a1.jsonl')).map((m) => [m.line, m.into]), [['card-merged', 'audit/A1']]);
  assert.deepEqual(messages('A1'), ['Triaged: folded in T-1 "Fix the header"; same as the header work']);
});

// docs/adr/2026-11-17-0543-a-quick-ask-is-triaged-into-staging.md: the owner's Implement on a New task is one path to
// staging, kept through triage, and the orchestrator then judges it as any staged task, at any size.
const thread = (id) => (!fs.existsSync(audit('data', 'threads', `audit__${id}.jsonl`)) ? [] : lines(audit('data', 'threads', `audit__${id}.jsonl`)));
test("item triage on a Quick build ask refuses any phase but staging, and lands it staging with the owner's Implement kept", async () => {
  auditEvents(ask('a1', 'Pin the header', { quick: true }));
  const key = await fileAsk('a1');
  for (const phase of ['discussing', 'grilling', 'prototyping', 'visual', 'ready']) {
    const r = await board('item', 'triage', key, '--title', 'fix(board): pin the header', '--phase', phase, '--site', 'audit');
    assert.equal(r.code, 1, phase);
    assert.equal(r.err, `${key} came with the owner's Implement, which stages it: run item triage ${key} --title "<type>(<scope>): <summary>" with its links and no --phase, then judge it as any staged task: item set ${key} --phase ready --text "<what you checked>", or --phase grilling or prototyping with a thread line saying why\n`, phase);
  }
  assert.deepEqual([item('T-1').phase, thread('T-1')], [undefined, []], 'a refusal writes nothing');
  const r = await board('item', 'triage', key, '--title', 'fix(board): pin the header', '--relate', 'A1', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.match(r.out, /T-1: triaged staging/);
  const t = item('T-1');
  assert.deepEqual([t.title, t.phase, t.related, t.triaged.phase], ['fix(board): pin the header', 'staging', ['audit/A1'], 'staging']);
  assert.ok(t.staged_at && t.sorted_at);
  // It owes the staging wait, the judgment any staged task gets, not the investigate wait of a triaged discussion.
  const b = buildBoard({ now: Date.now(), events: [ask('a1', 'Pin the header', { quick: true })], files: [{ slug: 'audit', agents: {}, itemFile: read(audit('data', 'items.json')) }], threads: { 'audit/T-1': thread('T-1') }, prs: {}, owner: {} });
  assert.deepEqual(orchestratorWaits(b).filter((w) => w.key === key).map((w) => w.kind), ['staging']);
  assert.deepEqual(thread('T-1').map((m) => [m.command, m.text]), [['staged', 'Marked as staged'], ['related', 'Related to']]);
  // Staged, it goes ready on the orchestrator's judgment at any size, as any staged task does.
  const notes = path.join(home, 'n.md');
  fs.writeFileSync(notes, 'Pin the header with position sticky.');
  assert.equal((await board('item', 'notes', key, '--heading', 'Scope', '--file', notes, '--site', 'audit')).code, 0);
  const ready = await board('item', 'set', key, '--phase', 'ready', '--size', 'large', '--text', 'No other task covers it.', '--site', 'audit');
  assert.deepEqual([ready.code, ready.err], [0, '']);
  assert.equal(item('T-1').phase, 'ready');
});

test('item triage takes --phase staging on a Quick build ask, and an Implement on its New card stages it the same way; a Slack ask and a Discuss ask take a phase as before', async () => {
  const routed = { reason: 'the header is this board', via: 'slack', by: 'Ann', at: '2026-11-15T06:59:00Z', slack: { channel: 'D1', thread_ts: '1.1', ts: '1.1' } };
  auditEvents(ask('a1', 'Pin the header', { quick: true }), ask('a2', 'Pin the footer'), { id: 'i2', ts: '2026-11-15T07:01:00Z', kind: 'item-message', data: { key: 'ask:a2', text: '', intent: 'build' } },
    ask('a3', 'Ann: @kickflip pin the sidebar', { routed }), { id: 'i3', ts: '2026-11-15T07:01:00Z', kind: 'item-message', data: { key: 'ask:a3', text: '', intent: 'build' } }, ask('a4', 'Pin the nav'));
  const [k1, k2, k3, k4] = [await fileAsk('a1'), await fileAsk('a2'), await fileAsk('a3'), await fileAsk('a4')];
  assert.equal((await board('item', 'triage', k1, '--title', 'fix(board): pin the header', '--phase', 'staging', '--site', 'audit')).code, 0);
  assert.match((await board('item', 'triage', k2, '--title', 'fix(board): pin the footer', '--phase', 'discussing', '--site', 'audit')).err, /came with the owner's Implement, which stages it/);
  assert.equal((await board('item', 'triage', k2, '--title', 'fix(board): pin the footer', '--site', 'audit')).code, 0);
  assert.deepEqual([item('T-1').phase, item('T-2').phase], ['staging', 'staging']);
  // docs/adr/2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md: a Slack ask discusses first.
  assert.match((await board('item', 'triage', k3, '--title', 'fix(board): pin the sidebar', '--site', 'audit')).err, /needs --title .* and --phase/);
  assert.equal((await board('item', 'triage', k3, '--title', 'fix(board): pin the sidebar', '--phase', 'discussing', '--site', 'audit')).code, 0);
  assert.match((await board('item', 'triage', k4, '--title', 'fix(board): pin the nav', '--phase', 'staging', '--site', 'audit')).err, /--phase takes discussing, grilling, prototyping, visual/);
  assert.deepEqual([item('T-3').phase, item('T-4').phase], ['discussing', undefined]);
});

const card = (key, title, extra = {}) => ({ kind: 'work', key, title, lane: 'todo', ...extra });
test('the related candidates are open cards sharing two significant title words, or the scope, most shared first, at most five', () => {
  const it = card('w/T-9', 'Fix the header jumping on scroll');
  const items = [
    it,
    card('w/T-1', 'feat(board): the header stays pinned on scroll'),
    card('w/T-2', 'fix(hub): header colours'),
    card('w/T-3', 'fix(board): headers jump while scrolling', { lane: 'done' }),
    card('w/T-4', 'fix(board): a header that jumps on scroll'),
    card('w/T-5', 'fix(board): the header jumps on scroll', { unsorted: true }),
  ];
  assert.deepEqual(relatedCandidates(items, it).map((c) => c.key), ['w/T-4', 'w/T-1']);
  const scoped = card('w/T-10', 'feat(hub): a new integration');
  assert.deepEqual(relatedCandidates([...items, scoped], scoped).map((c) => c.key), ['w/T-2']);
  // A comma list of scopes matches a card with any one of them.
  const across = card('w/T-11', 'feat(api,hub): a new integration');
  assert.deepEqual(relatedCandidates([...items, across], across).map((c) => c.key), ['w/T-2']);
  const many = Array.from({ length: 7 }, (_, n) => card(`w/M${n}`, `the header jumps ${n}`));
  assert.equal(relatedCandidates([it, ...many], it).length, 5);
});

test("a New task's intake wait asks for item triage first, then investigation, and names its likely related cards", () => {
  const b = buildBoard({
    now: Date.parse('2026-11-15T07:01:00Z'), events: [ask('a1')], prs: {}, owner: {},
    files: [{ slug: 'w', agents: {}, itemFile: { items: [
      { id: 'T-1', title: 'Fix the header jumping on scroll', created: '2026-11-15T07:00:01Z', lane: 'todo', from_ask: 'a1' },
      { id: 'T-2', title: 'feat(board): the header stays pinned on scroll', lane: 'todo', phase: 'discussing' },
    ] } }],
  });
  const wait = orchestratorWaits(b).find((w) => w.kind === 'intake');
  assert.equal(wait.key, 'w/T-1');
  assert.match(wait.next, /^Triage the new task first, from what you know of the board, reading no code: item triage w\/T-1 --title "<type>\(<scope>\): <summary>" --phase discussing\|grilling\|prototyping\|visual .*--fold-into <task> for a duplicate\. Then investigate/);
  assert.match(wait.next, /Likely related \(check them, don't hunt\): w\/T-2 "feat\(board\): the header stays pinned on scroll"\.$/);
});

test("a Quick build ask's intake wait asks for item triage with no phase, which stages it, then the staged task's checks", () => {
  const b = buildBoard({
    now: Date.parse('2026-11-15T07:01:00Z'), events: [ask('a1', 'Pin the header', { quick: true })], prs: {}, owner: {},
    files: [{ slug: 'w', agents: {}, itemFile: { items: [{ id: 'T-1', title: 'Pin the header', created: '2026-11-15T07:00:01Z', lane: 'todo', from_ask: 'a1' }] } }],
  });
  const wait = orchestratorWaits(b).find((w) => w.kind === 'intake');
  assert.match(wait.next, /^Triage the new task first, from what you know of the board, reading no code: the owner tapped Implement, so item triage w\/T-1 --title "<type>\(<scope>\): <summary>" \[--relate <keys>\] \[--parent <key> \[--split\]\] \[--blocked-by <keys>\] \[--ticket <id>\] stages it, taking no --phase\. Then judge it as any staged task: item notes, then the checks a staged task gets \(check that no open or merged task/);
  assert.match(wait.next, /\), then item set w\/T-1 --phase ready --text "<what you checked>" at any size, or --phase grilling or prototyping with a thread line saying why\.$/);
  assert.doesNotMatch(wait.next, /--phase discussing\|/);
});

const investigate = (key = 'audit/T-1') => {
  process.env.HOME = home;
  const b = buildBoard({ now: Date.now(), events: [ask('a1')], files: [{ slug: 'audit', agents: {}, itemFile: read(audit('data', 'items.json')) }], threads: { 'audit/T-1': fs.existsSync(audit('data', 'threads', 'audit__T-1.jsonl')) ? lines(audit('data', 'threads', 'audit__T-1.jsonl')) : [] }, prs: {}, owner: {} });
  return orchestratorWaits(b).find((w) => w.kind === 'investigate' && w.key === key);
};
const triage = async (phase = 'discussing') => {
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  assert.equal((await board('item', 'triage', key, '--title', 'fix(board): the header jumps on scroll', '--phase', phase, '--site', 'audit')).code, 0);
  return key;
};

// docs/adr/2026-11-15-1030-a-triaged-task-owes-an-investigate-wait-until-its-notes-are-written.md
test('a triaged task owes an investigate wait that item notes ends', async () => {
  const key = await triage();
  assert.match(investigate(key).next, /^Investigate audit\/T-1: write its notes \(item notes\), then reply$/);
  const notes = path.join(home, 'n.md');
  fs.writeFileSync(notes, 'The header is sticky.');
  assert.equal((await board('item', 'notes', key, '--heading', 'Scope', '--file', notes, '--site', 'audit')).code, 0);
  assert.equal(investigate(key), undefined);
});

test('a reply in the thread ends the investigate wait, the Triaged line does not', async () => {
  const key = await triage();
  assert.ok(investigate(key));
  assert.equal((await board('reply', key, '--site', 'audit', '--text', 'It is the sticky header.')).code, 0);
  assert.equal(investigate(key), undefined);
});

test('a fold owes no investigate wait, and a task sorted past its triage phase owes none', async () => {
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  assert.equal((await board('item', 'triage', key, '--fold-into', 'audit/A1', '--site', 'audit')).code, 0);
  assert.equal(investigate(key), undefined);
  auditEvents(ask('a2'));
  const k2 = await fileAsk('a2');
  assert.equal((await board('item', 'triage', k2, '--title', 'fix(board): x y', '--phase', 'discussing', '--site', 'audit')).code, 0);
  assert.ok(investigate(k2));
  assert.equal((await board('item', 'set', k2, '--phase', 'grilling', '--site', 'audit')).code, 0);
  assert.equal(investigate(k2), undefined);
});

// docs/adr/2026-11-16-2000-an-ask-places-every-issue-it-names.md: on a GitHub board an ask naming an issue of its repo
// is triaged only once the issue is the card's ticket or held by a task the card links.
async function githubBoard(t) {
  const world = await ticketCli(t);
  await world.saveBoardSettings(audit(), { tickets: { source: 'github' } });
  const file = audit('data', 'items.json');
  write(file, { ...read(file), repo: 'o/audit', items: [...read(file).items, { id: 'GH-43', ticket: '#43', title: 'fix: the other', lane: 'todo', phase: 'grilling' }] });
  return world;
}

test('item triage refuses an ask naming an issue it does not place, and takes it as --ticket or through a link to the task holding it', async (t) => {
  const { cli, err, item: stored } = await githubBoard(t);
  auditEvents(
    ask('a1', 'https://github.com/o/audit/issues/674'),
    ask('a2', 'See GH-43, which this extends'),
    ask('a3', 'Like "#99, said by someone", and https://github.com/other/repo/issues/5'),
    ask('a4', 'Is #674 and #675 the same?'),
  );
  const [k1, k2, k3, k4] = [await fileAsk('a1'), await fileAsk('a2'), await fileAsk('a3'), await fileAsk('a4')];
  const triage = (key, ...more) => cli('item', 'triage', key, '--title', 'fix(board): x y', '--phase', 'discussing', ...more);
  assert.equal(await triage(k1), 1);
  assert.match(err.at(-1), /the ask names issue #674 without placing it: if it is the ask's direct topic, add --ticket 674 so the owner's Done closes it; otherwise link the task that holds it as --relate, --parent or --blocked-by/);
  assert.equal(stored('T-1').phase, undefined);
  assert.equal(await triage(k1, '--ticket', '#674'), 0);
  assert.equal(stored('T-1').ticket, '#674');
  // A link to the card holding the issue places it; another repo's issue and quoted words name nothing here.
  assert.equal(await triage(k2), 1);
  assert.match(err.at(-1), /names issue #43 without placing it/);
  assert.equal(await triage(k2, '--relate', 'GH-43'), 0);
  assert.equal(await triage(k3), 0);
  // Of several issues, placing one leaves the rest.
  assert.equal(await triage(k4, '--ticket', '674'), 1);
  assert.match(err.at(-1), /names issue #675 without placing it/);
});

test('a PR is never an issue: a /pull/<n> URL and a #N the GitHub state knows as a PR need no placing', async (t) => {
  const { cli } = await githubBoard(t);
  write(path.join(home, '.claude', 'kickflip', 'github-state.json'), { prs: { 'o/audit#899': { state: 'OPEN' }, 'other/repo#7': { state: 'OPEN' } } });
  auditEvents(ask('a1', 'Review https://github.com/o/audit/pull/899 and #899, GH-899'), ask('a2', 'Is #7 the one?'));
  const [k1, k2] = [await fileAsk('a1'), await fileAsk('a2')];
  const triage = (key) => cli('item', 'triage', key, '--title', 'fix(board): x y', '--phase', 'discussing');
  assert.equal(await triage(k1), 0);
  // Another repo's PR number is no PR of this one, so #7 is an issue here.
  assert.equal(await triage(k2), 1);
});

test('item add --ask refuses words naming an issue no linked task holds', async (t) => {
  const { cli, err } = await githubBoard(t);
  assert.equal(await cli('item', 'add', 'audit', '--ask', 'Follow up on #43 and #50', '--relate', 'GH-43'), 1);
  assert.match(err.at(-1), /the request names issue #50 without placing it: link the task that holds it as --relate, --parent or --blocked-by/);
  assert.equal(await cli('item', 'add', 'audit', '--ask', 'Follow up on #43', '--relate', 'GH-43'), 0);
});

test('item triage --text is refused unless it folds, and the refusal writes nothing', async () => {
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  assert.match((await board('item', 'triage', key, '--title', 'fix: x', '--phase', 'grilling', '--text', 'hello', '--site', 'audit')).err, /--text goes only with --fold-into/);
  assert.deepEqual([item('T-1').phase, fs.existsSync(audit('data', 'threads', 'audit__T-1.jsonl'))], [undefined, false]);
});
