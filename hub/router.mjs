// docs/adr/2026-11-12-2345-a-haiku-router-files-each-incoming-request-on-a-board.md
// docs/adr/2026-11-21-2300-each-board-takes-a-routed-ask-or-passes-it-down-haikus-ranking.md
// The hub's router: an incoming request that names no board (a Slack @kickflip, T-228, the hub's New task box, or a
// `kickflip handoff` with no board) goes down a ranking of the boards it may fit. One `claude -p --model haiku` call per
// request, with no tools, reads each board's route, title, manifest description and its 15 most recently changed open
// card titles, and ranks the boards that may fit, best first, each with a reason. The request is filed on the first as
// an ask with `routed {reason, via, by, link, slack, at, id, next}`, id the request's and next the rest of the ranking;
// the board's thread draws it as a status line above the ask (domain.mjs), and routed-log.mjs keeps it for the hub
// page's New rows. Its orchestrator takes it at triage, or passes it on with `ask move <id> --next "<why>"`
// (board/asks.mjs passAsk), which files it on the next board in next. Past the last, it comes back to the hub unplaced,
// and Haiku answers it itself (answerUnplaced), on its New row and in its Slack thread when it came from Slack; the
// owner can still put it on a board from the row (placeRow). With one board there is no call.
// Every request waits in ~/.claude/kickflip/route-queue.json until it is routed: while usage is paused it stays there,
// and the hub's 15-second tick routes it once the pause lifts. A failed call keeps it there with its error for the next
// tick; after ROUTE_TRIES it goes down the boards in manifest order, the first reason saying why.
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
import { copyUpload } from '../board/asks.mjs';
import { ROUTED_LOG, changeEntry, changeRouted, readRouted } from './routed-log.mjs';
import { savedSlack } from './slack.mjs';
import { CLAUDE_PREFIX } from './pr-report.mjs';

export { ROUTED_LOG };

const WEB = path.join(os.homedir(), '.claude', 'kickflip');
// The hub's own site for uploads: the hub page's New task box uploads here, before any board is picked, and filing copies
// each file to the board.
const UPLOAD_HOME = WEB;
export const ROUTE_QUEUE = path.join(WEB, 'route-queue.json');
// The ids of the New rows the owner dismissed, oldest first, kept in the hub so every device sees the same strip.
export const ROUTED_DISMISSED = path.join(WEB, 'routed-dismissed.json');
const KEEP_DISMISSED = 500;
export const ROUTE_TRIES = 3;
const RECENT = 15;
// A routed status line holds at most 100 characters (board/hub-lines.mjs), "Routed here from Slack: " among them.
const REASON_LIMIT = 76;
// Haiku's answer to an ask no board took: a short reply on the hub's New row and in a Slack thread.
const ANSWER_LIMIT = 700;
// Why a placed ask is on its board, on its routed line.
const PLACED = 'you put it here after no board took it';

// Each board as the router reads it: {board, route, title, description, recent: its RECENT most recently changed open card titles}.
export function routingBoards(manifest = readManifest()) {
  return listBoards(manifest).map((board) => ({
    board, route: board.route, title: board.title, description: String(manifest.sites?.[board.route]?.description || '').trim(),
    recent: board.files.flatMap((f) => f.itemFile.items).filter((it) => it && it.lane !== 'done' && it.title)
      .sort((a, b) => String(b.lane_at || b.created || '').localeCompare(String(a.lane_at || a.created || '')))
      .slice(0, RECENT).map((it) => String(it.title)),
  }));
}

// The boards as text, for the router's prompt and for a session choosing its own board (kickflip handoff with no objective).
export function boardsListing(boards) {
  return boards.map((b) => `/${b.route} · ${b.title}\nDescription: ${b.description || 'none'}\nRecent open tasks:${b.recent.length ? b.recent.map((t) => `\n- ${t}`).join('') : ' none'}`).join('\n\n');
}

export function routePrompt(text, boards) {
  const listed = boardsListing(boards);
  return `You route one incoming request to the boards whose work it may belong to. You only rank the boards; you don't answer the request.

The boards:

${listed}

The request:
<request>
${text}
</request>

Rank the boards the request could belong to, best fit first: each board's orchestrator in turn takes it or passes it to the next. Leave out a board it clearly doesn't belong to, but always rank at least one. Give each its route, without its slash, and a reason of at most ${REASON_LIMIT} characters a person reads to see why it went there.`;
}

const RANKING = { type: 'object', properties: { ranking: { type: 'array', items: { type: 'object', properties: { route: { type: 'string' }, reason: { type: 'string' } }, required: ['route', 'reason'], additionalProperties: false } } }, required: ['ranking'], additionalProperties: false };
const ANSWER = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };

// One Haiku call with no tools and no session kept, its answer shaped by schema. → its structured answer
export async function askHaiku(prompt, { schema = RANKING, timeout = 120_000 } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !inherited(k)));
  const { stdout } = await promisify(execFile)(claudeBin(), ['-p', prompt, '--model', 'haiku', '--output-format', 'json', '--tools', '',
    '--json-schema', JSON.stringify(schema), '--no-session-persistence'], { env, cwd: os.tmpdir(), timeout, maxBuffer: 4 << 20 });
  const out = JSON.parse(stdout);
  if (out.is_error) throw new Error(String(out.result || 'claude -p failed'));
  return out.structured_output ?? JSON.parse(out.result);
}

const cut = (words, limit) => (words.length > limit ? `${words.slice(0, limit - 1).trimEnd()}…` : words);

// Haiku's ranking, checked: routes among routes, each once, each with a reason on one line; an unknown route drops.
// → [{route, reason}], best first
export function parseRanking(answer, routes) {
  if (!Array.isArray(answer?.ranking)) throw new Error('the router gave no answer');
  const ranking = [];
  const unknown = [];
  for (const r of answer.ranking) {
    const route = String(r?.route || '').trim().replace(/^\/+|\/+$/g, '');
    const reason = String(r?.reason || '').replace(/\s+/g, ' ').trim();
    if (!routes.includes(route)) unknown.push(`/${route}`);
    else if (reason && !ranking.some((x) => x.route === route)) ranking.push({ route, reason: cut(reason, REASON_LIMIT) });
  }
  if (!ranking.length) throw new Error(unknown.length ? `the router named ${unknown.join(', ')}, which isn't a board` : 'the router ranked no board');
  return ranking;
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

// Files req on board as an ask carrying `routed`, next the boards ranked after it, logs it for the hub page and takes it
// off the queue. → its routed.json entry
async function file(req, board, reason, next) {
  const at = new Date().toISOString();
  const { via, by, link, slack } = req.from;
  // appendEvent throws only when the board may already have the ask, so the request leaves the queue either way and is
  // never filed twice (docs/adr/2026-11-05-0820-a-hub-event-a-board-took-is-never-written-twice.md). A Slack request's
  // slack {channel, thread_ts, ts} names the thread it came from
  // (docs/adr/2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md).
  const files = await Promise.all((req.files || []).map((f) => copyUpload(UPLOAD_HOME, board.dir, f)));
  const eventId = await appendEvent(board, 'ask', { text: req.text, ...(files.length ? { files } : {}), ...req.fields, routed: { reason, via, by, ...(link ? { link } : {}), ...(slack ? { slack } : {}), at, id: req.id, next } })
    .finally(() => changeQueue((queue) => queue.filter((q) => q.id !== req.id)));
  await Promise.all((req.files || []).map(dropUpload));
  const entry = { id: req.id, at, text: req.text, via, by, ...(link ? { link } : {}), ...(slack ? { slack } : {}), route: board.route, eventId, reason };
  await changeRouted((entries) => [...entries, entry]);
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
    let ranking;
    try {
      ranking = boards.length === 1 ? [{ route: boards[0].route, reason: 'the only board' }]
        : parseRanking(await ask(routePrompt(req.text, boards)), boards.map((b) => b.route));
    } catch (e) {
      const tries = (req.tries || 0) + 1;
      if (tries < ROUTE_TRIES) { await changeQueue((q) => q.map((x) => (x.id === req.id ? { ...x, tries, error: e.message } : x))); continue; }
      ranking = boards.map((b, i) => ({ route: b.route, reason: i ? 'the next board in the manifest' : `the router failed (${e.message}), so it went to the first board`.slice(0, REASON_LIMIT) }));
    }
    const [first, ...next] = ranking;
    try { routed.push(await file(req, boards.find((b) => b.route === first.route).board, first.reason, next)); }
    catch (e) { failed.push(`/${first.route}: ${e.message}`); }
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
// A request with a sendId (the hub page's outbox, board/public/view-hub.js) takes it as its id, and one already queued or
// routed under it is not queued again, so a resend never files a task twice.
export async function queueRequest(request) {
  const req = { id: request.sendId || crypto.randomUUID(), at: new Date().toISOString(), text: String(request.text), ...(request.files?.length ? { files: request.files } : {}), ...(request.fields ? { fields: request.fields } : {}), from: request.from, tries: 0 };
  const had = (queue) => queue.some((q) => q.id === req.id) || readRouted().some((r) => r.id === req.id);
  await changeQueue((queue) => (request.sendId && had(queue) ? queue : [...queue, req]));
  return req;
}

// An incoming request, queued, then routed at once unless usage is paused. → drainRoutes' answer
export async function routeRequest(request, opts = {}) {
  await queueRequest(request);
  return drainRoutes(opts);
}

export function answerPrompt(text, passed) {
  return `Every board the request below was sent to passed it on, so you answer it yourself. You have no tools and can't read any repo or board: answer from what you know, in plain words, at most ${ANSWER_LIMIT} characters. If it needs work on one of the boards, say so in a sentence; the person can still put it on a board.

The boards that passed it, and why:
${passed.map((p) => `- /${p.route}: ${p.reason}`).join('\n') || '- none'}

The request:
<request>
${text}
</request>`;
}

// Haiku answers each ask every board passed (an unplaced entry with no answer), once, unless usage is paused: the answer
// goes on its New row, and into its Slack thread when it came from Slack, "🤖 " first as the orchestrator's replies are
// (slack-intake.mjs postSlackReplies). A failed call is tried again each tick, up to ROUTE_TRIES; a failed Slack post
// keeps the answer with why, and isn't tried again. → {answered: [request ids], failed: [why]}
export async function answerUnplaced({ ask = askHaiku, paused = () => readUsageGate().state === 'paused', slack = savedSlack } = {}) {
  const answered = [];
  const failed = [];
  if (paused()) return { answered, failed };
  for (const e of readRouted().filter((r) => r.unplaced && !r.answer && (r.answerTries || 0) < ROUTE_TRIES)) {
    let text;
    try {
      text = cut(String((await ask(answerPrompt(e.text, e.passed || []), { schema: ANSWER }))?.answer || '').trim(), ANSWER_LIMIT);
      if (!text) throw new Error('the router gave no answer');
    } catch (err) {
      failed.push(`${e.id}: ${err.message}`);
      await changeEntry(e.id, (x) => ({ ...x, answerTries: (x.answerTries || 0) + 1, answerError: err.message }));
      continue;
    }
    const answer = { text, at: new Date().toISOString() };
    if (e.slack) {
      try {
        const client = slack() || (() => { throw new Error('the hub has no Slack token'); })();
        answer.slack = await client.post({ channel: e.slack.channel, thread_ts: e.slack.thread_ts, text: `${CLAUDE_PREFIX}${text}` });
      } catch (err) { answer.slackError = err.message; }
    }
    await changeEntry(e.id, (x) => ({ ...x, answer }));
    answered.push(e.id);
  }
  return { answered, failed };
}

const refused = (status, message) => Object.assign(new Error(message), { status });
// The owner puts request id's ask, which no board took, on the board at route: filed there as an ask with its words,
// intent and files from the last board's copy, its routed line naming the owner, and its row placed.
export async function placeRow(id, route, { manifest = readManifest() } = {}) {
  const boards = listBoards(manifest);
  const entry = readRouted().find((e) => e.id === id);
  if (!entry?.unplaced) throw refused(409, "that row isn't waiting for a board");
  const target = boards.find((b) => b.route === route);
  if (!target) throw refused(404, `no board at /${route} in the hub's manifest`);
  const last = boards.find((b) => b.route === entry.route);
  const data = (last && (await readEvents(path.join(last.dir, 'data', 'events.jsonl'))).find((e) => e.id === entry.eventId && e.kind === 'ask')?.data) || {};
  const files = await Promise.all((data.files || []).map((f) => copyUpload(last.dir, target.dir, f)));
  const { passed: _, ...routed } = data.routed || { via: entry.via, by: entry.by, id };
  const intent = Object.fromEntries(['request', 'quick'].filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
  const eventId = await appendEvent(target, 'ask', { text: data.text || entry.text, ...(files.length ? { files } : {}), ...intent, routed: { ...routed, reason: PLACED, at: new Date().toISOString(), next: [] } });
  await changeEntry(id, ({ unplaced: _u, ...e }) => ({ ...e, route, eventId, reason: PLACED, placed: true }));
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
async function movedTo(board, eventId, boards) {
  const lines = parseLines(await fs.promises.readFile(path.join(board.dir, 'data', 'threads', `ask__${eventId}.jsonl`), 'utf8').catch(() => ''));
  const link = lines.find((m) => m.line === 'ask-moved')?.link;
  const m = /^\/([^/]+)\/#selectedCard=ask%3A(.+)$/.exec(link || '');
  const there = m && boards.find((b) => b.route === m[1]);
  return there ? cardOf(there, decodeURIComponent(m[2])) : null;
}
const parseLines = (text) => text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

// Each board's events file as parsed lines, read once and then only what was appended: the file only grows, so a read
// takes the bytes past the last whole line it parsed. A file that shrank or was replaced (another inode) is read afresh.
// Reads of one file queue, so none parses the same bytes twice.
const eventTails = new Map();
const eventReads = new Map();
async function tailEvents(file) {
  const fh = await fs.promises.open(file).catch(() => null);
  if (!fh) { eventTails.delete(file); return []; }
  try {
    const st = await fh.stat({ bigint: true });
    let tail = eventTails.get(file);
    if (!tail || tail.ino !== st.ino || tail.birth !== st.birthtimeNs || st.size < tail.offset) tail = { ino: st.ino, birth: st.birthtimeNs, offset: 0n, lines: [] };
    if (st.size > tail.offset) {
      const buf = Buffer.alloc(Number(st.size - tail.offset));
      const { bytesRead } = await fh.read(buf, 0, buf.length, tail.offset);
      const whole = buf.subarray(0, bytesRead).lastIndexOf(10) + 1;
      tail.lines.push(...parseLines(buf.toString('utf8', 0, whole)));
      tail.offset += BigInt(whole);
    }
    eventTails.set(file, tail);
    return tail.lines;
  } finally { await fh.close(); }
}
function readEvents(file) {
  const run = (eventReads.get(file) || Promise.resolve()).then(() => tailEvents(file));
  eventReads.set(file, run.catch(() => {}));
  return run;
}

// The asks other boards put to board (domain.mjs boardAsksOf over its events), as hub rows {id, at, text, asked: {from,
// to: {route, href}, answered: {at, href} | null}}: href is the asking card, where the answer landed as a message.
async function askedRows(board, boards) {
  return boardAsksOf(await readEvents(path.join(board.dir, 'data', 'events.jsonl'))).map((a) => {
    const asker = boards.find((b) => b.route === a.from.route);
    const answered = a.answer && { at: a.answer.at, href: a.from.key && asker ? cardHref(a.from.route, a.from.key) : null };
    return { id: a.id, at: a.at, text: a.text, asked: { from: a.from, to: { route: board.route, href: cardHref(board.route, `ask:${a.id}`) }, answered: answered || null } };
  });
}

// Hides row id from the hub page's New rows for good (the X on a routed row, or following its link).
export async function dismissRow(id) {
  await withFileLock(ROUTED_DISMISSED, () => {
    const { dismissed } = readJSON(ROUTED_DISMISSED, { dismissed: [] });
    if (!dismissed.includes(id)) saveJSON(ROUTED_DISMISSED, { dismissed: [...dismissed, id].slice(-KEEP_DISMISSED) });
  });
}

// Whether board's orchestrator has taken ask eventId: the card it became has left New (a lane past Todo or a phase
// set), or it was folded into another card. An ask the owner deleted counts as taken, so its row never reads trying.
async function taken(board, eventId, events) {
  const it = board.files.flatMap((f) => f.itemFile.items).find((i) => i?.from_ask === eventId);
  if (it) return (it.lane || 'todo') !== 'todo' || Boolean(it.phase);
  return typeof readJSON(path.join(board.dir, 'data', 'ask-links.json'), {}).links?.[eventId] === 'string'
    || (await events()).some((e) => e.kind === 'ask-withdrawn' && e.data?.id === eventId);
}

// The hub page's New rows, newest first: each queued request, waiting, then each routed one with `to`, the card it
// became, `moved`, where a later `ask move --to` sent it, passed, the boards that passed it, and trying while the board
// it's on hasn't taken it; one every board passed is unplaced, with Haiku's answer (or why it has none) and places, the
// boards the owner can put it on, and one the owner put on a board is placed. Then each ask another board put to a
// board, queued or answered, less the rows dismissRow hid.
export async function routedRows({ manifest = readManifest() } = {}) {
  const boards = listBoards(manifest);
  const events = (board) => () => readEvents(path.join(board.dir, 'data', 'events.jsonl'));
  const waiting = readJSON(ROUTE_QUEUE, { queue: [] }).queue.map((q) => ({ id: q.id, at: q.at, text: q.text, via: q.from?.via, by: q.from?.by, waiting: true }));
  const routed = await Promise.all(readRouted().map(async (r) => {
    const board = boards.find((b) => b.route === r.route);
    const row = { id: r.id, at: r.at, text: r.text, via: r.via, by: r.by, ...(r.link ? { link: r.link } : {}), reason: r.reason,
      to: board ? cardOf(board, r.eventId) : { route: r.route, ref: null, title: null, href: `/${r.route}/` }, ...(r.passed?.length ? { passed: r.passed } : {}) };
    if (r.unplaced) {
      const answer = r.answer ? { text: r.answer.text, at: r.answer.at, slack: Boolean(r.answer.slack), ...(r.answer.slackError ? { slackError: r.answer.slackError } : {}) } : null;
      return { ...row, unplaced: true, answer, ...(!answer && r.answerTries >= ROUTE_TRIES ? { answerError: r.answerError } : {}), places: boards.map((b) => ({ route: b.route, title: b.title })) };
    }
    if (r.placed) return { ...row, placed: true };
    const moved = board && await movedTo(board, r.eventId, boards);
    if (moved) return { ...row, moved };
    return board && !(await taken(board, r.eventId, events(board))) ? { ...row, trying: true } : row;
  }));
  const dismissed = new Set(readJSON(ROUTED_DISMISSED, { dismissed: [] }).dismissed);
  return [...waiting, ...routed, ...(await Promise.all(boards.map((b) => askedRows(b, boards)))).flat()].filter((r) => !dismissed.has(r.id)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
