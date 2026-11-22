import { home } from '../shared/scratch-home.mjs';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until, boardListening, fakeSlack, slackWorld, startBoard, untilTestEnds, putWave as sharedPutWave } from '../shared/test-helpers.mjs';
import { fakeGh, writeGithubUser } from '../shared/fake-gh.mjs';
import { writeBrief } from './store.mjs';

import { watch as watchEvents } from '../bin/wait-events.mjs';
import { readInbox } from '../bin/event-lines.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// docs/adr/2026-11-14-0013-server-test-runs-its-board-and-watchers-in-process.md
// One board server for the file, in this process: a test that writes a file the server would hear
// of has it hear the write (heard), and awaits settled() for the passes it started.
let site, board, base, slackWorldOf, slackServer, ghDir;
// How far from the real clock the server's clock reads; a test sets it back so what the server records is already old.
let clockSkewMs = 0;
const uploads = () => path.join(site, 'data', 'uploads');

before(async () => {
  site = path.join(home, 'site');
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(site, 'data', 'owner.json'), '{"items":[]}');
  fs.writeFileSync(path.join(home, 'push-stub.mjs'), "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(3)) + '\\n'); console.log('sent');");
  const pushEnv = { KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, path.join(home, 'push-stub.mjs'), 'push']), STUB_CALLS: path.join(home, 'push-calls.jsonl') };
  // A held card's Merge runs this instead of board.mjs merge, recording its arguments.
  fs.writeFileSync(path.join(home, 'merge-stub.mjs'), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(path.join(home, 'merges.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
  const mergeEnv = { KICKFLIP_MERGE_CMD: JSON.stringify([process.execPath, path.join(home, 'merge-stub.mjs')]) };
  // The hub's Slack token is saved, Slack is a stand-in, and gh is a fixture one: Board settings' Reviewers fetches and adds through them.
  slackWorldOf = slackWorld();
  slackWorldOf.people = [{ id: 'U3', name: 'cy', real_name: 'Cy Doe' }, { id: 'U4', name: 'di', real_name: 'Di Poe' }];
  slackServer = await fakeSlack(slackWorldOf).serve();
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'secrets.json'), JSON.stringify({ slack: { token: slackWorldOf.token, team: 'Acme', user: 'love' } }));
  ghDir = path.join(home, 'gh-fixtures');
  const ghBin = fakeGh(ghDir);
  // Reviewers' lookups wait longer than the run's own per-file limit, so a loaded host can't give up on the stand-ins
  // (board/reviewer-people.test.mjs gives up by hand). It is read as board/reviewer-people.mjs loads, so it is set
  // before the server is imported.
  const slackEnv = { KICKFLIP_SLACK_URL: slackServer.url, PATH: `${ghBin}:${process.env.PATH}`, KICKFLIP_PEOPLE_WAIT_MS: String(60 * 60_000) };
  // Builders and planners the server launches run `true`, which exits at once.
  Object.assign(process.env, { KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true', ...pushEnv, ...mergeEnv, ...slackEnv });
  const { startServer } = await import('./server.mjs');
  board = await startServer({ site, now: () => new Date(Date.now() + clockSkewMs), signedIn: () => true });
  base = `http://127.0.0.1:${board.server.address().port}`;
  await board.settled();
});

// docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md
test("a held card's Merge records the tap on the card and runs board.mjs merge detached, with no event to wake the session, and reads merging", async () => {
  const waveFile = path.join(site, 'data', 'items.json');
  const before = fs.existsSync(waveFile) ? fs.readFileSync(waveFile, 'utf8') : null;
  const wave = before ? JSON.parse(before) : { items: [] };
  wave.items.push({ id: 'M1', title: 'Held', branch: 'M1', merge_ready: { branch: 'M1', at: '2026-11-04T10:00:00Z' } });
  try {
    await putWave(JSON.stringify(wave));
    const card = async () => (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === 't/M1');
    assert.deepEqual(await card().then((c) => [c.lane, c.waitsOn, c.action?.label]), ['review', 'merge', 'Merge']);
    const events = () => (fs.existsSync(path.join(site, 'data', 'events.jsonl')) ? fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8') : '');
    const r = await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'card-merge', key: 't/M1' }) });
    const answer = await r.json();
    assert.equal(r.status, 200, JSON.stringify(answer));
    assert.equal(answer.id, null);
    assert.equal(answer.board.items.find((i) => i.key === 't/M1').merging, true);
    assert.equal(typeof JSON.parse(fs.readFileSync(waveFile, 'utf8')).items.find((i) => i.id === 'M1').merge_ready.tapped, 'string');
    assert.equal(events().includes('"card-merge"'), false);
    // docs/adr/2026-11-18-2100-a-card-tap-logs-a-sending-line-and-its-button-just-disables.md: the tap's line.
    const thread = await (await fetch(`${base}/api/thread?key=t/M1`)).json();
    assert.deepEqual(thread.filter((m) => m.command).map((m) => [m.text, m.who]), [['Merge requested', 'love']]);
    // The stand-in merge creates the file before it writes its line.
    await until(() => fs.existsSync(path.join(home, 'merges.jsonl')) && fs.readFileSync(path.join(home, 'merges.jsonl'), 'utf8').endsWith('\n'), 'the merge runs');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'merges.jsonl'), 'utf8').trim()), ['--site', 'site', 'merge', 't/M1']);
  } finally { if (before) await putWave(before); else fs.rmSync(waveFile); }
});
// Each test's asks are withdrawn when it ends: an open ask becomes a T-<n> card on every board change (store.mjs
// fileAsks), so one left open races a later test's board reads.
afterEach(async () => {
  const file = path.join(site, 'data', 'events.jsonl');
  if (!board || !fs.existsSync(file)) return;
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const withdrawn = new Set(events.filter((e) => e.kind === 'ask-withdrawn').map((e) => e.data?.id));
  // An ask a test sorted into a card of its own (from_ask on a non-T-<n> id) stays: later tests use that card.
  const itemsFile = path.join(site, 'data', 'items.json');
  const items = fs.existsSync(itemsFile) ? JSON.parse(fs.readFileSync(itemsFile, 'utf8')).items || [] : [];
  const sorted = new Set(items.filter((i) => i.from_ask && !/^T-\d+$/.test(i.id)).map((i) => i.from_ask));
  for (const { id } of events.filter((e) => e.kind === 'ask' && !withdrawn.has(e.id) && !sorted.has(e.id))) {
    const r = await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ask-withdrawn', id }) });
    // The board refuses deleting an ask whose card a test moved past Todo; its ask is withdrawn in the log all the same,
    // so a later test that rewrites the item file never files it again.
    if (r.status === 400) fs.appendFileSync(file, JSON.stringify({ id: `ecleanup${id}`, ts: new Date().toISOString(), kind: 'ask-withdrawn', data: { id } }) + '\n');
  }
});
after(async () => { await board?.close(); await slackServer?.close(); });

// Has the server hear writes to files, as a store write tells it of them, then waits for every pass they started.
const heard = async (...files) => {
  for (const file of files) board.changed(file);
  await board.settled();
};

// Replaces the item file once every pass so far has finished, the launches of builders and planners (KICKFLIP_CLAUDE=true,
// so each exits at once) and their exit paths' writes of the item file included, in one rename, which no reader sees
// half-written, and has the server hear it. The rename is made under the item file's lock, which the server's writes of
// it (store.mjs writeJSON, moveCard) hold from their read of the file to their own rename, so none writes back a file it
// read before this one.
// docs/adr/2026-11-09-2100-a-settle-move-never-undoes-a-tap-made-after-its-snapshot.md,
// docs/adr/2026-11-09-2230-a-settle-move-checks-its-snapshot-under-the-item-files-lock.md
const putWave = async (text) => {
  const file = path.join(site, 'data', 'items.json');
  await board.settled();
  await sharedPutWave(file, text);
  await heard(file);
};

// Asserts a request answered 200, and otherwise fails with what the server answered; on 200 the body is left unread.
const ok200 = async (pending) => {
  const r = await pending;
  if (r.status !== 200) assert.fail(`${r.url} answered ${r.status}: ${await r.text() || '(empty)'}`);
  return r;
};

const upload = (body, name, type) => fetch(`${base}/api/upload`, { method: 'POST', headers: { 'x-filename': encodeURIComponent(name), 'content-type': type }, body });

// The push stub creates its file before it writes its line, so only lines ending in a newline are read.
const pushes = () => (fs.existsSync(path.join(home, 'push-calls.jsonl')) ? fs.readFileSync(path.join(home, 'push-calls.jsonl'), 'utf8').split('\n').slice(0, -1).map((l) => JSON.parse(l)) : []);
const flag = (call, name) => (call.includes(`--${name}`) ? call[call.indexOf(`--${name}`) + 1] : undefined);

// docs/adr/2026-11-15-1300-a-boards-needs-you-pushes-are-one-live-row.md
test("what waits on the owner is one live notification for the board: its first push alerts, something new joining updates it silently, a falling count or new words push nothing, and once nothing waits it drops its queued push", async () => {
  const queue = path.join(home, '.claude', 'kickflip', 'push', 'queue.json');
  const ownerFile = path.join(site, 'data', 'owner.json');
  const ask = (id, topic, question) => ({ id, topic, question, options: [{ id: 'A', label: 'Keep' }] });
  const answer = (id) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'owner-answer', id, choice: 'A' }) });
  const before = pushes().length;
  const row = () => pushes().slice(before).filter((c) => flag(c, 'tag') === 'board-site').map((c) => [flag(c, 'title'), flag(c, 'body'), flag(c, 'url'), c.includes('--silent')]);
  await putWave(JSON.stringify({ items: [{ id: 'P1', title: 'Pushed', lane: 'progress' }] }));
  fs.writeFileSync(ownerFile, JSON.stringify({ topics: [{ id: 'plan', title: 'Plan' }], items: [ask('p1', 'item:t/P1', 'Keep the badge?')] }));
  try {
    await heard(ownerFile);
    const [first] = pushes().slice(before);
    assert.deepEqual([flag(first, 'kind'), flag(first, 'tag'), first.includes('--now')], ['action', 'board-site', true]);
    assert.deepEqual(row(), [['P1: Answer 1 question', 'Keep the badge?', '/site/questions.html?from=push#p1', false]], 'one item reads as itself, and the first push alerts');
    fs.writeFileSync(ownerFile, JSON.stringify({ topics: [{ id: 'plan', title: 'Plan' }], items: [ask('p1', 'item:t/P1', 'Keep the badge?'), ask('p2', 'item:t/P1', 'Keep the dot?'), ask('p3', 'plan', 'Ship it?')] }));
    await heard(ownerFile);
    assert.deepEqual(row().slice(1), [['T (2)', '3 questions', '/site/#show=action,questions', true]], 'several are counted and open the board filtered to them, silently');
    await ok200(answer('p1'));
    await heard(ownerFile);
    await ok200(answer('p2'));
    await heard(ownerFile);
    assert.equal(row().length, 2, 'a count going down pushes nothing');
    fs.mkdirSync(path.dirname(queue), { recursive: true });
    const keep = [{ tag: 'board-site', url: '/site-other/' }, { tag: 'unrelated', url: '/site/' }];
    fs.writeFileSync(queue, JSON.stringify({ items: [{ tag: 'board-site', url: '/site/#show=action,questions' }, ...keep] }));
    // The answer resolves p3 in owner.json, a write the server's checks run on once it is told of it.
    await ok200(answer('p3'));
    await heard(ownerFile);
    assert.deepEqual(JSON.parse(fs.readFileSync(queue, 'utf8')), { items: keep });
    assert.equal(row().length, 2);
    assert.equal(pushes().length - before, 2, 'no push but the live row');
    assert.deepEqual(pushes().slice(before).map((c) => [c.includes('--now'), c.includes('--silent')]), [[true, false], [false, true]], 'kickflip push takes --now or --silent, not both');
  } finally {
    fs.writeFileSync(ownerFile, '{"items":[]}');
    fs.rmSync(queue, { force: true });
    await heard(ownerFile);
  }
});

// docs/adr/2026-11-17-1505-alerts-opt-in-to-sounding-the-live-row-as-implement-or-a-merge-joins.md
test("with an alert switched on, a card of that kind joining the board's open live notification sounds it once; with it off the update stays silent", async () => {
  const settings = path.join(home, '.claude', 'kickflip', 'settings.json');
  const ownerFile = path.join(site, 'data', 'owner.json');
  const alerts = (a) => fs.writeFileSync(settings, JSON.stringify({ alerts: a }));
  const before = pushes().length;
  const row = () => pushes().slice(before).filter((c) => flag(c, 'tag') === 'board-site').map((c) => [flag(c, 'title'), c.includes('--now'), c.includes('--silent')]);
  const merge = (id) => ({ id, title: 'Held', branch: id, merge_ready: { branch: id, at: '2026-11-04T10:00:00Z' } });
  const implement = (id) => ({ id, title: 'Talked', phase: 'discussing', waits_on_owner: { on: 'implement', at: '2026-11-15T00:25:16Z', phase: 'discussing', lane: 'todo' } });
  const asked = { id: 'Q1', title: 'Asked', lane: 'progress' };
  alerts({ merge: true });
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [{ id: 'a1', topic: 'item:t/Q1', question: 'Keep?', options: [{ id: 'A', label: 'Keep' }] }] }));
  try {
    await putWave(JSON.stringify({ items: [asked] }));
    await heard(ownerFile);
    assert.deepEqual(row(), [['Q1: Answer 1 question', true, false]], 'the row opens alerting');
    await putWave(JSON.stringify({ items: [asked, merge('AM1')] }));
    assert.deepEqual(row().slice(1), [['T (2)', true, false]], 'a merge joining the open row sounds it, with merge ready on');
    await putWave(JSON.stringify({ items: [asked, merge('AM1'), implement('AI1')] }));
    assert.deepEqual(row().slice(2), [['T (3)', false, true]], 'Implement needed is off: its joining stays silent');
    await putWave(JSON.stringify({ items: [asked, merge('AM1'), implement('AI1'), merge('AM2')] }));
    assert.deepEqual(row().slice(3), [['T (4)', true, false]], 'each merge joining sounds once');
    alerts({ implement: true });
    await putWave(JSON.stringify({ items: [asked, merge('AM1'), implement('AI1'), merge('AM2'), implement('AI2'), merge('AM3')] }));
    assert.deepEqual(row().slice(4), [['T (6)', true, false]], 'switches are read at each check: a new Implement sounds, the one already in the row does not');
    await putWave(JSON.stringify({ items: [asked, merge('AM1'), implement('AI1'), merge('AM2'), implement('AI2')] }));
    assert.equal(row().length, 5, 'one leaving pushes nothing');
  } finally {
    fs.rmSync(settings, { force: true });
    fs.writeFileSync(ownerFile, '{"items":[]}');
    await putWave(JSON.stringify({ items: [] }));
    await heard(ownerFile);
  }
});

// docs/adr/2026-11-07-0700-staging-then-ready.md
test("the owner's last answer on a grilling card leaves it discussing, held or blocked too, and wakes no session to start it", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const ask = (id, key) => ({ id, topic: `item:${key}`, question: 'Which?', options: [{ id: 'A', label: 'This' }] });
  const answer = (id) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'owner-answer', id, choice: 'A' }) });
  const unblocked = () => (fs.existsSync(path.join(site, 'data', 'events.jsonl')) ? fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'card-unblocked').map((e) => e.data.key);
  // The board's settle pass writes a card's phase new once it has seen the item file, so a card with none reads new.
  const states = () => JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items.map((i) => i.phase ?? 'new');
  await putWave(JSON.stringify({ items: [{ id: 'S1', title: 'Two questions', phase: 'grilling' }, { id: 'S2', title: 'Blocked', deps: ['S3'], phase: 'grilling' }, { id: 'S3', title: 'Dep' }, { id: 'S4', title: 'Held', held: true, phase: 'grilling' }] }));
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [ask('s1a', 't/S1'), ask('s1b', 't/S1'), ask('s2', 't/S2'), ask('s4', 't/S4')] }));
  const before = unblocked().length;
  try {
    for (const id of ['s1a', 's2', 's4']) await ok200(answer(id));
    await board.settled();
    assert.deepEqual(states(), ['grilling', 'discussing', 'new', 'discussing']);
    await ok200(answer('s1b'));
    await board.settled();
    assert.deepEqual(states(), ['discussing', 'discussing', 'new', 'discussing']);
    assert.deepEqual(unblocked().slice(before), []);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

test("an owner answer opens no confirm: a pick settles its round, with a note or none, and a note with no take resolves its question", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const pick = { id: 'pick', topic: 'item:t/A1', question: 'Which?', url: 'prototype-rounds.html?q=pick', options: [{ id: 'A', label: 'Badge' }, { id: 'B', label: 'Dot' }], round: 2 };
  const plain = { id: 'plain', topic: 'item:t/A1', question: 'Keep?', options: [{ id: 'A', label: 'Keep' }] };
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [pick, plain] }));
  const answer = (id, choice, note = '') => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'owner-answer', id, choice, note }) });
  const items = () => JSON.parse(fs.readFileSync(ownerFile, 'utf8')).items;
  const board = async () => (await fetch(`${base}/api/board`)).json();
  const round = async () => (await board()).ownerTopics.find((t) => t.questions.includes('pick')).round;
  try {
    await ok200(answer('pick', 'B'));
    const untouched = fs.readFileSync(ownerFile, 'utf8');
    assert.deepEqual(await round(), { n: 2, state: 'closed', take: 'B' });
    await ok200(answer('pick', 'B', 'Bigger'));
    assert.equal(fs.readFileSync(ownerFile, 'utf8'), untouched);
    assert.deepEqual(await round(), { n: 2, state: 'closed', take: 'B' });
    const b = await board();
    assert.equal(b.owner.find((q) => q.id === 'pick'), undefined, 'Send folds the answered pick');
    assert.equal(items().find((q) => q.id === 'pick').resolved, 'Answered');
    await ok200(answer('plain', null, 'Keep it, but rename it'));
    assert.equal(items().find((q) => q.id === 'plain').resolved, 'Answered with a note');
    const after = await board();
    assert.equal(after.owner.find((q) => q.id === 'plain'), undefined);
    const topic = after.ownerTopics.find((t) => t.questions.includes('plain')).id;
    const resolved = (await (await fetch(`${base}/api/questions?topic=${encodeURIComponent(topic)}`)).json()).questions;
    assert.deepEqual(resolved.map((q) => [q.id, q.state]), [['pick', 'resolved'], ['plain', 'resolved']]);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

// docs/adr/2026-11-03-1646-a-prototype-answer-with-no-pick-prototypes-again.md
test("an owner answer that picks no take on a card's prototype says so in its event, and the card prototypes again", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const eventsFile = path.join(site, 'data', 'events.jsonl');
  await putWave(JSON.stringify({ items: [{ id: 'P1', title: 'Moon', phase: 'prototyping' }] }));
  const takes ={ id: 'moon', topic: 'item:t/P1', question: 'Which?', url: 'prototype-moon.html?q=moon', options: [{ id: 'A', label: 'Light' }, { id: 'B', label: 'Dark' }] };
  const plain = { id: 'keep', topic: 'item:t/P1', question: 'Keep?', options: [{ id: 'A', label: 'Keep' }] };
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [takes, plain] }));
  const answer = (id, choice, note) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'owner-answer', id, choice, note }) });
  // The server's own orchestrator-waits pass appends meanwhile; the answers' lines are what this reads.
  const last = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind !== 'orchestrator-waits').at(-1);
  try {
    await ok200(answer('keep', null, 'Rename it'));
    assert.equal(last().data.prototype_again, undefined);
    const r = await answer('moon', null, 'Neither: try a darker moon');
    await ok200(r);
    assert.deepEqual([last().kind, last().data.prototype_again], ['owner-answer', true]);
    await board.settled();
    const card = (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === 't/P1');
    assert.deepEqual([card.phase, card.next, card.buildable], ['prototyping', 'Prototype again', false]);
    // The card owes the orchestrator its next round's brief, the note its ask even when it reads as a question; the board
    // launches the round from the brief (docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md).
    const p1 = () => JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items.find((i) => i.id === 'P1');
    assert.deepEqual(p1().briefs.map((b) => [b.kind, b.asks, b.brief]), [['prototype', [{ question: 'moon', note: 'Neither: try a darker moon' }], undefined]]);
    // Every request is its own round: a second one before the brief is written joins the first rather than replacing it
    // (docs/adr/2026-11-14-2300-picked-prototypes-draw-in-parallel-and-their-records-merge-by-topic.md).
    await ok200(await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'prototype-request', key: 't/P1', question: 'keep', note: 'Show both' }) }));
    const asks = [{ question: 'moon', note: 'Neither: try a darker moon' }, { question: 'keep', note: 'Show both' }];
    assert.deepEqual(p1().briefs.map((b) => [b.kind, b.asks]), [['prototype', asks]]);
    const draft = path.join(home, 'brief-P1.md');
    fs.writeFileSync(draft, 'Neither take landed; try a darker moon.');
    await writeBrief(site, 't/P1', { kind: 'prototype', file: draft });
    await heard(path.join(site, 'data', 'items.json'));
    const record = path.join(site, 'data', 'agents', 'P1.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')).brief.asks, asks);
    await ok200(answer('moon', 'B', ''));
    assert.equal(last().data.prototype_again, undefined);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

// docs/adr/2026-11-14-2300-picked-prototypes-draw-in-parallel-and-their-records-merge-by-topic.md
test("one Send with no take picked on two of a card's prototypes owes one brief that asks for both rounds", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  await putWave(JSON.stringify({ items: [{ id: 'P2', title: 'Sky', phase: 'prototyping' }] }));
  const takes = (id) => ({ id, topic: 'item:t/P2', question: `Which ${id}?`, url: `prototype-${id}.html?q=${id}`, options: [{ id: 'A', label: 'Light' }, { id: 'B', label: 'Dark' }] });
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [takes('sun'), takes('cloud')] }));
  try {
    const answers = [{ id: 'sun', question: 'Which sun?', choice: null, note: 'Neither: warmer' }, { id: 'cloud', question: 'Which cloud?', choice: null, note: 'Neither: fluffier' }];
    await ok200(await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'owner-answers', answers }) }));
    await board.settled();
    const p2 = JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items.find((i) => i.id === 'P2');
    assert.deepEqual(p2.briefs.map((b) => [b.kind, b.asks]), [['prototype', [{ question: 'sun', note: 'Neither: warmer' }, { question: 'cloud', note: 'Neither: fluffier' }]]]);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

// docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md
test("a prototype request on a question keeps its note and pick on the event and leaves owner.json alone: the question reads requested, the topic's round reads making and the card prototypes", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const eventsFile = path.join(site, 'data', 'events.jsonl');
  await putWave(JSON.stringify({ items: [{ id: 'R1', title: 'Search' }] }));
  const plain = { id: 'where', topic: 'item:t/R1', question: 'Where does search sit?', options: [{ id: 'A', label: 'Above' }, { id: 'B', label: 'Icon' }] };
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [plain] }));
  const send = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // The server's own orchestrator-waits pass appends meanwhile; the request's line is what this reads.
  const last = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind !== 'orchestrator-waits').at(-1);
  try {
    const untouched = fs.readFileSync(ownerFile, 'utf8');
    await ok200(send({ kind: 'prototype-request', key: 't/R1' }));
    assert.equal(fs.readFileSync(ownerFile, 'utf8'), untouched);

    const r = await send({ kind: 'prototype-request', key: 't/R1', question: 'where', note: 'Show it on a phone', choice: 'B' });
    await ok200(r);
    assert.deepEqual([last().kind, last().data], ['prototype-request', { key: 't/R1', question: 'where', note: 'Show it on a phone', choice: 'B' }]);
    assert.equal(fs.readFileSync(ownerFile, 'utf8'), untouched);
    const b = (await r.json()).board;
    assert.deepEqual([b.owner.map((q) => [q.id, q.state]), b.ownerTopics.find((t) => t.id === 'item:t/R1').open], [[['where', 'requested']], 0]);
    assert.deepEqual(b.ownerTopics.find((t) => t.id === 'item:t/R1').round, { n: 1, state: 'making' });
    const card = b.items.find((i) => i.key === 't/R1');
    assert.deepEqual([card.phase, card.next, card.buildable], ['prototyping', 'Prototype again', false]);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

// docs/adr/2026-11-15-1100-grill-more-hands-its-question-to-the-grill.md
test("a Grill more or prototype request hands its question over: a Send on it is refused, in one answer or a batch, and a grilling card stays grilling", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const eventsFile = path.join(site, 'data', 'events.jsonl');
  await putWave(JSON.stringify({ items: [{ id: 'GM1', title: 'Search', phase: 'grilling' }] }));
  const ask = (id) => ({ id, topic: 'item:t/GM1', question: `${id}?`, options: [{ id: 'A', label: 'This' }] });
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [ask('deeper'), ask('proto')] }));
  const send = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const log = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  try {
    const grill = await send({ kind: 'grill-more', key: 't/GM1', question: 'deeper', note: 'More', choice: 'A' });
    await ok200(grill);
    await ok200(send({ kind: 'prototype-request', key: 't/GM1', question: 'proto', note: 'Show it', choice: 'A' }));
    const before = log().filter((e) => e.kind === 'owner-answer').length;
    const one = await send({ kind: 'owner-answer', id: 'deeper', choice: 'A', note: '' });
    assert.equal(one.status, 400);
    assert.match((await one.json()).error, /deeper waits on the grill/);
    const batch = await send({ kind: 'owner-answers', answers: [{ id: 'proto', choice: 'A', note: '' }] });
    assert.equal(batch.status, 400);
    assert.match((await batch.json()).error, /proto waits on the prototype/);
    assert.equal(log().filter((e) => e.kind === 'owner-answer').length, before);
    const items = JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items;
    assert.equal(items.find((i) => i.id === 'GM1').phase, 'grilling');
    const b = (await (await send({ kind: 'item-message', key: 't/GM1', text: 'hi' })).json()).board;
    assert.deepEqual(b.owner.map((q) => [q.id, q.state, q.request.kind]), [['deeper', 'requested', 'grill-more'], ['proto', 'requested', 'prototype-request']]);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

test("a re-ask request on a resolved question is recorded, marks it pending in the topic's resolved questions and reads 're-ask requested' in the card's thread; one on a question that isn't resolved records nothing", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const eventsFile = path.join(site, 'data', 'events.jsonl');
  await putWave(JSON.stringify({ items: [{ id: 'K1', title: 'Again' }] }));
  const ask = (id, extra = {}) => ({ id, topic: 'item:t/K1', question: `${id}?`, options: [{ id: 'A', label: 'This' }], ...extra });
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [ask('done', { resolved: 'Picked A', resolved_at: '2026-10-23T10:00:00Z' }), ask('live')] }));
  const send = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // The server's own orchestrator-waits pass appends meanwhile; the request's writes are what this compares.
  const lines = () => (fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind !== 'orchestrator-waits');
  try {
    const before = lines().length;
    for (const question of ['live', 'gone']) {
      const r = await send({ kind: 'reask-request', key: 't/K1', question });
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /isn’t resolved|no longer asked here/);
    }
    assert.equal(lines().length, before);
    const r = await send({ kind: 'reask-request', key: 't/K1', question: 'done' });
    await ok200(r);
    assert.deepEqual([lines().at(-1).kind, lines().at(-1).data], ['reask-request', { key: 't/K1', question: 'done' }]);
    const resolved = (await (await fetch(`${base}/api/questions?topic=${encodeURIComponent('item:t/K1')}`)).json()).questions;
    assert.deepEqual(resolved.map((q) => [q.id, q.reask?.ts === lines().at(-1).ts]), [['done', true]]);
    const thread = (await (await fetch(`${base}/api/thread?key=t%2FK1`)).json()).map((m) => [m.text, Boolean(m.request)]);
    assert.deepEqual(thread, [['Re-ask requested', true]]);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});


test("one owner-answers request records every answer as one-by-one answers would, in one write, returning the board once, or on any it can't record records none and says why", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const eventsFile = path.join(site, 'data', 'events.jsonl');
  const ask = (id, key) => ({ id, topic: `item:${key}`, question: `${id}?`, options: [{ id: 'A', label: 'This' }] });
  const batch = (answers) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'owner-answers', answers }) });
  // The server's own orchestrator-waits pass appends meanwhile; the request's writes are what this compares.
  const lines = () => (fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind !== 'orchestrator-waits');
  await putWave(JSON.stringify({ items: [{ id: 'B1', title: 'Two questions', phase: 'grilling' }] }));
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [ask('b1a', 't/B1'), ask('b1b', 't/B1')] }));
  try {
    const untouched = [fs.readFileSync(ownerFile, 'utf8'), lines().length];
    const refused = await batch([{ id: 'b1a', choice: 'A', note: '' }, { id: 'gone', choice: 'A', note: '' }]);
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /gone/);
    assert.deepEqual([fs.readFileSync(ownerFile, 'utf8'), lines().length], untouched);
    assert.equal((await batch([])).status, 400);
    assert.deepEqual([fs.readFileSync(ownerFile, 'utf8'), lines().length], untouched);

    const before = lines().length;
    const r = await batch([{ id: 'b1a', question: 'b1a?', choice: 'A', label: 'A. This', note: 'Bigger' }, { id: 'b1b', question: 'b1b?', choice: null, label: '', note: 'Rename it' }]);
    await ok200(r);
    const out = await r.json();
    const added = lines().slice(before);
    assert.deepEqual(added.map((e) => [e.kind, e.data]), [
      ['owner-answer', { id: 'b1a', question: 'b1a?', choice: 'A', label: 'A. This', note: 'Bigger' }],
      ['owner-answer', { id: 'b1b', question: 'b1b?', choice: null, label: '', note: 'Rename it' }]]);
    assert.deepEqual(out.ids, added.map((e) => e.id));
    await board.settled();
    const after = await (await fetch(`${base}/api/board`)).json();
    assert.equal(after.items.find((i) => i.id === 'B1').phase, 'discussing', 'a note-only answer leaves the task discussing too');
    assert.deepEqual(after.owner.filter((q) => q.topic === 'item:t/B1').map((q) => [q.id, q.state]), [], 'Send folds both answers');
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).items.find((q) => q.id === 'b1a').resolved, 'Answered');
    assert.deepEqual(after.ownerTopics.find((t) => t.id === 'item:t/B1').questions, ['b1a', 'b1b']);
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).items.find((q) => q.id === 'b1b').resolved, 'Answered with a note');
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

// docs/adr/2026-11-16-0300-send-answers-once-the-answers-are-written.md
test("Send answers once the answers are written and their questions resolved: the move to discussing follows, and the notes stay untouched", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const itemsFile = path.join(site, 'data', 'items.json');
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await putWave(JSON.stringify({ items: [{ id: 'FAST1', title: 'Fast', phase: 'grilling' }] }));
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [{ id: 'fast', topic: 'item:t/FAST1', question: 'fast?', options: [{ id: 'A', label: 'This' }] }] }));
  const card = () => JSON.parse(fs.readFileSync(itemsFile, 'utf8')).items.find((i) => i.id === 'FAST1');
  try {
    const r = await post({ kind: 'owner-answers', answers: [{ id: 'fast', question: 'fast?', choice: 'A', label: 'A. This', note: '' }] });
    await ok200(r);
    assert.equal((await r.json()).ids.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).items[0].resolved, 'Answered');
    await board.settled();
    assert.equal(card().plan, undefined, 'no notes are written');
    assert.equal(card().phase, 'discussing');
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

test('a Send of answers already recorded adds nothing and answers as sent', async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const eventsFile = path.join(site, 'data', 'events.jsonl');
  const lines = () => (fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'owner-answer' && e.data.id === 'once');
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await putWave(JSON.stringify({ items: [{ id: 'ONCE1', title: 'Once' }] }));
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [{ id: 'once', topic: 'item:t/ONCE1', question: 'once?', options: [{ id: 'A', label: 'This' }] }] }));
  try {
    const send = () => post({ kind: 'owner-answers', answers: [{ id: 'once', question: 'once?', choice: 'A', label: 'A. This', note: '' }] });
    await ok200(send());
    const again = await send();
    assert.equal(again.status, 200);
    assert.deepEqual((await again.json()).ids, []);
    await ok200(post({ kind: 'owner-answer', id: 'once', choice: 'A' }));
    assert.equal(lines().length, 1);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

test('board writes refuse cross-site requests and non-JSON bodies before their handlers run', async () => {
  const file = path.join(site, 'data', 'events.jsonl');
  // The server's own orchestrator-waits pass appends meanwhile; the refused writes are what this compares.
  const writes = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.includes('"kind":"orchestrator-waits"')).join('\n') : null);
  const before = writes();
  // Each guard once here; hub/cross-site.test.mjs checks every header case.
  for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://other.example' }]) {
    const r = await fetch(`${base}/_claude/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ kind: 'ask', text: 'Refused' }),
    });
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.match(r.headers.get('content-type'), /^text\/plain/);
  }
  for (const p of ['/_claude/events', '/api/settings', '/api/try', '/api/rules', '/api/hide', '/api/read', '/api/drafts']) {
    assert.equal((await fetch(base + p, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{' })).status, 403, p);
  }
  assert.equal((await fetch(`${base}/_claude/health`, { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(writes(), before);
  for (const headers of [{ 'sec-fetch-site': 'same-origin', origin: base }, {}]) {
    const r = await fetch(`${base}/_claude/events`, {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify({ kind: 'guard-check' }),
    });
    assert.equal(r.status, 200, JSON.stringify(headers));
  }
  await ok200(fetch(`${base}/_claude/events`, { headers: { origin: 'https://other.example' } }));
  await ok200(fetch(`${base}/_claude/health`, { method: 'HEAD', headers: { 'sec-fetch-site': 'cross-site' } }));
});

test('cross-site raw uploads are refused before a file is stored', async () => {
  const before = fs.existsSync(uploads()) ? fs.readdirSync(uploads()) : [];
  const r = await fetch(`${base}/api/upload`, {
    method: 'POST', headers: { 'content-type': 'text/plain', 'x-filename': 'refused.txt', origin: 'https://other.example' }, body: 'refused',
  });
  assert.equal(r.status, 403);
  assert.deepEqual(fs.existsSync(uploads()) ? fs.readdirSync(uploads()) : [], before);
});

test('a copied starter refuses cross-site writes and accepts same-origin JSON and Node callers', async () => {
  const root = path.join(home, 'starter');
  fs.cpSync(fileURLToPath(new URL('../starter', import.meta.url)), root, { recursive: true });
  const [port] = await freePorts();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(root, 'server.mjs')], { env: { ...process.env, KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true', HOME: home, PORT: String(port), PREFIX: '/plain' } });
  try {
    await boardListening(server);
    const post = (headers, body = '{"kind":"message","text":"Hello"}') => fetch(`${url}/plain/_claude/events`, { method: 'POST', headers, body });
    for (const headers of [
      { 'content-type': 'application/json', origin: 'https://other.example' },
      { 'content-type': 'text/plain', origin: url },
    ]) assert.equal((await post(headers)).status, 403, JSON.stringify(headers));
    assert.equal(fs.existsSync(path.join(root, 'data')), false);
    for (const headers of [
      { 'content-type': 'application/json', origin: url },
      { 'content-type': 'application/json' },
    ]) assert.equal((await post(headers)).status, 200, JSON.stringify(headers));
    await ok200(fetch(`${url}/_claude/events`));
    assert.equal((await fetch(`${url}/_claude/health`, { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill();
      await exited;
    }
  }
});

test('an upload is stored under data/uploads and served back with its type', async () => {
  const r = await upload('hello', '../../ my log.txt', 'text/plain');
  await ok200(r);
  const u = await r.json();
  assert.equal(u.name, '../../ my log.txt');
  assert.match(u.url, /^uploads\/\d+-my-log\.txt$/);
  assert.equal(path.dirname(u.path), uploads());
  assert.deepEqual([u.type, u.size], ['text/plain', 5]);
  const back = await fetch(`${base}/${u.url}`);
  assert.equal(back.status, 200);
  assert.match(back.headers.get('content-type'), /^text\/plain/);
  assert.equal(await back.text(), 'hello');
});

test('an upload over 20 MB is refused and leaves no file', async () => {
  const before = fs.readdirSync(uploads()).length;
  const r = await upload(new Uint8Array(20 * 1024 * 1024 + 1), 'big.bin', 'application/octet-stream');
  assert.equal(r.status, 413);
  assert.equal(fs.readdirSync(uploads()).length, before);
});

test('only stored uploads are served, never other files under data', async () => {
  for (const p of ['/uploads/..%2fowner.json', '/uploads/%2e%2e/owner.json', '/data/owner.json', '/uploads/.meta']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});

test('a card with a message marked working or a prototype recorded for it stays in Todo with its Build', async () => {
  await putWave(JSON.stringify({ items: [{ id: 'W1', title: 'Messaged' }, { id: 'W2', title: 'Prototyped' }] }));
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { id } = await post('/_claude/events', { kind: 'item-message', key: 't/W1', text: 'Fix it' });
  const lanes = async () => (await (await fetch(`${base}/api/board`)).json()).items.filter((i) => i.id === 'W1' || i.id === 'W2').map((i) => [i.id, i.lane, i.buildable]).sort();
  assert.deepEqual(await lanes(), [['W1', 'todo', true], ['W2', 'todo', true]]);
  fs.writeFileSync(path.join(site, 'data', 'working.json'), JSON.stringify({ events: { [id]: new Date().toISOString() } }));
  fs.writeFileSync(path.join(site, 'data', 'prototypes.json'), JSON.stringify({ prototypes: [{ topic: 'w2', title: 'W2', card: 't/W2', takes: [{ key: 'A', label: 'One' }] }] }));
  try {
    assert.deepEqual(await lanes(), [['W1', 'todo', true], ['W2', 'todo', true]]);
  } finally {
    fs.rmSync(path.join(site, 'data', 'working.json'));
    fs.rmSync(path.join(site, 'data', 'prototypes.json'));
  }
});

test("a Build tap starts the build in the board server, moving the card to In Progress reading starting and launching its builder with no event, and a refusal leaves it in Todo with the reason; a blocked card it bumps instead, leaving it in Todo", async () => {
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
  fs.writeFileSync(manifest, JSON.stringify({ sites: { site: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: clone } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/items.json', slug: 't', github_login: 'Me' }));
  const hubSettings = path.join(home, '.claude', 'kickflip', 'settings.json');
  fs.writeFileSync(hubSettings, JSON.stringify({ tasksInProgress: 10 }));
  await putWave(JSON.stringify({ items: [
    { id: 'B1', title: 'feat: tapped', lane: 'todo', next: 'Implement' }, { id: 'B2', title: 'feat: held', lane: 'todo', held: true, pick_up_at: '2099-01-01T00:00:00.000Z' }, { id: 'B3', title: 'feat: blocked', lane: 'todo', deps: ['B4'] }, { id: 'B4', title: 'feat: dep', lane: 'todo' },
    { id: 'B5', title: 'feat: held and blocked', lane: 'todo', deps: ['B4'], held: true }, { id: 'B6', title: 'feat: leftover worktree', lane: 'todo' }, { id: 'B7', title: 'feat: leftover work', lane: 'todo' },
    { id: 'B8', title: 'feat: held and unstarted', lane: 'todo', held: true }, { id: 'B9', title: 'feat: held and waiting', lane: 'todo', held: true }, { id: 'B10', title: 'Held and grilled', lane: 'todo', held: true },
    { id: 'B11', title: 'Ready', lane: 'todo', phase: 'ready' }, { id: 'B12', title: 'Grilling', lane: 'todo', phase: 'grilling', unfiled: true }, { id: 'B13', title: 'Leftover work, prototyping', lane: 'todo', phase: 'prototyping' },
    { id: 'B14', title: 'feat: waits for a slot', lane: 'todo' },
  ] }));
  const wave = () => JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8'));
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const log = () => (fs.existsSync(path.join(site, 'data', 'events.jsonl')) ? fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const card = async (id) => (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.id === id);
  const thread = (id) => fs.readFileSync(path.join(site, 'data', 'threads', `t__${id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const worktree = path.join(home, '.claude', 'kickflip', 'worktrees', 'B1');
  const before = log().length;
  try {
    await ok200(post({ kind: 'card-build', key: 't/B1' }));
    const record = JSON.parse(fs.readFileSync(path.join(site, 'data', 'agents', 'B1.json'), 'utf8'));
    assert.deepEqual([record.kind, record.label, record.dispatched, record.worktree], ['claude', 'Builder', 'tap', { path: worktree, branch: 'me/t/b1', repo: clone }]);
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'));
    assert.equal(wave().items.find((i) => i.id === 'B1').next, undefined);
    // orchestrator-waits and waits-history are the waits check's own record of a change, not an event the tap sent.
    assert.deepEqual(log().slice(before).map((e) => e.kind).filter((k) => !['orchestrator-waits', 'waits-history'].includes(k)), []);
    const started = await card('B1');
    assert.deepEqual([started.lane, started.storedLane, started.buildable, started.builder.progress, started.refusal], ['progress', 'progress', false, null, null]);

    const held = await card('B2');
    assert.deepEqual([Boolean(held.ownerBlock), held.buildable], [true, true]);
    await ok200(post({ kind: 'card-build', key: 't/B2' }));
    const unheld = await card('B2');
    assert.deepEqual([unheld.ownerBlock, unheld.lane, unheld.storedLane, unheld.builder.progress, unheld.refusal], [null, 'progress', 'progress', null, null]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items[1].pick_up_at, undefined);
    assert.deepEqual(thread('B2').map((m) => [m.who, m.text.replace(/ in .*/, '')]), [['love', 'Unblocked'], ['claude', 'Moved to In Progress: a build started']]);
    assert.deepEqual(log().slice(before).map((e) => e.kind).filter((k) => !['orchestrator-waits', 'waits-history'].includes(k)), []);
    // docs/adr/2026-11-05-0500-held-only-stops-the-automatic-pull.md: a held card that has an unstarted status is unheld by Implement too.
    for (const id of ['B8', 'B9']) {
      await ok200(post({ kind: 'card-build', key: `t/${id}` }));
      const resumed = await card(id);
      assert.deepEqual([resumed.ownerBlock, resumed.lane, resumed.storedLane, resumed.refusal], [null, 'progress', 'progress', null], id);
      assert.deepEqual(thread(id).map((m) => m.text.replace(/ in .*/, '')), ['Unblocked', 'Moved to In Progress: a build started'], id);
    }
    // Grill leaves the owner's block alone.
    await ok200(post({ kind: 'grill-more', key: 't/B10' }));
    assert.deepEqual((await card('B10')).ownerBlock, { until: null });
    // docs/adr/2026-11-05-0802-todo-has-no-queue.md
    const bumpedAnswer = await (await post({ kind: 'card-build', key: 't/B3' })).json();
    assert.equal(bumpedAnswer.id, null);
    assert.ok(bumpedAnswer.board.items.find((i) => i.id === 'B3').bumpedAt);
    const bumped = await card('B3');
    assert.deepEqual([bumped.lane, 'queued' in bumped, bumped.storedLane, bumped.builder, bumped.next, bumped.buildable, bumped.blockedBy.map((d) => d.ref)], ['todo', false, 'todo', null, null, true, ['B4']]);
    assert.deepEqual(thread('B3').map((m) => [m.who, m.text]), [['claude', 'Can’t start yet: waits on B4. Bumped to the top of Todo.']]);
    assert.equal(fs.existsSync(path.join(site, 'data', 'agents', 'B3.json')), false);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'kickflip', 'worktrees', 'B3')), false);
    await ok200(post({ kind: 'card-build', key: 't/B5' }));
    const unheldBumped = await card('B5');
    assert.deepEqual([unheldBumped.ownerBlock, unheldBumped.blocked, unheldBumped.lane, Boolean(unheldBumped.bumpedAt)], [null, true, 'todo', true]);
    assert.deepEqual(thread('B5').map((m) => m.text), ['Unblocked', 'Can’t start yet: waits on B4. Bumped to the top of Todo.']);
    assert.deepEqual(log().slice(before).filter((e) => e.kind === 'card-bump').map((e) => e.data.key), ['t/B3', 't/B5']);
    assert.deepEqual(log().slice(before).map((e) => e.kind).filter((k) => !['orchestrator-waits', 'waits-history', 'grill-more', 'card-bump'].includes(k)), []);

    const taken = path.join(home, '.claude', 'kickflip', 'worktrees', 'B4');
    fs.mkdirSync(taken, { recursive: true });
    await ok200(post({ kind: 'card-build', key: 't/B4' }));
    const leftover = await card('B4');
    // A status line holds 100 characters, so a long path reads by its last part (board/hub-lines.mjs fit).
    assert.deepEqual([leftover.lane, leftover.storedLane, leftover.refusal], ['todo', 'todo', "Couldn't start implementing: --worktree: …/B4 already exists; land or remove it first"]);
    assert.deepEqual(log().slice(before).map((e) => e.kind).filter((k) => !['orchestrator-waits', 'waits-history', 'grill-more', 'card-bump'].includes(k)), []);

    // A leftover worktree holding no work is remade from the board's fetched main; one holding work still refuses.
    git(clone, 'fetch', '--quiet', 'origin');
    const leftover6 = path.join(home, '.claude', 'kickflip', 'worktrees', 'B6');
    const leftover7 = path.join(home, '.claude', 'kickflip', 'worktrees', 'B7');
    git(clone, 'worktree', 'add', '--quiet', '-b', 'B6', leftover6, 'origin/main');
    git(clone, 'worktree', 'add', '--quiet', '-b', 'B7', leftover7, 'origin/main');
    fs.writeFileSync(path.join(leftover7, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(origin, 'b.txt'), 'b\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '--quiet', '-m', 'main moved');
    await ok200(post({ kind: 'card-build', key: 't/B6' }));
    const remade = await card('B6');
    assert.deepEqual([remade.lane, remade.storedLane, remade.refusal], ['progress', 'progress', null]);
    assert.equal(git(leftover6, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'));
    assert.deepEqual(thread('B6').map((m) => [m.who, m.text]), [['claude', 'Moved to In Progress: a build started'], ['claude', 'Remade its leftover worktree: it held no commits or changes.']]);
    await ok200(post({ kind: 'card-build', key: 't/B7' }));
    const kept = await card('B7');
    assert.deepEqual([kept.lane, kept.storedLane, kept.refusal], ['todo', 'todo', "Couldn't start implementing: --worktree: …/B7 holds 1 changed file; land or remove it first"]);

    // docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md: with every slot taken by a card In
    // Progress, the tap starts nothing: the card stays in Todo, bumped to the top for the pull.
    const inProgress = (await (await fetch(`${base}/api/board`)).json()).items.filter((i) => i.lane === 'progress').length;
    fs.writeFileSync(hubSettings, JSON.stringify({ tasksInProgress: inProgress }));
    try {
      await ok200(post({ kind: 'card-build', key: 't/B14' }));
      const waits = await card('B14');
      assert.deepEqual([waits.lane, waits.storedLane, Boolean(waits.bumpedAt), waits.refusal], ['todo', 'todo', true, null]);
      assert.deepEqual(thread('B14').map((m) => [m.who, m.text]), [['claude', 'Can’t start yet: waits on a free implementer slot. Bumped to the top of Todo.']]);
      assert.equal(fs.existsSync(path.join(site, 'data', 'agents', 'B14.json')), false);
    } finally {
      fs.writeFileSync(hubSettings, JSON.stringify({ tasksInProgress: 10 }));
    }

    // docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md: an empty Implement on a card
    // still grilling writes its keyed status line and stages the card, with no event and no build.
    const events = log().length;
    // docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md: on a ready card,
    // which has had its Implement, it answers 409 and the card stays ready.
    const ready = await post({ kind: 'item-message', key: 't/B11', text: '', intent: 'build' });
    assert.equal(ready.status, 409);
    assert.equal(wave().items.find((i) => i.id === 'B11').phase, 'ready');
    // docs/adr/2026-11-08-0900-ready-and-staging-moves-are-bare-status-lines.md: it stages the card, with "Marked as
    // staging" after the request line, and starts no build.
    for (const id of ['B12']) {
      await ok200(post({ kind: 'item-message', key: `t/${id}`, text: '', intent: 'build' }));
      const tapped = await card(id);
      assert.deepEqual([tapped.lane, tapped.storedLane, tapped.staging], ['todo', 'todo', true], id);
      assert.deepEqual([wave().items.find((i) => i.id === id).phase, 'unfiled' in wave().items.find((i) => i.id === id)], ['staging', false], id);
      assert.equal(fs.existsSync(path.join(site, 'data', 'agents', `${id}.json`)), false, id);
      // A pull refused on it posts its refusal once; the tap's own line is what this reads.
      assert.deepEqual(thread(id).filter((m) => m.line !== 'build-refused').map((m) => [m.who, m.command, m.text]), [['claude', 'staged', 'Marked as staged']], id);
    }
    assert.deepEqual(log().slice(events).map((e) => e.kind).filter((k) => k !== 'orchestrator-waits'), []);
  } finally {
    fs.rmSync(manifest);
    fs.rmSync(hubSettings);
    fs.rmSync(path.join(site, 'data', 'agents'), { recursive: true, force: true });
    fs.rmSync(path.join(home, '.claude', 'kickflip', 'worktrees'), { recursive: true, force: true });
  }
});

// docs/adr/2026-11-07-0700-staging-then-ready.md
test("an Implement message stages a Todo card where it is, its words left out of the notes and its open questions skipped; a Reply stages a ready card and leaves any other", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  await putWave(JSON.stringify({ items: [{ id: 'IMP1', title: 'Implement', held: true }, { id: 'IMPR1', title: 'Reply', phase: 'grilling' }, { id: 'IMPR2', title: 'Ready reply', phase: 'ready' }, { id: 'IMPG1', title: 'Ready grill', phase: 'ready' }, { id: 'IMPP1', title: 'Staged prototype', phase: 'staging' }] }));
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [{ id: 'impq1', topic: 'item:t/IMP1', question: 'Which?', options: [{ id: 'A', label: 'This' }] }] }));
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const item = (id) => JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items.find((i) => i.id === id);
  const log = () => fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const footer = async (key) => (await (await fetch(`${base}/api/thread?key=${encodeURIComponent(key)}`)).json()).filter((m) => m.eventId).map((m) => [m.text, m.status]);
  try {
    const sent = await post({ kind: 'item-message', key: 't/IMP1', text: 'Use the blue', intent: 'build' });
    const card = sent.board.items.find((i) => i.id === 'IMP1');
    const staged = item('IMP1').staged_at;
    assert.ok(staged);
    assert.deepEqual([card.lane, card.ownerBlock !== null, card.staging, item('IMP1').held, item('IMP1').phase, item('IMP1').plan], ['todo', true, true, true, 'staging', undefined]);
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).items[0].resolved, 'Skipped: you tapped Implement');
    assert.deepEqual(log().filter((e) => e.kind === 'item-message').at(-1).data, { key: 't/IMP1', text: 'Use the blue', intent: 'build' });
    assert.deepEqual(await footer('t/IMP1'), [['Use the blue', 'Implement']]);
    // The message comes first in the thread; the lines its tap caused follow it.
    const order = (await (await fetch(`${base}/api/thread?key=t%2FIMP1`)).json()).map((m) => m.text);
    assert.equal(order[0], 'Use the blue');
    assert.ok(order.length > 1);
    // A second Implement while it is staging keeps the first time, and adds its words.
    await post({ kind: 'item-message', key: 't/IMP1', text: 'And the red', intent: 'build' });
    assert.equal(item('IMP1').staged_at, staged);
    assert.equal(item('IMP1').plan, undefined, 'the owner\'s words are in the thread, never copied into notes');

    const replied = await post({ kind: 'item-message', key: 't/IMPR1', text: 'Why blue?', intent: 'reply' });
    assert.deepEqual([replied.board.items.find((i) => i.id === 'IMPR1').lane, item('IMPR1').phase], ['todo', 'grilling']);
    assert.deepEqual(await footer('t/IMPR1'), [['Why blue?', undefined]]);
    const back = await post({ kind: 'item-message', key: 't/IMPR2', text: 'Also the weekend', intent: 'reply' });
    assert.deepEqual([back.board.items.find((i) => i.id === 'IMPR2').staging, item('IMPR2').phase], [true, 'staging']);
    assert.equal(item('IMPR2').plan, undefined);
    // A Grill tap takes a ready card out of it; a typed request on a staged card is refused and leaves it staged.
    await post({ kind: 'grill-more', key: 't/IMPG1' });
    const staged2 = item('IMPP1').staged_at;
    for (const kind of ['prototype-request', 'grill-more', 'visual-request', 'review-request']) {
      const refused = await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, key: 't/IMPP1' }) });
      assert.equal(refused.status, 409, kind);
    }
    assert.deepEqual([item('IMPG1').phase, item('IMPP1').phase, item('IMPP1').staged_at, item('IMPP1').briefs], ['grilling', 'staging', staged2, undefined]);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

// docs/adr/2026-11-15-0100-an-implement-tap-stops-the-card-s-planners-and-stages-it.md
test("an Implement tap on a card with a running grill, prototype or visual stops it and stages the card, its questions skipped and its chain ended", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const stagedFile = path.join(site, 'data', 'staged-questions.json');
  const kinds = { IWG: 'grill', IWP: 'prototype', IWV: 'visual' };
  await putWave(JSON.stringify({ items: Object.keys(kinds).map((id) => ({ id, title: id, phase: { grill: 'grilling', prototype: 'prototyping', visual: 'discussing' }[kinds[id]] })) }));
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const item = (id) => JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items.find((i) => i.id === id);
  const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  fs.mkdirSync(path.join(site, 'data', 'agents'), { recursive: true });
  const children = {};
  for (const id of Object.keys(kinds)) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    children[id] = child;
    await new Promise((resolve) => child.once('spawn', resolve));
    fs.writeFileSync(path.join(site, 'data', 'agents', `${id}.json`), JSON.stringify({ kind: kinds[id], started: new Date().toISOString(), session: { pid: child.pid, at: new Date().toISOString() } }));
  }
  try {
    fs.writeFileSync(ownerFile, JSON.stringify({ items: [{ id: 'iwq', topic: 'item:t/IWP', question: 'Which?', url: 'prototype-iw.html?q=iwq', options: [{ id: 'A', label: 'One' }] }] }));
    fs.writeFileSync(stagedFile, JSON.stringify({ 't/IWG': [{ id: 'iwg1', topic: 'item:t/IWG', question: 'Staged?', options: [{ id: 'A', label: 'Yes' }] }] }));
    for (const id of Object.keys(kinds)) {
      const sent = await post({ kind: 'item-message', key: `t/${id}`, text: '', intent: 'build' });
      assert.deepEqual([sent.board.items.find((i) => i.id === id).staging, item(id).phase], [true, 'staging'], id);
      const record = JSON.parse(fs.readFileSync(path.join(site, 'data', 'agents', `${id}.json`), 'utf8'));
      assert.deepEqual([Boolean(record.done), record.note], [true, 'Stopped by your Implement tap'], id);
      if (children[id].exitCode === null && children[id].signalCode === null) await new Promise((resolve) => children[id].once('exit', resolve));
      assert.equal(gone(children[id].pid), true, `${id}'s planner process stopped`);
    }
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    assert.equal(owner.items[0].resolved, 'Skipped: you tapped Implement');
    assert.equal(JSON.parse(fs.readFileSync(stagedFile, 'utf8'))['t/IWG'], undefined);
  } finally {
    for (const child of Object.values(children)) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    fs.writeFileSync(ownerFile, '{"items":[]}');
    fs.rmSync(stagedFile, { force: true });
    fs.rmSync(path.join(site, 'data', 'agents'), { recursive: true, force: true });
  }
});

// docs/adr/2026-11-12-0700-reply-implement-marks-a-card-ready-to-implement.md
test("a Prototype, Grill or Visual tap ends the orchestrator's Implement or Close mark on a card", async () => {
  await putWave(JSON.stringify({ items: [{ id: 'OW1', title: 'One' }, { id: 'OW2', title: 'Two' }, { id: 'OW3', title: 'Three' }] }));
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const itemsFile = path.join(site, 'data', 'items.json');
  const marked = (id) => JSON.parse(fs.readFileSync(itemsFile, 'utf8')).items.find((i) => i.id === id).waits_on_owner;
  const mark = (id, on) => {
    const f = JSON.parse(fs.readFileSync(itemsFile, 'utf8'));
    f.items.find((i) => i.id === id).waits_on_owner = { on, at: '2026-11-12T20:00:00Z' };
    fs.writeFileSync(itemsFile, JSON.stringify(f));
  };
  for (const [id, kind, on] of [['OW1', 'prototype-request', 'implement'], ['OW2', 'grill-more', 'close'], ['OW3', 'visual-request', 'implement']]) {
    mark(id, on);
    assert.equal(marked(id).on, on);
    const r = await post({ kind, key: `t/${id}` });
    assert.equal(marked(id), undefined, kind);
    assert.equal(r.board.items.find((i) => i.id === id).action, null, kind);
  }
});

// docs/adr/2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md
test("a thread message sent again with the same send id records once: the resend answers with the first event's id, and an Implement resent stages once", async () => {
  await putWave(JSON.stringify({ items: [{ id: 'SID1', title: 'Resent' }] }));
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const log = () => fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'item-message' && e.data.key === 't/SID1');
  const item = () => JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items.find((i) => i.id === 'SID1');
  const first = await post({ kind: 'item-message', key: 't/SID1', text: 'Use the blue', intent: 'build', sendId: 's-1' });
  const again = await post({ kind: 'item-message', key: 't/SID1', text: 'Use the blue', intent: 'build', sendId: 's-1' });
  assert.ok(first.id);
  assert.equal(again.id, first.id);
  assert.ok(again.board);
  assert.deepEqual(log().map((e) => e.data), [{ key: 't/SID1', text: 'Use the blue', intent: 'build', sendId: 's-1' }]);
  assert.equal(item().plan, undefined);
  const other = await post({ kind: 'item-message', key: 't/SID1', text: 'Use the blue', sendId: 's-2' });
  assert.notEqual(other.id, first.id);
  assert.equal(log().length, 2);
});

// docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md
test("a reply-box tap sent again with the same send id records once, whatever its kind: a request and a Hold answer with the first event's id", async () => {
  await putWave(JSON.stringify({ items: [{ id: 'SID2', title: 'Tapped' }] }));
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const log = (kind) => fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === kind && e.data.key === 't/SID2');
  for (const body of [{ kind: 'prototype-request', key: 't/SID2', sendId: 'p-1' }, { kind: 'card-hold', key: 't/SID2', hold: true, for: 'forever', sendId: 'h-1' }]) {
    const first = await post(body);
    const again = await post(body);
    assert.ok(first.id, body.kind);
    assert.equal(again.id, first.id, body.kind);
    assert.equal(log(body.kind).length, 1, body.kind);
  }
});

// docs/adr/2026-11-13-2045-an-exact-repeat-within-30-seconds-is-skipped.md
test("an exact repeat of a message within 30 seconds is skipped, and one later or on another card is kept", async () => {
  await putWave(JSON.stringify({ items: [{ id: 'RP1', title: 'One' }, { id: 'RP2', title: 'Two' }] }));
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const eventsFile = path.join(site, 'data', 'events.jsonl');
  const log = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'item-message' && /^t\/RP/.test(e.data.key));
  clockSkewMs = -31_000;
  const first = await post({ kind: 'item-message', key: 't/RP1', text: 'Bump' });
  const again = await post({ kind: 'item-message', key: 't/RP1', text: 'Bump' });
  assert.equal(again.id, first.id);
  assert.ok(again.board);
  assert.equal(log().length, 1);
  await post({ kind: 'item-message', key: 't/RP2', text: 'Bump' });
  assert.equal(log().length, 2);
  clockSkewMs = 0;
  const later = await post({ kind: 'item-message', key: 't/RP1', text: 'Bump' });
  assert.notEqual(later.id, first.id);
  const ask = await post({ kind: 'ask', text: 'Release it' });
  assert.equal((await post({ kind: 'ask', text: 'Release it' })).id, ask.id);
});

// docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md
test("an owner tap carries the card version it was drawn from: one whose card has moved since answers 409 with where the card is, and changes nothing", async () => {
  await putWave(JSON.stringify({ items: [{ id: 'VT1', title: 'Readied', phase: 'ready', held: true }] }));
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const item = () => JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items.find((i) => i.id === 'VT1');
  const tapEvents = () => fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.data?.key === 't/VT1');
  const card = async () => (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === 't/VT1');
  assert.equal((await card()).version, 'todo/ready');
  for (const body of [{ kind: 'item-message', key: 't/VT1', text: '', intent: 'build', version: 'todo/discussing', sendId: 'v-1' }, { kind: 'card-done', key: 't/VT1', version: 'todo/discussing' }, { kind: 'card-build', key: 't/VT1', version: 'todo/staging' }]) {
    const r = await post(body);
    assert.equal(r.status, 409, body.kind);
    assert.match((await r.json()).error, /already ready.*nothing changed/, body.kind);
  }
  assert.deepEqual([item().phase, item().lane ?? 'todo', item().done, tapEvents().length], ['ready', 'todo', undefined, 0]);
  // A tap drawn from where the card is goes through.
  await ok200(post({ kind: 'card-hold', key: 't/VT1', hold: false, version: 'todo/ready' }));
  assert.equal(item().held, undefined);
  await putWave(JSON.stringify({ items: [{ id: 'VT1', title: 'Readied', phase: 'ready', held: true }] }));
});

// The original fault (#735): a ready card's bare Implement staged it again. Implement on a ready card changes nothing.
test("a bare Implement on a ready card answers 409, already ready, and leaves it ready with no staged line", async () => {
  await putWave(JSON.stringify({ items: [{ id: 'VT2', title: 'Ready', phase: 'ready', held: true }] }));
  const item = () => JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items.find((i) => i.id === 'VT2');
  const r = await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'item-message', key: 't/VT2', text: '', intent: 'build', version: 'todo/ready', sendId: 'v-2' }) });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /already ready/);
  assert.deepEqual([item().phase, item().held], ['ready', true]);
  const thread = path.join(site, 'data', 'threads', 't__VT2.jsonl');
  assert.ok(!fs.existsSync(thread) || !/staged/.test(fs.readFileSync(thread, 'utf8')));
});

test("a bare Implement on a staged card answers 409, already staged, and writes no second staged line", async () => {
  await putWave(JSON.stringify({ items: [{ id: 'VT3', title: 'Staged', phase: 'staging', staged_at: '2026-11-01T00:00:00.000Z' }] }));
  const r = await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'item-message', key: 't/VT3', text: '', intent: 'build', sendId: 'v-3' }) });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /already staged/);
  const thread = path.join(site, 'data', 'threads', 't__VT3.jsonl');
  assert.ok(!fs.existsSync(thread) || !/staged/.test(fs.readFileSync(thread, 'utf8')));
});

test("a Tap Implement push already sent is closed on the owner's devices once its card is staged", async (t) => {
  const { startFakeDevice } = await import('../hub/fake-device.mjs');
  const device = await startFakeDevice();
  const subs = path.join(home, '.claude', 'kickflip', 'push', 'subs.json');
  fs.mkdirSync(path.dirname(subs), { recursive: true });
  fs.writeFileSync(subs, JSON.stringify([device.subscription]));
  process.env.KICKFLIP_HUB_PORT = String(device.port);
  t.after(async () => { fs.rmSync(subs, { force: true }); delete process.env.KICKFLIP_HUB_PORT; await device.close(); });
  const mark = { on: 'implement', at: '2026-11-15T00:25:16Z', phase: 'discussing', lane: 'todo' };
  await putWave(JSON.stringify({ items: [{ id: 'CL1', title: 'Closed', phase: 'discussing', waits_on_owner: mark }] }));
  assert.equal(pushes().filter((c) => flag(c, 'tag') === 'board-site' && flag(c, 'title') === 'CL1: Tap Implement').length, 1, 'Tap Implement pushes');
  await putWave(JSON.stringify({ items: [{ id: 'CL1', title: 'Closed', phase: 'staging', waits_on_owner: mark }] }));
  assert.deepEqual(device.received.map((m) => m.close), ['board-site']);
  await putWave(JSON.stringify({ items: [] }));
});

test("a hidden thread message leaves the item's thread", async () => {
  await putWave(JSON.stringify({ items: [{ id: 'A1', title: 'One' }] }));
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { id } = await post('/_claude/events', { kind: 'item-message', key: 't/A1', text: 'Fix it' });
  const thread = async () => (await (await fetch(`${base}/api/thread?key=t%2FA1`)).json()).map((m) => [m.eventId, m.state]);
  assert.deepEqual(await thread(), [[id, 'waiting']]);
  await post('/api/hide', { id, hidden: true });
  assert.deepEqual(await thread(), []);
});

test("a new task is a New T-<n> card from the moment it arrives, whose thread holds the ask, its thread and the owner's replies to it", async () => {
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { id } = await post('/_claude/events', { kind: 'ask', text: 'Fix the header' });
  const thread = async (key) => (await (await fetch(`${base}/api/thread?key=${encodeURIComponent(key)}`)).json()).map((m) => [m.eventId ?? m.link, m.text, m.state]);
  const board = async () => (await fetch(`${base}/api/board`)).json();
  const card = async () => (await board()).items.find((i) => i.kind === 'ask' && i.id === id);
  // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md
  const filed = (await board()).moved[`ask:${id}`];
  const arrived = (await board()).items.find((i) => i.key === filed);
  assert.deepEqual([await card(), arrived.kind, arrived.title, arrived.lane, arrived.isNew, arrived.ask.state], [undefined, 'work', 'Fix the header', 'todo', true, 'waiting']);
  assert.deepEqual(await thread(filed), [[id, 'Fix the header', 'waiting']]);
  await putWave(JSON.stringify({ items: [{ id: 'AK2', title: 'Header', from_ask: id }] }));
  const reply = await post('/_claude/events', { kind: 'item-message', key: `ask:${id}`, text: 'Also the footer' });
  fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(site, 'data', 'threads', `ask__${id}.jsonl`), JSON.stringify({ ts: new Date(Date.now() + 60000).toISOString(), who: 'claude', text: 'Footer too.' }) + '\n');
  // A card's thread comes from the board build, which reads a write once the server is told of it
  // (docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md).
  await heard(path.join(site, 'data', 'threads', `ask__${id}.jsonl`));
  assert.deepEqual(await thread(`ask:${id}`), [[id, 'Fix the header', 'answered'], ['#selectedCard=t%2FAK2', 'Became AK2', undefined], [reply.id, 'Also the footer', 'answered'], [null, 'Footer too.', undefined]]);
  assert.deepEqual([await card(), (await board()).moved], [undefined, { [`ask:${id}`]: 't/AK2' }]);
  assert.deepEqual(await thread('t/AK2'), [[id, 'Fix the header', 'answered'], [reply.id, 'Also the footer', 'answered'], [null, 'Footer too.', undefined]]);
});

test("a Quick build ask carries quick: true to the session, and its thread holds only the ask; a card's Grill and Prototype taps read as request entries", async () => {
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { id } = await post('/_claude/events', { kind: 'ask', text: 'Add a badge', quick: true });
  const logged = fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.id === id);
  assert.deepEqual(logged.data, { text: 'Add a badge', quick: true });
  const thread = async (key) => (await (await fetch(`${base}/api/thread?key=${encodeURIComponent(key)}`)).json()).map((m) => [m.text, Boolean(m.request)]);
  const arrived = (await (await fetch(`${base}/api/board`)).json()).moved[`ask:${id}`];
  assert.deepEqual(await thread(arrived), [['Add a badge', false]]);
  // The ask arrived as a New card; Q1 stands in for the card it is sorted into.
  const filed = JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8'));
  assert.deepEqual(filed.items.filter((i) => i.from_ask === id).map((i) => i.title), ['Add a badge']);
  const wave = { ...filed, items: filed.items.filter((i) => i.from_ask !== id) };
  await putWave(JSON.stringify({ ...wave, items: [...wave.items, { id: 'Q1', title: 'Badge', from_ask: id }] }));
  const taps = [await post('/_claude/events', { kind: 'grill-more', key: 't/Q1' }), await post('/_claude/events', { kind: 'prototype-request', key: 't/Q1' })];
  assert.deepEqual((await thread('t/Q1')).filter(([, request]) => request), [['Grill requested', true], ['Prototype requested', true]]);
  const card = (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === 't/Q1');
  assert.deepEqual([card.grilling, card.prototyping], [true, true]);
  for (const e of [{ id }, ...taps]) await post('/api/hide', { id: e.id, hidden: true });
  await putWave(JSON.stringify(wave));
  fs.rmSync(path.join(site, 'data', 'agents'), { recursive: true, force: true });
});

// docs/adr/2026-11-15-0730-each-question-has-the-threads-request-row.md
test("a new task sent from its Prototype, Grill or Visual carries its request: its card owes that kind's brief with the task's text, and the ask reads the request in its footer", async () => {
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const before = fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8');
  const sent = [];
  for (const request of ['prototype', 'grill', 'visual']) {
    const { id } = await post('/_claude/events', { kind: 'ask', text: `Draw the ${request}`, request });
    sent.push(id);
    const card = JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items.find((i) => i.from_ask === id);
    const owed = card.briefs.find((b) => b.kind === request);
    assert.deepEqual([owed.tap, owed.asks ?? [owed.ask]], [true, [{ text: `Draw the ${request}` }]], request);
    const key = (await (await fetch(`${base}/api/board`)).json()).moved[`ask:${id}`];
    const shown = (await (await fetch(`${base}/api/thread?key=${encodeURIComponent(key)}`)).json()).find((m) => m.eventId === id);
    assert.deepEqual([shown.text, shown.status], [`Draw the ${request}`, { prototype: 'Prototype requested', grill: 'Grill requested', visual: 'Visual requested' }[request]]);
  }
  for (const id of sent) await post('/api/hide', { id, hidden: true });
  await putWave(before);
});

test("a work card's Hold, Resume and Done apply at once from their events, a Hold's chosen time with them", async () => {
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const work = async () => (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === 't/AK2');
  assert.deepEqual(await work().then((c) => [c.lane, c.ownerBlock, c.finishable]), ['todo', null, true]);
  const filed = () => JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items.find((i) => i.id === 'AK2');
  const said = () => fs.readFileSync(path.join(site, 'data', 'threads', 't__AK2.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((m) => m.who === 'love').map((m) => m.text);
  const keys = () => fs.readFileSync(path.join(site, 'data', 'threads', 't__AK2.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((m) => m.who === 'love').map((m) => m.command);
  await post('/_claude/events', { kind: 'card-hold', key: 't/AK2', hold: true });
  assert.deepEqual((await work()).ownerBlock, { until: null });
  assert.deepEqual([filed().held, filed().pick_up_at], [true, undefined]);
  await post('/_claude/events', { kind: 'card-hold', key: 't/AK2', hold: false });
  assert.equal((await work()).ownerBlock, null);
  const before = Date.now();
  await post('/_claude/events', { kind: 'card-hold', key: 't/AK2', hold: true, for: '3h' });
  const timed = await work();
  assert.equal(timed.blocked, true);
  assert.ok(Math.abs(Date.parse(timed.ownerBlock.until) - before - 3 * 3_600_000) < 60_000);
  const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
  await post('/_claude/events', { kind: 'card-hold', key: 't/AK2', hold: true, for: at });
  assert.equal((await work()).ownerBlock.until, at);
  assert.deepEqual([filed().held, filed().pick_up_at], [true, at]);
  await post('/_claude/events', { kind: 'card-hold', key: 't/AK2', hold: true, for: 'forever' });
  assert.deepEqual((await work()).ownerBlock, { until: null });
  const refuse = (choice) => fetch(base + '/_claude/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'card-hold', key: 't/AK2', hold: true, for: choice }) });
  for (const choice of [new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 31 * 86_400_000).toISOString(), 'soon']) assert.equal((await refuse(choice)).status, 400, choice);
  const sent = fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.kind === 'card-hold').slice(-3).map((e) => e.data);
  assert.deepEqual(sent, [{ key: 't/AK2', hold: true, until: timed.ownerBlock.until }, { key: 't/AK2', hold: true, until: at }, { key: 't/AK2', hold: true }]);
  await post('/_claude/events', { kind: 'card-hold', key: 't/AK2', hold: false });
  await post('/_claude/events', { kind: 'card-done', key: 't/AK2' });
  assert.deepEqual(await work().then((c) => [c.lane, c.finishable]), ['done', false]);
  assert.deepEqual([filed().lane, typeof filed().closed_at, filed().held], ['done', 'string', undefined]);
  const lines = said();
  // docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md: each tap's line is keyed.
  assert.deepEqual([lines.slice(0, 2), lines.slice(4)], [['Blocked', 'Unblocked'], ['Blocked', 'Unblocked', 'Marked done']]);
  assert.match(lines[2], /^Blocked until [^.]+$/);
  assert.deepEqual(keys(), ['hold', 'resume', 'hold', 'hold', 'hold', 'resume', 'done']);
});

// docs/adr/2026-11-03-0500-every-owner-tap-the-server-can-apply-draws-at-once.md
test("the events POST answers with the board as the tap left it, so a bump, unbump, Hold and Done each draw from the one round trip", async () => {
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const todo = (board) => board.items.filter((i) => i.lane === 'todo').map((i) => [i.id, Boolean(i.bumpedAt)]);
  await putWave(JSON.stringify({ items: [{ id: 'C1', title: 'One' }, { id: 'C2', title: 'Two' }] }));
  const first = await (await fetch(`${base}/api/board`)).json();
  const bottom = todo(first).at(-1)[0];
  const bumped = await post({ kind: 'card-bump', key: `t/${bottom}` });
  assert.match(bumped.id, /\S/);
  assert.deepEqual(todo(bumped.board)[0], [bottom, true]);
  assert.ok(bumped.board.generatedAt >= first.generatedAt);
  const unbumped = await post({ kind: 'card-unbump', key: `t/${bottom}`, sendId: 'unbump-1' });
  assert.deepEqual(todo(unbumped.board), todo(first));
  // docs/adr/2026-11-18-2100-a-card-tap-logs-a-sending-line-and-its-button-just-disables.md: each leaves the owner's line
  // on the card, the unbump's carrying its sendId, so the page's sending line gives way to it.
  const thread = await (await fetch(`${base}/api/thread?key=t/${bottom}`)).json();
  assert.deepEqual(thread.filter((m) => m.command).slice(-2).map((m) => [m.text, m.who, m.command, m.sendId ?? null]),
    [['Moved to the top', 'love', 'bumped', null], ['Unbumped', 'love', 'unbumped', 'unbump-1']]);
  const held = await post({ kind: 'card-hold', key: 't/C1', hold: true });
  assert.deepEqual(held.board.items.find((i) => i.id === 'C1').ownerBlock, { until: null });
  const done = await post({ kind: 'card-done', key: 't/C2' });
  assert.equal(done.board.items.find((i) => i.id === 'C2').lane, 'done');
  const said = await post({ kind: 'message', text: 'Hello' });
  assert.deepEqual(Object.keys(said).sort(), ['board', 'id']);
});

// docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md
test("a Hold or Done whose item file couldn't be written is refused with why and records no event, as is one on a card already in Done", async () => {
  const wave = path.join(site, 'data', 'items.json');
  await putWave(JSON.stringify({ items: [{ id: 'HD1', title: 'One' }] }));
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  const logged = () => (fs.existsSync(path.join(site, 'data', 'events.jsonl')) ? fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length : 0);
  const before = logged();
  // The item file as the server's own passes on the new card left it.
  const written = fs.readFileSync(wave, 'utf8');
  // The item file's write makes a temp file named for that write alone in its folder; a folder that takes no new file fails it.
  const folder = path.join(site, 'data');
  fs.chmodSync(folder, 0o555);
  try {
    for (const tap of [{ kind: 'card-hold', key: 't/HD1', hold: true }, { kind: 'card-done', key: 't/HD1' }]) {
      const [status, out] = await post(tap);
      assert.equal(status, 500, tap.kind);
      assert.match(out.error, /^Couldn’t write t\/HD1 to its item file: EACCES/, tap.kind);
    }
  } finally { fs.chmodSync(folder, 0o755); }
  assert.equal(logged(), before);
  assert.equal(fs.readFileSync(wave, 'utf8'), written);
  const landed = { id: 'HD1', title: 'One', lane: 'done', closed_at: '2026-11-01T00:00:00.000Z', prs: [{ number: 7, merged_at: '2026-11-01T00:00:00.000Z' }] };
  // A merged card waiting on its owner step closes on the owner's Done, its PR staying merged.
  await putWave(JSON.stringify({ items: [{ ...landed, owner_step: 'Tag the first release' }] }));
  const [status, out] = await post({ kind: 'card-done', key: 't/HD1' });
  assert.equal(status, 200, out.error);
  assert.equal(out.board.items.find((i) => i.id === 'HD1').lane, 'done');
  assert.deepEqual((({ lane, owner_step, prs }) => [lane, owner_step, prs[0].merged_at])(JSON.parse(fs.readFileSync(wave, 'utf8')).items[0]), ['done', undefined, landed.prs[0].merged_at]);
  await putWave(JSON.stringify({ items: [landed] }));
  const stepped = logged();
  assert.deepEqual(await post({ kind: 'card-done', key: 't/HD1' }), [400, { error: 't/HD1 is already in Done, so its item file stays as it is.' }]);
  assert.equal(logged(), stepped);
  const [held] = await post({ kind: 'card-hold', key: 't/HD1', hold: true });
  assert.equal(held, 400);
});

// docs/adr/2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md
test("a Reopen moves a Done card back to In Review with its line, records card-reopen and wakes nobody; one on a card not in Done is refused and records nothing", async () => {
  const wave = path.join(site, 'data', 'items.json');
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  const logged = () => (fs.existsSync(path.join(site, 'data', 'events.jsonl')) ? fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean) : []);
  await putWave(JSON.stringify({ items: [
    { id: 'RO1', title: 'One', lane: 'done', phase: 'merged', lane_at: '2026-11-01T00:00:00.000Z', closed_at: '2026-11-01T00:00:00.000Z' },
    { id: 'RO2', title: 'Two', lane: 'progress', lane_at: '2026-11-01T00:00:00.000Z' },
  ] }));
  const [status, out] = await post({ kind: 'card-reopen', key: 't/RO1' });
  assert.equal(status, 200, out.error);
  const card = out.board.items.find((i) => i.id === 'RO1');
  assert.deepEqual([card.lane, card.reopened], ['review', true]);
  const stored = JSON.parse(fs.readFileSync(wave, 'utf8')).items[0];
  assert.deepEqual([stored.lane, Boolean(stored.reopened_at)], ['review', true]);
  assert.equal(JSON.parse(logged().at(-1)).kind, 'card-reopen');
  const thread = fs.readFileSync(path.join(site, 'data', 'threads', 't__RO1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(thread.map((m) => m.text), ['Reopened', 'Moved to In Review: you reopened it']);
  await board.settled();
  const before = logged().length;
  for (const key of ['t/RO1', 't/RO2']) assert.deepEqual(await post({ kind: 'card-reopen', key }), [400, { error: `${key} isn’t in Done, so there is nothing to reopen.` }]);
  assert.equal(logged().length, before);
});

test("a Cancel on a staged or ready Todo card moves it back to discussing with its line, records card-cancel; one on any other card is refused and records nothing", async () => {
  const wave = path.join(site, 'data', 'items.json');
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  const logged = () => (fs.existsSync(path.join(site, 'data', 'events.jsonl')) ? fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean) : []);
  const cancelled = () => logged().map((l) => JSON.parse(l)).filter((e) => e.kind === 'card-cancel');
  await putWave(JSON.stringify({ items: [
    { id: 'CA1', title: 'One', lane: 'todo', phase: 'staging', staged_at: '2026-11-01T00:00:00.000Z', lane_at: '2026-11-01T00:00:00.000Z' },
    { id: 'CA2', title: 'Two', lane: 'todo', phase: 'ready', ready_at: '2026-11-01T00:00:00.000Z', ready_main: 'abc', lane_at: '2026-11-01T00:00:00.000Z' },
    { id: 'CA3', title: 'Three', lane: 'todo', phase: 'discussing', lane_at: '2026-11-01T00:00:00.000Z' },
  ] }));
  for (const id of ['CA1', 'CA2']) {
    const [status, out] = await post({ kind: 'card-cancel', key: `t/${id}` });
    assert.equal(status, 200, out.error);
    const card = out.board.items.find((i) => i.id === id);
    assert.deepEqual([card.lane, card.phase], ['todo', 'discussing']);
    const stored = JSON.parse(fs.readFileSync(wave, 'utf8')).items.find((i) => i.id === id);
    assert.deepEqual([stored.phase, stored.staged_at, stored.ready_at, stored.ready_main], ['discussing', undefined, undefined, undefined]);
    const thread = fs.readFileSync(path.join(site, 'data', 'threads', `t__${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(thread.some((m) => m.text === 'Cancelled Implement'));
    assert.ok(cancelled().some((e) => e.data.key === `t/${id}`));
  }
  await board.settled();
  const before = cancelled().length;
  assert.deepEqual(await post({ kind: 'card-cancel', key: 't/CA3' }), [400, { error: 't/CA3 isn’t staged or ready, so there is no Implement to cancel.' }]);
  assert.equal(cancelled().length, before);
});

// docs/adr/2026-11-22-0200-a-card-carries-board-only-tags.md
test("a Tag… pick is one events POST that writes the tag to the card's item file, a Done card's included, with its line and no event; a pick that changes nothing is refused", async () => {
  const wave = path.join(site, 'data', 'items.json');
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  const logged = () => (fs.existsSync(path.join(site, 'data', 'events.jsonl')) ? fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean) : []);
  await putWave(JSON.stringify({ items: [
    { id: 'TG1', title: 'One', lane: 'done', closed_at: '2026-11-01T00:00:00.000Z', lane_at: '2026-11-01T00:00:00.000Z' },
  ] }));
  await board.settled();
  const before = logged().length;
  const [status, out] = await post({ kind: 'card-tag', key: 't/TG1', tag: ' dark  mode ', on: true, sendId: 'tag-1' });
  assert.equal(status, 200, out.error);
  assert.deepEqual(out.board.items.find((i) => i.id === 'TG1').tags, ['dark mode']);
  assert.deepEqual(JSON.parse(fs.readFileSync(wave, 'utf8')).items.find((i) => i.id === 'TG1').tags, ['dark mode']);
  const thread = fs.readFileSync(path.join(site, 'data', 'threads', 't__TG1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(thread.some((m) => m.command === 'tagged' && m.text === 'Tagged dark mode' && m.who === 'love' && m.sendId === 'tag-1'));
  assert.equal(logged().length, before, 'a tag wakes no session');
  assert.deepEqual(await post({ kind: 'card-tag', key: 't/TG1', tag: 'Dark Mode', on: true }), [400, { error: 'TG1 already carries the tag Dark Mode, so nothing changed.' }]);
  const [off] = await post({ kind: 'card-tag', key: 't/TG1', tag: 'dark mode', on: false });
  assert.equal(off, 200);
  assert.equal('tags' in JSON.parse(fs.readFileSync(wave, 'utf8')).items.find((i) => i.id === 'TG1'), false);
});

// docs/adr/2026-11-22-1200-an-archived-tag-greys-out-and-leaves-the-picker.md
test("an Archive tap is one events POST that writes the tag to data/tags.json with no event, the board answers it, and a repeat is refused", async () => {
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  await putWave(JSON.stringify({ items: [{ id: 'TA1', title: 'One', tags: ['phone'] }] }));
  await board.settled();
  const [status, out] = await post({ kind: 'tag-archive', key: 't/TA1', tag: 'Phone', on: true });
  assert.equal(status, 200, out.error);
  assert.deepEqual(out.board.archivedTags, ['Phone']);
  assert.deepEqual(out.board.items.find((i) => i.id === 'TA1').archivedTags, ['phone']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(site, 'data', 'tags.json'), 'utf8')), { archived: ['Phone'] });
  assert.equal((await post({ kind: 'tag-archive', key: 't/TA1', tag: 'phone', on: true }))[0], 400);
  const [back, restored] = await post({ kind: 'tag-archive', key: 't/TA1', tag: 'phone', on: false });
  assert.equal(back, 200);
  assert.deepEqual(restored.board.archivedTags, []);
});

test("deleting a New card is one events POST that records ask-withdrawn and hides the ask, and its board has the card gone", async () => {
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { id } = await post({ kind: 'ask', text: 'Never mind' });
  const out = await post({ kind: 'ask-withdrawn', id });
  assert.equal(out.board.items.some((i) => i.key === `ask:${id}`), false);
  const log = fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.find((e) => e.id === out.id).data, { id });
  assert.ok(JSON.parse(fs.readFileSync(path.join(site, 'data', 'hidden.json'), 'utf8')).events.includes(id));
});

// docs/adr/2026-11-18-2330-deleting-a-new-ask-reads-deleting-on-its-own-row.md
test("an ask from the page is stored under its send id, which its card's from_ask names, so a withdrawal naming the send id drops the card; one whose build has started is refused and records nothing", async () => {
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  const items = () => JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items;
  const sendId = 'mwmk3677-cju750';
  const [, sent] = await post({ kind: 'ask', text: 'Never mind', sendId });
  assert.equal(sent.id, sendId);
  assert.equal(items().filter((i) => i.from_ask === sendId).length, 1);
  const [status, out] = await post({ kind: 'ask-withdrawn', id: sendId, sendId: 'mwmk3699-aaaaaa' });
  assert.equal(status, 200);
  assert.equal(items().some((i) => i.from_ask === sendId), false);
  assert.equal(out.board.items.some((i) => i.ask?.eventId === sendId), false);

  const [, built] = await post({ kind: 'ask', text: 'Build me', sendId: 'mwmk3700-bbbbbb' });
  const card = items().find((i) => i.from_ask === built.id);
  fs.mkdirSync(path.join(site, 'data', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(site, 'data', 'agents', `${card.id}.json`), JSON.stringify({ kind: 'claude', started: new Date().toISOString() }));
  const before = fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8');
  assert.deepEqual(await post({ kind: 'ask-withdrawn', id: built.id }), [400, { error: `A build has already started on ${card.id}. Block it to stop the build.` }]);
  assert.equal(fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8'), before);
  assert.ok(items().some((i) => i.id === card.id));
  fs.rmSync(path.join(site, 'data', 'agents', `${card.id}.json`));
  assert.equal((await post({ kind: 'ask-withdrawn', id: built.id }))[0], 200);
  assert.equal(items().some((i) => i.id === card.id), false);
});

// bin/wait-events.mjs's watcher for session on this file's board, in this process, once it has written its cursor. Its
// 2 s sleeps end only as the test takes passes: pass() ends the sleep it waits in and resolves once it waits in the
// next or has returned, and run() takes passes until it returns, → its exit code. Its session never dies, and it
// prints no link lines. → {lines: what it printed, pass(), run()}
async function watching(session) {
  const lines = [];
  let wake = null;
  let reached = null;
  let code;
  const arrive = () => { const r = reached; reached = null; r?.(); };
  const sleep = () => new Promise((resolve) => { wake = resolve; arrive(); });
  watchEvents({ route: 't', session, sleep, sessionGone: () => false, log: (line) => lines.push(line), links: () => [] })
    .then((c) => { code = c; arrive(); });
  const arrival = () => new Promise((resolve) => { reached = resolve; });
  if (!wake) await arrival();
  const pass = () => {
    const arrived = arrival();
    const w = wake;
    wake = null;
    w();
    return arrived;
  };
  return { lines, pass, run: async () => { while (code === undefined) await pass(); return code; } };
}

test('a watcher that just exited on an event still counts as listening, until its session stops', async (t) => {
  const session = spawn(process.execPath, ['-e', untilTestEnds()], { stdio: 'ignore' });
  t.after(() => session.kill());
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(session.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim();
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${session.pid}.json`), JSON.stringify({ pid: session.pid, sessionId: 's1', cwd: home, procStart, kind: 'bg' }));
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
  const cmd = [process.execPath, path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site];
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'manifest.json'), JSON.stringify({ sites: { t: { dir: site, port: 1, cmd, owner: { session: 's1' } } } }));
  fs.writeFileSync(path.join(site, 'data', 'checked.json'), JSON.stringify({ at: new Date().toISOString(), every: 30 }));
  const watcher = await watching('s1');
  await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'item-message', key: 't/A1', text: 'Wake' }) });
  assert.equal(await watcher.run(), 0);
  assert.equal(watcher.lines.filter((line) => /^new reply on \S+: inbox read t\/A1$/.test(line)).length, 1);
  await heard(path.join(site, 'data', 'watcher.json'), path.join(site, 'data', 'delivered.json'));
  const w = JSON.parse(fs.readFileSync(path.join(site, 'data', 'watcher.json'), 'utf8'));
  assert.ok(Date.parse(w.exited_at) >= Date.parse(w.since));
  assert.equal((await (await fetch(`${base}/api/board`)).json()).checks.watcher, 'running');
  const stopped = new Promise((resolve) => session.once('exit', resolve));
  session.kill();
  await stopped;
  assert.equal((await (await fetch(`${base}/api/board`)).json()).checks.watcher, 'stopped');
});

// docs/adr/2026-11-17-1500-the-board-menu-shows-how-to-join-the-orchestrator-in-a-terminal.md
test("the board carries the command that joins its orchestrator in a terminal: claude attach with the session's short id, tmux attach on the hub board, none without a session", async () => {
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  const before = fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8') : null;
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  const cmd = [process.execPath, path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site];
  const join = async (s) => {
    fs.writeFileSync(manifest, JSON.stringify({ sites: { t: { dir: site, port: 1, cmd, ...s } } }));
    return (await (await fetch(`${base}/api/board`)).json()).join;
  };
  try {
    assert.deepEqual(await join({ owner: { session: '3f9a1c7e-0b1d-4c55-9e2a-7d1f00aa1234' } }), { command: 'claude attach 3f9a1c7e', tmux: false });
    assert.deepEqual(await join({ hub: true, owner: { session: '3f9a1c7e-0b1d-4c55-9e2a-7d1f00aa1234' } }), { command: 'tmux attach -t kickflip-t', tmux: true });
    assert.equal(await join({}), null);
  } finally {
    if (before === null) fs.rmSync(manifest, { force: true }); else fs.writeFileSync(manifest, before);
  }
});

test("the board lists each agent's record on an item, and the item's thread shows when each started and finished among its lines", async () => {
  await putWave(JSON.stringify({ items: [{ id: 'A3', title: 'Three', lane: 'progress' }] }));
  const records = [path.join(site, 'data', 'agents', 'A3.json'), path.join(site, 'data', 'agents', 'A3@bench.json'), path.join(site, 'data', 'threads', 't__A3.jsonl')];
  fs.mkdirSync(path.join(site, 'data', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
  fs.writeFileSync(records[0], JSON.stringify({ label: 'Opus builder', kind: 'opus', started: '2026-10-23T10:00:00Z', done: '2026-10-23T10:30:00Z' }));
  fs.writeFileSync(records[1], JSON.stringify({ kind: 'codex', started: '2026-10-23T10:05:00Z', eta: '2026-10-23T16:30:00Z' }));
  fs.writeFileSync(records[2], [
    { ts: '2026-10-23T10:00:00Z', who: 'claude', kind: 'status', text: 'Planning' },
    { ts: '2026-10-23T10:06:00Z', who: 'claude', kind: 'status', text: 'Codex: Running benchmarks' },
    { ts: '2026-10-23T10:10:00Z', who: 'claude', text: 'Halfway.' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  await heard(...records);
  const item = (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === 't/A3');
  assert.deepEqual(item.agents.map((a) => [a.name, a.kind]), [['main', 'claude'], ['bench', 'codex']]);
  assert.deepEqual([item.waitsOn, item.builder.progress, item.eta], ['builder', 'Codex: Running benchmarks', '2026-10-23T16:30:00Z']);
  const thread = (await (await fetch(`${base}/api/thread?key=t%2FA3`)).json()).map((m) => [m.kind || m.who, m.text, m.finished ?? null, m.eta ?? null]);
  assert.deepEqual(thread, [
    ['agent', 'Claude Opus implementer started', false, null],
    ['status', 'Planning', null, null],
    ['agent', 'Codex implementer started', false, '2026-10-23T16:30:00Z'],
    ['status', 'Codex: Running benchmarks', null, null],
    ['claude', 'Halfway.', null, null],
    ['agent', 'Claude Opus implementer finished', true, null],
  ]);
});

test('hiding and unhiding many events at once keeps every change', async () => {
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const ids = (await Promise.all(Array.from({ length: 8 }, (_, i) => post('/_claude/events', { kind: 'ask', text: `Ask ${i}` })))).map((e) => e.id);
  const shown = async () => new Set((await (await fetch(`${base}/_claude/events?kind=ask&limit=500`)).json()).map((e) => e.id));
  await Promise.all(ids.map((id) => post('/api/hide', { id, hidden: true })));
  const afterHide = await shown();
  assert.deepEqual(ids.filter((id) => afterHide.has(id)), []);
  await Promise.all(ids.map((id) => post('/api/hide', { id, hidden: false })));
  const afterUndo = await shown();
  assert.deepEqual(ids.filter((id) => !afterUndo.has(id)), []);
  // Hidden again so later tests that replace the item file don't see these asks come back as New cards.
  await Promise.all(ids.map((id) => post('/api/hide', { id, hidden: true })));
});

// docs/adr/2026-11-16-2000-the-server-applies-the-owners-post-or-skip-on-a-held-review.md
test("a review-answer on a held review is applied by the server: Skip records it posted, a Post that fails leaves a review-failed, and an answer with no held review is refused", async () => {
  const eventsFile = path.join(site, 'data', 'events.jsonl');
  const reviewsFile = path.join(site, 'data', 'reviews.json');
  const pr = { number: 437, title: 'One endpoint', author: 'quinn', url: 'https://github.com/o/r/pull/437', head: 'abc', touches: [], asked: false };
  const held = { ...pr, state: 'needs', text: 'Clashes with #47.', at: '2026-11-05T09:00:00.000Z' };
  const send = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const kinds = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  try {
    fs.writeFileSync(path.join(site, 'data', 'incoming.json'), JSON.stringify({ at: 'x', repo: null, prs: [pr] }));
    fs.writeFileSync(reviewsFile, JSON.stringify({ 437: held }));
    const refused = await send({ kind: 'review-answer', pr: 438, answer: 'skip' });
    assert.deepEqual([refused.status, (await refused.json()).error], [400, 'PR #438 has no held review to answer']);
    await ok200(send({ kind: 'review-answer', pr: 437, answer: 'skip' }));
    const skipped = JSON.parse(fs.readFileSync(reviewsFile, 'utf8'))[437];
    assert.deepEqual([skipped.state, skipped.text], ['posted', 'Clashes with #47.']);
    assert.equal(kinds().some((e) => e.kind === 'review-failed'), false);

    fs.writeFileSync(reviewsFile, JSON.stringify({ 437: held }));
    await ok200(send({ kind: 'review-answer', pr: 437, answer: 'post' }));
    const failed = kinds().filter((e) => e.kind === 'review-failed').at(-1);
    assert.deepEqual([failed.data.pr, failed.data.answer, typeof failed.data.error], [437, 'post', 'string']);
    assert.equal(JSON.parse(fs.readFileSync(reviewsFile, 'utf8'))[437].state, 'needs');
    const card = (await (await fetch(`${base}/api/board`)).json()).reviews.cards.find((c) => c.number === 437);
    assert.deepEqual([card.state, card.failure], ['needs', failed.data.error]);
  } finally { fs.rmSync(reviewsFile, { force: true }); fs.rmSync(path.join(site, 'data', 'incoming.json'), { force: true }); }
});

test("the board lists its own title and reviewers from board.json, whatever its waves hold", async () => {
  const cfg = { title: 'T', items: 'data/items.json', slug: 't' };
  const board = async () => (await (await fetch(`${base}/api/board`)).json());
  const reviewers = async () => (await board()).reviewers;
  await putWave(JSON.stringify({ reviewers: [{ name: 'Bob', slack_user: 'U2', dm: 'D2', github: 'bob' }], items: [{ id: 'R1', title: 'R' }] }));
  assert.deepEqual(await reviewers(), []);
  assert.equal((await board()).title, 'T');
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, title: 'Renamed', reviewers: [{ name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' }] }));
  try {
    assert.deepEqual(await reviewers(), ['Ann']);
    assert.equal((await board()).title, 'Renamed');
  } finally {
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify(cfg));
  }
});

test("an item's notes are served only from a markdown file inside its wave's folder, else from its short notes text, and the board carries no summary", async () => {
  const outside = path.join(home, 'secret.md');
  fs.writeFileSync(outside, '# Secret');
  fs.writeFileSync(path.join(site, 'data', 'P1-plan.md'), '# The plan\n\nBody.');
  fs.symlinkSync(outside, path.join(site, 'data', 'link.md'));
  await putWave(JSON.stringify({ items: [
    { id: 'P1', title: 'Planned', plan: 'P1-plan.md', summary: 'Plan so far: X is settled.' }, { id: 'P2', title: 'Up', plan: '../secret.md' }, { id: 'P3', title: 'Abs', plan: outside },
    { id: 'P4', title: 'Link', plan: 'link.md' }, { id: 'P5', title: 'Json', plan: 'owner.json' }, { id: 'P6', title: 'None', notes: '  ' },
    { id: 'P7', title: 'Short', notes: 'Asked for X; Y is settled.' }, { id: 'P8', title: 'Both', plan: 'P1-plan.md', notes: 'Old line' },
    { id: 'P10', title: 'Bad file', plan: '../secret.md', notes: 'Old line' },
  ] }));
  const notes = (id, api = 'notes') => fetch(`${base}/api/${api}?item=t%2F${id}`);
  const ok = await notes('P1');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { key: 't/P1', ref: 'P1', title: 'Planned', markdown: '# The plan\n\nBody.' });
  assert.deepEqual(await (await notes('P1', 'plan')).json(), { key: 't/P1', ref: 'P1', title: 'Planned', markdown: '# The plan\n\nBody.' });
  assert.equal((await (await notes('P7')).json()).markdown, 'Asked for X; Y is settled.');
  assert.equal((await (await notes('P8')).json()).markdown, '# The plan\n\nBody.');
  for (const id of ['P2', 'P3', 'P4', 'P5', 'P6', 'P9', 'P10']) assert.equal((await notes(id)).status, 404, id);
  const board = await (await fetch(`${base}/api/board`)).json();
  const cards = Object.fromEntries(board.items.map((i) => [i.id, i.hasNotes]));
  assert.deepEqual([cards.P1, cards.P6, cards.P7], [true, false, true]);
  assert.equal(board.items.some((i) => 'summary' in i), false);
  assert.equal(board.items.some((i) => typeof i.notes === 'string'), false);
  const moved = await fetch(`${base}/plan.html?item=t%2FP1`, { redirect: 'manual' });
  assert.deepEqual([moved.status, moved.headers.get('location')], [302, 'notes.html?item=t%2FP1']);
});

test("the board, its Settings, its old questions.html and Notes serve the app shell, with no sidebar for shell.js to fetch, and a site's own page still renders the shared header", async () => {
  for (const p of ['/', '/settings.html', '/questions.html', '/notes.html?item=t%2FP1']) {
    const r = await fetch(base + p);
    const html = await r.text();
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /^text\/html/, p);
    assert.match(html, /<script src="\/_hub\/app\/shell\.js\?v=[^"]+"><\/script>\s*<script>AppShell\.start\(\);<\/script>/, p);
    assert.match(html, /<aside id="sidebar" class="sidebar" aria-label="Boards"><\/aside>/, p);
    assert.match(html, /<script id="sidebarData" type="application\/json">null<\/script>/, p);
    assert.doesNotMatch(html, /\{\{/, p);
  }
  const moved = await fetch(`${base}/index.html?x=1`, { redirect: 'manual' });
  assert.deepEqual([moved.status, moved.headers.get('location')], [302, './?x=1']);

  const pub = path.join(site, 'public');
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, 'prototype-hdr.html'), '<title>{{title}}</title><!--header {"lead":"back","title":"Take","backHref":"./#selectedCard=t%2FP1"}-->');
  try {
    const page = await (await fetch(`${base}/prototype-hdr.html`)).text();
    assert.match(page, /^<title>T<\/title><header class="top"><div class="brand"><a class="hub" href="[^"]*" aria-label="Boards"><img[^>]*><\/a><a class="back" href="\.\/#selectedCard=t%2FP1" aria-label="Back to the board">/);
    assert.doesNotMatch(page, /<!--header/);
  } finally { fs.rmSync(path.join(pub, 'prototype-hdr.html')); }
});

test('a recorded prototype is the one template with its record filled in, and nothing else is served from it', async () => {
  const pub = path.join(site, 'public');
  const takes = path.join(pub, 'prototypes', 'moon');
  fs.mkdirSync(takes, { recursive: true });
  fs.writeFileSync(path.join(takes, 'A.js'), 'export function render(stage) {}');
  fs.writeFileSync(path.join(pub, 'prototype-written.html'), '<p>Hand-written</p>');
  fs.writeFileSync(path.join(site, 'data', 'prototypes.json'), JSON.stringify({ prototypes: [
    { topic: 'moon', title: 'Moon </script><b>', card: 't/P1', takes: [{ key: 'A', label: 'Tap <it>' }, { key: 'B', label: 'Hover' }] },
    { topic: 'plain', title: 'Plain', takes: [{ key: 'A', label: 'Only' }] },
  ] }));
  try {
    const page = await (await fetch(`${base}/prototype-moon.html?take=A&q=q1`)).text();
    assert.match(page, /<title>Moon &lt;\/script&gt;&lt;b&gt; · prototype<\/title>/);
    assert.match(page, /<header class="top"><div class="brand"><a class="hub" href="[^"]*" aria-label="Boards"><img[^>]*><\/a><a class="back" href="\.\/#selectedCard=t%2FP1" aria-label="Back to the board">[\s\S]*<h1>Moon &lt;\/script&gt;&lt;b&gt; · prototype<\/h1>/);
    const json = /<script id="prototypeData" type="application\/json">(.*?)<\/script>/.exec(page)[1];
    assert.doesNotMatch(json, /</);
    const data = JSON.parse(json);
    assert.equal(data.title, 'Moon </script><b>');
    assert.deepEqual(data.takes.map((t) => [t.key, t.label, /^prototypes\/moon\/A\.js\?v=[\w-]+$/.test(t.src ?? ''), t.file]), [['A', 'Tap <it>', true, 'prototypes/moon/A.js'], ['B', 'Hover', false, 'prototypes/moon/B.js']]);
    assert.match(page, /<main class="proto-main"><div id="stage"><\/div><\/main>/);
    assert.match(await (await fetch(`${base}/prototype-moon.stage.html`)).text(), /#stage \{[^}]*contain: layout paint; transform: translateZ\(0\); isolation: isolate; overflow-x: clip;/);
    for (const script of ['claude.js', 'ui-page-header.js', 'ui-icon-text.js', 'ui-sidebar.js', 'ui-hub.js', 'ui-cards.js', 'prototype-switcher.js', 'prototype-kit.js']) assert.match(page, new RegExp(`<script src="${script.replace('.', '\\.')}\\?v=`), script);
    const plain = await (await fetch(`${base}/prototype-plain.html`)).text();
    assert.match(plain, /<a class="back" href="\.\/" aria-label="Back to the board">/);
    assert.match(await (await fetch(`${base}/prototype-written.html`)).text(), /^<p>Hand-written<\/p><script>/);
    for (const p of ['/prototype-missing.html', '/prototype.html']) assert.equal((await fetch(base + p)).status, 404, p);
  } finally {
    fs.rmSync(path.join(site, 'data', 'prototypes.json'));
    fs.rmSync(path.join(pub, 'prototypes'), { recursive: true });
    fs.rmSync(path.join(pub, 'prototype-written.html'));
  }
});

const raw = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get(base + p, { headers }, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

// docs/adr/2026-11-18-0523-previews-run-in-a-sandboxed-opaque-origin.md
test("a take-file round's stage and every file of the site's own public/ come sandboxed; the viewer and the board's own files don't", async () => {
  const pub = path.join(site, 'public');
  fs.mkdirSync(path.join(pub, 'prototypes', 'moon'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'prototypes', 'moon', 'A.js'), 'export function render(stage) {}');
  fs.mkdirSync(path.join(pub, 'visuals', 'P1'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'visuals', 'P1', 'look.html'), '<title>Look</title><body><a href="#x">x</a></body>');
  fs.writeFileSync(path.join(pub, 'shape.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
  fs.writeFileSync(path.join(site, 'data', 'prototypes.json'), JSON.stringify({ prototypes: [
    { topic: 'moon', title: 'Moon', takes: [{ key: 'A', label: 'Light' }] },
    { topic: 'live', title: 'Live', served: '/proto/live', takes: [{ key: 'A', label: 'One' }] },
  ] }));
  const csp = (r) => r.headers['content-security-policy'];
  try {
    const stage = await raw('/prototype-moon.stage.html');
    assert.equal(stage.status, 200);
    assert.equal(csp(stage), 'sandbox allow-scripts');
    const json = /<script id="prototypeData" type="application\/json">(.*?)<\/script>/.exec(stage.body.toString())[1];
    assert.deepEqual(JSON.parse(json).takes.map((t) => [t.key, /^prototypes\/moon\/A\.js\?v=/.test(t.src)]), [['A', true]]);
    assert.match(stage.body.toString(), /PrototypeKit\.stage\(/);
    const viewer = await raw('/prototype-moon.html');
    assert.equal(csp(viewer), undefined);
    assert.match(viewer.body.toString(), /PrototypeKit\.start\(/);
    const take = await raw('/prototypes/moon/A.js');
    assert.equal(csp(take), 'sandbox allow-scripts');
    assert.equal(take.headers['access-control-allow-origin'], 'null');
    const visual = await raw('/visuals/P1/look.html');
    assert.equal(csp(visual), 'sandbox allow-scripts');
    assert.match(visual.body.toString(), /<a href="#x">x<\/a><script>[\s\S]*kickflip: 'page-link'[\s\S]*<\/script><\/body>/);
    assert.equal(csp(await raw('/shape.svg')), 'sandbox allow-scripts');
    for (const p of ['/app.js', '/style.css', '/prototype-switcher.js']) {
      const own = await raw(p);
      assert.deepEqual([own.status, csp(own), own.headers['access-control-allow-origin']], [200, undefined, undefined], p);
    }
    for (const p of ['/prototype-live.stage.html', '/prototype-stage.html', '/prototype-gone.stage.html']) assert.equal((await raw(p)).status, 404, p);
  } finally {
    fs.rmSync(path.join(site, 'data', 'prototypes.json'));
    for (const p of ['prototypes', 'visuals', 'shape.svg']) fs.rmSync(path.join(pub, p), { recursive: true });
  }
});

test("a site's public/ file named like a board script never replaces it, and a site-only file is still served", async () => {
  const pub = path.join(site, 'public');
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, 'app.js'), 'SHADOW-MARKER');
  fs.writeFileSync(path.join(pub, 'claude.js'), 'SHADOW-MARKER');
  fs.writeFileSync(path.join(pub, 'only-here.html'), '<title>Only</title>');
  try {
    for (const p of ['/app.js', '/claude.js']) assert.ok(!(await raw(p)).body.toString().includes('SHADOW-MARKER'), p);
    assert.match((await raw('/only-here.html')).body.toString(), /Only/);
  } finally {
    for (const f of ['app.js', 'claude.js', 'only-here.html']) fs.rmSync(path.join(pub, f));
  }
});

test('the board, a thread and the static files come gzipped when the browser accepts it, and the API stays uncached', async () => {
  await putWave(JSON.stringify({ items: Array.from({ length: 30 }, (_, n) => ({ id: `G${n}`, title: `Gzip task `, lane: 'todo' })) }));
  fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(site, 'data', 'threads', 't__G1.jsonl'), Array.from({ length: 20 }, (_, n) => JSON.stringify({ ts: '2026-10-23T10:00:00Z', who: 'claude', text: `Line ${n} of a long thread` })).join('\n') + '\n');
  await heard(path.join(site, 'data', 'threads', 't__G1.jsonl'));
  assert.ok((await (await fetch(`${base}/api/board`)).json()).items.some((i) => i.key === 't/G29'), 'the board serves the new wave');
  for (const p of ['/api/board', '/api/thread?key=t%2FG1', '/app.js', '/style.css', '/']) {
    const plainRes = await raw(p, { 'accept-encoding': 'identity' });
    const zipped = await raw(p, { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(plainRes.headers['content-encoding'], undefined, p);
    assert.equal(zipped.headers['content-encoding'], 'gzip', p);
    assert.match(zipped.headers.vary || '', /accept-encoding/i, p);
    assert.ok(zipped.body.length < plainRes.body.length, p);
    if (!p.startsWith('/api/')) continue;
    const { generatedAt: _a, ...unzipped } = JSON.parse(zlib.gunzipSync(zipped.body));
    const { generatedAt: _b, ...unpacked } = JSON.parse(plainRes.body);
    assert.deepEqual(unzipped, unpacked, p);
    assert.equal(zipped.headers['cache-control'], 'no-store', p);
  }
});

test('the stream sends a change, uncompressed, for each write to a thread or a wave file the server hears', async () => {
  const req = http.get(`${base}/api/stream`, { headers: { 'accept-encoding': 'gzip' } });
  const res = await new Promise((resolve, reject) => req.once('response', resolve).once('error', reject));
  try {
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/event-stream/);
    assert.equal(res.headers['content-encoding'], undefined);
    res.setEncoding('utf8');
    let text = '';
    res.on('data', (c) => { text += c; });
    const changes = () => text.split('\n\n').filter((block) => /^event: change$/m.test(block)).length;
    // Resolves once the stream has sent more than seen changes, reading each chunk as it arrives.
    const sent = async (seen) => { while (changes() <= seen) await once(res, 'data'); };
    while (!text.includes('retry: 3000\n\n')) await once(res, 'data');
    fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
    const thread = path.join(site, 'data', 'threads', 't__S1.jsonl');
    for (const write of [
      () => { fs.appendFileSync(thread, JSON.stringify({ ts: new Date().toISOString(), who: 'claude', text: 'Live' }) + '\n'); return heard(thread); },
      () => putWave(JSON.stringify({ items: [{ id: 'S1', title: 'Streamed' }] })),
    ]) {
      const signal = sent(changes());
      await write();
      await signal;
    }
  } finally { req.destroy(); }
});

test('the shell links the shared colors.css, versioned, before style.css, and the board serves it', async () => {
  const html = (await raw('/')).body.toString();
  const colors = html.search(/href="\/_hub\/colors\.css\?v=/);
  assert.ok(colors >= 0 && colors < html.search(/href="\/_hub\/app\/style\.css\?v=/));
  const v = /href="\/_hub\/colors\.css\?v=([^"]+)"/.exec(html)[1];
  const css = await raw(`/colors.css?v=${v}`, { 'accept-encoding': 'identity' });
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /^text\/css/);
  assert.match(css.headers['cache-control'], /immutable/);
  assert.equal(css.body.toString(), fs.readFileSync(new URL('../shared/colors.css', import.meta.url), 'utf8'));
});

test('a page asks for each script and stylesheet by a version that changes with the file, which caches for good, and an unversioned file revalidates', async () => {
  const pub = path.join(site, 'public');
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, 'zz.js'), 'one();');
  fs.writeFileSync(path.join(pub, 'zz.html'), '<link rel="stylesheet" href="style.css"><script src="zz.js"></script><script src="/root.js"></script><a href="questions.html">q</a>');
  const versions = async () => Object.fromEntries([...(await raw('/zz.html')).body.toString().matchAll(/(?:src|href)="([^"?]+)\?v=([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const first = await versions();
  assert.deepEqual(Object.keys(first).sort(), ['style.css', 'zz.js']);
  const pinned = await raw(`/zz.js?v=${first['zz.js']}`);
  assert.match(pinned.headers['cache-control'], /max-age=31536000/);
  assert.match(pinned.headers['cache-control'], /immutable/);
  const bare = await raw('/zz.js');
  assert.equal(bare.headers['cache-control'], 'no-cache');
  assert.equal((await raw('/zz.js', { 'if-none-match': bare.headers.etag })).status, 304);
  const page = await raw('/zz.html');
  assert.equal(page.headers['cache-control'], 'no-cache');
  assert.equal((await raw('/zz.html', { 'if-none-match': page.headers.etag })).status, 304);
  fs.writeFileSync(path.join(pub, 'zz.js'), 'two(); two();');
  const second = await versions();
  assert.notEqual(second['zz.js'], first['zz.js']);
  assert.equal(second['style.css'], first['style.css']);
  assert.equal((await raw('/zz.js', { 'if-none-match': bare.headers.etag })).status, 200);
  assert.equal((await raw('/zz.html', { 'if-none-match': page.headers.etag })).status, 200);
  assert.notEqual((await raw(`/zz.js?v=${first['zz.js']}`)).headers['cache-control'], pinned.headers['cache-control']);
});

test("the settings page's rules save writes board.json, keeps its other keys and rules added since the page loaded, and wakes Claude with what changed", async () => {
  const cfg = { title: 'T', items: 'data/items.json', slug: 't' };
  const web = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'settings.json'), JSON.stringify({ rules: [{ id: 'h1', text: 'Hub rule', by: 'owner', at: '2026-10-24T00:00:00Z' }] }));
  const kept = { id: 'r1', text: 'Ask first', by: 'claude', at: '2026-10-24T00:00:00Z' };
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, reviewers: [{ name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' }], rules: [kept] }));
  const save = (body) => fetch(`${base}/api/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const rulesEvents = async () => (await (await fetch(`${base}/_claude/events?kind=rules`)).json()).map((e) => e.data);
  try {
    const loaded = await (await fetch(`${base}/api/rules`)).json();
    assert.deepEqual([loaded.board, loaded.hub.map((r) => r.text)], [[kept], ['Hub rule']]);

    const r = await save({ rules: [{ id: 'r1', text: 'Ask first' }, { text: 'Screenshots  in every PR' }], base: ['r1'] });
    await ok200(r);
    const out = await r.json();
    assert.match(out.id, /^e/);
    assert.deepEqual(out.rules.map((x) => [x.text, x.by]), [['Ask first', 'claude'], ['Screenshots in every PR', 'owner']]);
    const written = JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8'));
    assert.deepEqual([written.title, written.reviewers.length, written.rules], ['T', 1, out.rules]);
    assert.deepEqual((await rulesEvents())[0], { scope: 'board', added: ['Screenshots in every PR'], edited: [], removed: [] });

    const later = { id: 'r9', text: 'Added by the CLI meanwhile', by: 'claude', at: '2026-10-24T01:00:00Z' };
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...written, rules: [...written.rules, later] }));
    const second = await (await save({ rules: [{ id: out.rules[1].id, text: 'Screenshots in each PR' }], base: out.rules.map((x) => x.id) })).json();
    assert.deepEqual(second.rules.map((x) => x.text), ['Screenshots in each PR', 'Added by the CLI meanwhile']);
    assert.deepEqual((await rulesEvents())[0], { scope: 'board', added: [], edited: [{ from: 'Screenshots in every PR', to: 'Screenshots in each PR' }], removed: ['Ask first'] });

    const before = (await rulesEvents()).length;
    const same = await (await save({ rules: second.rules.map(({ id, text }) => ({ id, text })), base: second.rules.map((x) => x.id) })).json();
    assert.equal(same.id, null);
    for (const bad of [{ rules: 'x' }, { rules: [{ text: '' }] }, { rules: [{ id: 'r1', text: 'x', by: 'claude' }] }]) assert.equal((await save(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await rulesEvents()).length, before);
  } finally {
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify(cfg));
    fs.rmSync(path.join(web, 'settings.json'), { force: true });
  }
});

test("the settings page's auto-merge toggle writes board.json, keeping its other keys, wakes Claude only when the value moves, and asks for one GitHub check when it turns on", async () => {
  const cfg = { title: 'T', items: 'data/items.json', slug: 't' };
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, rules: [{ id: 'r1', text: 'Ask first', by: 'owner', at: 'x' }] }));
  const save = (body) => fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const settingsEvents = async () => (await (await fetch(`${base}/_claude/events?kind=settings`)).json()).map((e) => e.data);
  const checks = async () => (await (await fetch(`${base}/_claude/events?kind=check-github`)).json()).map((e) => e.data);
  const before = (await checks()).length;
  try {
    const offs = { auto_build: false, auto_review: false, auto_merge: false, idle_notification: false };
    assert.deepEqual(await (await fetch(`${base}/api/settings`)).json(), { settings: { auto_merge: false, auto_build: false, auto_review: false, idle_notification: false, skip_draft: false, prs: true },
      overrides: {}, defaults: offs, paused_until: null, pause_choices: [['1h', '1h', 3600_000], ['3h', '3h', 3 * 3600_000], ['6h', '6h', 6 * 3600_000], ['1d', '1d', 86400_000], ['forever', 'Forever', null]].map(([value, label, ms]) => ({ value, label, ms })) });
    assert.deepEqual((await (await fetch(`${base}/api/settings`)).json()).pause_choices, (await (await fetch(`${base}/api/board`)).json()).holdChoices, "Pause board's chips are the Hold sheet's");
    const on = await save({ auto_merge: true });
    assert.equal(on.status, 200);
    const out = await on.json();
    assert.deepEqual(out.settings, { auto_merge: true, auto_build: false, auto_review: false, idle_notification: false, skip_draft: false, prs: true });
    assert.deepEqual([out.overrides, out.defaults], [{ auto_merge: true }, offs]);
    assert.match(out.id, /^e/);
    const written = JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8'));
    assert.deepEqual([written.title, written.rules.length, written.auto_merge], ['T', 1, true]);
    assert.deepEqual(await settingsEvents(), [{ auto_merge: true }]);
    assert.deepEqual((await checks()).slice(before), [{ reason: 'auto-merge' }]);
    await ok200(save({ auto_build: true }));
    assert.equal((await (await fetch(`${base}/api/settings`)).json()).settings.auto_build, true);
    assert.deepEqual((await settingsEvents())[0], { auto_build: true });
    assert.equal((await (await save({ auto_merge: true })).json()).id, null);
    for (const bad of [{ auto_merge: 'yes' }, { auto_build: 'yes' }, { auto_deploy: true }, {}, ['x']]) assert.equal((await save(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await settingsEvents()).length, 2);
    await ok200(save({ auto_merge: false }));
    assert.equal((await checks()).length, before + 1);
    await ok200(save({ auto_merge: true }));
    assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8')).auto_merge, true);
    // docs/adr/2026-11-22-0130-the-auto-settings-are-hub-defaults-a-board-can-override.md: null drops the override, so
    // the board takes the hub's Board default, off here.
    const cleared = await (await save({ auto_merge: null })).json();
    assert.deepEqual([cleared.settings.auto_merge, cleared.overrides, 'auto_merge' in JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8'))], [false, { auto_build: true }, false]);
    assert.equal((await save({ skip_draft: null })).status, 400, 'only a Board default clears');
    // docs/adr/2026-11-04-1913-a-board-can-skip-the-draft.md
    assert.deepEqual(await (await save({ skip_draft: true })).json().then((b) => [b.settings.skip_draft, Boolean(b.id)]), [true, true]);
    assert.deepEqual((await settingsEvents())[0], { skip_draft: true });
    assert.equal((await save({ skip_draft: 'yes' })).status, 400);
  } finally {
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify(cfg));
  }
});

// docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
test('Pause board saves its end in board.json with no settings event, reads back on the settings page, takes forever and clears with off', async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8'));
  const pause = (body) => fetch(`${base}/api/pause`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const settingsEvents = async () => (await (await fetch(`${base}/_claude/events?kind=settings`)).json()).length;
  const events = await settingsEvents();
  try {
    const on = await pause({ pause: '1h' });
    assert.equal(on.status, 200);
    const { paused_until } = await on.json();
    assert.ok(Math.abs(Date.parse(paused_until) - Date.now() - 3600_000) < 60_000);
    assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8')).paused_until, paused_until);
    assert.equal((await (await fetch(`${base}/api/settings`)).json()).paused_until, paused_until);
    assert.equal(await settingsEvents(), events, 'no settings event');
    for (const bad of [{ pause: '45d' }, { pause: 1 }, { pause: '1h', more: 1 }, {}]) assert.equal((await pause(bad)).status, 400, JSON.stringify(bad));
    assert.deepEqual(await (await pause({ pause: 'forever' })).json(), { paused_until: 'forever' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8')).paused_until, 'forever');
    assert.equal((await (await fetch(`${base}/api/settings`)).json()).paused_until, 'forever');
    const resumed = async () => (await (await fetch(`${base}/_claude/events?kind=usage-resumed`)).json()).filter((e) => e.data?.window === 'manual').length;
    const before = await resumed();
    assert.deepEqual(await (await pause({ pause: 'off' })).json(), { paused_until: null });
    assert.equal('paused_until' in JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8')), false);
    await heard(path.join(site, 'board.json'));
    assert.equal(await resumed(), before + 1, "the lift wakes the board's session");
  } finally {
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify(cfg));
  }
});

test('try forwards only the board route and key over loopback, returning hub starts and refusals', async (t) => {
  const seen = [];
  let refuse = false;
  const hub = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push([req.url, JSON.parse(body), req.headers]);
    res.writeHead(refuse ? 409 : 202, { 'content-type': 'application/json' });
    res.end(JSON.stringify(refuse ? { error: 'Already running' } : { status: 'started' }));
  });
  await new Promise((resolve, reject) => hub.once('error', reject).listen(0, '127.0.0.1', resolve));
  // A second board server on the site, under its own route, that reaches the hub at KICKFLIP_HUB_PORT.
  process.env.KICKFLIP_HUB_PORT = String(hub.address().port);
  t.after(() => { delete process.env.KICKFLIP_HUB_PORT; });
  const boardPort = (await startBoard(t, { site, prefix: '/own-route' })).server.address().port;
  try {
    const post = (body) => fetch(`http://127.0.0.1:${boardPort}/api/try`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-host': 'mac.example' }, body: JSON.stringify(body) });
    // docs/adr/2026-11-18-2100-a-card-tap-logs-a-sending-line-and-its-button-just-disables.md: a card's Serve or Kill the
    // hub took leaves the owner's line on the card; a refusal, main's and the prototypes' leave none.
    const threadFile = path.join(site, 'data', 'threads', 't__A1.jsonl');
    const tapLines = () => (fs.existsSync(threadFile) ? fs.readFileSync(threadFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
      .filter((m) => ['served', 'killed'].includes(m.command)).map((m) => [m.text, m.who]);
    const linesBefore = tapLines().length;
    assert.equal((await post({ key: 't/A1' })).status, 202);
    assert.deepEqual(tapLines().slice(linesBefore), [['Serve started', 'love']]);
    assert.deepEqual(seen[0].slice(0, 2), ['/_hub/build', { route: 'own-route', key: 't/A1' }]);
    assert.equal(seen[0][2]['x-forwarded-host'], undefined);
    assert.equal((await post({ key: 'main' })).status, 202);
    assert.deepEqual(seen[1].slice(0, 2), ['/_hub/build', { route: 'own-route', key: 'main' }]);
    fs.mkdirSync(path.join(site, 'data/try'), { recursive: true });
    // docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md: the served viewer's poll.
    const baseURL = `http://127.0.0.1:${boardPort}/api/try/prototypes`;
    const none = { step: null, stepAt: null, steps: [], last: null, error: null };
    assert.deepEqual(await (await fetch(baseURL)).json(), { state: null, https: null, since: null, lines: [], ...none });
    const tryFile = path.join(site, 'data/try.json');
    const tryBefore = fs.existsSync(tryFile) ? fs.readFileSync(tryFile, 'utf8') : null;
    fs.writeFileSync(tryFile, JSON.stringify({ kind: 'web', cards: {}, prototypes: { state: 'ready', port: 40001, https: 8503, since: '2026-11-07T20:00:00.000Z' } }));
    assert.deepEqual(await (await fetch(baseURL)).json(), { state: 'ready', https: 8503, since: '2026-11-07T20:00:00.000Z', lines: [], ...none });
    // docs/adr/2026-11-14-1446-a-prototype-pages-landing-shows-its-sites-start-steps.md: a running serve's step, its
    // finished steps' times and the log's last non-empty line, without its colour codes or a progress line's overwritten part.
    const steps = [{ name: 'building', ms: 4000 }];
    fs.writeFileSync(tryFile, JSON.stringify({ kind: 'web', cards: {}, prototypes: { state: 'running', step: 'starting', stepAt: '2026-11-07T20:00:04.000Z', steps } }));
    fs.writeFileSync(path.join(site, 'data/try/prototypes.log'), 'vite v5\n\x1b[32m✓\x1b[0m 12 modules\rtransforming (412) src/a.ts\x1b[K\n\n');
    assert.deepEqual(await (await fetch(baseURL)).json(), { state: 'running', https: null, since: null, lines: [], step: 'starting', stepAt: '2026-11-07T20:00:04.000Z', steps, last: 'transforming (412) src/a.ts', error: null });
    fs.writeFileSync(tryFile, JSON.stringify({ kind: 'web', cards: {}, prototypes: { state: 'failed', step: 'starting', stepAt: '2026-11-07T20:00:04.000Z', steps, error: 'Nothing answered.' } }));
    fs.writeFileSync(path.join(site, 'data/try/prototypes.log'), 'npm ERR! missing\nexit 1\n');
    assert.deepEqual(await (await fetch(baseURL)).json(), { state: 'failed', https: null, since: null, lines: ['npm ERR! missing', 'exit 1'], step: 'starting', stepAt: '2026-11-07T20:00:04.000Z', steps, last: null, error: 'Nothing answered.' });
    if (tryBefore === null) fs.rmSync(tryFile); else fs.writeFileSync(tryFile, tryBefore);
    assert.equal((await post({ key: 'prototypes' })).status, 202);
    assert.deepEqual(seen.at(-1).slice(0, 2), ['/_hub/build', { route: 'own-route', key: 'prototypes' }]);
    refuse = true;
    const refusal = await post({ key: 't/A1' });
    assert.equal(refusal.status, 409);
    assert.deepEqual(await refusal.json(), { error: 'Already running' });
    for (const body of [{ route: 'other', key: 't/A1' }, {}, []]) assert.equal((await post(body)).status, 400);
    const pull = (body) => fetch(`http://127.0.0.1:${boardPort}/api/try/main/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const pulled = await pull({});
    assert.equal(pulled.status, 409);
    assert.deepEqual(seen.at(-1).slice(0, 2), ['/_hub/pull', { route: 'own-route' }]);
    assert.equal((await pull({ route: 'other' })).status, 400);
    refuse = false;
    assert.equal((await post({ key: 't/A1', anyway: true })).status, 202);
    assert.deepEqual(seen.at(-1).slice(0, 2), ['/_hub/build', { route: 'own-route', key: 't/A1', anyway: true }]);
    assert.equal((await post({ key: 't/A1', anyway: 'yes' })).status, 400);
    const kill = (body) => fetch(`http://127.0.0.1:${boardPort}/api/try/kill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await kill({ key: 't/A1' })).status, 202);
    assert.deepEqual(seen.at(-1).slice(0, 2), ['/_hub/kill', { route: 'own-route', key: 't/A1' }]);
    for (const body of [{ key: 't/A1', anyway: true }, {}, { key: 'main' }]) assert.equal((await kill(body)).status, 400);
    assert.deepEqual(tapLines().slice(linesBefore), [['Serve started', 'love'], ['Serve started', 'love'], ['Serve killed', 'love']]);
  } finally {
    await new Promise((resolve) => { hub.closeAllConnections(); hub.close(resolve); });
  }
});

// The try and main mapping is domain.test.mjs's; this checks the server feeds it board.json, try.json and main.json.
test('the board snapshot reads try.json, main.json and the auto_build setting', async () => {
  const config = path.join(site, 'board.json');
  const previous = fs.readFileSync(config, 'utf8');
  try {
    fs.writeFileSync(config, JSON.stringify({ title: 'T', items: 'data/items.json', slug: 't', auto_build: true }));
    await putWave(JSON.stringify({ items: [{ id: 'A1', title: 'One' }] }));
    fs.writeFileSync(path.join(site, 'data/try.json'), JSON.stringify({ kind: 'app', main: { sha: 'abcdef123', branch: 'main', slug: 'o/r', at: '2026-11-01', script: true, state: 'ready' }, cards: { 't/A1': { head: 'abc123456', sha: 'abc1234', state: 'running', ahead: 1, script: true } } }));
    fs.writeFileSync(path.join(site, 'data/main.json'), JSON.stringify({ install: { url: 'https://example.com/main.apk' } }));
    await heard(config, path.join(site, 'data/try.json'), path.join(site, 'data/main.json'));
    const served = await (await fetch(`${base}/api/board`)).json();
    assert.deepEqual([served.main.url, served.main.sha], ['https://example.com/main.apk', 'abcdef1']);
    assert.deepEqual(served.items.find((i) => i.key === 't/A1').try, { kind: 'app', state: 'running', stale: false, url: null, port: null, sha: null, changes: true, script: true, autoBuild: true, hostBusy: false });
  } finally {
    fs.writeFileSync(config, previous);
    fs.rmSync(path.join(site, 'data/try.json'), { force: true });
    fs.rmSync(path.join(site, 'data/main.json'), { force: true });
    await heard(config, path.join(site, 'data/try.json'), path.join(site, 'data/main.json'));
  }
});

test('the watcher prints the hub rules, then the board rules, the board settings and the quiet line, after each event line and its plain line or signal, and answers a hub ping', async () => {
  const cfg = { title: 'T', items: 'data/items.json', slug: 't' };
  const web = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'manifest.json'), JSON.stringify({ sites: { t: { dir: site } } }));
  fs.writeFileSync(path.join(web, 'settings.json'), JSON.stringify({ polling: {}, rules: [{ id: 'h1', text: 'Screenshots in every PR', by: 'owner', at: 'x' }] }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, rules: [{ id: 'b1', text: 'Ask before\ntouching main', by: 'claude', at: 'x' }, { text: 'no id' }] }));
  // Each wake says something new: an exact repeat inside 30 seconds is skipped and would wake nothing.
  let wakes = 0;
  const ask = () => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'item-message', key: 't/A1', text: `Wake ${++wakes}` }) });
  const watch = async (session, wake = ask) => {
    const watcher = await watching(session);
    await wake(watcher);
    assert.equal(await watcher.run(), 0);
    return watcher.lines;
  };
  try {
    const lines = await watch('rules1');
    // docs/adr/2026-11-18-1300-requests-arrive-as-a-signal-and-inbox-read-hands-over-the-words.md: the owner's message
    // is signalled, and inbox read hands it over and marks it working.
    assert.equal(lines[0], 'new reply on A1: inbox read t/A1');
    const asked = fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).findLast((e) => e.kind === 'item-message').id;
    const read = await readInbox(site, 't/A1');
    assert.ok(read.lines.some((l) => l.startsWith(`event data/events.jsonl {"id":"${asked}"`)), read.lines.join('\n'));
    assert.ok(Date.parse(JSON.parse(fs.readFileSync(path.join(site, 'data', 'working.json'), 'utf8')).events[asked]));
    // The read marks it working from outside the server, which sees the mark once it hears the write.
    await heard(path.join(site, 'data', 'working.json'));
    const workingOn = async () => (await (await fetch(`${base}/api/working`)).json()).working.filter((w) => w.id === asked).map(({ since, ...w }) => w);
    assert.deepEqual(await workingOn(), [{ id: asked, kind: 'item-message', card: 'A1' }]);
    assert.match(lines.at(-1), /^quiet .*AskUserQuestion/);
    assert.deepEqual(lines.slice(-9, -1), ['rule hub Screenshots in every PR', 'rule board Ask before touching main', 'setting auto-merge off', 'setting auto-build off', 'setting auto-review off', 'setting idle-notification off', 'setting skip-draft off', 'setting prs on']);
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, auto_merge: true }));
    fs.rmSync(path.join(web, 'settings.json'));
    assert.deepEqual((await watch('rules2')).slice(-7, -1), ['setting auto-merge on', 'setting auto-build off', 'setting auto-review off', 'setting idle-notification off', 'setting skip-draft off', 'setting prs on']);
    const ping = () => fs.appendFileSync(path.join(site, 'data', 'events.jsonl'), JSON.stringify({ id: 'ping1', ts: new Date().toISOString(), kind: 'ping', data: { title: 'T' } }) + '\n');
    // A ping is record-only: the watcher acks it on its next pass and keeps running, and its line prints ahead of the
    // next event's lines.
    const pingThenAsk = async (watcher) => {
      ping();
      await watcher.pass();
      assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'data', 'handshake.json'), 'utf8')).ack.id, 'ping1', 'the watcher acks the ping');
      await ask();
    };
    const pinged = await watch('ping', pingThenAsk);
    assert.match(pinged[0], /^event data\/events\.jsonl .*"id":"ping1"/);
    assert.equal(pinged[1], 'ping ping1 from the hub answered');
    assert.equal(pinged[2], 'new reply on A1: inbox read t/A1');
    // docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md
    const triage = () => fs.appendFileSync(path.join(site, 'data', 'events.jsonl'), JSON.stringify({ id: 'tt1', ts: new Date().toISOString(), kind: 'overnight-triage', data: { date: '2026-11-03', topic: 'overnight-triage-2026-11-03', cards: ['w/A1', 'w/A2'] } }) + '\n');
    assert.equal((await watch('triage', triage))[1], 'Overnight triage 2026-11-03 asks Claude to reply: 2 tasks wait on open questions; run the triage, then board.mjs reply tt1');
    assert.ok(Date.parse(JSON.parse(fs.readFileSync(path.join(site, 'data', 'working.json'), 'utf8')).events.tt1));
  } finally {
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify(cfg));
    fs.rmSync(path.join(web, 'settings.json'), { force: true });
  }
});

test('a reply written after an event\'s Working mark clears it for /api/working and the card, even when its change signal never arrived', async () => {
  const at = new Date().toISOString();
  await putWave(JSON.stringify({ internal: true, items: [{ id: 'R1', title: 'Reply', lane: 'progress' }] }));
  const sent = await (await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'item-message', key: 't/R1', text: 'Question' }) })).json();
  const triage = 'tt-reply';
  fs.appendFileSync(path.join(site, 'data', 'events.jsonl'), JSON.stringify({ id: triage, ts: at, kind: 'overnight-triage', data: { date: '2026-11-03', topic: 'x', cards: [] } }) + '\n');
  fs.writeFileSync(path.join(site, 'data', 'working.json'), JSON.stringify({ events: { [sent.id]: at, [triage]: at } }));
  await heard(path.join(site, 'data', 'events.jsonl'), path.join(site, 'data', 'working.json'));
  const ids = async () => (await (await fetch(`${base}/api/working`)).json()).working.map((w) => w.id);
  assert.deepEqual((await ids()).sort(), [sent.id, triage].sort());
  for (const id of [sent.id, triage]) {
    const f = path.join(site, 'data', 'replies', `${id}.md`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'Answered');
    fs.utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  }
  // No change signal came with the writes (a lost POST from the writing process): the reply folder's own stamp moved.
  assert.deepEqual(await ids(), []);
  const card = (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.id === 'R1');
  assert.equal(card.working, false);
});

// docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md
test("a message in a stalled card's thread clears the orchestrator's stall, and reaches the orchestrator like any message", async () => {
  const at = new Date().toISOString();
  await putWave(JSON.stringify({ internal: true, items: [{ id: 'X1', title: 'Stuck', lane: 'progress', stalled: { reason: 'Crashed twice', at } }] }));
  const card = async () => (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.id === 'X1');
  assert.deepEqual([(await card()).stalled, (await card()).action?.kind], ['Crashed twice', 'stalled']);
  const r = await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'item-message', key: 't/X1', text: 'Try the other test runner' }) });
  await ok200(r);
  const { id } = await r.json();
  assert.ok(id, 'the message is an event the orchestrator wakes on');
  assert.equal('stalled' in JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items[0], false);
  assert.deepEqual([(await card()).stalled, (await card()).action], [null, null]);
});

// docs/adr/2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping.md
test('the board serves no wave bands or wave notes, even from an item file that still holds a waves record', async () => {
  await putWave(JSON.stringify({ internal: true, items: [{ id: 'S1', title: 'One' }, { id: 'S2', title: 'Two', deps: ['S1'] }],
    waves: [{ slug: 'mon', title: 'Monitor', goal: 'Runs in kickflip.', items: ['S1', 'S2'] }] }));
  const snap = await (await fetch(`${base}/api/board`)).json();
  assert.equal('waveBands' in snap, false);
  assert.deepEqual(snap.items.filter((i) => i.kind === 'work').map((i) => ['wave' in i, 'fileLabel' in i, 'fileTitle' in i]), [[false, false, false], [false, false, false]]);
  assert.equal((await fetch(`${base}/api/notes?wave=mon`)).status, 404);
});

test("a later reply to an event is its own entry: the event lists every reply oldest first, and reply is the newest", async () => {
  const { id } = await (await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'note', text: 'hi' }) })).json();
  const put = (name, text, ms) => { const f = path.join(site, 'data', 'replies', name); fs.writeFileSync(f, text); fs.utimesSync(f, new Date(ms), new Date(ms)); };
  put(`${id}.html`, '<p>one</p>', Date.now() - 3000);
  put(`${id}~2.md`, 'two', Date.now() - 2000);
  put(`${id}~10.md`, 'three', Date.now() - 1000);
  const event = (await (await fetch(`${base}/_claude/events?kind=note`)).json()).find((e) => e.id === id);
  assert.deepEqual(event.replies.map((r) => r.html || r.md), ['<p>one</p>', 'two', 'three']);
  assert.equal(event.reply.md, 'three');
});

test("/api/board names a card's worktree while its folder exists, and says whether the request's browser runs on the host", async () => {
  const waveFile = path.join(site, 'data', 'items.json');
  const agents = path.join(site, 'data', 'agents');
  const kept = path.join(home, 'worktrees', 'V1');
  const saved = fs.readFileSync(waveFile, 'utf8');
  fs.mkdirSync(kept, { recursive: true });
  fs.mkdirSync(agents, { recursive: true });
  const record = (dir) => JSON.stringify({ label: 'Opus builder', kind: 'claude', started: new Date().toISOString(), worktree: { path: dir, branch: 'x', repo: home } });
  await putWave(JSON.stringify({ items: [{ id: 'V1', title: 'Kept', lane: 'progress' }, { id: 'V2', title: 'Landed', lane: 'progress' }] }));
  fs.writeFileSync(path.join(agents, 'V1.json'), record(kept));
  fs.writeFileSync(path.join(agents, 'V2.json'), record(path.join(home, 'worktrees', 'V2')));
  await heard(path.join(agents, 'V1.json'), path.join(agents, 'V2.json'));
  const served = async (headers = {}) => (await fetch(`${base}/api/board`, { headers })).json();
  try {
    const b = await served();
    assert.deepEqual([b.onHost, b.items.find((i) => i.id === 'V1').worktree, b.items.find((i) => i.id === 'V2').worktree], [true, kept, null]);
    assert.equal((await served({ 'x-forwarded-for': '127.0.0.1' })).onHost, true);
    assert.equal((await served({ 'x-forwarded-for': '100.70.1.2' })).onHost, false);
  } finally {
    await putWave(saved);
    for (const id of ['V1', 'V2']) fs.rmSync(path.join(agents, `${id}.json`), { force: true });
  }
});

test("/api/permissions writes the board folder's settings.local.json and reads it back", async () => {
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  const folder = path.join(home, 'perm-repo');
  const local = path.join(folder, '.claude', 'settings.local.json');
  fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
  fs.writeFileSync(local, JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { site: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], local: true, owner: { repo: folder } } } }));
  const get = async () => (await fetch(`${base}/api/permissions`)).json();
  const set = (body) => fetch(`${base}/api/permissions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const first = await get();
    assert.deepEqual([first.file, first.permissions.map((p) => [p.id, p.on])], [local, [['pushMain', false], ['runRelease', false], ['draftPr', false], ['approvePr', false]]]);
    const on = await set({ id: 'draftPr', on: true });
    assert.equal(on.status, 200);
    assert.deepEqual((await on.json()).permissions.map((p) => [p.id, p.on]), [['pushMain', false], ['runRelease', false], ['draftPr', true], ['approvePr', false]]);
    assert.deepEqual(JSON.parse(fs.readFileSync(local, 'utf8')), { permissions: { allow: ['Bash(npm test)', 'Bash(gh pr create --draft *)'] } });
    assert.equal((await set({ id: 'nope', on: true })).status, 400);
    const noScript = await set({ id: 'runRelease', on: true });
    assert.deepEqual([noScript.status, (await noScript.json()).error], [400, 'No .kickflip/release in this repo, so Run release script stays off.']);
    await ok200(set({ id: 'draftPr', on: false }));
    assert.deepEqual(JSON.parse(fs.readFileSync(local, 'utf8')), { permissions: { allow: ['Bash(npm test)'] } });
    fs.rmSync(manifest);
    assert.equal((await fetch(`${base}/api/permissions`)).status, 404);
  } finally {
    fs.rmSync(manifest, { force: true });
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-05-1823-board-settings-picks-which-build-script-a-board-runs.md
test('/api/build-targets lists the executable .kickflip/build-* scripts at the board’s main tip, and build_target saves a name or the default', async () => {
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  const folder = path.join(home, 'target-repo');
  const git = (...args) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } });
  fs.mkdirSync(path.join(folder, '.kickflip'), { recursive: true });
  git('init', '--quiet', '--initial-branch=main');
  for (const [name, mode] of [['build', 0o755], ['build-web', 0o755], ['build-ios', 0o755], ['build-notes', 0o644], ['README', 0o755]]) {
    fs.writeFileSync(path.join(folder, '.kickflip', name), '#!/bin/sh\n');
    fs.chmodSync(path.join(folder, '.kickflip', name), mode);
  }
  git('add', '.');
  git('commit', '--quiet', '-m', 'targets');
  fs.writeFileSync(path.join(folder, '.kickflip', 'build-uncommitted'), '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { site: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], local: true, owner: { repo: folder } } } }));
  const cfg = JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8'));
  const save = (body) => fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const settingsEvents = async () => (await (await fetch(`${base}/_claude/events?kind=settings`)).json()).map((e) => e.data);
  try {
    assert.deepEqual(await (await fetch(`${base}/api/build-targets`)).json(), { targets: ['ios', 'web'] });
    const set = await (await save({ build_target: 'web' })).json();
    assert.equal(set.settings.build_target, 'web');
    assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8')).build_target, 'web');
    assert.deepEqual((await settingsEvents())[0], { build_target: 'web' });
    for (const bad of ['../build', '', 'a b', 7]) assert.equal((await save({ build_target: bad })).status, 400, JSON.stringify(bad));
    const cleared = await (await save({ build_target: null })).json();
    assert.equal('build_target' in cleared.settings, false);
    assert.equal('build_target' in JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8')), false);
    assert.deepEqual((await settingsEvents())[0], { build_target: null });
    fs.rmSync(manifest);
    assert.equal((await fetch(`${base}/api/build-targets`)).status, 404);
  } finally {
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify(cfg));
    fs.rmSync(manifest, { force: true });
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md
test('/api/scripts answers the scripts source, the repo’s scripts at main and kickflip’s scripts, and a save replaces a kickflip script', async () => {
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  const folder = path.join(home, 'scripts-repo');
  const git = (...args) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } });
  fs.mkdirSync(path.join(folder, '.kickflip'), { recursive: true });
  git('init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(folder, 'README'), 'x');
  git('add', '.');
  git('commit', '--quiet', '-m', 'empty');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { site: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], local: true, owner: { repo: folder } } } }));
  const cfg = JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8'));
  const save = (body) => fetch(`${base}/api/scripts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const read = async () => (await fetch(`${base}/api/scripts`)).json();
  try {
    assert.deepEqual(await read(), { source: 'repo', repo: [], scripts: [{ name: 'build', text: '' }, { name: 'release', text: '' }, { name: 'test', text: '' }] });
    fs.writeFileSync(path.join(folder, '.kickflip', 'build'), '#!/bin/sh\n', { mode: 0o755 });
    git('add', '.');
    git('commit', '--quiet', '-m', 'build');
    assert.deepEqual((await read()).repo, ['build']);
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, scripts: 'kickflip' }));
    const saved = await (await save({ name: 'build-web', text: '#!/bin/sh\necho web\n' })).json();
    assert.deepEqual(saved, { source: 'kickflip', repo: ['build'], scripts: [{ name: 'build', text: '' }, { name: 'build-web', text: '#!/bin/sh\necho web\n' }, { name: 'release', text: '' }, { name: 'test', text: '' }] });
    assert.equal(fs.statSync(path.join(site, 'scripts', 'build-web')).mode & 0o777, 0o700);
    assert.deepEqual(await (await fetch(`${base}/api/build-targets`)).json(), { targets: ['web'] });
    for (const bad of [{ name: '../x', text: '#!/bin/sh\n' }, { name: 'setup', text: '#!/bin/sh\n' }, { name: 'build', text: '  ' }, { name: 'build' }]) {
      const r = await save(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.ok((await r.json()).error);
    }
    fs.rmSync(manifest);
    assert.equal((await fetch(`${base}/api/scripts`)).status, 404);
  } finally {
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify(cfg));
    fs.rmSync(path.join(site, 'scripts'), { recursive: true, force: true });
    fs.rmSync(manifest, { force: true });
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-05-2100-the-server-adds-reviewers-from-fetched-lists.md
test("Save on the settings page's reviewers adds and removes in the server, opening the DM and checking the login, and records reviewers-added and reviewers-removed for the session", async () => {
  const cfg = { title: 'T', items: 'data/items.json', slug: 't' };
  const ann = { name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' }, bob = { name: 'Bob', slack_user: 'U2', dm: 'D2', github: 'bob' };
  const read = (file) => JSON.parse(fs.readFileSync(path.join(site, file), 'utf8'));
  const send = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'reviewers', ...body }) });
  const events = async (kind) => (await (await fetch(`${base}/_claude/events?kind=${kind}`)).json()).map((e) => e.data);
  const waveFile = path.join(site, 'data', 'items.json');
  const wavePrev = fs.existsSync(waveFile) ? fs.readFileSync(waveFile) : null;
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, reviewers: [ann, bob] }));
  await putWave(JSON.stringify({ reviewers: [ann, bob], items: [{ id: 'R1', title: 'R', lane: 'todo' }] }));
  slackWorldOf.dms.U3 = 'D3';
  writeGithubUser(ghDir, 'cy-gh', { login: 'Cy-GH' });
  const cy = { name: 'Cy Doe', slack_user: 'U3', dm: 'D3', github: 'Cy-GH' };
  try {
    const before = [(await events('reviewers-added')).length, (await events('reviewers-removed')).length];
    const r = await send({ add: [{ name: 'Cy Doe', slack_user: 'U3', github: 'cy-gh' }], remove: ['ann'] });
    await ok200(r);
    const out = await r.json();
    assert.deepEqual([out.board.reviewers, out.board.reviewerGithub], [['Bob', 'Cy Doe'], { Bob: 'bob', 'Cy Doe': 'Cy-GH' }]);
    assert.deepEqual([read('board.json').reviewers, read('board.json').title, read('data/items.json').reviewers], [[bob, cy], 'T', [bob, cy]]);
    const [added, gone] = [await events('reviewers-added'), await events('reviewers-removed')];
    assert.deepEqual([added.length, added[0], gone.length, gone[0]], [before[0] + 1, { add: ['Cy Doe'] }, before[1] + 1, { remove: ['ann'] }]);
    assert.equal((await events('reviewers')).length, 0, 'nothing is left for the session to add');

    const refusedAdd = await send({ add: [{ name: 'Ghost', slack_user: 'U3', github: 'ghost' }] });
    assert.equal(refusedAdd.status, 400);
    assert.match((await refusedAdd.json()).error, /GitHub has no user ghost/);
    assert.equal((await send({ add: [{ name: 'Di', slack_user: 'U404', github: 'cy-gh' }] })).status, 400, 'a Slack member with no DM is refused');
    assert.equal((await send({ add: [{ name: 'Di', slack_user: 'U4' }] })).status, 400, 'an add needs both ids');
    assert.deepEqual([read('board.json').reviewers, (await events('reviewers-added')).length], [[bob, cy], before[0] + 1]);

    const removed = await (await send({ add: [], remove: ['Bob', 'Cy Doe'] })).json();
    assert.deepEqual([removed.board.reviewers, read('board.json').reviewers], [[], []]);
    assert.equal((await events('reviewers-added')).length, before[0] + 1, 'a remove alone records no reviewers-added');
    assert.equal(removed.id, (await (await fetch(`${base}/_claude/events?kind=reviewers-removed`)).json())[0].id);

    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, reviewers: [ann] }));
    const refused = await send({ remove: ['Zed'] });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /Zed/);
    assert.deepEqual([read('board.json').reviewers, (await events('reviewers-removed')).length], [[ann], before[1] + 2]);
    assert.equal((await send({ remove: 'Ann' })).status, 400, 'names come as a list');
    assert.equal((await send({})).status, 400, 'a Save names someone');
  } finally {
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify(cfg));
    if (wavePrev) await putWave(wavePrev); else fs.rmSync(waveFile, { force: true });
  }
});

test("Board settings' Reviewers lists the workspace's Slack people, and says what to fix when Slack has no token or the app lacks users:read", async () => {
  const people = async () => (await fetch(`${base}/api/reviewer-people`)).json();
  assert.deepEqual(await people(), { slack: [{ id: 'U3', name: 'Cy Doe' }, { id: 'U4', name: 'Di Poe' }], github: [] });
  slackWorldOf.missingScope = true;
  try { assert.deepEqual(await people(), { slack: null, github: [], slackProblem: 'Slack needs the users:read scope; update the app on Hub › Integrations › Slack.' }); }
  finally { delete slackWorldOf.missingScope; }
  const secrets = path.join(home, '.claude', 'kickflip', 'secrets.json');
  const saved = fs.readFileSync(secrets);
  fs.rmSync(secrets);
  try { assert.deepEqual(await people(), { slack: null, github: [], slackProblem: 'Slack needs Hub’s Slack token; add it in Hub › Integrations › Slack first.' }); }
  finally { fs.writeFileSync(secrets, saved); }
});

// docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md
test("/api/board leaves resolved questions out while its topics still count and list them, and /api/questions answers a topic's resolved questions", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const ask = (id, topic, extra = {}) => ({ id, topic, question: `${id}?`, options: [{ id: 'A', label: 'This' }], ...extra });
  const done = { resolved: 'Acted on', resolved_at: '2026-10-30T10:00:00.000Z' };
  fs.writeFileSync(ownerFile, JSON.stringify({ topics: [{ id: 'plan', title: 'Plan' }, { id: 'old', title: 'Old' }],
    items: [ask('open1', 'plan'), ask('gone1', 'plan', done), ask('gone2', 'old', done), ask('gone3', 'old', done)] }));
  const get = async (p) => (await fetch(`${base}${p}`)).json();
  try {
    await heard(ownerFile);
    const b = await get('/api/board');
    assert.deepEqual(b.owner.map((q) => q.id), ['open1']);
    assert.deepEqual(b.ownerTopics.map((t) => [t.id, t.state, t.questions, t.open, t.resolved]),
      [['plan', 'open', ['open1', 'gone1'], 1, 1], ['old', 'resolved', ['gone2', 'gone3'], 0, 2]]);
    const old = await get('/api/questions?topic=old');
    assert.deepEqual(old.questions.map((q) => [q.id, q.state, q.resolved, q.options.length]), [['gone2', 'resolved', 'Acted on', 1], ['gone3', 'resolved', 'Acted on', 1]]);
    assert.deepEqual((await get('/api/questions?topic=plan')).questions.map((q) => q.id), ['gone1']);
    assert.deepEqual(await get('/api/questions?topic=nowhere'), { questions: [] });
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

// The server marks a card new to the board read right after the board change that brought it (markNewCards), which is
// another change to the board; putWave's settled() has waited for it, so two reads of the board after it compare alike.
test("/api/board carries its change number as its version and ETag: a reload naming it answers 304 with no body until the board changes, and an events POST's board carries the number the next reload has", async () => {
  await putWave(JSON.stringify({ items: [{ id: 'E1', title: 'Tagged', lane: 'todo' }, { id: 'E2', title: 'Other', lane: 'todo' }] }));
  const first = await raw('/api/board', { 'accept-encoding': 'gzip' });
  const tag = first.headers.etag;
  const body = JSON.parse(zlib.gunzipSync(first.body));
  assert.equal(tag, `W/"${body.version}"`);
  assert.ok(Number.isInteger(body.version));
  assert.ok(body.items.every((i) => Number.isInteger(i.changed) && i.changed <= body.version));
  const again = await raw('/api/board', { 'accept-encoding': 'gzip', 'if-none-match': `"${body.version}"` });
  assert.deepEqual([again.status, again.body.length, again.headers.etag, again.headers['cache-control']], [304, 0, tag, 'no-store']);
  const posted = await (await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'card-bump', key: 't/E2' }) })).json();
  assert.ok(posted.board.version > body.version);
  assert.equal(posted.board.onHost, true);
  const stale = await raw('/api/board', { 'if-none-match': tag });
  assert.equal(stale.status, 200);
  assert.equal(JSON.parse(stale.body).version, posted.board.version);
  assert.equal((await raw('/api/board', { 'if-none-match': `"${posted.board.version}"` })).status, 304);
});

test("onHost rides beside the board: a phone and the host's browser read the same change number, each with its own onHost", async () => {
  const host = await (await fetch(`${base}/api/board`)).json();
  const phone = await (await fetch(`${base}/api/board`, { headers: { 'x-forwarded-for': '100.64.0.9' } })).json();
  assert.deepEqual([host.onHost, phone.onHost], [true, false]);
  assert.equal(phone.version, host.version);
  const patch = await (await fetch(`${base}/api/board?since=${host.version}`, { headers: { 'x-forwarded-for': '100.64.0.9' } })).json();
  assert.deepEqual([patch.since, patch.onHost], [host.version, false]);
});

test("a reload naming the number it holds as since gets a patch of the cards changed after it, a tap naming it gets one too, and a since the board can't answer gets the whole board", async () => {
  const vmContext = (await import('node:vm')).createContext({});
  (await import('node:vm')).runInContext(fs.readFileSync(new URL('./public/ui-patch.js', import.meta.url), 'utf8'), vmContext);
  const { applyPatch } = vmContext.BoardUI;
  const content = (b) => { const { generatedAt: _, ...rest } = JSON.parse(JSON.stringify(b)); return rest; };
  const get = async (q = '') => (await fetch(`${base}/api/board${q}`)).json();
  // The cards earlier tests' asks became stay, so no ask is left without its card for the server to file again.
  const asked = JSON.parse(fs.readFileSync(path.join(site, 'data', 'items.json'), 'utf8')).items.filter((i) => i.from_ask);
  await putWave(JSON.stringify({ items: [...asked, { id: 'F1', title: 'Patched', lane: 'todo', phase: 'discussing' }, { id: 'F2', title: 'Still', lane: 'todo', phase: 'discussing' }, { id: 'F3', title: 'Gone soon', lane: 'todo', phase: 'discussing' }] }));
  const first = await get();
  await putWave(JSON.stringify({ items: [...asked, { id: 'F1', title: 'Patched again', lane: 'todo', phase: 'discussing' }, { id: 'F2', title: 'Still', lane: 'todo', phase: 'discussing' }] }));
  const patch = await get(`?since=${first.version}`);
  assert.equal(patch.since, first.version);
  assert.deepEqual(patch.lists.items.set.map((c) => [c.key, c.title]), [['t/F1', 'Patched again']]);
  assert.deepEqual(patch.lists.items.drop, ['t/F3']);
  const whole = await get();
  assert.equal(patch.version, whole.version);
  assert.deepEqual(content(applyPatch(first, patch)), content(whole));

  const posted = await (await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'card-bump', key: 't/F2', since: whole.version }) })).json();
  assert.equal(posted.board.since, whole.version);
  assert.deepEqual(posted.board.lists.items.set.map((c) => c.key), ['t/F2']);
  const event = fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).findLast((e) => e.kind === 'card-bump');
  assert.equal('since' in event.data, false);
  assert.deepEqual(content(applyPatch(whole, posted.board)), content(await get()));

  for (const since of ['nothing', String(whole.version + 1000), '1']) {
    const unknown = await get(`?since=${since}`);
    assert.equal(unknown.since, undefined, since);
    assert.ok(Array.isArray(unknown.items));
  }
});

// docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md
test("a whole board carries no threads; a patch carries the lines added to each card's thread since, and /api/thread answers the same thread the board's sync carries", async () => {
  const vmContext = (await import('node:vm')).createContext({});
  (await import('node:vm')).runInContext(fs.readFileSync(new URL('./public/ui-patch.js', import.meta.url), 'utf8'), vmContext);
  const { threadPatch } = vmContext.BoardUI;
  const get = async (q) => (await fetch(`${base}${q}`)).json();
  // The cards earlier tests' asks became stay, so no ask is left without its card for the server to file again.
  const items = path.join(site, 'data', 'items.json');
  const asked = fs.existsSync(items) ? JSON.parse(fs.readFileSync(items, 'utf8')).items.filter((i) => i.from_ask) : [];
  const file = path.join(site, 'data', 'threads', 't__H1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ts: '2026-11-14T10:00:00.000Z', who: 'claude', text: 'First' }) + '\n');
  await putWave(JSON.stringify({ items: [...asked, { id: 'H1', title: 'Threaded', lane: 'todo', phase: 'discussing' }] }));
  const first = await get('/api/board');
  assert.equal(first.threads, undefined);
  const held = await get('/api/thread?key=t%2FH1');
  assert.deepEqual(held.map((m) => m.text), ['First']);
  fs.appendFileSync(file, JSON.stringify({ ts: '2026-11-14T10:01:00.000Z', who: 'claude', text: 'Second' }) + '\n');
  await heard(file);
  const patch = await get(`/api/board?since=${first.version}`);
  assert.deepEqual(JSON.parse(JSON.stringify(patch.threads['t/H1'])), { from: 1, lines: [{ ...held[0], ts: '2026-11-14T10:01:00.000Z', text: 'Second' }] });
  const { set } = threadPatch(new Map([['t/H1', held]]), patch.threads);
  assert.deepEqual(JSON.parse(JSON.stringify(new Map(set).get('t/H1'))), await get('/api/thread?key=t%2FH1'));
});

// docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md
test("a whole board carries no notes, /api/notes?all=1 answers every card's on it, and a patch carries a card's notes whole once they change", async () => {
  const get = async (q) => (await fetch(`${base}${q}`)).json();
  const items = path.join(site, 'data', 'items.json');
  const asked = fs.existsSync(items) ? JSON.parse(fs.readFileSync(items, 'utf8')).items.filter((i) => i.from_ask) : [];
  const file = path.join(site, 'data', 'N1-notes.md');
  fs.writeFileSync(file, '# N1\n');
  await putWave(JSON.stringify({ items: [...asked, { id: 'N1', title: 'Noted', lane: 'todo', phase: 'discussing', plan: 'N1-notes.md' },
    { id: 'N2', title: 'Short', lane: 'todo', phase: 'discussing', notes: 'Short text' }, { id: 'N3', title: 'Bare', lane: 'todo', phase: 'discussing' },
    { id: 'N4', title: 'Missing file', lane: 'todo', phase: 'discussing', plan: 'N4-gone.md' }] }));
  const first = await get('/api/board');
  assert.equal(first.notes, undefined);
  assert.equal(first.cardNotes, undefined);
  assert.deepEqual((await get('/api/notes?all=1')).notes, { 't/N1': '# N1\n', 't/N2': 'Short text' }, 'a card with no notes, or a notes file that is gone, has none');
  fs.writeFileSync(file, '# N1\n\n## Build notes\n');
  await heard(file);
  const patch = await get(`/api/board?since=${first.version}`);
  assert.deepEqual(patch.notes, { 't/N1': '# N1\n\n## Build notes\n' });
  assert.equal((await get(`/api/board?since=${patch.version}`)).notes, undefined, 'unchanged notes ride no patch');
});

test("while main's build is failing, the last 40 lines of its log ride the board's main; once it isn't, main carries none", async () => {
  const tryFile = path.join(site, 'data', 'try.json');
  const tryBefore = fs.existsSync(tryFile) ? fs.readFileSync(tryFile, 'utf8') : null;
  const logFile = path.join(site, 'data', 'try', 'main.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`);
  fs.writeFileSync(logFile, 'x'.repeat(100_000) + '\n' + lines.join('\n') + '\n');
  const main = (state) => ({ kind: 'web', cards: {}, main: { script: true, sha: 'abcdef1234', slug: 'w', at: '2026-11-15T10:00:00.000Z', state, target: 'web' } });
  try {
    fs.writeFileSync(tryFile, JSON.stringify(main('failed')));
    await heard(tryFile);
    const failed = await (await fetch(`${base}/api/board`)).json();
    assert.deepEqual(failed.main.log, lines.slice(-40));
    fs.writeFileSync(tryFile, JSON.stringify(main('running')));
    await heard(tryFile);
    const patch = await (await fetch(`${base}/api/board?since=${failed.version}`)).json();
    assert.equal(patch.set.main.log, null);
  } finally {
    if (tryBefore === null) fs.rmSync(tryFile); else fs.writeFileSync(tryFile, tryBefore);
    fs.rmSync(logFile);
    await heard(tryFile);
  }
});

test('an event posted with board=0, as the hub posts, is answered with its id alone, building no board', async () => {
  const r = await fetch(`${base}/_claude/events?board=0`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ping', title: 'Hub' }) });
  const answer = await r.json();
  assert.deepEqual(Object.keys(answer), ['id']);
  const event = fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).findLast((e) => e.kind === 'ping');
  assert.deepEqual([event.id, event.data], [answer.id, { title: 'Hub' }]);
});

test("a card's question topic in the page's board carries no title of its own: the page names it from its card", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  await putWave(JSON.stringify({ items: [{ id: 'G1', title: 'Asked' }] }));
  fs.writeFileSync(ownerFile, JSON.stringify({ topics: [{ id: 'plan', title: 'Plan', summary: 'Kept' }], items: [{ id: 'g1', topic: 'item:t/G1', question: 'Which?', options: [{ id: 'A', label: 'This' }] }, { id: 'g2', topic: 'plan', question: 'Ship?', options: [{ id: 'A', label: 'Yes' }] }] }));
  try {
    await heard(ownerFile);
    const b = await (await fetch(`${base}/api/board`)).json();
    assert.ok(b.items.some((i) => i.key === 't/G1'), 'the board serves the task');
    assert.deepEqual(b.ownerTopics.map((t) => [t.id, t.card, t.title, t.summary]), [['item:t/G1', 't/G1', undefined, undefined], ['plan', undefined, 'Plan', 'Kept']]);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

test("the board's version depends on its data alone: a minute later with nothing changed it is the same, and the Block choices carry their lengths, not clock words", () => {
  const dir = fs.realpathSync(tempDir('board-version-'));
  const at = path.join(dir, 'site');
  fs.mkdirSync(path.join(at, 'data'), { recursive: true });
  fs.writeFileSync(path.join(at, 'board.json'), JSON.stringify({ title: 'V', items: 'data/items.json', slug: 'v' }));
  fs.writeFileSync(path.join(at, 'data', 'items.json'), JSON.stringify({ items: [{ id: 'V1', title: 'Todo', phase: 'discussing' }, { id: 'V2', title: 'Held', held: true, phase: 'discussing' }] }));
  const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { mock } from 'node:test';
      mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T10:00:20Z') });
      const { startServer } = await import(${JSON.stringify(server)});
      const { server } = await startServer({ site: ${JSON.stringify(at)}, signedIn: () => true });
      const get = () => new Promise((resolve) => {
        const req = { method: 'GET', url: '/api/board', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
        const res = { req, writeHead() { return this; }, end(body) { resolve(JSON.parse(body)); } };
        server.emit('request', req, res);
      });
      const first = await get();
      mock.timers.tick(61000);
      const later = await get();
      console.log(JSON.stringify({ versions: [first.version, later.version], times: [first.generatedAt, later.generatedAt], holdChoices: later.holdChoices }));
      process.exit(0);
    `], { env: { ...process.env, KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true', HOME: dir }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.notEqual(out.times[0], out.times[1]);
    assert.equal(out.versions[0], out.versions[1]);
    assert.deepEqual(out.holdChoices, [{ value: '1h', label: '1h', ms: 3_600_000 }, { value: '3h', label: '3h', ms: 10_800_000 }, { value: '6h', label: '6h', ms: 21_600_000 },
      { value: '1d', label: '1d', ms: 86_400_000 }, { value: 'forever', label: 'Forever', ms: null }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// docs/adr/2026-11-04-0257-an-idle-board-pushes-once-when-it-has-gone-idle.md
// When an idle stretch pushes is domain.test.mjs's (idleStep, idleSummary); this checks the server's wiring.
test('with Idle notification on, the board pushes "<board> has gone idle" 15 minutes into an idle stretch, with what closed since, and turning it off forgets the stretch', () => {
  const dir = fs.realpathSync(tempDir('board-idle-'));
  const at = path.join(dir, 'site');
  fs.mkdirSync(path.join(at, 'data'), { recursive: true });
  fs.writeFileSync(path.join(at, 'board.json'), JSON.stringify({ title: 'Idle board', items: 'data/items.json', slug: 'i', idle_notification: true }));
  fs.writeFileSync(path.join(at, 'data', 'items.json'), JSON.stringify({ items: [{ id: 'I1', title: 'Open' }] }));
  fs.writeFileSync(path.join(dir, 'push-stub.mjs'), "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(3)) + '\\n'); console.log('sent');");
  const calls = path.join(dir, 'push-calls.jsonl');
  const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { mock } from 'node:test';
      mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T10:00:00Z') });
      const wave = ${JSON.stringify(path.join(at, 'data', 'items.json'))};
      const idle = ${JSON.stringify(path.join(at, 'data', 'idle.json'))};
      const pushes = () => (fs.existsSync(${JSON.stringify(calls)}) ? fs.readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').map((l) => JSON.parse(l)) : []);
      const state = () => (fs.existsSync(idle) ? fs.readFileSync(idle, 'utf8') : '');
      const { startServer } = await import(${JSON.stringify(server)});
      const board = await startServer({ site: ${JSON.stringify(at)}, signedIn: () => true });
      // Writes a file and has the server hear it, then waits for every check that started.
      const heard = async (file, text) => { fs.writeFileSync(file, text); board.changed(file); await board.settled(); };
      const write = (items) => heard(wave, JSON.stringify({ items }));
      await board.settled();
      if (!state()) throw new Error('the first idle check wrote no state');
      const done = (id, mins) => { const at = new Date(Date.parse('2026-11-04T10:00:00Z') + mins * 60000).toISOString(); return { id, title: id, lane: 'done', lane_at: at, closed_at: at }; };
      await write([{ id: 'I1', title: 'Open' }, done('I2', 5)]);
      mock.timers.tick(16 * 60000);
      await write([{ id: 'I1', title: 'Open!' }, done('I2', 5)]);
      if (pushes().length !== 1) throw new Error('no idle push');
      await heard(${JSON.stringify(path.join(at, 'board.json'))}, JSON.stringify({ title: 'Idle board', items: 'data/items.json', slug: 'i' }));
      if (state()) throw new Error('turning it off kept the stretch');
      console.log(JSON.stringify({ pushes: pushes() }));
      process.exit(0);
    `], { env: { ...process.env, KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true', HOME: dir, PREFIX: '', KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, path.join(dir, 'push-stub.mjs'), 'push']), STUB_CALLS: calls }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').at(-1));
    const [push] = out.pushes;
    assert.deepEqual([out.pushes.length, flag(push, 'kind'), flag(push, 'title'), flag(push, 'body'), flag(push, 'url'), flag(push, 'tag')],
      [1, 'reminder', 'Idle board has gone idle', '1 task landed: I2', '/site/', 'idle']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md
test("data/sync.json keeps the change numbers across a restart: the counter carries on, and a page holding a number from before catches up with a patch", async () => {
  const dir = tempDir('board-sync-');
  const at = path.join(dir, 'site');
  fs.mkdirSync(path.join(at, 'data'), { recursive: true });
  fs.writeFileSync(path.join(at, 'board.json'), JSON.stringify({ title: 'T', items: 'data/items.json', slug: 's' }));
  fs.writeFileSync(path.join(at, 'data', 'owner.json'), '{"items":[]}');
  const wave = (titles) => fs.writeFileSync(path.join(at, 'data', 'items.json'), JSON.stringify({ items: titles.map((title, i) => ({ id: `S${i + 1}`, title, phase: 'discussing' })) }));
  wave(['One', 'Two']);
  const file = path.join(at, 'data', 'sync.json');
  // A server on the site in this process, once its start's passes have finished.
  const start = async () => {
    const { startServer } = await import('./server.mjs');
    const server = await startServer({ site: at, signedIn: () => true });
    await server.settled();
    return { ...server, get: async (q = '') => (await fetch(`http://127.0.0.1:${server.server.address().port}/api/board${q}`)).json() };
  };
  const first = await start();
  let held;
  try {
    held = await first.get();
    assert.deepEqual(held.items.map((i) => [i.key, Boolean(i.readAt)]), [['s/S1', true], ['s/S2', true]], 'the board reads both tasks');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, held.version);
  } finally { await first.close(); }
  wave(['One', 'Two, renamed while the server was down']);
  const second = await start();
  try {
    const patch = await second.get(`?since=${held.version}`);
    assert.equal(patch.since, held.version);
    assert.ok(patch.version > held.version);
    assert.deepEqual(patch.lists.items.set.map((i) => [i.key, i.title, i.changed]), [['s/S2', 'Two, renamed while the server was down', patch.version]]);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, patch.version);
  } finally { await second.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// docs/adr/2026-11-05-0910-read-marks-live-on-the-board.md
test("read marks live on the board: a card new to it is read up to then, POST /api/read moves a mark only forward, every page's board carries it as the card's readAt, and a card leaving the board drops its mark", async () => {
  const waveFile = path.join(site, 'data', 'items.json');
  const readFile = path.join(site, 'data', 'read.json');
  const before = fs.existsSync(waveFile) ? fs.readFileSync(waveFile, 'utf8') : null;
  const wave = before ? JSON.parse(before) : { items: [] };
  const post = (body) => fetch(`${base}/api/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const card = async (key) => (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === key);
  const marks = () => JSON.parse(fs.readFileSync(readFile, 'utf8')).cards;
  try {
    const start = new Date().toISOString();
    await putWave(JSON.stringify({ ...wave, items: [...wave.items, { id: 'R1', title: 'Read' }, { id: 'R2', title: 'Dropped' }] }));
    assert.ok((await card('t/R2')).readAt, 'tasks new to the board get a mark');
    const first = (await card('t/R1')).readAt;
    assert.ok(first >= start, `${first} is when the server first saw the task`);

    await ok200(post({ marks: { 't/R1': '2099-01-01T00:00:00.000Z' } }));
    assert.equal((await card('t/R1')).readAt, '2099-01-01T00:00:00.000Z');
    await ok200(post({ marks: { 't/R1': '2098-01-01T00:00:00.000Z', 'gone/X': '2099-01-01T00:00:00.000Z' } }));
    assert.equal((await card('t/R1')).readAt, '2099-01-01T00:00:00.000Z', 'an older mark leaves the later one');
    assert.equal(marks()['gone/X'], undefined, 'a task not on the board keeps no mark');

    for (const bad of [{}, { marks: [] }, { marks: { 't/R1': 5 } }, { marks: { 't/R1': 'yesterday' } }]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad));

    await putWave(JSON.stringify({ ...wave, items: [...wave.items, { id: 'R1', title: 'Read' }] }));
    assert.equal(marks()['t/R2'], undefined, 'the dropped task loses its mark');
    assert.equal(marks()['t/R1'], '2099-01-01T00:00:00.000Z');
  } finally { if (before) await putWave(before); else fs.rmSync(waveFile); }
});

// docs/adr/2026-11-18-1200-composer-drafts-live-on-the-server.md
test("composer drafts live on the board: POST /api/drafts saves a box's text and files at the server's time, every page's board carries them as drafts, and a reply's draft goes when its card leaves the board", async () => {
  const waveFile = path.join(site, 'data', 'items.json');
  const before = fs.existsSync(waveFile) ? fs.readFileSync(waveFile, 'utf8') : null;
  const wave = before ? JSON.parse(before) : { items: [] };
  const post = (body) => fetch(`${base}/api/drafts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const drafts = async () => (await (await fetch(`${base}/api/board`)).json()).drafts;
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png', size: 3 };
  try {
    await putWave(JSON.stringify({ ...wave, items: [...wave.items, { id: 'D1', title: 'Drafted' }] }));
    const reply = await (await ok200(post({ id: 'item:t/D1', text: 'Half a reply', files: [{ ...shot, path: '/etc/passwd' }] }))).json();
    const ask = await (await ok200(post({ id: 'ask', text: 'A new task' }))).json();
    assert.deepEqual(await drafts(), {
      'item:t/D1': { text: 'Half a reply', files: [{ ...shot, path: path.join(site, 'data', shot.url) }], at: reply.at },
      ask: { text: 'A new task', files: [], at: ask.at },
    });
    for (const bad of [{}, { id: 'edit:e1', text: '' }, { id: 'ask', text: 5 }, { id: 'ask', text: '', files: [{ url: '/etc/passwd' }] }]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad));

    await putWave(JSON.stringify(wave));
    assert.deepEqual(Object.keys(await drafts()), ['ask'], 'the card left, and its reply draft with it');
  } finally { if (before) await putWave(before); else fs.rmSync(waveFile); }
});

// docs/adr/2026-11-18-1200-composer-drafts-live-on-the-server.md
test("a question's unsent pick and note live on the board as q:<id>, with no files: they stay while the question is open and go with it once it is gone from the board", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const post = (body) => fetch(`${base}/api/drafts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const drafts = async () => (await (await fetch(`${base}/api/board`)).json()).drafts;
  const waveFile = path.join(site, 'data', 'items.json');
  const before = fs.existsSync(waveFile) ? fs.readFileSync(waveFile, 'utf8') : null;
  const wave = before ? JSON.parse(before) : { items: [] };
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [{ id: 'pq1', topic: 'item:t/PQ1', question: 'Keep?', options: [{ id: 'A', label: 'Keep' }] }] }));
  try {
    await putWave(JSON.stringify({ ...wave, items: [...wave.items, { id: 'PQ1', title: 'Asked', lane: 'progress' }] }));
    const kept = await (await ok200(post({ id: 'q:pq1', text: 'Because', choice: 'A' }))).json();
    await ok200(post({ id: 'q:gone', text: 'Nothing asks this', choice: null }));
    assert.equal((await post({ id: 'q:pq1', text: '', files: [{ url: 'uploads/1-a.png' }] })).status, 400);
    await putWave(JSON.stringify({ ...wave, items: [...wave.items, { id: 'PQ1', title: 'Asked', lane: 'progress' }, { id: 'PQ2', title: 'Another' }] }));
    assert.deepEqual((await drafts())['q:pq1'], { text: 'Because', files: [], choice: 'A', at: kept.at });
    assert.equal((await drafts())['q:gone'], undefined, 'no open question has it');

    fs.writeFileSync(ownerFile, '{"items":[]}');
    await putWave(JSON.stringify(wave));
    assert.equal((await drafts())['q:pq1'], undefined, 'the question left the board');
  } finally {
    fs.writeFileSync(ownerFile, '{"items":[]}');
    if (before) await putWave(before); else fs.rmSync(waveFile);
  }
});

// docs/adr/2026-11-18-0700-the-hub-has-no-sharing-only-the-owners-tailnet-identity-gets-in.md
test('a board has no sharing: api/share is no route, and an old board.json share writes nothing', async () => {
  const cfg = { title: 'T', items: 'data/items.json', slug: 't' };
  const kept = JSON.stringify({ ...cfg, share: ['maya@github'] });
  fs.writeFileSync(path.join(site, 'board.json'), kept);
  try {
    const r = await fetch(`${base}/api/share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ add: 'sam@github' }) });
    assert.equal(r.status, 405);
    assert.equal(fs.readFileSync(path.join(site, 'board.json'), 'utf8'), kept);
  } finally {
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify(cfg));
  }
});

// docs/adr/2026-11-16-2000-board-settings-edits-the-boards-description.md
test("Board Settings' description reads and saves the manifest's, with how it was set, refusing an empty or over-long one", async () => {
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { site: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], description: 'Old words', description_source: 'new-board', description_at: '2026-11-12T10:00:00.000Z' } } }));
  const post = (description) => fetch(`${base}/api/description`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description }) });
  try {
    assert.deepEqual(await (await fetch(`${base}/api/description`)).json(), { description: 'Old words', source: 'new-board', at: '2026-11-12T10:00:00.000Z' });
    const saved = await (await post('  The shop board  ')).json();
    assert.deepEqual([saved.description, saved.source, typeof saved.at], ['The shop board', 'settings', 'string']);
    assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')).sites.site, { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], description: 'The shop board', description_source: 'settings', description_at: saved.at });
    for (const bad of ['', '   ', 'x'.repeat(241)]) assert.equal((await post(bad)).status, 400, bad.length.toString());
    assert.equal((await (await post('')).json()).error, 'A board needs a description');
    assert.equal((await (await fetch(`${base}/api/description`)).json()).description, 'The shop board');
    assert.equal((await post('x'.repeat(240))).status, 200);
  } finally { fs.rmSync(manifest); }
});

test('a symlink in the board\'s public folder that leads outside its roots is not served', async () => {
  const pub = path.join(site, 'public');
  fs.mkdirSync(pub, { recursive: true });
  const secret = path.join(home, 'board-secret.js');
  fs.writeFileSync(secret, 'secret');
  fs.writeFileSync(path.join(pub, 'inside.js'), 'inside');
  fs.symlinkSync(secret, path.join(pub, 'leak.js'));
  assert.equal((await fetch(`${base}/inside.js`)).status, 200);
  assert.equal((await fetch(`${base}/leak.js`)).status, 404);
});
