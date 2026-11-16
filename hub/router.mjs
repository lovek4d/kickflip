// docs/adr/2026-11-12-2345-a-haiku-router-files-each-incoming-request-on-a-board.md
// The hub's router: an incoming request that names no board (a Slack @kickflip, T-228, or a `kickflip handoff` with no
// board) goes to the board it fits. One
// `claude -p --model haiku` call per request, with no tools, reads each board's route, title, manifest description and
// its 15 most recently changed open card titles, and answers {route, reason}. The request is filed there as an ask with
// `routed {reason, via, by, link, at}`, which the board's thread draws as a status line above the ask (domain.mjs), and
// the hub keeps it in ~/.claude/kickflip/routed.json for the hub page's Routed section. It only routes: the board's
// orchestrator sorts, discusses and builds the ask as any other. It always files on its best guess and learns nothing
// from a later `ask move`. With one board there is no call.
// Every request waits in ~/.claude/kickflip/route-queue.json until it is routed: while usage is paused it stays there,
// and the hub's 15-second tick routes it once the pause lifts. A failed call keeps it there with its error for the next
// tick; after ROUTE_TRIES it goes to the first board in the manifest, the reason saying why.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendEvent, listBoards, readJSON, readManifest, saveJSON } from './boards.mjs';
import { withFileLock } from './locks.mjs';
import { claudeBin, inherited } from './sessions.mjs';
import { readUsageGate } from '../shared/usage-gate.mjs';
import { boardAsksOf, refOf } from '../board/domain.mjs';
import { copyUpload } from '../board/store.mjs';

const WEB = path.join(os.homedir(), '.claude', 'kickflip');
// The hub's own site for uploads: the hub page's New task box uploads here, before any board is picked, and filing copies
// each file to the board.
const UPLOAD_HOME = WEB;
export const ROUTE_QUEUE = path.join(WEB, 'route-queue.json');
export const ROUTED_LOG = path.join(WEB, 'routed.json');
export const ROUTE_TRIES = 3;
const RECENT = 15;
// The hub page shows this many; the log keeps no more.
const KEEP = 30;
// A routed status line holds at most 100 characters (board/hub-lines.mjs), "Routed here from Slack: " among them.
const REASON_LIMIT = 76;

// Each board as the router reads it: {board, route, title, description, recent: its RECENT most recently changed open card titles}.
export function routingBoards(manifest = readManifest()) {
  return listBoards(manifest).map((board) => ({
    board, route: board.route, title: board.title, description: String(manifest.sites?.[board.route]?.description || '').trim(),
    recent: board.files.flatMap((f) => f.itemFile.items).filter((it) => it && it.lane !== 'done' && it.title)
      .sort((a, b) => String(b.lane_at || b.created || '').localeCompare(String(a.lane_at || a.created || '')))
      .slice(0, RECENT).map((it) => String(it.title)),
  }));
}

export function routePrompt(text, boards) {
  const listed = boards.map((b) => `/${b.route} · ${b.title}\nDescription: ${b.description || 'none'}\nRecent open tasks:${b.recent.length ? b.recent.map((t) => `\n- ${t}`).join('') : ' none'}`).join('\n\n');
  return `You route one incoming request to the board whose work it belongs to. You only pick the board; you don't answer the request.

The boards:

${listed}

The request:
<request>
${text}
</request>

Answer with the board's route, without its slash, and a reason of at most ${REASON_LIMIT} characters a person reads to see why it went there. Always pick the best fit, even when none fits well.`;
}

const SCHEMA = { type: 'object', properties: { route: { type: 'string' }, reason: { type: 'string' } }, required: ['route', 'reason'], additionalProperties: false };

// One Haiku call with no tools and no session kept. → its structured answer
export async function askHaiku(prompt, { timeout = 120_000 } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !inherited(k)));
  const { stdout } = await promisify(execFile)(claudeBin(), ['-p', prompt, '--model', 'haiku', '--output-format', 'json', '--tools', '',
    '--json-schema', JSON.stringify(SCHEMA), '--no-session-persistence'], { env, cwd: os.tmpdir(), timeout, maxBuffer: 4 << 20 });
  const out = JSON.parse(stdout);
  if (out.is_error) throw new Error(String(out.result || 'claude -p failed'));
  return out.structured_output ?? JSON.parse(out.result);
}

// Haiku's answer, checked: a route among routes and a reason on one line. → {route, reason}
export function parseRoute(answer, routes) {
  if (!answer || typeof answer !== 'object') throw new Error('the router gave no answer');
  const route = String(answer.route || '').trim().replace(/^\/+|\/+$/g, '');
  if (!routes.includes(route)) throw new Error(`the router named /${route}, which isn't a board`);
  const reason = String(answer.reason || '').replace(/\s+/g, ' ').trim();
  if (!reason) throw new Error('the router gave no reason');
  return { route, reason: reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT - 1).trimEnd()}…` : reason };
}

// The hub's copy of a request's upload, once the board has its own.
const dropUpload = async (f) => {
  const file = /^uploads\/(\d+-[\w.-]+)$/.exec(f.url || '')?.[1];
  if (!file) return;
  const dir = path.join(UPLOAD_HOME, 'data', 'uploads');
  await Promise.all([fs.promises.rm(path.join(dir, file), { force: true }), fs.promises.rm(path.join(dir, '.meta', `${file}.json`), { force: true })]);
};

const readQueue = () => readJSON(ROUTE_QUEUE, { queue: [] }).queue;
// The lock covers each change to the queue file, never a Haiku call, which outlasts its stale age.
const changeQueue = (fn) => withFileLock(ROUTE_QUEUE, () => saveJSON(ROUTE_QUEUE, { queue: fn(readQueue()) }));

// Files req on board as an ask carrying `routed`, logs it for the hub page and takes it off the queue. → its routed.json entry
async function file(req, board, reason) {
  const at = new Date().toISOString();
  const { via, by, link, slack } = req.from;
  // appendEvent throws only when the board may already have the ask, so the request leaves the queue either way and is
  // never filed twice (docs/adr/2026-11-05-0820-a-hub-event-a-board-took-is-never-written-twice.md). A Slack request's
  // slack {channel, thread_ts, ts} names the thread it came from
  // (docs/adr/2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md).
  const files = await Promise.all((req.files || []).map((f) => copyUpload(UPLOAD_HOME, board.dir, f)));
  const eventId = await appendEvent(board, 'ask', { text: req.text, ...(files.length ? { files } : {}), ...req.fields, routed: { reason, via, by, ...(link ? { link } : {}), ...(slack ? { slack } : {}), at } })
    .finally(() => changeQueue((queue) => queue.filter((q) => q.id !== req.id)));
  await Promise.all((req.files || []).map(dropUpload));
  const entry = { id: req.id, at, text: req.text, via, by, ...(link ? { link } : {}), route: board.route, eventId, reason };
  saveJSON(ROUTED_LOG, { routed: [...readJSON(ROUTED_LOG, { routed: [] }).routed, entry].slice(-KEEP) });
  return entry;
}

async function drain({ manifest, ask, paused }) {
  const queue = readQueue();
  if (!queue.length || paused()) return { routed: [], failed: [], waiting: queue.length };
  const boards = routingBoards(manifest);
  if (!boards.length) return { routed: [], failed: [], waiting: queue.length };
  const routed = [];
  const failed = [];
  for (const req of queue) {
    let pick;
    try {
      pick = boards.length === 1 ? { route: boards[0].route, reason: 'the only board' }
        : parseRoute(await ask(routePrompt(req.text, boards)), boards.map((b) => b.route));
    } catch (e) {
      const tries = (req.tries || 0) + 1;
      if (tries < ROUTE_TRIES) { await changeQueue((q) => q.map((x) => (x.id === req.id ? { ...x, tries, error: e.message } : x))); continue; }
      pick = { route: boards[0].route, reason: `the router failed (${e.message}), so it went to the first board`.slice(0, REASON_LIMIT) };
    }
    try { routed.push(await file(req, boards.find((b) => b.route === pick.route).board, pick.reason)); }
    catch (e) { failed.push(`/${pick.route}: ${e.message}`); }
  }
  return { routed, failed, waiting: readQueue().length };
}

// Routes each queued request in arrival order, unless usage is paused; one drain runs at a time, and a call while one
// runs waits for it, then drains again. A failed call stays queued with its error and one more try. → {routed: [the
// routed.json entries], failed: [why a filing failed], waiting: how many are still queued}
let draining = Promise.resolve();
export function drainRoutes({ manifest = readManifest(), ask = askHaiku, paused = () => readUsageGate().state === 'paused' } = {}) {
  const run = draining.catch(() => {}).then(() => drain({ manifest, ask, paused }));
  draining = run;
  return run;
}

// An incoming request {text, files?, fields?, from: {via, by, link?, slack?}} on the queue, for the next drain: the hub's tick
// when another process or the hub's poll queued it, as `kickflip handoff` with no board and Slack intake
// (slack-intake.mjs) do. → the queued request
export async function queueRequest(request) {
  const req = { id: crypto.randomUUID(), at: new Date().toISOString(), text: String(request.text), ...(request.files?.length ? { files: request.files } : {}), ...(request.fields ? { fields: request.fields } : {}), from: request.from, tries: 0 };
  await changeQueue((queue) => [...queue, req]);
  return req;
}

// An incoming request, queued, then routed at once unless usage is paused. → drainRoutes' answer
export async function routeRequest(request, opts = {}) {
  await queueRequest(request);
  return drainRoutes(opts);
}

const cardHref = (route, key) => `/${route}/#selectedCard=${encodeURIComponent(key)}`;
// The card ask eventId became on board, or the card it was folded into: {route, ref, title, href, into?}; with neither
// yet, a link to the ask.
function cardOf(board, eventId) {
  for (const { slug, itemFile } of board.files) {
    const it = itemFile.items.find((i) => i?.from_ask === eventId);
    if (it) return { route: board.route, ref: refOf(itemFile, it, board.tickets), title: it.title, href: cardHref(board.route, `${slug}/${it.id}`) };
  }
  const folded = readJSON(path.join(board.dir, 'data', 'ask-links.json'), {}).links?.[eventId];
  if (typeof folded === 'string') {
    const [slug, id] = folded.split('/');
    const f = board.files.find((x) => x.slug === slug);
    const it = f?.itemFile.items.find((i) => i?.id === id);
    if (it) return { route: board.route, ref: refOf(f.itemFile, it, board.tickets), title: it.title, href: cardHref(board.route, folded), into: true };
  }
  return { route: board.route, ref: null, title: null, href: cardHref(board.route, `ask:${eventId}`) };
}
// Where ask eventId on board was moved by `ask move` (its thread's ask-moved line), or null.
function movedTo(board, eventId, boards) {
  const lines = readLines(path.join(board.dir, 'data', 'threads', `ask__${eventId}.jsonl`));
  const link = lines.find((m) => m.line === 'ask-moved')?.link;
  const m = /^\/([^/]+)\/#selectedCard=ask%3A(.+)$/.exec(link || '');
  const there = m && boards.find((b) => b.route === m[1]);
  return there ? cardOf(there, decodeURIComponent(m[2])) : null;
}
function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; }
}

// The asks other boards put to board (domain.mjs boardAsksOf over its events), as hub rows {id, at, text, asked: {from,
// to: {route, href}, answered: {at, href} | null}}: href is the asking card, where the answer landed as a message.
function askedRows(board, boards) {
  return boardAsksOf(readLines(path.join(board.dir, 'data', 'events.jsonl'))).map((a) => {
    const asker = boards.find((b) => b.route === a.from.route);
    const answered = a.answer && { at: a.answer.at, href: a.from.key && asker ? cardHref(a.from.route, a.from.key) : null };
    return { id: a.id, at: a.at, text: a.text, asked: { from: a.from, to: { route: board.route, href: cardHref(board.route, `ask:${a.id}`) }, answered: answered || null } };
  });
}

// The hub page's New rows, newest first: each queued request, waiting, then each routed one with `to`, the card it
// became, and `moved`, where a later `ask move` sent it, and each ask another board put to a board, queued or answered.
export function routedRows({ manifest = readManifest() } = {}) {
  const boards = listBoards(manifest);
  const waiting = readJSON(ROUTE_QUEUE, { queue: [] }).queue.map((q) => ({ id: q.id, at: q.at, text: q.text, via: q.from?.via, by: q.from?.by, waiting: true }));
  const routed = readJSON(ROUTED_LOG, { routed: [] }).routed.map((r) => {
    const board = boards.find((b) => b.route === r.route);
    const moved = board && movedTo(board, r.eventId, boards);
    return { id: r.id, at: r.at, text: r.text, via: r.via, by: r.by, reason: r.reason, to: board ? cardOf(board, r.eventId) : { route: r.route, ref: null, title: null, href: `/${r.route}/` }, ...(moved ? { moved } : {}) };
  });
  return [...waiting, ...routed, ...boards.flatMap((b) => askedRows(b, boards))].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
