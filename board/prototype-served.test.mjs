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
const ask = (url = 'prototype-look.html?q=q1') => {
  write(path.join(home, 'q.json'), question('q1', { url, options: [{ id: 'A', label: 'Chips', recommended: true }, { id: 'B', label: 'Stepper' }] }));
  return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json'));
};

test('prototype add --served records the page path and named states, with no take files to write', () => {
  const r = served('look', ['--state', 'empty:No cards', '--state', 'busy:Ten cards running']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, ['prototype look recorded', 'page prototype-look.html', 'served /proto/look from the base prototype worktree (board.mjs prototype base)', 'states empty, busy', ''].join('\n'));
  const [record] = read(site('orch', 'data', 'prototypes.json')).prototypes;
  assert.deepEqual({ ...record, at: undefined }, { topic: 'look', title: 'Look', served: '/proto/look', takes: [{ key: 'A', label: 'Chips' }, { key: 'B', label: 'Stepper' }],
    states: [{ key: 'empty', label: 'No cards' }, { key: 'busy', label: 'Ten cards running' }], at: undefined });
  assert.equal(board('prototype', 'list', '--site', 'orch').out, 'look · Look · A: Chips, B: Stepper · served /proto/look · states empty, busy\n');
});

test('prototype add refuses states without --served, a served path that is not a site path, and a bad or repeated state', () => {
  const refusals = [
    [['t', '--take', 'A:Keep', '--state', 'empty:None'], '--state goes with --served: only a served round re-renders its states in place'],
    [['t', '--take', 'A:Keep', '--served', 'proto/x'], '--served takes the page\'s path on the served site, starting with "/", not "proto/x"'],
    [['t', '--take', 'A:Keep', '--served', 'https://x/proto'], '--served takes the page\'s path on the served site, starting with "/", not "https://x/proto"'],
    [['t', '--take', 'A:Keep', '--served', '/x', '--state', 'Empty:None'], '--state takes KEY:"Label" with KEY in a-z, 0-9 and "-", not "Empty:None"'],
    [['t', '--take', 'A:Keep', '--served', '/x', '--state', 'e:One', '--state', 'e:Two'], '--state e is given twice'],
  ];
  for (const [args, line] of refusals) assert.deepEqual(board('prototype', 'add', ...args, '--site', 'orch', '--title', 'T'), { code: 1, out: '', err: line + '\n' }, line);
  assert.equal(fs.existsSync(site('orch', 'data', 'prototypes.json')), false);
});

test("a served round's question needs no take files, and still names takes its options must come from", () => {
  assert.equal(served().code, 0);
  const r = ask();
  assert.equal(r.code, 0, r.err);
  assert.equal(read(site('orch', 'data', 'owner.json')).items[0].url, 'prototype-look.html?q=q1');
});

test('the hub keeps the base worktree served while an open question links a served round, and no longer once it resolves', async () => {
  const { servedRoundsOpen } = await import('./store.mjs');
  assert.deepEqual(await servedRoundsOpen(site('orch')), []);
  assert.equal(served().code, 0);
  assert.equal(board('prototype', 'add', 'files', '--site', 'orch', '--title', 'Files', '--take', 'A:Keep').code, 0);
  assert.deepEqual(await servedRoundsOpen(site('orch')), []);
  assert.equal(ask().code, 0);
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

  const first = board('prototype', 'base', '--site', 'orch');
  assert.equal(first.code, 0, first.err);
  const sha = git(repo, 'rev-parse', 'main');
  assert.equal(first.out, [`base ${base} at ${sha.slice(0, 7)}, made from main`, 'build script .kickflip/build is missing: write one that serves the app and prints "port <n>"', `listener ${frame}`, ''].join('\n'));
  assert.equal(git(base, 'rev-parse', 'HEAD'), sha);
  assert.equal(git(base, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');

  write(path.join(base, 'app', 'proto-look.js'), 'page');
  write(path.join(repo, '.kickflip', 'build'), '#!/bin/sh\n');
  fs.chmodSync(path.join(repo, '.kickflip', 'build'), 0o755);
  commit(repo, 'app/routes.js', 'export default [1];\n');
  const moved = board('prototype', 'base', '--site', 'orch');
  assert.equal(moved.code, 0, moved.err);
  const tip = git(repo, 'rev-parse', 'main');
  assert.match(moved.out, new RegExp(`^base ${base} at ${tip.slice(0, 7)}, moved to main\nbuild script .kickflip/build is there\n`));
  assert.equal(fs.readFileSync(path.join(base, 'app', 'proto-look.js'), 'utf8'), 'page');

  write(path.join(base, 'app', 'routes.js'), 'export default ["look"];\n');
  commit(repo, 'app/routes.js', 'export default [2];\n');
  const held = board('prototype', 'base', '--site', 'orch');
  assert.equal(held.code, 0, held.err);
  assert.match(held.out, new RegExp(`^base ${base} at ${tip.slice(0, 7)}, kept: its pages' edits to app/routes.js block the move to main\n`));
  assert.equal(git(base, 'rev-parse', 'HEAD'), tip);
  assert.equal(fs.readFileSync(path.join(base, 'app', 'routes.js'), 'utf8'), 'export default ["look"];\n');
});

// The listener a served page loads: the take and state from its URL at first, then from each viewer message.
test("the frame listener reads ?variant= and ?state= first, then each of the viewer's messages, and ignores any other sender or shape", () => {
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

test('the viewer bar lists the round’s states as a row of chips, the current one pressed, and the page opens on ?state= else the first', () => {
  const context = vm.createContext({});
  for (const file of ['ui.js', 'ui-links.js', 'ui-questions.js', 'prototype-switcher.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
  const sw = context.PrototypeSwitcher;
  const html = sw.pillHtml({ name: 'Chips', states: { empty: 'No cards', busy: 'Ten <running>' }, state: 'busy' });
  assert.match(html, /<div class="ps-row ps-states">.*data-ps-state="empty" aria-pressed="false">No cards<\/button>.*data-ps-state="busy" aria-pressed="true">Ten &lt;running&gt;<\/button>/);
  assert.doesNotMatch(sw.pillHtml({ name: 'Chips' }), /ps-states/);
  assert.equal(sw.startTake(['empty', 'busy'], 'busy'), 'busy');
  assert.equal(sw.startTake(['empty', 'busy'], 'gone'), 'empty');
});

test("the served viewer frames the page at the base worktree's port with the take and state, and shows Starting or the failure with Try again", () => {
  const context = vm.createContext({ location: { hostname: 'mac.ts.net' }, setTimeout, clearTimeout, setInterval, clearInterval, EventTarget, URL, document: new EventTarget() });
  context.window = context;
  vm.runInContext(fs.readFileSync(new URL('./public/prototype-kit.js', import.meta.url), 'utf8'), context);
  const kit = context.PrototypeKit;
  assert.equal(kit.servedSrc({ https: 8512, path: '/proto/look?theme=dark', take: 'B', state: 'busy' }), 'https://mac.ts.net:8512/proto/look?theme=dark&variant=B&state=busy');
  assert.equal(kit.servedSrc({ https: 8512, path: '/proto/look', take: 'A', state: null }), 'https://mac.ts.net:8512/proto/look?variant=A');
  assert.match(kit.servedStatus({ state: 'running' }), /Starting the prototype site/);
  assert.match(kit.servedStatus({}), /Starting the prototype site/);
  const failed = kit.servedStatus({ state: 'failed', lines: ['npm ERR! <missing>', 'exit 1'] });
  assert.match(failed, /The prototype site didn’t start/);
  assert.match(failed, /npm ERR! &lt;missing&gt;\nexit 1/);
  assert.match(failed, /<button type="button" data-kit-served="retry">Try again<\/button>/);
});

// docs/adr/2026-11-07-1231-a-base-move-restarts-the-prototype-serve-and-a-demo-hub-never-restarts-itself.md
test('the served viewer keeps polling while the frame shows: Starting while the serve is down, and a new frame at the same take and state once a new run is ready', async () => {
  const timers = [];
  const answers = [];
  const posts = [];
  const stage = Object.assign(new EventTarget(), { innerHTML: '', frame: null, replaceChildren(el) { this.frame = el; this.innerHTML = ''; } });
  let switcher;
  const context = vm.createContext({
    location: { hostname: 'mac.ts.net', href: 'https://mac.ts.net/orch/prototype-look.html' }, URL, EventTarget, clearTimeout, setInterval, clearInterval,
    setTimeout: (fn) => timers.push(fn),
    fetch: async (url, opts) => {
      if (opts?.method === 'POST') { posts.push(url); return {}; }
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { json: async () => next };
    },
    ClaudeSite: { url: (p) => `/orch/${p}` },
    PrototypeSwitcher: { mount(opts) { switcher = opts; opts.render(opts.initial, 'busy'); return {}; } },
    document: Object.assign(new EventTarget(), {
      documentElement: { dataset: {} },
      getElementById: (id) => (id === 'stage' ? stage : null),
      createElement: () => Object.assign(new EventTarget(), { contentWindow: { postMessage() {} } }),
    }),
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(new URL('./public/prototype-kit.js', import.meta.url), 'utf8'), context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // Answers the next poll with answer, and returns what the stage shows after it.
  const step = async (answer) => {
    answers.push(answer);
    timers.shift()();
    await settle();
    return stage.frame ? stage.frame.src : stage.innerHTML;
  };
  answers.push({ state: 'running' });
  context.PrototypeKit.start({ served: '/proto/look', title: 'Look', takes: [{ key: 'A', label: 'A' }, { key: 'B', label: 'B' }], states: [{ key: 'busy', label: 'Busy' }] });
  await settle();
  assert.match(stage.innerHTML, /Starting the prototype site/);
  assert.equal(await step({ state: 'ready', https: 8500, since: 's1' }), 'https://mac.ts.net:8500/proto/look?variant=A&state=busy');
  const first = stage.frame;
  switcher.render('B', 'busy');
  assert.equal(await step({ state: 'ready', https: 8500, since: 's1' }), first.src);
  assert.equal(stage.frame, first, 'the same run keeps its frame');
  assert.equal(await step(new Error('the board is out of reach')), first.src);
  assert.equal(stage.frame, first, 'a poll that fails keeps the frame');
  stage.frame = null;
  assert.match(await step({ state: null }), /Starting the prototype site/);
  assert.match(await step({ state: 'running' }), /Starting the prototype site/);
  assert.equal(await step({ state: 'ready', https: 8500, since: 's2' }), 'https://mac.ts.net:8500/proto/look?variant=B&state=busy');
  const second = stage.frame;
  assert.notEqual(second, first);
  // A run that restarted between two polls still gets a new frame.
  await step({ state: 'ready', https: 8500, since: 's3' });
  assert.notEqual(stage.frame, second);
  assert.equal(timers.length, 1, 'it keeps polling');
  stage.frame = null;
  assert.match(await step({ state: 'failed', lines: ['exit 1'] }), /didn’t start/);
  assert.equal(timers.length, 0, 'a failed serve waits for Try again');
});
