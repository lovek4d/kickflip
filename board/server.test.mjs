import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until, ownSession } from '../shared/test-helpers.mjs';

let home, site, child, base;
const uploads = () => path.join(site, 'data', 'uploads');

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'board-server-'));
  site = path.join(home, 'site');
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/wave.json', slug: 't' }));
  fs.writeFileSync(path.join(site, 'data', 'owner.json'), '{"items":[]}');
  const [port] = await freePorts();
  base = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(home, 'push-stub.mjs'), "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(3)) + '\\n'); console.log('sent');");
  const pushEnv = { KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, path.join(home, 'push-stub.mjs'), 'push']), STUB_CALLS: path.join(home, 'push-calls.jsonl') };
  child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], { env: { ...process.env, HOME: home, PORT: String(port), PREFIX: '', ...pushEnv } });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', reject); });
  await until(() => fs.existsSync(path.join(site, 'data', 'action-pushes.json')), 'the first Action needed check');
});
after(() => { child?.kill(); fs.rmSync(home, { recursive: true, force: true }); });

const upload = (body, name, type) => fetch(`${base}/api/upload`, { method: 'POST', headers: { 'x-filename': encodeURIComponent(name), 'content-type': type }, body });

const pushes = () => (fs.existsSync(path.join(home, 'push-calls.jsonl')) ? fs.readFileSync(path.join(home, 'push-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const flag = (call, name) => (call.includes(`--${name}`) ? call[call.indexOf(`--${name}`) + 1] : undefined);

test("the board pushes each new Action needed once under its card's tag, again only for a new question, and drops its queued push once it is gone", async () => {
  const queue = path.join(home, '.claude', 'kickflip', 'push', 'queue.json');
  const ownerFile = path.join(site, 'data', 'owner.json');
  const ask = (id, topic, question) => ({ id, topic, question, options: [{ id: 'A', label: 'Keep' }] });
  const answer = (id) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'owner-answer', id, choice: 'A' }) });
  const tagged = (tag) => pushes().filter((c) => flag(c, 'tag') === tag);
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'P1', title: 'Pushed', status: 'building' }] }));
  fs.writeFileSync(ownerFile, JSON.stringify({ topics: [{ id: 'plan', title: 'Plan' }], items: [ask('p1', 'item:t/P1', 'Keep the badge?')] }));
  try {
    await until(() => tagged('item-t/P1').length === 1, 'the new question pushes');
    const [first] = tagged('item-t/P1');
    assert.deepEqual([flag(first, 'kind'), flag(first, 'title'), flag(first, 'body'), flag(first, 'url'), first.includes('--now')],
      ['action', 'P1: Answer 1 question', 'Keep the badge?', '/site/questions.html?from=push#p1', true]);
    fs.writeFileSync(ownerFile, JSON.stringify({ topics: [{ id: 'plan', title: 'Plan' }], items: [ask('p1', 'item:t/P1', 'Keep the badge?'), ask('p2', 'item:t/P1', 'Keep the dot?'), ask('p3', 'plan', 'Ship it?')] }));
    await until(() => tagged('item-t/P1').length === 2 && tagged('topic-plan').length === 1, 'a second question and a topic push');
    assert.deepEqual([flag(tagged('item-t/P1')[1], 'body'), flag(tagged('topic-plan')[0], 'title')], ['Keep the dot?', 'Plan · 1 question']);
    assert.equal((await answer('p1')).status, 200);
    fs.mkdirSync(path.dirname(queue), { recursive: true });
    const keep = [{ tag: 'item-t/P1', url: '/site-other/' }, { tag: 'unrelated', url: '/site/' }];
    fs.writeFileSync(queue, JSON.stringify({ items: [{ tag: 'item-t/P1', url: '/site/questions.html?from=push#p2' }, ...keep] }));
    assert.equal((await answer('p2')).status, 200);
    await until(() => JSON.parse(fs.readFileSync(queue, 'utf8')).items.length === 2, 'the gone action drops its queued push');
    assert.deepEqual(JSON.parse(fs.readFileSync(queue, 'utf8')), { items: keep });
    assert.equal(tagged('item-t/P1').length, 2);
  } finally {
    fs.writeFileSync(ownerFile, '{"items":[]}');
    fs.rmSync(queue, { force: true });
  }
});

test("the owner's last answer on an unstarted card that nothing stops wakes the session to start it", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const ask = (id, key) => ({ id, topic: `item:${key}`, question: 'Which?', options: [{ id: 'A', label: 'This' }] });
  const answer = (id) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'owner-answer', id, choice: 'A' }) });
  const unblocked = () => (fs.existsSync(path.join(site, 'data', 'events.jsonl')) ? fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'card-unblocked').map((e) => e.data.key);
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'S1', title: 'Two questions' }, { id: 'S2', title: 'Blocked', deps: ['S3'] }, { id: 'S3', title: 'Dep' }, { id: 'S4', title: 'Held', held: true }] }));
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [ask('s1a', 't/S1'), ask('s1b', 't/S1'), ask('s2', 't/S2'), ask('s4', 't/S4')] }));
  const before = unblocked().length;
  try {
    for (const id of ['s1a', 's2', 's4']) assert.equal((await answer(id)).status, 200);
    assert.deepEqual(unblocked().slice(before), []);
    assert.equal((await answer('s1b')).status, 200);
    assert.deepEqual(unblocked().slice(before), ['t/S1']);
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
    const untouched = fs.readFileSync(ownerFile, 'utf8');
    assert.equal((await answer('pick', 'B')).status, 200);
    assert.equal(fs.readFileSync(ownerFile, 'utf8'), untouched);
    assert.deepEqual(await round(), { n: 2, state: 'closed', take: 'B' });
    assert.equal((await answer('pick', 'B', 'Bigger')).status, 200);
    assert.equal(fs.readFileSync(ownerFile, 'utf8'), untouched);
    assert.deepEqual(await round(), { n: 2, state: 'closed', take: 'B' });
    const b = await board();
    assert.equal(b.owner.find((q) => q.id === 'pick').state, 'answered');
    assert.equal(b.needsSummary, '1 question');
    assert.equal((await answer('plain', null, 'Keep it, but rename it')).status, 200);
    assert.equal(items().find((q) => q.id === 'plain').resolved, 'Answered with a note');
    const after = await board();
    assert.equal(after.owner.find((q) => q.id === 'plain'), undefined);
    const topic = after.ownerTopics.find((t) => t.questions.includes('plain')).id;
    const resolved = (await (await fetch(`${base}/api/questions?topic=${encodeURIComponent(topic)}`)).json()).questions;
    assert.deepEqual(resolved.map((q) => [q.id, q.state]), [['plain', 'resolved']]);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

// docs/adr/2026-11-03-1646-a-prototype-answer-with-no-pick-prototypes-again.md
test("an owner answer that picks no take on a card's prototype says so in its event, and the card prototypes again", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const eventsFile = path.join(site, 'data', 'events.jsonl');
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'P1', title: 'Moon' }] }));
  const takes = { id: 'moon', topic: 'item:t/P1', question: 'Which?', url: 'prototype-moon.html?q=moon', options: [{ id: 'A', label: 'Light' }, { id: 'B', label: 'Dark' }] };
  const plain = { id: 'keep', topic: 'item:t/P1', question: 'Keep?', options: [{ id: 'A', label: 'Keep' }] };
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [takes, plain] }));
  const answer = (id, choice, note) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'owner-answer', id, choice, note }) });
  const last = () => JSON.parse(fs.readFileSync(eventsFile, 'utf8').trim().split('\n').at(-1));
  try {
    assert.equal((await answer('keep', null, 'Rename it')).status, 200);
    assert.equal(last().data.prototype_again, undefined);
    const r = await answer('moon', null, 'Neither: try a darker moon');
    assert.equal(r.status, 200);
    assert.deepEqual([last().kind, last().data.prototype_again], ['owner-answer', true]);
    const card = (await r.json()).board.items.find((i) => i.key === 't/P1');
    assert.deepEqual([card.state, card.next, card.buildable], ['prototyping', 'Prototype again', false]);
    assert.equal((await answer('moon', 'B', '')).status, 200);
    assert.equal(last().data.prototype_again, undefined);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

// docs/adr/2026-11-03-1803-a-question-asked-for-a-prototype-is-resolved.md
test("a prototype request on a question resolves it with its note and pick kept on the event, the topic's round reads making and the card prototypes; one on a card resolves nothing", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const eventsFile = path.join(site, 'data', 'events.jsonl');
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'R1', title: 'Search' }] }));
  const plain = { id: 'where', topic: 'item:t/R1', question: 'Where does search sit?', options: [{ id: 'A', label: 'Above' }, { id: 'B', label: 'Icon' }] };
  fs.writeFileSync(ownerFile, JSON.stringify({ items: [plain] }));
  const send = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const last = () => JSON.parse(fs.readFileSync(eventsFile, 'utf8').trim().split('\n').at(-1));
  const items = () => JSON.parse(fs.readFileSync(ownerFile, 'utf8')).items;
  try {
    const untouched = fs.readFileSync(ownerFile, 'utf8');
    assert.equal((await send({ kind: 'prototype-request', key: 't/R1' })).status, 200);
    assert.equal(fs.readFileSync(ownerFile, 'utf8'), untouched);

    const r = await send({ kind: 'prototype-request', key: 't/R1', question: 'where', note: 'Show it on a phone', choice: 'B' });
    assert.equal(r.status, 200);
    assert.deepEqual([last().kind, last().data], ['prototype-request', { key: 't/R1', question: 'where', note: 'Show it on a phone', choice: 'B' }]);
    const q = items()[0];
    assert.equal(q.resolved, 'Prototype requested');
    assert.ok(q.resolved_at >= last().ts);
    const b = (await r.json()).board;
    assert.deepEqual([b.owner, b.ownerTopics.find((t) => t.id === 'item:t/R1').resolved], [[], 1]);
    assert.deepEqual(b.ownerTopics.find((t) => t.id === 'item:t/R1').round, { n: 1, state: 'making' });
    const card = b.items.find((i) => i.key === 't/R1');
    assert.deepEqual([card.state, card.next, card.buildable], ['prototyping', 'Prototype again', false]);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

test("one owner-answers request records every answer as one-by-one answers would, in one write, returning the board once, or on any it can't record records none and says why", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  const eventsFile = path.join(site, 'data', 'events.jsonl');
  const ask = (id, key) => ({ id, topic: `item:${key}`, question: `${id}?`, options: [{ id: 'A', label: 'This' }] });
  const batch = (answers) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'owner-answers', answers }) });
  const lines = () => (fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'B1', title: 'Two questions' }] }));
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
    assert.equal(r.status, 200);
    const out = await r.json();
    const added = lines().slice(before);
    assert.deepEqual(added.map((e) => [e.kind, e.data]), [
      ['owner-answer', { id: 'b1a', question: 'b1a?', choice: 'A', label: 'A. This', note: 'Bigger' }],
      ['owner-answer', { id: 'b1b', question: 'b1b?', choice: null, label: '', note: 'Rename it' }],
      ['card-unblocked', { key: 't/B1' }]]);
    assert.deepEqual(out.ids, added.slice(0, 2).map((e) => e.id));
    assert.deepEqual(out.board.owner.filter((q) => q.topic === 'item:t/B1').map((q) => [q.id, q.state]), [['b1a', 'answered']]);
    assert.deepEqual(out.board.ownerTopics.find((t) => t.id === 'item:t/B1').questions, ['b1a', 'b1b']);
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).items.find((q) => q.id === 'b1b').resolved, 'Answered with a note');
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

test('board writes refuse cross-site requests and non-JSON bodies before their handlers run', async () => {
  const file = path.join(site, 'data', 'events.jsonl');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { origin: 'https://other.example' },
    { origin: 'null' },
    { origin: 'invalid' },
    { 'sec-fetch-site': 'same-origin', origin: 'https://other.example' },
  ]) {
    const r = await fetch(`${base}/_claude/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ kind: 'ask', text: 'Refused' }),
    });
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.match(r.headers.get('content-type'), /^text\/plain/);
  }
  for (const p of ['/_claude/events', '/api/settings', '/api/try', '/api/rules', '/api/hide']) {
    for (const headers of [{ 'content-type': 'text/plain' }, { 'content-type': 'application/x-www-form-urlencoded' }, {}]) {
      assert.equal((await fetch(base + p, { method: 'POST', headers, body: '{' })).status, 403, p);
    }
  }
  for (const method of ['POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS']) {
    assert.equal((await fetch(`${base}/_claude/health`, { method, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, method);
  }
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, before);
  for (const headers of [
    { origin: base },
    { 'sec-fetch-site': 'same-origin', origin: base },
    { 'sec-fetch-site': 'none' },
    { 'x-forwarded-host': 'mac.example.ts.net', origin: 'https://mac.example.ts.net' },
    {},
  ]) {
    const r = await fetch(`${base}/_claude/events`, {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify({ kind: 'guard-check' }),
    });
    assert.equal(r.status, 200, JSON.stringify(headers));
  }
  assert.equal((await fetch(`${base}/_claude/events`, { headers: { origin: 'https://other.example' } })).status, 200);
  assert.equal((await fetch(`${base}/_claude/health`, { method: 'HEAD', headers: { 'sec-fetch-site': 'cross-site' } })).status, 200);
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
  const server = spawn(process.execPath, [path.join(root, 'server.mjs')], { env: { ...process.env, HOME: home, PORT: String(port), PREFIX: '/plain' } });
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('exit', reject); });
    const post = (headers, body = '{"kind":"message","text":"Hello"}') => fetch(`${url}/plain/_claude/events`, { method: 'POST', headers, body });
    for (const headers of [
      { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      { 'content-type': 'application/json', origin: 'https://other.example' },
      { 'content-type': 'text/plain', origin: url },
    ]) assert.equal((await post(headers)).status, 403, JSON.stringify(headers));
    assert.equal(fs.existsSync(path.join(root, 'data')), false);
    for (const headers of [
      { 'content-type': 'application/json', origin: url },
      { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      { 'content-type': 'application/json', origin: 'https://mac.example.ts.net', 'x-forwarded-host': 'mac.example.ts.net' },
      { 'content-type': 'application/json' },
    ]) assert.equal((await post(headers)).status, 200, JSON.stringify(headers));
    assert.equal((await fetch(`${url}/_claude/events`)).status, 200);
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
  assert.equal(r.status, 200);
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
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'W1', title: 'Messaged' }, { id: 'W2', title: 'Prototyped' }] }));
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

test("a Build tap starts the build in the board server, moving the card to In Progress reading preheating and waking the session with its worktree and pick, and a refusal leaves it in Todo with the reason; on a blocked card it queues the build, which the server starts once the blocker is done", async () => {
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
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [
    { id: 'B1', title: 'Tapped', next: 'Implement' }, { id: 'B2', title: 'Held', held: true, pick_up_at: '2099-01-01T00:00:00.000Z' }, { id: 'B3', title: 'Blocked', deps: ['B4'] }, { id: 'B4', title: 'Dep' },
    { id: 'B5', title: 'Held and blocked', deps: ['B4'], held: true }, { id: 'B6', title: 'Leftover worktree' }, { id: 'B7', title: 'Leftover work' },
  ] }));
  const wave = () => JSON.parse(fs.readFileSync(path.join(site, 'data', 'wave.json'), 'utf8'));
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const log = () => fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const card = async (id) => (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.id === id);
  const thread = (id) => fs.readFileSync(path.join(site, 'data', 'threads', `t__${id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const worktree = path.join(home, '.claude', 'kickflip', 'worktrees', 'B1');
  const before = log().length;
  try {
    assert.equal((await post({ kind: 'card-build', key: 't/B1' })).status, 200);
    const record = JSON.parse(fs.readFileSync(path.join(site, 'data', 'agents', 'B1.json'), 'utf8'));
    assert.deepEqual([record.kind, record.label, record.dispatched, record.worktree], ['claude', 'Builder', 'tap', { path: worktree, branch: 'B1', repo: clone }]);
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'));
    assert.equal(wave().items.find((i) => i.id === 'B1').next, undefined);
    const woke = log().slice(before);
    assert.deepEqual(woke.map((e) => [e.kind, e.data]), [['card-build', { key: 't/B1', ref: 'B1', kind: 'claude', model: 'opus', reason: woke[0].data.reason, worktree }]]);
    assert.match(woke[0].data.reason, /\S/);
    const started = await card('B1');
    assert.deepEqual([started.lane, started.status, started.buildable, started.builder.progress, started.refusal], ['progress', 'building', false, null, null]);

    const held = await card('B2');
    assert.deepEqual([held.held, held.buildable], [true, true]);
    assert.equal((await post({ kind: 'card-build', key: 't/B2' })).status, 200);
    const unheld = await card('B2');
    assert.deepEqual([unheld.held, unheld.lane, unheld.status, unheld.builder.progress, unheld.refusal], [false, 'progress', 'building', null, null]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'data', 'wave.json'), 'utf8')).items[1].pick_up_at, undefined);
    assert.deepEqual(thread('B2').map((m) => [m.who, m.text]), [['love', 'Resumed.']]);
    assert.deepEqual(log().slice(before).map((e) => e.kind), ['card-build', 'card-build']);
    // docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md
    const queuedAnswer = await (await post({ kind: 'card-build', key: 't/B3' })).json();
    assert.equal(queuedAnswer.id, null);
    assert.equal(queuedAnswer.board.items.find((i) => i.id === 'B3').queued, true);
    const queued = await card('B3');
    assert.deepEqual([queued.lane, queued.queued, queued.status, queued.builder, queued.next, queued.buildable, queued.blockedBy.map((d) => d.ref)], ['todo', true, null, null, null, false, ['B4']]);
    assert.deepEqual(thread('B3').map((m) => [m.who, m.text]), [['claude', 'Implement queued: it starts once B4 is done.']]);
    assert.equal(fs.existsSync(path.join(site, 'data', 'agents', 'B3.json')), false);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'kickflip', 'worktrees', 'B3')), false);
    assert.equal((await post({ kind: 'card-build', key: 't/B5' })).status, 200);
    const unheldQueued = await card('B5');
    assert.deepEqual([unheldQueued.held, unheldQueued.lane, unheldQueued.queued], [false, 'todo', true]);
    assert.deepEqual(thread('B5').map((m) => m.text), ['Resumed.', 'Implement queued: it starts once B4 is done.']);
    assert.deepEqual(log().slice(before).map((e) => e.kind), ['card-build', 'card-build']);

    const taken = path.join(home, '.claude', 'kickflip', 'worktrees', 'B4');
    fs.mkdirSync(taken, { recursive: true });
    assert.equal((await post({ kind: 'card-build', key: 't/B4' })).status, 200);
    const leftover = await card('B4');
    assert.deepEqual([leftover.lane, leftover.status, leftover.refusal], ['todo', null, `Couldn't start implementing: --worktree: ${taken} already exists; land or remove it first`]);
    assert.deepEqual(log().slice(before).map((e) => e.kind), ['card-build', 'card-build']);

    // The blocker finishing starts both queued builds in the server, each waking the session once, with no card-unblocked.
    const done = wave();
    done.items.find((i) => i.id === 'B4').status = 'done';
    fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify(done));
    await until(() => log().slice(before).filter((e) => e.kind === 'card-build').length === 4, 'the queued builds start');
    const woken = log().slice(before).filter((e) => e.kind === 'card-build').slice(2).map((e) => e.data.key).sort();
    assert.deepEqual(woken, ['t/B3', 't/B5']);
    for (const id of ['B3', 'B5']) {
      const startedQueued = await card(id);
      assert.deepEqual([startedQueued.lane, startedQueued.status, startedQueued.queued, startedQueued.builder.progress], ['progress', 'building', false, null]);
      assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'data', 'agents', `${id}.json`), 'utf8')).worktree.path, path.join(home, '.claude', 'kickflip', 'worktrees', id));
      assert.equal(wave().items.find((i) => i.id === id).queued_at, undefined);
    }
    assert.equal(log().slice(before).some((e) => e.kind === 'card-unblocked'), false);

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
    assert.equal((await post({ kind: 'card-build', key: 't/B6' })).status, 200);
    const remade = await card('B6');
    assert.deepEqual([remade.lane, remade.status, remade.refusal], ['progress', 'building', null]);
    assert.equal(git(leftover6, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'));
    assert.deepEqual(thread('B6').map((m) => [m.who, m.text]), [['claude', `Remade the leftover worktree ${leftover6} from main: it held no commits or changes.`]]);
    assert.equal((await post({ kind: 'card-build', key: 't/B7' })).status, 200);
    const kept = await card('B7');
    assert.deepEqual([kept.lane, kept.status, kept.refusal], ['todo', null, `Couldn't start implementing: --worktree: ${leftover7} holds 1 changed file; land or remove it first`]);
  } finally {
    fs.rmSync(manifest);
    fs.rmSync(path.join(site, 'data', 'agents'), { recursive: true, force: true });
    fs.rmSync(path.join(home, '.claude', 'kickflip', 'worktrees'), { recursive: true, force: true });
  }
});

test("a hidden thread message leaves the item's thread", async () => {
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One' }] }));
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { id } = await post('/_claude/events', { kind: 'item-message', key: 't/A1', text: 'Fix it' });
  const thread = async () => (await (await fetch(`${base}/api/thread?key=t%2FA1`)).json()).map((m) => [m.eventId, m.state, m.canDelete]);
  assert.deepEqual(await thread(), [[id, 'waiting', true]]);
  await post('/api/hide', { id, hidden: true });
  assert.deepEqual(await thread(), []);
});

test("a new task is a New card until it becomes work, whose thread then holds the ask, its thread and the owner's replies to it", async () => {
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { id } = await post('/_claude/events', { kind: 'ask', text: 'Fix the header' });
  const thread = async (key) => (await (await fetch(`${base}/api/thread?key=${encodeURIComponent(key)}`)).json()).map((m) => [m.eventId ?? m.link, m.text, m.state]);
  const board = async () => (await fetch(`${base}/api/board`)).json();
  const card = async () => (await board()).items.find((i) => i.kind === 'ask' && i.id === id);
  assert.deepEqual([(await card()).lane, (await card()).isNew, (await card()).ask.state], ['todo', true, 'waiting']);
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'A2', title: 'Header', from_ask: id }] }));
  const reply = await post('/_claude/events', { kind: 'item-message', key: `ask:${id}`, text: 'Also the footer' });
  fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(site, 'data', 'threads', `ask__${id}.jsonl`), JSON.stringify({ ts: new Date(Date.now() + 60000).toISOString(), who: 'claude', text: 'Footer too.' }) + '\n');
  assert.deepEqual(await thread(`ask:${id}`), [[id, 'Fix the header', 'answered'], ['#item=t%2FA2', 'Became A2', undefined], [reply.id, 'Also the footer', 'answered'], [null, 'Footer too.', undefined]]);
  assert.deepEqual([await card(), (await board()).moved], [undefined, { [`ask:${id}`]: 't/A2' }]);
  assert.deepEqual(await thread('t/A2'), [[id, 'Fix the header', 'answered'], [reply.id, 'Also the footer', 'answered'], [null, 'Footer too.', undefined]]);
});

test("a Quick build ask carries quick: true to the session, and its thread says so under the ask; a card's Grill and Prototype taps read as request entries", async () => {
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { id } = await post('/_claude/events', { kind: 'ask', text: 'Add a badge', quick: true });
  const logged = fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.id === id);
  assert.deepEqual(logged.data, { text: 'Add a badge', quick: true });
  const thread = async (key) => (await (await fetch(`${base}/api/thread?key=${encodeURIComponent(key)}`)).json()).map((m) => [m.text, Boolean(m.request)]);
  assert.deepEqual(await thread(`ask:${id}`), [['Add a badge', false], ['quick build: no grill, as you asked', true]]);
  const wave = JSON.parse(fs.readFileSync(path.join(site, 'data', 'wave.json'), 'utf8'));
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ ...wave, items: [...wave.items, { id: 'Q1', title: 'Badge', from_ask: id }] }));
  const taps = [await post('/_claude/events', { kind: 'grill-more', key: 't/Q1' }), await post('/_claude/events', { kind: 'prototype-request', key: 't/Q1' })];
  assert.deepEqual(await thread('t/Q1'), [['Add a badge', false], ['quick build: no grill, as you asked', true], ['grill requested', true], ['prototype requested', true]]);
  const card = (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === 't/Q1');
  assert.deepEqual([card.grilling, card.prototyping], [true, true]);
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify(wave));
  for (const e of [{ id }, ...taps]) await post('/api/hide', { id: e.id, hidden: true });
});

test("an ask's Done and a work card's Hold, Resume and Done apply at once from their events, a Hold's chosen time with them", async () => {
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { id } = await post('/_claude/events', { kind: 'ask', text: 'Settings prototype' });
  const card = async () => (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === `ask:${id}`);
  fs.writeFileSync(path.join(site, 'data', 'ask-progress.json'), JSON.stringify({ asks: { [id]: { state: 'progress', at: new Date(Date.now() - 1000).toISOString(), next: 'Pick a take' } } }));
  assert.deepEqual(await card().then((c) => [c.lane, c.next, c.finishable]), ['review', 'Pick a take', true]);
  await post('/_claude/events', { kind: 'ask-done', id });
  assert.deepEqual(await card().then((c) => [c.lane, c.fold, c.finishable]), ['asks', null, false]);
  const work = async () => (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === 't/A2');
  assert.deepEqual(await work().then((c) => [c.lane, c.held, c.finishable]), ['todo', false, true]);
  const filed = () => JSON.parse(fs.readFileSync(path.join(site, 'data', 'wave.json'), 'utf8')).items.find((i) => i.id === 'A2');
  const said = () => fs.readFileSync(path.join(site, 'data', 'threads', 't__A2.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((m) => m.who === 'love').map((m) => m.text);
  await post('/_claude/events', { kind: 'card-hold', key: 't/A2', hold: true });
  assert.equal((await work()).held, true);
  assert.deepEqual([filed().held, filed().pick_up_at], [true, undefined]);
  await post('/_claude/events', { kind: 'card-hold', key: 't/A2', hold: false });
  assert.equal((await work()).held, false);
  const board = await (await fetch(`${base}/api/board`)).json();
  assert.deepEqual(board.holdChoices.map((c) => c.value), ['1h', '3h', '6h', '1d', 'forever']);
  const before = Date.now();
  await post('/_claude/events', { kind: 'card-hold', key: 't/A2', hold: true, for: '3h' });
  const timed = await work();
  assert.equal(timed.held, true);
  assert.ok(Math.abs(Date.parse(timed.heldUntil) - before - 3 * 3_600_000) < 60_000);
  const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
  await post('/_claude/events', { kind: 'card-hold', key: 't/A2', hold: true, for: at });
  assert.equal((await work()).heldUntil, at);
  assert.deepEqual([filed().held, filed().pick_up_at], [true, at]);
  await post('/_claude/events', { kind: 'card-hold', key: 't/A2', hold: true, for: 'forever' });
  assert.deepEqual(await work().then((c) => [c.held, c.heldUntil]), [true, null]);
  const refuse = (choice) => fetch(base + '/_claude/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'card-hold', key: 't/A2', hold: true, for: choice }) });
  for (const choice of [new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 31 * 86_400_000).toISOString(), 'soon']) assert.equal((await refuse(choice)).status, 400, choice);
  const sent = fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.kind === 'card-hold').slice(-3).map((e) => e.data);
  assert.deepEqual(sent, [{ key: 't/A2', hold: true, until: timed.heldUntil }, { key: 't/A2', hold: true, until: at }, { key: 't/A2', hold: true }]);
  await post('/_claude/events', { kind: 'card-hold', key: 't/A2', hold: false });
  await post('/_claude/events', { kind: 'card-done', key: 't/A2' });
  assert.deepEqual(await work().then((c) => [c.lane, c.status, c.finishable]), ['done', 'done', false]);
  assert.deepEqual([filed().status, filed().held], ['done', undefined]);
  const lines = said();
  assert.deepEqual([lines.slice(0, 2), lines.slice(4)], [['Held.', 'Resumed.'], ['Held.', 'Resumed.', 'Marked done.']]);
  assert.match(lines[2], /^Held until .+\.$/);
});

// docs/adr/2026-11-03-0500-every-owner-tap-the-server-can-apply-draws-at-once.md
test("the events POST answers with the board as the tap left it, so a bump, unbump, Hold and Done each draw from the one round trip", async () => {
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'C1', title: 'One' }, { id: 'C2', title: 'Two' }] }));
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const todo = (board) => board.items.filter((i) => i.lane === 'todo').map((i) => [i.id, Boolean(i.bumpedAt)]);
  const first = await (await fetch(`${base}/api/board`)).json();
  const bottom = todo(first).at(-1)[0];
  const bumped = await post({ kind: 'card-bump', key: `t/${bottom}` });
  assert.match(bumped.id, /\S/);
  assert.deepEqual(todo(bumped.board)[0], [bottom, true]);
  assert.ok(bumped.board.generatedAt >= first.generatedAt);
  const unbumped = await post({ kind: 'card-unbump', key: `t/${bottom}` });
  assert.deepEqual(todo(unbumped.board), todo(first));
  const held = await post({ kind: 'card-hold', key: 't/C1', hold: true });
  assert.equal(held.board.items.find((i) => i.id === 'C1').held, true);
  const done = await post({ kind: 'card-done', key: 't/C2' });
  assert.equal(done.board.items.find((i) => i.id === 'C2').lane, 'done');
  const said = await post({ kind: 'message', text: 'Hello' });
  assert.deepEqual(Object.keys(said).sort(), ['board', 'id']);
});

// docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md
test("a Hold or Done whose wave file couldn't be written is refused with why and records no event, as is one on a merged card", async () => {
  const wave = path.join(site, 'data', 'wave.json');
  fs.writeFileSync(wave, JSON.stringify({ items: [{ id: 'W1', title: 'One' }] }));
  const post = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  const logged = () => fs.readFileSync(path.join(site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').length;
  const before = logged();
  // The wave file's write goes through a temp file named for the server's pid; a folder in its place fails it.
  const blocker = path.join(site, 'data', `wave.json.${child.pid}.tmp`);
  fs.mkdirSync(blocker);
  try {
    for (const tap of [{ kind: 'card-hold', key: 't/W1', hold: true }, { kind: 'card-done', key: 't/W1' }]) {
      const [status, out] = await post(tap);
      assert.equal(status, 500, tap.kind);
      assert.match(out.error, /^Couldn’t write t\/W1 to its wave file: EISDIR/, tap.kind);
    }
  } finally { fs.rmdirSync(blocker); }
  assert.equal(logged(), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(wave, 'utf8')).items[0], { id: 'W1', title: 'One' });
  fs.writeFileSync(wave, JSON.stringify({ items: [{ id: 'W1', title: 'One', status: 'merged' }] }));
  assert.deepEqual(await post({ kind: 'card-done', key: 't/W1' }), [400, { error: 't/W1 is already merged or dropped, so its wave file stays as it is.' }]);
  assert.equal(logged(), before);
  const [held] = await post({ kind: 'card-hold', key: 't/W1', hold: true });
  assert.equal(held, 400);
  // A merged card waiting on its owner step closes on the owner's Done.
  fs.writeFileSync(wave, JSON.stringify({ items: [{ id: 'W1', title: 'One', status: 'merged', owner_step: 'Tag the first release' }] }));
  const [status, out] = await post({ kind: 'card-done', key: 't/W1' });
  assert.equal(status, 200, out.error);
  assert.equal(out.board.items.find((i) => i.id === 'W1').lane, 'done');
  assert.deepEqual((({ status: s, owner_step }) => [s, owner_step])(JSON.parse(fs.readFileSync(wave, 'utf8')).items[0]), ['merged', undefined]);
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

test('a watcher that just exited on an event still counts as listening, until its session stops', async () => {
  const session = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(session.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim();
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${session.pid}.json`), JSON.stringify({ pid: session.pid, sessionId: 's1', cwd: home, procStart, kind: 'bg' }));
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
  const cmd = [process.execPath, path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site];
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'manifest.json'), JSON.stringify({ sites: { t: { dir: site, port: 1, cmd, owner: { session: 's1' } } } }));
  fs.writeFileSync(path.join(site, 'data', 'checked.json'), JSON.stringify({ at: new Date().toISOString(), every: 30 }));
  const watcher = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wait-events.mjs'), 't', 's1'], { env: { ...process.env, HOME: home } });
  const out = [];
  watcher.stdout.on('data', (c) => out.push(String(c)));
  const exited = new Promise((resolve) => watcher.once('exit', resolve));
  await until(() => {
    try { return JSON.parse(fs.readFileSync(path.join(site, 'data', 'watcher.json'), 'utf8')).pid === watcher.pid && fs.existsSync(path.join(site, 'data', '.watch-cursor-s1.json')); } catch { return false; }
  }, 'watcher did not initialize its cursor');
  await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ask', text: 'Wake' }) });
  assert.equal(await exited, 0);
  assert.match(out.join(''), /^event data\/events\.jsonl /);
  const w = JSON.parse(fs.readFileSync(path.join(site, 'data', 'watcher.json'), 'utf8'));
  assert.ok(Date.parse(w.exited_at) >= Date.parse(w.since));
  assert.equal((await (await fetch(`${base}/api/board`)).json()).checks.watcher, 'running');
  const stopped = new Promise((resolve) => session.once('exit', resolve));
  session.kill();
  await stopped;
  assert.equal((await (await fetch(`${base}/api/board`)).json()).checks.watcher, 'stopped');
});

test("the board lists each agent's record on an item, and the item's thread shows when each started and finished among its lines", async () => {
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'A3', title: 'Three', status: 'building' }] }));
  fs.mkdirSync(path.join(site, 'data', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(site, 'data', 'agents', 'A3.json'), JSON.stringify({ label: 'Opus builder', kind: 'opus', started: '2026-10-23T10:00:00Z', done: '2026-10-23T10:30:00Z' }));
  fs.writeFileSync(path.join(site, 'data', 'agents', 'A3@bench.json'), JSON.stringify({ kind: 'codex', started: '2026-10-23T10:05:00Z', eta: '2026-10-23T16:30:00Z' }));
  fs.writeFileSync(path.join(site, 'data', 'threads', 't__A3.jsonl'), [
    { ts: '2026-10-23T10:00:00Z', who: 'claude', kind: 'status', text: 'Planning' },
    { ts: '2026-10-23T10:06:00Z', who: 'claude', kind: 'status', text: 'Codex: Running benchmarks' },
    { ts: '2026-10-23T10:10:00Z', who: 'claude', text: 'Halfway.' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
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
});

test("the board lists its own title and reviewers from board.json, whatever its waves hold", async () => {
  const cfg = { title: 'T', items: 'data/wave.json', slug: 't' };
  const board = async () => (await (await fetch(`${base}/api/board`)).json());
  const reviewers = async () => (await board()).reviewers;
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ reviewers: [{ name: 'Bob', slack_user: 'U2', dm: 'D2', github: 'bob' }], items: [{ id: 'R1', title: 'R' }] }));
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
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [
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

test("the board, its Settings, Waiting on you and Notes serve the app shell, with no sidebar for shell.js to fetch, and a site's own page still renders the shared header", async () => {
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
  fs.writeFileSync(path.join(pub, 'prototype-hdr.html'), '<title>{{title}}</title><!--header {"lead":"back","title":"Take","backHref":"./#item=t%2FP1"}-->');
  try {
    const page = await (await fetch(`${base}/prototype-hdr.html`)).text();
    assert.match(page, /^<title>T<\/title><header class="top"><div class="brand"><a class="hub" href="[^"]*" aria-label="Boards"><img[^>]*><\/a><a class="back" href="\.\/#item=t%2FP1" aria-label="Back to the board">/);
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
    assert.match(page, /<header class="top"><div class="brand"><a class="hub" href="[^"]*" aria-label="Boards"><img[^>]*><\/a><a class="back" href="\.\/#item=t%2FP1" aria-label="Back to the board">[\s\S]*<h1>Moon &lt;\/script&gt;&lt;b&gt; · prototype<\/h1>/);
    const json = /<script id="prototypeData" type="application\/json">(.*?)<\/script>/.exec(page)[1];
    assert.doesNotMatch(json, /</);
    const data = JSON.parse(json);
    assert.equal(data.title, 'Moon </script><b>');
    assert.deepEqual(data.takes.map((t) => [t.key, t.label, /^prototypes\/moon\/A\.js\?v=[\w-]+$/.test(t.src ?? ''), t.file]), [['A', 'Tap <it>', true, 'prototypes/moon/A.js'], ['B', 'Hover', false, 'prototypes/moon/B.js']]);
    assert.match(page, /<main class="proto-main"><div id="stage"><\/div><\/main>/);
    assert.match(page, /#stage \{[^}]*contain: layout paint; transform: translateZ\(0\); isolation: isolate; overflow-x: clip;/);
    for (const script of ['claude.js', 'ui-page-header.js', 'ui-sidebar.js', 'ui-hub.js', 'ui-cards.js', 'prototype-switcher.js', 'prototype-kit.js']) assert.match(page, new RegExp(`<script src="${script.replace('.', '\\.')}\\?v=`), script);
    const plain = await (await fetch(`${base}/prototype-plain.html`)).text();
    assert.match(plain, /<a class="back" href="\.\/" aria-label="Back to the board">/);
    assert.equal(await (await fetch(`${base}/prototype-written.html`)).text(), '<p>Hand-written</p>');
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

test('the board, a thread and the static files come gzipped when the browser accepts it, and the API stays uncached', async () => {
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: Array.from({ length: 30 }, (_, n) => ({ id: `G${n}`, title: `Gzip card ${n}` })) }));
  fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(site, 'data', 'threads', 't__G1.jsonl'), Array.from({ length: 20 }, (_, n) => JSON.stringify({ ts: '2026-10-23T10:00:00Z', who: 'claude', text: `Line ${n} of a long thread` })).join('\n') + '\n');
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

test('the stream sends a change, uncompressed, after a write to a thread or a wave file, also once a rename replaced the file, and in a folder made after the stream opened', async () => {
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
    const nextChange = async () => {
      const seen = changes();
      await until(() => changes() > seen, 'the board stream sends a change after a file write');
    };
    await until(() => text.includes('retry: 3000\n\n'), 'the board change stream opens');
    fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
    for (const write of [
      () => fs.appendFileSync(path.join(site, 'data', 'threads', 't__S1.jsonl'), JSON.stringify({ ts: new Date().toISOString(), who: 'claude', text: 'Live' }) + '\n'),
      () => fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'S1', title: 'Streamed' }] })),
      () => { fs.writeFileSync(path.join(site, 'data', 'wave.json.tmp'), JSON.stringify({ items: [{ id: 'S1', title: 'Renamed' }] })); fs.renameSync(path.join(site, 'data', 'wave.json.tmp'), path.join(site, 'data', 'wave.json')); },
      () => fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'S1', title: 'In place' }] })),
      () => fs.mkdirSync(path.join(site, 'data', 'streamed', 'deeper'), { recursive: true }),
      () => fs.writeFileSync(path.join(site, 'data', 'streamed', 'deeper', 'note.json'), '{}'),
    ]) {
      const signal = nextChange();
      write();
      await signal;
    }
  } finally { req.destroy(); }
});

test('with thousands of folders and lock folders coming and going, the board answers at once, sends no change for the locks and still sends one for a write in a normal folder', async (t) => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'board-churn-'));
  const data = path.join(own, 'site', 'data');
  for (let w = 0; w < 20; w++) {
    for (let i = 0; i < 150; i++) fs.mkdirSync(path.join(data, `w${w}`, 'dd', 'Build', `m${i}`), { recursive: true });
    for (let i = 0; i < 50; i++) fs.mkdirSync(path.join(data, `w${w}`, 'attachments', `a${i}`), { recursive: true });
    for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(data, `w${w}`, '.installs', `i${i}`), { recursive: true });
  }
  fs.writeFileSync(path.join(own, 'site', 'board.json'), JSON.stringify({ title: 'T', items: 'data/wave.json', slug: 't' }));
  const [port] = await freePorts();
  const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), path.join(own, 'site')], { env: { ...process.env, HOME: own, PORT: String(port), PREFIX: '' } });
  const exited = new Promise((resolve) => server.once('exit', resolve));
  let req, churn;
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('exit', reject); });
    req = http.get(`http://127.0.0.1:${port}/api/stream`);
    const res = await new Promise((resolve, reject) => req.once('response', resolve).once('error', reject));
    res.setEncoding('utf8');
    let text = '';
    res.on('data', (c) => { text += c; });
    const changes = () => text.split('\n\n').filter((block) => /^event: change$/m.test(block)).length;
    await until(() => text.includes('retry: 3000\n\n'), 'the board change stream opens');
    await until(() => fs.existsSync(path.join(data, 'action-pushes.json')), 'the first Action needed check');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const settled = changes();
    churn = spawn(process.execPath, ['-e', `
      const fs = require('fs'), path = require('path');
      let n = 0;
      const tick = () => {
        for (let k = 0; k < 20; k++, n++) {
          const locks = path.join(${JSON.stringify(data)}, 'w' + (n % 20), '.locks');
          fs.mkdirSync(path.join(locks, 'l' + n), { recursive: true });
          fs.rmSync(locks, { recursive: true, force: true });
        }
        setTimeout(tick, 1);
      };
      tick();`], { stdio: 'ignore' });

    const BUDGET = 250;
    let slowest = 0;
    for (const end = Date.now() + 3000; Date.now() < end;) {
      const start = Date.now();
      const answer = await fetch(`http://127.0.0.1:${port}/_claude/health`, { signal: AbortSignal.timeout(BUDGET * 5) });
      assert.equal(answer.status, 200);
      slowest = Math.max(slowest, Date.now() - start);
    }
    t.diagnostic(`slowest health answer during churn: ${slowest} ms`);
    if (slowest > BUDGET) console.warn(`the board answered in ${slowest} ms during churn, over its ${BUDGET} ms budget`);
    assert.equal(changes(), settled, 'lock folders coming and going send no change');

    fs.writeFileSync(path.join(data, 'w3', 'attachments', 'a7', 'note.json'), '{}');
    await until(() => changes() > settled, 'a write in a normal folder sends a change during churn', 5000);
  } finally {
    req?.destroy();
    churn?.kill();
    server.kill(); await exited;
    fs.rmSync(own, { recursive: true, force: true });
  }
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
  const cfg = { title: 'T', items: 'data/wave.json', slug: 't' };
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
    assert.equal(r.status, 200);
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
  const cfg = { title: 'T', items: 'data/wave.json', slug: 't' };
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, rules: [{ id: 'r1', text: 'Ask first', by: 'owner', at: 'x' }] }));
  const save = (body) => fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const settingsEvents = async () => (await (await fetch(`${base}/_claude/events?kind=settings`)).json()).map((e) => e.data);
  const checks = async () => (await (await fetch(`${base}/_claude/events?kind=check-github`)).json()).map((e) => e.data);
  const before = (await checks()).length;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/settings`)).json(), { settings: { auto_merge: false, auto_build: false, auto_pull: false, max_implementers: 10, auto_triage: false, auto_review: false, headless_builders: false, idle_notification: false } });
    const on = await save({ auto_merge: true });
    assert.equal(on.status, 200);
    const out = await on.json();
    assert.deepEqual(out.settings, { auto_merge: true, auto_build: false, auto_pull: false, max_implementers: 10, auto_triage: false, auto_review: false, headless_builders: false, idle_notification: false });
    assert.match(out.id, /^e/);
    const written = JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8'));
    assert.deepEqual([written.title, written.rules.length, written.auto_merge], ['T', 1, true]);
    assert.deepEqual(await settingsEvents(), [{ auto_merge: true }]);
    assert.deepEqual((await checks()).slice(before), [{ reason: 'auto-merge' }]);
    assert.equal((await save({ auto_build: true })).status, 200);
    assert.equal((await (await fetch(`${base}/api/settings`)).json()).settings.auto_build, true);
    assert.deepEqual((await settingsEvents())[0], { auto_build: true });
    assert.equal((await (await save({ auto_merge: true })).json()).id, null);
    for (const bad of [{ auto_merge: 'yes' }, { auto_build: 'yes' }, { auto_deploy: true }, {}, ['x']]) assert.equal((await save(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await settingsEvents()).length, 2);
    assert.equal((await save({ auto_merge: false })).status, 200);
    assert.equal((await checks()).length, before + 1);
    assert.equal((await save({ auto_merge: true })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8')).auto_merge, true);
    fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One', ticket: 'INT-3' }, { id: 'B2', title: 'Two', ticket: 'OPS-4' }] }));
    const internal = await (await save({ tickets: { source: 'internal', prefix: 'OPS' } })).json();
    assert.deepEqual(internal.settings.tickets, { source: 'internal', prefix: 'OPS' });
    const cards = (await (await fetch(`${base}/api/board`)).json()).items;
    assert.deepEqual(['A1', 'B2'].map((id) => cards.find((i) => i.id === id).ticket), [{ id: 'INT-3', url: null, source: null }, { id: 'OPS-4', url: '#item=t%2FB2', source: 'internal' }]);
    assert.equal((await (await save({ tickets: { source: 'internal', prefix: 'OPS' } })).json()).id, null);
    assert.equal((await save({ tickets: { source: 'internal', prefix: 'bad1' } })).status, 400);
    assert.deepEqual((await settingsEvents()).find((e) => e.tickets), { tickets: { source: 'internal', prefix: 'OPS' } });
  } finally {
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify(cfg));
  }
});

test('try forwards only the board route and key over loopback, returning hub starts and refusals', async () => {
  const [port] = await freePorts();
  const seen = [];
  let refuse = false;
  const hub = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push([req.url, JSON.parse(body), req.headers]);
    res.writeHead(refuse ? 409 : 202, { 'content-type': 'application/json' });
    res.end(JSON.stringify(refuse ? { error: 'Already running' } : { status: 'started' }));
  });
  await new Promise((resolve, reject) => hub.once('error', reject).listen(port, '127.0.0.1', resolve));
  const [boardPort] = await freePorts();
  const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], {
    env: { ...process.env, HOME: home, PORT: String(boardPort), PREFIX: '/own-route', KICKFLIP_HUB_PORT: String(port) },
  });
  const exited = new Promise((resolve) => server.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('exit', reject); });
    const post = (body) => fetch(`http://127.0.0.1:${boardPort}/api/try`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-host': 'mac.example' }, body: JSON.stringify(body) });
    assert.equal((await post({ key: 't/A1' })).status, 202);
    assert.deepEqual(seen[0].slice(0, 2), ['/_hub/build', { route: 'own-route', key: 't/A1' }]);
    assert.equal(seen[0][2]['x-forwarded-host'], undefined);
    assert.equal((await post({ key: 'main' })).status, 202);
    assert.deepEqual(seen[1].slice(0, 2), ['/_hub/build', { route: 'own-route', key: 'main' }]);
    const logURL = `http://127.0.0.1:${boardPort}/api/try/main/log`;
    const absent = await fetch(logURL);
    assert.equal(absent.status, 200);
    assert.deepEqual(await absent.json(), { lines: [] });
    fs.mkdirSync(path.join(site, 'data/try'), { recursive: true });
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`);
    fs.writeFileSync(path.join(site, 'data/try/main.log'), 'x'.repeat(100_000) + '\n' + lines.join('\n') + '\n');
    const tail = await fetch(logURL);
    assert.equal(tail.status, 200);
    assert.deepEqual(await tail.json(), { lines: lines.slice(-40) });
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
  } finally {
    server.kill(); await exited;
    await new Promise((resolve) => { hub.closeAllConnections(); hub.close(resolve); });
  }
});

test('the board snapshot reads try.json and main.json and ignores the old install_script setting', async () => {
  const config = path.join(site, 'board.json');
  const previous = fs.readFileSync(config, 'utf8');
  try {
    fs.writeFileSync(config, JSON.stringify({ title: 'T', items: 'data/wave.json', slug: 't', install_script: '/ignored' }));
    fs.writeFileSync(path.join(site, 'data/wave.json'), JSON.stringify({ items: [{ id: 'A1', title: 'One' }] }));
    fs.writeFileSync(path.join(site, 'data/try.json'), JSON.stringify({ kind: 'app', main: { sha: 'abcdef123', branch: 'main', slug: 'o/r', at: '2026-11-01', script: true, state: 'ready' }, cards: { 't/A1': { head: 'abc123456', sha: 'abc1234', state: 'running', ahead: 1, script: true } } }));
    fs.writeFileSync(path.join(site, 'data/main.json'), JSON.stringify({ install: { url: 'https://example.com/main.apk' } }));
    const board = await (await fetch(`${base}/api/board`)).json();
    assert.equal(board.main.url, 'https://example.com/main.apk');
    assert.equal(board.main.sha, 'abcdef1');
    assert.deepEqual(board.items.find((i) => i.key === 't/A1').try, { kind: 'app', state: 'running', stale: false, url: null, port: null, sha: null, changes: true, script: true, autoBuild: false });
    fs.writeFileSync(config, JSON.stringify({ title: 'T', items: 'data/wave.json', slug: 't', auto_build: true }));
    assert.equal((await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === 't/A1').try.autoBuild, true);
    fs.writeFileSync(path.join(site, 'data/try.json'), JSON.stringify({ kind: 'web', main_port: 8500, main: { sha: 'abcdef123', script: true, state: 'ready', https: 8500 }, cards: { 't/A1': { sha: 'abc1234', state: 'ready', https: 8501 } } }));
    const web = await (await fetch(`${base}/api/board`)).json();
    assert.equal(web.main.url, null);
    assert.equal(web.main.port, 8500);
    assert.equal(web.items.find((i) => i.key === 't/A1').try.url, null);
    assert.equal(web.items.find((i) => i.key === 't/A1').try.port, 8501);
    assert.equal((await fetch(`${base}/api/install-script`)).status, 404);
  } finally {
    fs.writeFileSync(config, previous);
    fs.rmSync(path.join(site, 'data/try.json'), { force: true });
    fs.rmSync(path.join(site, 'data/main.json'), { force: true });
  }
});

test('the watcher prints the hub rules, then the board rules, the board settings and the quiet line, after each event line and its plain line, and answers a hub hello', async () => {
  const cfg = { title: 'T', items: 'data/wave.json', slug: 't' };
  const web = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'manifest.json'), JSON.stringify({ sites: { t: { dir: site } } }));
  fs.writeFileSync(path.join(web, 'settings.json'), JSON.stringify({ polling: {}, rules: [{ id: 'h1', text: 'Screenshots in every PR', by: 'owner', at: 'x' }] }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, rules: [{ id: 'b1', text: 'Ask before\ntouching main', by: 'claude', at: 'x' }, { text: 'no id' }] }));
  const ask = () => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ask', text: 'Wake' }) });
  const watch = async (session, wake = ask) => {
    ownSession(home, session);
    const watcher = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wait-events.mjs'), 't', session], { env: { ...process.env, HOME: home } });
    const out = [];
    watcher.stdout.on('data', (c) => out.push(String(c)));
    const exited = new Promise((resolve) => watcher.once('exit', resolve));
    await until(() => fs.existsSync(path.join(site, 'data', `.watch-cursor-${session}.json`)), 'watcher did not initialize its cursor');
    await wake();
    assert.equal(await exited, 0);
    return out.join('').trim().split('\n');
  };
  try {
    const lines = await watch('rules1');
    assert.match(lines[0], /^event data\/events\.jsonl /);
    assert.match(lines[1], /^new task \S+ received$/);
    const asked = lines[1].split(' ')[2];
    assert.ok(Date.parse(JSON.parse(fs.readFileSync(path.join(site, 'data', 'working.json'), 'utf8')).events[asked]));
    assert.equal((await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === `ask:${asked}`).working, true);
    assert.deepEqual((await (await fetch(`${base}/api/working`)).json()).working.filter((w) => w.id === asked).map(({ since, ...w }) => w), [{ id: asked, kind: 'ask', card: null }]);
    assert.match(lines.at(-1), /^quiet .*AskUserQuestion/);
    assert.deepEqual(lines.slice(2, -1), ['rule hub Screenshots in every PR', 'rule board Ask before touching main', 'setting auto-merge off', 'setting auto-build off', 'setting auto-pull off', 'setting max-implementers 10', 'setting auto-triage off', 'setting auto-review off', 'setting headless-builders off', 'setting idle-notification off']);
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, auto_merge: true }));
    fs.rmSync(path.join(web, 'settings.json'));
    assert.deepEqual((await watch('rules2')).slice(2, -1), ['setting auto-merge on', 'setting auto-build off', 'setting auto-pull off', 'setting max-implementers 10', 'setting auto-triage off', 'setting auto-review off', 'setting headless-builders off', 'setting idle-notification off']);
    const hello = () => fs.appendFileSync(path.join(site, 'data', 'events.jsonl'), JSON.stringify({ id: 'hello1', ts: new Date().toISOString(), kind: 'hello', data: { title: 'T' } }) + '\n');
    assert.equal((await watch('hello', hello))[1], 'hello hello1 from the hub answered');
    assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'data', 'handshake.json'), 'utf8')).ack.id, 'hello1');
    // docs/adr/2026-11-03-1551-an-idle-board-triages-its-todo-once-a-day.md
    const triage = () => fs.appendFileSync(path.join(site, 'data', 'events.jsonl'), JSON.stringify({ id: 'tt1', ts: new Date().toISOString(), kind: 'todo-triage', data: { date: '2026-11-03', topic: 'todo-triage-2026-11-03' } }) + '\n');
    assert.equal((await watch('triage', triage))[1], 'Todo triage 2026-11-03 asked: the board was idle');
    assert.ok(Date.parse(JSON.parse(fs.readFileSync(path.join(site, 'data', 'working.json'), 'utf8')).events.tt1));
  } finally {
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify(cfg));
    fs.rmSync(path.join(web, 'settings.json'), { force: true });
  }
});

test('a builder nudge is recorded even when the card is no longer stalled', async () => {
  const response = await fetch(`${base}/_claude/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'builder-nudge', key: 't/A1' }),
  });
  const { id } = await response.json();
  const events = await (await fetch(`${base}/_claude/events?kind=builder-nudge`)).json();
  assert.deepEqual(events.map((e) => [e.id, e.data]), [[id, { key: 't/A1' }]]);
});

test("a wave's triage runs from its wave-triage event until Claude replies, and its notes show its goal, order and note", async () => {
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ internal: true, items: [{ id: 'S1', title: 'One' }, { id: 'S2', title: 'Two', deps: ['S1'] }],
    lineups: [{ slug: 'mon', title: 'Monitor', goal: 'Runs in kickflip.', items: ['S1', 'S2'] }] }));
  fs.writeFileSync(path.join(site, 'data', 'lineup-mon.md'), 'Why: one PR each.\n');
  const row = async () => (await (await fetch(`${base}/api/board`)).json()).waveBands[0];
  assert.deepEqual((await row()).triage, { running: false, questions: 0 });
  const { id } = await (await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'wave-triage', lineup: 'mon' }) })).json();
  assert.equal((await row()).triage.running, true);
  fs.writeFileSync(path.join(site, 'data', 'replies', `${id}.html`), 'No changes.');
  assert.equal((await row()).triage.running, false);
  const notes = await fetch(`${base}/api/notes?wave=mon`);
  assert.deepEqual(await notes.json(), { title: 'Monitor', markdown: '**Goal** Runs in kickflip.\n\n**Order** INT-1 → INT-2\n\nWhy: one PR each.\n' });
  assert.equal((await fetch(`${base}/api/notes?wave=nope`)).status, 404);
});

// docs/adr/2026-11-03-1840-waves-are-bands-in-todo.md
test("a lineup-move tap reorders the wave's unstarted cards, chains them again and answers with the board, appending no event; a move past the end is refused", async () => {
  const waveFile = path.join(site, 'data', 'wave.json');
  const saved = fs.readFileSync(waveFile, 'utf8');
  fs.writeFileSync(waveFile, JSON.stringify({ internal: true, items: [{ id: 'M1', title: 'One' }, { id: 'M2', title: 'Two', deps: ['M1'] }, { id: 'M3', title: 'Three', deps: ['M2'] }],
    lineups: [{ slug: 'mv', title: 'Move', goal: 'G', items: ['M1', 'M2', 'M3'] }] }));
  const move = (key, by) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'lineup-move', lineup: 'mv', key, by }) });
  const before = (await (await fetch(`${base}/_claude/events`)).json()).length;
  try {
    const r = await move('t/M3', -1);
    assert.equal(r.status, 200);
    const { id, board } = await r.json();
    assert.equal(id, null);
    assert.deepEqual(board.waveBands[0].keys, ['t/M1', 't/M3', 't/M2']);
    const wave = JSON.parse(fs.readFileSync(waveFile, 'utf8'));
    assert.deepEqual([wave.lineups[0].phases, wave.items.map((it) => it.deps || [])], [[['M1'], ['M3'], ['M2']], [[], ['M3'], ['M1']]]);
    const refused = await move('t/M1', -1);
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /can't move/);
    assert.equal((await (await fetch(`${base}/_claude/events`)).json()).length, before);
  } finally {
    fs.writeFileSync(waveFile, saved);
  }
});

test("/api/board names a card's worktree while its folder exists, and says whether the request's browser runs on the host", async () => {
  const waveFile = path.join(site, 'data', 'wave.json');
  const agents = path.join(site, 'data', 'agents');
  const kept = path.join(home, 'worktrees', 'V1');
  const saved = fs.readFileSync(waveFile, 'utf8');
  fs.mkdirSync(kept, { recursive: true });
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(waveFile, JSON.stringify({ items: [{ id: 'V1', title: 'Kept', status: 'building' }, { id: 'V2', title: 'Landed', status: 'building' }] }));
  const record = (dir) => JSON.stringify({ label: 'Opus builder', kind: 'claude', started: new Date().toISOString(), worktree: { path: dir, branch: 'x', repo: home } });
  fs.writeFileSync(path.join(agents, 'V1.json'), record(kept));
  fs.writeFileSync(path.join(agents, 'V2.json'), record(path.join(home, 'worktrees', 'V2')));
  const board = async (headers = {}) => (await fetch(`${base}/api/board`, { headers })).json();
  try {
    const b = await board();
    assert.deepEqual([b.onHost, b.items.find((i) => i.id === 'V1').worktree, b.items.find((i) => i.id === 'V2').worktree], [true, kept, null]);
    assert.equal((await board({ 'x-forwarded-for': '127.0.0.1' })).onHost, true);
    assert.equal((await board({ 'x-forwarded-for': '100.70.1.2' })).onHost, false);
  } finally {
    fs.writeFileSync(waveFile, saved);
    for (const id of ['V1', 'V2']) fs.rmSync(path.join(agents, `${id}.json`), { force: true });
  }
});

test("/api/permissions writes the board folder's settings.local.json from the host, and reads them anywhere else", async () => {
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  const folder = path.join(home, 'perm-repo');
  const local = path.join(folder, '.claude', 'settings.local.json');
  fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
  fs.writeFileSync(local, JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { site: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], local: true, owner: { repo: folder } } } }));
  const get = async (headers = {}) => (await fetch(`${base}/api/permissions`, { headers })).json();
  const set = (body, headers = {}) => fetch(`${base}/api/permissions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const away = { 'x-forwarded-for': '100.70.1.2' };
  try {
    const first = await get();
    assert.deepEqual([first.onHost, first.file, first.permissions.map((p) => [p.id, p.on])], [true, local, [['pushMain', false], ['pushTags', false], ['draftPr', false]]]);
    assert.equal((await get(away)).onHost, false);
    const refused = await set({ id: 'pushTags', on: true }, away);
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /Change on the host/);
    assert.deepEqual(JSON.parse(fs.readFileSync(local, 'utf8')), { permissions: { allow: ['Bash(npm test)'] } });
    const on = await set({ id: 'pushTags', on: true });
    assert.equal(on.status, 200);
    assert.deepEqual((await on.json()).permissions.map((p) => [p.id, p.on]), [['pushMain', false], ['pushTags', true], ['draftPr', false]]);
    assert.deepEqual(JSON.parse(fs.readFileSync(local, 'utf8')), { permissions: { allow: ['Bash(npm test)', 'Bash(git push origin v*)'] } });
    assert.equal((await set({ id: 'nope', on: true })).status, 400);
    assert.equal((await set({ id: 'pushTags', on: false })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(local, 'utf8')), { permissions: { allow: ['Bash(npm test)'] } });
    fs.rmSync(manifest);
    assert.equal((await fetch(`${base}/api/permissions`)).status, 404);
  } finally {
    fs.rmSync(manifest, { force: true });
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// docs/adr/2026-11-04-0119-the-board-server-removes-reviewers-itself.md
test("Save on the settings page's reviewers removes names in the server, records reviewers-removed, and leaves only an add for the session", async () => {
  const cfg = { title: 'T', items: 'data/wave.json', slug: 't' };
  const ann = { name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' }, bob = { name: 'Bob', slack_user: 'U2', dm: 'D2', github: 'bob' };
  const read = (file) => JSON.parse(fs.readFileSync(path.join(site, file), 'utf8'));
  const send = (body) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'reviewers', ...body }) });
  const events = async (kind) => (await (await fetch(`${base}/_claude/events?kind=${kind}`)).json()).map((e) => e.data);
  const waveFile = path.join(site, 'data', 'wave.json');
  const wavePrev = fs.existsSync(waveFile) ? fs.readFileSync(waveFile) : null;
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, reviewers: [ann, bob] }));
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ reviewers: [ann, bob], items: [{ id: 'R1', title: 'R', status: 'planned' }] }));
  try {
    const before = [(await events('reviewers')).length, (await events('reviewers-removed')).length];
    const r = await send({ add: ['Cy'], remove: ['ann'] });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.deepEqual(out.board.reviewers, ['Bob']);
    assert.deepEqual([read('board.json').reviewers, read('board.json').title, read('data/wave.json').reviewers], [[bob], 'T', [bob]]);
    const [added, gone] = [await events('reviewers'), await events('reviewers-removed')];
    assert.deepEqual([added.length, added[0], gone.length, gone[0]], [before[0] + 1, { add: ['Cy'] }, before[1] + 1, { remove: ['ann'] }]);

    const removed = await (await send({ add: [], remove: ['Bob'] })).json();
    assert.deepEqual([removed.board.reviewers, read('board.json').reviewers], [[], []]);
    assert.equal((await events('reviewers')).length, before[0] + 1, 'a remove alone records no reviewers event for the session');
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
    if (wavePrev) fs.writeFileSync(waveFile, wavePrev); else fs.rmSync(waveFile, { force: true });
  }
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

test("/api/board carries its version as its ETag: a reload naming it answers 304 with no body until the board changes, and an events POST's board carries the version the next reload has", async () => {
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'E1', title: 'Tagged' }, { id: 'E2', title: 'Other' }] }));
  const first = await raw('/api/board', { 'accept-encoding': 'gzip' });
  const tag = first.headers.etag;
  const body = JSON.parse(zlib.gunzipSync(first.body));
  assert.equal(tag, `W/"${body.version}"`);
  assert.match(body.version, /^[\w-]{8,}$/);
  const again = await raw('/api/board', { 'accept-encoding': 'gzip', 'if-none-match': `"${body.version}"` });
  assert.deepEqual([again.status, again.body.length, again.headers.etag, again.headers['cache-control']], [304, 0, tag, 'no-store']);
  const posted = await (await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'card-bump', key: 't/E2' }) })).json();
  assert.notEqual(posted.board.version, body.version);
  assert.equal(posted.board.onHost, true);
  const stale = await raw('/api/board', { 'if-none-match': tag });
  assert.equal(stale.status, 200);
  assert.equal(JSON.parse(stale.body).version, posted.board.version);
  assert.equal((await raw('/api/board', { 'if-none-match': `"${posted.board.version}"` })).status, 304);
});

test("a reload naming its version since gets a patch of the cards that changed, a tap naming it gets one too, and a version the server no longer holds gets the whole board", async () => {
  const vmContext = (await import('node:vm')).createContext({});
  (await import('node:vm')).runInContext(fs.readFileSync(new URL('./public/ui-patch.js', import.meta.url), 'utf8'), vmContext);
  const { applyPatch } = vmContext.BoardUI;
  const content = (b) => { const { generatedAt: _, ...rest } = JSON.parse(JSON.stringify(b)); return rest; };
  const get = async (q = '') => (await fetch(`${base}/api/board${q}`)).json();
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'F1', title: 'Patched' }, { id: 'F2', title: 'Still' }, { id: 'F3', title: 'Gone soon' }] }));
  const first = await get();
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'F1', title: 'Patched again' }, { id: 'F2', title: 'Still' }] }));
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

  const unknown = await get('?since=nothing-kept');
  assert.equal(unknown.since, undefined);
  assert.ok(Array.isArray(unknown.items));
});

test("a card's question topic in the page's board carries no title of its own: the page names it from its card", async () => {
  const ownerFile = path.join(site, 'data', 'owner.json');
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'G1', title: 'Asked' }] }));
  fs.writeFileSync(ownerFile, JSON.stringify({ topics: [{ id: 'plan', title: 'Plan', summary: 'Kept' }], items: [{ id: 'g1', topic: 'item:t/G1', question: 'Which?', options: [{ id: 'A', label: 'This' }] }, { id: 'g2', topic: 'plan', question: 'Ship?', options: [{ id: 'A', label: 'Yes' }] }] }));
  try {
    const b = await (await fetch(`${base}/api/board`)).json();
    assert.deepEqual(b.ownerTopics.map((t) => [t.id, t.card, t.title, t.summary]), [['plan', undefined, 'Plan', 'Kept'], ['item:t/G1', 't/G1', undefined, undefined]]);
  } finally { fs.writeFileSync(ownerFile, '{"items":[]}'); }
});

test("the board's version depends on its data alone: a minute later with nothing changed it is the same, and the Hold choices carry their lengths, not clock words", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-version-')));
  const at = path.join(dir, 'site');
  fs.mkdirSync(path.join(at, 'data'), { recursive: true });
  fs.writeFileSync(path.join(at, 'board.json'), JSON.stringify({ title: 'V', items: 'data/wave.json', slug: 'v' }));
  fs.writeFileSync(path.join(at, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'V1', title: 'Todo' }, { id: 'V2', title: 'Held', held: true }] }));
  const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import http from 'node:http';
      import { mock } from 'node:test';
      mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T10:00:20Z') });
      let server;
      mock.method(http.Server.prototype, 'listen', function () { server = this; return this; });
      process.argv[2] = ${JSON.stringify(at)};
      await import(${JSON.stringify(server)});
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
    `], { env: { ...process.env, HOME: dir }, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.notEqual(out.times[0], out.times[1]);
    assert.equal(out.versions[0], out.versions[1]);
    assert.deepEqual(out.holdChoices, [{ value: '1h', label: '1h', ms: 3_600_000 }, { value: '3h', label: '3h', ms: 10_800_000 }, { value: '6h', label: '6h', ms: 21_600_000 },
      { value: '1d', label: '1d', ms: 86_400_000 }, { value: 'forever', label: 'Forever', ms: null }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// docs/adr/2026-11-04-0257-an-idle-board-pushes-once-when-it-has-gone-idle.md
test('with Idle notification on, the board pushes "<board> has gone idle" once 15 minutes into an idle stretch, with what closed since, and again only after it was busy', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-idle-')));
  const at = path.join(dir, 'site');
  fs.mkdirSync(path.join(at, 'data'), { recursive: true });
  fs.writeFileSync(path.join(at, 'board.json'), JSON.stringify({ title: 'Idle board', items: 'data/wave.json', slug: 'i', idle_notification: true }));
  fs.writeFileSync(path.join(at, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'I1', title: 'Open' }] }));
  fs.writeFileSync(path.join(dir, 'push-stub.mjs'), "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(3)) + '\\n'); console.log('sent');");
  const calls = path.join(dir, 'push-calls.jsonl');
  const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import http from 'node:http';
      import { mock } from 'node:test';
      mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T10:00:00Z') });
      mock.method(http.Server.prototype, 'listen', function () { return this; });
      process.argv[2] = ${JSON.stringify(at)};
      const wave = ${JSON.stringify(path.join(at, 'data', 'wave.json'))};
      const idle = ${JSON.stringify(path.join(at, 'data', 'idle.json'))};
      const pushes = () => (fs.existsSync(${JSON.stringify(calls)}) ? fs.readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').map((l) => JSON.parse(l)) : []);
      const state = () => (fs.existsSync(idle) ? fs.readFileSync(idle, 'utf8') : '');
      // The mocked Date stands still, so a wait counts real 20 ms sleeps.
      const until = async (predicate, message, ms = 15000) => {
        for (let n = 0; !predicate(); n++) {
          if (n * 20 > ms) throw new Error(message);
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      // Writes the wave and waits for the idle check to see it: the state file moves, or a settle time passes.
      const write = async (items) => {
        const before = state();
        fs.writeFileSync(wave, JSON.stringify({ items }));
        await until(() => state() !== before, 'the idle check', 1500).catch(() => {});
        await new Promise((r) => setTimeout(r, 400));
      };
      await import(${JSON.stringify(server)});
      await until(() => state(), 'the first idle check');
      const seen = [];
      const done = (id, mins) => ({ id, title: id, status: 'done', status_at: new Date(Date.parse('2026-11-04T10:00:00Z') + mins * 60000).toISOString() });
      await write([{ id: 'I1', title: 'Open' }, done('I2', 5)]);
      mock.timers.tick(14 * 60000);
      await write([{ id: 'I1', title: 'Open!' }, done('I2', 5)]);
      seen.push(pushes().length);
      mock.timers.tick(2 * 60000);
      await write([{ id: 'I1', title: 'Open' }, done('I2', 5)]);
      await until(() => pushes().length === 1, 'the idle push');
      mock.timers.tick(20 * 60000);
      await write([{ id: 'I1', title: 'Open!' }, done('I2', 5)]);
      seen.push(pushes().length);
      await write([{ id: 'I1', title: 'Open', status: 'checking', status_at: new Date().toISOString() }, done('I2', 5)]);
      await write([{ id: 'I1', title: 'Open' }, done('I2', 5)]);
      mock.timers.tick(16 * 60000);
      await write([{ id: 'I1', title: 'Open!' }, done('I2', 5)]);
      await until(() => pushes().length === 2, 'the second idle push');
      fs.writeFileSync(${JSON.stringify(path.join(at, 'board.json'))}, JSON.stringify({ title: 'Idle board', items: 'data/wave.json', slug: 'i' }));
      await write([{ id: 'I1', title: 'Open' }, done('I2', 5)]);
      await until(() => !state(), 'turning it off forgets the stretch');
      console.log(JSON.stringify({ seen, pushes: pushes() }));
      process.exit(0);
    `], { env: { ...process.env, HOME: dir, PREFIX: '', KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, path.join(dir, 'push-stub.mjs'), 'push']), STUB_CALLS: calls }, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.deepEqual(out.seen, [0, 1], 'nothing at 14 minutes, and no second push in one stretch');
    const [first, second] = out.pushes;
    assert.deepEqual([flag(first, 'kind'), flag(first, 'title'), flag(first, 'body'), flag(first, 'url'), flag(first, 'tag')],
      ['reminder', 'Idle board has gone idle', '1 card landed: I2', '/site/', 'idle']);
    assert.deepEqual([flag(second, 'title'), flag(second, 'body')], ['Idle board has gone idle', 'Nothing closed since the last idle notification.']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
