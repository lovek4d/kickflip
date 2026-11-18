// docs/adr/2026-11-18-2200-a-board-asks-a-board-on-another-of-your-hubs-while-its-online.md: ask <hub>/<route> asks a
// board on another of the owner's hubs through this hub, whose /_hub/peers/* relays it; that hub files it
// (takePeerAsk) and its answer comes back the same way (takePeerAnswer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { boardWith, boardsManifest, home, lines, site, write, at } from './board-fixture.mjs';
import { boardAskWaits, buildBoard } from './domain.mjs';
import { takePeerAsk, takePeerAnswer } from './store.mjs';

const QUESTION = 'Why does land rebase first?';
const setUp = () => {
  boardsManifest();
  write(at('waves', 'w', 'wave.json'), { title: 'W', items: [{ id: 'A1', title: 'feat: shared header', lane: 'progress' }] });
};
const thread = () => lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map(({ ts, ...m }) => m);
const events = (route) => lines(site(route, 'data', 'events.jsonl'));
// listBoards reads the manifest under HOME, as the hub calling takePeerAsk does.
const asHome = (t) => {
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = saved; });
};

// This hub's loopback, answering each /_hub/peers/<what> with answer(what, body) → [status, json]. → {port, got: [{method,
// path, body}]}
async function localHub(t, answer) {
  const got = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    got.push({ method: req.method, path: req.url, type: req.headers['content-type'], body });
    const [status, json] = answer(req.url.replace('/_hub/peers/', ''), body);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: String(server.address().port), got };
}

test('ask <hub>/<route> sends the question through this hub and writes the asker\'s line and record as a local ask does', async (t) => {
  setUp();
  const hub = await localHub(t, () => [200, { id: 'p1', listening: false }]);
  const r = await boardWith(['ask', 'macb/audit', QUESTION, '--from', 'w/A1', '--site', 'orch'], { KICKFLIP_HUB_PORT: hub.port });
  assert.equal(r.code, 0, r.err);
  // The asking board names the question: the other hub keeps that id, and its answer comes back under it.
  const id = /^asked macb\/audit: (e\w+)\n/.exec(r.out)?.[1];
  assert.ok(id, r.out);
  assert.deepEqual(hub.got, [{ method: 'POST', path: '/_hub/peers/ask', type: 'application/json', body: { hub: 'macb', route: 'audit', text: QUESTION, from: { route: 'orch', title: 'Orch', key: 'w/A1', ref: 'A1', id } } }]);
  assert.equal(r.out, `asked macb/audit: ${id}\nqueued: macb/audit's orchestrator isn't listening, so it answers once it is\n`);
  assert.deepEqual(thread(), [{ who: 'claude', kind: 'hub', line: 'board-asked', text: `Asked macb/audit: ${QUESTION}` }]);
  assert.deepEqual(lines(site('orch', 'data', 'board-asks.jsonl')).map(({ at: _, ...a }) => a), [{ id, to: 'macb/audit', text: QUESTION, key: 'w/A1' }]);
  assert.equal((await boardWith(['asks', '--site', 'orch'])).out, `${id} macb/audit: ${QUESTION}\n  waiting on macb/audit's orchestrator\n`);
});

test('an ask the hub queues for an offline hub is recorded, reads queued on the card and in asks, and asks reads it as sent once it went', async (t) => {
  setUp();
  asHome(t);
  const hub = await localHub(t, () => [202, { queued: 'macb is offline' }]);
  const r = await boardWith(['ask', 'macb/audit', QUESTION, '--from', 'w/A1', '--site', 'orch'], { KICKFLIP_HUB_PORT: hub.port });
  assert.equal(r.code, 0, r.err);
  const { from } = hub.got[0].body;
  assert.equal(r.out, `asked macb/audit: ${from.id}\nqueued: macb is offline, so the question goes once it's back\n`);
  assert.deepEqual(thread(), [{ who: 'claude', kind: 'hub', line: 'board-asked', text: `Asked macb/audit, queued: macb is offline: ${QUESTION}` }]);
  // The hub's outbox holds it, as /_hub/peers/ask queued it.
  const outbox = at('kickflip', 'peer-outbox.json');
  const queued = { id: 'o1', hub: 'macb', what: 'ask', body: { route: 'audit', text: QUESTION, from }, at: '2026-11-18T23:00:00.000Z', queued: 'macb is offline' };
  write(outbox, [queued]);
  const asks = () => boardWith(['asks', '--site', 'orch']).then((a) => a.out);
  assert.equal(await asks(), `${from.id} macb/audit: ${QUESTION}\n  queued: macb is offline\n`);
  write(outbox, [{ ...queued, queued: undefined, refused: 'no board at /audit; the boards are learn' }]);
  assert.equal(await asks(), `${from.id} macb/audit: ${QUESTION}\n  not sent: no board at /audit; the boards are learn\n`);
  const done = await boardWith(['asks', '--wait', '--site', 'orch']);
  assert.equal(done.code, 0, 'a refused ask waits on nothing');
  write(outbox, []);
  assert.equal(await asks(), `${from.id} macb/audit: ${QUESTION}\n  waiting on macb/audit's orchestrator\n`);
});

test('an answer the hub queues for an offline asking hub ends the wait here and says it goes once that hub is back', async (t) => {
  setUp();
  asHome(t);
  const { id } = await takePeerAsk({ route: 'audit', text: QUESTION, from: { hub: 'maca', host: 'maca.tail1234.ts.net', route: 'orch', title: 'Orch', key: 'w/A1', ref: 'A1', id: 'q1' } });
  const hub = await localHub(t, () => [202, { queued: 'maca is offline' }]);
  const r = await boardWith(['answer', id, '--text', 'So the tests run on what lands', '--site', 'audit'], { KICKFLIP_HUB_PORT: hub.port });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `answered maca/orch's question ${id}\nqueued: maca is offline, so the answer goes once it's back\n`);
  // The answer goes back under the asking board's own id for the question.
  assert.deepEqual(hub.got[0].body, { hub: 'maca', id: 'q1', route: 'orch', text: 'So the tests run on what lands', from: { route: 'audit', title: 'Audit' } });
  assert.deepEqual(boardAskWaits(events('audit')), []);
});

test('the same ask or answer arriving twice from another hub, as a retry after a lost reply, lands once', async (t) => {
  setUp();
  asHome(t);
  const hub = await localHub(t, () => [200, { id: 'p1', listening: true }]);
  const r = await boardWith(['ask', 'macb/audit', QUESTION, '--from', 'w/A1', '--site', 'orch'], { KICKFLIP_HUB_PORT: hub.port });
  const asked = hub.got[0].body.from.id;
  assert.equal(r.code, 0, r.err);
  const ask = { route: 'audit', text: QUESTION, from: { hub: 'macb', host: 'macb.tail1234.ts.net', route: 'orch', title: 'Orch', id: asked } };
  const first = await takePeerAsk(ask);
  assert.deepEqual(await takePeerAsk(ask), first);
  assert.equal(events('audit').filter((e) => e.kind === 'board-ask').length, 1);
  const answer = { id: asked, route: 'orch', text: 'Because CI', from: { hub: 'macb', route: 'audit', title: 'Audit' } };
  await takePeerAnswer(answer);
  await takePeerAnswer(answer);
  assert.equal(thread().filter((m) => m.via === 'board').length, 1);
  assert.equal(events('orch').filter((e) => e.kind === 'board-answer').length, 1);
});

test("ask <hub>/<route> records nothing when this hub refuses it or doesn't answer", async (t) => {
  setUp();
  const off = 'asks between hubs ride the tailnet, which is off on this hub; run kickflip tailnet on here and on the other hub';
  const hub = await localHub(t, () => [409, { error: off }]);
  for (const [port, err] of [[hub.port, off], ['1', /this hub doesn't answer \(.+\), so nothing went to another hub/]]) {
    const r = await boardWith(['ask', 'macb/audit', QUESTION, '--from', 'w/A1', '--site', 'orch'], { KICKFLIP_HUB_PORT: port });
    assert.equal(r.code, 1);
    assert.match(r.err, typeof err === 'string' ? new RegExp(err.replace(/[()?]/g, '\\$&')) : err);
  }
  assert.equal(fs.existsSync(site('orch', 'data', 'board-asks.jsonl')), false);
  assert.equal(fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl')), false);
});

test('a question from another hub is filed as a board-ask naming that hub, and reads <hub>/<route> in the waits and the New strip', async (t) => {
  setUp();
  asHome(t);
  const from = { hub: 'maca', host: 'maca.tail1234.ts.net', route: 'orch', title: 'Orch', key: 'w/A1', ref: 'A1' };
  const { id, listening } = await takePeerAsk({ route: 'audit', text: QUESTION, from });
  assert.equal(listening, false);
  const [e] = events('audit');
  assert.deepEqual([e.id, e.kind, e.data], [id, 'board-ask', { text: QUESTION, from }]);
  const [wait] = boardAskWaits(events('audit'));
  assert.equal(wait.ref, 'maca/orch · A1');
  assert.match(wait.next, new RegExp(`^Answer maca/orch's question: ${QUESTION.replace('?', '\\?')}: answer ${id} --text`));
  const built = buildBoard({ files: [], events: events('audit'), working: {} });
  assert.deepEqual(built.boardAsks[0].from, { words: 'maca/orch · A1', link: 'https://maca.tail1234.ts.net/orch/#selectedCard=w%2FA1' });

  const context = vm.createContext({ Date, location: { hostname: 'macb.ts.net', host: 'macb.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout });
  for (const file of ['ui-icon-text.js', 'ui.js', 'ui-links.js', 'ui-enums.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
  const html = context.BoardUI.newStrip(context.BoardUI.newEntries({ items: [], merges: [], boardAsks: built.boardAsks }, {}));
  assert.match(html, /<a class="new-source" href="https:\/\/maca.tail1234.ts.net\/orch\/#selectedCard=w%2FA1" target="_blank" rel="noopener">Asked from maca\/orch · A1<\/a>/);

  for (const [body, err] of [
    [{ route: 'nope', text: QUESTION, from }, /no board at \/nope; the boards are orch, audit/],
    [{ route: 'audit', text: 'One?\nTwo?', from }, /ask takes one line/],
    [{ route: 'audit', text: QUESTION, from: { route: 'orch' } }, /an ask from another hub names its hub, host and route/],
  ]) await assert.rejects(takePeerAsk(body), err);
  assert.equal(events('audit').length, 1);
});

test("answering another hub's question sends it back through this hub and records the answer only once it went", async (t) => {
  setUp();
  asHome(t);
  const { id } = await takePeerAsk({ route: 'audit', text: QUESTION, from: { hub: 'maca', host: 'maca.tail1234.ts.net', route: 'orch', title: 'Orch', key: 'w/A1', ref: 'A1' } });
  let refuse = true;
  const hub = await localHub(t, () => (refuse ? [502, { error: "maca doesn't answer (ECONNREFUSED): its hub is down, or its tailnet is off (kickflip tailnet on there)" }] : [200, {}]));
  const answer = 'So the tests run on what lands';
  const refused = await boardWith(['answer', id, '--text', answer, '--site', 'audit'], { KICKFLIP_HUB_PORT: hub.port });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /maca doesn't answer/);
  assert.equal(boardAskWaits(events('audit')).length, 1, 'the wait stays while the answer did not go');
  refuse = false;
  const r = await boardWith(['answer', id, '--text', answer, '--site', 'audit'], { KICKFLIP_HUB_PORT: hub.port });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `answered maca/orch's question ${id}\n`);
  assert.deepEqual(hub.got.at(-1).body, { hub: 'maca', id, route: 'orch', text: answer, from: { route: 'audit', title: 'Audit' } });
  assert.deepEqual(boardAskWaits(events('audit')), []);
});

test('an answer from another hub lands on the asking card as that board\'s message, named <hub>/<route>, and wakes the asker', async (t) => {
  setUp();
  asHome(t);
  const hub = await localHub(t, () => [200, { id: 'p1', listening: true }]);
  assert.equal((await boardWith(['ask', 'macb/audit', QUESTION, '--from', 'w/A1', '--site', 'orch'], { KICKFLIP_HUB_PORT: hub.port })).code, 0);
  const { id } = hub.got[0].body.from;
  const from = { hub: 'macb', route: 'audit', title: 'Audit' };
  for (const [body, err] of [
    [{ id, route: 'orch', text: 'Yes', from: { hub: 'macc', route: 'audit' } }, new RegExp(`/orch asked macc/audit no question ${id}`)],
    [{ id: 'p1', route: 'orch', text: 'Yes', from }, /\/orch asked macb\/audit no question p1/],
    [{ id, route: 'nope', text: 'Yes', from }, /no board at \/nope/],
  ]) await assert.rejects(takePeerAnswer(body), err);
  await takePeerAnswer({ id, route: 'orch', text: 'Because CI', from });
  assert.deepEqual(thread().at(-1), { who: 'macb/audit', text: 'Because CI', via: 'board' });
  const woke = events('orch').at(-1);
  assert.deepEqual([woke.kind, woke.data], ['board-answer', { id, from, key: 'w/A1', question: QUESTION, text: 'Because CI' }]);
  assert.equal((await boardWith(['asks', '--site', 'orch'])).out, `${id} macb/audit: ${QUESTION}\n  answered: Because CI\n`);
});

test("boards lists this hub's boards, then each other hub's as <hub>/<route> or why it can't be listed", async (t) => {
  setUp();
  const hub = await localHub(t, () => [200, { hubs: [{ hub: 'macb', boards: [{ route: 'audit', title: 'Audit' }, { route: 'learn', title: 'Learn' }] }, { hub: 'macc', error: 'macc answered 404 without asks between hubs: update kickflip there' }] }]);
  const r = await boardWith(['boards'], { KICKFLIP_HUB_PORT: hub.port });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'orch: Orch\naudit: Audit\nmacb/audit: Audit\nmacb/learn: Learn\nmacc: macc answered 404 without asks between hubs: update kickflip there\n');
  assert.deepEqual(hub.got.map((g) => [g.method, g.path]), [['GET', '/_hub/peers/boards']]);
  const off = await localHub(t, () => [409, { error: 'asks between hubs ride the tailnet, which is off on this hub' }]);
  assert.equal((await boardWith(['boards'], { KICKFLIP_HUB_PORT: off.port })).out, 'orch: Orch\naudit: Audit\nother hubs: asks between hubs ride the tailnet, which is off on this hub\n');
});
