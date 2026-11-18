import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, at, write, read, onHome, scratchRepo, git } from './board-fixture.mjs';
import { branchName, makeWorktree } from './worktree.mjs';

// The audit board's cards: A1 (ticket #7 when given) and ENG-1. Its title is "Audit Board" so a space shows.
function auditBoard(t, config = {}, ticket) {
  onHome(t);
  write(at('kickflip', 'manifest.json'), { sites: { audit: { dir: site('audit'), port: 2, cmd: ['node', '/x/board/server.mjs'] } } });
  write(site('audit', 'board.json'), { title: 'Audit Board', items: 'data/items.json', slug: 'audit', github_login: 'LoveK4d', ...config });
  const items = read(site('audit', 'data', 'items.json'));
  if (ticket) items.items[0].ticket = ticket;
  write(site('audit', 'data', 'items.json'), items);
}

test('a GitHub board names the branch <login>/<board>/<issue number>, lower case', (t) => {
  auditBoard(t, { tickets: { source: 'github' } }, '#7');
  assert.equal(branchName(site('audit'),'A1'), 'lovek4d/audit_board/7');
});

test('a Linear board names the branch by the lower-cased key', (t) => {
  auditBoard(t, { tickets: { source: 'linear', workspace: 'acme', team: 'ENG', project: 'P' } }, 'ENG-42');
  assert.equal(branchName(site('audit'),'A1'), 'lovek4d/audit_board/eng-42');
});

test('a board with no tickets names the branch by the lower-cased card id', (t) => {
  auditBoard(t);
  assert.equal(branchName(site('audit'),'ENG-1'), 'lovek4d/audit_board/eng-1');
});

test('a card with no ticket from the source falls back to its id', (t) => {
  auditBoard(t, { tickets: { source: 'github' } });
  assert.equal(branchName(site('audit'),'A1'), 'lovek4d/audit_board/a1');
});

test('with no github_login and no gh login the branch has no user part', (t) => {
  auditBoard(t, { github_login: undefined });
  const saved = process.env.PATH;
  process.env.PATH = '/nonexistent';
  t.after(() => { process.env.PATH = saved; });
  assert.equal(branchName(site('audit'),'A1'), 'audit_board/a1');
});

test('no board at the site keeps the card id as the branch', (t) => {
  auditBoard(t);
  assert.equal(branchName(undefined, 'A1'), 'A1');
});

test('a worktree refuses a branch whose prefix is a branch, and one that is a prefix of a branch, naming it', (t) => {
  const repo = scratchRepo();
  onHome(t);
  git(repo, 'branch', 'me/board');
  assert.throws(() => makeWorktree('A1', { repo, branch: 'me/board/a1' }), /branch me\/board already exists .* can't make me\/board\/a1/);
  git(repo, 'branch', '-D', 'me/board');
  git(repo, 'branch', 'me/board/a1');
  assert.throws(() => makeWorktree('A2', { repo, branch: 'me/board' }), /branch me\/board\/a1 already exists .* can't make me\/board/);
  git(repo, 'branch', '-D', 'me/board/a1');
  assert.equal(makeWorktree('A1', { repo, branch: 'me/board/a1' }).branch, 'me/board/a1');
});
