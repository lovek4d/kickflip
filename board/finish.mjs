// docs/adr/2026-11-04-1611-finishing-a-build-is-one-step.md
// Finishing a board card's build, the one step behind `builder done` with no unverified calls, `builder verified` on a
// handed-back build, and `land`. On a board on GitHub whose PRs setting is on (store.mjs opensPRs), the hub board on
// Draft PR or Ready PR included, it pushes the card's branch, opens a draft PR and moves the card to it, or on a card
// whose PR is open force-pushes it there with a lease, leaving the PR as it is; on a plain git remote it pushes the
// branch for the owner's merge.
// Anywhere else, a local board (the hub board on Merge included) or a board on GitHub with PRs off, it verifies the worktree
// as a land does and, with Auto-merge off, stops there: the card waits in In Review for the owner's Merge
// (docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md). With Auto-merge on, or once the owner tapped Merge, it
// lands the worktree (worktree.mjs land), closes the card and its ticket, and pushes the branch to origin when the
// board's "Push main after a land" switch is on (permissions.mjs pushMain). Each refuses with the reason before it
// changes the card, so the builder stays on, fixes it and finishes again.
import fs from 'node:fs';
import path from 'node:path';
import { ghSync, limitWords } from '../shared/gh.mjs';
import * as store from './store.mjs';
import { affectedRun, builderRepo, git, joiningLand, landInTurn, passTests, syncBase, worktreesDir } from './worktree.mjs';
import { readPermissions } from './permissions.mjs';
import { pushRelease } from './release-tag.mjs';
import { landByBuilder } from './headless.mjs';
import { boardAt } from '../hub/boards.mjs';
import { boardRepo } from '../hub/board-repo.mjs';
import { subjectFault } from './commit-message.mjs';

const fail = (msg) => { throw new store.BoardError(msg); };
const said = (text) => (typeof text === 'string' && text.trim() ? text.trim() : fail('--text must be non-empty text'));

// text is the card's closing line ("<what was checked>"), the builder's message, unless closing ([kind, inputs]) names
// the board's status line instead; ownerStep land's and builder done's --owner-step, check its --check, repo --repo,
// merge whether the land is the one a held card's Merge tap started. → {said: what became of the card, lines}
export async function finishCard(site, key, { text, closing, ownerStep, check, repo: given, onWait, merge = false, title }) {
  store.messageText(text);
  const id = key.split('/')[1];
  const recorded = await store.recordedWorktree(site, key);
  const { repo, base, remote } = builderRepo(site, { repo: given ?? recorded?.repo });
  const tree = { path: recorded?.path ?? path.join(worktreesDir(), id), branch: recorded?.branch ?? id, repo: path.resolve(repo), base };
  const ref = await store.cardName(site, key);
  const settings = await store.readBoardSettings(site);
  const github = remote ? boardRepo(boardAt(site).route).github : null;
  if (remote && (!github || settings.prs)) return sendForReview(site, key, { ...tree, title, text: said(text) });
  // docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md: a finish asked for a card already landing joins
  // that land, then finishes what it left, if anything.
  const ran = await joiningLand(ref, () => landCard(site, key, { tree: { ...tree, title }, ref, base, remote, repo, settings, text, closing, ownerStep, check, onWait }), { merge });
  if (!ran.joined) return ran;
  if (await store.isFinished(site, key)) return { said: 'landed and done', lines: [] };
  return finishCard(site, key, { text, closing, ownerStep, check, repo: given, onWait, merge, title });
}

async function landCard(site, key, { tree, ref, base, remote, repo, settings, text, closing, ownerStep, check, onWait }) {
  const go = settings.auto_merge || Boolean((await store.heldMerge(site, key))?.tapped);
  // docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md
  const blocked = go && await store.blockWords(site, key);
  if (blocked) fail(`${ref} is blocked ${blocked}, so it can't land; it lands once nothing blocks it`);
  await store.checkClose(site, key, text, ownerStep, check);
  await store.checkCallsVerified(site, key);
  // The branch was made from origin's base, which it tracks, and land deletes it before main reaches origin.
  if (remote) {
    syncBase(tree.repo, base);
    git(tree.repo, 'branch', '--unset-upstream', tree.branch);
  }
  if (go) await store.landingLine(site, key);
  // docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md: only the fast-forward waits for the land lock,
  // and base is brought up to origin's again under it.
  // docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md: a bumped card's land goes ahead in the queue.
  const queue = { site, key, first: await store.landFirst(site, key) };
  const report = await store.testReport(site, key, { phase: 'landing' });
  const landed = await landInTurn({ ...tree, ref }, { hold: !go, onWait, queue, report, sync: () => remote && syncBase(tree.repo, base) });
  if (!go) {
    const set = await store.setItem(site, key, { mergeReady: tree.branch, ownerStep, check });
    await store.appendMessage(site, key, { text });
    return { said: 'verified; waits for your Merge', lines: set.lines };
  }
  const closed = await store.setItem(site, key, { done: true, landed: true, ...(closing ? { closing } : { text }), ownerStep, check });
  return {
    said: ownerStep === undefined ? 'landed and done' : `landed; waits on the owner step "${ownerStep.trim()}"`,
    lines: [...closed.lines, ...await pushBase(site, key, repo, base, landed.tag)],
  };
}

// docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md
// `board.mjs merge` on a card waiting for the owner's Merge, which the board server runs on the tap (store.mjs
// tapMerge records it first): the land, onto the base as it is now. A conflict or failing tests after the rebase go
// to a headless lander, which fixes them and finishes with the tap as its go; any other refusal is one thread line,
// and the card's Merge shows again. While another card is landing the tap waits its turn, saying so on the thread.
export async function landHeld(site, key, { launch = landByBuilder } = {}) {
  const held = await store.heldMerge(site, key);
  if (!held?.tapped) fail(`${key} isn't waiting on a Merge tap`);
  try {
    const { base } = builderRepo(site, { repo: (await store.recordedWorktree(site, key))?.repo });
    const onWait = (card) => store.appendStatus(site, key, 'land-waiting', { card });
    return await finishCard(site, key, { text: `Landed on ${base} on your Merge.`, closing: ['landed-on-merge', { base }], onWait, merge: true });
  } catch (e) {
    if (!(e instanceof store.BoardError)) throw e;
    const why = e.message.split('\n')[0];
    if (/^rebasing .+ conflicts in |^tests failed in /.test(why)) {
      await store.appendStatus(site, key, 'lander-handoff', { why });
      try { await launch(site, { key, model: await store.builderModel(site, key) }, { why }); } catch (err) {
        await store.appendStatus(site, key, 'lander-failed', { error: err.message });
      }
    } else await store.appendStatus(site, key, 'land-failed', { why });
    throw e;
  }
}

// The card has already landed, so a push that fails is said, on the card's thread too, and leaves the land standing.
// tag, the release tag the land made (release-tag.mjs), follows base to origin
// (docs/adr/2026-11-12-1251-land-tags-a-release-commit-and-pushes-the-tag.md).
async function pushBase(site, key, repo, base, tag) {
  const permissions = await readPermissions(repo);
  if (!permissions.pushMain) return [];
  const pushed = git(repo, 'push', '--quiet', 'origin', base);
  if (!pushed.ok) {
    const why = `${base} didn't reach origin: ${pushed.err}; push it with git -C ${repo} push origin ${[base, tag].filter(Boolean).join(' ')}`;
    await store.appendStatus(site, key, 'push-failed', { base, error: pushed.err });
    return [`landed, but ${why}`];
  }
  if (!tag) return [`pushed ${base} to origin`];
  const release = pushRelease(repo, tag, permissions.pushTags);
  if (release.failed) await store.appendStatus(site, key, 'push-failed', { base: tag, error: release.failed });
  return [`pushed ${base} to origin`, release.line];
}

async function sendForReview(site, key, { path: dir, branch, base, title: given, text }) {
  await store.checkCallsVerified(site, key);
  if (!fs.existsSync(dir)) fail(`no worktree at ${dir}`);
  if (git(dir, 'status', '--porcelain').out) fail(`${dir} has uncommitted changes; commit them there first`);
  if (Number(git(dir, 'rev-list', '--count', `refs/remotes/origin/${base}..HEAD`).out) === 0) fail(`${branch} has no commits beyond ${base}; nothing to send for review`);
  const { github } = boardRepo(boardAt(site).route);
  const open = github ? await store.cardPR(site, key) : null;
  // docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md: a new PR's title is a
  // Conventional subject, the builder's --title, else the card's title
  // (docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md).
  const opens = github && !open;
  const title = given ?? (opens ? await store.cardTitleOf(site, key) : undefined);
  const fault = opens && subjectFault(title);
  if (fault) fail(`${given === undefined ? "the task's title" : '--title'} "${title}" ${fault}; pass --title "<type>(<scope>): <summary>", at most 100 characters`);
  const report = await store.testReport(site, key, { phase: 'landing' });
  await passTests(dir, { runTests: affectedRun(`refs/remotes/origin/${base}`), outcome: 'nothing was pushed', report });
  // docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md: to a card's open PR, a rebased
  // branch goes with a lease on origin's branch as the worktree last fetched it, and the PR stays as it is.
  const from = open ? git(dir, 'rev-parse', `refs/remotes/origin/${branch}`).out : null;
  const pushed = open ? git(dir, 'push', '--quiet', `--force-with-lease=refs/heads/${branch}:${from}`, 'origin', `HEAD:refs/heads/${branch}`)
    : git(dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  if (!pushed.ok) fail(`could not push ${branch} to origin: ${pushed.err}`);
  if (open) {
    // Rebase-only: no more commits on base than the PR had, so the run replayed the PR's commits and added none of its own.
    const ahead = (tip) => Number(git(dir, 'rev-list', '--count', `refs/remotes/origin/${base}..${tip}`).out);
    await store.recordRebase(site, key, { from, to: git(dir, 'rev-parse', 'HEAD').out, replayed: ahead('HEAD') <= ahead(from) });
    const set = await store.setItem(site, key, { pr: open });
    await store.appendMessage(site, key, { text });
    return { said: `pushed ${branch} to PR #${open}`, lines: set.lines };
  }
  if (!github) {
    const set = await store.setItem(site, key, { pushed: branch });
    await store.appendMessage(site, key, { text });
    return { said: `pushed ${branch} for its merge`, lines: set.lines };
  }
  const created = ghSync(['pr', 'create', '--draft', '--repo', github, '--base', base, '--head', branch, '--title', title, '--body', text], { cwd: dir });
  // A PR an earlier finish opened for the branch is the one the card moves to.
  const out = `${created.stdout || ''}\n${created.stderr || ''}`;
  const number = (created.status === 0 || /already exists/.test(out)) && /\/pull\/(\d+)/.exec(out)?.[1];
  // docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md: GitHub's limit refusing it goes in the card's thread.
  if (created.limited) await store.appendStatus(site, key, 'gh-limited', { what: 'No PR opened', words: limitWords(created.limited) });
  if (!number) fail(`could not open a draft PR for ${branch}: ${(created.stderr || `gh exited ${created.status}`).trim().split('\n')[0]}`);
  const set = await store.setItem(site, key, { pr: Number(number) });
  await store.appendMessage(site, key, { text });
  return { said: `draft PR #${number} opened`, lines: set.lines };
}
