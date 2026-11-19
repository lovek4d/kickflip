import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { boardWith, home, at, site, write, read, lines, run, board, runAsync, withDevice, wave } from './board-fixture.mjs';

test('install posts only the route and key to the hub once it quotes the owner, prints started, and reports refusals plainly', async () => {
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'Please build A1 so I can\n try it' } }) + '\n');
  const seen = [];
  let refuse = false;
  const hub = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push([req.method, req.url, JSON.parse(body)]);
    res.writeHead(refuse ? 409 : 202, { 'content-type': 'application/json' });
    res.end(JSON.stringify(refuse ? { error: 'An install build is already running for this task.' } : { status: 'started' }));
  });
  await new Promise((resolve, reject) => hub.once('error', reject).listen(0, '127.0.0.1', resolve));
  try {
    const env = { KICKFLIP_HUB_PORT: String(hub.address().port) };
    const run = () => runAsync('board.mjs', ['--site', 'orch', 'install', 'w/A1', '--asked', 'build a1 so I can try'], env);
    for (const asked of [[], ['--asked', 'just build it']]) {
      const refused = await runAsync('board.mjs', ['--site', 'orch', 'build', 'w/A1', ...asked], env);
      assert.equal(refused.code, 1);
      assert.match(refused.err, asked.length ? /--asked must quote the owner's words/ : /pass --asked/);
    }
    assert.match((await board('build', 'w/A1')).err, /needs --site/);
    assert.deepEqual(seen, []);
    assert.deepEqual(await run(), { code: 0, out: 'started\n', err: '' });
    assert.deepEqual(seen, [['POST', '/_hub/build', { route: 'orch', key: 'w/A1' }]]);
    assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map(({ who, text }) => [who, text]), [['claude', 'Running at the owner\'s ask: "build a1 so I can try"']]);
    refuse = true;
    assert.deepEqual(await run(), { code: 1, out: '', err: 'An install build is already running for this task.\n' });
  } finally { await new Promise((resolve) => { hub.closeAllConnections(); hub.close(resolve); }); }
});

test('reply answers a known event in markdown, naming its card, and refuses an unknown one', async () => {
  write(site('orch', 'data', 'replies', 'e1.html'), '<p>Before markdown.</p>');
  assert.deepEqual(await board('reply', 'e1', '--site', 'orch', '--text', '**Done.**'), { code: 0, err: '', out: 'reply written to task e1\n' });
  const rep = (n) => site('orch', 'data', 'replies', n);
  assert.equal(fs.readFileSync(rep('e1~2.md'), 'utf8'), '**Done.**');
  assert.equal(fs.readFileSync(rep('e1.html'), 'utf8'), '<p>Before markdown.</p>', 'a later reply is appended; the first reply stays');
  assert.equal(run('board.mjs', ['reply', 'e1', '--site', 'orch', '--file', '-'], '- Again.').code, 0);
  assert.equal(fs.readFileSync(rep('e1~3.md'), 'utf8'), '- Again.');
  assert.equal(fs.readFileSync(rep('e1~2.md'), 'utf8'), '**Done.**', 'a third reply leaves the second');
  write(at('waves', 'internal', 'wave.json'), { internal: true, items: [{ id: 'S80', title: 'Legacy' }] });
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'item-message', data: { key: 'internal/S80', text: 'Still on?' } }) + '\n');
  assert.deepEqual(await board('reply', 'e2', '--site', 'orch', '--text', 'Yes.'), { code: 0, err: '', out: 'reply written to INT-80\n' });
  const r = await board('reply', 'e9', '--site', 'orch', '--text', 'x');
  assert.equal(r.code, 1);
  assert.match(r.err, /no event "e9"/);
  assert.equal(fs.existsSync(site('orch', 'data', 'replies', 'e9.md')), false);
  assert.deepEqual(read(at('waves', 'w', 'wave.json')), wave());
  assert.equal(lines(site('orch', 'data', 'events.jsonl')).some((e) => e.ticket), false);
  assert.match((await board('reply', 'e1', '--site', 'orch', '--html', '<p>x</p>')).err, /reply does not take --html/);
});

test('reply refuses a file path passed as --text, which would post the path itself', async () => {
  const r = await board('reply', 'e1', '--site', 'orch', '--text', '/tmp/scratch/answer.md');
  assert.equal(r.code, 2);
  assert.match(r.err, /--file \/tmp\/scratch\/answer\.md/);
  assert.equal(fs.existsSync(site('orch', 'data', 'replies', 'e1.md')), false);
});

test('every text flag refuses a bare file path, and --file refuses a missing file', async () => {
  const real = path.join(home, 'notes');
  write(real, 'hello');
  const thread = await board('thread', 'w/A1', '--site', 'orch', '--text', real);
  assert.equal(thread.code, 2);
  assert.match(thread.err, /--text takes text, not a file path/);
  assert.doesNotMatch(thread.err, /for a file use/);
  assert.equal((await board('item', 'set', 'w/A1', '--site', 'orch', '--next', './plan.md')).code, 2);
  assert.equal((await board('thread', 'w/A1', '--site', 'orch', '--text', 'Wrote docs/plan.md for you')).code, 0);
  const missing = await board('reply', 'e1', '--site', 'orch', '--file', path.join(home, 'nope.html'));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no such file/);
});

test("thread appends a line to an item's thread", async () => {
  assert.equal((await board('thread', 'w/A1', '--site', 'orch', '--text', 'Built.', '--who', 'Jamie', '--via', 'github', '--link', 'https://github.com/o/r/pull/1')).code, 0);
  assert.equal((await board('thread', 'w/A1', '--site', 'orch', '--text', 'Merged.')).code, 0);
  const msgs = lines(site('orch', 'data', 'threads', 'w__A1.jsonl'));
  assert.deepEqual(msgs.map(({ ts, ...m }) => m), [
    { who: 'Jamie', text: 'Built.', link: 'https://github.com/o/r/pull/1', via: 'github' },
    { who: 'claude', text: 'Merged.' },
  ]);
  assert.ok(!Number.isNaN(Date.parse(msgs[0].ts)));
  const links = ['prototype-x.html', 'prototype-x.html?q=some-id', 'prototype-x.html#take-A', 'prototype-x.html?q=some-id#take-A', 'http://example.com/prototype'];
  for (const link of links) {
    const r = await board('thread', 'w/A1', '--site', 'orch', '--text', 'Pick a take.', '--link', link);
    assert.equal(r.code, 0, r.err);
  }
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).slice(msgs.length).map((m) => m.link), links);
});

test('thread refuses an unknown item, an empty text, an unknown channel and invalid links', async () => {
  assert.equal((await board('thread', 'w/Z9', '--site', 'orch', '--text', 'Hi')).code, 1);
  assert.equal((await board('thread', 'w/A1', '--site', 'orch', '--text', ' ')).code, 1);
  assert.equal((await board('thread', 'w/A1', '--site', 'orch', '--text', 'Hi', '--via', 'email')).code, 1);
  assert.equal((await board('thread', 'w/A1', '--text', 'Hi')).code, 1);
  for (const link of ['javascript:alert(1)', 'data:text/html,Hi', 'file:///tmp/prototype-x.html', 'ftp://example.com/page', '//example.com/page', '/orch/prototype-x.html', 'notes.html', 'prototype-x.html?q=some id']) {
    const r = await board('thread', 'w/A1', '--site', 'orch', '--text', 'Hi', '--link', link);
    assert.equal(r.code, 1, link);
    assert.match(r.err, /--link must be an http\(s\) URL or a site page/);
  }
  assert.equal(fs.existsSync(site('orch', 'data', 'threads')), false);
});

test('a refusal exits non-zero with one line naming the bad flag, and changes nothing', async () => {
  for (const [args, code, err] of [
    [['item', 'set', 'w/A1', '--site', 'orch', '--colour', 'red'], 2, /^item set does not take --colour\b/],
    [['item', 'set', 'w/A1', '--site', 'orch', '--phase', 'shipped'], 1, /^--phase takes /],
  ]) {
    const r = await board(...args);
    assert.equal(r.code, code, args.join(' '));
    assert.match(r.err, err, args.join(' '));
    assert.equal(r.err.trim().split('\n').length, 1, args.join(' '));
  }
  assert.equal((await board('frobnicate')).code, 2);
  assert.deepEqual(read(at('waves', 'w', 'wave.json')), wave());
});

test('push adds the replies written since the last push to the body, and records the push only when kickflip push succeeds', async () => {
  const stub = path.join(home, 'stub.mjs');
  const calls = path.join(home, 'calls.jsonl');
  write(stub, "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n'); process.exit(Number(process.env.STUB_EXIT || 0));");
  const push = (exit, ...args) => boardWith(['push', '--site', 'orch', ...args], { KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, stub, 'push']), STUB_CALLS: calls, STUB_EXIT: String(exit) });
  const state = site('orch', 'data', 'push-state.json');
  const reply = (id, msAgo, ext = 'md') => {
    write(site('orch', 'data', 'replies', `${id}.${ext}`), ext === 'md' ? 'Done.' : '<p>Done.</p>');
    const t = new Date(Date.now() - msAgo);
    fs.utimesSync(site('orch', 'data', 'replies', `${id}.${ext}`), t, t);
  };

  reply('e1', 60_000);
  assert.equal((await push(0, '--kind', 'fault', '--title', 'Question', '--body', 'Pick one', '--url', '/orch/questions.html')).code, 0);
  assert.ok(!Number.isNaN(Date.parse(read(state).last_push)));

  write(state, { last_push: new Date(Date.now() - 30_000).toISOString() });
  reply('e2', 10_000);
  reply('e3', 5_000, 'html');
  reply('e3~2', 4_000);
  const failed = await push(3, '--kind', 'fault', '--title', 'Ready', '--body', 'A1 is green', '--tag', 'ready-A1', '--urgent');
  assert.equal(failed.code, 3);
  const kept = read(state).last_push;
  assert.equal((await push(0, '--kind', 'fault', '--title', 'Ready', '--tag', 'ready-A1')).code, 0);
  assert.ok(Date.parse(read(state).last_push) > Date.parse(kept));
  assert.equal((await push(0, '--kind', 'fault', '--title', 'Orch is down')).code, 0);
  assert.equal((await push(0, '--kind', 'fault', '--title', 'e1 waits on your Done', '--tag', 'ask-e1', '--now')).code, 0);
  assert.equal((await push(0, '--kind', 'reminder', '--title', 'Everything is done', '--now')).code, 0);

  assert.deepEqual(lines(calls), [
    ['push', '--kind', 'fault', '--title', 'Question', '--body', 'Pick one', '--url', '/orch/questions.html?from=push'],
    ['push', '--kind', 'fault', '--title', 'Ready', '--body', 'A1 is green · and 3 replies', '--tag', 'ready-A1', '--urgent'],
    ['push', '--kind', 'fault', '--title', 'Ready', '--body', 'and 3 replies', '--tag', 'ready-A1'],
    ['push', '--kind', 'fault', '--title', 'Orch is down'],
    ['push', '--kind', 'fault', '--title', 'e1 waits on your Done', '--tag', 'ask-e1', '--now'],
    ['push', '--kind', 'reminder', '--title', 'Everything is done', '--now'],
  ]);
  assert.equal((await board('push', '--site', 'orch', '--kind', 'fault')).code, 2);
  assert.equal((await board('push', '--kind', 'fault', '--title', 'No site')).code, 1);
});

test("a Claude thread line or reply rewrites its item's queued push to the latest message, and a sent push stays sent", async () => {
  const board = (...args) => boardWith(args, { KICKFLIP_PUSH_CMD: '' });
  write(at('kickflip', 'push', 'subs.json'), [{ endpoint: 'https://push.invalid/device', keys: { p256dh: 'x', auth: 'y' }, origin: 'https://hub.invalid' }]);
  const queueFile = at('kickflip', 'push', 'queue.json');
  const queue = () => Object.fromEntries(read(queueFile).items.map((i) => [i.tag, i.body]));
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'm1', ts: '2026-10-23T10:05:00Z', kind: 'item-message', data: { key: 'w/A1' } }) + '\n');
  const lastPush = () => write(site('orch', 'data', 'push-state.json'), { last_push: new Date(Date.now() - 60_000).toISOString() });
  write(site('orch', 'data', 'replies', 'old.html'), '<p>Earlier.</p>');

  assert.equal((await board('push', '--site', 'orch', '--kind', 'fault', '--title', 'e1 waits on your Done', '--body', 'Too early', '--tag', 'ask-e1')).code, 0);
  lastPush();
  assert.equal((await board('push', '--site', 'orch', '--kind', 'fault', '--title', 'e1 waits on your Done', '--body', 'First answer', '--tag', 'ask-e1')).code, 0);
  assert.equal((await board('push', '--site', 'orch', '--kind', 'fault', '--title', 'One needs you', '--body', 'Pick a layout', '--url', '/orch/prototype-layout.html?q=w-layout', '--tag', 'item-w/A1')).code, 0);
  assert.deepEqual(queue(), { 'ask-e1': 'First answer · and 1 reply', 'item-w/A1': 'Pick a layout' });
  const urls = () => Object.fromEntries(read(queueFile).items.map((i) => [i.tag, i.url]));
  assert.equal(urls()['item-w/A1'], '/orch/prototype-layout.html?q=w-layout&from=push');

  assert.equal((await board('thread', 'ask:e1', '--site', 'orch', '--text', 'Second answer\nwith more below')).code, 0);
  assert.deepEqual(queue(), { 'ask-e1': 'Second answer · and 1 reply', 'item-w/A1': 'Pick a layout' });
  assert.equal((await board('thread', 'ask:e1', '--site', 'orch', '--who', 'love', '--text', 'Thanks')).code, 0);
  assert.equal((await board('thread', 'w/A1', '--site', 'orch', '--who', 'Jamie', '--via', 'github', '--text', 'Looks good')).code, 0);
  assert.deepEqual(queue(), { 'ask-e1': 'Second answer · and 1 reply', 'item-w/A1': 'Pick a layout' });

  assert.equal((await board('reply', 'e1', '--site', 'orch', '--text', 'Third & final\n\n- Why: long')).code, 0);
  const long = 'Layout B, because '.repeat(20);
  assert.equal((await board('reply', 'm1', '--site', 'orch', '--text', long)).code, 0);
  const bodies = queue();
  assert.equal(bodies['ask-e1'], 'Third & final · and 1 reply');
  assert.equal(urls()['item-w/A1'], '/orch/#selectedCard=w%2FA1&reply');
  assert.ok(bodies['item-w/A1'].length <= 160 && bodies['item-w/A1'].endsWith('…') && long.startsWith(bodies['item-w/A1'].slice(0, -1)));

  write(queueFile, { items: [] });
  assert.equal((await board('thread', 'ask:e1', '--site', 'orch', '--text', 'After it went out')).code, 0);
  assert.deepEqual(read(queueFile).items, []);
});

test('a push without an allowed kind is refused with one line, board.mjs allowing only a fault, and nothing goes', async () => {
  const webTs = (...args) => runAsync(path.join('..', '..', 'bin', 'kickflip.mjs'), ['push', ...args], { KICKFLIP_HUB_PORT: '9' });
  for (const r of [
    await board('push', '--site', 'orch', '--title', 'Answered: keep it?', '--now'),
    await board('push', '--site', 'orch', '--kind', 'info', '--title', '2 PRs merged'),
    await board('push', '--site', 'orch', '--kind', 'action', '--title', 'A1 asks: Which layout?', '--tag', 'item-w/A1'),
    await board('push', '--site', 'orch', '--kind', 'prompt', '--title', 'Orch wants to run tests'),
  ]) {
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /a session pushes only --kind fault/);
    assert.equal(r.err.trim().split('\n').length, 1, r.err);
  }
  for (const r of [
    await webTs('--title', 'Orch board connected', '--now'),
    await webTs('--kind', 'info', '--title', 'Morning digest'),
  ]) {
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /a push needs --kind action\|prompt\|fault/);
    assert.equal(r.err.trim().split('\n').length, 1, r.err);
  }
  assert.equal(fs.existsSync(at('kickflip', 'push', 'queue.json')), false);
  assert.equal(fs.existsSync(site('orch', 'data', 'push-state.json')), false);
});

test("after a thread's push has gone, Claude's lines and replies there push nothing; a card whose action changes pushes again under its tag", async () => withDevice(async (b, received) => {
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'm1', ts: '2026-10-23T10:05:00Z', kind: 'item-message', data: { key: 'w/A1' } }) + '\n');
  const seen = () => received.map(({ title, body, url, tag }) => [tag, title, body, url]);
  const url = '/orch/#selectedCard=w%2FA1';

  assert.equal((await b('push', '--site', 'orch', '--kind', 'fault', '--now', '--title', 'A1 asks: Which layout?', '--body', 'Grid · List', '--url', url, '--tag', 'item-w/A1')).code, 0);
  assert.equal((await b('thread', 'w/A1', '--site', 'orch', '--text', 'Grid fits the phone')).code, 0);
  assert.equal((await b('reply', 'm1', '--site', 'orch', '--text', 'Filed as follow-up INT-56')).code, 0);
  assert.equal((await b('reply', 'e1', '--site', 'orch', '--text', 'Yes, keep it')).code, 0);
  assert.equal((await b('thread', 'w/A1', '--site', 'orch', '--text', 'Done', '--answer')).code, 2);
  assert.equal(received.length, 1);

  assert.equal((await b('push', '--site', 'orch', '--kind', 'fault', '--now', '--title', 'A1 asks: Which colour?', '--body', 'Blue · Red', '--url', url, '--tag', 'item-w/A1')).code, 0);
  assert.deepEqual(seen(), [
    ['item-w/A1', 'A1 asks: Which layout?', 'Grid · List', `${url}&reply`],
    ['item-w/A1', 'A1 asks: Which colour?', 'Blue · Red · and 2 replies', `${url}&reply`],
  ]);
  assert.deepEqual(read(at('kickflip', 'push', 'queue.json')).items, []);
}));

test('a reminder the owner asked for goes out as kickflip push sends a fault', async () => withDevice(async (b, received) => {
  const r = await b('push', '--site', 'orch', '--kind', 'reminder', '--title', 'Everything is done', '--body', 'Orch has nothing in progress', '--url', '/orch/', '--now');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(received.map(({ title, body }) => [title, body]), [['Everything is done', 'Orch has nothing in progress']]);
}));

test("thread writes in an ask's thread and refuses an unknown ask", async () => {
  assert.equal((await board('thread', 'ask:e1', '--site', 'orch', '--text', 'Answered here.')).code, 0);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'ask__e1.jsonl')).map(({ ts, ...m }) => m), [{ who: 'claude', text: 'Answered here.' }]);
  assert.match((await board('thread', 'ask:e9', '--site', 'orch', '--text', 'x')).err, /no ask "e9"/);
});

// docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
test("visual add places the agent's page under the site's public/visuals/<card>/, a new page each time, and links it from the thread", async () => {
  const page = path.join(home, 'land-queue.html');
  fs.writeFileSync(page, '<!doctype html><title>Queue</title><script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>');
  const add = () => board('--site', 'orch', 'visual', 'add', 'w/A1', '--file', page, '--title', 'How a land moves');
  assert.deepEqual(await add(), { code: 0, err: '', out: 'visuals/A1/how-a-land-moves.html\n' });
  assert.equal(fs.readFileSync(site('orch', 'public', 'visuals', 'A1', 'how-a-land-moves.html'), 'utf8'), fs.readFileSync(page, 'utf8'));
  assert.equal((await add()).out, 'visuals/A1/how-a-land-moves-2.html\n', 'asking again makes a new page');
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map(({ who, kind, text, link }) => [who, kind, text, link]), [
    ['claude', 'visual', 'How a land moves', 'visuals/A1/how-a-land-moves.html'], ['claude', 'visual', 'How a land moves', 'visuals/A1/how-a-land-moves-2.html'],
  ]);
  const missing = await board('--site', 'orch', 'visual', 'add', 'w/A1', '--file', path.join(home, 'nope.html'), '--title', 'X');
  assert.equal(missing.code, 2);
  assert.match(missing.err, /nope\.html/);
  const plain = path.join(home, 'notes.txt');
  fs.writeFileSync(plain, 'hi');
  assert.match((await board('--site', 'orch', 'visual', 'add', 'w/A1', '--file', plain, '--title', 'X')).err, /\.html/);
  assert.match((await board('--site', 'orch', 'visual', 'add', 'w/A1', '--file', page)).err, /--title/);
});

// docs/adr/2026-11-09-1200-the-board-writes-status-lines-and-only-the-orchestrator-writes-messages.md
test('a message runs to at most 2000 characters, and a longer one is refused with how to rewrite it; a GitHub comment is kept whole', async () => {
  assert.equal((await board('thread', 'w/A1', '--site', 'orch', '--text', 'x'.repeat(2000))).code, 0);
  const long = await board('thread', 'w/A1', '--site', 'orch', '--text', 'y'.repeat(2001));
  assert.equal(long.code, 1);
  assert.match(long.err, /runs to 2001 characters, past a message's 2000: rewrite it shorter, or put the detail in an HTML page \(board\.mjs visual add, or --link to a page\) and link it/);
  assert.equal((await board('thread', 'w/A1', '--site', 'orch', '--text', 'z'.repeat(2001), '--via', 'github', '--who', 'Jamie')).code, 0);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map((m) => m.text[0]), ['x', 'z']);
  const close = await board('item', 'set', 'w/A1', '--site', 'orch', '--done', '--text', 'y'.repeat(2001));
  assert.equal(close.code, 1);
  assert.match(close.err, /past a message's 2000/);
  assert.notEqual(read(at('waves', 'w', 'wave.json')).items.find((i) => i.id === 'A1').lane, 'done', 'refused before it closes');
});

test('the board writes a thread only through appendStatus and appendMessage: no code appends a plain line to a thread file', async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const sources = ['board', 'board/bin', 'hub', 'shared', 'bin'].flatMap((dir) => fs.readdirSync(path.join(root, dir))
    .filter((f) => /\.m?js$/.test(f) && !f.includes('.test.')).map((f) => path.join(root, dir, f)));
  const data = ['cards', 'questions', 'asks', 'settings', 'runs'].map((m) => path.join('board', `${m}.mjs`));
  let raw = 0;
  for (const file of sources) {
    const code = fs.readFileSync(file, 'utf8');
    const name = path.relative(root, file);
    assert.doesNotMatch(code, /appendFile(Sync)?\([^)]*thread/i, `${name} appends to a thread file itself`);
    if (!data.includes(name)) continue;
    // In the board's data modules, every raw write to a thread is a line of a kind or a command, or one of the line a
    // writer built: appendStatus's, appendMessage's, appendCommand's and a move's.
    const writes = [...code.matchAll(/appendLine\((?:threadFile\([^)]*\)|file), ([^\n]*)\);\n/g)];
    raw += writes.length;
    for (const w of writes) {
      const writer = [...code.slice(0, w.index).matchAll(/function (\w+)\(/g)].at(-1)[1];
      if (w[1] === 'line') assert.ok(['appendStatus', 'appendMessage', 'appendCommand', 'moveCard'].includes(writer), `${writer} writes a line it built`);
      else assert.match(w[1], /\b(kind|command)\b/, `${writer} writes a plain thread line: ${w[1]}`);
    }
  }
  assert.ok(raw > 0);
});
