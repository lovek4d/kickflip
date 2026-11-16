import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';

const home = tempDir('router-');
process.env.HOME = home;
const { routingBoards, routePrompt, parseRoute, routeRequest, drainRoutes, routedRows, ROUTE_QUEUE, ROUTED_LOG, ROUTE_TRIES } = await import('./router.mjs');

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
  for (const f of [ROUTE_QUEUE, ROUTED_LOG]) fs.rmSync(f, { force: true });
});

test('a board for routing is its route, title, description and its 15 most recently changed open card titles', () => {
  const items = Array.from({ length: 18 }, (_, i) => item(`T-${i + 1}`, `Card ${i + 1}`, 'todo', `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
  items.push(item('T-99', 'Finished', 'done', '2026-11-30T00:00:00Z'));
  const [only] = routingBoards(manifestOf(board('shop', { description: 'The paddock shop', items, title: 'Paddock' })));
  assert.equal(only.route, 'shop');
  assert.equal(only.title, 'Paddock');
  assert.equal(only.description, 'The paddock shop');
  assert.deepEqual(only.recent, Array.from({ length: 15 }, (_, i) => `Card ${18 - i}`));
});

test('the prompt names every board with its description and recent titles, and the request', () => {
  const prompt = routePrompt('the checkout 500s', [
    { route: 'shop', title: 'Paddock', description: 'The paddock shop', recent: ['Fix the basket'] },
    { route: 'hub', title: 'Hub', description: '', recent: [] },
  ]);
  assert.match(prompt, /\/shop · Paddock\nDescription: The paddock shop\nRecent open tasks:\n- Fix the basket/);
  assert.match(prompt, /\/hub · Hub\nDescription: none\nRecent open tasks: none/);
  assert.match(prompt, /the checkout 500s/);
});

test("Haiku's answer is a known route and a one-line reason; anything else is refused", () => {
  const routes = ['shop', 'hub'];
  assert.deepEqual(parseRoute({ route: '/shop', reason: '  the shop owns checkout\nand more ' }, routes), { route: 'shop', reason: 'the shop owns checkout and more' });
  assert.throws(() => parseRoute({ route: 'paddock', reason: 'x' }, routes), /paddock/);
  assert.throws(() => parseRoute({ route: 'shop', reason: '' }, routes), /reason/);
  assert.throws(() => parseRoute(null, routes), /answer/);
});

test('a request is filed as an ask on the board Haiku picks, carrying the reason, and logged for the hub page', async () => {
  const shop = board('shop', { description: 'The paddock shop' });
  const hub = board('hub', { description: 'The hub' });
  const prompts = [];
  const ask = async (prompt) => { prompts.push(prompt); return { route: 'shop', reason: 'checkout is the shop' }; };
  const out = await routeRequest({ text: 'the checkout 500s', from: { via: 'slack', by: 'Maya', link: 'https://slack.com/archives/D1/p1' } },
    { manifest: manifestOf(shop, hub), ask, paused: () => false });
  assert.equal(prompts.length, 1);
  assert.deepEqual(out.routed.map((r) => r.route), ['shop']);
  const [e] = events(shop[1].dir);
  assert.equal(e.kind, 'ask');
  assert.equal(e.data.text, 'the checkout 500s');
  assert.deepEqual(e.data.routed, { reason: 'checkout is the shop', via: 'slack', by: 'Maya', link: 'https://slack.com/archives/D1/p1', at: e.data.routed.at });
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
  const ask = async () => { calls++; return { route: 'b', reason: 'b fits' }; };
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
  const rows = routedRows({ manifest: manifestOf(shop, other) });
  assert.deepEqual(rows.map((r) => r.id), ['q1', 'r3', 'r2', 'r1']);
  assert.deepEqual(rows[0], { id: 'q1', at: '2026-11-12T09:50:00Z', text: 'held', via: 'slack', by: 'Quinn', waiting: true });
  assert.deepEqual(rows[3].to, { route: 'shop', ref: 'T-5', title: 'Checkout 500s', href: '/shop/#selectedCard=items%2FT-5' });
  assert.deepEqual(rows[2].to, { route: 'shop', ref: null, title: null, href: '/shop/#selectedCard=ask%3Ae2' });
  assert.deepEqual(rows[2].moved, { route: 'other', ref: 'T-9', title: 'Rename the field', href: '/other/#selectedCard=items%2FT-9' });
  assert.deepEqual(rows[1].to, { route: 'shop', ref: null, title: null, href: '/shop/#selectedCard=ask%3Ae3' });
  assert.equal(rows[1].moved, undefined);
  assert.equal(rows[3].reason, 'shop');
});

test("the hub page's rows carry the asks other boards put to a board, queued or answered, among the routed ones, newest first", () => {
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
  const rows = routedRows({ manifest: manifestOf(shop, other) });
  assert.deepEqual(rows.map((r) => r.id), ['a2', 'r1', 'a1']);
  assert.deepEqual(rows[0], { id: 'a2', at: '2026-11-12T09:45:00Z', text: 'and Y?', asked: { from: { route: 'other', title: 'Other' }, to: { route: 'shop', href: '/shop/#selectedCard=ask%3Aa2' }, answered: null } });
  assert.deepEqual(rows[2].asked, { from: { route: 'other', title: 'Other', key: 'items/T-9', ref: 'T-9' }, to: { route: 'shop', href: '/shop/#selectedCard=ask%3Aa1' }, answered: { at: '2026-11-12T08:30:00Z', href: '/other/#selectedCard=items%2FT-9' } });
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
