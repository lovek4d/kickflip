// docs/adr/2026-11-04-1611-finishing-a-build-is-one-step.md
// Finishing a board card's build, the one step behind `builder done` with no unverified calls, `builder verified` on a
// handed-back build, and `land`. On a board whose builders branch from a local repo (the hub board included) it lands
// the worktree (worktree.mjs land), closes the card and its ticket, and pushes the branch to origin when the board's
// "Push main after a land" switch is on (permissions.mjs pushMain). On a board on GitHub it pushes the card's branch,
// opens a draft PR and moves the card to it; on a plain git remote it pushes the branch for the owner's merge. Each
// refuses with the reason before it changes the card, so the builder stays on, fixes it and finishes again.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as store from './store.mjs';
import { builderRepo, git, holdingLandLock, land, passTests, worktreesDir } from './worktree.mjs';
import { readPermissions } from './permissions.mjs';
import { boardAt } from '../hub/boards.mjs';
import { boardRepo } from '../hub/board-repo.mjs';

const fail = (msg) => { throw new store.BoardError(msg); };
const said = (text) => (typeof text === 'string' && text.trim() ? text.trim() : fail('--text must be non-empty text'));

// text is the card's closing line ("<what was checked>"), ownerStep land's and builder done's --owner-step, repo
// --repo. → {said: what became of the card, lines}
export async function finishCard(site, key, { text, ownerStep, repo: given }) {
  const id = key.split('/')[1];
  const recorded = await store.recordedWorktree(site, key);
  const { repo, base, remote } = builderRepo(site, { repo: given ?? recorded?.repo });
  const tree = { path: recorded?.path ?? path.join(worktreesDir(), id), branch: recorded?.branch ?? id };
  const ref = await store.cardName(site, key);
  if (remote) return sendForReview(site, key, { ...tree, base, ref, text: said(text) });
  return holdingLandLock(ref, async () => {
    await store.checkClose(site, key, text, ownerStep);
    await store.checkCallsVerified(site, key);
    land({ ...tree, repo: path.resolve(repo), base, ref });
    const closed = await store.setItem(site, key, { status: 'done', text, ownerStep });
    return {
      said: ownerStep === undefined ? 'landed and done' : `landed; waits on the owner step "${ownerStep.trim()}"`,
      lines: [...closed.lines, ...await pushBase(site, key, repo, base)],
    };
  });
}

// The card has already landed, so a push that fails is said, on the card's thread too, and leaves the land standing.
async function pushBase(site, key, repo, base) {
  if (!(await readPermissions(repo)).pushMain) return [];
  const pushed = git(repo, 'push', '--quiet', 'origin', base);
  if (pushed.ok) return [`pushed ${base} to origin`];
  const why = `${base} didn't reach origin: ${pushed.err}; push it with git -C ${repo} push origin ${base}`;
  await store.appendThread(site, key, { text: `Landed, but ${why}` });
  return [`landed, but ${why}`];
}

async function sendForReview(site, key, { path: dir, branch, base, ref, text }) {
  await store.checkCallsVerified(site, key);
  if (!fs.existsSync(dir)) fail(`no worktree at ${dir}`);
  if (git(dir, 'status', '--porcelain').out) fail(`${dir} has uncommitted changes; commit them there first`);
  if (Number(git(dir, 'rev-list', '--count', `refs/remotes/origin/${base}..HEAD`).out) === 0) fail(`${branch} has no commits beyond ${base}; nothing to send for review`);
  passTests(dir, { outcome: 'nothing was pushed' });
  const pushed = git(dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  if (!pushed.ok) fail(`could not push ${branch} to origin: ${pushed.err}`);
  const { github } = boardRepo(boardAt(site).route);
  if (!github) {
    const set = await store.setItem(site, key, { pushed: branch });
    await store.appendThread(site, key, { text });
    return { said: `pushed ${branch} for its merge`, lines: set.lines };
  }
  const { title } = await store.briefFacts(site, key);
  const created = spawnSync('gh', ['pr', 'create', '--draft', '--repo', github, '--base', base, '--head', branch, '--title', `${ref}: ${title}`, '--body', text], { cwd: dir, encoding: 'utf8' });
  // A PR an earlier finish opened for the branch is the one the card moves to.
  const out = `${created.stdout || ''}\n${created.stderr || ''}`;
  const number = (created.status === 0 || /already exists/.test(out)) && /\/pull\/(\d+)/.exec(out)?.[1];
  if (!number) fail(`could not open a draft PR for ${branch}: ${(created.stderr || created.error?.message || `gh exited ${created.status}`).trim().split('\n')[0]}`);
  const set = await store.setItem(site, key, { pr: Number(number) });
  await store.appendThread(site, key, { text });
  return { said: `draft PR #${number} opened`, lines: set.lines };
}
