import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let home, site, child, base;
const uploads = () => path.join(site, 'data', 'uploads');

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'board-server-'));
  site = path.join(home, 'site');
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/wave.json', slug: 't' }));
  fs.writeFileSync(path.join(site, 'data', 'owner.json'), '{"items":[]}');
  const port = 47000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], { env: { ...process.env, HOME: home, PORT: String(port) } });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', reject); });
});
after(() => { child.kill(); fs.rmSync(home, { recursive: true, force: true }); });

const upload = (body, name, type) => fetch(`${base}/api/upload`, { method: 'POST', headers: { 'x-filename': encodeURIComponent(name), 'content-type': type }, body });

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

test("an ask marked in progress waits on the owner in In Review until their ask-done moves it to Done", async () => {
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { id } = await post('/_claude/events', { kind: 'ask', text: 'Settings prototype' });
  const card = async () => (await (await fetch(`${base}/api/board`)).json()).items.find((i) => i.key === `ask:${id}`);
  fs.writeFileSync(path.join(site, 'data', 'ask-progress.json'), JSON.stringify({ asks: { [id]: { state: 'progress', at: new Date(Date.now() - 1000).toISOString(), next: 'Pick a take' } } }));
  assert.deepEqual(await card().then((c) => [c.lane, c.next, c.finishable]), ['review', 'Pick a take', true]);
  await post('/_claude/events', { kind: 'ask-done', id });
  assert.deepEqual(await card().then((c) => [c.lane, c.fold, c.finishable]), ['done', 'asks', false]);
});

test('a watcher that just exited on an event still counts as listening, until its session stops', async () => {
  const session = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(session.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim();
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${session.pid}.json`), JSON.stringify({ pid: session.pid, sessionId: 's1', cwd: home, procStart, kind: 'bg' }));
  fs.mkdirSync(path.join(home, '.claude', 'web-ts'), { recursive: true });
  const cmd = [process.execPath, path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site];
  fs.writeFileSync(path.join(home, '.claude', 'web-ts', 'manifest.json'), JSON.stringify({ sites: { t: { dir: site, port: 1, cmd, owner: { session: 's1' } } } }));
  fs.writeFileSync(path.join(site, 'data', 'checked.json'), JSON.stringify({ at: new Date().toISOString(), every: 30 }));
  const watcher = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wait-events.mjs'), 't', 's1'], { env: { ...process.env, HOME: home } });
  const out = [];
  watcher.stdout.on('data', (c) => out.push(String(c)));
  const exited = new Promise((resolve) => watcher.once('exit', resolve));
  await new Promise((r) => setTimeout(r, 500));
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
  assert.deepEqual(item.agents.map((a) => [a.name, a.kind]), [['main', 'opus'], ['bench', 'codex']]);
  assert.deepEqual([item.waitsOn, item.builder.progress, item.eta], ['builder', 'Codex: Running benchmarks', '2026-10-23T16:30:00Z']);
  const thread = (await (await fetch(`${base}/api/thread?key=t%2FA3`)).json()).map((m) => [m.kind || m.who, m.text, m.finished ?? null, m.eta ?? null]);
  assert.deepEqual(thread, [
    ['agent', 'Opus builder started', false, null],
    ['status', 'Planning', null, null],
    ['agent', 'Codex started', false, '2026-10-23T16:30:00Z'],
    ['status', 'Codex: Running benchmarks', null, null],
    ['claude', 'Halfway.', null, null],
    ['agent', 'Opus builder finished', true, null],
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
    assert.match(page, /^<title>T<\/title><header class="top"><div class="brand"><a class="back" href="\.\/#item=t%2FP1" aria-label="Back to the board">/);
    assert.doesNotMatch(page, /<!--header/);
  } finally { fs.rmSync(path.join(pub, 'prototype-hdr.html')); }
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

test('the stream sends a change, uncompressed, within a second of a write to a thread or a wave file', async () => {
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
      const started = Date.now();
      while (changes() === seen) {
        assert.ok(Date.now() - started < 1000, `no change signal within a second; got ${JSON.stringify(text)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await new Promise((r) => setTimeout(r, 600));
    fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
    for (const write of [
      () => fs.appendFileSync(path.join(site, 'data', 'threads', 't__S1.jsonl'), JSON.stringify({ ts: new Date().toISOString(), who: 'claude', text: 'Live' }) + '\n'),
      () => fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify({ items: [{ id: 'S1', title: 'Streamed' }] })),
    ]) {
      await new Promise((r) => setTimeout(r, 400));
      const signal = nextChange();
      write();
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
  const cfg = { title: 'T', items: 'data/wave.json', slug: 't' };
  const web = path.join(home, '.claude', 'web-ts');
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

test("the settings page's auto-merge toggle writes board.json, keeping its other keys, and wakes Claude only when the value moves", async () => {
  const cfg = { title: 'T', items: 'data/wave.json', slug: 't' };
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, rules: [{ id: 'r1', text: 'Ask first', by: 'owner', at: 'x' }] }));
  const save = (body) => fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const settingsEvents = async () => (await (await fetch(`${base}/_claude/events?kind=settings`)).json()).map((e) => e.data);
  try {
    assert.deepEqual(await (await fetch(`${base}/api/settings`)).json(), { settings: { auto_merge: false } });
    const on = await save({ auto_merge: true });
    assert.equal(on.status, 200);
    const out = await on.json();
    assert.deepEqual(out.settings, { auto_merge: true });
    assert.match(out.id, /^e/);
    const written = JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8'));
    assert.deepEqual([written.title, written.rules.length, written.auto_merge], ['T', 1, true]);
    assert.deepEqual(await settingsEvents(), [{ auto_merge: true }]);
    assert.equal((await (await save({ auto_merge: true })).json()).id, null);
    for (const bad of [{ auto_merge: 'yes' }, { auto_deploy: true }, {}, ['x']]) assert.equal((await save(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await settingsEvents()).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8')).auto_merge, true);
  } finally {
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify(cfg));
  }
});

test('Board Settings saves and clears a validated install script, preserving board.json and logging changes without a thread', async () => {
  const cfg = { title: 'T', items: 'data/wave.json', slug: 't', auto_merge: true };
  const script = path.join(home, 'install.sh');
  fs.writeFileSync(script, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify(cfg));
  const save = (body) => fetch(`${base}/api/install-script`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const log = path.join(home, '.claude', 'web-ts', 'hub.log');
  const beforeLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const eventFile = path.join(site, 'data', 'events.jsonl');
  const events = fs.existsSync(eventFile) ? fs.readFileSync(eventFile, 'utf8') : '';
  try {
    assert.deepEqual(await (await fetch(`${base}/api/install-script`)).json(), { install_script: '' });
    for (const install_script of ['relative.sh', script + '.missing', home]) {
      const r = await save({ install_script });
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /Install script must/);
    }
    fs.chmodSync(script, 0o720);
    assert.equal((await save({ install_script: script })).status, 400);
    fs.chmodSync(script, 0o700);
    for (const body of [{}, { install_script: script, command: 'anything' }]) assert.equal((await save(body)).status, 400);
    assert.deepEqual(await (await save({ install_script: script })).json(), { install_script: script });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(site, 'board.json'))), { ...cfg, install_script: script });
    assert.equal((await (await fetch(`${base}/api/install-script`)).json()).install_script, script);
    const changed = fs.readFileSync(log, 'utf8');
    assert.match(changed.slice(beforeLog.length), /install script/);
    assert.ok(changed.includes(script));
    await save({ install_script: script });
    assert.equal(fs.readFileSync(log, 'utf8'), changed);
    assert.equal((await save({ install_script: '' })).status, 200);
    assert.equal(fs.existsSync(eventFile) ? fs.readFileSync(eventFile, 'utf8') : '', events);
  } finally { fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/wave.json', slug: 't' })); }
});

test('the watcher prints the hub rules, then the board rules, then the board settings, after the event lines', async () => {
  const cfg = { title: 'T', items: 'data/wave.json', slug: 't' };
  const web = path.join(home, '.claude', 'web-ts');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'manifest.json'), JSON.stringify({ sites: { t: { dir: site } } }));
  fs.writeFileSync(path.join(web, 'settings.json'), JSON.stringify({ polling: {}, rules: [{ id: 'h1', text: 'Screenshots in every PR', by: 'owner', at: 'x' }] }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, rules: [{ id: 'b1', text: 'Ask before\ntouching main', by: 'claude', at: 'x' }, { text: 'no id' }] }));
  const watch = async (session) => {
    const watcher = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wait-events.mjs'), 't', session], { env: { ...process.env, HOME: home } });
    const out = [];
    watcher.stdout.on('data', (c) => out.push(String(c)));
    const exited = new Promise((resolve) => watcher.once('exit', resolve));
    await new Promise((r) => setTimeout(r, 500));
    await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ask', text: 'Wake' }) });
    assert.equal(await exited, 0);
    return out.join('').trim().split('\n');
  };
  try {
    const lines = await watch('rules1');
    assert.match(lines[0], /^event data\/events\.jsonl /);
    assert.deepEqual(lines.slice(1), ['rule hub Screenshots in every PR', 'rule board Ask before touching main', 'setting auto-merge off']);
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ ...cfg, auto_merge: true }));
    fs.rmSync(path.join(web, 'settings.json'));
    assert.deepEqual((await watch('rules2')).slice(1), ['setting auto-merge on']);
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
