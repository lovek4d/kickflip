import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'incoming-'));
process.env.HOME = home;
const { incomingFor, checkIncoming } = await import('./incoming.mjs');
after(() => fs.rmSync(home, { recursive: true, force: true }));

const open = (number, over = {}) => ({ number, title: `PR ${number}`, author: 'quinn', url: `https://github.com/o/r/pull/${number}`, head: `h${number}`, draft: false, files: [], requested: [], ...over });

test('an incoming PR is one from someone else that touches a file a card changed, or asks the owner for review', () => {
  const cards = [{ key: 'w/A1', pr: 10, files: ['board/server.mjs', 'a.js'] }, { key: 'w/A2', pr: 11, files: ['b.js'] }];
  const prs = [
    open(10, { author: 'love', files: ['board/server.mjs'] }),
    open(20, { files: ['board/server.mjs', 'b.js'] }),
    open(21, { files: ['c.js'], requested: ['Love'] }),
    open(22, { files: ['c.js'] }),
    open(23, { files: ['a.js'], draft: true }),
    open(24, { author: 'LOVE', files: ['a.js'] }),
    open(11, { author: 'quinn', files: ['b.js'] }),
  ];
  assert.deepEqual(incomingFor({ open: prs, cards, me: 'love' }), [
    { number: 20, title: 'PR 20', author: 'quinn', url: 'https://github.com/o/r/pull/20', head: 'h20', touches: ['w/A1', 'w/A2'], asked: false },
    { number: 21, title: 'PR 21', author: 'quinn', url: 'https://github.com/o/r/pull/21', head: 'h21', touches: [], asked: true },
  ]);
});

test('the poll lists incoming PRs for each board with auto review on, reading a merged card PR\'s files once', async () => {
  const board = (route, cfg) => {
    const dir = path.join(home, route);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 'w', github_login: 'love', ...cfg }));
    fs.writeFileSync(path.join(dir, 'data', 'items.json'), JSON.stringify({ items: [
      { id: 'A1', title: 'Open', pr: 10, lane: 'progress' }, { id: 'A2', title: 'Merged', lane: 'done', prs: [{ number: 5, merged_at: '2026-11-01T00:00:00Z' }] }, { id: 'A3', title: 'Dropped', pr: 6, lane: 'done' },
    ] }));
    return [route, { cmd: ['node', 'board/server.mjs'], dir, port: 1, github: 'o/r' }];
  };
  const manifest = { sites: Object.fromEntries([board('on', { auto_review: true }), board('off', {})]) };
  const calls = [];
  const gh = {
    openPRs: async (repo) => { calls.push(['open', repo]); return [open(10, { author: 'love', files: ['x.js'] }), open(30, { files: ['y.js'] }), open(31, { files: ['z.js'] })]; },
    prFiles: async (repo, n) => { calls.push(['files', repo, n]); return { state: 'MERGED', files: ['y.js'] }; },
  };
  const first = await checkIncoming({ manifest, gh, login: async () => 'nobody' });
  assert.deepEqual(first, { checked: ['on'], failed: [] });
  const written = JSON.parse(fs.readFileSync(path.join(home, 'on', 'data', 'incoming.json'), 'utf8'));
  assert.ok(Date.parse(written.at));
  assert.deepEqual([written.repo, written.prs.map((p) => [p.number, p.touches])], ['o/r', [[30, ['w/A2']]]]);
  assert.equal(fs.existsSync(path.join(home, 'off', 'data', 'incoming.json')), false);
  await checkIncoming({ manifest, gh, login: async () => 'nobody' });
  assert.deepEqual(calls, [['open', 'o/r'], ['files', 'o/r', 5], ['open', 'o/r']], 'a merged PR\'s files are read once');

  const broken = await checkIncoming({ manifest, gh: { ...gh, openPRs: async () => { throw new Error('gh: rate limited'); } }, login: async () => 'nobody' });
  assert.deepEqual(broken, { checked: [], failed: ['on: gh: rate limited'] });
});
