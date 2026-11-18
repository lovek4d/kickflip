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
  assert.deepEqual(hub.got, [{ method: 'POST', path: '/_hub/peers/ask', type: 'application/json', body: { hub: 'macb', route: 'audit', text: QUESTION, from: { route: 'orch', title: 'Orch', key: 'w/A1', ref: 'A1' } } }]);
  assert.equal(r.out, "asked macb/audit: p1\nqueued: macb/audit's orchestrator isn't listening, so it answers once it is\n");
  assert.deepEqual(thread(), [{ who: 'claude', kind: 'hub', line: 'board-asked', text: `Asked macb/audit: ${QUESTION}` }]);
  assert.deepEqual(lines(site('orch', 'data', 'board-asks.jsonl')).map(({ at: _, ...a }) => a), [{ id: 'p1', to: 'macb/audit', text: QUESTION, key: 'w/A1' }]);
  assert.equal((await boardWith(['asks', '--site', 'orch'])).out, `p1 macb/audit: ${QUESTION}\n  waiting on macb/audit's orchestrator\n`);
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
  const from = { hub: 'macb', route: 'audit', title: 'Audit' };
  for (const [body, err] of [
    [{ id: 'p1', route: 'orch', text: 'Yes', from: { hub: 'macc', route: 'audit' } }, /\/orch asked macc\/audit no question p1/],
    [{ id: 'p9', route: 'orch', text: 'Yes', from }, /\/orch asked macb\/audit no question p9/],
    [{ id: 'p1', route: 'nope', text: 'Yes', from }, /no board at \/nope/],
  ]) await assert.rejects(takePeerAnswer(body), err);
  await takePeerAnswer({ id: 'p1', route: 'orch', text: 'Because CI', from });
  assert.deepEqual(thread().at(-1), { who: 'macb/audit', text: 'Because CI', via: 'board' });
  const woke = events('orch').at(-1);
  assert.deepEqual([woke.kind, woke.data], ['board-answer', { id: 'p1', from, key: 'w/A1', question: QUESTION, text: 'Because CI' }]);
  assert.equal((await boardWith(['asks', '--site', 'orch'])).out, `p1 macb/audit: ${QUESTION}\n  answered: Because CI\n`);
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
