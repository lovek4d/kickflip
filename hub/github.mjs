// The hub's GitHub check, run once per polling slot (docs/adr/0025-the-hub-polls-github-and-sends-pushes-on-one-interval.md).
// Its PRs are every open PR on any board's card, from the board registry, boards.mjs listBoards
// (docs/adr/0040-one-board-registry-for-every-hub-feature.md). Each PR runs the monitor skill's monitor-gh.sh once,
// however many boards show it, and its summary is compared with the last one accepted, kept by repo#pr in
// ~/.claude/web-ts/github-state.json. Each board's `github-change` event lists its eligible changed cards,
// waking its owning session to run a monitor tick. A `head` change goes only to a card that
// carries an install, so its session rebuilds it
// (docs/adr/0051-a-device-app-card-carries-an-install-link.md). Each board gets data/checked.json after a check that reached
// GitHub for every PR it shows, in the idle form when it shows none. sendWakes sends the polling interval's daily wakes
// to every board, changed or not.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { wakesDue, localDay } from './schedule.mjs';
import { GITHUB_STATE as STATE, WAKE_STATE, listBoards, appendEvent, prKey, readJSON, saveJSON } from './boards.mjs';

const MONITOR_GH = path.join(os.homedir(), '.claude', 'skills', 'monitor', 'monitor-gh.sh');
// launchd starts the hub without Homebrew on PATH, and monitor-gh.sh needs gh and jq from it.
const CHILD_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
export const CHANGE_KINDS = ['ci', 'review', 'comments', 'merged', 'mergeable', 'draft', 'head'];

const known = (v) => (v && v !== 'UNKNOWN' ? v : null);

// monitor-gh.sh's output → the fields a change is read from. The newest event is the newest comment or review
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
  if (next.state === 'OPEN' && prev.head && next.head && prev.head !== next.head) out.add('head');
  return CHANGE_KINDS.filter((k) => out.has(k));
}

export function cardChanges(p, changes) {
  return changes.filter((k) => k !== 'head' || p.install);
}

// What to remember for next time: next, keeping the last known mergeability over an UNKNOWN.
export function carry(prev, next) {
  const kept = { ...next };
  for (const k of ['mergeable', 'mergeStateStatus']) if (!known(next[k]) && known(prev?.[k])) kept[k] = prev[k];
  return kept;
}

function runMonitorGh({ pr, repo, since }) {
  return new Promise((resolve, reject) => {
    execFile('/bin/zsh', [MONITOR_GH, String(pr), since], { env: { ...process.env, PATH: CHILD_PATH, MONITOR_REPO: repo }, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${repo}#${pr}: ${String(stderr || err.message).trim().split('\n')[0].slice(0, 200)}`));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`${repo}#${pr}: unreadable output (${e.message})`)); }
    });
  });
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
  // One fetch per PR, from the earliest gh_since of the cards that show it, so no board misses a comment.
  const prs = new Map();
  for (const p of boards.flatMap((b) => b.prs)) {
    const seen = prs.get(prKey(p));
    if (!seen || p.since < seen.since) prs.set(prKey(p), p);
  }
  const failed = [];
  const fetched = {};
  const found = {};
  for (const [key, p] of prs) {
    try { fetched[key] = summarize(await runMonitorGh(p)); } catch (e) { fetched[key] = null; failed.push(e.message); continue; }
    found[key] = [];
  }
  const events = [];
  const checked = [];
  const undelivered = new Set();
  for (const board of boards) {
    const cards = board.prs.map((p) => {
      const key = prKey(p);
      const recipient = JSON.stringify([board.route, p.wave, p.id]);
      const previous = state.acknowledged[key]?.[recipient] || state.prs[key];
      const changes = fetched[key] ? cardChanges(p, changesBetween(previous, fetched[key])) : [];
      if (changes.length) found[key] = CHANGE_KINDS.filter((k) => found[key].includes(k) || changes.includes(k));
      return { p, key, recipient, previous, changes };
    });
    const changed = cards.filter((c) => c.changes.length);
    let reached = board.prs.every((p) => fetched[prKey(p)]);
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
    // accepted changes or lose an install's head change when another board accepts only CI.
    for (const { key, recipient, previous, changes } of cards) {
      if (fetched[key] && (accepted || !changes.length)) {
        state.acknowledged[key] ||= {};
        state.acknowledged[key][recipient] = carry(previous, fetched[key]);
      }
    }
    if (!reached) continue;
    try { writeChecked(board.dir, board.prs.length ? every : null); checked.push(board.route); } catch (e) { failed.push(`${board.route}: could not write checked.json (${e.message})`); }
  }
  const changes = [];
  for (const [key, next] of Object.entries(fetched)) {
    if (!next || undelivered.has(key)) continue;
    if (found[key].length) {
      changes.push({ repo: prs.get(key).repo, pr: prs.get(key).pr, changes: found[key] });
    }
    state.prs[key] = { ...carry(state.prs[key], next), at };
    delete state.acknowledged[key];
  }
  for (const key of Object.keys(state.acknowledged)) if (!prs.has(key)) delete state.acknowledged[key];
  state.lastCheck = { at, watched: prs.size, failed: failed.length, changed: changes.length, boards: checked };
  saveJSON(STATE, state);
  return { at, watched: prs.size, failed, changes, events, checked };
}

// The wakes due at `now` (schedule.mjs wakesDue): every board gets one `check-github {reason: "morning"}`
// event, so its owning session runs a monitor tick, which runs the Slack bridge's daily steps. Each wake's last send
// day is kept in ~/.claude/web-ts/wake-state.json, so a restart never sends one twice in a day, with `last` {at, due,
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
