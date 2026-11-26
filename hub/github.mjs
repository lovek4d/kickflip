// The hub's GitHub check, run on each of the hub's checks (schedule.mjs checkEvery;
// docs/adr/2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md).
// Its PRs are every open PR on any board's card, from the board registry, boards.mjs listBoards
// (docs/adr/2026-10-29-1639-one-board-registry-for-every-hub-feature.md). One GraphQL query reads every PR and the
// account's login, however many boards show a PR (pr-report.mjs fetchPRs), and each summary is compared with the last one accepted, kept by repo#pr in
// ~/.claude/kickflip/github-state.json. Each board's `github-change` event lists its eligible changed cards,
// waking its owning session to run its GitHub tick (SKILL.md). Before that, each card gets its PR's new owner and
// reviewer comments and reviews as thread lines, and a card closes as merged once every PR on it has merged or closed,
// at least one merged (docs/adr/2026-11-02-2335-the-hubs-poll-records-merges-and-pr-comments-on-the-card.md,
// docs/adr/2026-11-03-1904-a-card-holds-several-prs-across-repos.md). A landed card waiting on an owner step runs the
// step's code check, closing when it passes (owner-checks.mjs), and a landed release card's tag run and npm are read
// until it publishes (release-watch.mjs). Each board gets data/checked.json after a
// check that reached GitHub for every PR it shows, in the idle form when it shows none. sendWakes sends the daily wake,
// at the end of quiet hours, to every board, changed or not. The same query lists each board repo's open PRs, and one
// opened by hand on a card's branch is linked to the card (linkHandPRs,
// docs/adr/2026-11-05-1000-the-poll-links-a-pr-opened-by-hand-on-a-cards-branch.md).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checksPassed, fetchPRs, markReady, reportOf } from './pr-report.mjs';
import { wakesDue, localDay } from './schedule.mjs';
import { overnightOn } from './overnight.mjs';
import { githubStateFile, wakeStateFile, wavesDir, listBoards, appendEvent, prKey, readJSON, saveJSON, reviewerLogins } from './boards.mjs';
import { appendMessage, appendStatus, setItem, mergeCard, shownCard } from '../board/cards.mjs';
import { blockWordsOf } from '../board/domain.mjs';
import { boardBranch } from '../board/worktree.mjs';
import { followPRs } from '../board/tickets.mjs';
import { storedTickets } from '../board/settings.mjs';
import { allLanded, cardPRs, leastReady, prNames } from '../shared/card-prs.mjs';

const PR_ENDED = ['MERGED', 'CLOSED'];
import { runOwnerChecks } from './owner-checks.mjs';
import { runReleaseWatch } from './release-watch.mjs';
import { runTicketRetries } from './ticket-retry.mjs';
import { audit, boardAudit } from '../shared/audit.mjs';

export const CHANGE_KINDS = ['ci', 'review', 'comments', 'merged', 'mergeable', 'draft', 'linked'];

const known = (v) => (v && v !== 'UNKNOWN' ? v : null);

// The PR report → the fields a change is read from. The newest event is the newest comment or review
// after the item's gh_since, so it clears once the session handles it.
export function summarize(out) {
  const events = Array.isArray(out.events) ? out.events : [];
  const newest = events.at(-1);
  return {
    state: out.state || null, isDraft: Boolean(out.isDraft), reviewDecision: out.reviewDecision || null,
    mergeable: out.mergeable || null, mergeStateStatus: out.mergeStateStatus || null, head: out.head || null,
    failing: [...new Set(out.failing || [])].sort(), pending: Number(out.pending) || 0,
    eventId: newest ? String(newest.id) : null, eventAt: newest?.at || null,
    // For the PR's Slack link and its reactions (board/slack-store.mjs reviewDue)
    title: out.title ?? null, additions: out.additions ?? null, deletions: out.deletions ?? null, files: out.files ?? null,
    approved: Boolean(out.approved),
    // What a board's badges draw, which boards read from here (board/snapshot.mjs readSnapshot,
    // docs/adr/2026-11-09-1556-boards-read-pr-state-from-the-hubs-check.md)
    url: out.url ?? null, mergedAt: out.mergedAt ?? null, headRefName: out.headRefName ?? null, headRefOid: out.headRefOid ?? null,
    updatedAt: out.updatedAt ?? null, checks: out.checks ?? null, reviews: out.reviews ?? {},
  };
}

// The CHANGE_KINDS between two summaries, in that order. A PR seen for the first time reports only what the
// session hasn't handled: a merge, or comments after its gh_since. GitHub computes mergeability lazily, so
// UNKNOWN never counts as a change.
export function changesBetween(prev, next) {
  const out = new Set();
  if (!prev) {
    if (next.state === 'MERGED') out.add('merged');
    if (next.eventId) out.add('comments');
    return CHANGE_KINDS.filter((k) => out.has(k));
  }
  const settled = next.pending === 0 && (prev.pending > 0 || prev.head !== next.head);
  if (settled || prev.failing.join('\n') !== next.failing.join('\n')) out.add('ci');
  if (prev.reviewDecision !== next.reviewDecision) out.add('review');
  if (next.eventId && next.eventId !== prev.eventId) out.add('comments');
  if (next.state === 'MERGED' && prev.state !== 'MERGED') out.add('merged');
  for (const k of ['mergeable', 'mergeStateStatus']) if (known(prev[k]) && known(next[k]) && prev[k] !== next[k]) out.add('mergeable');
  if (prev.isDraft !== next.isDraft) out.add('draft');
  return CHANGE_KINDS.filter((k) => out.has(k));
}

// What to remember for next time: next, keeping the last known mergeability over an UNKNOWN.
export function carry(prev, next) {
  const kept = { ...next };
  for (const k of ['mergeable', 'mergeStateStatus']) if (!known(next[k]) && known(prev?.[k])) kept[k] = prev[k];
  return kept;
}

// The shape of data/checked.json; board/domain.mjs checksOf reads it. every null is the idle form.
function writeChecked(dir, every) {
  const file = path.join(dir, 'data', 'checked.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(every ? { at: new Date().toISOString(), every } : { at: new Date().toISOString(), every: null, idle: true }, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// One check. every: the most minutes until the next check, for checked.json. manifest: the hub's manifest.
// → {at, watched, failed: [message], changes: [{repo, pr, changes}], events: [{route, id}], checked: [route], merged: [route],
// tickets: {moved, failed} of the ticket layer's PR poll (board/tickets.mjs followPRs), rate: GitHub's {remaining, resetAt} after the query, null when no PR made one}. merged names each board where this check recorded a card merged, for the hub to refresh its Main
// (docs/adr/2026-11-03-1619-a-merge-refreshes-its-boards-main-at-once.md).
// watched counts distinct PRs; github-state.json's lastCheck also names the boards the check reached, for
// boards.mjs linksOf.
export async function checkGitHub({ every, manifest }) {
  const at = new Date().toISOString();
  const state = readJSON(githubStateFile(), { prs: {} });
  state.prs ||= {};
  state.acknowledged ||= {};
  state.threaded ||= {};
  const boards = listBoards(manifest);
  const failed = [];
  const distinct = [...new Map(boards.flatMap((b) => b.prs).map((p) => [prKey(p), { repo: p.repo, pr: p.pr }])).values()];
  const repos = [...new Set(boards.flatMap(repoList))];
  let query = null;
  if (distinct.length || repos.length) {
    try { query = await fetchPRs(distinct, repos); } catch (e) { failed.push(e.message); }
  }
  const linked = new Map(boards.map((board) => [board.route, []]));
  if (query) for (const board of boards) linked.set(board.route, await linkHandPRs(board, query.open, failed));
  const raw = new Map(distinct.map((p, i) => [prKey(p), query ? query.results[i] : null]));
  const fallback = query?.login ?? null;
  const fetchKey = (p, me) => JSON.stringify([prKey(p), me]);
  const prs = new Map();
  const requests = new Map();
  const variants = new Map();
  for (const board of boards) {
    board.me = board.githubLogin || fallback;
    for (const p of board.prs) {
      const key = prKey(p);
      prs.set(key, p);
      const labels = variants.get(key) || new Set();
      labels.add(board.me);
      variants.set(key, labels);
      if (!board.me) continue;
      const request = fetchKey(p, board.me);
      const seen = requests.get(request);
      if (!seen || p.since < seen.since) requests.set(request, { ...p, me: board.me });
    }
  }
  const fetched = {};
  const reports = {};
  const summaries = new Map();
  const found = Object.fromEntries([...prs.keys()].map((key) => [key, []]));
  const reported = new Set();
  for (const [request, p] of requests) {
    const got = raw.get(prKey(p));
    if (!got?.view) {
      fetched[request] = null;
      if (got?.error && !reported.has(got.error)) { reported.add(got.error); failed.push(got.error); }
      continue;
    }
    reports[request] = reportOf(got, p);
    const next = summarize(reports[request]);
    fetched[request] = next;
    if (!summaries.has(prKey(p))) summaries.set(prKey(p), next);
  }
  const events = [];
  const checked = [];
  const undelivered = new Set();
  const merged = new Map();
  const mergedRoutes = new Set();
  const readied = new Set();
  const mergeTried = new Set();
  for (const board of boards) {
    const cards = board.prs.map((p) => {
      const key = prKey(p);
      const recipient = JSON.stringify([board.route, p.file, p.id]);
      const previous = state.acknowledged[key]?.[recipient] || state.prs[key];
      const next = fetched[fetchKey(p, board.me)];
      const changes = next ? changesBetween(previous, next) : [];
      if (changes.length) found[key] = CHANGE_KINDS.filter((k) => found[key].includes(k) || changes.includes(k));
      return { p, key, recipient, previous, next, changes };
    });
    for (const card of cards) {
      const report = reports[fetchKey(card.p, board.me)];
      const siblings = cards.filter((c) => c.p.file === card.p.file && c.p.id === card.p.id);
      if (report && await recordOnCard(board, card, report, siblings, { state, merged, failed })) mergedRoutes.add(board.route);
      if (board.skipDraft) await readyGreenDraft(board, card, raw.get(card.key)?.view, readied, failed);
      if (board.autoMerge) await mergeApproved(board, card, raw.get(card.key)?.view, mergeTried, failed);
    }
    const changed = cards.filter((c) => c.changes.length);
    let reached = cards.every((c) => c.next);
    let accepted = true;
    if (changed.length || linked.get(board.route).length) {
      try {
        const prs = [...changed.map(({ p, changes }) => ({ file: p.file, id: p.id, pr: p.pr, changes })), ...linked.get(board.route)];
        events.push({ route: board.route, id: await appendEvent(board, 'github-change', { prs }) });
      } catch (e) {
        failed.push(`${board.route}: could not add the github-change event (${e.message})`);
        for (const { key } of changed) undelivered.add(key);
        reached = accepted = false;
      }
    }
    // Retain each recipient's accepted summary while another delivery is outstanding, so retries don't repeat
    // accepted changes while another board's delivery is retried, or when logins label the same PR differently.
    for (const { key, recipient, previous, next, changes } of cards) {
      if (next && (accepted || !changes.length)) {
        state.acknowledged[key] ||= {};
        state.acknowledged[key][recipient] = carry(previous, next);
      }
    }
    if (!reached) continue;
    try { writeChecked(board.dir, board.prs.length ? every : null); checked.push(board.route); } catch (e) { failed.push(`${board.route}: could not write checked.json (${e.message})`); }
  }
  const changes = [];
  for (const [key, p] of prs) {
    const next = summaries.get(key);
    if (!next || undelivered.has(key)) continue;
    if (found[key].length) {
      changes.push({ repo: p.repo, pr: p.pr, changes: found[key] });
    }
    state.prs[key] = { ...carry(state.prs[key], next), at };
    if (variants.get(key).size === 1) delete state.acknowledged[key];
  }
  for (const key of Object.keys(state.acknowledged)) if (!prs.has(key)) delete state.acknowledged[key];
  for (const key of Object.keys(state.threaded)) if (!prs.has(key)) delete state.threaded[key];
  await runOwnerChecks(boards, state, failed);
  await runReleaseWatch(boards, failed);
  await runTicketRetries(boards, failed);
  state.lastCheck = { at, watched: prs.size, failed: failed.length, changed: changes.length, boards: checked };
  saveJSON(githubStateFile(), state);
  const tickets = await followPRs(ticketCards(boards, fetched, fetchKey));
  return { at, watched: prs.size, failed, changes, events, checked, merged: [...mergedRoutes], tickets, rate: query?.rate ?? null };
}

const repoList = (board) => (board.github ? [board.github] : [...new Set(board.files.map((w) => w.itemFile.repo).filter(Boolean))]);

// A hand-opened PR comes from the card's own branch, the board-named one a build pushes (board/worktree.mjs boardBranch), so an open PR in the card's repo whose head is that
// branch in the same repo, and which the card doesn't hold yet, was opened by hand: a bare card id names no board, so another board's same-numbered card never matches. It is recorded as `item set --pr` does,
// with no --clear-status. → [{file, id, pr, changes: ['linked']}] for the github-change event.
async function linkHandPRs(board, open, failed) {
  const out = [];
  for (const { slug, itemFile } of board.files) {
    const repo = board.github || itemFile.repo;
    const heads = new Map((open[repo] || []).filter((p) => !p.isCrossRepository).map((p) => [p.headRefName, p.number]));
    if (!heads.size) continue;
    for (const item of itemFile.items) {
      if (item.lane === 'done' || cardPRs(item, repo).some((p) => p.repo === repo)) continue;
      const branch = boardBranch(board, item.id);
      if (!heads.has(branch)) continue;
      const card = `${slug}/${item.id}`;
      const pr = heads.get(branch);
      try {
        await setItem(board.dir, card, { pr });
        await appendStatus(board.dir, card, 'pr-found', { pr, branch });
        out.push({ file: slug, id: item.id, pr, changes: ['linked'] });
      } catch (err) { failed.push(`${board.route}: could not link PR #${pr} to ${card} (${err.message})`); }
    }
  }
  return out;
}

// '' for an empty plain review: its inline comments arrive as their own events.
function lineText(event) {
  const body = (event.body || '').trim();
  const verdict = event.kind === 'review' && { APPROVED: 'Approved.', CHANGES_REQUESTED: 'Changes requested.' }[event.state];
  return [verdict, body].filter(Boolean).join(' ');
}

// docs/adr/2026-11-02-2335-the-hubs-poll-records-merges-and-pr-comments-on-the-card.md. siblings is every PR on the card, this one
// included, with its summary as next; once every one has merged or closed the card moves to Done, each merged PR marked
// with its merge (docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md), its line naming the
// merged ones, or the closed ones when none merged. → true when this check recorded the card merged (shared/card-prs.mjs
// allLanded), on any board showing it.
async function recordOnCard(board, { p, key, recipient }, report, siblings, { state, merged, failed }) {
  const card = `${p.file}/${p.id}`;
  const written = new Set(state.threaded[key]?.[recipient] || []);
  const itemFile = board.files.find((w) => w.slug === p.file)?.itemFile;
  const names = { ...board.reviewerLogins, ...reviewerLogins(itemFile?.reviewers) };
  for (const e of [...report.events, ...report.threadOnly].sort((a, b) => (a.at < b.at ? -1 : 1))) {
    const id = `${e.kind}:${e.id}`;
    if (!['user', 'reviewer'].includes(e.who) || e.at <= p.since || written.has(id)) continue;
    const said = lineText(e);
    try {
      if (said) {
        await appendMessage(board.dir, card, {
          text: said, via: 'github', who: e.who === 'user' ? 'love' : names[String(e.login).toLowerCase()] || e.login,
          link: e.url || `https://github.com/${p.repo}/pull/${p.pr}`,
        });
      }
      written.add(id);
    } catch (err) { failed.push(`${board.route}: could not write ${card}'s GitHub line (${err.message})`); }
  }
  if (written.size) (state.threaded[key] ||= {})[recipient] = [...written];
  const states = siblings.map((c) => c.next);
  if (!PR_ENDED.includes(report.state) || !states.every((s) => PR_ENDED.includes(s?.state))) return false;
  const landed = allLanded(states);
  const file = JSON.stringify([board.kind === 'waves' ? wavesDir() : board.dir, p.file, p.id]);
  if (!merged.has(file)) {
    const repo = board.github || board.files.find((w) => w.slug === p.file)?.itemFile.repo;
    const prs = siblings.filter((c) => c.next.state === 'MERGED').map((c) => ({ repo: c.p.repo, number: c.p.pr }));
    const closedPRs = siblings.map((c) => ({ repo: c.p.repo, number: c.p.pr }));
    // A merge closes with the board's merged line (board/cards.mjs closingLine).
    const closing = landed ? undefined : ['prs-closed', { prs: prNames(closedPRs, repo) }];
    try { await setItem(board.dir, card, { merged: prs, force: true, closing }); merged.set(file, landed); }
    catch (err) { failed.push(`${board.route}: could not record ${card} ${landed ? 'merged' : 'closed'} (${err.message})`); merged.set(file, false); }
  }
  return merged.get(file);
}

// docs/adr/2026-11-04-1913-a-board-can-skip-the-draft.md: on a board that skips the draft, a card's draft PR is marked
// ready for review once its CI passes, once a check however many cards show it, with a line on the card. The next
// check reads it out of draft, which wakes the session with a draft change. A blocked card's draft stays a draft until
// nothing blocks it (docs/adr/2026-11-24-0100-a-block-holds-every-transition-and-its-end-moves-the-card-or-opens-a-wait.md).
async function readyGreenDraft(board, { p, key }, view, readied, failed) {
  if (readied.has(key) || view?.state !== 'OPEN' || !view.isDraft || !checksPassed(view.statusCheckRollup)) return;
  if (blockWordsOf(await shownCard(board.dir, `${p.file}/${p.id}`))) return;
  readied.add(key);
  const entry = { call: 'ready-draft', key: `${p.file}/${p.id}`, reason: `The board skips the draft and PR #${p.pr}'s CI passed.`, inputs: { repo: p.repo, pr: p.pr, isDraft: view.isDraft, checks: 'passed' } };
  try { await markReady({ repo: p.repo, pr: p.pr }); }
  catch (err) {
    audit(boardAudit(board.dir), { ...entry, result: 'failed', reason: `${entry.reason} gh failed: ${err.message}` }, { once: true });
    failed.push(`${board.route}: could not mark ${key} ready for review (${err.message})`); return;
  }
  audit(boardAudit(board.dir), { ...entry, result: 'marked ready' });
  try { await appendStatus(board.dir, `${p.file}/${p.id}`, 'ci-passed', { pr: p.pr }); }
  catch (err) { failed.push(`${board.route}: could not write ${p.file}/${p.id}'s ready line (${err.message})`); }
}

// docs/adr/2026-11-04-2045-the-merge-tap-and-auto-merge-run-in-code.md: on a board with auto-merge on, a card whose PR
// GitHub reads approved, green and CLEAN is merged here (board/cards.mjs mergeCard, which rereads every PR on the card), once
// a check however many of its PRs show it. A refusal such as commits after the approval is left to the session, which
// the github-change event wakes; a gh failure is reported.
async function mergeApproved(board, { p }, view, tried, failed) {
  const card = `${p.file}/${p.id}`;
  const key = JSON.stringify([board.dir, card]);
  if (tried.has(key) || view?.state !== 'OPEN' || view.isDraft || view.reviewDecision !== 'APPROVED' || view.mergeStateStatus !== 'CLEAN' || !checksPassed(view.statusCheckRollup)) return;
  tried.add(key);
  const entry = { call: 'auto-merge', key: card, reason: `Auto-merge is on and PR #${p.pr} is approved, green and clean.`, inputs: { repo: p.repo, pr: p.pr, reviewDecision: view.reviewDecision, mergeStateStatus: view.mergeStateStatus, checks: 'passed' } };
  try {
    await mergeCard(board.dir, card);
    audit(boardAudit(board.dir), { ...entry, result: 'merged' });
  } catch (err) {
    audit(boardAudit(board.dir), { ...entry, result: 'not merged', reason: `${entry.reason} ${err.message}` }, { once: true });
    if (!err.message.startsWith('Not merged:')) failed.push(`${board.route}: could not merge ${card} (${err.message})`);
  }
}

// Every card on every board with its PRs as this check read them, for the ticket layer's PR poll (board/tickets.mjs
// followPRs). key names a waves card once however many boards show it; the card's least-ready PR stands for it, as on
// the board (shared/card-prs.mjs leastReady).
function ticketCards(boards, fetched, fetchKey) {
  const cards = [];
  for (const board of boards) {
    const prs = Map.groupBy(board.prs, (p) => JSON.stringify([p.file, p.id]));
    const dir = board.kind === 'waves' ? wavesDir() : board.dir;
    const source = storedTickets(board.tickets);
    for (const { slug, itemFile } of board.files) {
      for (const item of itemFile.items) {
        const summaries = (prs.get(JSON.stringify([slug, item.id])) || []).map((p) => fetched[fetchKey(p, board.me)] || null);
        const summary = summaries[leastReady(summaries)];
        const merged = item.lane === 'done' || allLanded(summaries);
        cards.push({
          source, item, key: JSON.stringify([dir, slug, item.id]), card: `${board.route}:${slug}/${item.id}`,
          scoped: summaries.some(Boolean), failed: summaries.some((s) => !s), merged, ready: summary?.state === 'OPEN' && !summary.isDraft,
          hasPR: summaries.length > 0 && (merged || summaries.some((s) => s?.state === 'OPEN')),
        });
      }
    }
  }
  return cards;
}

// The wake due at `now` (schedule.mjs wakesDue): every board gets one `check-github {reason: "morning"}`
// event, so its owning session runs a GitHub tick. Each wake's last send
// day is kept in ~/.claude/kickflip/wake-state.json, so a restart never sends one twice in a day, with `last` {at, due,
// routes, failed} for boards.mjs linksOf and the Daily wake row (overnight.mjs), a run no board took included; that wake
// stays due. With Daily wake off in Overnight work, none is due. settings: push.mjs readSettings.
// → {due: [hhmm], events: [{route, id}], failed: [message]}
export async function sendWakes({ now = new Date(), settings, manifest }) {
  const state = readJSON(wakeStateFile(), {});
  state.sent ||= {};
  const due = overnightOn('wake') ? wakesDue(now, settings, state.sent) : [];
  const events = [];
  const failed = [];
  const missed = [];
  if (!due.length) return { due, events, failed };
  const boards = listBoards(manifest);
  for (const board of boards) {
    try { events.push({ route: board.route, id: await appendEvent(board, 'check-github', { reason: 'morning' }) }); } catch (e) { failed.push(`${board.route}: could not add the morning check-github event (${e.message})`); missed.push(board.route); }
  }
  if (events.length || !boards.length) for (const w of due) state.sent[w] = localDay(now);
  state.last = { at: now.toISOString(), due, routes: events.map((e) => e.route), failed: missed };
  saveJSON(wakeStateFile(), state);
  return { due, events, failed };
}
