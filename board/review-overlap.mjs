// docs/adr/2026-11-25-0000-an-incoming-review-leads-with-the-boards-overlap.md
// `review overlap <pr>`: what a board's review of a teammate's PR reads before it writes a word, for an auto review's
// pr-review and a review asked in Slack alike. The PR's files against the board's work: each open task's worktree diff
// (so a Merge-mode board, and a task with no PR yet, count) and each task landed on main since the PR branched; the
// lines of those tasks' notes that name a shared file; every review and comment already on the PR; and whether a
// line-level review is due, which it is only when no bot (the repo's automated reviewer) has reviewed it.
import fs from 'node:fs';
import path from 'node:path';
import { LANES, worktreeOf } from './domain.mjs';
import { boardTasks, readAgents } from './cards.mjs';
import { itemSources, readJSON, boardConfig } from './files.mjs';
import { itemNotes } from './questions.mjs';
import { externalRef } from './cites.mjs';
import { git, builderRepo } from './worktree.mjs';
import { fail, needSite } from './checks.mjs';
import { settingsOf, boardRepoOf } from './settings.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { parsePRRef } from '../shared/card-prs.mjs';
import { prForReview } from '../hub/pr-report.mjs';

const NOTE_LINE_CAP = 240;

// The tickets and card keys a landed commit names: its subject's " (<ticket>)" suffix, then each ref in its Refs
// trailers (older commits name their card there).
export function commitNames({ subject, body = '' }) {
  const suffix = / \(([^()\s]+)\)$/.exec(subject)?.[1];
  const refs = [...String(body).matchAll(/^Refs:[ \t]*(.+)$/gim)].flatMap((m) => m[1].split(/[,\s]+/)).filter(Boolean);
  return [...new Set([suffix, ...refs].filter(Boolean))];
}

// The board's work a PR touches. files: the PR's; live: open tasks [{key, title, lane, files}]; landed: tasks landed
// since the PR branched [{key, title, files, commits: [sha]}]; notes: {key: notes text}. → {live, landed, decisions},
// each task with shared, the files it shares with the PR, and decisions the lines of those tasks' notes naming a shared
// file by its path or its name: [{key, line}].
export function overlapOf({ files, live, landed, notes = {} }) {
  const pr = new Set(files);
  const touching = (tasks) => tasks.map((t) => ({ ...t, shared: [...new Set(t.files)].filter((f) => pr.has(f)).sort() })).filter((t) => t.shared.length);
  const hit = { live: touching(live), landed: touching(landed) };
  const decisions = [...hit.live, ...hit.landed].flatMap((t) => {
    const names = [...new Set(t.shared.flatMap((f) => [f, path.basename(f)]))];
    const named = (line) => names.some((n) => new RegExp(`(?<![\\w.-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(line));
    return String(notes[t.key] ?? '').split('\n').map((l) => l.trim()).filter((l) => l && named(l))
      .map((l) => ({ key: t.key, line: l.length > NOTE_LINE_CAP ? `${l.slice(0, NOTE_LINE_CAP)}…` : l }));
  });
  return { ...hit, decisions };
}

// Whether the review adds a line-level pass. said: the PR's reviews and comments [{kind, login, bot}]; pending: its CI
// checks still running. A bot's review or inline review comment means the repo has an automated reviewer, so none is
// due; a bot's plain comment (a deploy or coverage bot's) doesn't. With none yet, CI still running may bring one, so it
// waits. → {due: true} | {due: false, bots: [login]} | {wait: pending}
export function lineLevelOf({ said, pending }) {
  const bots = [...new Set(said.filter((s) => s.bot && s.kind !== 'comment').map((s) => s.login))];
  if (bots.length) return { due: false, bots };
  if (pending) return { wait: pending };
  return { due: true };
}

const indent = (text) => String(text).trim().split('\n').map((l) => `    ${l}`).join('\n');

// The command's lines. pr: prForReview's answer with number and repo; overlap: overlapOf's; cite: key → the task's
// external form or null; readAt: when the PR was read, for review post's --read-at.
export function overlapLines({ pr, overlap, cite, readAt }) {
  const named = (t) => `${t.key}${cite(t.key) ? ` (${cite(t.key)})` : ''} "${t.title}"`;
  const lines = [`PR #${pr.number} "${pr.title}" by ${pr.author}, read at ${readAt}: pass that to review post --read-at`];
  lines.push('Overlap with this board\'s work (lead the review with it):');
  if (!overlap.live.length && !overlap.landed.length) lines.push('- no overlap: no open task\'s worktree and no task landed since the PR branched changes its files');
  for (const t of overlap.live) lines.push(`- open, ${t.lane}: ${named(t)} also changes ${t.shared.join(', ')}; expect a conflict at whichever lands second`);
  for (const t of overlap.landed) lines.push(`- landed since the PR branched (${t.commits.map((c) => c.slice(0, 7)).join(', ')}): ${named(t)} changed ${t.shared.join(', ')}; check the PR builds on it and doesn't undo it`);
  if (overlap.decisions.length) {
    lines.push('Their notes on those files (a decision the PR may contradict):');
    for (const d of overlap.decisions) lines.push(`- ${d.key}: ${d.line}`);
  }
  lines.push(pr.said.length ? 'Already said on the PR (repeat none of it):' : 'Already said on the PR: nothing yet');
  for (const s of pr.said) {
    const what = s.kind === 'review' ? `review, ${String(s.state).toLowerCase()}` : s.kind === 'inline' ? `inline on ${s.path}${s.line ? `:${s.line}` : ''}` : 'comment';
    lines.push(`- ${s.login}${s.bot ? ' (bot)' : ''}, ${what}, ${s.at}: ${s.url}`);
    if (s.body.trim()) lines.push(indent(s.body));
  }
  const level = lineLevelOf(pr);
  lines.push(level.due ? 'Line-level review: due, as no automated reviewer has reviewed this PR'
    : level.wait ? `Line-level review: wait, ${level.wait} CI check${level.wait === 1 ? ' is' : 's are'} still running and an automated review may follow; run review overlap again once they finish`
      : `Line-level review: not due, as ${level.bots.join(', ')} reviewed it; add one only when the owner or the asker asks for it in words`);
  return lines;
}

// Files a worktree changes against its base ref: committed since the merge base, uncommitted, and new. → [path]
function worktreeFiles(dir, ref) {
  const base = git(dir, 'merge-base', 'HEAD', ref);
  if (!base.ok) fail(`${dir}: no merge base with ${ref} (${base.err})`);
  const out = (...args) => git(dir, ...args).out.split('\n').filter(Boolean);
  return [...out('diff', '--name-only', base.out), ...out('ls-files', '--others', '--exclude-standard')];
}

// The commits on ref since sha, in folder, oldest first: [{sha, subject, body, files}]. A board on GitHub fetches its base once
// when its clone hasn't the PR's base commit yet.
function commitsSince(folder, sha, ref, { remote, base }) {
  if (!git(folder, 'cat-file', '-e', `${sha}^{commit}`).ok && remote) git(folder, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`);
  const log = git(folder, 'log', '--reverse', '--format=%x1e%H%x1f%s%x1f%b%x1f', '--name-only', `${sha}..${ref}`);
  if (!log.ok) fail(`${folder}: can't list ${ref} since the PR's base ${sha.slice(0, 7)} (${log.err}); pull the board's main first`);
  return log.out.split('\x1e').filter((c) => c.trim()).map((c) => {
    const [hash, subject, body, files] = c.split('\x1f');
    return { sha: hash.trim(), subject, body, files: files.split('\n').map((f) => f.trim()).filter(Boolean) };
  });
}

// `review overlap <pr>`: ref is the PR's link, owner/repo#n, or n in the board's repo. → {lines}
export async function reviewOverlap(site, ref) {
  needSite(site);
  const link = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(String(ref).trim());
  const parsed = link ? { repo: link[1], number: Number(link[2]) } : parsePRRef(ref) || fail(`review overlap takes the PR's link, owner/repo#n or its number, not "${ref}"`);
  const repo = parsed.repo || boardRepoOf(site, {}) || fail('review overlap needs a board on GitHub for a bare PR number; pass owner/repo#n');
  const readAt = new Date().toISOString();
  const pr = { number: parsed.number, ...await prForReview({ repo, pr: parsed.number, login: settingsOf(await boardConfig(site)).github_login }).catch((e) => fail(e.message)) };

  const { tasks, repo: github } = await boardTasks(site);
  const items = [];
  for (const source of await itemSources(site)) {
    const list = (await readJSON(source.file, null))?.items || [];
    const agents = await readAgents(path.join(source.dir, 'agents'), new Set(list.map((it) => it.id)));
    for (const it of list) items.push({ key: `${source.slug}/${it.id}`, it, dir: source.dir, worktree: worktreeOf(routeRecord(agents, it.id)) ?? it.worktree?.path ?? null });
  }
  const live = items.filter(({ it, worktree }) => it.lane !== 'done' && worktree && fs.existsSync(worktree)).map(({ key, it, worktree }) => {
    const { base, remote } = builderRepo(site, { id: it.id });
    return { key, title: it.title, lane: LANES[it.lane || 'todo'], files: worktreeFiles(worktree, remote ? `origin/${base}` : base) };
  });

  const main = builderRepo(site);
  const byName = new Map(tasks.flatMap((t) => [[t.ticket, t], [t.id, t], ...(t.landed ? [[t.landed, t]] : [])]).filter(([name]) => name));
  const landedBy = new Map();
  for (const c of commitsSince(main.repo, pr.mergeBase, main.remote ? `origin/${main.base}` : main.base, main)) {
    const task = byName.get(c.sha) || commitNames(c).map((n) => byName.get(n)).find(Boolean);
    if (!task) continue;
    const entry = landedBy.get(task.key) || { key: task.key, title: items.find((i) => i.key === task.key)?.it.title ?? c.subject, files: [], commits: [] };
    entry.files.push(...c.files);
    entry.commits.push(c.sha);
    landedBy.set(task.key, entry);
  }

  const landed = [...landedBy.values()];
  const prFiles = new Set(pr.files);
  const notes = {};
  for (const t of [...live, ...landed].filter((t) => t.files.some((f) => prFiles.has(f)))) {
    const found = items.find((i) => i.key === t.key);
    if (found) notes[t.key] = await itemNotes(found.dir, found.it);
  }
  const cite = (key) => externalRef(tasks.find((t) => t.key === key), github);
  return { lines: overlapLines({ pr, overlap: overlapOf({ files: pr.files, live, landed, notes }), cite, readAt }) };
}
