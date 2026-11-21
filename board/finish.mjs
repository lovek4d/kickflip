// docs/adr/2026-11-04-1611-finishing-a-build-is-one-step.md
// Finishing a board card's build, the one step behind `builder done` with no unverified calls, `builder verified` on a
// handed-back build, and `land`. On a board on GitHub whose PRs setting is on (settings.mjs opensPRs), the hub board on
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
import { BoardError } from './checks.mjs';
import { readLog } from './files.mjs';
import { landRetry } from './hub-lines.mjs';
import { threadFile, messageText, cardName, shownCard, loadItem, heldMerge, appendStatus, appendWaitOver, setItem, appendMessage, builderModel, cardTitleOf, boardSource } from './cards.mjs';
import { checkClose } from './questions.mjs';
import { readBoardSettings } from './settings.mjs';
import { recordedWorktree, checkCallsVerified, landingLine, landFirst, testReport, recordCall, waitOnMainFix, cardPR, recordRebase, endFixRun } from './runs.mjs';
import { blockWordsOf } from './domain.mjs';
import { affectedRun, builderRepo, git, joiningLand, landInTurn, passTests, syncBase, worktreesDir } from './worktree.mjs';
import { readPermissions } from './permissions.mjs';
import { shipRelease } from './release.mjs';
import { landByBuilder } from './headless.mjs';
import { boardAt } from '../hub/boards.mjs';
import { boardRepo } from '../hub/board-repo.mjs';
import { commentTicket } from './tickets.mjs';
import { subjectFault } from './commit-message.mjs';

const fail = (msg) => { throw new BoardError(msg); };
const said = (text) => (typeof text === 'string' && text.trim() ? text.trim() : fail('--text must be non-empty text'));

// text is the card's closing line ("<what was checked>"), the builder's message, unless closing ([kind, inputs]) names
// the board's status line instead; ownerStep land's and builder done's --owner-step, check its --check, repo --repo,
// merge whether the land is the one a held card's Merge tap started. → {said: what became of the card, lines}
export async function finishCard(site, key, { text, closing, ownerStep, check, repo: given, onWait, onTurn, merge = false, title }) {
  messageText(text);
  const id = key.split('/')[1];
  const recorded = await recordedWorktree(site, key);
  const { repo, base, remote } = builderRepo(site, { repo: given ?? recorded?.repo, id });
  const tree = { path: recorded?.path ?? path.join(worktreesDir(), id), branch: recorded?.branch ?? id, repo: path.resolve(repo), base };
  const ref = await cardName(site, key);
  const settings = await readBoardSettings(site);
  const github = remote ? boardRepo(boardAt(site).route).github : null;
  if (remote && (!github || settings.prs)) return sendForReview(site, key, { ...tree, title, text: said(text) });
  // docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md: a finish asked for a card already landing joins
  // that land, then finishes what it left, if anything.
  // The joined land landed the card when it recorded a new landed commit (setItem --landed, with the card's release on a
  // release): a card its owner step or release holds in In Review isn't landed again, and a reopened card's build,
  // whose landed commit is still its earlier land's, lands.
  const landedBefore = (await loadItem(site, key)).item.landed_sha;
  const ran = await joiningLand(ref, () => landCard(site, key, { tree: { ...tree, title }, ref, base, remote, repo, settings, text, closing, ownerStep, check, onWait, onTurn }), { merge });
  if (!ran.joined) return ran;
  if ((await loadItem(site, key)).item.landed_sha !== landedBefore) return { said: 'landed by the land it joined', lines: [] };
  return finishCard(site, key, { text, closing, ownerStep, check, repo: given, onWait, onTurn, merge, title });
}

// The wait lines a land writes, one for each card it waits on; the wait line before one, or the last, is ended by
// over() (hub-lines.mjs WAIT_OVER): when its wait is over, whether the land got its turn or stopped. A test wait after
// the card's land failed its tests reads as the land's retry (hub-lines.mjs landRetry).
function waitLines(site, key, kind) {
  let open = null;
  const over = async () => {
    const of = open;
    open = null;
    if (of) await appendWaitOver(site, key, of);
  };
  const onWait = async (card) => {
    await over();
    const retry = kind === 'test-waiting' && landRetry(await readLog(threadFile(site, key)));
    open = (await appendStatus(site, key, kind, { card, retry }, { pid: process.pid, wait: { for: card, retry } })).line.ts;
  };
  return { onWait, over };
}

async function landCard(site, key, { tree, ref, base, remote, repo, settings, text, closing, ownerStep, check, onWait, onTurn }) {
  const go = settings.auto_merge || Boolean((await heldMerge(site, key))?.tapped);
  // docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md
  const blocked = go && blockWordsOf(await shownCard(site, key));
  if (blocked) fail(`${ref} is blocked ${blocked}, so it can't land; it lands once nothing blocks it`);
  await checkClose(site, key, text, ownerStep, check);
  await checkCallsVerified(site, key);
  // The branch was made from origin's base, which it tracks, and land deletes it before main reaches origin.
  if (remote) {
    syncBase(tree.repo, base);
    git(tree.repo, 'branch', '--unset-upstream', tree.branch);
  }
  if (go) await landingLine(site, key);
  // docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md: only the fast-forward waits for the land lock,
  // and base is brought up to origin's again under it.
  // docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md: a bumped card's land goes ahead in the queue.
  const queue = { site, key, first: await landFirst(site, key) };
  const report = await testReport(site, key, { phase: 'landing' });
  const testWaits = waitLines(site, key, 'test-waiting');
  // The files its diff changes, which the cards it unblocks compare with the files their notes name.
  const landedFiles = git(tree.repo, 'diff', '--name-only', '--no-renames', `${base}...${tree.branch}`).out.split('\n').filter(Boolean);
  let landed;
  try {
    landed = await landInTurn({ ...tree, ref, site }, { hold: !go, onWait, onTurn, onTestWait: testWaits.onWait, onTestTurn: testWaits.over, queue, report, found: (words) => recordCall(site, key, words, {}), sync: () => remote && syncBase(tree.repo, base) });
  } catch (e) {
    // docs/adr/2026-11-17-0519-a-land-failing-on-mains-own-test-blocks-on-mains-fix.md
    if (!e.failsOnBase) throw e;
    return waitOnMainFix(site, key, { files: e.failsOnBase, log: e.log, base });
  } finally {
    await testWaits.over();
  }
  if (!go) {
    const set = await setItem(site, key, { mergeReady: tree.branch, ownerStep, check });
    await appendMessage(site, key, { text });
    return { said: 'verified; waits for your Merge', lines: set.lines };
  }
  // docs/adr/2026-11-18-0200-a-release-card-waits-in-in-review-until-its-release-is-published.md: a release card keeps
  // its release, which holds it in In Review while the hub watches it publish, whether this land ships it or the
  // orchestrator does by hand.
  const release = landed.release ? { version: landed.release.version, pkg: landed.release.pkg } : undefined;
  const closed = await setItem(site, key, { done: true, landed: landed.commit, landedFiles, release, ...(closing ? { closing } : { text }), ownerStep, check });
  return {
    said: release ? `landed; waits until release ${release.version} is published`
      : ownerStep === undefined ? 'landed and done' : `landed; waits on the owner step "${ownerStep.trim()}"`,
    lines: [...closed.lines, ...await pushBase(site, key, repo, base, landed)],
  };
}

// docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md
// `board.mjs merge` on a card waiting for the owner's Merge, which the board server runs on the tap (cards.mjs
// tapMerge records it first): the land, onto the base as it is now. A conflict or failing tests after the rebase go
// to a headless lander, which fixes them and finishes with the tap as its go; any other refusal is one thread line,
// and the card's Merge shows again. While another card is landing the tap waits its turn, saying so on the thread.
export async function landHeld(site, key, { launch = landByBuilder } = {}) {
  const held = await heldMerge(site, key);
  if (!held?.tapped) fail(`${key} isn't waiting on a Merge tap`);
  try {
    const { base } = builderRepo(site, { repo: (await recordedWorktree(site, key))?.repo, id: key.split('/')[1] });
    const waits = waitLines(site, key, 'land-waiting');
    try {
      return await finishCard(site, key, { text: `Landed on ${base} on your Merge.`, closing: ['landed-on-merge', { base }], onWait: waits.onWait, onTurn: waits.over, merge: true });
    } finally {
      await waits.over();
    }
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    const why = e.message.split('\n')[0];
    if (/^rebasing .+ conflicts in |^tests failed in /.test(why)) {
      await appendStatus(site, key, 'lander-handoff', { why });
      try { await launch(site, { key, model: await builderModel(site, key) }, { why }); } catch (err) {
        await appendStatus(site, key, 'lander-failed', { error: err.message });
      }
    } else await appendStatus(site, key, 'land-failed', { why });
    throw e;
  }
}

// The card has already landed, so a push that fails is said, on the card's thread too, and leaves the land standing.
// release, the land's (release.mjs landRelease), ships once base reached origin
// (docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md).
async function pushBase(site, key, repo, base, { release, commit }) {
  const permissions = await readPermissions(repo, site);
  if (!permissions.pushMain) return [];
  const pushed = git(repo, 'push', '--quiet', 'origin', base);
  if (!pushed.ok) {
    const why = `${base} didn't reach origin: ${pushed.err}; push it with git -C ${repo} push origin ${base}`;
    await appendStatus(site, key, 'push-failed', { base, error: pushed.err });
    return [`landed, but ${why}`];
  }
  const lines = [`pushed ${base} to origin`];
  // The landed commit is announced on the card's ticket once, when its push put it on origin.
  const github = boardRepo(boardAt(site).route).github;
  if (github) {
    const subject = git(repo, 'log', '-1', '--format=%s', commit).out;
    const posted = await commentTicket(await boardSource(site), (await loadItem(site, key)).item, { lead: `Landed on ${base}`, title: subject, url: `https://github.com/${github}/commit/${commit}` }, { repo: github });
    if (posted) lines.push((await appendStatus(site, key, posted.kind, posted.inputs)).line.text);
  }
  if (!release) return lines;
  const shipped = shipRelease(repo, release, permissions, site);
  if (shipped.failed) await appendStatus(site, key, 'push-failed', { base: `release ${release.version}`, error: shipped.failed });
  return [...lines, shipped.line];
}

async function sendForReview(site, key, { path: dir, branch, base, title: given, text }) {
  await checkCallsVerified(site, key);
  if (!fs.existsSync(dir)) fail(`no worktree at ${dir}`);
  if (git(dir, 'status', '--porcelain').out) fail(`${dir} has uncommitted changes; commit them there first`);
  if (Number(git(dir, 'rev-list', '--count', `refs/remotes/origin/${base}..HEAD`).out) === 0) fail(`${branch} has no commits beyond ${base}; nothing to send for review`);
  const { github } = boardRepo(boardAt(site).route);
  // docs/adr/2026-11-21-2333-a-task-can-keep-its-own-pr-base.md: with none recorded, the PR GitHub has open from the
  // branch, whatever its base, is the card's: one opened against the board's branch and retargeted with gh pr edit
  // --base gets no second PR beside it.
  const recorded = github ? await cardPR(site, key) : null;
  const found = github && !recorded ? openPROf(github, branch, dir) : null;
  const open = recorded ?? found;
  // docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md: a new PR's title is a
  // Conventional subject, the builder's --title, else the card's title
  // (docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md).
  const opens = github && !open;
  const title = given ?? (opens ? await cardTitleOf(site, key) : undefined);
  const fault = opens && subjectFault(title);
  if (fault) fail(`${given === undefined ? "the task's title" : '--title'} "${title}" ${fault}; pass --title "<type>(<scope>): <summary>", at most 100 characters`);
  const report = await testReport(site, key, { phase: 'landing' });
  await passTests(dir, { runTests: affectedRun(`refs/remotes/origin/${base}`), outcome: 'nothing was pushed', report });
  // docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md: to a card's open PR, a rebased
  // branch goes with a lease on origin's branch as the worktree last fetched it, and the PR stays as it is; a PR found
  // open on GitHub has its branch fetched first.
  if (found) git(dir, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  const from = open ? git(dir, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`).out : null;
  const pushed = open ? git(dir, 'push', '--quiet', `--force-with-lease=refs/heads/${branch}:${from}`, 'origin', `HEAD:refs/heads/${branch}`)
    : git(dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  if (!pushed.ok) fail(`could not push ${branch} to origin: ${pushed.err}`);
  if (open) {
    // Rebase-only: no more commits on base than the PR had, so the run replayed the PR's commits and added none of its own.
    const ahead = (tip) => Number(git(dir, 'rev-list', '--count', `refs/remotes/origin/${base}..${tip}`).out);
    await recordRebase(site, key, { from, to: git(dir, 'rev-parse', 'HEAD').out, replayed: ahead('HEAD') <= ahead(from) });
    await endFixRun(site, key);
    const set = await setItem(site, key, { pr: open });
    await appendMessage(site, key, { text });
    return { said: `pushed ${branch} to PR #${open}`, lines: set.lines };
  }
  if (!github) {
    const set = await setItem(site, key, { pushed: branch });
    await appendMessage(site, key, { text });
    return { said: `pushed ${branch} for its merge`, lines: set.lines };
  }
  const created = ghSync(['pr', 'create', '--draft', '--repo', github, '--base', base, '--head', branch, '--title', title, '--body', text], { cwd: dir });
  // A PR an earlier finish opened for the branch is the one the card moves to.
  const out = `${created.stdout || ''}\n${created.stderr || ''}`;
  const number = (created.status === 0 || /already exists/.test(out)) && /\/pull\/(\d+)/.exec(out)?.[1];
  // docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md: GitHub's limit refusing it goes in the card's thread.
  if (created.limited) await appendStatus(site, key, 'gh-limited', { what: 'No PR opened', words: limitWords(created.limited) });
  if (!number) fail(`could not open a draft PR for ${branch}: ${(created.stderr || `gh exited ${created.status}`).trim().split('\n')[0]}`);
  const set = await setItem(site, key, { pr: Number(number) });
  await appendMessage(site, key, { text });
  // The PR is announced on the card's ticket once, when this finish opened it, not when it found one already open.
  if (created.status === 0) {
    const { item } = await loadItem(site, key);
    const posted = await commentTicket(await boardSource(site), item, { lead: 'PR opened', title, url: `https://github.com/${github}/pull/${number}` }, { repo: github });
    if (posted) set.lines.push((await appendStatus(site, key, posted.kind, posted.inputs)).line.text);
  }
  return { said: `draft PR #${number} opened`, lines: set.lines };
}

// The number of the PR open in github from branch, whatever its base, or null when there is none or gh can't say.
function openPROf(github, branch, dir) {
  const listed = ghSync(['pr', 'list', '--repo', github, '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[0].number'], { cwd: dir });
  return (listed.status === 0 && Number(listed.stdout.trim())) || null;
}
