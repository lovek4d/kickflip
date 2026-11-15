// The skill's entry points as CLI commands: kickflip board, page and handoff, each over join or the router's queue.
import { home, web, write } from '../hub/hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./kickflip.mjs', import.meta.url));
// No hub listens on port 1, so join reports it not running and runs no poll.
const cli = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: home, env: { ...process.env, KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8' });
  return { ...r, json: () => JSON.parse(r.stdout) };
};
const ok = (r) => { assert.equal(r.status, 0, r.stderr); return r.json(); };
const manifest = () => JSON.parse(fs.readFileSync(path.join(web, 'manifest.json'), 'utf8'));
const lines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const boardJson = (route) => JSON.parse(fs.readFileSync(path.join(web, 'sites', route, 'board.json'), 'utf8'));

test('kickflip board joins a board as the session with its watcher, on its own cards when new, keeping a rejoined board\'s items', () => {
  const r = ok(cli('board', 'Shop front', '--session', 's-shop', '--label', 'shop'));
  const site = manifest().sites['shop-front'];
  assert.deepEqual([r.route, site.title, site.owner.session, site.owner.label, site.watch], ['shop-front', 'Shop front', 's-shop', 'shop', ['data/events.jsonl']]);
  assert.match(site.cmd[1], /board[/\\]server\.mjs$/);
  assert.match(r.watcher, /wait-events\.mjs shop-front/);
  assert.deepEqual([boardJson('shop-front').title, boardJson('shop-front').items], ['Shop front', 'data/items.json']);
  const cfg = path.join(web, 'sites', 'shop-front', 'board.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...boardJson('shop-front'), items: 'waves' }));
  ok(cli('board', 'shop-front', '--session', 's-shop'));
  assert.deepEqual([boardJson('shop-front').title, boardJson('shop-front').items], ['Shop front', 'waves']);
});

test('kickflip board needs the session and a name, and refuses a route a page holds', () => {
  assert.equal(cli('board', 'Lonely').status, 2);
  assert.equal(cli('board', '--session', 's-x').status, 2);
  ok(cli('page', 'notes-dir', '--dir', home));
  const r = cli('board', 'notes-dir', '--session', 's-x');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\/notes-dir is a page/);
});

test('kickflip page joins a plain page with --port or --dir, or a watched page with --session, and never a board', () => {
  const plain = ok(cli('page', 'learn', '--dir', home));
  assert.equal(plain.route, 'learn');
  assert.deepEqual([manifest().sites.learn.dir, manifest().sites.learn.owner], [home, undefined]);
  const watched = ok(cli('page', 'Scratch pad', '--session', 's-pad'));
  const site = manifest().sites['scratch-pad'];
  assert.deepEqual([watched.createdFromStarter, site.owner.session, site.watch], [true, 's-pad', ['data/events.jsonl']]);
  for (const args of [['page', 'nothing'], ['page', 'learn', '--dir', home, '--template', 'board'], ['page', '--dir', home]]) {
    assert.equal(cli(...args).status, 2, args.join(' '));
  }
  assert.match(cli('page', 'shop-front', '--session', 's-shop').stderr, /\/shop-front is a board/);
});

test('kickflip handoff files the objective as a New ask on the named board, with a routed line naming the session', () => {
  write(path.join(web, 'sites', 'desk', 'board.json'), { title: 'Desk', items: 'data/items.json' });
  const m = manifest();
  m.sites.desk = { dir: path.join(web, 'sites', 'desk'), cmd: ['node', path.join(path.dirname(CLI), '..', 'board', 'server.mjs')], title: 'Desk' };
  write(path.join(web, 'manifest.json'), m);
  const r = cli('handoff', 'desk', '--text', 'Make checkout retry once', '--label', 'checkout fix');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(web, 'route-queue.json')), 'a named board skips the router');
  const [ask] = lines(path.join(web, 'sites', 'desk', 'data', 'events.jsonl')).filter((e) => e.kind === 'ask');
  assert.equal(r.stdout.trim(), `handed to /desk/#selectedCard=${encodeURIComponent(`ask:${ask.id}`)}`);
  assert.deepEqual({ ...ask.data, routed: { ...ask.data.routed, at: 'x' } },
    { text: 'Make checkout retry once', routed: { reason: 'checkout fix named this board', via: 'handoff', by: 'checkout fix', at: 'x' } });
  const file = path.join(home, 'objective.md');
  fs.writeFileSync(file, 'From a file\n');
  const fromFile = cli('handoff', 'desk', '--file', file);
  assert.equal(fromFile.status, 0, fromFile.stderr);
  const last = lines(path.join(web, 'sites', 'desk', 'data', 'events.jsonl')).at(-1);
  assert.deepEqual([last.data.text, last.data.routed.by], ['From a file', 'a session']);
});

test('kickflip handoff with no board queues the objective for the hub\'s router', () => {
  const r = cli('handoff', '--text', 'Where does this go?', '--label', 'stray idea');
  assert.equal(r.status, 0, r.stderr);
  const [req] = JSON.parse(fs.readFileSync(path.join(web, 'route-queue.json'), 'utf8')).queue;
  assert.deepEqual([req.text, req.from, req.tries], ['Where does this go?', { via: 'handoff', by: 'stray idea' }, 0]);
  assert.match(r.stdout, /queued for the hub's router/);
});

test('kickflip handoff needs the objective and a board the manifest has', () => {
  assert.equal(cli('handoff', 'desk').status, 2);
  const r = cli('handoff', 'nowhere', '--text', 'x');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no board at \/nowhere; the boards are .*desk/);
});
