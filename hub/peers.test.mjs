// docs/adr/2026-11-18-2200-a-board-asks-a-board-on-another-of-your-hubs-while-its-online.md
// docs/adr/2026-11-18-2250-asks-between-hubs-wait-in-an-outbox-while-the-other-hub-is-offline-or-older.md
import { home, web, bin, write, inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ownerGate } from '../board/on-host.mjs';
import { peersOf, outboxFile } from './peers.mjs';

const STATUS = { BackendState: 'Running', Self: { UserID: 7, TailscaleIPs: ['100.81.98.101'], DNSName: 'MacA.tail1234.ts.net.' }, User: { 7: { LoginName: 'lovek4d@github' } } };
// A request from the other Mac's hub through tailscale serve: Node's fetch sends no Origin, and serve names the login.
const otherMac = { 'x-forwarded-for': '100.70.1.2', 'tailscale-user-login': 'lovek4d@github' };
const friend = { 'x-forwarded-for': '100.70.1.3', 'tailscale-user-login': 'friend@github' };
const json = { 'content-type': 'application/json' };
const QUESTION = 'Why does land rebase first?';

// The tailscale the owner gate runs answers `status --json` with STATUS.
write(path.join(bin, 'tailscale'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(STATUS))});\n`);
fs.chmodSync(path.join(bin, 'tailscale'), 0o755);
write(path.join(home, 'stand-in', 'board', 'server.mjs'), 'setInterval(() => {}, 2 ** 30);\n');

// A hub with a board /audit (its port refuses, so events go straight to its log) and peers that the test sets: by
// default the tailnet is on, this hub is maca and macb is online at this same hub, so a relay reaches itself.
async function startHub(t, gate) {
  fs.rmSync(web, { recursive: true, force: true });
  const dir = path.join(home, 'audit');
  fs.rmSync(dir, { recursive: true, force: true });
  write(path.join(dir, 'board.json'), { title: 'Audit', items: 'data/items.json' });
  write(path.join(web, 'manifest.json'), { version: 1, migrated: ['hub-flag'], sites: { audit: { port: 1, dir, cmd: [process.execPath, path.join(home, 'stand-in', 'board', 'server.mjs')] } } });
  const peers = {
    tailnet: () => true,
    read: async () => ({ self: { name: 'maca', host: 'maca.tail1234.ts.net' }, peers: [{ name: 'macb', host: 'macb.tail1234.ts.net' }], offline: ['mini'] }),
    url: () => hub.base,
  };
  const hub = await inProcessHub(t, { peers, ...(gate ? { gate } : {}) });
  await hub.settled();
  const events = () => { try { return fs.readFileSync(path.join(dir, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
  const post = (p, body, headers = {}) => fetch(hub.base + p, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });
  return { hub, peers, events, post };
}

test('peers are the online machines of this host\'s own Tailscale user, by machine name, phones left out', () => {
  const node = (name, extra) => ({ DNSName: `${name}.tail1234.ts.net.`, UserID: 7, Online: true, OS: 'macOS', ...extra });
  const status = { ...STATUS, Peer: { a: node('MacC'), b: node('MacB'), c: node('mini', { Online: false }), d: node('friends-mac', { UserID: 9 }), e: node('iphone', { OS: 'iOS' }), f: node('pixel', { OS: 'android' }), g: node('nas', { OS: 'linux' }) } };
  assert.deepEqual(peersOf(status), {
    self: { name: 'maca', host: 'MacA.tail1234.ts.net' },
    peers: [{ name: 'macb', host: 'MacB.tail1234.ts.net' }, { name: 'macc', host: 'MacC.tail1234.ts.net' }, { name: 'nas', host: 'nas.tail1234.ts.net' }],
    offline: ['mini'],
  });
});

test("an ask goes out through this hub's loopback and lands on the other hub's board naming this hub; boards lists the other hub's", async (t) => {
  const { hub, events, post } = await startHub(t);
  const r = await post('/_hub/peers/ask', { hub: 'MacB', route: 'audit', text: QUESTION, from: { route: 'orch', title: 'Orch', key: 'w/A1', ref: 'A1' } });
  const sent = await r.json();
  assert.equal(r.status, 200, JSON.stringify(sent));
  const [e] = events();
  assert.deepEqual([e.id, e.kind, e.data], [sent.id, 'board-ask', { text: QUESTION, from: { hub: 'maca', host: 'maca.tail1234.ts.net', route: 'orch', title: 'Orch', key: 'w/A1', ref: 'A1' } }]);
  assert.equal(sent.listening, false);
  const boards = await fetch(`${hub.base}/_hub/peers/boards`);
  assert.deepEqual([boards.status, await boards.json()], [200, { hubs: [{ hub: 'macb', boards: [{ route: 'audit', title: 'Audit' }] }, { hub: 'mini', error: 'mini is offline' }] }]);
  // A board the other hub doesn't run is its refusal, passed on.
  const none = await post('/_hub/peers/ask', { hub: 'macb', route: 'nope', text: QUESTION, from: { route: 'orch', title: 'Orch' } });
  assert.deepEqual([none.status, await none.json()], [400, { error: 'no board at /nope; the boards are audit' }]);
  // An answer goes out the same way, naming this hub; the other hub takes it only for a question its board asked there.
  const answer = await post('/_hub/peers/answer', { hub: 'macb', id: 'p1', route: 'audit', text: 'Because CI', from: { route: 'orch', title: 'Orch' } });
  assert.deepEqual([answer.status, await answer.json()], [400, { error: '/audit asked maca/orch no question p1' }]);
});

// An older hub answers an unknown /_hub/ path with a bare 404. → its URL
async function olderHub(t) {
  const older = http.createServer((req, res) => res.writeHead(404).end());
  await new Promise((resolve) => older.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => older.close(resolve)));
  return `http://127.0.0.1:${older.address().port}`;
}
const outbox = () => { try { return JSON.parse(fs.readFileSync(outboxFile(), 'utf8')); } catch { return []; } };
const DOWN = () => 'http://127.0.0.1:1';

test('an ask is refused with the reason while the tailnet is off, tailscale is silent, or the hub named is unknown or this one', async (t) => {
  const { hub, peers, post } = await startHub(t);
  const ask = (hub) => post('/_hub/peers/ask', { hub, route: 'audit', text: QUESTION, from: { route: 'orch', title: 'Orch', id: 'q1' } }).then(async (r) => [r.status, (await r.json()).error]);
  assert.deepEqual(await ask('macz'), [404, "macz isn't one of your machines on the tailnet; online now: macb"]);
  assert.deepEqual(await ask('maca'), [400, 'maca is this hub; ask a board here by its route alone']);
  peers.url = DOWN;
  const listed = await (await fetch(`${hub.base}/_hub/peers/boards`)).json();
  assert.match(listed.hubs[0].error, /^macb doesn't answer/);
  peers.read = async () => null;
  assert.deepEqual(await ask('macb'), [503, "Tailscale doesn't answer on this host, so no other hub can be reached"]);
  peers.tailnet = () => false;
  assert.deepEqual(await ask('macb'), [409, 'asks between hubs ride the tailnet, which is off on this hub; run kickflip tailnet on here and on the other hub']);
  assert.deepEqual(outbox(), []);
});

test('an ask or answer to a hub that is offline, down or older waits in the outbox, and the minute job retries it until it goes, once', async (t) => {
  const { hub, peers, events, post } = await startHub(t);
  const reached = peers.url;
  const ask = (to, id) => post('/_hub/peers/ask', { hub: to, route: 'audit', text: QUESTION, from: { route: 'orch', title: 'Orch', key: 'w/A1', ref: 'A1', id } });
  // mini is one of the owner's machines, offline on the tailnet.
  const offline = await ask('mini', 'q1');
  assert.deepEqual([offline.status, await offline.json()], [202, { queued: 'mini is offline' }]);
  const older404 = await olderHub(t);
  peers.url = () => older404;
  const older = await ask('macb', 'q2');
  assert.deepEqual([older.status, await older.json()], [202, { queued: 'macb runs an older kickflip' }]);
  peers.url = DOWN;
  const answer = await post('/_hub/peers/answer', { hub: 'macb', id: 'q9', route: 'orch', text: 'Because CI', from: { route: 'audit', title: 'Audit' } });
  assert.deepEqual([answer.status, await answer.json()], [202, { queued: 'macb is offline' }]);
  assert.deepEqual(outbox().map((s) => [s.hub, s.what, s.body.from.id ?? s.body.id, s.queued]), [['mini', 'ask', 'q1', 'mini is offline'], ['macb', 'ask', 'q2', 'macb runs an older kickflip'], ['macb', 'answer', 'q9', 'macb is offline']]);
  assert.deepEqual(events(), []);

  // Still down: each stays queued, with the reason of its last try.
  await hub.outbox();
  assert.deepEqual(outbox().map((s) => s.queued), ['mini is offline', 'macb is offline', 'macb is offline']);
  // macb is back: its ask lands once, naming this hub, and the answer, which /orch never asked, is refused and dropped.
  peers.url = reached;
  await hub.outbox();
  assert.deepEqual(events().map((e) => [e.kind, e.data.from]), [['board-ask', { hub: 'maca', host: 'maca.tail1234.ts.net', route: 'orch', title: 'Orch', key: 'w/A1', ref: 'A1', id: 'q2' }]]);
  assert.deepEqual(outbox().map((s) => [s.hub, s.queued]), [['mini', 'mini is offline']]);
  await hub.logged(/^peer outbox: macb refused the answer to q9: no board at \/orch/);
  // The same ask sent again, as after a send whose reply was lost, files nothing new.
  const again = await ask('macb', 'q2');
  assert.equal((await again.json()).id, events()[0].id);
  assert.equal(events().length, 1);
  const listed = await (await fetch(`${hub.base}/_hub/peers/boards`)).json();
  assert.deepEqual(listed.hubs.at(-1), { hub: 'mini', error: 'mini is offline' });
});

test("a queued ask the other hub refuses once it's back stays in the outbox as refused, and isn't sent again", async (t) => {
  const { hub, peers, events, post } = await startHub(t);
  const reached = peers.url;
  peers.url = DOWN;
  assert.equal((await post('/_hub/peers/ask', { hub: 'macb', route: 'gone', text: QUESTION, from: { route: 'orch', title: 'Orch', id: 'q1' } })).status, 202);
  peers.url = reached;
  await hub.outbox();
  assert.deepEqual(outbox().map((s) => [s.queued, s.refused]), [[undefined, 'no board at /gone; the boards are audit']]);
  await hub.outbox();
  assert.deepEqual(events(), []);
  assert.equal(hub.lines.filter((l) => /^peer outbox: macb refused the ask q1/.test(l)).length, 1);
});

test('while the tailnet is off or tailscale is silent here, the minute job sends nothing and keeps the outbox', async (t) => {
  const { hub, peers, events, post } = await startHub(t);
  const reached = peers.url;
  peers.url = DOWN;
  await post('/_hub/peers/ask', { hub: 'macb', route: 'audit', text: QUESTION, from: { route: 'orch', title: 'Orch', id: 'q1' } });
  peers.url = reached;
  const read = peers.read;
  peers.read = async () => null;
  await hub.outbox();
  peers.read = read;
  peers.tailnet = () => false;
  await hub.outbox();
  assert.deepEqual([events(), outbox().map((s) => s.queued)], [[], ['macb is offline']]);
  peers.tailnet = () => true;
  await hub.outbox();
  assert.deepEqual([events().length, outbox()], [1, []]);
});

test('only a local process sends to another hub; another hub reaches its peer routes only as the owner', async (t) => {
  const { hub, events, post } = await startHub(t, ownerGate());
  // The gate reads the tailnet on, as the hubs asking each other run.
  write(path.join(web, 'settings.json'), { tailnet: true });
  const out = await post('/_hub/peers/ask', { hub: 'macb', route: 'audit', text: QUESTION, from: { route: 'orch', title: 'Orch' } }, otherMac);
  assert.deepEqual([out.status, await out.json()], [403, { error: 'Only an agent on this host sends to your other hubs, over loopback.' }]);
  const from = { hub: 'macb', host: 'macb.tail1234.ts.net', route: 'orch', title: 'Orch' };
  assert.equal((await post('/_hub/peer/ask', { route: 'audit', text: QUESTION, from }, friend)).status, 403);
  assert.deepEqual(events(), []);
  const r = await post('/_hub/peer/ask', { route: 'audit', text: QUESTION, from }, otherMac);
  assert.equal(r.status, 200);
  assert.deepEqual(events().map((e) => e.data.from), [from]);
  assert.equal((await fetch(`${hub.base}/_hub/peer/boards`, { headers: otherMac })).status, 200);
  assert.equal((await fetch(`${hub.base}/_hub/peer/boards`, { headers: friend })).status, 403);
});
