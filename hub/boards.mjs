// The one registry of board sites (docs/adr/0040-one-board-registry-for-every-hub-feature.md). Only this module reads a
// board's board.json and the wave files its items come from. Every hub feature that serves boards asks listBoards: the
// GitHub check and its github-change routing (github.mjs), the daily wakes, the rules fan-out, the handshake and the
// not-listening push. So a board over the waves and a board over its own file get every link the same way, and a
// new feature can't forget one kind. linksOf says whether each link reaches a board, for its Hub links sheet.
// A board: {route, dir, port, title, kind: 'waves' | 'file', waves: [{slug, wave}], prs: [{wave, id, pr, repo, since}],
// githubLogin: board.json github_login or null, reviewers: [name], reviewerLogins: {login: name}, owner, watch,
// filter}. prs are the open PRs on any of its cards: every item with a PR that isn't merged or dropped, with no
// monitor.json opt-in; a card showing a PR is the opt-in.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { routeRecord } from './routes.mjs';
import { deliver, readSettings } from './push.mjs';
import { DEFAULTS, windowAt } from './schedule.mjs';
import { liveSessions } from './live.mjs';
import { withFileLock } from './locks.mjs';
import { dropSessionPrompts, readPrompts, savePrompts, withPromptsLock } from './prompts.mjs';
import { storedPath } from '../bin/install.mjs';
import { hubService } from '../shared/service.mjs';
import { cloneRoot } from '../shared/repos.mjs';
import { githubFromOrigin } from './repos.mjs';
import { reviewLinks, topicItems } from '../board/review.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE = path.join(os.homedir(), '.claude');
const WEB = path.join(CLAUDE, 'kickflip');
export const WAVES = path.join(CLAUDE, 'waves');
const MANIFEST = path.join(WEB, 'manifest.json');
export const GITHUB_STATE = path.join(WEB, 'github-state.json');
export const WAKE_STATE = path.join(WEB, 'wake-state.json');
const DEAF_STATE = path.join(WEB, 'deaf-state.json');
export const RESUME_STATE = path.join(WEB, 'resume-state.json');
const LINK_FAULTS = path.join(WEB, 'link-faults.json');
export const REPO_FETCH = path.join(WEB, 'repo-fetch.json');
export const HUB_CODE = path.join(WEB, 'hub-code.json');
const SUBS = path.join(WEB, 'push', 'subs.json');
const FINISHED = ['merged', 'dropped'];
const NO_SINCE = '1970-01-01T00:00:00Z';
// bin/wait-events.mjs exits on each event and the session relaunches it, so a recent exit still counts as running.
const RELAUNCH_GRACE = 2 * 60_000;
// An event waiting this long while the board isn't listening pushes the owner once (checkListening).
export const DEAF_AFTER = 15 * 60_000;

export const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
export function saveJSON(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
export const readManifest = () => readJSON(MANIFEST, { sites: {} });

// Runs fn while holding the manifest's lock, the directory manifest.json.lock that bin/kickflip.mjs takes too. A lock
// older than 30 seconds is a dead holder's and is taken over. Throws with code 'ELOCKED' after 10 seconds.
export const withManifestLock = (fn) => withFileLock(MANIFEST, fn);

// Call under the manifest lock. Clear both sessions before publishing an ownership change, even with the hub down.
export function writeManifest(m) {
  return withPromptsLock(() => {
    const sites = [...Object.values(m.sites || {}), ...Object.values(m.closed || {}).map((entry) => entry.site)];
    for (const site of sites.filter(Boolean)) {
      if (site.dir) site.dir = storedPath(site.dir);
      if (Array.isArray(site.cmd)) site.cmd = site.cmd.map((arg) => storedPath(arg));
      if (site.owner?.repo) site.owner.repo = storedPath(site.owner.repo);
    }
    for (const owner of Object.values(m.starting || {})) {
      if (owner.repo) owner.repo = storedPath(owner.repo);
    }
    const previous = readManifest();
    const owner = (manifest, route) => routeRecord(manifest.sites, route)?.owner || routeRecord(manifest.starting, route);
    const routes = new Set([...Object.keys(previous.sites || {}), ...Object.keys(m.sites || {}),
      ...Object.keys(previous.starting || {}), ...Object.keys(m.starting || {})]);
    const sessions = [];
    for (const route of routes) {
      const before = owner(previous, route);
      const after = owner(m, route);
      if (before?.session !== after?.session || before?.since !== after?.since) sessions.push(before?.session, after?.session);
    }
    if (sessions.some(Boolean)) {
      const store = readPrompts();
      dropSessionPrompts(store, sessions);
      savePrompts(store);
    }
    saveJSON(MANIFEST, m);
  });
}
export const prKey = (p) => `${p.repo}#${p.pr}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const names = (list) => (Array.isArray(list) ? list : []).map((r) => (typeof r === 'string' ? r : r?.name)).filter((n) => typeof n === 'string' && n);
export const reviewerLogins = (list) => Object.fromEntries((Array.isArray(list) ? list : [])
  .filter((r) => typeof r?.github === 'string' && r.github && typeof r.name === 'string' && r.name).map((r) => [r.github.toLowerCase(), r.name]));
const isWave = (w) => Array.isArray(w?.items);

export const isBoardSite = (s) => Array.isArray(s?.cmd) && s.cmd.some((a) => /board[/\\]server\.mjs$/.test(a)) && typeof s.dir === 'string';
// Whether a board's builders branch from its repo's local main and land there, with no fetch: a board
// `kickflip join` made (`local: true`), the hub board among them, and a board with neither a GitHub repo nor a plain git remote
// (docs/adr/0143-kickflip-join-adds-the-current-repository-as-a-board.md).
export const buildsLocally = (s) => s.local === true || !(s.github || s.remote);

// The waves a board shows, keyed as board/store.mjs itemSources keys them: a file board's slug is board.json `slug`,
// else the file's basename, so a github-change names the same <wave>/<id> the board's cards use.
function wavesOf(dir, cfg, kind) {
  if (kind === 'file') {
    const wave = readJSON(path.resolve(dir, cfg.items), null);
    return isWave(wave) ? [{ slug: cfg.slug || path.basename(cfg.items, '.json'), wave }] : [];
  }
  let slugs = [];
  try { slugs = fs.readdirSync(WAVES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch {}
  return slugs.map((slug) => ({ slug, wave: readJSON(path.join(WAVES, slug, 'wave.json'), null) })).filter((w) => isWave(w.wave));
}

// [{slug, wave}] → each card's open PR: [{wave, id, pr, repo, since}], since being the item's gh_since. A card
// whose board has no github and whose wave has no repo has no PR to poll.
export function prsOf(waves, github) {
  return waves.flatMap(({ slug, wave }) => {
    const repo = github || wave.repo;
    if (!repo) return [];
    return wave.items.filter((it) => Number.isInteger(it?.pr) && !FINISHED.includes(it.status))
      .map((it) => ({ wave: slug, id: it.id, pr: it.pr, repo, since: it.gh_since || NO_SINCE }));
  });
}

function boardOf(route, s) {
  const cfg = readJSON(path.join(s.dir, 'board.json'), {});
  const kind = typeof cfg.items === 'string' && cfg.items !== 'waves' ? 'file' : 'waves';
  const waves = wavesOf(s.dir, cfg, kind);
  const github = s.github;
  return {
    route, dir: s.dir, port: s.port, title: cfg.title || s.title || route, kind, waves, prs: prsOf(waves, github), github, ...(s.remote && !github ? { remote: s.remote } : {}), branch: s.branch, auto_build: cfg.auto_build === true,
    githubLogin: typeof cfg.github_login === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(cfg.github_login) ? cfg.github_login : null,
    tickets: cfg.tickets, reviewers: names(cfg.reviewers), reviewerLogins: reviewerLogins(cfg.reviewers), owner: s.owner || null, watch: Array.isArray(s.watch) && s.watch.length ? s.watch : ['data/events.jsonl'], filter: s.filter || null,
  };
}

// Every board site in the manifest (a site whose cmd runs board/server.mjs), in manifest order.
export function listBoards(manifest = readManifest()) {
  return Object.entries(manifest?.sites || {}).filter(([, s]) => isBoardSite(s)).map(([route, s]) => boardOf(route, s));
}

// The board whose manifest entry has `hub: true`, which bin/kickflip.mjs `set --hub` and `join --hub` keep on at most one
// site: its session runs in the foreground in tmux (docs/adr/0147-boards-run-in-the-background-and-the-hub-board-in-tmux.md).
// → a board, or undefined when no board has it
export function hubBoard(manifest = readManifest()) {
  const found = Object.entries(manifest?.sites || {}).find(([, s]) => s?.hub === true && isBoardSite(s));
  return found ? boardOf(...found) : undefined;
}

// Two paths name one folder when they are equal or resolve to the same real folder, as a saved path through a link does.
export function samePath(a, b) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return path.resolve(a) === path.resolve(b) || real(a) === real(b);
}

// The board served from `dir`, for its own server; null when the manifest has no board there.
export function boardAt(dir, manifest = readManifest()) {
  const found = Object.entries(manifest?.sites || {}).find(([, s]) => isBoardSite(s) && samePath(s.dir, dir));
  return found ? boardOf(...found) : null;
}

// One event on a board, through its server's own append path, so the line has the server's id scheme and wakes its
// watcher. A board that is down gets the same line appended directly. → the event id
export async function appendEvent(board, kind, data) {
  try {
    const r = await fetch(`http://127.0.0.1:${board.port}/_claude/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ...data }), signal: AbortSignal.timeout(5000),
    });
    if (r.ok) return (await r.json()).id;
  } catch {}
  const e = { id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ts: new Date().toISOString(), kind, data };
  fs.mkdirSync(path.join(board.dir, 'data'), { recursive: true });
  fs.appendFileSync(path.join(board.dir, 'data', 'events.jsonl'), JSON.stringify(e) + '\n');
  return e.id;
}

// One `kind` event on each board, as a hub rules save sends `rules {scope: "hub"}`. → {events: [{route, id}], failed: [message]}
export async function sendToBoards(boards, kind, data) {
  const events = [];
  const failed = [];
  for (const b of boards) {
    try { events.push({ route: b.route, id: await appendEvent(b, kind, data) }); } catch (e) { failed.push(`${b.route}: could not add the ${kind} event (${e.message})`); }
  }
  return { events, failed };
}

// ---------- listening ----------
// Whether a watcher (bin/wait-events.mjs) runs for the board, from data/watcher.json {pid, since, exited_at}: its pid
// alive and running wait-events.mjs, since pids get reused, or an exit within the relaunch grace (ms).
export function watcherRunning(dir, now = Date.now(), { grace = RELAUNCH_GRACE } = {}) {
  const w = readJSON(path.join(dir, 'data', 'watcher.json'), null);
  if (!Number.isInteger(w?.pid)) return false;
  if (typeof w.exited_at === 'string') return now - Date.parse(w.exited_at) <= grace;
  try { process.kill(w.pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try { return execFileSync('ps', ['-p', String(w.pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).includes('wait-events.mjs'); } catch { return false; }
}

// Whether the board hears its events: its owner session runs and a watcher runs for it. A watcher outlives its
// session, so one alone isn't listening (docs/adr/0061-a-boards-session-wakes-when-an-event-arrives.md). running is
// live.mjs liveSessions' Map, passed when checking several boards.
export function isListening(board, { now = Date.now(), running } = {}) {
  const session = board.owner?.session;
  return Boolean(session && (running ?? liveSessions()).has(session)) && watcherRunning(board.dir, now);
}

// Whether the board hears its events now: 'listening' (isListening); 'waking', the hub resumed its session for this
// outage and is still waiting for it to listen (resume-state.json resumed_at, with no error or pushed_at yet); 'asleep',
// its owner session isn't running and the hub can wake it on the next event or a tap on its page (hub/sessions.mjs
// checkSessions): a session and folder are recorded and no wake of this outage has failed or gone unanswered; else
// 'deaf', which nothing will wake. running is live.mjs liveSessions' Map and wakes resume-state.json, passed when
// checking several boards.
export function listenState(board, { now = Date.now(), running = liveSessions(), wakes = readJSON(RESUME_STATE, {}) } = {}) {
  if (isListening(board, { now, running })) return 'listening';
  const session = board.owner?.session;
  const wake = routeRecord(wakes, board.route);
  if (!session || !board.owner.repo || wake?.error || wake?.pushed_at) return 'deaf';
  if (wake?.resumed_at) return 'waking';
  return running.has(session) ? 'deaf' : 'asleep';
}

const cursorPath = (board, session) => path.join(board.dir, 'data', `.watch-cursor-${session}.json`);
const cursorFile = (board) => cursorPath(board, board.owner.session);
export function watcherCursor(board) {
  const cursor = board.owner?.session ? readJSON(cursorFile(board), {}) : {};
  return Object.fromEntries(board.watch.map((file) => {
    const count = routeRecord(cursor, file);
    return [file, Number.isSafeInteger(count) && count >= 0 ? count : 0];
  }));
}
// How many watched lines each of the board's watched files holds: {<file>: count}, as a watcher cursor counts them.
export const watchedCounts = (board) => Object.fromEntries(Object.entries(watchedLines(board)).map(([f, l]) => [f, l.length]));

// Gives session `to` the watcher cursor of session `from`, wound back to mark ({<file>: count}) where it is past it, so
// to's first watcher prints every line since mark: a watcher left running after its session stopped may have printed
// those to nobody. With no cursor for from, mark is the cursor.
export function carryCursor(board, { from, to = from, mark = null }) {
  const cursor = readJSON(cursorPath(board, from), null);
  if (!cursor && !mark) return;
  const next = Object.assign(Object.create(null), cursor);
  for (const [f, n] of Object.entries(mark || {})) next[f] = Math.min(routeRecord(next, f) ?? n, n);
  saveJSON(cursorPath(board, to), next);
}
// The board's watched lines, per file, as bin/wait-events.mjs counts them: its manifest `watch` files, `filter` applied.
export function watchedLines(board) {
  const re = board.filter ? new RegExp(board.filter) : null;
  return Object.fromEntries(board.watch.map((f) => {
    let lines = [];
    try { lines = fs.readFileSync(path.resolve(board.dir, f), 'utf8').split('\n').filter(Boolean); } catch {}
    return [f, re ? lines.filter((l) => re.test(l)) : lines];
  }));
}

// The time of the oldest line the owning session's watcher hasn't printed: past the counts in its cursor,
// data/.watch-cursor-<session>.json. With no cursor the session never ran a watcher, so every line since it took the
// site waits. → ISO time, or null when nothing waits or the board has no owner.
export function oldestUnheard(board) {
  if (!board.owner?.session) return null;
  const cursor = readJSON(cursorFile(board), null);
  const from = cursor ? 0 : Date.parse(board.owner.since || '') || 0;
  let oldest = null;
  for (const [f, lines] of Object.entries(watchedLines(board))) {
    for (const line of cursor ? lines.slice(routeRecord(cursor, f) || 0) : lines) {
      let ts = null;
      try { ts = JSON.parse(line).ts; } catch {}
      const t = Date.parse(ts);
      if (Number.isNaN(t) || t < from) continue;
      if (!oldest || t < Date.parse(oldest)) oldest = ts;
    }
  }
  return oldest;
}

// One push per board per outage when an event has waited DEAF_AFTER while the board is deaf (listenState); an asleep or
// waking board waits for the hub's wake, which pushes on its own when it fails. Its listening again ends the outage (~/.claude/kickflip/deaf-state.json {<route>: {at, since}}). The hub runs it after each
// GitHub check. → {pushed: [route], failed: [message]}
export async function checkListening({ manifest, now = new Date(), running = liveSessions() } = {}) {
  const state = Object.assign(Object.create(null), readJSON(DEAF_STATE, {}));
  const pushed = [];
  const failed = [];
  let dirty = false;
  const wakes = readJSON(RESUME_STATE, {});
  for (const board of listBoards(manifest)) {
    const listen = listenState(board, { now: now.getTime(), running, wakes });
    if (listen === 'listening') {
      if (routeRecord(state, board.route)) { delete state[board.route]; dirty = true; }
      continue;
    }
    if (listen === 'asleep' || listen === 'waking' || routeRecord(state, board.route)) continue;
    const since = oldestUnheard(board);
    if (!since || now - Date.parse(since) < DEAF_AFTER) continue;
    const minutes = Math.round((now - Date.parse(since)) / 60_000);
    const why = running.has(board.owner.session) ? "no watcher runs. Relaunch it in the board's session." : "its session isn't running, and the hub can't wake it.";
    try {
      await deliver({ title: `${board.title} isn't listening`, body: `An event has waited ${minutes} min and ${why}`, url: `/${board.route}/`, tag: `deaf-${board.route}` }, { kind: 'fault', immediate: true, at: now });
      state[board.route] = { at: now.toISOString(), since };
      dirty = true;
      pushed.push(board.route);
    } catch (e) { failed.push(`${board.route}: could not push that it isn't listening (${e.message})`); }
  }
  if (dirty) saveJSON(DEAF_STATE, state);
  return { pushed, failed };
}

// ---------- handshake ----------
// data/handshake.json {hello: {id, at, session}, ack: {id, at} | null, done_at?}: board/store.mjs
// ackHello records the session's answer, and the board shows its setup checklist until that and the GitHub link pass.
export const handshakeFile = (dir) => path.join(dir, 'data', 'handshake.json');

// A new board's test of its links: a `hello` event its session's watcher answers (bin/wait-events.mjs). The owner's
// watcher cursor is set first when the session has none, so its first watcher prints the hello rather than starting
// past it. → {route, hello}
export async function handshake(route, manifest = readManifest()) {
  const board = listBoards(manifest).find((b) => b.route === route);
  if (!board) throw new Error(`/${route} is not a board site in the manifest`);
  if (board.owner?.session && !fs.existsSync(cursorFile(board))) {
    saveJSON(cursorFile(board), Object.fromEntries(Object.entries(watchedLines(board)).map(([f, l]) => [f, l.length])));
  }
  const hello = { id: await appendEvent(board, 'hello', { title: board.title }), at: new Date().toISOString(), session: board.owner?.session || null };
  saveJSON(handshakeFile(board.dir), { hello, ack: null });
  return { route, hello: hello.id };
}

// ---------- links ----------
export const LINKS = ['github', 'repo-fetch', 'events', 'wakes', 'push', 'slack'];

// A board on another git remote has no PRs, so nothing to poll (docs/adr/0127-a-board-can-work-on-any-git-remote.md).
function githubLink(board, state) {
  if (board.remote) return null;
  const last = state?.lastCheck;
  if (!last?.at) return { link: 'github', ok: false, detail: "The hub hasn't checked GitHub yet." };
  const missed = board.prs.filter((p) => state.prs?.[prKey(p)]?.at !== last.at).map((p) => `#${p.pr}`);
  if (missed.length) return { link: 'github', ok: false, detail: `${[...new Set(missed)].join(', ')} missed the last check.` };
  if (!(last.boards || []).includes(board.route)) return { link: 'github', ok: false, detail: "The last check didn't reach this board." };
  const n = new Set(board.prs.map(prKey)).size;
  return { link: 'github', ok: true, detail: n ? `${plural(n, 'open PR')}, all in the last check.` : 'No open PRs; the last check reached this board.' };
}

// fetch is the board's REPO_FETCH record (try.mjs fetchTryBranches), absent for a board the hub doesn't fetch.
function repoFetchLink(fetch) {
  if (!fetch) return null;
  if (fetch.ok) return { link: 'repo-fetch', ok: true, detail: "The hub's last git fetch of this board's repo worked." };
  return { link: 'repo-fetch', ok: false, detail: `${fetch.error.replace(/[.\s]*$/, '.')} ${fetch.hint}.` };
}

const EVENTS = {
  listening: { ok: true, detail: 'Its session and a watcher are running.' },
  waking: { ok: true, detail: 'Waking: the hub resumed its session, which listens again once it rejoins.' },
  asleep: { ok: true, detail: 'Asleep: its session idled out, and the hub wakes it on the next event or a tap on its page.' },
  deaf: { ok: false, detail: "Not listening: its session or its watcher isn't running, and the hub can't wake it, so events wait." },
};
const eventsLink = (listen) => ({ link: 'events', listen, ...EVENTS[listen] });

function wakesLink(board, settings, wakeState) {
  const wakes = settings?.wakes || [];
  if (!wakes.length) return { link: 'wakes', ok: false, detail: 'No daily wakes are set (Hub, Polling).' };
  if ((wakeState?.last?.failed || []).includes(board.route)) return { link: 'wakes', ok: false, detail: `The last wake (${wakeState.last.due.join(', ')}) couldn't reach this board.` };
  return { link: 'wakes', ok: true, detail: `Daily at ${wakes.join(', ')}.` };
}

const pushLink = (devices) => (devices
  ? { link: 'push', ok: true, detail: `${plural(devices, 'device')} subscribed.` }
  : { link: 'push', ok: false, detail: 'No device has turned on notifications.' });

function slackLink(board, state, topics) {
  const missing = [];
  let inReview = 0;
  for (const p of board.prs) {
    const s = state?.prs?.[prKey(p)];
    if (s?.state !== 'OPEN' || s.isDraft) continue;
    inReview++;
    const { wave } = board.waves.find((w) => w.slug === p.wave);
    const item = wave.items.find((it) => it.id === p.id);
    const links = reviewLinks(wave, item, `${p.wave}/${p.id}`, topics);
    const lacking = [...new Set([...board.reviewers, ...names(wave.reviewers)])].filter((n) => !Object.hasOwn(links, n));
    if (lacking.length) missing.push(`#${p.pr} has no link for ${lacking.join(', ')}`);
  }
  if (missing.length) return { link: 'slack', ok: false, detail: `${missing.join('; ')}.` };
  return { link: 'slack', ok: true, detail: inReview ? `Every reviewer has the link to ${plural(inReview, 'PR')} in review.` : 'No PR is in review.' };
}

// ---------- hub code ----------
// The code the hub runs: hub/hub.mjs and every file it imports by a relative path, followed through the skill.
// → {hash, files: [path from the skill dir]}. entry points elsewhere only in tests.
const RELATIVE_IMPORT = /\b(?:from|import)\s*['"](\.\.?\/[^'"]+)['"]/g;
export function hubCode(entry = path.join(SKILL_DIR, 'hub', 'hub.mjs')) {
  const root = path.dirname(path.dirname(entry));
  const seen = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    let src;
    try { src = fs.readFileSync(file); } catch { return; }
    seen.set(file, src);
    for (const m of src.toString('utf8').matchAll(RELATIVE_IMPORT)) visit(path.resolve(path.dirname(file), m[1]));
  };
  visit(entry);
  const files = [...seen.keys()].map((f) => path.relative(root, f)).sort();
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(f).update('\0').update(seen.get(path.join(root, f))).update('\0');
  return { hash: h.digest('hex').slice(0, 12), files };
}

// Run by the hub as it starts, so the hub link can tell when its files changed under it. → {hash, files, pid, at}
export function recordHubCode() {
  const code = { ...hubCode(), pid: process.pid, at: new Date().toISOString() };
  saveJSON(HUB_CODE, code);
  return code;
}

const RESTART_HUB = hubService().restartCommand;
export const runningHubCode = () => readJSON(HUB_CODE, null)?.hash ?? null;
export const hubCodeState = () => ({ running: runningHubCode(), onDisk: hubCode().hash });
// The hub's own link, so linksOf leaves it out (docs/adr/0064-every-builder-works-in-a-worktree.md).
// → {link: 'hub', ok, detail}
export const hubLink = ({ running, onDisk } = hubCodeState()) => (running && running === onDisk
  ? { link: 'hub', ok: true, detail: `The hub runs the code in its files (${onDisk}).` }
  : { link: 'hub', ok: false, detail: `The hub runs older code than its files; restart it with ${RESTART_HUB}` });

// ---------- grace ----------
// How long a link stays broken before the board shows it red; until then it reads settling, while the watcher prints
// it at once so the session can fix it (docs/adr/0046-hub-links-turn-red-only-after-a-grace-period.md). every is the
// polling interval's minutes.
const MIN = 60_000;
export const GRACE = {
  github: (every) => (every + 10) * MIN,
  'repo-fetch': (every) => (every + 10) * MIN,
  events: () => 2 * MIN,
  wakes: (every) => (every + 10) * MIN,
  push: () => 0,
  slack: (every) => (every + 10) * MIN,
};

// The longer of the polling window when the fault began and the window now, so a fault from a slow window doesn't
// turn red when a faster one starts before its next check.
function everyFor(since, now, settings) {
  const s = settings?.windows?.length ? settings : DEFAULTS;
  return Math.max(windowAt(new Date(since), s).every_minutes, windowAt(new Date(now), s).every_minutes);
}

// Adds state ('ok' | 'settling' | 'broken') and, for a fault, since: when it was first seen, from faults
// ({<link>: ISO time}), or ~/.claude/kickflip/link-faults.json {<route>: {<link>: ISO time}} when faults is undefined,
// which this then updates.
function settle(route, links, { settings, now, faults }) {
  const stored = faults === undefined;
  const known = stored ? routeRecord(readJSON(LINK_FAULTS, {}), route) || {} : faults;
  const open = {};
  const out = links.map((l) => {
    if (l.ok) return { ...l, state: 'ok' };
    const since = routeRecord(known, l.link) || new Date(now).toISOString();
    open[l.link] = since;
    const grace = GRACE[l.link](everyFor(Date.parse(since), now, settings));
    return { ...l, state: now - Date.parse(since) >= grace ? 'broken' : 'settling', since };
  });
  if (stored && JSON.stringify(open) !== JSON.stringify(known)) {
    const all = Object.assign(Object.create(null), readJSON(LINK_FAULTS, {}));
    if (Object.keys(open).length) all[route] = open; else delete all[route];
    try { saveJSON(LINK_FAULTS, all); } catch {}
  }
  return out;
}

// Whether each hub link reaches the board → [{link, ok, detail, state, since?}] in LINKS order. ok is the link's
// state now; state is what the board shows, broken only once ok has stayed false past the link's GRACE.
//   github      every open PR on a card was in the hub's last check, and that check reached the board; a board on
//               another git remote has none
//   repo-fetch  the hub's last git fetch of the board's repo worked; only a board the hub fetches has it
//   events      the board is listening, waking or asleep (listenState, as the link's listen), so its events reach the session
//   wakes       the polling interval has daily wakes, and the last one reached the board
//   push        at least one device is subscribed
//   slack       every open, non-draft PR has a Slack link for each of the board's and its wave's reviewers
// ctx overrides what is read from disk: github (github-state.json), fetches (repo-fetch.json), settings (polling),
// wakes (wake-state.json), devices (subscription count), listen (listenState), topics (slack-bridge topic items),
// faults (as settle takes them; given, nothing is written) and now (ms).
export function linksOf(board, ctx = {}) {
  const state = ctx.github ?? readJSON(GITHUB_STATE, {});
  const settings = ctx.settings ?? readSettings();
  const links = [
    githubLink(board, state),
    repoFetchLink(routeRecord(ctx.fetches ?? readJSON(REPO_FETCH, {}), board.route)),
    eventsLink(ctx.listen ?? listenState(board)),
    wakesLink(board, settings, ctx.wakes ?? readJSON(WAKE_STATE, {})),
    pushLink(ctx.devices ?? (readJSON(SUBS, []) || []).length),
    slackLink(board, state, ctx.topics ?? topicItems()),
  ].filter(Boolean);
  return settle(board.route, links, { settings, now: ctx.now ?? Date.now(), faults: ctx.faults });
}

// Brings link-faults.json up to date for every board, so a fault no page or watcher looked at still dates from the
// poll that first saw it. The hub runs it after each poll.
export function recordLinkFaults(manifest) {
  const ctx = { running: liveSessions(), wakes: readJSON(RESUME_STATE, {}) };
  for (const board of listBoards(manifest)) linksOf(board, { listen: listenState(board, ctx) });
}
