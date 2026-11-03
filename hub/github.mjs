// The hub's GitHub check, run once per polling slot (docs/adr/0025-the-hub-polls-github-and-sends-pushes-on-one-interval.md).
// Its PRs are every open PR on any board's card, from the board registry, boards.mjs listBoards
// (docs/adr/0040-one-board-registry-for-every-hub-feature.md). Each PR and login is fetched once,
// however many boards show it, and its summary is compared with the last one accepted, kept by repo#pr in
// ~/.claude/kickflip/github-state.json. Each board's `github-change` event lists its eligible changed cards,
// waking its owning session to run its GitHub tick (SKILL.md). Before that, each card gets its PR's new owner and
// reviewer comments and reviews as thread lines, and a merged PR closes its card as merged
// (docs/adr/0134-the-hubs-poll-records-merges-and-pr-comments-on-the-card.md). Each board gets data/checked.json after a
// check that reached GitHub for every PR it shows, in the idle form when it shows none. sendWakes sends the polling
// interval's daily wakes to every board, changed or not.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { savedClient } from './linear.mjs';
import { fetchPR, reportOf, githubLogin } from './pr-report.mjs';
import { wakesDue, localDay } from './schedule.mjs';
import { GITHUB_STATE as STATE, WAKE_STATE, WAVES, listBoards, appendEvent, prKey, readJSON, saveJSON, reviewerLogins } from './boards.mjs';
import { appendThread, setItem } from '../board/store.mjs';

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
// → {at, watched, failed: [message], changes: [{repo, pr, changes}], events: [{route, id}], checked: [route], linear: {moved, failed}}
// watched counts distinct PRs; github-state.json's lastCheck also names the boards the check reached, for
// boards.mjs linksOf.
export async function checkGitHub({ every, manifest }) {
  const at = new Date().toISOString();
  const state = readJSON(STATE, { prs: {} });
  state.prs ||= {};
  state.acknowledged ||= {};
  state.threaded ||= {};
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
  const reports = {};
  const summaries = new Map();
  const found = Object.fromEntries([...prs.keys()].map((key) => [key, []]));
  for (const [request, p] of requests) {
    try {
      reports[request] = reportOf(await fetchPR(p), p);
      const next = summarize(reports[request]);
      fetched[request] = next;
      if (!summaries.has(prKey(p))) summaries.set(prKey(p), next);
    }
    catch (e) { fetched[request] = null; failed.push(e.message); }
  }
  const events = [];
  const checked = [];
  const undelivered = new Set();
  const merged = new Set();
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
    for (const card of cards) {
      const report = reports[fetchKey(card.p, board.me)];
      if (report) await recordOnCard(board, card, report, { state, merged, failed });
    }
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
  for (const key of Object.keys(state.threaded)) if (!prs.has(key)) delete state.threaded[key];
  state.lastCheck = { at, watched: prs.size, failed: failed.length, changed: changes.length, boards: checked };
  saveJSON(STATE, state);
  const linear = { moved: [], failed: [] };
  // docs/adr/0107-the-hubs-poll-moves-the-owners-linear-tickets.md
  try { await advanceLinear(boards, fetched, fetchKey, linear); }
  catch (e) { linear.failed.push(`linear: ${e.message}`); }
  return { at, watched: prs.size, failed, changes, events, checked, linear };
}

// '' for an empty plain review: its inline comments arrive as their own events.
function lineText(event) {
  const body = (event.body || '').trim();
  const verdict = event.kind === 'review' && { APPROVED: 'Approved.', CHANGES_REQUESTED: 'Changes requested.' }[event.state];
  return [verdict, body].filter(Boolean).join(' ');
}

// docs/adr/0134-the-hubs-poll-records-merges-and-pr-comments-on-the-card.md
async function recordOnCard(board, { p, key, recipient }, report, { state, merged, failed }) {
  const card = `${p.wave}/${p.id}`;
  const written = new Set(state.threaded[key]?.[recipient] || []);
  const wave = board.waves.find((w) => w.slug === p.wave)?.wave;
  const names = { ...board.reviewerLogins, ...reviewerLogins(wave?.reviewers) };
  for (const e of report.events) {
    const id = `${e.kind}:${e.id}`;
    if (!['user', 'reviewer'].includes(e.who) || e.at <= p.since || written.has(id)) continue;
    const said = lineText(e);
    try {
      if (said) {
        await appendThread(board.dir, card, {
          text: said, via: 'github', who: e.who === 'user' ? 'love' : names[String(e.login).toLowerCase()] || e.login,
          link: e.url || `https://github.com/${p.repo}/pull/${p.pr}`,
        });
      }
      written.add(id);
    } catch (err) { failed.push(`${board.route}: could not write ${card}'s GitHub line (${err.message})`); }
  }
  if (written.size) (state.threaded[key] ||= {})[recipient] = [...written];
  if (report.state !== 'MERGED') return;
  const file = JSON.stringify([board.kind === 'waves' ? WAVES : board.dir, p.wave, p.id]);
  if (merged.has(file)) return;
  merged.add(file);
  try { await setItem(board.dir, card, { status: 'merged', force: true }); }
  catch (err) { failed.push(`${board.route}: could not record ${card} merged (${err.message})`); }
}

async function advanceLinear(boards, fetched, fetchKey, result) {
  const client = savedClient();
  if (!client) return;
  const tickets = new Map();
  for (const board of boards) {
    const prs = new Map(board.prs.map((p) => [JSON.stringify([p.wave, p.id]), p]));
    const source = board.kind === 'waves' ? WAVES : board.dir;
    for (const { slug, wave } of board.waves) {
      for (const item of wave.items) {
        if (item.status === 'dropped') continue;
        const ids = new Set(item.linear || []);
        if (board.tickets?.source === 'linear' && item.ticket) ids.add(item.ticket);
        const p = prs.get(JSON.stringify([slug, item.id]));
        const summary = p && fetched[fetchKey(p, board.me)];
        const merged = ['merged', 'done'].includes(item.status) || summary?.state === 'MERGED';
        const carrying = {
          merged, ready: summary?.state === 'OPEN' && !summary.isDraft,
          hasPR: Boolean(item.pr) && (merged || summary?.state === 'OPEN'), failed: Boolean(p && !summary),
        };
        const key = JSON.stringify([source, slug, item.id]);
        for (const id of ids) {
          if (!tickets.has(id)) tickets.set(id, { items: new Map(), scoped: false, created: false });
          const ticket = tickets.get(id);
          const previous = ticket.items.get(key);
          ticket.items.set(key, { ...carrying, failed: carrying.failed || previous?.failed });
          ticket.scoped ||= Boolean(summary);
          ticket.created ||= item.ticket === id && Boolean(item.ticket_created);
        }
      }
    }
  }
  for (const [id, ticket] of tickets) {
    const items = [...ticket.items.values()];
    if (!ticket.scoped || items.some((item) => item.failed)) continue;
    const target = items.every((item) => item.merged) ? 'done'
      : items.every((item) => item.merged || item.ready) ? 'review'
      : items.some((item) => item.hasPR) ? 'started' : null;
    if (!target) continue;
    try {
      const state = await client.advanceIssue(id, target, { owner: client.saved.viewer.id, created: ticket.created });
      if (state) result.moved.push({ id, state });
    } catch (e) { result.failed.push(`linear ${id}: ${e.message}`); }
  }
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
