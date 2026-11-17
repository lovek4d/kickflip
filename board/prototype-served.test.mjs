// docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md
// A served round: a page in the board's base prototype worktree, recorded with prototype add --served, framed by the
// board's viewer, which switches its takes and states by message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { home, at, site, write, read, board, question, git, commit } from './board-fixture.mjs';

const served = (topic = 'look', extra = []) => board('prototype', 'add', topic, '--site', 'orch', '--title', 'Look', '--served', '/proto/look',
  '--take', 'A:Chips', '--take', 'B:Stepper', ...extra);
const ask = async (url = 'prototype-look.html?q=q1') => {
  write(path.join(home, 'q.json'), question('q1', { url, options: [{ id: 'A', label: 'Chips', recommended: true }, { id: 'B', label: 'Stepper' }] }));
  return await board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json'));
};

test('prototype add --served records the page path and named states, with no take files to write', async () => {
  const r = await served('look', ['--state', 'empty:No tasks', '--state', 'busy:Ten tasks running']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, ['prototype look recorded', 'page prototype-look.html', 'served /proto/look from the base prototype worktree (board.mjs prototype base)', 'states empty, busy', ''].join('\n'));
  const [record] = read(site('orch', 'data', 'prototypes.json')).prototypes;
  assert.deepEqual({ ...record, at: undefined }, { id: 'look', topic: 'look', title: 'Look', served: '/proto/look', takes: [{ key: 'A', label: 'Chips' }, { key: 'B', label: 'Stepper' }],
    states: [{ key: 'empty', label: 'No tasks' }, { key: 'busy', label: 'Ten tasks running' }], at: undefined });
  assert.equal((await board('prototype', 'list', '--site', 'orch')).out, 'look · Look · A: Chips, B: Stepper · served /proto/look · states empty, busy\n');
});

test('prototype add refuses states without --served, a served path that is not a site path, and a bad or repeated state', async () => {
  const refusals = [
    [['t', '--take', 'A:Keep', '--state', 'empty:None'], '--state goes with --served: only a served round re-renders its states in place'],
    [['t', '--take', 'A:Keep', '--served', 'proto/x'], '--served takes the page\'s path on the served site, starting with "/", not "proto/x"'],
    [['t', '--take', 'A:Keep', '--served', 'https://x/proto'], '--served takes the page\'s path on the served site, starting with "/", not "https://x/proto"'],
    [['t', '--take', 'A:Keep', '--served', '/x', '--state', 'Empty:None'], '--state takes KEY:"Label" with KEY in a-z, 0-9 and "-", not "Empty:None"'],
    [['t', '--take', 'A:Keep', '--served', '/x', '--state', 'e:One', '--state', 'e:Two'], '--state e is given twice'],
  ];
  for (const [args, line] of refusals) assert.deepEqual(await board('prototype', 'add', ...args, '--site', 'orch', '--title', 'T'), { code: 1, out: '', err: line + '\n' }, line);
  assert.equal(fs.existsSync(site('orch', 'data', 'prototypes.json')), false);
});

test("a served round's question needs no take files, and still names takes its options must come from", async () => {
  assert.equal((await served()).code, 0);
  const r = await ask();
  assert.equal(r.code, 0, r.err);
  assert.equal(read(site('orch', 'data', 'owner.json')).items[0].url, 'prototype-look.html?q=q1');
});

test('the hub keeps the base worktree served while an open question links a served round, and no longer once it resolves', async () => {
  const { servedRoundsOpen } = await import('./store.mjs');
  assert.deepEqual(await servedRoundsOpen(site('orch')), []);
  assert.equal((await served()).code, 0);
  assert.equal((await board('prototype', 'add', 'files', '--site', 'orch', '--title', 'Files', '--take', 'A:Keep')).code, 0);
  assert.deepEqual(await servedRoundsOpen(site('orch')), []);
  assert.equal((await ask()).code, 0);
  assert.deepEqual(await servedRoundsOpen(site('orch')), ['look']);
  const owner = read(site('orch', 'data', 'owner.json'));
  owner.items[0].resolved = '2026-11-06T10:00:00Z';
  write(site('orch', 'data', 'owner.json'), owner);
  assert.deepEqual(await servedRoundsOpen(site('orch')), []);
});

test('prototype base makes the board a worktree on main, moves it to a new tip keeping round pages, and stays put when a page edit blocks the move', async () => {
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  commit(repo, 'app/routes.js', 'export default [];\n');
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), cmd: ['node', 'board/server.mjs'], owner: { repo } } } });
  const base = at('kickflip', 'worktrees', 'orch-prototypes');
  const frame = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'shared', 'prototype-frame.js');

  const first = await board('prototype', 'base', '--site', 'orch');
  assert.equal(first.code, 0, first.err);
  const sha = git(repo, 'rev-parse', 'main');
  assert.equal(first.out, [`base ${base} at ${sha.slice(0, 7)}, made from main`, 'build script .kickflip/build is missing: write one that serves the app and prints "port <n>"', `listener ${frame}`, ''].join('\n'));
  assert.equal(git(base, 'rev-parse', 'HEAD'), sha);
  assert.equal(git(base, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');

  write(path.join(base, 'app', 'proto-look.js'), 'page');
  write(path.join(repo, '.kickflip', 'build'), '#!/bin/sh\n');
  fs.chmodSync(path.join(repo, '.kickflip', 'build'), 0o755);
  commit(repo, 'app/routes.js', 'export default [1];\n');
  const moved = await board('prototype', 'base', '--site', 'orch');
  assert.equal(moved.code, 0, moved.err);
  const tip = git(repo, 'rev-parse', 'main');
  assert.match(moved.out, new RegExp(`^base ${base} at ${tip.slice(0, 7)}, moved to main\nbuild script .kickflip/build is there\n`));
  assert.equal(fs.readFileSync(path.join(base, 'app', 'proto-look.js'), 'utf8'), 'page');

  write(path.join(base, 'app', 'routes.js'), 'export default ["look"];\n');
  commit(repo, 'app/routes.js', 'export default [2];\n');
  const held = await board('prototype', 'base', '--site', 'orch');
  assert.equal(held.code, 0, held.err);
  assert.match(held.out, new RegExp(`^base ${base} at ${tip.slice(0, 7)}, kept: its pages' edits to app/routes.js block the move to main\n`));
  assert.equal(git(base, 'rev-parse', 'HEAD'), tip);
  assert.equal(fs.readFileSync(path.join(base, 'app', 'routes.js'), 'utf8'), 'export default ["look"];\n');
});

// The listener a served page loads: the take and state from its URL at first, then from each viewer message.
test("the frame listener reads ?variant= and ?state= first, then each of the viewer's messages, and ignores any other sender or shape", async () => {
  const listeners = [];
  const parent = {};
  const context = vm.createContext({ location: { search: '?variant=B&state=busy' }, parent, URLSearchParams, addEventListener: (type, fn) => listeners.push([type, fn]) });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(new URL('../shared/prototype-frame.js', import.meta.url), 'utf8'), context);
  const seen = [];
  context.KickflipPrototype.on((take, state) => seen.push([take, state]));
  const send = (data, source = parent) => listeners.filter(([t]) => t === 'message').forEach(([, fn]) => fn({ data, source }));
  send({ kickflip: 'prototype', take: 'A', state: 'empty' });
  send({ kickflip: 'prototype', take: 'C', state: null }, {});
  send({ take: 'C' });
  assert.deepEqual(seen, [['B', 'busy'], ['A', 'empty']]);
  assert.equal(context.KickflipPrototype.take, 'A');
  assert.equal(context.KickflipPrototype.state, 'empty');
});

test('the viewer bar lists the round’s states as a row of chips, the current one pressed, and the page opens on ?state= else the first', async () => {
  const context = vm.createContext({});
  for (const file of ['ui-icon-text.js', 'ui.js','ui-links.js', 'ui-questions.js', 'prototype-switcher.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
  const sw = context.PrototypeSwitcher;
  const html = sw.pillHtml({ name: 'Chips', states: { empty: 'No tasks', busy: 'Ten <running>' }, state: 'busy' });
  assert.match(html, /<div class="ps-row ps-states">.*data-ps-state="empty" aria-pressed="false">No tasks<\/button>.*data-ps-state="busy" aria-pressed="true">Ten &lt;running&gt;<\/button>/);
  assert.doesNotMatch(sw.pillHtml({ name: 'Chips' }), /ps-states/);
  assert.equal(sw.startTake(['empty', 'busy'], 'busy'), 'busy');
  assert.equal(sw.startTake(['empty', 'busy'], 'gone'), 'empty');
});

// The kit with the board's progress bar, as prototype.html loads them.
const kitContext = (extra = {}) => {
  const context = vm.createContext({ location: { hostname: 'mac.ts.net' }, setTimeout, clearTimeout, setInterval, clearInterval, EventTarget, URL, document: new EventTarget(), ...extra });
  context.window = context;
  vm.runInContext(fs.readFileSync(new URL('./public/ui-progress-bar.js', import.meta.url), 'utf8'), context);
  vm.runInContext(fs.readFileSync(new URL('./public/prototype-kit.js', import.meta.url), 'utf8'), context);
  return context;
};

test("the served viewer frames the page at the base worktree's port with the take and state", async () => {
  const kit = kitContext().PrototypeKit;
  assert.equal(kit.servedSrc({ https: 8512, path: '/proto/look?theme=dark', take: 'B', state: 'busy' }), 'https://mac.ts.net:8512/proto/look?theme=dark&variant=B&state=busy');
  assert.equal(kit.servedSrc({ https: 8512, path: '/proto/look', take: 'A', state: null }), 'https://mac.ts.net:8512/proto/look?variant=A');
  // The host's own page, served over http while the tailnet is off, frames the try port on this host.
  const local = kitContext({ location: { protocol: 'http:', hostname: 'localhost' } }).PrototypeKit;
  assert.equal(local.servedSrc({ https: 8512, path: '/proto/look', take: 'A', state: null }), 'http://127.0.0.1:8512/proto/look?variant=A');
});

// docs/adr/2026-11-14-1446-a-prototype-pages-landing-shows-its-sites-start-steps.md
test("the landing draws the site's three start steps with a caption under each: only the running one orange, a finished one grey with its time, and a failed one red above its error, log and Try again", async () => {
  const kit = kitContext().PrototypeKit;
  const now = Date.parse('2026-11-14T20:00:09.000Z');
  const captions = (html) => [...html.matchAll(/<span class="kit-step( \w+)?">([^<]*)<\/span>/g)].map((m) => `${(m[1] || '').trim() || 'grey'}: ${m[2]}`);
  const bars = (html) => [...html.matchAll(/<i class="(\w*)"/g)].map((m) => m[1] || 'empty');

  const asked = kit.servedStatus({}, now);
  assert.deepEqual(captions(asked), ['now: building · 0s', 'grey: starting server', 'grey: opening'], 'before the hub runs it, step 1 at 0s');
  assert.deepEqual(bars(asked), ['now', 'empty', 'empty']);
  assert.doesNotMatch(asked, /had stopped/);

  const starting = kit.servedStatus({ state: 'running', step: 'starting', stepAt: '2026-11-14T20:00:06.000Z', steps: [{ name: 'building', ms: 4300 }], last: 'listening <on> 4173' }, now);
  assert.deepEqual(captions(starting), ['grey: building · 4s', 'now: starting server · 3s', 'grey: opening'], 'a finished step keeps its time, grey');
  assert.deepEqual(bars(starting), ['done', 'now', 'empty']);
  assert.match(starting, /<p class="kit-landing-last">listening &lt;on&gt; 4173<\/p>/);

  const ahead = kit.servedStatus({ state: 'running', step: 'building', stepAt: '2026-11-14T20:00:20.000Z', steps: [] }, now);
  assert.deepEqual(captions(ahead), ['now: building · 0s', 'grey: starting server', 'grey: opening'], 'a host clock ahead counts from 0s');

  const restarting = kit.servedStatus({ state: 'running', step: 'building', stepAt: '2026-11-14T20:00:09.000Z', steps: [] }, now, true);
  assert.match(restarting, /^<div class="kit-landing"><p class="kit-landing-stopped">The prototype site had stopped\. Starting it again\.\.\.<\/p>/);

  const failed = kit.servedStatus({ state: 'failed', step: 'opening', stepAt: '2026-11-14T20:00:08.000Z', steps: [{ name: 'building', ms: 4000 }, { name: 'starting', ms: 2000 }],
    error: 'tailnet port <8443> refused', lines: ['npm ERR! <missing>', 'exit 1'] }, now, true);
  assert.deepEqual(captions(failed), ['grey: building · 4s', 'grey: starting server · 2s', 'failed: opening']);
  assert.deepEqual(bars(failed), ['done', 'done', 'failed']);
  assert.doesNotMatch(failed, /had stopped/, 'a failure replaces the stopped line');
  assert.match(failed, /<p class="kit-landing-why">The prototype site didn’t start while opening\.<\/p><p class="kit-landing-error">tailnet port &lt;8443&gt; refused<\/p><pre>npm ERR! &lt;missing&gt;\nexit 1<\/pre><button type="button" data-kit-served="retry">Try again<\/button>/);
  assert.deepEqual(captions(kit.servedStatus({ state: 'failed', error: 'No build script.', lines: [] }, now)), ['failed: building', 'grey: starting server', 'grey: opening'], 'a launch that failed before its first step fails building');
  const crashed = kit.servedStatus({ state: 'failed', step: 'ready', steps: [{ name: 'building', ms: 4000 }, { name: 'starting', ms: 2000 }, { name: 'opening', ms: 0 }], error: 'The build script exited with code 1.', lines: [] }, now);
  assert.deepEqual(captions(crashed), ['grey: building · 4s', 'grey: starting server · 2s', 'grey: opening · 0s'], 'a site that was up and then failed finished every step');
  assert.deepEqual(bars(crashed), ['done', 'done', 'done']);
  assert.match(crashed, /<p class="kit-landing-why">The prototype site stopped after it started\.<\/p>/);
});

// docs/adr/2026-11-07-1231-a-base-move-restarts-the-prototype-serve-and-a-demo-hub-never-restarts-itself.md, docs/adr/2026-11-15-1921-the-browsers-polls-ride-the-change-stream.md
test("the served viewer reads the serve on each of its board's change signals, never on a timer: Starting while the serve is down, and a new frame at the same take and state once a new run is ready", async () => {
  const timers = [];
  const tickers = [];
  const keeps = [];
  const answers = [];
  const posts = [];
  const reads = [];
  const streams = [];
  const stage = Object.assign(new EventTarget(), { innerHTML: '', frame: null, replaceChildren(el) { this.frame = el; this.innerHTML = ''; } });
  let switcher;
  // The hub's one stream, as hub/stream.mjs sends it: `change {route}` for each board.
  class EventSource extends EventTarget {
    static CLOSED = 2;
    constructor(url) { super(); this.url = url; this.readyState = 1; streams.push(this); }
    close() { this.readyState = EventSource.CLOSED; }
  }
  const context = vm.createContext({
    location: { hostname: 'mac.ts.net', href: 'https://mac.ts.net/orch/prototype-look.html' }, URL, EventTarget, Event, MessageEvent, EventSource, clearTimeout, clearInterval,
    setTimeout: (fn, ms) => (ms === 5 * 60_000 ? keeps : timers).push(fn),
    setInterval: (fn, ms) => { tickers.push({ fn, ms }); return tickers.length; },
    fetch: async (url, opts) => {
      if (opts?.method === 'POST') { posts.push(url); return {}; }
      reads.push(url);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { json: async () => next };
    },
    ClaudeSite: { url: (p) => `/orch/${p}` },
    PrototypeSwitcher: { mount(opts) { switcher = opts; opts.render(opts.initial, 'busy'); return {}; } },
    document: Object.assign(new EventTarget(), {
      documentElement: { dataset: {} },
      visibilityState: 'visible',
      getElementById: (id) => (id === 'stage' ? stage : null),
      createElement: () => Object.assign(new EventTarget(), { contentWindow: { postMessage() {} } }),
    }),
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(new URL('./public/ui-progress-bar.js', import.meta.url), 'utf8'), context);
  vm.runInContext(fs.readFileSync(new URL('./public/prototype-kit.js', import.meta.url), 'utf8'), context);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const change = (route) => streams.at(-1).dispatchEvent(new MessageEvent('change', { data: JSON.stringify({ route }) }));
  // Answers the read the next change signal brings with answer, and returns what the stage shows after it.
  const step = async (answer) => {
    answers.push(answer);
    change('orch');
    await settle();
    return stage.frame ? stage.frame.src : stage.innerHTML;
  };
  answers.push({ state: 'running' });
  context.PrototypeKit.start({ served: '/proto/look', title: 'Look', takes: [{ key: 'A', label: 'A' }, { key: 'B', label: 'B' }], states: [{ key: 'busy', label: 'Busy' }] });
  await settle();
  assert.deepEqual(streams.map((s) => s.url), ['/_hub/stream']);
  assert.match(stage.innerHTML, /<span class="kit-step now">building · 0s<\/span>/);
  assert.equal(posts.length, 1, 'the page asks on load');
  assert.deepEqual([timers.length, tickers.map((t) => t.ms)], [0, [1000]], 'no read waits on a timer; the starting step counts its seconds each second');
  const read = reads.length;
  streams[0].dispatchEvent(new Event('open'));
  await settle();
  assert.equal(reads.length, read, "the stream's first open reads nothing more than the load did");
  tickers[0].fn();
  assert.equal(reads.length, read, 'counting the seconds reads nothing');
  change('other');
  await settle();
  assert.equal(reads.length, read, "another board's change reads nothing");
  assert.equal(await step({ state: 'ready', https: 8500, since: 's1' }), 'https://mac.ts.net:8500/proto/look?variant=A&state=busy');
  assert.equal(posts.length, 1, 'a read that finds the site up asks nothing');
  context.document.visibilityState = 'hidden';
  keeps.shift()();
  assert.equal(posts.length, 1, 'a hidden page does not ask');
  context.document.visibilityState = 'visible';
  keeps.shift()();
  assert.equal(posts.length, 2, 'a visible page asks every 5 minutes');
  context.document.visibilityState = 'hidden';
  context.document.dispatchEvent(new context.Event('visibilitychange'));
  assert.equal(posts.length, 2);
  context.document.visibilityState = 'visible';
  context.document.dispatchEvent(new context.Event('visibilitychange'));
  assert.equal(posts.length, 3, 'a page that becomes visible asks');
  const first = stage.frame;
  switcher.render('B', 'busy');
  assert.equal(await step({ state: 'ready', https: 8500, since: 's1' }), first.src);
  assert.equal(stage.frame, first, 'the same run keeps its frame');
  assert.equal(await step(new Error('the board is out of reach')), first.src);
  assert.equal(stage.frame, first, 'a read that fails keeps the frame');
  stage.frame = null;
  assert.match(await step({ state: null }), /^<div class="kit-landing"><p class="kit-landing-stopped">The prototype site had stopped. Starting it again...<\/p>.*building · 0s/);
  assert.equal(posts.length, 4, 'a framed site found down is asked for at once');
  assert.match(await step({ state: null }), /had stopped/);
  assert.equal(posts.length, 4, 'once');
  assert.match(await step({ state: 'running', step: 'starting', stepAt: new Date().toISOString(), steps: [{ name: 'building', ms: 1000 }] }), /had stopped.*building · 1s.*kit-step now">starting server/, 'the stopped line stays above the steps while the site starts again');
  assert.equal(await step({ state: 'ready', https: 8500, since: 's2' }), 'https://mac.ts.net:8500/proto/look?variant=B&state=busy');
  const second = stage.frame;
  assert.notEqual(second, first);
  // A run that restarted between two signals still gets a new frame.
  await step({ state: 'ready', https: 8500, since: 's3' });
  assert.notEqual(stage.frame, second);
  stage.frame = null;
  assert.match(await step({ state: 'failed', lines: ['exit 1'] }), /didn’t start/);
  // A stream the hub dropped, such as while it restarts, opens again and reads the serve once it has.
  streams.at(-1).readyState = EventSource.CLOSED;
  streams.at(-1).dispatchEvent(new Event('error'));
  timers.shift()();
  assert.equal(streams.length, 2, 'a closed stream opens again');
  answers.push({ state: 'ready', https: 8500, since: 's4' });
  streams.at(-1).dispatchEvent(new Event('open'));
  await settle();
  assert.match(stage.frame.src, /:8500\/proto\/look/, 'a reopened stream reads the serve');
});
