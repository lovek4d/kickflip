import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';

const home = tempDir('router-');
process.env.HOME = home;
const { routingBoards, boardsListing, routePrompt, parseRanking, routeRequest, drainRoutes, routedRows, dismissRow, answerUnplaced, answerPrompt, placeRow, ROUTE_QUEUE, ROUTED_LOG, ROUTED_DISMISSED, ROUTE_TRIES } = await import('./router.mjs');
const { passAsk } = await import('../board/asks.mjs');
const { listBoards } = await import('./boards.mjs');

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const events = (dir) => fs.readFileSync(path.join(dir, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// A file board at ~/<route> with items, served on a port nothing listens on, so appendEvent writes its events file.
function board(route, { description, items = [], title } = {}) {
  const dir = path.join(home, route);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'data', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 'items', ...(title ? { title } : {}) }));
  fs.writeFileSync(path.join(dir, 'data', 'items.json'), JSON.stringify({ items }));
  return [route, { cmd: ['node', 'board/server.mjs'], dir, port: 1, ...(description ? { description } : {}) }];
}
const manifestOf = (...boards) => ({ sites: Object.fromEntries(boards) });
const item = (id, title, lane, at) => ({ id, title, lane, created: at, lane_at: at });

beforeEach(() => {
  for (const f of [ROUTE_QUEUE, ROUTED_LOG, ROUTED_DISMISSED]) fs.rmSync(f, { force: true });
});

test('a board for routing is its route, title, description and its 15 most recently changed open card titles', async () => {
  const items = Array.from({ length: 18 }, (_, i) => item(`T-${i + 1}`, `Card ${i + 1}`, 'todo', `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
  items.push(item('T-99', 'Finished', 'done', '2026-11-30T00:00:00Z'));
  const [only] = routingBoards(manifestOf(board('shop', { description: 'The paddock shop', items, title: 'Paddock' })));
  assert.equal(only.route, 'shop');
  assert.equal(only.title, 'Paddock');
  assert.equal(only.description, 'The paddock shop');
  assert.deepEqual(only.recent, Array.from({ length: 15 }, (_, i) => `Card ${18 - i}`));
});

test('the board listing a session reads is the one inside the router prompt', async () => {
  const boards = routingBoards(manifestOf(
    board('shop', { description: 'The paddock shop', items: [item('T-1', 'Fix the basket', 'todo', '2026-11-01T00:00:00Z')], title: 'Paddock' }),
    board('hub', { description: '', items: [], title: 'Hub' }),
  ));
  const listing = boardsListing(boards);
  assert.match(listing, /^\/shop · Paddock\nDescription: The paddock shop\nRecent open tasks:\n- Fix the basket\n\n\/hub · Hub\nDescription: none\nRecent open tasks: none$/);
  assert.ok(routePrompt('anything', boards).includes(listing));
});

test('the prompt names every board with its description and recent titles, and the request', async () => {
  const prompt = routePrompt('the checkout 500s', [
    { route: 'shop', title: 'Paddock', description: 'The paddock shop', recent: ['Fix the basket'] },
    { route: 'hub', title: 'Hub', description: '', recent: [] },
  ]);
  assert.match(prompt, /\/shop · Paddock\nDescription: The paddock shop\nRecent open tasks:\n- Fix the basket/);
  assert.match(prompt, /\/hub · Hub\nDescription: none\nRecent open tasks: none/);
  assert.match(prompt, /the checkout 500s/);
});

// docs/adr/2026-11-21-2300-each-board-takes-a-routed-ask-or-passes-it-down-haikus-ranking.md
test("Haiku's answer is a ranking of known routes, best first, each with a one-line reason; unknown and repeated routes drop, and none left is refused", async () => {
  const routes = ['shop', 'hub', 'web'];
  assert.deepEqual(parseRanking({ ranking: [{ route: '/shop', reason: '  the shop owns checkout\nand more ' }, { route: 'paddock', reason: 'x' }, { route: 'hub', reason: 'maybe the hub' }, { route: 'shop', reason: 'again' }, { route: 'web', reason: '' }] }, routes),
    [{ route: 'shop', reason: 'the shop owns checkout and more' }, { route: 'hub', reason: 'maybe the hub' }]);
  assert.throws(() => parseRanking({ ranking: [{ route: 'paddock', reason: 'x' }] }, routes), /paddock/);
  assert.throws(() => parseRanking({ ranking: [] }, routes), /no board/);
  assert.throws(() => parseRanking(null, routes), /answer/);
  assert.match(routePrompt('x', [{ route: 'shop', title: 'Shop', description: '', recent: [] }]), /Rank/);
});

test('a request is filed as an ask on the board Haiku picks, carrying the reason, and logged for the hub page', async () => {
  const shop = board('shop', { description: 'The paddock shop' });
  const hub = board('hub', { description: 'The hub' });
  const prompts = [];
  const ask = async (prompt) => { prompts.push(prompt); return { ranking: [{ route: 'shop', reason: 'checkout is the shop' }, { route: 'hub', reason: 'the hub next' }] }; };
  const out = await routeRequest({ text: 'the checkout 500s', from: { via: 'slack', by: 'Maya', link: 'https://slack.com/archives/D1/p1' } },
    { manifest: manifestOf(shop, hub), ask, paused: () => false });
  assert.equal(prompts.length, 1);
  assert.deepEqual(out.routed.map((r) => r.route), ['shop']);
  const [e] = events(shop[1].dir);
  assert.equal(e.kind, 'ask');
  assert.equal(e.data.text, 'the checkout 500s');
  assert.deepEqual(e.data.routed, { reason: 'checkout is the shop', via: 'slack', by: 'Maya', link: 'https://slack.com/archives/D1/p1', at: e.data.routed.at, id: out.routed[0].id, next: [{ route: 'hub', reason: 'the hub next' }] });
  assert.ok(Date.parse(e.data.routed.at) <= Date.parse(e.ts), 'the routed line sorts above the ask');
  assert.equal(fs.existsSync(path.join(hub[1].dir, 'data', 'events.jsonl')), false);
  const [logged] = read(ROUTED_LOG).routed;
  assert.deepEqual({ ...logged, id: 'x', at: 'x' }, { id: 'x', at: 'x', text: 'the checkout 500s', via: 'slack', by: 'Maya', link: 'https://slack.com/archives/D1/p1', route: 'shop', eventId: e.id, reason: 'checkout is the shop' });
  assert.deepEqual(read(ROUTE_QUEUE).queue, []);
});

test('with one board there is no call: the request goes there, a Slack request naming its thread on the ask', async () => {
  const only = board('only', {});
  const slack = { channel: 'D1', thread_ts: '1792801001.000100', ts: '1792801003.000100' };
  const out = await routeRequest({ text: 'hello', from: { via: 'slack', by: 'Sam', slack } },
    { manifest: manifestOf(only), ask: async () => assert.fail('no call with one board'), paused: () => false });
  assert.deepEqual(out.routed.map((r) => r.route), ['only']);
  assert.equal(events(only[1].dir)[0].data.routed.reason, 'the only board');
  assert.deepEqual(events(only[1].dir)[0].data.routed.slack, slack);
});

test('while usage is paused a request waits in the queue, and is routed on the first drain after the pause lifts', async () => {
  const a = board('a', {}); const b = board('b', {});
  const manifest = manifestOf(a, b);
  let calls = 0;
  const ask = async () => { calls++; return { ranking: [{ route: 'b', reason: 'b fits' }] }; };
  const held = await routeRequest({ text: 'later', from: { via: 'slack', by: 'Sam' } }, { manifest, ask, paused: () => true });
  assert.deepEqual(held, { routed: [], failed: [], waiting: 1 });
  assert.equal(calls, 0);
  assert.equal(read(ROUTE_QUEUE).queue[0].text, 'later');
  const done = await drainRoutes({ manifest, ask, paused: () => false });
  assert.deepEqual([done.routed.map((r) => r.route), done.waiting, calls], [['b'], 0, 1]);
});

test('a failed call keeps the request queued with its error; after the last try it goes to the first board, saying why', async () => {
  const a = board('a', {}); const b = board('b', {});
  const manifest = manifestOf(a, b);
  const ask = async () => { throw new Error('claude -p timed out'); };
  await routeRequest({ text: 'stuck', from: { via: 'slack', by: 'Sam' } }, { manifest, ask, paused: () => false });
  assert.deepEqual(read(ROUTE_QUEUE).queue.map((q) => [q.tries, q.error]), [[1, 'claude -p timed out']]);
  for (let i = 1; i < ROUTE_TRIES; i++) await drainRoutes({ manifest, ask, paused: () => false });
  assert.deepEqual(read(ROUTE_QUEUE).queue, []);
  const [e] = events(a[1].dir);
  assert.match(e.data.routed.reason, /^the router failed \(claude -p timed out\), so it went to the first board$/);
});

test("the hub page's rows: newest first, each linked to the card its ask became, a moved one to where it went, and queued ones waiting", async () => {
  const shop = board('shop', { items: [{ ...item('T-5', 'Checkout 500s', 'todo', '2026-11-12T10:00:00Z'), from_ask: 'e1' }] });
  const other = board('other', { title: 'Other', items: [{ ...item('T-9', 'Rename the field', 'todo', '2026-11-12T10:00:00Z'), from_ask: 'e9' }] });
  fs.writeFileSync(path.join(shop[1].dir, 'data', 'threads', 'ask__e2.jsonl'),
    JSON.stringify({ who: 'claude', kind: 'hub', line: 'ask-moved', text: 'Moved to Other.', link: '/other/#selectedCard=ask%3Ae9' }) + '\n');
  fs.writeFileSync(ROUTED_LOG, JSON.stringify({ routed: [
    { id: 'r1', at: '2026-11-12T09:00:00Z', text: 'checkout', via: 'slack', by: 'Maya', route: 'shop', eventId: 'e1', reason: 'shop' },
    { id: 'r2', at: '2026-11-12T09:30:00Z', text: 'rename', via: 'slack', by: 'Sam', route: 'shop', eventId: 'e2', reason: 'nearest' },
    { id: 'r3', at: '2026-11-12T09:40:00Z', text: 'not yet a task', via: 'slack', by: 'Sam', route: 'shop', eventId: 'e3', reason: 'shop again' },
  ] }));
  fs.writeFileSync(ROUTE_QUEUE, JSON.stringify({ queue: [{ id: 'q1', at: '2026-11-12T09:50:00Z', text: 'held', from: { via: 'slack', by: 'Quinn' }, tries: 0 }] }));
  const rows = await routedRows({ manifest: manifestOf(shop, other) });
  assert.deepEqual(rows.map((r) => r.id), ['q1', 'r3', 'r2', 'r1']);
  assert.deepEqual(rows[0], { id: 'q1', at: '2026-11-12T09:50:00Z', text: 'held', via: 'slack', by: 'Quinn', waiting: true });
  assert.deepEqual(rows[3].to, { route: 'shop', ref: 'T-5', title: 'Checkout 500s', href: '/shop/#selectedCard=items%2FT-5' });
  assert.deepEqual(rows[2].to, { route: 'shop', ref: null, title: null, href: '/shop/#selectedCard=ask%3Ae2' });
  assert.deepEqual(rows[2].moved, { route: 'other', ref: 'T-9', title: 'Rename the field', href: '/other/#selectedCard=items%2FT-9' });
  assert.deepEqual(rows[1].to, { route: 'shop', ref: null, title: null, href: '/shop/#selectedCard=ask%3Ae3' });
  assert.equal(rows[1].moved, undefined);
  assert.equal(rows[3].reason, 'shop');
});

test("the hub page's rows carry the asks other boards put to a board, queued or answered, among the routed ones, newest first", async () => {
  const shop = board('shop', {});
  const other = board('other', { title: 'Other' });
  const ev = (id, ts, kind, data) => JSON.stringify({ id, ts, kind, data });
  fs.writeFileSync(path.join(shop[1].dir, 'data', 'events.jsonl'), [
    ev('a1', '2026-11-12T08:00:00Z', 'board-ask', { text: 'why X?', from: { route: 'other', title: 'Other', key: 'items/T-9', ref: 'T-9' } }),
    ev('a2', '2026-11-12T09:45:00Z', 'board-ask', { text: 'and Y?', from: { route: 'other', title: 'Other' } }),
    ev('x1', '2026-11-12T08:30:00Z', 'board-ask-answered', { id: 'a1', text: 'because' }),
    ev('n1', '2026-11-12T08:31:00Z', 'ask', { text: 'not a board ask' }),
  ].join('\n') + '\n');
  fs.writeFileSync(ROUTED_LOG, JSON.stringify({ routed: [{ id: 'r1', at: '2026-11-12T09:00:00Z', text: 'checkout', via: 'slack', by: 'Maya', route: 'shop', eventId: 'e1', reason: 'shop' }] }));
  const rows = await routedRows({ manifest: manifestOf(shop, other) });
  assert.deepEqual(rows.map((r) => r.id), ['a2', 'r1', 'a1']);
  assert.deepEqual(rows[0], { id: 'a2', at: '2026-11-12T09:45:00Z', text: 'and Y?', asked: { from: { route: 'other', title: 'Other' }, to: { route: 'shop', href: '/shop/#selectedCard=ask%3Aa2' }, answered: null } });
  assert.deepEqual(rows[2].asked, { from: { route: 'other', title: 'Other', key: 'items/T-9', ref: 'T-9' }, to: { route: 'shop', href: '/shop/#selectedCard=ask%3Aa1' }, answered: { at: '2026-11-12T08:30:00Z', href: '/other/#selectedCard=items%2FT-9' } });
});

// docs/adr/2026-11-22-2300-the-hub-page-reads-board-events-async-and-only-what-was-appended.md
test("a board's events are read once and then only what was appended, and a replaced file is read afresh", async () => {
  const shop = board('shop', {});
  const file = path.join(shop[1].dir, 'data', 'events.jsonl');
  const manifest = manifestOf(shop);
  const ev = (id, kind, data) => JSON.stringify({ id, ts: '2026-11-12T08:00:00Z', kind, data }) + '\n';
  const ask = (id) => ev(id, 'board-ask', { text: id, from: { route: 'other', title: 'Other' } });
  fs.writeFileSync(file, ask('a1') + ask('a2'));
  const reads = [];
  const probe = await fs.promises.open(file);
  const handle = Object.getPrototypeOf(probe);
  await probe.close();
  const read = handle.read;
  handle.read = function (...args) { reads.push(args[3]); return read.apply(this, args); };
  after(() => { handle.read = read; });
  assert.deepEqual((await routedRows({ manifest })).map((r) => r.id).sort(), ['a1', 'a2']);
  const size = fs.statSync(file).size;
  assert.deepEqual(reads, [0n]);
  await routedRows({ manifest });
  assert.deepEqual(reads, [0n], 'an unchanged file is not read again');
  fs.appendFileSync(file, ask('a3') + '{"id":"a4"');
  assert.deepEqual((await routedRows({ manifest })).map((r) => r.id).sort(), ['a1', 'a2', 'a3']);
  assert.equal(reads[1], BigInt(size), 'only the appended bytes are read');
  fs.appendFileSync(file, ',"ts":"2026-11-12T08:00:00Z","kind":"board-ask","data":{"text":"a4","from":{"route":"other"}}}\n');
  assert.equal((await routedRows({ manifest })).length, 4, 'a line cut off mid-write is parsed once it is whole');
  fs.rmSync(file);
  fs.writeFileSync(file, ask('b1'));
  assert.deepEqual((await routedRows({ manifest })).map((r) => r.id), ['b1']);
  handle.read = read;
});

// docs/adr/2026-11-16-0600-the-hubs-new-task-box-files-through-the-router.md
test("a hub request's intent fields ride on its ask, and its uploads are copied to the board and dropped from the hub", async () => {
  const shop = board('shop', {});
  const uploads = path.join(home, '.claude', 'kickflip', 'data', 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, '1700-shot.png'), 'png');
  await routeRequest({ text: 'fix the basket', fields: { quick: true }, files: [{ name: 'shot.png', url: 'uploads/1700-shot.png', type: 'image/png', size: 3 }], from: { via: 'hub', by: 'love' } },
    { manifest: manifestOf(shop), paused: () => false });
  const [e] = events(shop[1].dir);
  assert.equal(e.data.quick, true);
  assert.deepEqual(e.data.routed.via, 'hub');
  const [file] = e.data.files;
  assert.match(file.url, /^uploads\/\d+-shot\.png$/);
  assert.equal(fs.readFileSync(path.join(shop[1].dir, 'data', file.url), 'utf8'), 'png');
  assert.equal(fs.existsSync(path.join(uploads, '1700-shot.png')), false);
  await routeRequest({ text: 'look into it', fields: { request: 'grill' }, from: { via: 'hub', by: 'love' } }, { manifest: manifestOf(shop), paused: () => false });
  assert.equal(events(shop[1].dir)[1].data.request, 'grill');
});

test("a dismissed row leaves the hub page's rows, whatever kind it was, and stays gone", async () => {
  const shop = board('shop', {});
  fs.writeFileSync(path.join(shop[1].dir, 'data', 'events.jsonl'), JSON.stringify({ id: 'a1', ts: '2026-11-12T08:00:00Z', kind: 'board-ask', data: { text: 'why X?', from: { route: 'other', title: 'Other' } } }) + '\n');
  fs.writeFileSync(ROUTED_LOG, JSON.stringify({ routed: [{ id: 'r1', at: '2026-11-12T09:00:00Z', text: 'checkout', route: 'shop', eventId: 'e1', reason: 'shop' }, { id: 'r2', at: '2026-11-12T09:10:00Z', text: 'two', route: 'shop', eventId: 'e2', reason: 'shop' }] }));
  const manifest = manifestOf(shop);
  assert.deepEqual((await routedRows({ manifest })).map((r) => r.id), ['r2', 'r1', 'a1']);
  await dismissRow('r1');
  await dismissRow('a1');
  await dismissRow('a1');
  assert.deepEqual((await routedRows({ manifest })).map((r) => r.id), ['r2']);
  assert.deepEqual(read(ROUTED_DISMISSED).dismissed, ['r1', 'a1']);
});

// docs/adr/2026-11-21-2300-each-board-takes-a-routed-ask-or-passes-it-down-haikus-ranking.md
const thread = (dir, eventId) => fs.readFileSync(path.join(dir, 'data', 'threads', `ask__${eventId}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ranked = (...routes) => async () => ({ ranking: routes.map((route) => ({ route, reason: `${route} might` })) });

test("a board passes a routed ask on to the next board in Haiku's ranking; past the last it comes back to the hub unplaced", async () => {
  const a = board('a', { title: 'A' }); const b = board('b', { title: 'B' }); const c = board('c', { title: 'C' });
  const manifest = manifestOf(a, b, c);
  const boards = listBoards(manifest);
  const slack = { channel: 'D1', thread_ts: '1792801001.000100', ts: '1792801003.000100' };
  const { routed: [entry] } = await routeRequest({ text: 'keep my Mac awake', fields: { quick: true }, from: { via: 'slack', by: 'Maya', slack } }, { manifest, ask: ranked('a', 'b'), paused: () => false });
  const [first] = events(a[1].dir);
  await assert.rejects(passAsk(a[1].dir, first.id, '', { boards }), /--next needs/);
  await assert.rejects(passAsk(a[1].dir, first.id, 'x'.repeat(77), { boards }), /past 76/);
  await passAsk(a[1].dir, first.id, 'not this repo', { boards });
  const [second] = events(b[1].dir);
  assert.equal(second.data.text, 'keep my Mac awake');
  assert.equal(second.data.quick, true, "the ask's intent rides on");
  assert.deepEqual({ ...second.data.routed, at: 'x' }, { reason: 'b might', via: 'slack', by: 'Maya', slack, at: 'x', id: entry.id, next: [], passed: [{ route: 'a', reason: 'not this repo' }] });
  assert.equal(second.data.from, undefined, 'a passed ask reads as routed, not handed');
  assert.deepEqual(thread(a[1].dir, first.id).map((m) => [m.line, m.link]), [['ask-moved', `/b/#selectedCard=${encodeURIComponent(`ask:${second.id}`)}`]]);
  let [logged] = read(ROUTED_LOG).routed;
  assert.deepEqual([logged.route, logged.eventId, logged.passed, logged.unplaced], ['b', second.id, [{ route: 'a', reason: 'not this repo' }], undefined]);
  await assert.rejects(passAsk(a[1].dir, first.id, 'again', { boards }), /moved/);
  await passAsk(b[1].dir, second.id, 'a macOS question', { boards });
  assert.equal(fs.existsSync(path.join(c[1].dir, 'data', 'events.jsonl')), false, 'a board Haiku left out of the ranking never sees it');
  assert.deepEqual(thread(b[1].dir, second.id).map((m) => [m.line, m.text]), [['ask-moved', 'Moved to the hub.']]);
  [logged] = read(ROUTED_LOG).routed;
  assert.deepEqual([logged.route, logged.unplaced, logged.passed], ['b', true, [{ route: 'a', reason: 'not this repo' }, { route: 'b', reason: 'a macOS question' }]]);
  assert.deepEqual(logged.slack, slack);
  fs.appendFileSync(path.join(c[1].dir, 'data', 'events.jsonl'), JSON.stringify({ id: 'p1', ts: '2026-11-21T10:00:00Z', kind: 'ask', data: { text: 'typed here' } }) + '\n');
  await assert.rejects(passAsk(c[1].dir, 'p1', 'not mine', { boards }), /wasn't routed by the hub/);
});

test("Haiku answers an ask every board passed, once, from the passes and the ask; a Slack one's answer also posts in its thread", async () => {
  const a = board('a', {}); const b = board('b', {});
  const manifest = manifestOf(a, b);
  fs.writeFileSync(ROUTED_LOG, JSON.stringify({ routed: [
    { id: 'r1', at: '2026-11-21T09:00:00Z', text: 'keep my Mac awake?', via: 'slack', by: 'Maya', route: 'b', eventId: 'e2', reason: 'b might', unplaced: true, passed: [{ route: 'a', reason: 'not this repo' }, { route: 'b', reason: 'a macOS question' }], slack: { channel: 'D1', thread_ts: '1.1', ts: '1.2' } },
    { id: 'r2', at: '2026-11-21T09:10:00Z', text: 'fix the basket', via: 'hub', by: 'love', route: 'a', eventId: 'e3', reason: 'a' },
  ] }));
  const prompts = [];
  const posts = [];
  const ask = async (prompt) => { prompts.push(prompt); return { answer: '  Run your build under caffeinate -i.\n\nIt costs nothing. ' }; };
  const slackClient = { post: async (m) => { posts.push(m); return '1.3'; } };
  assert.deepEqual(await answerUnplaced({ manifest, ask, paused: () => true, slack: () => slackClient }), { answered: [], failed: [] });
  const out = await answerUnplaced({ manifest, ask, paused: () => false, slack: () => slackClient });
  assert.deepEqual(out, { answered: ['r1'], failed: [] });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /keep my Mac awake\?/);
  assert.match(prompts[0], /\/a: not this repo/);
  assert.deepEqual(posts, [{ channel: 'D1', thread_ts: '1.1', text: 'Run your build under caffeinate -i.\n\nIt costs nothing.' }]);
  const [logged] = read(ROUTED_LOG).routed;
  assert.deepEqual({ ...logged.answer, at: 'x' }, { text: 'Run your build under caffeinate -i.\n\nIt costs nothing.', at: 'x', slack: '1.3' });
  assert.deepEqual(await answerUnplaced({ manifest, ask, paused: () => false, slack: () => slackClient }), { answered: [], failed: [] }, 'answered once');
  assert.match(answerPrompt('the words', []), /the words/);
});

test('a failed answer is retried each tick until the last try, which keeps the error; a failed Slack post keeps the answer and says so', async () => {
  const a = board('a', {});
  const manifest = manifestOf(a);
  fs.writeFileSync(ROUTED_LOG, JSON.stringify({ routed: [{ id: 'r1', at: '2026-11-21T09:00:00Z', text: 'q?', via: 'slack', by: 'Maya', route: 'a', eventId: 'e1', reason: 'a', unplaced: true, passed: [{ route: 'a', reason: 'no' }], slack: { channel: 'D1', thread_ts: '1.1', ts: '1.2' } }] }));
  const broken = async () => { throw new Error('claude -p timed out'); };
  for (let i = 0; i < ROUTE_TRIES + 1; i++) await answerUnplaced({ manifest, ask: broken, paused: () => false, slack: () => null });
  let [logged] = read(ROUTED_LOG).routed;
  assert.deepEqual([logged.answer, logged.answerTries, logged.answerError], [undefined, ROUTE_TRIES, 'claude -p timed out']);
  const { answerTries: _t, answerError: _e, ...fresh } = logged;
  fs.writeFileSync(ROUTED_LOG, JSON.stringify({ routed: [fresh] }));
  const out = await answerUnplaced({ manifest, ask: async () => ({ answer: 'yes' }), paused: () => false, slack: () => ({ post: async () => { throw new Error('Slack: channel_not_found'); } }) });
  assert.deepEqual(out.answered, ['r1']);
  [logged] = read(ROUTED_LOG).routed;
  assert.deepEqual([logged.answer.text, logged.answer.slack, logged.answer.slackError], ['yes', undefined, 'Slack: channel_not_found']);
});

test("the hub page's rows: a routed ask its board hasn't sorted reads trying with the passes so far; an unplaced one carries its passes, answer and the boards to put it on", async () => {
  const a = board('a', { title: 'A' });
  const b = board('b', { title: 'B', items: [{ ...item('T-2', 'keep awake', 'todo', '2026-11-21T09:01:00Z'), from_ask: 'e2' }, { ...item('T-3', 'sorted', 'todo', '2026-11-21T09:01:00Z'), from_ask: 'e3', phase: 'ready' }] });
  const passed = [{ route: 'a', reason: 'not this repo' }];
  fs.writeFileSync(ROUTED_LOG, JSON.stringify({ routed: [
    { id: 'r1', at: '2026-11-21T09:00:00Z', text: 'trying', via: 'hub', by: 'love', route: 'b', eventId: 'e2', reason: 'b might', passed },
    { id: 'r2', at: '2026-11-21T09:05:00Z', text: 'taken', via: 'hub', by: 'love', route: 'b', eventId: 'e3', reason: 'b might' },
    { id: 'r3', at: '2026-11-21T09:10:00Z', text: 'nobody', via: 'slack', by: 'Maya', link: 'https://slack.com/x', route: 'b', eventId: 'e4', reason: 'b might', unplaced: true, passed, slack: { channel: 'D1', thread_ts: '1.1', ts: '1.2' }, answer: { text: 'Use caffeinate.', at: '2026-11-21T09:11:00Z', slack: '1.3' } },
  ] }));
  const rows = await routedRows({ manifest: manifestOf(a, b) });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual([by.r1.trying, by.r1.passed], [true, passed]);
  assert.equal(by.r2.trying, undefined, 'a sorted card is taken');
  assert.deepEqual([by.r3.unplaced, by.r3.passed, by.r3.answer.text, by.r3.answer.slack, by.r3.link], [true, passed, 'Use caffeinate.', true, 'https://slack.com/x']);
  assert.deepEqual(by.r3.places, [{ route: 'a', title: 'A' }, { route: 'b', title: 'B' }]);
  assert.equal(by.r3.trying, undefined);
});

test("the owner puts an unplaced ask on a board: it's filed there with its words, intent and files, and the row reads placed", async () => {
  const a = board('a', { title: 'A' }); const b = board('b', { title: 'B' });
  const manifest = manifestOf(a, b);
  fs.mkdirSync(path.join(b[1].dir, 'data', 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(b[1].dir, 'data', 'uploads', '1700-shot.png'), 'png');
  const slack = { channel: 'D1', thread_ts: '1.1', ts: '1.2' };
  fs.writeFileSync(path.join(b[1].dir, 'data', 'events.jsonl'), JSON.stringify({ id: 'e4', ts: '2026-11-21T09:10:00Z', kind: 'ask', data: { text: 'nobody', request: 'grill', files: [{ name: 'shot.png', url: 'uploads/1700-shot.png' }], routed: { reason: 'b might', via: 'slack', by: 'Maya', slack, at: '2026-11-21T09:10:00Z', id: 'r3', next: [] } } }) + '\n');
  fs.writeFileSync(ROUTED_LOG, JSON.stringify({ routed: [
    { id: 'r3', at: '2026-11-21T09:10:00Z', text: 'nobody', via: 'slack', by: 'Maya', route: 'b', eventId: 'e4', reason: 'b might', unplaced: true, passed: [{ route: 'b', reason: 'no' }], slack, answer: { text: 'x', at: '2026-11-21T09:11:00Z' } },
    { id: 'r4', at: '2026-11-21T09:20:00Z', text: 'routed', via: 'hub', by: 'love', route: 'a', eventId: 'e5', reason: 'a' },
  ] }));
  await assert.rejects(placeRow('r4', 'b', { manifest }), /isn't waiting for a board/);
  await assert.rejects(placeRow('r3', 'nope', { manifest }), /no board at \/nope/);
  await placeRow('r3', 'a', { manifest });
  const [e] = events(a[1].dir);
  assert.equal(e.data.text, 'nobody');
  assert.equal(e.data.request, 'grill');
  assert.match(e.data.files[0].url, /^uploads\/\d+-shot\.png$/);
  assert.deepEqual({ ...e.data.routed, at: 'x' }, { reason: 'you put it here after no board took it', via: 'slack', by: 'Maya', slack, at: 'x', id: 'r3', next: [] });
  const [logged] = read(ROUTED_LOG).routed;
  assert.deepEqual([logged.route, logged.eventId, logged.unplaced, logged.placed], ['a', e.id, undefined, true]);
  const row = (await routedRows({ manifest })).find((r) => r.id === 'r3');
  assert.deepEqual([row.placed, row.to.route, row.unplaced], [true, 'a', undefined]);
  await assert.rejects(placeRow('r3', 'b', { manifest }), /isn't waiting for a board/);
});
