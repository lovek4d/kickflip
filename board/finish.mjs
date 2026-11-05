// docs/adr/2026-11-04-1611-finishing-a-build-is-one-step.md
// Finishing a board card's build, the one step behind `builder done` with no unverified calls, `builder verified` on a
// handed-back build, and `land`. On a board on GitHub whose PRs setting is on (store.mjs opensPRs) it pushes the card's
// branch, opens a draft PR and moves the card to it; on a plain git remote it pushes the branch for the owner's merge.
// Anywhere else, a local board (the hub board included) or a board on GitHub with PRs off, it verifies the worktree
// as a land does and, with Auto-merge off, stops there: the card waits in In Review for the owner's Merge
// (docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md). With Auto-merge on, or once the owner tapped Merge, it
// lands the worktree (worktree.mjs land), closes the card and its ticket, and pushes the branch to origin when the
// board's "Push main after a land" switch is on (permissions.mjs pushMain). Each refuses with the reason before it
// changes the card, so the builder stays on, fixes it and finishes again.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as store from './store.mjs';
import { builderRepo, git, joiningLand, landInTurn, passTests, syncBase, worktreesDir } from './worktree.mjs';
import { readPermissions } from './permissions.mjs';
import { launchBuilder } from './headless.mjs';
import { boardAt } from '../hub/boards.mjs';
import { boardRepo } from '../hub/board-repo.mjs';

const fail = (msg) => { throw new store.BoardError(msg); };
const said = (text) => (typeof text === 'string' && text.trim() ? text.trim() : fail('--text must be non-empty text'));

// text is the card's closing line ("<what was checked>"), ownerStep land's and builder done's --owner-step, check its
// --check, repo --repo. → {said: what became of the card, lines}
export async function finishCard(site, key, { text, ownerStep, check, repo: given, onWait }) {
  const id = key.split('/')[1];
  const recorded = await store.recordedWorktree(site, key);
  const { repo, base, remote } = builderRepo(site, { repo: given ?? recorded?.repo });
  const tree = { path: recorded?.path ?? path.join(worktreesDir(), id), branch: recorded?.branch ?? id, repo: path.resolve(repo), base };
  const ref = await store.cardName(site, key);
  const settings = await store.readBoardSettings(site);
  const github = remote ? boardRepo(boardAt(site).route).github : null;
  if (remote && (!github || settings.prs)) return sendForReview(site, key, { ...tree, ref, text: said(text) });
  // docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md: a finish asked for a card already landing joins
  // that land, then finishes what it left, if anything.
  const ran = await joiningLand(ref, () => landCard(site, key, { tree, ref, base, remote, repo, settings, text, ownerStep, check, onWait }));
  if (!ran.joined) return ran;
  if (await store.isFinished(site, key)) return { said: 'landed and done', lines: [] };
  return finishCard(site, key, { text, ownerStep, check, repo: given, onWait });
}

async function landCard(site, key, { tree, ref, base, remote, repo, settings, text, ownerStep, check, onWait }) {
  await store.checkClose(site, key, text, ownerStep, check);
  await store.checkCallsVerified(site, key);
  // The branch was made from origin's base, which it tracks, and land deletes it before main reaches origin.
  if (remote) {
    syncBase(tree.repo, base);
    git(tree.repo, 'branch', '--unset-upstream', tree.branch);
  }
  const go = settings.auto_merge || Boolean((await store.heldMerge(site, key))?.tapped);
  if (go) await store.landingLine(site, key);
  // docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md: only the fast-forward waits for the land lock,
  // and base is brought up to origin's again under it.
  await landInTurn({ ...tree, ref }, { hold: !go, onWait, sync: () => remote && syncBase(tree.repo, base) });
  if (!go) {
    const set = await store.setItem(site, key, { mergeReady: tree.branch, ownerStep, check });
    await store.appendThread(site, key, { text });
    return { said: 'verified; waits for your Merge', lines: set.lines };
  }
  const closed = await store.setItem(site, key, { status: 'done', text, ownerStep, check });
  return {
    said: ownerStep === undefined ? 'landed and done' : `landed; waits on the owner step "${ownerStep.trim()}"`,
    lines: [...closed.lines, ...await pushBase(site, key, repo, base)],
  };
}

// docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md
// `board.mjs merge` on a card waiting for the owner's Merge, which the board server runs on the tap (store.mjs
// tapMerge records it first): the land, onto the base as it is now. A conflict or failing tests after the rebase go
// to a headless lander, which fixes them and finishes with the tap as its go; any other refusal is one thread line,
// and the card's Merge shows again. While another card is landing the tap waits its turn, saying so on the thread.
export async function landHeld(site, key, { launch = launchBuilder } = {}) {
  const held = await store.heldMerge(site, key);
  if (!held?.tapped) fail(`${key} isn't waiting on a Merge tap`);
  try {
    const { base } = builderRepo(site, { repo: (await store.recordedWorktree(site, key))?.repo });
    const onWait = (card) => store.appendThread(site, key, { text: `Waiting for ${card} to land`, kind: 'status' });
    return await finishCard(site, key, { text: `Landed on ${base} on your Merge.`, onWait });
  } catch (e) {
    if (!(e instanceof store.BoardError)) throw e;
    const why = e.message.split('\n')[0];
    if (/^rebasing .+ conflicts in |^tests failed in /.test(why)) {
      await store.appendThread(site, key, { text: `Not merged yet: ${why}. A lander fixes it and lands it.` });
      try { await launch(site, { key, model: await store.builderModel(site, key) }, { lander: true }); } catch (err) {
        await store.appendThread(site, key, { text: `Couldn't launch the lander headless (${err.message}); land it with board.mjs land ${key}.` });
      }
    } else await store.appendThread(site, key, { text: `Not merged: ${why}. Tap Merge again.` });
    throw e;
  }
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
  await passTests(dir, { outcome: 'nothing was pushed' });
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
