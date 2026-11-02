// The hub's GitHub check, run once per polling slot (docs/adr/0025-the-hub-polls-github-and-sends-pushes-on-one-interval.md).
// Its PRs are every open PR on any board's card, from the board registry, boards.mjs listBoards
// (docs/adr/0040-one-board-registry-for-every-hub-feature.md). Each PR and login is fetched once,
// however many boards show it, and its summary is compared with the last one accepted, kept by repo#pr in
// ~/.claude/kickflip/github-state.json. Each board's `github-change` event lists its eligible changed cards,
// waking its owning session to run its GitHub tick (SKILL.md). Each board gets data/checked.json after a check that reached
// GitHub for every PR it shows, in the idle form when it shows none. sendWakes sends the polling interval's daily wakes
// to every board, changed or not.
import fs from 'node:fs';
import path from 'node:path';
import { fetchPR, reportOf, githubLogin } from './pr-report.mjs';
import { wakesDue, localDay } from './schedule.mjs';
import { GITHUB_STATE as STATE, WAKE_STATE, listBoards, appendEvent, prKey, readJSON, saveJSON } from './boards.mjs';

export const CHANGE_KINDS = ['ci', 'review', 'comments', 'merged', 'mergeable', 'draft'];

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

// The shape board/store.mjs writeChecked writes; board/domain.mjs checksOf reads it. every null is the idle form.
function writeChecked(dir, every) {
  const file = path.join(dir, 'data', 'checked.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(every ? { at: new Date().toISOString(), every } : { at: new Date().toISOString(), every: null, idle: true }, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// One check. every: the current polling window's minutes, for checked.json. manifest: the hub's manifest.
// → {at, watched, failed: [message], changes: [{repo, pr, changes}], events: [{route, id}], checked: [route]}
// watched counts distinct PRs; github-state.json's lastCheck also names the boards the check reached, for
// boards.mjs linksOf.
export async function checkGitHub({ every, manifest }) {
  const at = new Date().toISOString();
  const state = readJSON(STATE, { prs: {} });
  state.prs ||= {};
  state.acknowledged ||= {};
  const boards = listBoards(manifest);
  const failed = [];
  let fallback = null;
  if (boards.some((b) => !b.githubLogin && b.prs.length)) {
    try { fallback = await githubLogin(); } catch (e) { failed.push(e.message); }
  }
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
  const summaries = new Map();
  const found = Object.fromEntries([...prs.keys()].map((key) => [key, []]));
  for (const [request, p] of requests) {
    try {
      const next = summarize(reportOf(await fetchPR(p), p));
      fetched[request] = next;
      if (!summaries.has(prKey(p))) summaries.set(prKey(p), next);
    }
    catch (e) { fetched[request] = null; failed.push(e.message); }
  }
  const events = [];
  const checked = [];
  const undelivered = new Set();
  for (const board of boards) {
    const cards = board.prs.map((p) => {
      const key = prKey(p);
      const recipient = JSON.stringify([board.route, p.wave, p.id]);
      const previous = state.acknowledged[key]?.[recipient] || state.prs[key];
      const next = fetched[fetchKey(p, board.me)];
      const changes = next ? changesBetween(previous, next) : [];
      if (changes.length) found[key] = CHANGE_KINDS.filter((k) => found[key].includes(k) || changes.includes(k));
      return { p, key, recipient, previous, next, changes };
    });
    const changed = cards.filter((c) => c.changes.length);
    let reached = cards.every((c) => c.next);
    let accepted = true;
    if (changed.length) {
      try {
        events.push({ route: board.route, id: await appendEvent(board, 'github-change', { prs: changed.map(({ p, changes }) => ({ wave: p.wave, id: p.id, pr: p.pr, changes })) }) });
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
  state.lastCheck = { at, watched: prs.size, failed: failed.length, changed: changes.length, boards: checked };
  saveJSON(STATE, state);
  return { at, watched: prs.size, failed, changes, events, checked };
}

// The wakes due at `now` (schedule.mjs wakesDue): every board gets one `check-github {reason: "morning"}`
// event, so its owning session runs a GitHub tick. Each wake's last send
// day is kept in ~/.claude/kickflip/wake-state.json, so a restart never sends one twice in a day, with `last` {at, due,
// routes, failed} for boards.mjs linksOf. A wake no board took stays due. settings: the polling settings.
// → {due: [hhmm], events: [{route, id}], failed: [message]}
export async function sendWakes({ now = new Date(), settings, manifest }) {
  const state = readJSON(WAKE_STATE, {});
  state.sent ||= {};
  const due = wakesDue(now, settings, state.sent);
  const events = [];
  const failed = [];
  const missed = [];
  if (!due.length) return { due, events, failed };
  const boards = listBoards(manifest);
  for (const board of boards) {
    try { events.push({ route: board.route, id: await appendEvent(board, 'check-github', { reason: 'morning' }) }); } catch (e) { failed.push(`${board.route}: could not add the morning check-github event (${e.message})`); missed.push(board.route); }
  }
  if (events.length || !boards.length) {
    for (const w of due) state.sent[w] = localDay(now);
    state.last = { at: now.toISOString(), due, routes: events.map((e) => e.route), failed: missed };
    saveJSON(WAKE_STATE, state);
  }
  return { due, events, failed };
}
