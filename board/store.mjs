// The board's data files and the only code that writes them, uploads included. A site is a directory under
// ~/.claude/kickflip/sites; `site` null means a board over ~/.claude/waves alone. Every write
// is validated first, JSON files are replaced by rename, and JSONL files are appended to.
import fs from 'node:fs/promises';
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { nodeBin } from '../bin/install.mjs';
import { gh, limitWords } from '../shared/gh.mjs';
import { cardTitleFault, cardTitleWords, squashBody, startTitleBrief, startTitleFault, subjectFault } from './commit-message.mjs';
import { fileURLToPath } from 'node:url';
import { BUILD_REFUSED, LOGGED_OUT_WORDS, BUILDER_ASK, SUMMARY_HINT, COMMANDS, LANDER, LANES, MOVE, PAUSE_CLEARS, PHASES, ITEM_EVENTS, SCRIPT_EVENTS, scriptStateOf, handedBackAt, MAX_IMPLEMENTERS, MAX_SERVES, builds, mergeBlockers, modelName, noTakePicked, IMPLEMENT_SKIPPED, ANSWERED, ownerQuestion, plans, PLANNER_WORD, providerOf, owesNext, pushTag, refOf, roundOf, roundSettledBy, HELPER, VISUAL, REVIEWER, beside, besideAgent, boardAsksOf, OWES_IMPLEMENT, markedState } from './domain.mjs';
import { githubStateFile, appendEvent, isBoardSite, isListening, listBoards, readManifest, samePath, withManifestLock, writeManifest } from '../hub/boards.mjs';
import { readUsageGate, pauseReason, pauseReasonFor, heldFor, holdsWork, builderPick, pauseEnd, boardClaudeModel, claudeModelFor } from '../shared/usage-gate.mjs';
import { reviseQueued, pushKindError, readClaudeModel, readLandTests, setLandTests, CLAUDE_MODEL_VALUES } from '../hub/push.mjs';
import { AT_RE } from '../hub/duration.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { ticketSource, ticketBadge, resolveTicket, ticketNamed, ticketTarget, moveTicket, cardIdOf } from './tickets.mjs';
import { LINEAR_NEEDS_KEY, linearStatus, linearWorks } from '../hub/linear.mjs';
import { validateBranch } from '../hub/repos.mjs';
import { withFileLock } from '../hub/locks.mjs';
import { audit, auditLines, boardAudit, readAudit } from '../shared/audit.mjs';
import { merge3 } from './merge3.mjs';
import { SCRIPT_LIMIT, runsAs, scriptLogName, scriptSha } from './scripts.mjs';
import { HUB, MESSAGE_LIMIT, BRIEF_LINE_LIMIT, hubLineOf, hubText, detailOf, lineFault } from './hub-lines.mjs';
import { fetchPR, prSize, reportOf, githubLogin, postToPR, postReview, reviewsSince, CLAUDE_PREFIX, CLAUDE_MARK } from '../hub/pr-report.mjs';
import { allLanded, cardPRs, hasPR, parsePRRef, prKeyOf, prNames, prURL, storedPRs } from '../shared/card-prs.mjs';
import { reviewLinks, topicItems, reviewersOf } from './review.mjs';
import { readiness } from '../hub/readiness.mjs';
import { SlackError, SLACK_NEEDS_TOKEN, isSignedOff, readSlack, savedSlack, slackDay, slackUserId } from '../hub/slack.mjs';
import { storedPath } from '../bin/install.mjs';
import { readPermissions } from './permissions.mjs';
import { validBuildTarget } from './build-script.mjs';
import { parseCheck, checkText } from '../shared/owner-check.mjs';
import { RuleError, rulesOf, addRule, editRule, removeRule, applyRules, readHubRules, writeHubRules } from '../hub/rules.mjs';
import { shareEntries, validLogin } from '../hub/share.mjs';

// brief, when a refusal has one, is its reason in a status line's room, for the line a refusal the board meets writes
// (hub-lines.mjs build-refused); the message is whole.
export class BoardError extends Error {
  constructor(message, brief) {
    super(message);
    this.brief = brief;
  }
}
const fail = (msg, brief) => { throw new BoardError(msg, brief); };

export const sitesDir = () => path.join(os.homedir(), '.claude', 'kickflip', 'sites');
export const wavesDir = () => path.join(os.homedir(), '.claude', 'waves');

// An object read from a file carries the text it was read from, so writeJSON can merge in what others wrote meanwhile.
const READ_AS = Symbol('read as');
export const readJSON = async (f, fallback) => {
  let text;
  try { text = await fs.readFile(f, 'utf8'); } catch { return fallback; }
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value, [READ_AS]: text } : value;
  } catch { return fallback; }
};
const readLines = async (f) => { try { return (await fs.readFile(f, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// docs/adr/2026-11-16-0205-the-event-log-and-threads-are-parsed-once-and-archived-cards-agent-files-go-unread.md
// The lines of an append-only JSON-lines file (data/events.jsonl, a thread), each parsed once in this process: a read
// stats the file and parses only the bytes appended since the last, read from the start of the last whole line it
// kept, so a file rewritten under it shows in bytes that no longer match and is read whole again, as is one replaced
// (another inode) or rewritten to the same length. A last line with no newline counts once it parses, and is left out
// while it is still being written. A broken whole line makes the file read as empty, as readLines does. → a new array
// each call, of frozen lines, so no caller changes what another reads.
const logs = new Map();
const frozen = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) frozen(v[k]); }
  return v;
};
const parseLines = (text) => text.split('\n').filter(Boolean).map((l) => frozen(JSON.parse(l)));
export async function readLog(file) {
  let st;
  try { st = await fs.stat(file); } catch { logs.delete(file); return []; }
  let kept = logs.get(file);
  if (kept && (kept.ino !== st.ino || st.size <= kept.size)) {
    if (st.size === kept.size && st.mtimeMs === kept.mtimeMs) return [...kept.lines, ...kept.open];
    kept = null;
  }
  for (;;) {
    const from = kept ? kept.end - kept.tail.length : 0;
    const fh = await fs.open(file).catch(() => null);
    if (!fh) { logs.delete(file); return []; }
    let buf;
    try {
      buf = Buffer.alloc(Math.max(0, st.size - from));
      buf = buf.subarray(0, (await fh.read(buf, 0, buf.length, from)).bytesRead);
    } finally { await fh.close(); }
    if (kept && !buf.subarray(0, kept.tail.length).equals(kept.tail)) { kept = null; continue; }
    const start = kept ? kept.tail.length : 0;
    const lastNewline = buf.lastIndexOf(10);
    let parsed;
    try { parsed = lastNewline >= start ? parseLines(buf.subarray(start, lastNewline + 1).toString('utf8')) : []; } catch { logs.delete(file); return []; }
    let open = [];
    try { open = parseLines(buf.subarray(lastNewline + 1).toString('utf8')); } catch {}
    const tailFrom = lastNewline > 0 ? buf.lastIndexOf(10, lastNewline - 1) + 1 : 0;
    const next = {
      ino: st.ino, size: from + buf.length, mtimeMs: st.mtimeMs, end: from + lastNewline + 1,
      tail: lastNewline >= 0 ? Buffer.from(buf.subarray(tailFrom, lastNewline + 1)) : Buffer.alloc(0),
      lines: kept ? kept.lines.concat(parsed) : parsed, open,
    };
    logs.set(file, next);
    return [...next.lines, ...next.open];
  }
}

// docs/adr/2026-11-16-0312-a-store-write-tells-its-board-server.md
// The board servers running in this process, by site: startServer's changed(file), which a write in their folders calls
// directly. → a function that stops it
const servers = new Map();
export function tellOnWrite(site, changed) {
  servers.set(path.resolve(site), changed);
  return () => servers.delete(path.resolve(site));
}
const inside = (dir, file) => file === dir || file.startsWith(dir + path.sep);
// After each write, each board whose data/ or item file's folder holds file is told:
// one served in this process through its changed(file), any other by a POST of {file} to /_claude/changed on its port in
// the hub's manifest, not waited on. A board whose server isn't up reads the write as it starts, or its minute pass
// signals it (signalMissedWrites).
function wrote(file) {
  file = path.resolve(file);
  const ports = new Map(Object.values(readManifest().sites || {}).filter(isBoardSite).map((s) => [path.resolve(s.dir), s.port]));
  for (const site of new Set([...servers.keys(), ...ports.keys()])) {
    const holds = inside(path.join(site, 'data'), file) ? Promise.resolve(true)
      : itemSources(site).then((sources) => sources.some((s) => inside(path.resolve(s.dir), file)), () => false);
    holds.then((held) => {
      if (!held) return;
      if (servers.has(site)) return servers.get(site)(file);
      if (!ports.get(site)) return;
      return fetch(`http://127.0.0.1:${ports.get(site)}/_claude/changed`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file }), signal: AbortSignal.timeout(10000),
      }).then((r) => r.body?.cancel(), () => {});
    });
  }
}
// told false: a cache of what the board just read, which changes nothing any board shows.
async function replace(file, text, { told = true } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
  if (told) wrote(file);
}
async function remove(file) {
  await fs.rm(file, { force: true });
  wrote(file);
}
// A value read through readJSON is written under the file's lock, merged with whatever was written to the file since that
// read (merge3), so concurrent processes' changes to different parts of one file all survive.
const writeJSON = (file, value) => {
  const { [READ_AS]: readAs, ...mine } = value ?? {};
  if (readAs === undefined) return replace(file, JSON.stringify(value, null, 2) + '\n');
  return withFileLock(file, async () => {
    const base = JSON.parse(readAs);
    const current = JSON.parse(await fs.readFile(file, 'utf8').catch(() => readAs));
    await replace(file, JSON.stringify(merge3(base, mine, current), null, 2) + '\n');
  });
};
async function appendLine(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(value) + '\n');
  wrote(file);
}

export async function siteDir(route) {
  if (!/^[\w-]+$/.test(route || '')) fail(`--site takes a route such as ios-orchestrator, not "${route}"`);
  const dir = path.join(sitesDir(), route);
  if (!(await fs.stat(dir).then((s) => s.isDirectory(), () => false))) fail(`no site at ${dir}`);
  return dir;
}

export const boardConfig = async (site) => ({ title: 'Board', items: 'waves', ...(site ? await readJSON(path.join(site, 'board.json'), {}) : {}) });

// Each item file the board shows: {slug, dir, file}. Builder records sit in <dir>/agents.
export async function itemSources(site) {
  const cfg = await boardConfig(site);
  if (cfg.items === 'waves') {
    try {
      return (await fs.readdir(wavesDir(), { withFileTypes: true })).filter((d) => d.isDirectory())
        .map((d) => ({ slug: d.name, dir: path.join(wavesDir(), d.name), file: path.join(wavesDir(), d.name, 'wave.json') }));
    } catch { return []; }
  }
  const file = path.resolve(site, cfg.items);
  return [{ slug: cfg.slug || path.basename(cfg.items, '.json'), dir: path.dirname(file), file }];
}

export const threadFile = (site, key) => path.join(site, 'data', 'threads', key.replace(/[^\w.-]+/g, '__') + '.jsonl');
const ownerFile = (site) => path.join(site, 'data', 'owner.json');
// data/staged-questions.json {<file>/<id>: [question]}: questions added to a card while a planner of it runs, held back from
// owner.json until it finishes (docs/adr/2026-11-06-0100-a-grills-questions-appear-together-once-the-grill-is-done.md).
const stagedFile = (site) => path.join(site, 'data', 'staged-questions.json');
// data/screening.json {<file>/<id>: <iso>}: the cards whose grill has finished with questions staged, which wait on the
// orchestrator to screen them, since when, until question publish, or SCREEN_AFTER, publishes them
// (docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md).
const screeningFile = (site) => path.join(site, 'data', 'screening.json');
export const SCREEN_AFTER = 15 * 60 * 1000;
const needSite = (site) => site || fail('this command needs --site <route>');
const text = (v, name) => (typeof v === 'string' && v.trim() ? v.trim() : fail(`${name} must be non-empty text`));
const optional = (v, check) => (v === undefined ? undefined : check(v));
// docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md: a --title a card takes is a Conventional subject or an ask.
const cardTitle = (v) => {
  const title = text(v, '--title');
  const fault = cardTitleFault(title);
  return fault ? fail(`--title "${title}" ${fault}; a task's title is ${cardTitleWords}`) : title;
};
const PROTOTYPE_PAGE = /^prototype-[\w-]+\.html(?:[?#]\S*)?$/;
const VISUAL_PAGE = /^visuals\/[\w-]+\/[\w-]+\.html$/;
const pageUrl = (v, name) => (typeof v === 'string' && (PROTOTYPE_PAGE.test(v) || VISUAL_PAGE.test(v) || /^https?:\/\/\S+$/.test(v)) ? v : fail(`${name} must be an http(s) URL or a site page such as prototype-<topic>.html?q=<id>`));
const bool = (v, name) => (typeof v === 'boolean' ? v : fail(`${name} must be true or false`));
const domId = (v, name) => (typeof v === 'string' && /^[\w.-]+$/.test(v) ? v : fail(`${name} must use only letters, digits, "_", "." and "-"`));
const onlyKeys = (o, keys, name) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail(`${name} must be a JSON object`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) fail(`${name} has unknown field ${extra.map((k) => `"${k}"`).join(', ')}; allowed: ${keys.join(', ')}`);
};

export function parseKey(key) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(key || '');
  return m ? { file: m[1], id: m[2] } : fail(`expected <file>/<id>, not "${key}"`);
}

async function loadItemFile(site, slug) {
  const source = (await itemSources(site)).find((s) => s.slug === slug) || fail(`this board has no item file "${slug}"`);
  const itemFile = await readJSON(source.file, null);
  if (!itemFile || !Array.isArray(itemFile.items)) fail(`${source.file} is not an item file with items[]`);
  return { source, itemFile };
}

// A card in the archive comes back to its item file for any command that names it (restoreArchived).
async function loadItem(site, key) {
  const { file: slug, id } = parseKey(key);
  let loaded = await loadItemFile(site, slug);
  if (!loaded.itemFile.items.some((it) => it.id === id) && await restoreArchived(site, key)) loaded = await loadItemFile(site, slug);
  const item = loaded.itemFile.items.find((it) => it.id === id) || fail(`item file "${slug}" has no item "${id}"`);
  return { ...loaded, item };
}
export const cardTitleOf = async (site, key) => (await loadItem(site, key)).item.title;

// A reply's file, data/replies/<eventId>.<ext>: .md, which `reply` writes; .html, which replies before markdown are; .json.
// An event's thread of replies is append-only: its first reply is <eventId>.<ext>, and each later one is its own file,
// <eventId>~2.<ext>, <eventId>~3.<ext>, … ("~" can't appear in an event id).
export const REPLY_EXTS = ['md', 'html', 'json'];

// Every reply file in dir by event id, from one listing: Map<eventId, [{name, ext, n}]>, each event's replies oldest first
// (n 1 for the first reply).
export async function readReplyIndex(dir) {
  const index = new Map();
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const m = /^(.+?)(?:~(\d+))?\.(md|html|json)$/.exec(name);
    if (!m) continue;
    if (!index.has(m[1])) index.set(m[1], []);
    index.get(m[1]).push({ name, ext: m[3], n: Number(m[2] || 1) });
  }
  for (const [id, files] of index) {
    index.set(id, files.sort((a, b) => a.n - b.n || REPLY_EXTS.indexOf(a.ext) - REPLY_EXTS.indexOf(b.ext)).filter((f, i, all) => f.n !== all[i - 1]?.n));
  }
  return index;
}

// → [{name, ext, n}] of event eventId's reply files in dir, oldest first.
export async function replyFilesOf(dir, eventId) {
  return (await readReplyIndex(dir)).get(eventId) || [];
}

// {<item id>: {<agent>: record}} from dir's <id>.json (agent main) and <id>@<agent>.json (builderFile), of the ids in
// ids, a Set.
export async function readAgents(dir, ids) {
  let files = [];
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json') && ids.has(path.basename(f, '.json').split('@')[0])); } catch {}
  const records = await Promise.all(files.map(async (f) => { try { return JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')); } catch { return null; } }));
  const out = Object.create(null);
  files.forEach((f, i) => {
    if (!records[i]) return;
    const [id, agent = 'main'] = path.basename(f, '.json').split('@');
    (out[id] ||= Object.create(null))[agent] = records[i];
  });
  return out;
}

export async function writeReply(site, eventId, md, title) {
  needSite(site);
  domId(eventId, 'the event id');
  const event = (await readLog(path.join(site, 'data', 'events.jsonl'))).find((e) => e.id === eventId);
  if (!event) fail(`no event "${eventId}" in this site's data/events.jsonl`);
  // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: a reply to an ask answers the card
  // it became, which alone takes --title.
  const card = event.kind === 'ask' ? await askCardOf(site, eventId) : null;
  const key = card ? card.key : event.kind === 'ask' ? `ask:${eventId}` : event.kind === 'item-message' && typeof event.data?.key === 'string' ? event.data.key : null;
  if (card && answerable(card.item)) {
    text(md, 'the reply');
    await markAnswered(site, card, title);
  } else if (title !== undefined) fail(`reply --title titles the New or answered task an ask became; "${eventId}" is not one`);
  const dir = path.join(site, 'data', 'replies');
  const earlier = await replyFilesOf(dir, eventId);
  const file = path.join(dir, earlier.length ? `${eventId}~${earlier.at(-1).n + 1}.md` : `${eventId}.md`);
  await replace(file, text(md, 'the reply'));
  // docs/adr/2026-11-16-1700-replies-to-a-slack-message-post-into-its-slack-thread.md
  if (key && !key.startsWith('ask:') && slackSourced(event) && (card || await loadItem(site, key)).item.lane !== 'done') await queueSlackReply(site, key, path.basename(file, '.md'));
  const lines = key ? await freshenPush(site, key, md) : [];
  // docs/adr/2026-11-01-1813-an-answered-question-stops-waiting-once-claude-acts-on-its-card.md
  if (card) lines.push(...await resolveAnsweredOn(site, `item:${card.key}`, 'Acted on: replied'));
  return { file, lines };
}

// An event the watcher handed the session, such as an ask or a thread message, reads "Working on it" until
// Claude replies to it (or, in a thread, writes a later line); domain.mjs decides which.
const workingFile = (site) => path.join(site, 'data', 'working.json');
export async function readWorking(site) {
  return (await readJSON(workingFile(site), {})).events || {};
}

// The kinds bin/wait-events.mjs marks working as it hands them to the session (docs/adr/2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md).
export const WORKING_KINDS = ['ask', 'item-message', 'overnight-triage', 'board-ask'];
export async function markWorking(site, eventIds) {
  if (!eventIds.length) return;
  const at = new Date().toISOString();
  const events = await readWorking(site);
  await writeJSON(workingFile(site), { events: { ...events, ...Object.fromEntries(eventIds.map((id) => [id, routeRecord(events, id) || at])) } });
}

// docs/adr/2026-11-15-1700-a-card-reads-thinking-from-its-events-delivery-until-the-orchestrator-writes.md
// data/delivered.json {since, events: {<event id>: ts}}: when bin/wait-events.mjs, or the PostToolUse hook, first handed
// each event to the session, every kind it hands over; since is the board's first stamp, so an event sent before it
// counts as handed when sent (domain.mjs handedAt).
const deliveredFile = (site) => path.join(site, 'data', 'delivered.json');
export async function readDelivered(site) {
  return readJSON(deliveredFile(site), {});
}
export async function markDelivered(site, eventIds) {
  if (!eventIds.length) return;
  const at = new Date().toISOString();
  const { since = at, events = {} } = await readDelivered(site);
  await writeJSON(deliveredFile(site), { since, events: { ...events, ...Object.fromEntries(eventIds.map((id) => [id, routeRecord(events, id) || at])) } });
}

// docs/adr/2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md
// data/acted-on.json {cards: {<file>/<id>: ts}}: when the orchestrator's last command on each card ran (bin/board.mjs
// ACTS). It ends the working of the card's messages before it, as a later thread line of Claude's does (domain.mjs threadOf).
const actedOnFile = (site) => path.join(site, 'data', 'acted-on.json');
export async function readActedOn(site) {
  return (await readJSON(actedOnFile(site), {})).cards || {};
}
export async function markActedOn(site, keys) {
  if (!keys.length) return;
  const at = new Date().toISOString();
  await writeJSON(actedOnFile(site), { cards: { ...await readActedOn(site), ...Object.fromEntries(keys.map((key) => [key, at])) } });
}
// docs/adr/2026-11-15-2350-text-to-the-owner-names-a-questions-task-not-its-id.md: a question's id is internal, the owner
// sees a question by its words on its task's thread. Text that names the id of any question owner.json or the done
// archive holds is refused, with the task to name instead.
export async function refuseQuestionIds(site, texts) {
  const said = texts.filter((t) => typeof t === 'string' && t);
  if (!said.length) return;
  const owner = await readJSON(ownerFile(site), { items: [] });
  const known = [...(owner.items || []), ...(await readArchive(site)).flatMap((a) => a.questions || [])];
  for (const q of known) {
    const named = new RegExp(`(?<![\\w-])${q.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
    if (!said.some((t) => named.test(t))) continue;
    const task = String(q.topic || '').startsWith('item:') ? q.topic.slice(5) : 'its task';
    fail(`the text names the question "${q.id}"; name its task instead, e.g. "the question on ${task}", and quote its words if needed: the owner sees a question by its words, never its id`);
  }
}
// The cards owner.json's questions ids are asked on, for the question commands' ACTS entries.
export async function questionCards(site, ids) {
  const owner = await readJSON(ownerFile(site), { items: [] });
  return (owner.items || []).filter((q) => ids.includes(q.id)).map((q) => cardOfTopic(q.topic)).filter(Boolean);
}

// The asks whose text the session was just handed again, an edit the watcher or the PostToolUse hook printed or a
// sorting command's refusal, have their working mark moved to now: that is when the session read their latest text.
export async function restampWorking(site, askIds) {
  if (!askIds.length) return;
  const at = new Date().toISOString();
  await writeJSON(workingFile(site), { events: { ...await readWorking(site), ...Object.fromEntries(askIds.map((id) => [id, at])) } });
}
// The asks the ask-edited events among events edit.
export const editedAsks = (events) => [...new Set(events.filter((e) => e?.kind === 'ask-edited' && typeof e.data?.id === 'string').map((e) => e.data.id))];

// docs/adr/2026-11-12-1300-sorting-an-ask-refuses-an-edit-the-orchestrator-hasnt-read.md
// Refuses a command that sorts the ask ref is or became (an ask's event id, or the card key it became) when the owner
// edited the ask after its working mark, or it has an edit and no mark: the session hasn't read that text. The refusal
// prints the new text, which re-stamps the mark, so a rerun goes through. Any other event or card passes.
export async function refuseUnreadEdit(site, ref) {
  needSite(site);
  const id = ref.includes('/') ? (await loadItem(site, ref)).item.from_ask : ref;
  if (!id) return;
  const edit = (await readLog(path.join(site, 'data', 'events.jsonl')))
    .filter((e) => e.kind === 'ask-edited' && e.data?.id === id && typeof e.data?.text === 'string')
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1);
  if (!edit) return;
  const mark = routeRecord(await readWorking(site), id);
  if (mark && Date.parse(mark) >= Date.parse(edit.ts)) return;
  await restampWorking(site, [id]);
  fail(`task ${id} was edited at ${edit.ts}, after you read it. Its text now:\n${edit.data.text}\nRead it, then run this again, or change the command if the edit changes the plan.`);
}

// Replies ride along on the next push (docs/adr/2026-10-29-1639-replies-ride-along-on-the-next-push.md).
const pushStateFile = (site) => path.join(site, 'data', 'push-state.json');

// Reply files modified after the site's last recorded push and no later than `until`; 0 before its first push.
export async function repliesSincePush(site, until) {
  needSite(site);
  const last = Date.parse((await readJSON(pushStateFile(site), {})).last_push);
  if (Number.isNaN(last)) return 0;
  const dir = path.join(site, 'data', 'replies');
  const names = (await fs.readdir(dir).catch(() => [])).filter((n) => REPLY_EXTS.includes(path.extname(n).slice(1)));
  const times = await Promise.all(names.map((n) => fs.stat(path.join(dir, n)).then((st) => st.mtimeMs, () => 0)));
  return times.filter((t) => t > last && t <= until.getTime()).length;
}

export async function recordPush(site, at) {
  await writeJSON(pushStateFile(needSite(site)), { last_push: at.toISOString() });
  return pushStateFile(site);
}

const KICKFLIP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kickflip.mjs');
function pushCommand() {
  if (!process.env.KICKFLIP_PUSH_CMD) return [nodeBin(), KICKFLIP, 'push'];
  try {
    const cmd = JSON.parse(process.env.KICKFLIP_PUSH_CMD);
    if (Array.isArray(cmd) && cmd.length && cmd.every((a) => typeof a === 'string')) return cmd;
  } catch {}
  throw new BoardError('KICKFLIP_PUSH_CMD must be a JSON array of strings');
}

// Runs kickflip push with {kind, title, body?, url?, tag?, urgent?, now?, silent?}, adding "· and N replies" to the body for the
// replies written since the site's last push, and records the push when kickflip push succeeds. → {lines}: what
// kickflip push said. A failure throws a BoardError with its exit code, naming why on its last line.
export async function sendPush(site, f) {
  const refused = pushKindError(f.kind);
  if (refused) fail(refused);
  if (f.title === undefined) fail('push needs --title');
  const at = new Date();
  const body = withReplies(f.body, await repliesSincePush(site, at));
  const flags = { kind: f.kind, title: f.title, body: body || undefined, url: pushUrl(f.url), tag: f.tag };
  const [cmd, ...pre] = pushCommand();
  const args = [...pre, ...Object.entries(flags).flatMap(([k, v]) => (v === undefined ? [] : [`--${k}`, v])), ...(f.urgent ? ['--urgent'] : []), ...(f.now ? ['--now'] : []), ...(f.silent ? ['--silent'] : [])];
  const r = await new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8' }, (error, stdout, stderr) => resolve({ error, said: `${stdout || ''}${stderr || ''}`.split('\n').filter((l) => l.trim()) }));
  });
  const code = r.error ? (typeof r.error.code === 'number' ? r.error.code : 1) : 0;
  if (code !== 0) throw Object.assign(new BoardError([...r.said, `kickflip push failed (${typeof r.error.code === 'number' ? `exit ${code}` : r.error.message}); the push was not recorded`].join('\n')), { exitCode: code });
  await recordPush(site, at);
  return { lines: r.said };
}

const REPLIES = /(?:^| · )(and \d+ repl(?:y|ies))$/;
export const withReplies = (body, n) => [body, n && `and ${n} ${n === 1 ? 'reply' : 'replies'}`].filter(Boolean).join(' · ');


export const PUSH_LINE_MAX = 160;
// A message's first non-empty line, cut to PUSH_LINE_MAX characters.
export function pushLine(message) {
  const line = String(message).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
  return line.length > PUSH_LINE_MAX ? `${line.slice(0, PUSH_LINE_MAX - 1).trimEnd()}…` : line;
}

// Where a push lands (docs/adr/2026-10-29-1639-a-push-lands-where-the-owner-answers.md). A card or ask link (#selectedCard=) gains
// &reply, so the board opens that thread with its reply box focused. A page other than the board gains from=push, so
// the back arrow of a page outside the page tree goes to the card or the board
// (docs/adr/2026-10-30-1125-back-follows-the-page-tree.md), and a prototype page tied to a question (?q=) sends the owner to the
// card's thread instead once that question has a pick.
export function pushUrl(url) {
  if (!url || !url.startsWith('/')) return url;
  const u = new URL(url, 'http://board');
  if (/^#(?:selectedCard|item)=[^&]+$/.test(u.hash)) u.hash = `${u.hash}&reply`;
  if (/\/[\w-]+\.html$/.test(u.pathname) && !u.pathname.endsWith('/index.html')) u.searchParams.set('from', 'push');
  return u.pathname + u.search + u.hash;
}
const threadUrl = (site, key) => `/${path.basename(site)}/#selectedCard=${encodeURIComponent(key)}&reply`;

// Claude's latest message in a thread becomes the body of that thread's queued push, keeping its "· and N replies",
// and the push now opens that thread at its reply box, whatever page it first linked. It never sends a push: a line
// after the push went shows as the thread's unread mark (docs/adr/2026-10-29-1639-pushes-go-by-kind-and-each-arrives-on-its-own.md).
// → lines for the CLI to print.
async function freshenPush(site, key, message) {
  const line = pushLine(message);
  if (!line) return [];
  const tag = pushTag(key);
  const body = await reviseQueued(tag, (old) => [line, REPLIES.exec(old)?.[1]].filter(Boolean).join(' · '), threadUrl(site, key));
  return body === null ? [] : [`queued push ${tag} now reads: ${body}`];
}

export const hiddenFile = (site) => path.join(site, 'data', 'hidden.json');
export const readHidden = async (site) => new Set((await readJSON(hiddenFile(site), { events: [] })).events || []);

// The owner deleted an event from the page; it leaves every device's list. Writes run one at a
// time, since overlapping read-modify-writes drop each other's changes.
let hiddenWrites = Promise.resolve();
export function setHidden(site, eventId, hidden) {
  domId(eventId, 'the event id');
  const write = hiddenWrites.then(async () => {
    const ids = await readHidden(site);
    if (hidden) ids.add(eventId); else ids.delete(eventId);
    await writeJSON(hiddenFile(site), { events: [...ids] });
  });
  hiddenWrites = write.catch(() => {});
  return write;
}

// docs/adr/2026-11-05-0910-read-marks-live-on-the-board.md
// The owner's read marks, one set for every device: card key → the newest message time they have seen on it.
export const readMarksFile = (site) => path.join(site, 'data', 'read.json');
export const readMarks = async (site) => (await readJSON(readMarksFile(site), {})).cards || {};

// keys: the cards on the board. Each keeps the later of its mark and marks[key]; a card with no mark yet is read up to
// now, so a card new to the board badges only what comes after it; a key not on the board loses its mark. Writes run
// one at a time, sorted by key, and only when a mark changed.
let readWrites = Promise.resolve();
export function markRead(site, keys, marks = {}) {
  const write = readWrites.then(async () => {
    const old = await readMarks(site);
    const now = new Date().toISOString();
    const later = (a, b) => (String(b || '') > a ? b : a);
    const cards = Object.fromEntries([...new Set(keys)].sort().map((key) => [key, later(old[key] || now, marks[key])]));
    if (JSON.stringify(cards) !== JSON.stringify(old)) await writeJSON(readMarksFile(site), { cards });
  });
  readWrites = write.catch(() => {});
  return write;
}

export const UPLOAD_LIMIT = 20 * 1024 * 1024;
const uploadsDir = (site) => path.join(site, 'data', 'uploads');
const uploadMeta = (site, file) => path.join(uploadsDir(site), '.meta', `${file}.json`);
const STORED = /^\d+-[\w.-]+$/;
const MIME = /^[\w.+-]+\/[\w.+-]+$/;
const tooLarge = () => Object.assign(new BoardError(`a file can be at most ${UPLOAD_LIMIT / 1024 / 1024} MB`), { status: 413 });

// Streams body (an async iterable of chunks) to data/uploads/<ms>-<safe name>. Past UPLOAD_LIMIT bytes it
// removes the partial file and throws a BoardError with status 413. → {name, url, path, type, size}
export async function saveUpload(site, body, { name, type, length }) {
  needSite(site);
  if (length > UPLOAD_LIMIT) throw tooLarge();
  const shown = String(name || '').trim().slice(0, 200) || 'file';
  const safe = path.basename(shown).replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(-80) || 'file';
  const mime = String(type || '').split(';')[0].trim().toLowerCase();
  const kind = MIME.test(mime) ? mime : 'application/octet-stream';
  await fs.mkdir(path.dirname(uploadMeta(site, 'x')), { recursive: true });
  let file, handle;
  for (let t = Date.now(); !handle; t++) {
    file = `${t}-${safe}`;
    handle = await fs.open(path.join(uploadsDir(site), file), 'wx').catch((e) => (e.code === 'EEXIST' ? null : Promise.reject(e)));
  }
  const full = path.join(uploadsDir(site), file);
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.length;
      if (size > UPLOAD_LIMIT) throw tooLarge();
      await handle.write(chunk);
    }
  } catch (e) {
    await handle.close();
    await fs.rm(full, { force: true });
    throw e;
  }
  await handle.close();
  await writeJSON(uploadMeta(site, file), { name: shown, type: kind, size, at: new Date().toISOString() });
  return { name: shown, url: `uploads/${file}`, path: full, type: kind, size };
}

// A stored upload by its file name under data/uploads, or null for any other name. → {path, name, type, size}
export async function readUpload(site, file) {
  if (!STORED.test(file || '')) return null;
  const full = path.join(uploadsDir(site), file);
  const st = await fs.stat(full).catch(() => null);
  if (!st?.isFile()) return null;
  const meta = await readJSON(uploadMeta(site, file), {});
  return { path: full, name: meta.name || file, type: MIME.test(meta.type || '') ? meta.type : 'application/octet-stream', size: st.size };
}

// board: an answer another board's orchestrator wrote (answerBoardAsk), who naming that board's route.
const VIA = ['github', 'slack', 'board'];
// docs/adr/2026-11-09-1200-the-board-writes-status-lines-and-only-the-orchestrator-writes-messages.md
// A thread takes two kinds of line: the board's status lines (appendStatus) and messages (appendMessage), which the
// orchestrator writes in its own words, as do the reviewers it names and GitHub's and Slack's comments brought in.
// Nothing else writes a plain line to a thread; board-threads.test.mjs holds the code to it.
const checkThreadKey = async (site, key) => (String(key).startsWith('ask:') ? checkAsk(site, key.slice(4), 'the ask') : loadItem(site, key));
// A status line of a kind in hub-lines.mjs HUB_LINES, its words from inputs; a fault line freshens the queued push.
// questions: the ids a questions-added line holds, which colour it (domain.mjs threadOf).
// → {line, lines for the CLI to print}
export async function appendStatus(site, key, kind, inputs = {}, { link, questions } = {}) {
  needSite(site);
  await checkThreadKey(site, key);
  const line = { ts: new Date().toISOString(), who: 'claude', kind: HUB, line: kind, text: hubText(kind, inputs), ...(detailOf(kind, inputs) ? { detail: detailOf(kind, inputs) } : {}), ...(link ? { link } : {}), ...(questions ? { questions } : {}) };
  await appendLine(threadFile(site, key), line);
  return { line, lines: hubLineOf(line).fault ? await freshenPush(site, key, line.text) : [] };
}
// The line a resumed builder posts, "Builder resumed", when something else came after the builder's section: a plain
// message on the thread or an owner event on the card, newer than the newest status or hub line (the builder's, the
// lander's, the board's). Resumes in a row, or right after the builder, post none.
export async function appendBuilderResumed(site, key) {
  const lines = await readLog(threadFile(site, key));
  const events = (await readLog(path.join(site, 'data', 'events.jsonl'))).filter((e) => e.data?.key === key && ITEM_EVENTS.includes(e.kind));
  const section = lines.filter((m) => m.kind === 'status' || m.kind === HUB).map((m) => String(m.ts)).sort().pop() ?? '';
  const other = [...lines.filter((m) => !m.kind && !m.command), ...events].map((m) => String(m.ts));
  if (other.some((ts) => ts > section)) await appendStatus(site, key, 'builder-resumed');
}
// key is <file>/<id>, or ask:<event id> for an ask's thread. by: the shared person whose tap an owner line is, by name
// (docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md).
// A message holds at most MESSAGE_LIMIT characters; a longer one is refused for the orchestrator to rewrite shorter or
// move into a page it links. A comment brought in from GitHub or Slack is kept whole.
// script: a file whose text the message offers for the owner to run on a work card
// (docs/adr/2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md), stored whole on the line with
// its id, hash, and the host and user the board server runs it as.
export async function appendMessage(site, key, { text: body, link, log, who = 'claude', via, by, close, implement, script: scriptFile }) {
  needSite(site);
  if (close && implement) fail('thread takes --implement or --close, not both');
  if ((close || implement) && (who !== 'claude' || via !== undefined)) fail(`thread --${close ? 'close' : 'implement'} is the orchestrator marking a task: it takes no --who or --via`);
  if (scriptFile !== undefined && (who !== 'claude' || via !== undefined)) fail("--script is the orchestrator's offer: it takes no --who or --via");
  if (scriptFile !== undefined && String(key).startsWith('ask:')) fail('--script goes on a task: name it <file>/<id>');
  await checkThreadKey(site, key);
  if (!/^[^\n]{1,40}$/.test(who.trim())) fail('--who takes claude, love or a reviewer\'s name');
  if (via !== undefined && !VIA.includes(via)) fail(`--via takes ${VIA.join(' or ')}`);
  const words = via === undefined ? messageText(body) : text(body, '--text');
  const script = scriptFile === undefined ? undefined : scriptOf(scriptFile);
  const line = { ts: new Date().toISOString(), who: who.trim(), text: words, link: optional(link, (v) => pageUrl(v, '--link')), log, via, by, script };
  const file = threadFile(site, key);
  if (close || implement) await markWaiting(site, key, close ? 'close' : 'implement');
  await appendLine(file, line);
  return { file, lines: line.who === 'claude' && !via ? await freshenPush(site, key, line.text) : [] };
}
// docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md: the words and the flag
// agree. The orchestrator's reply or thread line asking the owner to tap Implement is refused without --implement, and
// one asking them to tap Done without --close: the flag marks the card, so the board owes the tap and pushes it.
const TAP_WORDS = /\btap\s+(implement|done)\b/i;
export function refuseUnflaggedTap(words, { implement, close }) {
  const asked = TAP_WORDS.exec(String(words ?? ''))?.[1];
  if (!asked) return;
  const flag = asked.toLowerCase() === 'implement' ? 'implement' : 'close';
  if (!(flag === 'implement' ? implement : close)) fail(`the text asks the owner to tap ${asked}: pass --${flag}, which marks the task so its card owes that tap, or reword it`);
}
function scriptOf(file) {
  const body = readFileSync(String(file), 'utf8');
  if (!body.trim()) fail(`--script ${file} is empty: offer the script the owner should run`);
  if (body.length > SCRIPT_LIMIT) fail(`--script runs to ${body.length} characters, past a script's ${SCRIPT_LIMIT}: offer a shorter one`);
  return { id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, body, sha: scriptSha(body), ...runsAs() };
}
// The script offer id on card key as the board reads it (domain.mjs scriptStateOf): {offer: the line's script, state}.
export async function readScriptOffer(site, key, id) {
  const offers = (await readLog(threadFile(site, key))).filter((m) => m.script);
  const offer = offers.find((m) => m.script.id === id)?.script;
  if (!offer) fail(`${key} has no script ${id}`);
  const events = (await readLog(path.join(site, 'data', 'events.jsonl'))).filter((e) => e.data?.key === key && e.data?.id === id);
  return { offer, state: scriptStateOf(offer, events, offers.at(-1).script.id).state };
}
// A finished run of script id on card key ({exit, output, timedOut, ms}) as its script-result event, through the board
// server so it wakes the watcher (hub/boards.mjs appendEvent).
export async function recordScriptResult(site, key, id, result) {
  return appendEvent(boardTarget(site), SCRIPT_EVENTS.result, { key, id, ...result, log: scriptLogName(id) });
}
// A message's words, refused past MESSAGE_LIMIT, which a command checks before it changes anything.
export function messageText(body) {
  const words = text(body, '--text');
  if (words.length > MESSAGE_LIMIT) {
    fail(`--text runs to ${words.length} characters, past a message's ${MESSAGE_LIMIT}: rewrite it shorter, or put the detail in an HTML page (board.mjs visual add, or --link to a page) and link it`);
  }
  return words;
}
// command is a button's key (domain.mjs COMMANDS), which makes the line its status line; card, on a link's line, the other
// card's key, whose ref and title the thread draws when it renders (domain.mjs threadOf).
async function appendCommand(site, key, { command, text: words = COMMANDS[command], who = 'claude', by, card, sendId, ts = new Date().toISOString() }) {
  const line = { ts, who, command, text: words, ...(sendId ? { sendId } : {}),...(by ? { by } : {}), ...(card ? { card } : {}) };
  await appendLine(threadFile(site, key), line);
  return { lines: [] };
}

// An ask folded into an existing work item: data/ask-links.json ({links: {<ask event id>: <file>/<id>}}) names the item,
// whose thread then holds the ask, marked moved, and one summary line; the ask has no card of its own
// (docs/adr/2026-10-29-1639-the-plus-makes-a-new-card.md).
const askLinksFile = (site) => path.join(site, 'data', 'ask-links.json');
export async function readAskLinks(site) {
  return (await readJSON(askLinksFile(site), {})).links || {};
}

// A card as the board labels it, for the one-line summaries board/bin/board.mjs and bin/wait-events.mjs print: a work
// item by its ref, an ask (ask:<event id>) by the card it became or was folded into, else "task <id>",
// the owner's word for an ask (CONTEXT.md New task).
export async function cardName(site, key) {
  const { tickets } = settingsOf(await boardConfig(site));
  const sources = await itemSources(site);
  const ask = /^ask:(.+)$/.exec(key)?.[1];
  if (ask === undefined) {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(key);
    if (!m) return key;
    const source = sources.find((s) => s.slug === m[1]);
    const itemFile = source && await readJSON(source.file, null);
    if (!itemFile) return m[2];
    const card = (itemFile.items || []).find((it) => it.id === m[2]);
    return refOf(itemFile, card || { id: m[2] }, tickets);
  }
  const folded = site ? routeRecord(await readAskLinks(site), ask) : undefined;
  if (folded) return cardName(site, folded);
  for (const s of sources) {
    const itemFile = await readJSON(s.file, null);
    const it = (Array.isArray(itemFile?.items) ? itemFile.items : []).find((i) => i.from_ask === ask);
    if (it) return refOf(itemFile, it, tickets);
  }
  return `task ${ask}`;
}

// The card an event in data/events.jsonl belongs to (cardName), or "the <kind> event" for one about no card.
export async function eventCard(site, eventId) {
  const e = (await readLog(path.join(site, 'data', 'events.jsonl'))).find((x) => x.id === eventId);
  if (e?.kind === 'ask') return cardName(site, `ask:${eventId}`);
  if (typeof e?.data?.key === 'string') return cardName(site, e.data.key);
  return `the ${e?.kind} event`;
}

// docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md
// The card ask eventId became, {source, itemFile, item, key}, or null.
async function askCardOf(site, eventId) {
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    const item = (Array.isArray(itemFile?.items) ? itemFile.items : []).find((i) => i.from_ask === eventId);
    if (item) return { source, itemFile, item, key: `${source.slug}/${item.id}` };
  }
  return null;
}
// Whether the card an ask became is still New: nothing has sorted, answered or started it.
const stillNew = (item) => !item.phase && !item.answered_at && !leftTodo(item) && !hasPR(item) && !item.filed_held;
// docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md: the card an ask became, given its first
// phase, records when the orchestrator ingested it, which the New strip's line to the card reads (domain.mjs ingested).
// Call it before the phase is set. → whether the card left New, so its caller posts its held links once it is written
// (postHeldLinks).
function leaveNew(item) {
  if (!item.from_ask || item.phase || item.sorted_at) return false;
  item.sorted_at = new Date().toISOString();
  return true;
}
// An ask's title as its card takes it: the first line of its latest text, else its files' names.
function askTitle(ask, events) {
  const edit = events.filter((e) => e.kind === 'ask-edited' && e.data?.id === ask.id && typeof e.data?.text === 'string')
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1);
  const words = String(edit ? edit.data.text : ask.data?.text || '').trim().split('\n')[0].trim();
  return words || (ask.data?.files || []).map((f) => f?.name).filter(Boolean).join(', ') || 'Ask';
}

// Files ask eventId as a New T-<n> card in the board's first item file: from_ask, titled by its first line, no phase,
// no thread line (its thread opens with the ask; domain.mjs threadOf). The board server runs it as an ask arrives, with
// pending, the ask event it is about to write, filed first so the watcher's line names its card. → its key, or null
// when the ask already has a card or isn't New: deleted, moved, folded or answered (askNotNew). An ask the orchestrator
// filed (askItem) goes in the item file it names and is born with the links it carries.
export const fileAsk = (site, eventId, pending, options) => ticketWrite(site, async () => {
  needSite(site);
  const events = await readLog(path.join(site, 'data', 'events.jsonl'));
  const ask = pending || events.find((e) => e.id === eventId && e.kind === 'ask') || fail(`no ask "${eventId}" in this site's data/events.jsonl`);
  if (await askCardOf(site, eventId) || await askNotNew(site, eventId, events)) return null;
  const { source, itemFile } = await askFile(site, ask.data?.file);
  const item = await newAskCard(site, source, ask, askTitle(ask, events));
  itemFile.items.push(item);
  await writeJSON(source.file, itemFile);
  const key = `${source.slug}/${item.id}`;
  await postAskLinks(site, key, ask.data?.links, options);
  return key;
});

// docs/adr/2026-11-16-1100-a-task-the-orchestrator-files-comes-in-as-an-ask-through-new.md
// item add --ask: the orchestrator's plain-text request filed as an ask on its own board, as the owner's New task is,
// so the task it becomes waits in intake and is triaged, investigated and answered like theirs. The ask event carries
// asked {by, key?, ref?}, who asked (the orchestrator, or the builder or planner of the task it comes from), which
// opens its thread (domain.mjs askedLine); file, the item file its card goes in; and links {parent?, via?, related?,
// deps?, before?}, as keys, which its card is born with (askLinks). Every link is checked before the event is
// written. Filed at once, as handoff files on a board that may be down. → its card's key.
// docs/adr/2026-11-16-1700-a-filed-task-links-where-it-came-from-and-the-tasks-it-names.md: it names where it came from,
// a --parent or a --relate, and links every task its request names. via is split for --split, else from: a task
// filed with a Parent is born from it.
export const ASKERS = ['orchestrator', 'builder', 'planner'];
export async function askItem(site, file, { text: request, parent, split, relate, deps, before, by = 'orchestrator', replyOn }, options) {
  needSite(site);
  if (file.includes('/')) fail(`item add --ask files a task keyed by the board's next number; pass the item file alone, ${file.split('/')[0]}`);
  const words = text(request, '--ask');
  if (!ASKERS.includes(by)) fail('--by takes orchestrator, builder or planner');
  if (by !== 'orchestrator' && parent === undefined) fail(`--by ${by} names the task whose ${by} asked: pass --parent <that task>`);
  if (split && parent === undefined) fail(SPLIT_NEEDS_PARENT);
  if (parent === undefined && relate === undefined) fail(`${UNSOURCED}: pass --parent <the task it came from> or --relate <the tasks it touches>`);
  await loadItemFile(site, file);
  const links = {};
  if (parent !== undefined) Object.assign(links, { parent: await parentKey(site, file, null, parent) || fail('--parent takes a task, such as <file>/<id>'), via: split ? 'split' : 'from' });
  if (relate !== undefined) links.related = await relatedKeys(site, file, relate, '--relate');
  if (deps !== undefined) links.deps = (await depList(site, file, deps)).map((d) => depKey(file, d));
  if (before !== undefined) links.before = (await depList(site, file, before)).map((d) => depKey(file, d));
  const linked = [links.parent, ...links.related || [], ...links.deps || [], ...links.before || []];
  await refuseUnlinked(site, 'the request', words, linked);
  await refuseUnplaced(site, 'the request', words, { links: linked.filter(Boolean), repo: boardRepoOf(site, (await loadItemFile(site, file)).itemFile) });
  await refuseUnborn(site, words);
  // The reply goes before the ask's event, which a running board may file, and post its link lines, at once.
  await (await replyFirst(site, linked.filter(Boolean), replyOn))();
  const asked = by === 'orchestrator' ? { by } : { by, key: links.parent, ref: await cardName(site, links.parent) };
  const id = await appendEvent(boardTarget(site), 'ask', { text: words, asked, file, ...(Object.keys(links).length ? { links } : {}) });
  // A running board may file it first, as it takes the event.
  const key = await fileAsk(site, id, undefined, options) || (await askCardOf(site, id)).key;
  return { key, lines: [] };
}
// The links an ask carries, set on its card as it is made: its Parent, with a split's gates, its Related to and its
// deps, a dep in the card's own item file by its id alone.
async function askLinks(site, item, slug, links = {}) {
  if (links.parent) item.parent = links.parent;
  if (links.via === 'split') {
    const { gates } = (await loadItem(site, links.parent)).item;
    if (gates) item.gates = { ...gates };
  }
  if (links.related?.length) item.related = links.related;
  if (links.deps?.length) item.deps = links.deps.map((k) => (parseKey(k).file === slug ? parseKey(k).id : k));
}
// Once its card is written: the tasks it blocks gain it as a dep, and each link posts its line in both threads, but
// for a Related to line on another card, held while the card is New.
async function postAskLinks(site, key, links = {}, options) {
  const { item } = await loadItem(site, key);
  await blockLines(site, key, links.before || [], item.deps || [], options);
  await postLinkLines(site, key, { related: new Set(), parent: null }, await linksOf(site, key), { spunOut: true, held: inIntake(item) });
}

// The item file an ask's card goes in, {source, itemFile}: the one named slug, else the first there is; a file-items
// board starts its one file.
// A board over ~/.claude/waves with no item file yet has nowhere to file it, and filing never makes one, so the ask is refused.
async function askFile(site, slug) {
  const sources = await itemSources(site);
  for (const source of sources.filter((s) => slug === undefined || s.slug === slug)) {
    const itemFile = await readJSON(source.file, null);
    if (!itemFile) continue;
    if (!Array.isArray(itemFile.items)) fail(`${source.file} is not an item file with items[]`);
    return { source, itemFile };
  }
  if ((await boardConfig(site)).items === 'waves') fail('this board has no wave yet to file a new task in; start a wave first');
  await fs.mkdir(sources[0].dir, { recursive: true });
  return { source: sources[0], itemFile: { items: [] } };
}
// A New T-<n> card for ask, with its notes file. Run under the tickets lock.
async function newAskCard(site, source, ask, title) {
  const created = new Date().toISOString();
  const item = { id: await nextTaskId(site), title, created, lane: 'todo', lane_at: created, from_ask: ask.id };
  await askLinks(site, item, source.slug, ask.data?.links);
  item.plan = freeNotesName(source.dir, item.id);
  await writeNotesFile(path.join(source.dir, item.plan), `# ${item.title}\n`);
  return item;
}

// docs/adr/2026-11-09-2000-old-asks-migrate-into-cards-and-the-ask-only-records-retire.md
// Files every ask with no card of its own, in asked order: one not deleted, not folded or merged (data/ask-links.json,
// which also holds an archived card's own ask), not moved to another board (its thread's ask-moved line), and no live
// card's from_ask. One Claude answered before every ask was a card (a reply, a Claude line in its thread, a done mark in
// the retired data/ask-progress.json, or the owner's retired ask-done) becomes a Done card closed at its answer time:
// its newest reply or Claude line, else that mark. One still New becomes its New card, as fileAsk files it. Each takes
// the title triage gave it in the retired data/ask-titles.json, else its first line, and its item:ask:<id> questions
// move to its card's topic. Then the two retired files go. The board server runs it as it starts and when its built
// board lists an unfiled ask. → the keys it filed.
export const fileAsks = (site) => ticketWrite(site, async () => {
  needSite(site);
  const data = (...p) => path.join(site, 'data', ...p);
  const events = await readLog(data('events.jsonl'));
  const links = await readAskLinks(site);
  // Each ask's card by its id: a live card it became, else the card it went into.
  const carded = new Map(Object.entries(links));
  for (const s of await itemSources(site)) for (const it of (await readJSON(s.file, {})).items || []) if (it.from_ask) carded.set(it.from_ask, `${s.slug}/${it.id}`);
  const withdrawn = new Set(events.filter((e) => e.kind === 'ask-withdrawn').map((e) => e.data?.id));
  const asks = events.filter((e) => e.kind === 'ask' && !withdrawn.has(e.id) && !carded.has(e.id))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const marks = (await readJSON(data('ask-progress.json'), {})).asks || {};
  const titles = (await readJSON(data('ask-titles.json'), {})).titles || {};
  const dones = new Map(events.filter((e) => e.kind === 'ask-done').map((e) => [e.data?.id, String(e.ts)]));
  const filed = [];
  let target;
  for (const ask of asks) {
    const thread = await readLog(threadFile(site, `ask:${ask.id}`));
    if (thread.some((m) => m.line === 'ask-moved')) continue;
    const replies = await Promise.all((await replyFilesOf(data('replies'), ask.id)).map((f) => fs.stat(data('replies', f.name)).then((st) => st.mtime.toISOString())));
    const said = thread.filter((m) => (m.who || 'claude') === 'claude' && m.kind !== 'status').map((m) => String(m.ts));
    const answeredAt = [...replies, ...said].sort().pop() || [routeRecord(marks, ask.id)?.at, dones.get(ask.id)].filter(Boolean).sort().pop();
    target ||= await askFile(site);
    const item = await newAskCard(site, target.source, ask, routeRecord(titles, ask.id) || askTitle(ask, events));
    item.created = ask.ts;
    if (answeredAt) placeIn(item, 'done', answeredAt);
    target.itemFile.items.push(item);
    // Each card is written as it is made, so the next one's number counts it.
    await writeJSON(target.source.file, target.itemFile);
    carded.set(ask.id, `${target.source.slug}/${item.id}`);
    await postAskLinks(site, carded.get(ask.id), ask.data?.links);
    filed.push(carded.get(ask.id));
  }
  const cardOf = (topic) => carded.get(/^item:ask:(.+)$/.exec(topic || '')?.[1]);
  const owner = await readJSON(ownerFile(site), null);
  if (owner?.items?.some((q) => cardOf(q.topic))) {
    for (const q of owner.items) if (cardOf(q.topic)) q.topic = `item:${cardOf(q.topic)}`;
    await writeJSON(ownerFile(site), owner);
  }
  for (const f of ['ask-progress.json', 'ask-titles.json']) await remove(data(f));
  return filed;
});

// Retitles the New card ask eventId became from the ask's latest text, as an edit changes it. → its key, or null.
export const retitleAskCard = (site, eventId) => ticketWrite(site, async () => {
  const card = await askCardOf(needSite(site), eventId);
  if (!card || !stillNew(card.item)) return null;
  const events = await readLog(path.join(site, 'data', 'events.jsonl'));
  card.item.title = askTitle(events.find((e) => e.id === eventId && e.kind === 'ask'), events);
  await writeJSON(card.source.file, card.itemFile);
  return card.key;
});

// Takes card out of its item file with its notes and thread file, keeping the task number it had as the file's
// last_task, so nextTaskId never issues it again. → the thread lines it had.
async function dropCard(site, { source, itemFile, item, key }) {
  itemFile.items = itemFile.items.filter((i) => i !== item);
  const n = Number(/^T-([1-9]\d*)$/.exec(item.id)?.[1] || 0);
  if (n > (Number(itemFile.last_task) || 0)) itemFile.last_task = n;
  await writeJSON(source.file, itemFile);
  if (item.plan) await remove(path.join(source.dir, item.plan));
  const thread = threadFile(site, key);
  const lines = await readLog(thread);
  await remove(thread);
  return lines;
}

// The owner deleted ask eventId's message: its card goes, with no Done row, while it is still New. → its key, or null.
export const dropAskCard = (site, eventId) => ticketWrite(site, async () => {
  const card = await askCardOf(needSite(site), eventId);
  if (!card || !stillNew(card.item)) return null;
  await dropCard(site, card);
  return card.key;
});

// docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md
// docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md: the orchestrator answers the card an ask became
// (reply <file>/<id>, or reply <ask event id>), which starts its discussion: md is a message in its thread unless the
// reply file holds it, title retitles the card, and the card reads discussing in Todo. A discussing card answers again.
const answerable = (item) => [undefined, 'discussing'].includes(item.phase) && !leftTodo(item) && !hasPR(item);
// waitsOn (implement | close) marks it waiting on the owner in the phase the answer leaves it in.
async function markAnswered(site, card, title, waitsOn) {
  const { item, key } = card;
  if (!item.from_ask) fail(`${key} is not a task an ask became; write in its thread with thread ${key} --text`);
  if (!answerable(item)) fail(`${key} is sorted (${item.phase || LANES[item.lane]}), so it is work: write in its thread with thread ${key} --text`);
  if (title !== undefined) item.title = cardTitle(title);
  leaveNew(item);
  item.phase = 'discussing';
  dropOwed(item);
  delete item.unfiled;
  delete item.filed_held;
  if (waitsOn) item.waits_on_owner = ownerMark(item, waitsOn);
  await writeJSON(card.source.file, card.itemFile);
}
// Refuses filing ask eventId onto a card other than key when the board already filed it as its own.
async function refuseFiled(site, eventId, key) {
  const card = await askCardOf(site, eventId);
  if (card && card.key !== key) fail(`ask "${eventId}" is already task ${card.key}: sort it with item set ${card.key} --phase, or merge it with item relate-ask ${eventId} <task>`);
}
export async function answerCard(site, key, md, title, { waitsOn } = {}) {
  needSite(site);
  const { source, itemFile, item } = await loadItem(site, key);
  const card = { source, itemFile, item, key };
  messageText(md);
  if (title !== undefined) cardTitle(title);
  await markAnswered(site, card, title, waitsOn);
  return appendMessage(site, key, { text: md });
}

export async function relateAsk(site, eventId, key, summary) {
  needSite(site);
  domId(eventId, 'the event id');
  const known = (await readLog(path.join(site, 'data', 'events.jsonl'))).some((e) => e.id === eventId && e.kind === 'ask');
  if (!known) fail(`no ask "${eventId}" in this site's data/events.jsonl`);
  await refuseMoved(site, eventId);
  await loadItem(site, key);
  text(summary, '--summary');
  // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: a New card the ask became merges
  // into key: it goes, its thread lines move to the ask's thread, which key's thread shows, and a card-merged line there
  // names key. A card already sorted is work of its own.
  const card = await askCardOf(site, eventId);
  if (card && card.key === key) fail(`ask "${eventId}" is ${key} already`);
  if (card && !stillNew(card.item)) fail(`ask "${eventId}" became ${card.key}, which is sorted; to fold that task's notes into ${key}, use item notes ${key} --from ${card.key}, then close it`);
  if (card) {
    const moved = await ticketWrite(site, () => dropCard(site, card));
    const askThread = threadFile(site, `ask:${eventId}`);
    for (const line of moved) await appendLine(askThread, line);
    // The New strip shows the merged card's title (domain.mjs merges).
    await appendLine(askThread, { ts: new Date().toISOString(), who: 'claude', kind: HUB, line: 'card-merged', text: hubText('card-merged', { card: await cardName(site, key) }),
      into: key, title: card.item.title, link: `#selectedCard=${encodeURIComponent(key)}` });
  }
  const links = await readAskLinks(site);
  await writeJSON(askLinksFile(site), { links: { ...links, [eventId]: key } });
  await appendMessage(site, key, { text: summary });
  return askLinksFile(site);
}

// docs/adr/2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md
// The orchestrator's first move on a card still in intake (a New card an ask became, or one an agent added unfiled),
// from what it knows of the board: one call sets its title, phase and links, which sorts it and ends its intake wait,
// and posts nothing in its thread: the owner's message stays alone there, reading thinking until the first real reply.
// visual sorts it discussing, for the visual's brief. foldInto, for a duplicate, merges the New card into that task as
// item relate-ask does, a line on both.
export const TRIAGE_PHASES = ['discussing', 'grilling', 'prototyping', 'visual'];
const inIntake = (item) => (item.from_ask ? stillNew(item) : Boolean(item.unfiled) && !item.phase);
// Every command that writes to a card refuses while it is still in intake: item triage is the one that sorts it.
// A name without a "/" is an ask's event id: the card the ask became is the one written to, if it has one.
export async function refuseInIntake(site, keys) {
  for (const name of keys) {
    const card = name.includes('/') ? { key: name, ...(await loadItem(site, name)) } : await askCardOf(needSite(site), name);
    if (!card) continue;
    const { key, item } = card;
    if (inIntake(item)) fail(`${key} is still in New: sort it first with item triage ${key} --title "<type>(<scope>): <summary>" --phase ${TRIAGE_PHASES.join('|')}, or --fold-into <task>; a Quick build ask goes item notes ${key}, then item set ${key} --phase ready --size small --from-ask <id>`);
  }
}
export async function triageItem(site, key, { title, phase, relate, parent, split, deps, ticket, text: said, foldInto, replyOn }, options) {
  needSite(site);
  const { item } = await loadItem(site, key);
  if (!inIntake(item)) fail(`${key} is sorted (${item.phase || LANES[item.lane]}), so item triage has nothing to do; change it with item set ${key}`);
  if (said !== undefined) messageText(said);
  if (foldInto !== undefined) {
    if ([title, phase, relate, parent, split, deps, ticket, replyOn].some((v) => v !== undefined)) fail('--fold-into closes the task into another; it takes only --text');
    if (!item.from_ask) fail(`${key} is no New task an ask became, so there is nothing to fold; file it with item triage ${key} --title --phase, then close it with item set ${key} --done`);
    const summary = `Triaged: folded in ${await cardName(site, key)} "${item.title}"${said === undefined ? '' : `; ${said}`}`;
    await relateAsk(site, item.from_ask, foldInto, summary);
    return { lines: [] };
  }
  if (title === undefined || phase === undefined) fail(`item triage needs --title "<type>(<scope>): <summary>" and --phase ${TRIAGE_PHASES.join('|')}, or --fold-into <task> for a duplicate`);
  if (!TRIAGE_PHASES.includes(phase)) fail(`item triage --phase takes ${TRIAGE_PHASES.join(', ')}; ready follows the investigation, with item set ${key} --phase ready`);
  if (said !== undefined) fail('item triage --text goes only with --fold-into, whose line it joins; a triaged task shows no Triaged line, so put what you know in its notes (item notes)');
  if (item.from_ask) {
    const file = parseKey(key).file;
    const links = new Set(await linkedWith(site, key));
    for (const k of [parent, ...String(relate ?? '').split(','), ...String(deps ?? '').split(',')]) if (k !== undefined && k.trim()) links.add(depKey(file, k.trim()));
    await refuseUnplaced(site, 'the ask', await askWordsOf(site, item.from_ask), { links: [...links], ticket: ticket ?? item.ticket, repo: boardRepoOf(site, (await loadItemFile(site, file)).itemFile), canTicket: true });
  }
  return setItem(site, key, { title, phase: phase === 'visual' ? 'discussing' : phase, relate, parent, split, deps, ticket, replyOn, triaged: true }, options);
}

// Moves a folded ask back out of the card it was folded into, to a card of its own.
export async function unfoldAsk(site, eventId) {
  await checkAsk(site, eventId, 'the ask');
  const links = await readAskLinks(site);
  if (routeRecord(links, eventId) === undefined) fail(`ask "${eventId}" is not folded into a task`);
  delete links[eventId];
  await writeJSON(askLinksFile(site), { links });
  return askLinksFile(site);
}

// The ask-moved line moveAsk wrote in ask eventId's thread when it sent the ask to another board, or undefined: the
// ask lives there now, at the line's link.
const movedLine = async (site, eventId) => (await readLog(threadFile(site, `ask:${eventId}`))).find((m) => m.line === 'ask-moved');
async function refuseMoved(site, eventId) {
  const moved = await movedLine(site, eventId);
  if (moved) fail(`ask "${eventId}" was moved to ${moved.link}; it lives there now`);
}

// Why an ask is no longer New on this board, or null. An ask that became work items is New to moveAsk while none of
// them has started; it returns them as `items`.
async function askNotNew(site, eventId, events) {
  const named = `ask "${eventId}"`;
  if (events.some((e) => e.kind === 'ask-withdrawn' && e.data?.id === eventId)) return { why: `${named} was deleted by the owner` };
  const moved = await movedLine(site, eventId);
  if (moved) return { why: `${named} was already moved to ${moved.link}` };
  const folded = routeRecord(await readAskLinks(site), eventId);
  if (folded) return { why: `${named} is folded into ${folded}; run ask unfold ${eventId} first` };
  const items = [];
  for (const s of await itemSources(site)) {
    const itemFile = await readJSON(s.file, null);
    for (const it of Array.isArray(itemFile?.items) ? itemFile.items : []) if (it.from_ask === eventId) items.push({ key: `${s.slug}/${it.id}`, it });
  }
  const started = items.find(({ it }) => hasPR(it) || leftTodo(it) || it.answered_at || it.phase === 'discussing');
  if (started) return { why: `${named} became ${started.key}, which has started or been answered` };
  return items.length ? { items: items.map((i) => i.key) } : null;
}

// A copy of an upload in another site's data/uploads under a fresh stored name, or the file's name alone when this
// site no longer has it, so the other board never shows a broken link.
export async function copyUpload(from, to, f) {
  const file = /^uploads\/([\w.-]+)$/.exec(f?.url || '')?.[1];
  const src = STORED.test(file || '') ? path.join(uploadsDir(from), file) : null;
  if (!src || !(await fs.stat(src).then((s) => s.isFile(), () => false))) return { name: String(f?.name || file || 'file') };
  await fs.mkdir(path.dirname(uploadMeta(to, 'x')), { recursive: true });
  const safe = file.replace(/^\d+-/, '');
  let name;
  for (let t = Date.now(); ; t++) {
    name = `${t}-${safe}`;
    const copied = await fs.copyFile(src, path.join(uploadsDir(to), name), fsConstants.COPYFILE_EXCL).then(() => true, (e) => (e.code === 'EEXIST' ? false : Promise.reject(e)));
    if (copied) break;
  }
  const meta = await readJSON(uploadMeta(from, file), null);
  if (meta) await writeJSON(uploadMeta(to, name), meta);
  return { ...f, url: `uploads/${name}`, path: path.join(uploadsDir(to), name) };
}

// Sends a New ask to another board in the hub's manifest: there, an `ask` event with the owner's latest text, copies
// of its uploads and `from {route, title, id}`, which wakes that board's session; here, an ask-moved line in the ask's
// thread linking to its card there, which says it lives there now (movedLine). Cards the ask became, none of them started, are dropped, leaving
// no Done row (docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md).
// note, from handoff, is the sender's words, which the other board quotes under the ask.
export async function moveAsk(site, eventId, route, { note, command = 'ask move' } = {}) {
  needSite(site);
  domId(eventId, 'the event id');
  const target = targetBoard(site, route, command);
  const events = await readLog(path.join(site, 'data', 'events.jsonl'));
  const ask = events.find((e) => e.id === eventId && e.kind === 'ask') || fail(`no ask "${eventId}" in this site's data/events.jsonl`);
  const state = await askNotNew(site, eventId, events);
  if (state?.why) fail(state.why);
  const edits = events.filter((e) => e.kind === 'ask-edited' && e.data?.id === eventId && typeof e.data?.text === 'string')
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const edited = edits.at(-1);
  const files = [];
  for (const f of [...(ask.data?.files || []), ...edits.flatMap((e) => e.data.files || [])]) files.push(await copyUpload(site, target.dir, f));
  const from = { route: path.basename(site), title: (await boardConfig(site)).title, id: eventId };
  const body = edited ? edited.data.text : ask.data?.text || '';
  const id = await appendEvent(target, 'ask', { text: body, ...(files.length ? { files } : {}), from, ...noteOf(note) });
  const link = `/${route}/#selectedCard=${encodeURIComponent(`ask:${id}`)}`;
  await appendStatus(site, `ask:${eventId}`, 'ask-moved', { board: target.title }, { link });
  for (const key of state?.items || []) {
    const { source, itemFile, item } = await loadItem(site, key);
    await ticketWrite(site, () => dropCard(site, { source, itemFile, item, key }));
  }
  return { file: path.join(target.dir, 'data', 'events.jsonl'), lines: [`moved to ${link}`, ...(state?.items || []).map((k) => `dropped: ${k}`)] };
}
// The board at route in the hub's manifest, other than this one, that command sends work to. named is how a refusal
// names the route the command was given.
function targetBoard(site, route, command, named = `--to ${route}`) {
  if (typeof route !== 'string' || !route.trim()) fail(`${command} needs --to <route>, the board to move it to`);
  const boards = listBoards();
  const target = boards.find((b) => b.route === route)
    || fail(`${named}: no board at /${route} in the hub's manifest; the boards are ${boards.map((b) => b.route).join(', ') || 'none'}`);
  if (samePath(target.dir, site)) fail(`${named}: that is this board`);
  return target;
}

// docs/adr/2026-11-15-0200-a-board-asks-another-board-and-its-orchestrator-answers.md
// A question this board put to another board in the hub, one line each in data/board-asks.jsonl {id, to, text, key?,
// at}: id is the board-ask event's on the board at route `to`, key the card it was asked from. Its answer comes back as
// a board-answer {id, from, key?, question, text} event in this board's log (answerBoardAsk).
const boardAsksFile = (site) => path.join(site, 'data', 'board-asks.jsonl');
// Asks the board at route a one-line question: there, a board-ask {text, from {route, title, key?, ref?}} event, which
// wakes its orchestrator, shows in its New strip and waits on it until answered (domain.mjs boardAskWaits); while no
// orchestrator listens there, the event waits in its log. Here, the record, and on card from, if given, the quiet
// "Asked <route>: <question>" line.
export async function askBoard(site, route, question, { from } = {}) {
  needSite(site);
  const words = text(question, 'ask');
  if (/\n/.test(words)) fail('ask takes one line; ask each question on its own');
  const target = targetBoard(site, route, 'ask', `ask ${route}`);
  if (from !== undefined) await loadItem(site, from);
  const asker = { route: path.basename(site), title: (await boardConfig(site)).title, ...(from !== undefined ? { key: from, ref: await cardName(site, from) } : {}) };
  const id = await appendEvent(target, 'board-ask', { text: words, from: asker });
  await appendLine(boardAsksFile(site), { id, to: route, text: words, ...(from !== undefined ? { key: from } : {}), at: new Date().toISOString() });
  if (from !== undefined) await appendStatus(site, from, 'board-asked', { route, question: words });
  return { id, lines: isListening(target) ? [] : [`queued: /${route}'s orchestrator isn't listening, so it answers once it is`] };
}

// The orchestrator's answer to question id another board asked this one: here, a board-ask-answered {id, text} event,
// record-only, which ends its wait and its New strip entry; on the asking board, the answer as an ordinary message
// on the card it was asked from, written as this board's route with via board, and a board-answer event, which wakes
// that board's orchestrator. The record here goes last, so an answer that didn't reach the asking board still waits.
export async function answerBoardAsk(site, id, answer) {
  needSite(site);
  const words = messageText(answer);
  const ask = boardAsksOf(await readLog(path.join(site, 'data', 'events.jsonl'))).find((a) => a.id === id)
    || fail(`no question "${id}" from another board on this board; the waits lines name each one`);
  if (ask.answer) fail(`question ${id} is already answered`);
  const asker = listBoards().find((b) => b.route === ask.from.route)
    || fail(`/${ask.from.route}, which asked question ${id}, is no longer in the hub's manifest`);
  const here = { route: path.basename(site), title: (await boardConfig(site)).title };
  if (ask.from.key) await appendMessage(asker.dir, ask.from.key, { text: words, who: here.route, via: 'board' });
  await appendEvent(asker, 'board-answer', { id, from: here, ...(ask.from.key ? { key: ask.from.key } : {}), question: ask.text, text: words });
  await appendEvent(boardTarget(site), 'board-ask-answered', { id, text: words });
  return { route: ask.from.route, lines: [] };
}

// → {lines}: each question this board asked, then its answer, or whether the other board's orchestrator is listening
// for it. With wait it blocks until none waits, giving up after timeout minutes, polling every ms, as builder asks
// --wait does (listAsks).
export async function listBoardAsks(site, { wait = false, timeout = 9, every = 2000, now = Date.now } = {}) {
  needSite(site);
  const minutes = Number(timeout);
  if (!(minutes > 0)) fail('--timeout takes minutes, a number above 0');
  const deadline = now() + minutes * 60_000;
  for (;;) {
    const asks = await readLines(boardAsksFile(site));
    if (!asks.length) return { lines: ['no asks yet'] };
    const answers = new Map((await readLog(path.join(site, 'data', 'events.jsonl'))).filter((e) => e.kind === 'board-answer').map((e) => [e.data?.id, e.data?.text]));
    const boards = listBoards();
    const state = (a) => {
      if (answers.has(a.id)) return `answered: ${answers.get(a.id)}`;
      const board = boards.find((b) => b.route === a.to);
      return board && isListening(board) ? `waiting on /${a.to}'s orchestrator` : `queued: /${a.to}'s orchestrator isn't listening`;
    };
    const lines = asks.flatMap((a) => [`${a.id} /${a.to}: ${a.text}`, `  ${state(a)}`]);
    const waiting = asks.filter((a) => !answers.has(a.id));
    if (!wait || !waiting.length) return { lines };
    if (now() >= deadline) fail(`${waiting.map((a) => a.id).join(', ')} still waiting on ${[...new Set(waiting.map((a) => `/${a.to}`))].join(', ')} after ${minutes} minutes; run asks --wait again`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}
const noteOf = (note) => (String(note ?? '').trim() ? { note: String(note).trim() } : {});

// docs/adr/2026-11-14-2340-handoff-moves-a-ticket-to-another-board-and-leaves-a-pointer.md
// Hands ref, a card's key or an ask's event id, to the board at route. A New ask, or a card still New from one, moves as
// moveAsk does. Any other card is filed there as an ask, its title and a link to its notes here, with `from {route,
// title, key, ref}` and note, and filed into its task there at once; here its thread gets a grey Handed to line linking
// that task, and it stays open as a pointer, unless done, a full handoff, closes it with the existing done.
export async function handoff(site, ref, { to, note, done } = {}) {
  needSite(site);
  if (!String(ref).includes('/')) return moveAsk(site, ref, to, { note, command: 'handoff' });
  const target = targetBoard(site, to, 'handoff');
  const { item } = await loadItem(site, ref);
  const events = await readLog(path.join(site, 'data', 'events.jsonl'));
  if (item.from_ask && (await askNotNew(site, item.from_ask, events))?.items?.includes(ref)) return moveAsk(site, item.from_ask, to, { note, command: 'handoff' });
  // Refused here, before anything is sent, when the other board has nowhere to file the task.
  await askFile(target.dir);
  const route = path.basename(site);
  const notes = item.plan ? `\n\nNotes: /${route}/notes.html?item=${encodeURIComponent(ref)}` : '';
  const from = { route, title: (await boardConfig(site)).title, key: ref, ref: await cardName(site, ref) };
  const id = await appendEvent(target, 'ask', { text: `${item.title}${notes}`, from, ...noteOf(note) });
  // A running board files the ask as it takes the event; one that is down, here.
  await fileAsk(target.dir, id);
  const made = await askCardOf(target.dir, id);
  const handed = { route: to, ref: await cardName(target.dir, made.key) };
  const link = `/${to}/#selectedCard=${encodeURIComponent(made.key)}`;
  await appendStatus(site, ref, 'handed-to', handed, { link });
  const closed = done ? await setItem(site, ref, { done: true, closing: ['handed-closed', handed] }) : null;
  return { file: path.join(target.dir, 'data', 'events.jsonl'), lines: [`handed to ${link}`, ...(closed?.lines || [])] };
}

// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
// data/reviews.json {<number>: {number, title, author, url, touches, asked, head, state: posted|needs, text, review_url?,
// at}}: the session's review of an incoming PR, at the head the hub's poll last listed for it in data/incoming.json, or
// at the head its last review saw once the PR has left that list (board/auto-review.mjs reviewsOf).
export async function recordReview(site, number, { state, text } = {}) {
  needSite(site);
  if (!['posted', 'needs'].includes(state)) fail('review record needs --state posted or --state needs');
  if (!String(text ?? '').trim()) fail('review record needs the review text, as --text or --file');
  return saveReview(site, await incomingPR(site, number, 'review record'), { state, text });
}

// The incoming PR number as the hub last listed it in data/incoming.json, else as its last review saw it, with the repo
// it is in: incoming.json's, else the board's.
async function incomingPR(site, number, command) {
  if (!/^[1-9]\d{0,6}$/.test(String(number))) fail(`${command} takes the PR number, such as 437, not "${number}"`);
  const incoming = await readJSON(path.join(site, 'data', 'incoming.json'), {});
  const listed = (incoming?.prs || []).find((p) => p.number === Number(number));
  const pr = listed || (await readJSON(path.join(site, 'data', 'reviews.json'), {}))[number] || fail(`PR #${number} is not an incoming PR on this board`);
  return { ...pr, repo: incoming?.repo || boardRepoOf(site, {}) };
}

async function saveReview(site, { number, title, author, url, touches = [], asked = false, head }, { state, text, review_url }) {
  const file = path.join(site, 'data', 'reviews.json');
  const records = await readJSON(file, {});
  records[number] = { number: Number(number), title, author, url, touches, asked, head, state, text, ...(review_url ? { review_url } : {}), at: new Date().toISOString() };
  await writeJSON(file, records);
  return { file, lines: [] };
}

// `review post`: the session's words as one Comment review on an incoming PR at its listed head, as the board's
// github-login, under the board's header and the claude-bridge marker, then recorded as posted with the review's link.
// It refuses, posting nothing, when another review landed after readAt, which it requires. → {lines}
export async function postIncomingReview(site, number, { words, readAt }) {
  needSite(site);
  const pr = await incomingPR(site, number, 'review post');
  const text = String(words ?? '').trim() || fail('review post needs the review text, as --file');
  const header = `${CLAUDE_PREFIX}Claude review from the ${(await boardConfig(site)).title} board`;
  if (text.startsWith(CLAUDE_PREFIX.trim()) || text.includes('Claude review from') || text.includes(CLAUDE_MARK)) fail(`review post adds the ${CLAUDE_PREFIX.trim()} header and the claude-bridge marker itself; pass only your words`);
  const repo = pr.repo || fail('review post needs a board on GitHub; this board has no repo there');
  if (Number.isNaN(Date.parse(readAt))) fail('--read-at takes the time you read the PR, such as 2026-11-05T09:30:00Z');
  const login = settingsOf(await boardConfig(site)).github_login;
  try {
    const newer = await reviewsSince({ repo, pr: pr.number, since: readAt });
    if (newer.length) fail(`PR #${number} got ${newer.length === 1 ? 'a review' : `${newer.length} reviews`} after ${readAt} (${newer.map((r) => `${r.login} at ${r.at}`).join(', ')}); reread the PR and review again`);
    const review_url = await postReview({ repo, pr: pr.number, head: pr.head, body: `${header}\n\n${text}\n\n${CLAUDE_MARK}`, login });
    await saveReview(site, pr, { state: 'posted', text, review_url });
    return { lines: [`posted review on PR #${number}: ${review_url}`] };
  } catch (e) { if (e instanceof BoardError) throw e; fail(e.message); }
}

// The held review of PR number, from data/reviews.json: the one `review record --state needs` wrote and the owner has not
// answered. Refuses a PR with no held review.
export async function heldReview(site, number) {
  const rec = (await readJSON(path.join(site, 'data', 'reviews.json'), {}))[number];
  if (rec?.state !== 'needs') fail(`PR #${number} has no held review to answer`);
  return rec;
}

// The owner's Post it or Skip on a held review, applied without the orchestrator: Skip records the review posted, as
// `review record` does, and Post posts the held text as `review post` does, read at the time the review was held.
// → {lines}
export async function applyReviewAnswer(site, number, answer) {
  const held = await heldReview(site, number);
  if (answer === 'post') return postIncomingReview(site, number, { words: held.text, readAt: held.at });
  if (answer !== 'skip') fail(`a review answer is post or skip, not "${answer}"`);
  return recordReview(site, number, { state: 'posted', text: held.text });
}

// The join handshake (docs/adr/2026-10-29-1639-one-board-registry-for-every-hub-feature.md): data/handshake.json
// {ping: {id, at, session}, ack: {id, at} | null, done_at?}, written by hub/boards.mjs handshake.
// A file an older board wrote keeps its ping under `hello`, which reads as the ping.
// The board shows its setup checklist until the session acks the newest ping and the hub's GitHub check reaches it.
const handshakeFile = (site) => path.join(site, 'data', 'handshake.json');
export async function readHandshake(site) {
  const h = await readJSON(handshakeFile(site), null);
  if (!h?.hello) return h;
  const { hello, ...rest } = h;
  return { ...rest, ping: rest.ping || hello };
}

export async function ackPing(site, eventId) {
  needSite(site);
  domId(eventId, 'the event id');
  const event = (await readLog(path.join(site, 'data', 'events.jsonl'))).find((e) => e.id === eventId);
  if (event?.kind !== 'ping' && event?.kind !== 'hello') fail(`no ping event "${eventId}" in this site's data/events.jsonl`);
  const h = (await readHandshake(site)) || {};
  if (h.ping?.id && h.ping.id !== eventId) fail(`"${eventId}" is an older ping; ack the newest, "${h.ping.id}"`);
  await writeJSON(handshakeFile(site), { ...h, ping: h.ping || { id: eventId, at: event.ts, session: null }, ack: { id: eventId, at: new Date().toISOString() } });
  return handshakeFile(site);
}

// The board server marks the checklist done once both pass, so a later broken link shows on the Hub links dot, not as setup.
export async function finishHandshake(site) {
  const h = await readHandshake(site);
  if (h && !h.done_at) await writeJSON(handshakeFile(site), { ...h, done_at: new Date().toISOString() });
}

// Board and item file reviewers share {name, slack_user, dm, github}.
const REVIEWER_FIELDS = { name: /^[^\n]{1,40}$/, slack_user: /^U[A-Z0-9]+$/, dm: /^D[A-Z0-9]+$/, github: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/ };
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
function checkReviewers(list, name) {
  if (!Array.isArray(list)) fail(`${name} must be a JSON array of reviewers`);
  list.forEach((r, i) => {
    const at = `${name}[${i}]`;
    onlyKeys(r, Object.keys(REVIEWER_FIELDS), at);
    for (const [k, re] of Object.entries(REVIEWER_FIELDS)) if (typeof r[k] !== 'string' || !re.test(r[k].trim())) fail(`${at}.${k} must match ${re}`);
    if (list.slice(0, i).some((o) => sameName(o.name, r.name))) fail(`${name} names "${r.name}" twice`);
  });
  return list.map((r) => Object.fromEntries(Object.keys(REVIEWER_FIELDS).map((k) => [k, r[k].trim()])));
}

// The board's list, also written to each item file with an unfinished card, so its open PRs reach the same people.
async function writeReviewers(site, change) {
  const { file, reviewers } = await writeBoardJSON(site, (cfg) => {
    const reviewers = checkReviewers(change(cfg.reviewers || []), 'the reviewers');
    return { set: { reviewers }, reviewers };
  });
  const lines = [];
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    if (!(itemFile?.items || []).some((it) => !closed(it))) continue;
    await writeJSON(source.file, { ...itemFile, reviewers });
    lines.push(`item file ${source.slug}: reviewers copied`);
  }
  return { file, lines };
}

export const setReviewers = (site, list) => writeReviewers(site, () => checkReviewers(list, 'the reviewer file'));

// docs/adr/2026-11-07-0300-slack-sends-hang-off-prs-and-go-out-from-the-hub-tick.md,
// docs/adr/2026-11-11-1600-review-posts-go-into-one-day-thread-per-board.md,
// docs/adr/2026-11-12-0044-a-day-thread-carries-only-each-prs-link.md
// data/pr-slack.json {<owner/repo#n>: {links: {<reviewer>: {channel, thread_ts, ts, reactions: [emoji]}},
// replies: [{id, text, to: {<reviewer>: {channel?, ts, reactions}}}]}}: each PR's Slack messages, apart from the cards
// that hold it. Every reviewer of a PR has their own link message, in the owner's DM with them: a reply in that day's
// thread when it has thread_ts, else posted top-level before the day threads. replies are the PR's other messages
// already posted, which get the link's reactions: a one-PR digest reply, and the bumps sent before they stopped; one
// never posted is never sent. A message carries ts once posted, and posting_at while its post is out or after its ts
// couldn't be recorded; either way it is never posted again.
const prSlackFile = (site) => path.join(needSite(site), 'data', 'pr-slack.json');
export const readPRSlack = (site) => readJSON(prSlackFile(site), {});
const held = (message) => Boolean(message?.ts || message?.posting_at);
// Whether a reviewer is owed a PR's link: the hub last read it open and out of draft, and its link isn't held.
const linkOwed = (gh, record, pr, name) => gh?.state === 'OPEN' && !gh.isDraft && !held(record[pr]?.links?.[name]);

// One locked read, edit and write of a JSON object file. → edit's answer
async function editJSON(file, edit) {
  return withFileLock(file, async () => {
    const value = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'));
    const out = edit(value);
    await replace(file, JSON.stringify(value, null, 2) + '\n');
    return out;
  });
}

// Posts one Slack message at most once. find(file's object) → the message's record. It is marked posting, posted, then
// given its ts. A post that throws is unmarked, to go again next poll; a ts that can't be recorded leaves it marked.
async function postOnce(file, find, post) {
  await editJSON(file, (all) => {
    const message = find(all);
    if (held(message)) fail('that Slack message has already gone out');
    message.posting_at = new Date().toISOString();
  });
  let ts;
  try { ts = await post(); } catch (e) {
    await editJSON(file, (all) => { delete find(all).posting_at; });
    throw e;
  }
  try {
    await editJSON(file, (all) => { const message = find(all); message.ts = ts; delete message.posting_at; });
  } catch (e) { fail(`posted, but its record failed, so it won't go again: ${e.message}`); }
  return ts;
}

// due: one of review due's links; thread: the reviewer's day thread {channel, ts}; post() → ts.
export const postLink = (site, due, thread, post) => postOnce(prSlackFile(site), (all) => {
  const rec = all[due.pr] ||= { links: {}, replies: [] };
  return Object.assign(rec.links[due.reviewer] ||= { reactions: [] }, { channel: thread.channel, thread_ts: thread.ts });
}, post);
// due: one of review due's reactions, once Slack has it. due.reply is the reply's index in the PR's replies, and absent
// for the reviewer's link; a due whose message isn't there is a bug.
export const recordReaction = (site, due) => editJSON(prSlackFile(site), (all) => {
  const rec = all[due.pr];
  const message = due.reply === undefined ? rec?.links[due.reviewer] : rec?.replies[due.reply]?.to[due.reviewer];
  if (!message) fail(`no recorded Slack message for ${due.reviewer} on ${due.pr}${due.reply === undefined ? '' : ` reply ${due.reply}`}`);
  message.reactions = [...new Set([...(message.reactions || []), due.emoji])];
});

// docs/adr/2026-11-14-0451-a-prs-slack-link-is-a-bar-coloured-by-the-builders-risk.md
// docs/adr/2026-11-14-2300-every-pr-message-is-the-bar-with-no-mention.md
// A PR's message in a day thread, the one PR message format every sender uses (the first-day link, each digest reply, a
// session's `slack link`): no text, and one attachment whose colour bar is the card's risk (grey with none), headed by
// the card's ticket id linking its issue (the attachment's small author line; none without a ticket), titled by the
// PR's title linking the PR, then “+N/-M · K files · <risk> risk”, the size from GitHub and the risk word repeating the
// colour, then from two days old its own line, “_(N days old)_”. The Slack client signs off the attachment's text, so
// the sign-off stays the message's last line. ticket: ticketBadge's {id, url}; old: whole days since the PR's first
// link to that reviewer, when over two. → {text, attachments}
const RISKS = ['low', 'medium', 'high'];
const RISK_COLOURS = { low: '#2eb67d', medium: '#e8912d', high: '#e01e5a' };
const NO_RISK_COLOUR = '#9e9e9e';
function prLink(pr, gh, item, { ticket, old } = {}) {
  const [repo, number] = pr.split('#');
  const title = gh.title || item.title;
  const size = Number.isInteger(gh.additions) ? [`+${gh.additions}/-${gh.deletions}`, `${gh.files} file${gh.files === 1 ? '' : 's'}`] : [];
  const line = [...size, item.risk && `${item.risk} risk`].filter(Boolean).join(' · ');
  const age = old && `(${old} days old)`;
  return {
    text: '',
    attachments: [{
      color: RISK_COLOURS[item.risk] || NO_RISK_COLOUR, ...(ticket ? { author_name: ticket.id, author_link: ticket.url } : {}),
      title, title_link: prURL({ repo, number }), text: [line, age && `_${age}_`].filter(Boolean).join('\n'),
      fallback: [ticket?.id, `${repo.split('/').pop()}#${number} ${title}`, line, age].filter(Boolean).join(' · '),
    }],
  };
}
// A card's ticket for its PR's message, null without one.
const ticketOfCard = (cfg, item, repo) => (cfg.tickets ? ticketBadge(storedTickets(cfg.tickets), item.ticket, { repo }) : null);
// docs/adr/2026-11-12-1400-a-chip-per-pr-reviewer-and-git-approved-waits-for-githubs-decision.md: a PR is approved on
// GitHub's review decision, which counts a code owner's approval when the branch asks for one; on a branch that asks
// for no review (no decision) any human approval does (hub/pr-report.mjs leaves a bot's out of `approved`). The digest,
// review due's headers and the git_approved reaction all ask this one test.
// A reviewer's digest holds a PR while GitHub still needs an approval for it (its decision is neither APPROVED nor empty,
// as on a branch that asks for no review) and that reviewer, by their github login, has not approved it themselves; the
// approval of a bot or another person takes it out of nobody else's digest.
const waitsOn = (gh, github) => Boolean(gh.reviewDecision) && gh.reviewDecision !== 'APPROVED' && !(github && gh.reviews?.[github] === 'APPROVED');
const approved = (gh) => (gh?.reviewDecision ? gh.reviewDecision === 'APPROVED' : Boolean(gh?.approved));

// docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md
// `review due`: each Slack send still owed, from local state with no GitHub call; the hub sends them each poll.
// date: the Slack day, whose thread a link goes in. links: a fresh link to each reviewer of a card's PR that the hub
// last read open and out of draft, once per PR. reactions: git_approved once approved, then git_merged on merge
// or x on a close, on each posted link and reply. digest: review digest's answer while one is due, else null. While
// Slack isn't ready → waiting and nothing owed.
export async function reviewDue(site, options) {
  needSite(site);
  const waiting = await readiness.waiting('slack');
  if (waiting) return { waiting, links: [], reactions: [], headers: [], digest: null };
  const cfg = await boardConfig(site);
  const cache = await readJSON(githubStateFile(), {});
  const record = await readPRSlack(site);
  const links = [];
  const reviewersByPR = new Map();
  const githubOf = new Map();
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, {});
    const people = reviewersOf(itemFile, cfg.reviewers);
    for (const r of people) githubOf.set(r.name, r.github);
    for (const item of itemFile.items || []) {
      for (const p of cardPRs(item, boardRepoOf(site, itemFile))) {
        const pr = prKeyOf(p);
        if (!reviewersByPR.has(pr)) reviewersByPR.set(pr, new Set());
        for (const r of people) reviewersByPR.get(pr).add(r.name);
        if (item.lane === 'done') continue;
        const gh = routeRecord(cache.prs, pr);
        for (const r of people) {
          if (!linkOwed(gh, record, pr, r.name) || links.some((l) => l.pr === pr && l.reviewer === r.name)) continue;
          links.push({ pr, key: `${source.slug}/${item.id}`, reviewer: r.name, slack_user: r.slack_user, ...prLink(pr, gh, item, { ticket: ticketOfCard(cfg, item, boardRepoOf(site, itemFile)) }) });
        }
      }
    }
  }
  const reactions = [];
  for (const [pr, rec] of Object.entries(record)) {
    const gh = routeRecord(cache.prs, pr);
    const react = (name, message, reply) => {
      if (!message.ts || !reviewersByPR.get(pr)?.has(name)) return;
      const wanted = [(approved(gh) || gh?.reviews?.[githubOf.get(name)] === 'APPROVED') && 'git_approved', gh?.state === 'MERGED' ? 'git_merged' : gh?.state === 'CLOSED' && 'x'].filter(Boolean);
      for (const emoji of wanted) if (!message.reactions?.includes(emoji)) reactions.push({ pr, reviewer: name, ...(reply === undefined ? {} : { reply }), channel: message.channel || rec.links[name].channel, ts: message.ts, emoji });
    };
    for (const [name, link] of Object.entries(rec.links)) react(name, link);
    rec.replies.forEach((reply, at) => { for (const [name, sent] of Object.entries(reply.to)) react(name, sent, at); });
  }
  // headers: each posted digest header whose count of PRs still pending that reviewer differs from the count it shows,
  // with the header's text at the new count. A header an earlier build put in a reply carries that reply's lead and tail.
  const headers = [];
  for (const d of (await readJSON(digestFile(site), {})).digests || []) {
    const ts = d.live && (d.live.reply === undefined ? d.ts : d.replies?.[d.live.reply]?.ts);
    if (!ts) continue;
    const n = d.live.prs.filter((pr) => { const gh = routeRecord(cache.prs, pr); return gh?.state === 'OPEN' && waitsOn(gh, githubOf.get(d.reviewer)); }).length;
    if (n !== d.live.shown) headers.push({ date: d.date, reviewer: d.reviewer, channel: d.channel, ts, n, text: `${d.live.lead ?? ''}${digestHeader(cfg.title, n)}${d.live.tail ?? ''}` });
  }
  const digest = await reviewDigest(site, options);
  return { date: slackDay(options?.now).date, links, reactions, headers, digest: digest.due ? digest : null };
}
// due: one of review due's headers, once Slack has its edit.
export const recordHeader = (site, due) => editJSON(digestFile(site), (all) => { dayEntry(due.date, due.reviewer)(all).live.shown = due.n; });

const digestFile = (site) => path.join(needSite(site), 'data', 'review-digests.json');

// `review digest`: each reviewer's PRs the hub last read open, out of draft and not approved (failing checks included), one item per PR
// with its digest reply's message, the PR's bar (prLink) with its age for a link over two days old.
// data/review-digests.json {digests: [{date, reviewer, channel, ts, heard?, replies?: [{pr, text, attachments, ts}]}]} holds
// each reviewer's thread for each day, posted as postOnce posts: ts is its opener, the digest's header or the header
// line an earlier build posted, and replies are the digest's. heard is the newest message in the thread the hub has
// read (docs/adr/2026-11-12-0000-reviewers-ask-the-board-in-the-day-thread.md). The day's digest opens each reviewer's
// day thread (docs/adr/2026-11-14-0449-one-digest-opens-each-day-thread.md): it is owed from quiet hours' end on a weekday
// in the Slack timezone (hub/slack.mjs slackDay), however late the hub gets to it that day, and any day a link is owed to a reviewer whose thread is
// not open yet (linked); until every message of it is posted.
export async function reviewDigest(site, { now = new Date() } = {}) {
  needSite(site);
  const cfg = await boardConfig(site);
  const cache = await readJSON(githubStateFile(), {});
  const record = await readPRSlack(site);
  const topics = topicItems();
  const reviewers = new Map();
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, {});
    const people = reviewersOf(itemFile, cfg.reviewers);
    for (const r of people) if (!reviewers.has(r.name)) reviewers.set(r.name, { name: r.name, slack_user: r.slack_user, dm: r.dm, items: [] });
    for (const item of itemFile.items || []) {
      if (item.lane === 'done') continue;
      const key = `${source.slug}/${item.id}`;
      const legacy = reviewLinks(itemFile, item, key, topics);
      for (const p of cardPRs(item, boardRepoOf(site, itemFile))) {
        const pr = prKeyOf(p);
        const gh = routeRecord(cache.prs, pr);
        for (const r of people) if (linkOwed(gh, record, pr, r.name)) reviewers.get(r.name).linked = true;
        if (gh?.state !== 'OPEN' || gh.isDraft) continue;
        for (const r of people) {
          if (!waitsOn(gh, r.github)) continue;
          const ts = record[pr]?.links?.[r.name]?.ts || routeRecord(legacy, r.name)?.ts || null;
          const age = ts ? (now.getTime() - Number(ts) * 1000) / 86400000 : null;
          const old = age > 2 ? Math.floor(age) : null;
          reviewers.get(r.name).items.push({ key, pr, title: item.title, url: prURL(p), sent_ts: ts, ...(old ? { days_old: old } : {}),
            message: prLink(pr, gh, item, { ticket: ticketOfCard(cfg, item, boardRepoOf(site, itemFile)), old }) });
        }
      }
    }
  }
  const { date, open } = slackDay(now);
  const today = ((await readJSON(digestFile(site), {})).digests || []).filter((d) => d.date === date);
  const waiting = await readiness.waiting('slack');
  for (const sent of today) if (!reviewers.has(sent.reviewer)) reviewers.set(sent.reviewer, { name: sent.reviewer, items: [] });
  const list = [...reviewers.values()].map((r) => {
    const sent = today.find((d) => d.reviewer === r.name);
    const owed = sent?.replies ? !sent.posting_at && (!sent.ts || sent.replies.some((reply) => !held(reply)))
      : !sent?.posting_at && ((open && r.items.length > 0) || (!sent?.ts && Boolean(r.linked)));
    return { ...r, owed, ...(sent ? { sent } : {}) };
  }).filter((r) => r.items.length || r.sent || r.owed);
  return { date, due: !waiting && list.some((r) => r.owed), ...(waiting ? { waiting } : {}), reviewers: list };
}

// The digest's top lines: “<board title> Digest”, then its count of PRs pending review.
const digestHeader = (title, n) => `${title} Digest\n${n ? `${n} PR${n === 1 ? '' : 's'} pending review` : 'All reviewed'}`;

const dayEntry = (date, name) => (all) => (all.digests || []).find((d) => d.date === date && d.reviewer === name);
// The hub hears a day thread for HEARD_DAYS days, the day it opens included.
const HEARD_DAYS = 7;
const heardOn = (thread, date) => (Date.parse(date) - Date.parse(thread.date)) / 86400000 < HEARD_DAYS;
// The reviewer's entry for date, added when there is none; the file keeps the entries of the days still heard.
function addDayEntry(all, date, name, fields) {
  if (dayEntry(date, name)(all)) return;
  all.digests = [...(all.digests || []).filter((d) => heardOn(d, date)), { date, reviewer: name, ...fields }];
  delete all.last_date;
}

// docs/adr/2026-11-12-0000-reviewers-ask-the-board-in-the-day-thread.md
// The day threads the hub still hears on now's Slack day: those opened in the last HEARD_DAYS days.
// → [{date, reviewer, channel, ts, heard?}]
export async function heardThreads(site, now = new Date()) {
  const { date } = slackDay(now);
  return ((await readJSON(digestFile(site), {})).digests || []).filter((d) => d.ts && heardOn(d, date));
}
// Records ts as the newest message the hub has read in thread.
export const markHeard = (site, thread, ts) => editJSON(digestFile(site), (all) => { dayEntry(thread.date, thread.reviewer)(all).heard = ts; });
// The ts of every message the board posted to Slack: links, their replies, day-thread openers and digest replies.
export async function boardPosts(site) {
  const out = new Set();
  for (const rec of Object.values(await readPRSlack(site))) {
    for (const link of Object.values(rec.links || {})) out.add(link.ts);
    for (const reply of rec.replies || []) for (const sent of Object.values(reply.to)) out.add(sent.ts);
  }
  for (const d of (await readJSON(digestFile(site), {})).digests || []) for (const m of [d, ...(d.replies || [])]) out.add(m.ts);
  const posted = await readJSON(slackThreadsFile(site), {});
  for (const m of [...Object.values(posted.replies || {}), ...Object.values(posted.ends || {})]) out.add(m.ts);
  out.delete(undefined);
  return out;
}
// docs/adr/2026-11-15-1530-later-replies-in-a-slack-filed-tasks-thread-land-on-the-task.md
// data/slack-threads.json {threads: {"<channel>:<thread_ts>": ts}}: the newest reply the hub has read in each Slack
// thread a task was filed from.
const slackThreadsFile = (site) => path.join(site, 'data', 'slack-threads.json');
const slackThreadId = (t) => `${t.channel}:${t.thread_ts}`;
// The Slack threads this board's tasks follow: each ask routed from a Slack @kickflip whose card is not Done, as
// {key, channel, thread_ts, ts, by, link, heard}: routed.slack, the @kickflip's sender and permalink, and heard, the
// newest reply read, else the @kickflip's ts, since the replies up to it were its words.
export async function followedSlackThreads(site) {
  const asks = (await readLog(path.join(site, 'data', 'events.jsonl'))).filter((e) => e.kind === 'ask' && e.data?.routed?.via === 'slack' && e.data.routed.slack);
  if (!asks.length) return [];
  const heard = (await readJSON(slackThreadsFile(site), {})).threads || {};
  const out = [];
  for (const e of asks) {
    const card = await askCardOf(site, e.id);
    if (!card || card.item.lane === 'done') continue;
    const { slack, by, link } = e.data.routed;
    out.push({ key: card.key, ...slack, by, link, heard: heard[slackThreadId(slack)] || slack.ts });
  }
  return out;
}
// Records ts as the newest reply the hub has read in thread, one of followedSlackThreads.
export const markSlackThreadHeard = (site, thread, ts) => editJSON(slackThreadsFile(site), (all) => { all.threads = { ...all.threads, [slackThreadId(thread)]: ts }; });
// docs/adr/2026-11-16-1700-replies-to-a-slack-message-post-into-its-slack-thread.md
// Whether event came from Slack: an ask routed from a Slack @kickflip, or a Slack reply followSlackAsks copied onto its
// task as a message. The orchestrator's reply to it posts into the task's Slack thread.
const slackSourced = (event) => (event.kind === 'ask' && event.data?.routed?.via === 'slack' && Boolean(event.data.routed.slack))
  || (event.kind === 'item-message' && Boolean(event.data?.slack));
// slack-threads.json's replies {"<reply file name>": {key, ts?, failed?}}, in the order written: each reply to post, with
// the ts Slack gave it once posted and failed once a post failed and the card's fault line was written; and ends
// {"<channel>:<thread_ts>": {ts?, failed?}}: each thread seen while its task was open, so its end line posts once.
const queueSlackReply = (site, key, name) => editJSON(slackThreadsFile(site), (all) => { all.replies = { ...all.replies, [name]: { key } }; });
// What the hub posts to each Slack-filed task's thread: [{key, channel, thread_ts, replies: [{name, text, failed?}],
// end: {text, failed?} | null}], its replies not yet posted, then, once the task is Done, its end line, "Closed: <title>"
// or "Built and landed: <title>". Records each thread whose task is open, so a task Done before its thread was first read
// posts no end line.
export async function slackOutbox(site) {
  const asks = (await readLog(path.join(site, 'data', 'events.jsonl'))).filter((e) => e.kind === 'ask' && e.data?.routed?.via === 'slack' && e.data.routed.slack);
  if (!asks.length) return [];
  const { replies = {}, ends = {} } = await readJSON(slackThreadsFile(site), {});
  const out = [];
  const opened = [];
  for (const e of asks) {
    const card = await askCardOf(site, e.id);
    if (!card) continue;
    const { channel, thread_ts } = e.data.routed.slack;
    const id = slackThreadId({ channel, thread_ts });
    const done = card.item.lane === 'done';
    if (!done && !ends[id]) opened.push(id);
    const owed = await Promise.all(Object.entries(replies).filter(([, r]) => r.key === card.key && !r.ts)
      .map(async ([name, r]) => ({ name, text: await fs.readFile(path.join(site, 'data', 'replies', `${name}.md`), 'utf8'), ...(r.failed ? { failed: true } : {}) })));
    const end = done && ends[id] && !ends[id].ts ? { text: `${card.item.phase === 'merged' ? 'Built and landed' : 'Closed'}: ${card.item.title}`, ...(ends[id].failed ? { failed: true } : {}) } : null;
    if (owed.length || end) out.push({ key: card.key, channel, thread_ts, replies: owed, end });
  }
  if (opened.length) await editJSON(slackThreadsFile(site), (all) => { all.ends = { ...all.ends, ...Object.fromEntries(opened.map((id) => [id, {}])) }; });
  return out;
}
// Records a post of slackOutbox's: thread's end line when reply is null, else reply, a reply's name; ts, the ts Slack
// gave it, or failed, after its first failed post.
export const markSlackPost = (site, thread, reply, { ts, failed }) => editJSON(slackThreadsFile(site), (all) => {
  const [field, id] = reply ? ['replies', reply] : ['ends', slackThreadId(thread)];
  all[field] = { ...all[field], [id]: { ...all[field]?.[id], ...(ts ? { ts } : { failed }) } };
});
// What the orchestrator posts in a day thread: its words, at most WORDS_LIMIT characters; the Slack client signs them off.
const WORDS_LIMIT = 250;
function orchestratorWords(words) {
  const body = text(words, '--text');
  if (body.length > WORDS_LIMIT) fail(`--text runs to ${body.length} characters, past the orchestrator's ${WORDS_LIMIT}: keep it brief`);
  return body;
}

// A slack-question event's data: {reviewer, channel, thread_ts, ts, from: reviewer|owner, answer}.
async function slackQuestion(site, eventId) {
  domId(eventId, 'the event id');
  const e = (await readLog(path.join(needSite(site), 'data', 'events.jsonl'))).find((x) => x.id === eventId && x.kind === 'slack-question');
  return e?.data || fail(`no slack-question "${eventId}" in this site's data/events.jsonl`);
}
// docs/adr/2026-11-15-1200-an-event-with-no-task-waits-on-the-orchestrator-until-acted-on.md: a slack-handled {id, by}
// event, record-only, ends the orchestrator's wait on slack-question id (domain.mjs eventWaits); by is the command.
const slackHandled = (site, id, by) => appendEvent(boardTarget(site), 'slack-handled', { id, by });
const throughSlack = (slack) => slack || fail(SLACK_NEEDS_TOKEN);
const slackCall = (call) => call.catch((e) => (e instanceof SlackError ? fail(e.message) : Promise.reject(e)));

// `slack thread`: the event's day thread, read from Slack, one message a line and continued lines indented, then each
// attachment's fallback, such as a PR link's bar, indented too; each named board (the board's posts and answers), you
// (the owner) or the reviewer; → marks the event's message.
export async function slackThread(site, eventId, slack = savedSlack()) {
  const q = await slackQuestion(site, eventId);
  const ours = await boardPosts(site);
  const owner = slackUserId();
  const messages = await slackCall(throughSlack(slack).replies({ channel: q.channel, ts: q.thread_ts }));
  const lines = messages.flatMap((m) => {
    const who = ours.has(m.ts) || (m.user === owner && isSignedOff(m.text, m.attachments)) ? 'board' : m.user === owner ? 'you' : q.reviewer;
    const [first = '', ...rest] = [...(m.text ? m.text.split('\n') : []), ...(m.attachments || []).map((a) => a.fallback)];
    return [`${m.ts === q.ts ? '→ ' : ''}${who}: ${first}`, ...rest.map((l) => `    ${l}`)];
  });
  // A message that expects no reply is acted on once read.
  if (!q.answer) await slackHandled(site, eventId, 'thread');
  return { lines };
}

// `slack skip`: a slack-question that needs no answer, such as a thanks, recorded handled with nothing posted.
export async function slackSkip(site, eventId) {
  const q = await slackQuestion(site, eventId);
  await slackHandled(site, eventId, 'skip');
  return { lines: [`no reply to ${q.reviewer}'s day thread`] };
}

// `slack answer`: the answer, signed off, posted as a reply in the event's day thread. Refuses an owner's message that
// names no @kickflip, which expects no reply, and words past WORDS_LIMIT.
export async function slackAnswer(site, eventId, words, slack = savedSlack()) {
  const q = await slackQuestion(site, eventId);
  if (!q.answer) fail("that message is the owner's and names no @kickflip, so it expects no reply");
  const message = orchestratorWords(words);
  await slackCall(throughSlack(slack).post({ channel: q.channel, thread_ts: q.thread_ts, text: message }));
  await slackHandled(site, eventId, 'answer');
  return { lines: [`answered in ${q.reviewer}'s day thread`] };
}

// `slack say`: the words, signed off, posted in the reviewer's day thread for now's Slack day, opened with the day's
// digest when none is open, as the hub opens one. The owner's explicit ask is its only use
// (SKILL.md); a message in a thread is answered with slack answer. Refuses words past WORDS_LIMIT.
export async function slackSay(site, name, words, { now = new Date() } = {}, slack = savedSlack()) {
  needSite(site);
  const message = orchestratorWords(words);
  const reviewer = await reviewerNamed(site, name);
  const client = throughSlack(slack);
  const thread = await openDayThread(site, client, reviewer, now);
  await slackCall(client.post({ channel: thread.channel, thread_ts: thread.ts, text: message }));
  return { lines: [`said in ${reviewer.name}'s day thread`] };
}

// The board's reviewer called name or whose Slack user is name, a leading @ ignored.
async function reviewerNamed(site, name) {
  const cfg = await boardConfig(site);
  const reviewers = new Map();
  for (const source of await itemSources(site)) for (const r of reviewersOf(await readJSON(source.file, {}), cfg.reviewers)) reviewers.set(r.name, r);
  const wanted = String(name).replace(/^@/, '');
  return [...reviewers.values()].find((r) => sameName(r.name, wanted) || r.slack_user === wanted)
    || fail(`no reviewer "${name}" on this board; its reviewers are ${[...reviewers.keys()].join(', ') || 'none'}`);
}

// The reviewer's day thread for now's Slack day, opened with the day's digest when none is open, as the hub opens one.
// → {channel, ts}
async function openDayThread(site, client, reviewer, now) {
  const { date } = slackDay(now);
  const open = dayEntry(date, reviewer.name)(await readJSON(digestFile(site), {}));
  return open?.ts ? open : slackCall(postDigest(site, date, (await reviewDigest(site, { now })).reviewers.find((r) => r.name === reviewer.name) || { ...reviewer, items: [] }, {
    channel: open?.channel || await slackCall(client.openDM(reviewer.slack_user)),
    post: (m) => client.post(m),
  }));
}

// `slack link`: a PR's link, the one PR message format (prLink), sent through the hub's Slack in the reviewer's day
// thread as review due sends the board's own, and recorded so the PR's reactions follow it and the board sends no
// second. pr: owner/repo#n, a PR URL or a number in the board's repo. The size is from GitHub (readPR), the risk from
// the card holding the PR, none without one.
export async function slackLink(site, pr, to, { now = new Date(), readPR = prSize } = {}, slack = savedSlack()) {
  needSite(site);
  const ref = parsePRRef(String(pr).replace(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/, '$1#$2')) || fail(`"${pr}" is no PR: give owner/repo#n, a PR URL or a number in the board's repo`);
  const repo = ref.repo || boardRepoOf(site, {}) || fail(`"${pr}" names no repo and this board has none: give owner/repo#n`);
  const key = prKeyOf({ repo, number: ref.number });
  const reviewer = await reviewerNamed(site, to);
  const client = throughSlack(slack);
  const cfg = await boardConfig(site);
  let card = {};
  let ticket = null;
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, {});
    const found = (itemFile.items || []).find((i) => cardPRs(i, boardRepoOf(site, itemFile)).some((p) => prKeyOf(p) === key));
    if (found) { card = found; ticket = ticketOfCard(cfg, found, boardRepoOf(site, itemFile)); }
  }
  let size;
  try { size = await readPR({ repo, pr: ref.number, login: settingsOf(cfg).github_login }); } catch (e) { fail(e.message); }
  const message = prLink(key, size, card, { ticket });
  const thread = await openDayThread(site, client, reviewer, now);
  await slackCall(postLink(site, { pr: key, reviewer: reviewer.name }, thread, () => client.post({ channel: thread.channel, thread_ts: thread.ts, ...message })));
  return { lines: [`sent ${key} to ${reviewer.name}'s day thread`] };
}

// `slack task`: a request for work in a day thread, filed as a new card in item file `file`, discussing, for the owner
// to review (docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md); never ready, so never a Quick build. The Slack
// message, read whole, is the card's first thread line, under its writer's name and linking to it when the Slack
// identity has the workspace's domain.
export async function slackTask(site, eventId, file, { title, notes, notesFrom }, slack = savedSlack()) {
  const q = await slackQuestion(site, eventId);
  const messages = await slackCall(throughSlack(slack).replies({ channel: q.channel, ts: q.thread_ts }));
  const message = messages.find((m) => m.ts === q.ts) || fail('that Slack message is gone from its thread');
  const filed = await addItem(site, file, { title, notes, notesFrom, phase: 'discussing', intake: true });
  const domain = readSlack().slack_domain;
  const link = domain ? `https://${domain}.slack.com/archives/${q.channel}/p${q.ts.replace('.', '')}?thread_ts=${q.thread_ts}&cid=${q.channel}` : undefined;
  await appendMessage(site, filed.key, { text: message.text, who: q.from === 'owner' ? 'love' : q.reviewer, via: 'slack', link });
  await slackHandled(site, eventId, 'task');
  return { ...filed, lines: [`filed ${filed.key} discussing, for the owner's review`] };
}

// The reviewer's day thread for date, {channel, ts}, or null until its opener is posted.
export async function dayThread(site, date, name) {
  const opened = dayEntry(date, name)(await readJSON(digestFile(site), {}));
  return opened?.ts ? { channel: opened.channel, ts: opened.ts } : null;
}

// Posts a reviewer's owed digest for date, one of review digest's reviewers. Opening the day's thread, it is the
// header, then one reply per PR, each the PR's bar (prLink) and nothing mentions the reviewer; a thread an earlier
// build opened gets the replies alone. A digest already begun keeps the PRs it began with. The entry's live holds the
// header's PRs and the count it shows, which review due finds to edit. post({channel, text, thread_ts?}) → ts.
// → the day thread, {channel, ts}
export async function postDigest(site, date, reviewer, { channel, post }) {
  const file = digestFile(site);
  const entry = dayEntry(date, reviewer.name);
  const { title } = await boardConfig(site);
  const header = (n) => digestHeader(title, n);
  await editJSON(file, (all) => {
    addDayEntry(all, date, reviewer.name, { channel });
    const opened = entry(all);
    if (opened.replies) return;
    const prs = reviewer.items.map((i) => i.pr);
    opened.replies = reviewer.items.map((i) => ({ pr: i.pr, ...i.message }));
    // A thread an earlier build opened has a header line that isn't the digest's, so it has no count to edit.
    if (!opened.ts) opened.live = { prs, shown: prs.length };
  });
  const sent = entry(await readJSON(file, {}));
  const top = sent.ts || await postOnce(file, entry, () => post({ channel: sent.channel, text: header(sent.live.prs.length) }));
  for (const [i, reply] of sent.replies.entries()) {
    if (!held(reply)) await postOnce(file, (all) => entry(all).replies[i], () => post({ channel: sent.channel, thread_ts: top, text: reply.text, attachments: reply.attachments }));
  }
  // A one-PR reply is a message about that PR, so it joins the PR's posted replies and gets its reactions (the digest
  // file keeps only the days still heard); a reply naming several PRs gets none.
  const posted = entry(await readJSON(file, {})).replies.filter((r) => r.pr && r.ts);
  if (posted.length) await editJSON(prSlackFile(site), (all) => {
    const id = `digest-${date}`;
    for (const reply of posted) {
      const rec = all[reply.pr] ||= { links: {}, replies: [] };
      const bump = rec.replies.find((r) => r.id === id) || rec.replies[rec.replies.push({ id, text: reply.text, to: {} }) - 1];
      bump.to[reviewer.name] ||= { channel: sent.channel, ts: reply.ts, reactions: [] };
    }
  });
  return { channel: sent.channel, ts: top };
}

// One reviewer or an array; each replaces the board's reviewer of the same name, ignoring case, or is added.
export function addReviewers(site, input) {
  const added = checkReviewers(Array.isArray(input) ? input : [input], 'the reviewer file');
  return writeReviewers(site, (list) => [...list.map((r) => added.find((a) => sameName(a.name, r.name)) || r), ...added.filter((a) => !list.some((r) => sameName(a.name, r.name)))]);
}

export function removeReviewers(site, names) {
  return writeReviewers(site, (list) => {
    const unknown = names.filter((n) => !list.some((r) => sameName(r.name, n)));
    if (unknown.length) fail(`this board has no reviewer ${unknown.map((n) => `"${n}"`).join(', ')}`);
    return list.filter((r) => !names.some((n) => sameName(r.name, n)));
  });
}

// Rules: the hub's in settings.json and this board's in board.json `rules` (../hub/rules.mjs;
// docs/adr/2026-10-29-1639-rules-live-on-settings-at-hub-and-board-level.md). The settings page and the CLI both write board.json,
// so board rule, setting and reviewer writes run one at a time.
const hubSettingsFile = () => path.join(os.homedir(), '.claude', 'kickflip', 'settings.json');
const ruleCall = (fn) => { try { return fn(); } catch (e) { if (e instanceof RuleError) fail(e.message); throw e; } };
export const readBoardRules = async (site) => rulesOf(await readJSON(path.join(site, 'board.json'), {}));

let boardWrites = Promise.resolve();
// change(cfg) → {keys to set in board.json, ...anything else to return}
function writeBoardJSON(site, change) {
  const write = boardWrites.then(async () => {
    const file = path.join(needSite(site), 'board.json');
    const cfg = await readJSON(file, {});
    const { set, ...result } = change(cfg);
    await writeJSON(file, { ...cfg, ...set });
    return { file, ...result };
  });
  boardWrites = write.catch(() => {});
  return write;
}
const writeBoardRules = (site, change) => writeBoardJSON(site, (cfg) => {
  const result = ruleCall(() => change(rulesOf(cfg)));
  return { set: { rules: result.rules }, ...result };
});

// Board settings' Sharing (docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md,
// docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md): change is {add: login}, {remove: login}, or
// {login, level: 'view' | 'full'} for someone listed, a login as Tailscale-User-Login sends it, trimmed. A View entry is
// stored as the bare login, a Full one as {login, level: 'full'}. → {share}, board.json's list
export function saveBoardShare(site, change) {
  const keys = Object.keys(change || {}).sort().join();
  const leveled = keys === 'level,login';
  const raw = leveled ? change.login : change?.[keys];
  const login = typeof raw === 'string' ? raw.trim() : null;
  if (!['add', 'remove', 'level,login'].includes(keys) || !validLogin(login)) fail('Send add or remove with one login, like name@github, or a listed login with its level.');
  if (leveled && !['view', 'full'].includes(change.level)) fail('A level is view or full.');
  const stored = ({ login: l, level }) => (level === 'full' ? { login: l, level } : l);
  return writeBoardJSON(site, (cfg) => {
    const listed = shareEntries(cfg);
    if (leveled && !listed.some((e) => e.login === login)) fail(`${login} isn't shared with yet. Add them first.`);
    const entries = keys === 'remove' ? listed.filter((e) => e.login !== login)
      : leveled ? listed.map((e) => (e.login === login ? { login, level: change.level } : e))
        : listed.some((e) => e.login === login) ? listed : [...listed, { login, level: 'view' }];
    const share = entries.map(stored);
    return { set: { share }, share };
  }).then(({ share }) => ({ share }));
}

const validGithubLogin = (value) => typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
const storedTickets = (value) => { try { return value ? ticketSource(value) : null; } catch { return null; } };
// A board's settings in board.json (docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md): auto_merge,
// auto_build, auto_review and idle_notification, off when absent, max_implementers, a
// whole number from 1 to 99 and MAX_IMPLEMENTERS when absent
// (docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md), max_serves, the same and MAX_SERVES
// when absent (docs/adr/2026-11-12-0112-a-card-serve-stays-up-while-its-worktree-does.md), skip_draft, off when
// absent (docs/adr/2026-11-04-1913-a-board-can-skip-the-draft.md), prs, on unless false, and on the hub board (board is its listBoards
// entry, `hub: true`) off unless true (opensPRs; docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md,
// docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md), tickets, its one
// ticket source, and github_login, absent when unset or invalid (docs/adr/2026-11-01-1348-a-board-has-one-ticket-source.md),
// tool_use, normal unless high (docs/adr/2026-11-14-1500-a-tool-use-setting-sets-how-readily-the-orchestrator-uses-tools.md),
// and build_target, the `.kickflip/build-<target>` the hub runs, absent for `.kickflip/build`
// (docs/adr/2026-11-05-1823-board-settings-picks-which-build-script-a-board-runs.md).
const validCap = (value) => Number.isInteger(value) && value >= 1 && value <= 99;
const CAPS = ['max_implementers', 'max_serves'];
const TOOL_USE = ['normal', 'high'];
export const settingsOf = (cfg, board) => {
  const tickets = storedTickets(cfg?.tickets);
  return { auto_merge: cfg?.auto_merge === true, auto_build: cfg?.auto_build === true,
    max_implementers: validCap(cfg?.max_implementers) ? cfg.max_implementers : MAX_IMPLEMENTERS,
    max_serves: validCap(cfg?.max_serves) ? cfg.max_serves : MAX_SERVES, auto_review: cfg?.auto_review === true,
    idle_notification: cfg?.idle_notification === true, skip_draft: cfg?.skip_draft === true, prs: board?.hub ? cfg?.prs === true : cfg?.prs !== false,
    tool_use: cfg?.tool_use === 'high' ? 'high' : 'normal',
    ...(tickets ? { tickets } : {}), ...(validGithubLogin(cfg?.github_login) ? { github_login: cfg.github_login } : {}),
    ...(validBuildTarget(cfg?.build_target) ? { build_target: cfg.build_target } : {}),
    // Builders, overriding Hub settings' (usage-gate.mjs claudeModelFor); none on Hub default.
    ...(CLAUDE_MODEL_VALUES.includes(cfg?.claude_model) ? { claude_model: cfg.claude_model } : {}) };
};
// Pause board (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md): a shared/usage-gate.mjs
// pauseEnd choice, or off, saved as board.json's paused_until, which readUsageGate reads with the board's dir. It is no
// board setting: the gate, not a settings event, tells the session. → the end as an ISO time or forever, or null.
export async function setBoardPause(site, choice, now = new Date()) {
  let end;
  try { end = pauseEnd(choice, now); } catch (e) { fail(e.message); }
  await writeBoardJSON(site, () => ({ set: { paused_until: end ?? undefined } }));
  return end;
}
// max_land_tests is the hub's, not the board's: land test runs at once on the host (push.mjs readLandTests), shown in
// Board Settings beside Maximum tasks in progress and saved to the hub's settings.json for every board.
export async function readBoardSettings(site) {
  const dir = needSite(site);
  return { ...settingsOf(await readJSON(path.join(dir, 'board.json'), {}), listBoards().find((b) => samePath(b.dir, dir))), max_land_tests: readLandTests() };
}
// A board's description is the hub's, in its manifest entry, where the router reads it on each request
// (hub/router.mjs routingBoards): description, with description_source, new-board, triage or settings, and
// description_at, the ISO time it was set. → {description, source, at}; source and at are '' for a board whose
// description was set before they were stored.
export const DESCRIPTION_LIMIT = 240;
const manifestRoute = (site) => listBoards().find((b) => samePath(b.dir, needSite(site)))?.route;
export function readBoardDescription(site) {
  const entry = readManifest().sites?.[manifestRoute(site)] || {};
  return { description: String(entry.description || ''), source: entry.description_source || '', at: entry.description_at || '' };
}
// source is where the text came from: 'settings' (Board Settings) or 'triage' (an approved proposal).
export async function saveBoardDescription(site, text, source = 'settings', now = new Date()) {
  const description = String(text ?? '').trim();
  if (!description) fail('A board needs a description');
  if (description.length > DESCRIPTION_LIMIT) fail(`A description is at most ${DESCRIPTION_LIMIT} characters`);
  if (!['settings', 'triage'].includes(source)) fail('a description is set from settings or triage');
  await markDescription(site, { description, description_source: source, description_at: now.toISOString() });
  return readBoardDescription(site);
}

// docs/adr/2026-11-16-2100-overnight-triage-proposes-a-stale-board-description.md
// An overnight triage's proposal to change a board's description is the task titled descriptionProposalTitle(route).
// The manifest entry keeps description_proposal, that task's key, and description_checked_at, when a triage last judged
// the description. A proposal is open while its task isn't Done; closing the task ends it, with nothing to clear.
const DESCRIPTION_CHECK_DAYS = 7;
const descriptionProposalTitle = (route) => `chore(board): update /${route}'s description`;
async function openProposal(site, entry) {
  const key = entry.description_proposal;
  if (!key) return null;
  try { return (await loadItem(site, key)).item.lane === 'done' ? null : key; } catch (e) { if (e instanceof BoardError) return null; throw e; }
}
// → {description, source, at, checked, proposal}: checked is when a triage last judged it ('' never), proposal the open
// proposal's task key, else null.
export async function describeBoard(site) {
  const entry = readManifest().sites?.[manifestRoute(site)] || {};
  return { ...readBoardDescription(site), checked: entry.description_checked_at || '', proposal: await openProposal(site, entry) };
}
// Whether tonight's overnight triage judges the description: the board is in the hub's manifest, no proposal is open,
// and the description is empty or neither set nor checked in DESCRIPTION_CHECK_DAYS.
export async function descriptionDue(site, now = new Date()) {
  if (!manifestRoute(site)) return false;
  const { description, at, checked, proposal } = await describeBoard(site);
  if (proposal) return false;
  if (!description) return true;
  const last = Math.max(Date.parse(at) || 0, Date.parse(checked) || 0);
  return now.getTime() - last >= DESCRIPTION_CHECK_DAYS * 86400000;
}
async function markDescription(site, fields) {
  const route = manifestRoute(site) || fail('this board isn’t in the hub’s manifest');
  await withManifestLock(async () => {
    const manifest = readManifest();
    manifest.sites[route] = { ...manifest.sites[route], ...fields };
    await writeManifest(manifest);
  });
}
// A triage that judged the description still right records when, so the next check is DESCRIPTION_CHECK_DAYS away.
export async function checkedDescription(site, now = new Date()) {
  await markDescription(site, { description_checked_at: now.toISOString() });
  return describeBoard(site);
}
// item add of a proposal's title: refused while one is open; → the board's route when the title is this board's proposal.
async function refuseSecondProposal(site, title) {
  const route = site && manifestRoute(site);
  if (!route || String(title).trim() !== descriptionProposalTitle(route)) return null;
  const entry = readManifest().sites[route];
  const open = await openProposal(site, entry);
  if (open) fail(`/${route} already has an open description proposal, ${open}; it ends when that task closes`);
  return route;
}
// Whether cards on a board open PRs: a board on GitHub that builds from its shared clone, not its folder
// (hub/boards.mjs buildsLocally), or the hub board, which builds from its folder, with its PRs setting on (Landing is
// Draft PR or Ready PR; docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md). board is a
// listBoards entry or hub/board-repo.mjs boardRepo's answer, settings settingsOf's.
export const opensPRs = (board, settings) => Boolean(board?.github) && (!board.local || board.hub === true) && settings.prs;

// changes {auto_merge?: boolean, auto_build?: boolean,max_implementers?: 1..99, max_serves?: 1..99, auto_review?: boolean, idle_notification?: boolean, skip_draft?: boolean, prs?: boolean, tool_use?: 'normal' | 'high', tickets?: source, github_login?: login | null, build_target?: target | null, claude_model?: 'opus' | 'auto' | 'sonnet' | null} → {file, settings, changed}; changed lists the keys whose value moved.
// PRs off on a board on GitHub that builds from its shared clone needs its Push main switch on, since each land there
// then pushes main (permissions.mjs pushMain).
export async function saveBoardSettings(site, changes) {
  onlyKeys(changes, ['auto_merge', 'auto_build','max_implementers', 'max_serves', 'max_land_tests', 'auto_review', 'idle_notification', 'skip_draft', 'prs', 'tool_use', 'tickets', 'github_login', 'build_target', 'claude_model'], 'the settings');
  if (!Object.keys(changes).length) fail('the settings name nothing to change');
  changes = { ...changes };
  // The hub's number is written to the hub's settings, after the board's own changes are checked.
  const { max_land_tests: landTests, ...own } = changes;
  changes = own;
  for (const [k, v] of Object.entries(changes)) {
    if (k === 'tickets') {
      // None is stored as no tickets key (docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md).
      try { changes.tickets = ticketSource(v) ?? undefined; } catch (e) { fail(e.message); }
      if (changes.tickets?.source === 'linear' && !linearWorks()) fail(LINEAR_NEEDS_KEY);
      // Issues need a repo on GitHub, as Board Settings' Tickets row shows (dialogs.js ticketsControl).
      const board = changes.tickets?.source === 'github' && site ? listBoards().find((b) => samePath(b.dir, site)) : null;
      if (board && !board.github) fail('GitHub issues need the board’s repo on GitHub, and this board’s repo isn’t; pick none or linear');
    }
    else if (k === 'github_login') {
      if (v === '' || v === null) changes.github_login = undefined;
      else if (!validGithubLogin(v)) fail('github_login must be a GitHub login');
    } else if (k === 'build_target') {
      if (v === null) changes.build_target = undefined;
      else if (!validBuildTarget(v)) fail('build_target must name .kickflip/build-<target>: letters, digits, ".", "_" or "-", or null for .kickflip/build');
    } else if (k === 'tool_use') {
      if (!TOOL_USE.includes(v)) fail('tool_use must be normal or high');
    } else if (k === 'claude_model') {
      if (v === null) changes.claude_model = undefined;
      else if (!CLAUDE_MODEL_VALUES.includes(v)) fail('claude_model must be opus, auto, sonnet or null for Hub default');
    } else if (CAPS.includes(k)) {
      if (!validCap(v)) fail(`${k} must be a whole number from 1 to 99`);
    } else bool(v, k);
  }
  if (changes.prs === false) {
    const board = site ? listBoards().find((b) => samePath(b.dir, site)) : null;
    if (board?.github && !board.local && !(await readPermissions(board.owner?.repo)).pushMain) fail('Merge lands each task on main and pushes it, so turn on Push main after a land first');
  }
  if (landTests !== undefined) {
    try { setLandTests(landTests); } catch { fail('max_land_tests must be a whole number from 1 to 99'); }
  }
  return writeBoardJSON(site, (cfg) => {
    const board = site ? listBoards().find((b) => samePath(b.dir, site)) : null;
    const before = settingsOf(cfg, board);
    const settings = { ...settingsOf({ ...cfg, ...changes }, board), max_land_tests: readLandTests() };
    return { set: changes, settings, changed: [...Object.keys(changes).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(settings[k])), ...(landTests === undefined ? [] : ['max_land_tests'])] };
  });
}
// Once Hub has no Linear key, each board in the manifest on Linear falls back to no ticket source, and its session
// hears of it as any source change, by a settings event. Its old cards keep their Linear tickets. Run by the hub as it
// starts and when Hub settings removes the key
// (docs/adr/2026-11-04-0227-every-new-card-gets-a-ticket-in-the-boards-current-source.md). → one line per board moved
export async function fallBackFromLinear() {
  if (linearStatus().set) return [];
  const lines = [];
  for (const board of listBoards()) {
    if ((await readBoardSettings(board.dir)).tickets?.source !== 'linear') continue;
    await saveBoardSettings(board.dir, { tickets: { source: 'none' } });
    await appendEvent(board, 'settings', { tickets: null });
    lines.push(`/${board.route} fell back to no ticket source: Hub has no Linear key`);
  }
  return lines;
}
// The CLI's `settings set <name> <value>`; names are the board.json keys with "-" for "_".
export async function setBoardSetting(site, name, value) {
  const key = String(name).replace(/-/g, '_');
  const names = ['auto_merge', 'auto_build','max_implementers', 'max_serves', 'max_land_tests', 'auto_review', 'idle_notification', 'skip_draft', 'prs', 'tool_use', 'github_login', 'tickets', 'build_target', 'claude_model'];
  if (!names.includes(key)) fail(`no board setting "${name}"; settings are ${names.map((k) => k.replace(/_/g, '-')).join(', ')}`);
  if (key === 'tickets') {
    let tickets;
    try { tickets = JSON.parse(value); } catch { fail('settings set tickets takes the source as JSON, such as {"source":"github"}'); }
    const { file, settings } = await saveBoardSettings(site, { tickets });
    return { file, lines: settingsLines({ tickets: settings.tickets }) };
  }
  if (key === 'github_login') {
    const { file, settings } = await saveBoardSettings(site, { github_login: value });
    return { file, lines: [`github-login ${settings.github_login || 'unset'}`] };
  }
  if (key === 'build_target') {
    const { file, settings } = await saveBoardSettings(site, { build_target: value === 'default' ? null : value });
    return { file, lines: [`build-target ${settings.build_target || 'default'}`] };
  }
  if (key === 'tool_use') {
    const { file, settings } = await saveBoardSettings(site, { tool_use: value });
    return { file, lines: [`tool-use ${settings.tool_use}`] };
  }
  if (key === 'claude_model') {
    const { file, settings } = await saveBoardSettings(site, { claude_model: value === 'hub' ? null : value });
    return { file, lines: settingsLines({ claude_model: settings.claude_model }) };
  }
  if (CAPS.includes(key) || key === 'max_land_tests') {
    const { file, settings } = await saveBoardSettings(site, { [key]: /^\d+$/.test(value) ? Number(value) : value });
    return { file, lines: [`${name} ${settings[key]}`] };
  }
  if (!['on', 'off'].includes(value)) fail(`settings set ${name} takes on or off, not "${value}"`);
  const { file, settings } = await saveBoardSettings(site, { [key]: value === 'on' });
  return { file, lines: [`${name} ${settings[key] ? 'on' : 'off'}`] };
}
export const settingsLines = (settings) => Object.entries(settings).map(([k, v]) => `setting ${k.replace(/_/g, '-')} ${k === 'tickets' ? JSON.stringify(v ?? { source: 'none' }) : k === 'github_login' || k === 'tool_use' || CAPS.includes(k) ? v : k === 'build_target' ? v || 'default' : k === 'claude_model' ? v || 'hub' : v ? 'on' : 'off'}`);

// change(list) → {rules, rule} from hub/rules.mjs; → {file, lines} naming the rule's id.
async function changeRules(site, hub, change) {
  const r = hub ? ruleCall(() => change(readHubRules())) : await writeBoardRules(site, change);
  if (hub) ruleCall(() => writeHubRules(r.rules));
  return { file: hub ? hubSettingsFile() : r.file, lines: [`id ${r.rule.id}`] };
}

// An id given without --hub that names a hub rule, or the reverse, says which flag it needed.
async function checkRuleId(site, id, hub) {
  const ids = (list) => list.map((r) => r.id);
  if (!hub) needSite(site);
  const [mine, other] = hub ? [ids(readHubRules()), site ? ids(await readBoardRules(site)) : []] : [ids(await readBoardRules(site)), ids(readHubRules())];
  if (mine.includes(id)) return;
  fail(`no ${hub ? 'hub' : 'board'} rule "${id}"${other.includes(id) ? `; it is a ${hub ? 'board' : 'hub'} rule, so ${hub ? 'drop' : 'pass'} --hub` : ''}`);
}

// The hub rules, then this board's with --site: one `<hub|board> <id> <owner|claude> <text>` line each.
export async function listRules(site) {
  const line = (scope) => (r) => `${scope} ${r.id} ${r.by === 'claude' ? 'claude' : 'owner'} ${r.text}`;
  return { lines: [...readHubRules().map(line('hub')), ...(site ? (await readBoardRules(site)).map(line('board')) : [])] };
}

export function addRuleTo(site, { text, hub = false, by }) {
  if (!hub) needSite(site);
  return changeRules(site, hub, (list) => addRule(list, { text, by }));
}

export async function editRuleIn(site, id, { text, hub = false }) {
  await checkRuleId(site, id, hub);
  return changeRules(site, hub, (list) => editRule(list, id, text));
}

export async function removeRuleFrom(site, id, { hub = false }) {
  await checkRuleId(site, id, hub);
  return changeRules(site, hub, (list) => removeRule(list, id));
}

// Board Settings' save (server.mjs POST /api/rules). → {file, rules, changes}
export const saveBoardRules = (site, incoming, base) => writeBoardRules(site, (list) => applyRules(list, incoming, base));

export async function addTopic(site, { id, title, summary }) {
  needSite(site);
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const topics = owner.topics || [];
  if (topics.some((t) => t.id === text(id, 'the topic id'))) fail(`topic "${id}" already exists`);
  topics.push({ id: id.trim(), title: text(title, '--title'), ...(summary === undefined ? {} : { summary: text(summary, '--summary') }) });
  await writeJSON(ownerFile(site), { ...owner, topics, items: owner.items || [] });
  return ownerFile(site);
}

// docs/adr/2026-10-29-1639-a-questions-takes-show-inline.md: rows of at most 4 boxes {text, tone?, to?}, `to` naming boxes of the
// next row, and a diagram always comes with its practice lines.
const DIAGRAM_TONES = ['quiet', 'info', 'notice', 'danger', 'success'];
function checkDiagram(o, at) {
  if ((o.diagram === undefined) !== (o.practice === undefined)) fail(`${at} needs diagram and practice together`);
  if (o.diagram === undefined) return;
  const rows = o.diagram;
  if (!Array.isArray(rows) || !rows.length) fail(`${at}.diagram must be a non-empty array of rows`);
  rows.forEach((row, r) => {
    if (!Array.isArray(row) || !row.length || row.length > 4) fail(`${at}.diagram[${r}] must be a row of 1 to 4 boxes`);
    row.forEach((b, n) => {
      const box = `${at}.diagram[${r}][${n}]`;
      onlyKeys(b, ['text', 'tone', 'to'], box);
      text(b.text, `${box}.text`);
      optional(b.tone, (v) => (DIAGRAM_TONES.includes(v) ? v : fail(`${box}.tone takes ${DIAGRAM_TONES.join(', ')}`)));
      optional(b.to, (v) => (Array.isArray(v) && r + 1 < rows.length && v.every((t) => Number.isInteger(t) && t >= 0 && t < rows[r + 1].length)
        ? v : fail(`${box}.to must list boxes of the next row by index`)));
    });
  });
  if (!Array.isArray(o.practice) || !o.practice.length) fail(`${at}.practice must be a non-empty array of lines`);
  o.practice.forEach((l, n) => text(l, `${at}.practice[${n}]`));
}

function checkOptions(options, name) {
  if (!Array.isArray(options) || !options.length) fail(`${name}.options must be a non-empty array`);
  const ids = new Set();
  options.forEach((o, i) => {
    const at = `${name}.options[${i}]`;
    onlyKeys(o, ['id', 'label', 'recommended', 'detail', 'diagram', 'practice'], at);
    checkDiagram(o, at);
    if (ids.has(text(o.id, `${at}.id`))) fail(`${name} has two options with id "${o.id}"`);
    ids.add(o.id);
    if (text(o.label, `${at}.label`).startsWith(`${o.id}. `)) fail(`${at}.label starts with "${o.id}. ", but the page adds the option letter itself`);
    optional(o.recommended, (v) => bool(v, `${at}.recommended`));
    optional(o.detail, (v) => (typeof v === 'string' ? v : fail(`${at}.detail must be text`)));
  });
  if (options.filter((o) => o.recommended).length > 1) fail(`${name} recommends more than one option`);
}

// docs/adr/2026-11-04-2200-overnight-triage-suggests-your-earlier-answers.md
// The option the overnight triage is confident the owner already chose, from their answer on an earlier card: the
// task's ref and the answer as they gave it.
function checkSuggested(s, options, at) {
  onlyKeys(s, ['option', 'task', 'answer', 'reason'], at);
  if (!options.some((o) => o.id === text(s.option, `${at}.option`))) fail(`${at}.option names no option "${s.option}"`);
  text(s.task, `${at}.task`);
  text(s.answer, `${at}.answer`);
  optional(s.reason, (v) => text(v, `${at}.reason`));
}

// A prototype is a topic recorded here, served as prototype-<topic>.html from one template (board/public/prototype.html,
// board/server.mjs), whose takes are the site's public/prototypes/<topic>/<KEY>.js (docs/adr/2026-11-01-1448-the-board-serves-every-prototype-from-one-template.md).
// A served round (served: its page's path) has no take files: the template frames that page from the board's base
// prototype worktree, which takes each take and state by message
// (docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md).
// Each record's id is its topic, so a merging write of the file (writeJSON, merge3) would merge it per record; a record
// written before records had ids reads with one.
// (docs/adr/2026-11-14-2300-picked-prototypes-draw-in-parallel-and-their-records-merge-by-topic.md)
const prototypesFile = (site) => path.join(site, 'data', 'prototypes.json');
export const takeFile = (site, topic, key) => path.join(site, 'public', 'prototypes', topic, `${key}.js`);
export async function readPrototypes(site) {
  const list = site ? (await readJSON(prototypesFile(site), {})).prototypes : null;
  return Array.isArray(list) ? list.map((p) => ({ id: p.topic, ...p })) : [];
}
// change(list) → the new list, run under the file's lock on the records the file holds now, so what it checks of them
// still holds when it writes: the sub-agents of one prototype round record their topics at once.
const changePrototypes = (site, change) => withFileLock(prototypesFile(site), async () => {
  const list = await change(await readPrototypes(site));
  await replace(prototypesFile(site), JSON.stringify({ prototypes: list }, null, 2) + '\n');
});
const prototypeTopic = (v) => (typeof v === 'string' && /^[a-z0-9-]+$/.test(v) ? v : fail(`a prototype topic uses only a-z, 0-9 and "-", not "${v}"`));
function prototypeTake(spec) {
  const m = /^([^:]*):(.*)$/s.exec(spec);
  if (!m || !/^[A-Z]$/.test(m[1])) fail(`--take takes KEY:"Label" with KEY one capital letter, not "${spec}"`);
  const label = text(m[2], `--take ${m[1]}'s label`);
  if (/^[A-Z]\.\s/.test(label)) fail(`--take ${m[1]}'s label starts with "${label.slice(0, 3)}"; the take pill shows the label alone, so drop the letter`);
  return { key: m[1], label };
}
function prototypeState(spec) {
  const m = /^([^:]*):(.*)$/s.exec(spec);
  if (!m || !/^[a-z0-9][a-z0-9-]*$/.test(m[1])) fail(`--state takes KEY:"Label" with KEY in a-z, 0-9 and "-", not "${spec}"`);
  return { key: m[1], label: text(m[2], `--state ${m[1]}'s label`) };
}
const twiceIn = (list) => list.find((t, i) => list.findIndex((u) => u.key === t.key) !== i);
const pageTopic = (url) => /^prototype-(.+)\.html$/.exec(path.posix.basename(String(url || '').split(/[?#]/)[0]))?.[1];

export async function addPrototype(site, { topic, title, card, takes = [], served, states = [] }) {
  needSite(site);
  prototypeTopic(topic);
  text(title, '--title');
  if (!takes.length) fail('prototype add needs a --take KEY:"Label" for each take');
  const parsed = takes.map(prototypeTake);
  const twice = twiceIn(parsed);
  if (twice) fail(`--take ${twice.key} is given twice`);
  if (served !== undefined && !/^\/\S*$/.test(served)) fail(`--served takes the page's path on the served site, starting with "/", not "${served}"`);
  if (states.length && served === undefined) fail('--state goes with --served: only a served round re-renders its states in place');
  const named = states.map(prototypeState);
  const stateTwice = twiceIn(named);
  if (stateTwice) fail(`--state ${stateTwice.key} is given twice`);
  if (card !== undefined) await loadItem(site, card);
  if (await fs.stat(path.join(site, 'public', `prototype-${topic}.html`)).then(() => true, () => false)) {
    fail(`public/prototype-${topic}.html is a hand-written page that questions may link; pick another topic`);
  }
  const record = { id: topic, topic, title: title.trim(), ...(card === undefined ? {} : { card }), ...(served === undefined ? {} : { served }), takes: parsed,
    ...(named.length ? { states: named } : {}), at: new Date().toISOString() };
  await changePrototypes(site, (list) => {
    if (list.some((p) => p.topic === topic)) fail(`prototype ${topic} is already recorded; run prototype rm ${topic} first, or pick another topic`);
    return [...list, record];
  });
  const page = `page prototype-${topic}.html`;
  if (served !== undefined) return { file: prototypesFile(site), lines: [page, `served ${served} from the base prototype worktree (board.mjs prototype base)`, ...(named.length ? [`states ${named.map((s) => s.key).join(', ')}`] : [])] };
  return { file: prototypesFile(site), lines: [page, ...parsed.map((t) => `take ${t.key} ${takeFile(site, topic, t.key)}`)] };
}

export async function listPrototypes(site) {
  needSite(site);
  const list = await readPrototypes(site);
  return { lines: list.length ? list.map((p) => [p.topic, p.title, p.takes.map((t) => `${t.key}: ${t.label}`).join(', '), p.card, p.served && `served ${p.served}`,
    p.states && `states ${p.states.map((s) => s.key).join(', ')}`].filter(Boolean).join(' · ')) : ['no prototypes recorded'] };
}

// The served rounds an open question links, by topic: the hub serves the board's base prototype worktree while there
// is one (hub/try.mjs tick).
export async function servedRoundsOpen(site) {
  const served = (await readPrototypes(site)).filter((p) => p.served).map((p) => p.topic);
  if (!served.length) return [];
  const owner = await readJSON(ownerFile(site), { items: [] });
  return served.filter((topic) => (owner.items || []).some((q) => !q.resolved && pageTopic(q.url) === topic));
}

// The take files stay, so a topic recorded again keeps them.
export async function removePrototype(site, topic) {
  needSite(site);
  const list = await readPrototypes(site);
  if (!list.some((p) => p.topic === topic)) fail(`no prototype "${topic}" is recorded`);
  const owner = await readJSON(ownerFile(site), { items: [] });
  const open = (owner.items || []).filter((q) => !q.resolved && pageTopic(q.url) === topic).map((q) => q.id);
  if (open.length) fail(`prototype ${topic} backs open question ${open.join(', ')}; resolve ${open.length === 1 ? 'it' : 'them'} first`);
  await changePrototypes(site, (now) => now.filter((p) => p.topic !== topic));
  return prototypesFile(site);
}

async function checkPrototype(site, q, name) {
  const page = q.url?.split(/[?#]/)[0];
  if (!page || !path.posix.basename(page).startsWith('prototype-')) return;
  const file = path.posix.basename(page);
  const query = q.url.split('#')[0].split('?').slice(1).join('?');
  const field = `${name}.url`;
  if (new URLSearchParams(query).get('q') !== q.id) fail(`${field} must be ${file}?q=${q.id} so the pill can pick`);
  const topic = pageTopic(page);
  const recorded = (await readPrototypes(site)).find((p) => p.topic === topic);
  if (!recorded) fail(`${field} names ${file}, which is not a recorded prototype; record it with board.mjs prototype add ${topic} --title "…" --take A:"…", then write its take files`);
  const keys = recorded.takes.map((t) => t.key);
  const ids = q.options.map((o) => o.id);
  const order = ids.map((id) => keys.indexOf(id));
  if (order.some((i, n) => i < 0 || (n > 0 && i < order[n - 1]))) fail(`${name}.options ids ${ids.join(', ')} must be a non-empty subset of ${file}'s takes, in take order: ${keys.join(', ')}`);
  if (recorded.served) return;
  for (const key of keys) {
    if (!(await fs.stat(takeFile(site, topic, key)).then((s) => s.isFile(), () => false))) fail(`${field} take ${key} has no file yet; write ${takeFile(site, topic, key)}`);
  }
}

// A question file holds one question or an array of them; all are checked before any is added. renderCheck(site, topic)
// then runs for each recorded prototype the questions link, and throws to refuse them
// (docs/adr/2026-11-07-0900-a-prototype-question-publishes-only-when-every-take-renders.md).
export async function addQuestions(site, input, renderCheck = async () => {}) {
  const { questions, owner, items, staged } = await checkQuestions(site, input, renderCheck);
  const lines = [];
  const held = [];
  for (const q of questions) {
    const card = q.topic.startsWith('item:') && !q.topic.startsWith('item:ask:') ? q.topic.slice(5) : null;
    const planner = card && await runningPlanner(site, card);
    if (!planner) continue;
    (staged[card] ||= []).push(q);
    held.push(q);
    lines.push(`staged: ${q.id} waits for ${card}'s ${planner} to finish; the task's staged questions then publish together`);
  }
  if (held.length) await writeJSON(stagedFile(site), staged);
  if (held.length === questions.length) return { file: stagedFile(site), lines, staged: held.length };
  return publishQuestions(site, owner, items, questions.filter((q) => !held.includes(q)), lines);
}

// Refuses a question file addQuestions would refuse, and writes nothing. → what addQuestions then reads.
export async function checkQuestions(site, input, renderCheck = async () => {}) {
  needSite(site);
  const questions = Array.isArray(input) ? input : [input];
  if (!questions.length) fail('the question file is empty');
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const items = owner.items || [];
  const staged = await readJSON(stagedFile(site), {});
  const taken = new Set([...items, ...Object.values(staged).flat()].map((q) => q.id));
  const topics = new Set((owner.topics || []).map((t) => t.id));
  for (const [i, q] of questions.entries()) {
    const name = `question ${q?.id ?? i + 1}`;
    onlyKeys(q, ['id', 'topic', 'source', 'question', 'context', 'url', 'urgent', 'options', 'round_of', 'reask_of', 'ask', 'suggested', 'prototype_gate', 'next_gate'], name);
    if (taken.has(domId(q.id, `${name}.id`))) fail(`question id "${q.id}" is already used`);
    taken.add(q.id);
    text(q.topic, `${name}.topic`);
    // docs/adr/2026-11-09-2000-old-asks-migrate-into-cards-and-the-ask-only-records-retire.md: an ask is a card, so a
    // question on it goes on that card's topic.
    if (q.topic.startsWith('item:ask:')) {
      const card = await askCardOf(site, await checkAsk(site, q.topic.slice(9), `${name}.topic`));
      fail(`${name}.topic: an ask's questions go on its task's topic${card ? `, item:${card.key}` : ''}`);
    } else if (q.topic.startsWith('item:')) await loadItem(site, q.topic.slice(5));
    else if (!topics.has(q.topic)) fail(`topic "${q.topic}" is not declared; add it with: topic add ${q.topic} --title <t>`);
    text(q.question, `${name}.question`);
    const long = lineFault(q.question);
    if (long) fail(`${name}.question ${long}; keep the question to one line and move the detail into context or the option details, which take markdown`);
    for (const k of ['source', 'context']) optional(q[k], (v) => text(v, `${name}.${k}`));
    optional(q.url, (v) => pageUrl(v, `${name}.url`));
    optional(q.urgent, (v) => bool(v, `${name}.urgent`));
    checkOptions(q.options, name);
    if (q.prototype_gate && q.next_gate) fail(`${name} sets prototype_gate and next_gate; a grill asks one closing question, next_gate`);
    for (const flag of Object.keys(GATES)) if (q[flag] !== undefined && checkGate(flag, q, `${name}.${flag}`)) await checkGateFact(site, q, flag, name);
    optional(q.suggested, (v) => checkSuggested(v, q.options, `${name}.suggested`));
    await checkPrototype(site, q, name);
    if (q.ask !== undefined) await checkAskQuestion(site, q, name);
    optional(q.round_of, (id) => {
      const from = items.find((x) => x.id === id);
      if (!from) fail(`${name}.round_of names no question "${id}" in owner.json`);
      if (from.topic !== q.topic) fail(`${name}.round_of names ${id} on topic ${from.topic}; a round stays on its question's topic, ${q.topic}`);
      if (!pageTopic(q.url)) fail(`${name}.round_of needs a url on a recorded prototype, prototype-<topic>.html?q=${q.id}`);
    });
    optional(q.reask_of, (id) => {
      const from = items.find((x) => x.id === id);
      if (!from) fail(`${name}.reask_of names no question "${id}" in owner.json`);
      if (from.topic !== q.topic) fail(`${name}.reask_of names ${id} on topic ${from.topic}; a re-ask stays on its question's topic, ${q.topic}`);
      if (!from.resolved) fail(`${name}.reask_of names ${id}, which is not resolved; only a resolved question is asked again`);
    });
  }
  for (const topic of new Set(questions.map((q) => pageTopic(q.url)).filter(Boolean))) await renderCheck(site, topic);
  return { questions, owner, items, staged };
}

// The kind of the card's open planner record (grill or prototype), or null while none runs. A visual agent or a
// reviewer posts no questions, so it holds none back.
async function runningPlanner(site, key) {
  const { source } = await loadItem(site, key);
  for (const file of await builderFiles(source.dir, parseKey(key).id)) {
    const record = await readJSON(file, null);
    if (record?.started && !record.done && plans(record) && !beside(record)) return record.kind;
  }
  return null;
}

// Publishes the card's staged questions in the order added, with one write, once no planner of it runs. A planner that
// finishes, fails or is stopped all end here, so none is lost. With screen, a finished grill's, they stay staged and the
// card waits on the orchestrator to screen them (screeningFile) instead.
async function publishStaged(site, key, { screen = false } = {}) {
  if (!site || await runningPlanner(site, key)) return;
  const staged = await readJSON(stagedFile(site), {});
  if (!staged[key]) return;
  const screening = await readJSON(screeningFile(site), {});
  if (screen) {
    if (!screening[key]) await writeJSON(screeningFile(site), { ...screening, [key]: new Date().toISOString() });
    return;
  }
  const { [key]: questions, ...rest } = staged;
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  await publishQuestions(site, owner, owner.items || [], questions, []);
  await writeJSON(stagedFile(site), rest);
  if (screening[key]) await writeJSON(screeningFile(site), withoutKey(screening, key));
}
const withoutKey = (map, key) => Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));

// The cards whose questions wait on the orchestrator to screen them: → {<key>: {since, ids}}, ids in the order added.
export async function readScreening(site) {
  const screening = await readJSON(screeningFile(site), {});
  const staged = await readJSON(stagedFile(site), {});
  return Object.fromEntries(Object.entries(screening).filter(([key]) => staged[key]).map(([key, since]) => [key, { since, ids: staged[key].map((q) => q.id) }]));
}

// The orchestrator settles one screened question the board already answers: it publishes resolved, "Settled by the
// orchestrator: <note>", and its answer goes into the card's notes as an owner's answer does. The prototype question
// is the owner's, so it is never settled.
export async function settleQuestion(site, id, note) {
  needSite(site);
  const said = text(note, '--note');
  const staged = await readJSON(stagedFile(site), {});
  const screening = await readJSON(screeningFile(site), {});
  const key = Object.keys(staged).find((k) => staged[k].some((q) => q.id === id));
  if (!key) return settleStale(site, id, said);
  if (!screening[key]) fail(`${id} waits for ${key}'s planner to finish`);
  const q = staged[key].find((x) => x.id === id);
  if (q.prototype_gate || q.next_gate) fail(`${id} is the task's ${q.next_gate ? 'closing' : 'prototype'} question, which is the owner's; question publish ${key} passes it on`);
  const at = new Date().toISOString();
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  await writeJSON(ownerFile(site), { ...owner, topics: owner.topics || [], items: [...(owner.items || []), { ...q, asked_at: at, resolved: `Settled by the orchestrator: ${said}`, resolved_at: at }] });
  const left = staged[key].filter((x) => x.id !== id);
  await writeJSON(stagedFile(site), left.length ? { ...staged, [key]: left } : withoutKey(staged, key));
  if (!left.length) await writeJSON(screeningFile(site), withoutKey(screening, key));
  await appendNotes(site, key, `Answers (orchestrator, ${noteStamp()})`, `- ${id} (${q.question}): settled by the orchestrator. "${said}"`);
  return ownerFile(site);
}

// docs/adr/2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md: on a card waiting on the re-check its
// block's end owes, the orchestrator answers a question the landed work made stale again, in its notes, as it settles
// a screened one.
async function settleStale(site, id, said) {
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const q = (owner.items || []).find((x) => x.id === id && x.topic?.startsWith('item:'));
  if (!q) fail(`no staged question "${id}"; question settle takes a question a finished grill left for you to screen, or a task's question while it waits on your re-check`);
  const key = q.topic.slice('item:'.length);
  if (!(await loadItem(site, key)).item.recheck_at) fail(`${key} waits on no re-check, so its question ${id} stays answered as it is`);
  const at = new Date().toISOString();
  await writeJSON(ownerFile(site), { ...owner, items: owner.items.map((x) => x === q ? { ...x, resolved: `Settled by the orchestrator: ${said}`, resolved_at: at } : x) });
  await appendNotes(site, key, `Answers (orchestrator, ${noteStamp()})`, `- ${id} (${q.question}): settled by the orchestrator. "${said}"`);
  return ownerFile(site);
}

// The orchestrator passes the rest of a card's screened questions on to the owner. → the ids published.
export async function publishScreened(site, key) {
  needSite(site);
  const ids = (await readScreening(site))[key]?.ids || fail(`${key} has no questions waiting on you to screen`);
  await publishStaged(site, key);
  return ids;
}

// Every card's screened questions left SCREEN_AFTER unscreened at now publish, with a thread line saying so. → [key]
export async function publishUnscreened(site, now = new Date()) {
  const due = Object.entries(await readScreening(site)).filter(([, s]) => now - Date.parse(s.since) >= SCREEN_AFTER).map(([key]) => key);
  for (const key of due) {
    await publishStaged(site, key);
    await appendStatus(site, key, 'screen-timeout');
  }
  return due;
}

async function publishQuestions(site, owner, items, questions, lines) {
  // docs/adr/2026-11-01-1813-an-answered-question-stops-waiting-once-claude-acts-on-its-card.md
  const { answers, requests } = await ownerEvents(site);
  const at = new Date().toISOString();
  const replaced = [];
  const resolved = [];
  // docs/adr/2026-11-02-1332-a-prototype-round-ends-with-a-one-take-confirm.md
  for (const q of questions.filter((x) => x.round_of)) {
    q.round = roundOf(items.find((x) => x.id === q.round_of)) + 1;
    setResolved(owner, [q.round_of], `Followed by prototype round ${q.round}`, at);
    resolved.push(q.round_of);
  }
  // A re-ask resolves its question again, which ends the owner's pending reask-request (domain.mjs ownerQuestion).
  for (const q of questions.filter((x) => x.reask_of)) {
    setResolved(owner, [q.reask_of], `Asked again as ${q.id}`, at);
    resolved.push(q.reask_of);
  }
  for (const q of questions) {
    const topic = pageTopic(q.url);
    const views = items.filter((old) => old.topic === q.topic).map((old) => ownerQuestion(old, answers, requests));
    const followed = q.topic.startsWith('item:') ? answeredOnClaude(views) : [];
    for (const old of views) {
      if (followed.includes(old.id)) {
        setResolved(owner, [old.id], `Followed by ${q.id}`, at);
        resolved.push(old.id);
      } else if (!old.resolved && topic && pageTopic(old.url) === topic) {
        setResolved(owner, [old.id], `Replaced by ${q.id}`, at);
        replaced.push(old.id);
      }
    }
  }
  const written = { ...owner, topics: owner.topics || [], items: [...items, ...questions.map((q) => ({ ...q, asked_at: at }))] };
  await writeJSON(ownerFile(site), written);
  // docs/adr/2026-11-13-0130-a-questions-added-line-is-stored-and-stays-in-the-thread.md
  for (const key of new Set(questions.map((q) => cardOfTopic(q.topic)).filter(Boolean))) {
    const ids = questions.filter((q) => cardOfTopic(q.topic) === key).map((q) => q.id);
    await appendStatus(site, key, 'questions-added', { count: ids.length }, { link: `questions.html#${encodeURIComponent(ids[0])}`, questions: ids });
    await grillAgain(site, key);
  }
  return { file: ownerFile(site), lines: [...lines, ...replaced.map((id) => `replaced: ${id}`), ...resolved.map((id) => `resolved: ${id}`)] };
}

// docs/adr/2026-11-06-0130-every-grill-ends-with-a-prototype-question-the-board-acts-on.md,
// docs/adr/2026-11-12-1400-a-grill-ends-asking-to-implement-prototype-or-discuss.md
// A gate flag set true goes on a card's own topic with exactly its gate's options, in order. field names the flag.
// → whether the flag is set
function checkGate(flag, q, field) {
  bool(q[flag], field);
  if (!q[flag]) return false;
  if (!q.topic.startsWith('item:') || q.topic.startsWith('item:ask:')) fail(`${field} goes on a task's topic, item:<file>/<id>`);
  const options = Object.keys(GATES[flag].keeps);
  if (q.options?.map((o) => o.id).join() !== options.join()) fail(`${field} takes exactly the options ${options.join(', ')}, in that order; mark the pick with \`recommended: true\`, don't reorder them`);
  return true;
}
// docs/adr/2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md
// A gate question's flag, the fact on the card it decides, gates.<kind>, and what each of its options keeps in gates:
// the owner's answer, kept so no later grill asks it again. A prototype yes becomes ran once the board moves the card to
// prototyping on it (moveOnAnswered). next_gate marks a grill's closing "What next, given these answers?": Implement
// keeps prototype no and Prototype first keeps yes, as the older prototype_gate's no and yes do; Keep discussing keeps
// gates.next discuss instead, spent once the board returns the card to discussing on it, so the next grill asks again.
const GATES = {
  prototype_gate: { kind: 'prototype', keeps: { yes: { prototype: 'yes' }, no: { prototype: 'no' } } },
  next_gate: { kind: 'prototype', keeps: { implement: { prototype: 'no' }, prototype: { prototype: 'yes' }, discuss: { next: 'discuss' } } },
};
// A gate question asks only while its fact is unset.
async function checkGateFact(site, q, flag, name) {
  const key = q.topic.slice(5);
  const { item } = await loadItem(site, key);
  const { kind } = GATES[flag];
  if (item.gates?.[kind]) fail(`${name}.${flag}: ${key} already has its ${kind} answer, ${item.gates[kind]}`);
}
// Card key keeps what its gate flag's choice keeps (GATES), and its other questions of that gate's kind resolve with
// note (resolveGate).
async function keepGate(site, key, flag, choice, note) {
  const { source, itemFile, item } = await loadItem(site, key);
  item.gates = { ...item.gates, ...GATES[flag].keeps[choice] };
  await writeJSON(source.file, itemFile);
  await resolveGate(site, key, GATES[flag].kind, note);
}
// A gate whose fact is set has no question: a published question of its kind resolves with note, as one the
// orchestrator closes does, and a staged one is dropped. → whether a published one resolved.
async function resolveGate(site, key, kind, note) {
  const ofKind = (q) => Object.keys(GATES).some((f) => q[f] && GATES[f].kind === kind);
  const staged = await readJSON(stagedFile(site), {});
  const left = (staged[key] || []).filter((q) => !ofKind(q));
  if (left.length !== (staged[key] || []).length) await writeJSON(stagedFile(site), left.length ? { ...staged, [key]: left } : withoutKey(staged, key));
  const { owner, asked } = await cardQuestions(site, key);
  const open = asked.filter((q) => ofKind(q) && q.state === 'open').map((q) => q.id);
  if (open.length) await markResolved(site, owner, open, note);
  return open.length > 0;
}

// docs/adr/2026-11-06-0130-every-grill-ends-with-a-prototype-question-the-board-acts-on.md,
// docs/adr/2026-11-07-0700-staging-then-ready.md, docs/adr/2026-11-07-1213-a-grill-waits-for-every-answer-before-it-changes-phase.md
// The owner's Send acted on with no orchestrator step. A gate question resolves and its answer becomes the card's gate
// fact (keepGate). A prototype yes while another of its card's questions is open has a thread line say the card waits
// for them. Every answer on a card goes into the card's notes verbatim, and the card then moves on once nothing is left
// open (moveOnAnswered).
// → {prototype: [keys], staged: [keys]}: the cards whose prototype planner the server starts, and the cards staged.
export async function settleAnswers(site, answers) {
  const asked = new Map(((await readJSON(ownerFile(site), { items: [] })).items || []).map((q) => [q.id, q]));
  for (const a of answers) {
    const q = asked.get(String(a.id));
    const flag = Object.keys(GATES).find((f) => q?.[f]);
    if (!flag || !(a.choice in GATES[flag].keeps)) continue;
    const chose = flag === 'next_gate' ? `Next: ${q.options.find((o) => o.id === a.choice).label}` : `Prototype round: ${a.choice}`;
    const said = `${chose}. The board moves the task on once every question is answered.`;
    await markResolved(site, await readJSON(ownerFile(site), { topics: [], items: [] }), [q.id], said);
    const key = q.topic.slice(5);
    const card = await loadItem(site, key).catch(() => null);
    if (!card) continue;
    await keepGate(site, key, flag, a.choice, said);
    if (GATES[flag].keeps[a.choice].prototype === 'yes' && card.item.phase === 'grilling' && await hasOpenQuestion(site, key)) {
      await appendStatus(site, key, 'prototype-after');
    }
  }
  const byCard = new Map();
  for (const a of answers) {
    const q = asked.get(String(a.id));
    const key = cardOfTopic(q?.topic);
    if (key) byCard.set(key, [...(byCard.get(key) || []), answerLine(q, a)]);
  }
  const prototype = [];
  const staged = [];
  for (const [key, said] of byCard) {
    if (!(await loadItem(site, key).catch(() => null))) continue;
    await followUp(site, key, 'writing them into its notes', async () => {
      await appendNotes(site, key, `Answers (owner, ${noteStamp()})`, said.join('\n'));
      const moved = await moveOnAnswered(site, key);
      if (moved === 'prototyping') prototype.push(key);
      if (moved === 'staging') staged.push(key);
    });
  }
  return { prototype, staged };
}

// docs/adr/2026-11-07-1213-a-grill-waits-for-every-answer-before-it-changes-phase.md
// A card moves on once none of its questions is open: a grilling card whose gates.prototype is yes to prototyping, with
// a thread line, the yes then spent as ran (docs/adr/2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md); a grilling
// card whose gates.next is discuss back to discussing, the discuss spent
// (docs/adr/2026-11-12-1400-a-grill-ends-asking-to-implement-prototype-or-discuss.md); a
// prototyping or discussing card back to the conversation, discussing (docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md);
// any other stageable card to staging. The move to prototyping owes the orchestrator's prototype brief.
// → 'prototyping', 'discussing', 'staging' or null when the card stays.
async function moveOnAnswered(site, key) {
  const { item } = await loadItem(site, key);
  const { asked } = await cardQuestions(site, key);
  // A requested question is handed to a prototype or the grill, whose round decides the next phase.
  if (asked.some((q) => q.state === 'open' || q.state === 'requested')) return null;
  if (item.phase === 'grilling' && item.gates?.prototype === 'yes') {
    await setItem(site, key, { phase: 'prototyping' });
    const { source, itemFile, item: moved } = await loadItem(site, key);
    moved.gates = { ...moved.gates, prototype: 'ran' };
    owe(moved, 'prototype');
    await writeJSON(source.file, itemFile);
    return 'prototyping';
  }
  if (item.phase === 'grilling' && item.gates?.next === 'discuss') {
    const { source, itemFile, item: kept } = await loadItem(site, key);
    spendNext(kept);
    await writeJSON(source.file, itemFile);
    await discuss(site, key);
    return 'discussing';
  }
  if (!(await stageable(site, key))) return null;
  if (['prototyping', 'discussing'].includes(item.phase)) {
    await discuss(site, key);
    return 'discussing';
  }
  await stage(site, key);
  return 'staging';
}

// Drops item's gates.next, the owner's Keep discussing, once a move has acted on it or overridden it; gates goes with
// it when nothing else is kept.
function spendNext(item) {
  if (!item.gates?.next) return;
  const { next, ...gates } = item.gates;
  if (Object.keys(gates).length) item.gates = gates;
  else delete item.gates;
}

// docs/adr/2026-11-08-0900-send-records-once-and-follow-ups-fail-on-their-own.md
// Runs one card's follow-up to an owner Send, which is already recorded: any failure becomes a fault line on the card.
export async function followUp(site, key, what, run) {
  try { await run(); } catch (e) {
    await appendStatus(site, key, 'answers-failed', { what, error: e.message });
  }
}

// docs/adr/2026-11-07-0700-staging-then-ready.md
// A card's key from a question topic, item:<file>/<id>, or null for any other topic, an ask's included.
const cardOfTopic = (topic) => (typeof topic === 'string' && topic.startsWith('item:') && !topic.startsWith('item:ask:') ? topic.slice(5) : null);
const pad2 = (n) => String(n).padStart(2, '0');
// The owner's time on a notes heading, MM/DD HH:MM in the host's local time.
const noteStamp = (d = new Date()) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
// One answer as its notes line: the question, the option picked by its label, and the owner's note verbatim.
function answerLine(q, a) {
  const picked = a.choice === null || a.choice === undefined || a.choice === '' ? null : (q.options || []).find((o) => o.id === a.choice)?.label ?? String(a.choice);
  const note = String(a.note || '').trim();
  return `- ${q.id} (${q.question}): ${picked ? `${picked}.` : 'no option picked.'}${note ? ` Note, verbatim: "${note}"` : ''}`;
}
// docs/adr/2026-11-09-1100-the-board-owns-a-cards-notes-file.md
// A card's notes file is written here and nowhere else. The board names it <id>-notes.md beside the card's item file,
// every write after the first is an appended section under the card's lock, written to a temp file then renamed, and
// the file is kept read-only, so a shell's `cat >` or `cat >>` into it fails while the rename still replaces it.
const NOTES_MODE = 0o444;
const notesBase = (id) => String(id).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
const notesLock = (dir, id, fn) => withFileLock(path.join(dir, `.${notesBase(id)}-notes`), fn);
// The card's own notes name, <id>-notes.md, or -2, -3… while a file of that name is already there.
function freeNotesName(dir, id) {
  let name = `${notesBase(id)}-notes.md`;
  for (let n = 2; existsSync(path.join(dir, name)); n++) name = `${notesBase(id)}-notes-${n}.md`;
  return name;
}
async function writeNotesFile(file, content) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await fs.rm(tmp, { force: true });
  await fs.writeFile(tmp, content, { mode: NOTES_MODE });
  await fs.rename(tmp, file);
  wrote(file);
}
const notesHeading = (v) => (/\n/.test(text(v, '--heading')) ? fail('--heading is one line, the section\'s title') : text(v, '--heading'));
const withSection = (notes, heading, body) => `${notes.replace(/\n*$/, '\n')}\n## ${heading}\n${body.replace(/^\n+|\s+$/g, '')}\n`;

// Appends a section, ## heading then body, to the card's notes, first making the card's <id>-notes.md when it has
// none, or starting its named file again, with a thread line saying so, when that file is gone. → its file name.
async function appendNotes(site, key, heading, body) {
  const { source, item: { id } } = await loadItem(site, key);
  return notesLock(source.dir, id, async () => {
    const { source, itemFile, item } = await loadItem(site, key);
    let file;
    if (item.plan) {
      file = await planPath(source.dir, item.plan, { missingOk: true });
      if (!existsSync(file)) await appendStatus(site, key, 'notes-missing');
    } else {
      item.plan = freeNotesName(source.dir, item.id);
      file = path.join(source.dir, item.plan);
      await writeJSON(source.file, itemFile);
    }
    const notes = existsSync(file) ? await fs.readFile(file, 'utf8') : `# ${item.title}\n`;
    await writeNotesFile(file, withSection(notes, notesHeading(heading), body));
    // docs/adr/2026-11-15-1030-a-triaged-task-owes-an-investigate-wait-until-its-notes-are-written.md
    if (item.triaged && !item.triaged.investigated_at) {
      item.triaged.investigated_at = new Date().toISOString();
      await writeJSON(source.file, itemFile);
    }
    return item.plan;
  });
}

// Every card that names a notes file, live then archived: [{key, ref, title, created, archived, dir, plan}]. An
// archived card's folder is its item file's, or the site's data/ once that item file is gone.
async function cardsWithNotes(site, archived = () => readArchive(site)) {
  const { tickets } = settingsOf(await boardConfig(site));
  const cards = [];
  const files = new Map();
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    files.set(source.slug, { source, itemFile: itemFile || {} });
    for (const it of itemFile?.items || []) if (it.plan) cards.push({ key: `${source.slug}/${it.id}`, ref: refOf(itemFile, it, tickets), title: it.title, created: it.created || '', archived: false, dir: source.dir, plan: it.plan });
  }
  for (const a of site ? await archived() : []) {
    if (!a.item?.plan) continue;
    const at = files.get(a.file);
    cards.push({ key: a.key, ref: refOf(at?.itemFile || {}, a.item, tickets), title: a.item.title, created: a.item.created || '', archived: true, dir: at?.source.dir || path.join(site, 'data'), plan: a.item.plan });
  }
  return cards;
}
const realNotes = (card) => fs.realpath(path.resolve(card.dir, card.plan)).catch(() => null);
// Refuses a draft that is any card's notes file, live, done or archived, naming that card; hint(card) ends the error.
// A draft of - is stdin, which is no card's notes file.
async function refuseCardNotes(site, draft, flag, hint) {
  if (draft === '-') return readFileSync(0, 'utf8');
  const real = await fs.realpath(draft).catch(() => fail(`${flag} ${draft}: no such file`));
  for (const card of await cardsWithNotes(site)) {
    if (await realNotes(card) === real) fail(`${flag} ${draft} is the notes file of ${card.ref} "${card.title}" (${card.key}), and a task's notes are its own; ${hint(card)}`);
  }
  return fs.readFile(real, 'utf8');
}
const DRAFT_HINT = 'write a draft of your own outside the board\'s data folder';

// `item notes <key> --heading <h> --file <draft>`, or `--from <other key>` to fold that card's notes in as a section
// (headed --heading, or "Folded from <ref> "<title>""). Resolves the card's answered questions still waiting on Claude,
// as recording their answers in the notes acts on them. → {file, heading, lines}
export async function addNotes(site, key, { heading, file, from }) {
  let body;
  if (from !== undefined) {
    if (from === key) fail(`${key} can't fold its own notes into itself; pass --from <the other task>`);
    const [into, other] = await Promise.all([loadItem(site, key), loadItem(site, from)]);
    const [a, b] = await Promise.all([into, other].map(({ source, item }) => (item.plan ? fs.realpath(path.resolve(source.dir, item.plan)).catch(() => null) : null)));
    if (a && a === b) fail(`${from} and ${key} name one notes file, ${into.item.plan}, from before the board named each task's own; the board splits it as it starts`);
    body = (await readNotes(site, from)).markdown;
    heading ??= `Folded from ${await cardName(site, from)} "${other.item.title}"`;
  } else {
    body = await refuseCardNotes(site, file, '--file', (card) => (card.key === key ? `${DRAFT_HINT}, holding only the new section` : `${DRAFT_HINT}, or fold that task's notes in with item notes ${key} --from ${card.key}`));
  }
  if (!body.trim()) fail(`${from ?? file} is empty`);
  const name = await appendNotes(site, key, heading, body);
  await passNews(site, key, { from: 'notes', text: `the section "${heading}"; read it in ${path.resolve((await loadItem(site, key)).source.dir, name)}` });
  const lines = await resolveAnswered(site, key, "Recorded in the task's notes");
  // docs/adr/2026-11-16-1700-a-filed-task-links-where-it-came-from-and-the-tasks-it-names.md: notes are written while
  // investigating, so a task the section names that isn't linked yet becomes Related rather than a refusal.
  const linked = await linkedWith(site, key);
  const unlinked = (await namedTasks(site, `${heading}\n${body}`)).filter((n) => n.key !== key && !linked.has(n.key)).map((n) => n.key);
  if (unlinked.length) await setItem(site, key, { relate: unlinked.join(',') });
  return { file: name, heading, lines: [...lines, ...unlinked.map((k) => `related: ${k}`)] };
}

// docs/adr/2026-11-09-1100-the-board-owns-a-cards-notes-file.md
// Run by the board server as it starts: of the cards naming one notes file, live or archived, the earliest made keeps
// it and each later live card gets a copy under its own name, with a thread line; an archived card is never rewritten.
// Every card's notes file is then made read-only. → one line per card given its own copy.
export const splitSharedNotes = (site, archived = () => readArchive(site)) => ticketWrite(site, async () => {
  const cards = await cardsWithNotes(site, archived);
  const byFile = new Map();
  for (const card of cards) {
    const real = await realNotes(card);
    if (real) byFile.set(real, [...(byFile.get(real) || []), card]);
  }
  const lines = [];
  for (const [real, sharing] of byFile) {
    const [keeper, ...later] = sharing.sort((x, y) => (x.created < y.created ? -1 : x.created > y.created ? 1 : x.key < y.key ? -1 : 1));
    for (const card of later.filter((c) => !c.archived)) {
      const { source, itemFile, item } = await loadItemFile(site, parseKey(card.key).file).then((l) => ({ ...l, item: l.itemFile.items.find((it) => it.id === parseKey(card.key).id) }));
      const was = item.plan;
      item.plan = freeNotesName(source.dir, item.id);
      await writeNotesFile(path.join(source.dir, item.plan), await fs.readFile(real, 'utf8'));
      await writeJSON(source.file, itemFile);
      await appendStatus(site, card.key, 'notes-shared', { card: keeper.ref });
      lines.push(`${card.key}: its own notes, ${item.plan}, copied from ${path.normalize(was)}, which ${keeper.key} keeps`);
    }
    await fs.chmod(real, NOTES_MODE);
  }
  return lines;
});
// Whether a Send leaves the card stageable: unstarted, with no PR, no planner or build running, no question open and a
// take picked on its prototypes.
async function stageable(site, key) {
  const { source, item } = await loadItem(site, key);
  if (leftTodo(item) || hasPR(item) || item.pushed) return false;
  const records = await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)));
  if (records.some((r) => r?.started && !r.done && !beside(r))) return false;
  if ((await cardQuestions(site, key)).asked.some((q) => q.state === 'open')) return false;
  if ((await readJSON(stagedFile(site), {}))[key]) return false;
  return !(await unpickedPrototype(site, key));
}
// Stages the card, keeping the time of a stage it is already in, with a "Marked as staged" status line when it newly
// stages. A Keep discussing the stage overrides is spent (spendNext).
async function stage(site, key, sendId) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (item.phase === 'staging') return;
  leaveNew(item);
  // The line and the wait share one moment, so the line's footer finds its wait by it (domain.mjs markWaitStarts).
  const at = new Date().toISOString();
  Object.assign(item, { phase: 'staging', staged_at: at });
  delete item.unfiled;
  delete item.filed_held;
  delete item.ready_at;
  delete item.ready_main;
  spendNext(item);
  await writeJSON(source.file, itemFile);
  await appendCommand(site, key, { command: 'staged', sendId, ts: at });
}
// docs/adr/2026-11-14-1700-a-ready-task-unpulled-a-day-re-stages-when-main-has-moved.md
// How long a card may sit ready and unpulled before main's moving sends it back to staging.
export const READY_EXPIRES_MS = 24 * 60 * 60 * 1000;
// A ready card in Todo has ready_at, the time of its ready, and ready_main, the base branch's commit then. main is that
// commit now: a card with no ready_main yet records it (and a ready_at, for a card readied before the record), and one
// ready for READY_EXPIRES_MS whose main differs from its ready_main, blocked or not, goes back to staging with a line,
// its notes kept, for the orchestrator's usual staging re-check. → the keys it re-staged
export async function restageStaleReady(site, main, now = new Date()) {
  const restaged = [];
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    let changed = false;
    for (const item of itemFile?.items || []) {
      if (item.phase !== 'ready' || leftTodo(item) || closed(item)) continue;
      if (!item.ready_main) {
        item.ready_main = main;
        item.ready_at ??= now.toISOString();
        changed = true;
      } else if (item.ready_main !== main && now - Date.parse(item.ready_at) >= READY_EXPIRES_MS) {
        Object.assign(item, { phase: 'staging', staged_at: now.toISOString() });
        delete item.ready_at;
        delete item.ready_main;
        delete item.recheck_at;
        changed = true;
        restaged.push(`${source.slug}/${item.id}`);
      }
    }
    if (changed) await writeJSON(source.file, itemFile);
  }
  for (const key of restaged) await appendStatus(site, key, 'ready-expired');
  return restaged;
}
// Returns the card to its conversation, with a "Marked as discussing" status line when it newly moves there.
async function discuss(site, key) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (item.phase === 'discussing') return;
  leaveNew(item);
  item.phase = 'discussing';
  await writeJSON(source.file, itemFile);
  await appendCommand(site, key, { command: 'discussing' });
}
// The owner's words from a thread message, text then any attached files, as one notes body, or '' when it carried none.
const messageWords = ({ text: said, files }) => [String(said || '').trim(), ...(Array.isArray(files) ? files : []).map((f) => `Attached: ${f?.path || f?.name || f}`)].filter(Boolean).join('\n');

// docs/adr/2026-11-15-0100-an-implement-tap-stops-the-card-s-planners-and-stages-it.md
// An Implement wins over whatever is in flight on the card: each open planner record (grill, prototype, visual) closes,
// its staged and screening questions, its owed briefs and its questions not yet resolved go, the last as "Skipped: you
// tapped Implement", which also ends their prototype chains (domain.mjs noTakePicked). → the closed planners' {pid, at},
// for the board server to stop.
async function endPlanners(site, key) {
  const { source, item } = await loadItem(site, key);
  const now = new Date().toISOString();
  const stopped = [];
  for (const file of await builderFiles(source.dir, item.id)) {
    const record = await readJSON(file, null);
    if (!record?.started || record.done || !plans(record)) continue;
    await writeJSON(file, { ...record, done: now, note: 'Stopped by your Implement tap' });
    stopped.push({ pid: record.session?.pid ?? null, at: record.session?.at ?? null });
  }
  for (const file of [stagedFile(site), screeningFile(site)]) {
    const map = await readJSON(file, {});
    if (map[key]) await writeJSON(file, withoutKey(map, key));
  }
  const { owner, asked } = await cardQuestions(site, key);
  const unresolved = asked.filter((q) => q.state !== 'resolved').map((q) => q.id);
  if (unresolved.length) await markResolved(site, owner, unresolved, IMPLEMENT_SKIPPED);
  const { source: file, itemFile, item: card } = await loadItem(site, key);
  if (card.briefs) {
    delete card.briefs;
    await writeJSON(file.file, itemFile);
  }
  return stopped;
}

// An Implement message on a Todo card, in the board server before its event: a card the owner blocked, or that waits on a task,
// stays blocked (docs/adr/2026-11-16-1030-implement-stages-a-blocked-card-and-keeps-the-block.md); its planners end (endPlanners); its words go into the notes; and it is staged in Todo.
// → the planners it closed, for the board server to stop.
export async function stageImplement(site, key, message) {
  await clearOwnerWait(site, key);
  const stopped = await endPlanners(site, key);
  const words = messageWords(message);
  if (words) await appendNotes(site, key, `Implement (owner, ${noteStamp()}), verbatim`, words);
  // A bare tap's staging line is the tap's own line, so it carries the tap's sendId; a message already holds it.
  await stage(site, key, words ? undefined : message.sendId);
  return stopped;
}
// docs/adr/2026-11-12-0700-reply-implement-marks-a-card-ready-to-implement.md
// An owner's Implement, Done, Prototype, Grill or Visual tap, or message, on a card ends the orchestrator's waits_on_owner mark (implement or close).
export async function clearOwnerWait(site, key) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (!item.waits_on_owner) return;
  delete item.waits_on_owner;
  await writeJSON(source.file, itemFile);
}
// thread <card> --implement or --close: marks a card waiting on the owner's Implement, or (a work card) only on their Done (docs/adr/2026-11-12-0800-reply-close-marks-a-card-waiting-to-be-closed.md).
// docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md: the mark holds the phase
// and lane it was set in, and the board reads it only while the card keeps both (domain.mjs ownerWaitOf). Implement is
// refused on a card already staged, ready or past Todo, which has had it.
async function markWaiting(site, key, on) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (on === 'implement') refuseImplementOwed(key, item);
  item.waits_on_owner = ownerMark(item, on);
  await writeJSON(source.file, itemFile);
}
const ownerMark = (item, on) => ({ on, at: new Date().toISOString(), ...markedState(item) });
// Where a card is that has had its Implement, in words: its phase in Todo, else its lane.
export const HAD_IMPLEMENT = { staging: 'staged', ready: 'ready', progress: 'in progress', review: 'in review', done: 'done' };
function refuseImplementOwed(key, item) {
  const { phase, lane } = markedState(item);
  const had = HAD_IMPLEMENT[lane === 'todo' ? phase : lane];
  if (had) fail(`${key} is already ${had}, so it owes no Implement: write in its thread without --implement`);
}
// The readied line's words: "Marked as ready · " and the orchestrator's check whole, which item set refuses when the
// line can't hold it (lineFault), for the orchestrator to rewrite; it is never cut.
const READIED_LEAD = `${COMMANDS.readied} · `;
function readiedText(said) {
  const words = said.trim();
  const shape = `the status line "${READIED_LEAD}<text>"`;
  if (words.includes('\n')) fail(`--text is ${shape}, one line; rewrite it as one`);
  const long = lineFault(words, BRIEF_LINE_LIMIT - READIED_LEAD.length);
  if (long) fail(`--text ${long}: it is ${shape}, which holds ${BRIEF_LINE_LIMIT}; rewrite it to fit`);
  return READIED_LEAD + words;
}
// A Reply on a ready Todo card: its words go into the notes, and it is staged again.
export async function stageReply(site, key, message) {
  const words = messageWords(message);
  if (words) await appendNotes(site, key, `Reply (owner, ${noteStamp()}), verbatim`, words);
  await stage(site, key);
}
// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
// A card's briefs, item.briefs [{kind, at, ask?, asks?, brief?: {heading, text, at}}], kind grill, prototype, visual or
// reviewer.
// An entry with no brief is owed: the orchestrator writes it (item brief, writeBrief). One with a brief waits for the
// board server to launch its agent (domain.mjs briefsDue), which takes the entry off the card onto the agent's record
// (startPlanner, startBeside). An owner's request it answers is {text?, files?, question?, note?, choice?}: a prototype
// entry keeps each in asks, every one its own round; any other entry keeps the newest as ask. A kind owed again
// keeps its first time.
// (docs/adr/2026-11-14-2300-picked-prototypes-draw-in-parallel-and-their-records-merge-by-topic.md)
const BRIEF_KINDS = ['grill', 'prototype', VISUAL, REVIEWER];
const PLANNER_PHASE = { grill: 'grilling', prototype: 'prototyping' };
function owe(item, kind, ask = {}, at = new Date().toISOString(), tap = false) {
  const briefs = item.briefs || [];
  const owed = briefs.find((b) => b.kind === kind && !b.brief);
  const requested = !Object.keys(ask).length ? {} : kind === 'prototype' ? { asks: [...(owed?.asks || []), ask] } : { ask };
  const asked = { ...requested, ...(tap ? { tap } : {}) };
  item.briefs = owed ? briefs.map((b) => (b === owed ? { ...b, ...asked } : b)) : [...briefs, { kind, at, ...asked }];
}
// A card sent back to its conversation owes nothing: its unwritten briefs go, the written ones stay for their launch.
function dropOwed(item) {
  if (!item.briefs) return;
  item.briefs = item.briefs.filter((b) => b.brief);
  if (!item.briefs.length) delete item.briefs;
}
// The owner's Grill or Prototype tap (kind grill or prototype) on a Todo card: the card owes the orchestrator's brief for
// it, and a discussing, ready or staging card moves to grilling or prototyping. A Visual or Review tap (kind visual or
// reviewer) owes that agent's brief on any open card and moves no phase.
export async function planAgain(site, key, kind, ask = {}) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (closed(item) || (!beside({ kind }) && leftTodo(item))) return;
  if (!beside({ kind }) && ['discussing', 'ready', 'staging'].includes(item.phase)) {
    item.phase = PLANNER_PHASE[kind];
    delete item.staged_at;
  }
  owe(item, kind, ask, undefined, true);
  await writeJSON(source.file, itemFile);
}
// The board's own call for a planner, a card arriving in Todo with no planner yet: it owes the brief, its phase as it is.
export async function oweBrief(site, key, kind) {
  const { source, itemFile, item } = await loadItem(site, key);
  owe(item, kind);
  await writeJSON(source.file, itemFile);
}
// `item brief <key> --kind grill|prototype|visual --file <draft.md>`: the orchestrator's brief for the card's next agent
// of that kind, appended to its notes as "Brief for <kind> round N" and set on the kind's owed entry, or on a new one when
// the orchestrator briefs an agent nobody asked for. A grill or prototype brief moves the Todo card to that phase; the
// board server launches the agent from it. → {heading, lines}
export async function writeBrief(site, key, { kind, file }) {
  needSite(site);
  if (!BRIEF_KINDS.includes(kind)) fail(`item brief needs --kind grill, prototype, ${VISUAL} or ${REVIEWER}`);
  if (file === undefined) fail('item brief needs --file <draft.md>: what the discussion settled, what is still open, what the agent should cover and the files that matter');
  const name = await cardName(site, key);
  const { item } = await loadItem(site, key);
  if (closed(item)) fail(`${name} is done; there is nothing to brief`);
  if (!beside({ kind }) && leftTodo(item)) fail(`${name} is past Todo, so it gets no ${kind}`);
  const body = (await refuseCardNotes(site, file, '--file', () => `${DRAFT_HINT}, holding only the brief`)).trim();
  if (!body) fail(`${file} is empty`);
  const notes = item.plan ? (await readNotes(site, key)).markdown : '';
  const heading = `Brief for ${kind} round ${(notes.match(new RegExp(`^## Brief for ${kind} round \\d+`, 'gm')) || []).length + 1}`;
  await appendNotes(site, key, heading, body);
  const { source, itemFile, item: briefed } = await loadItem(site, key);
  const at = new Date().toISOString();
  const tapped = (briefed.briefs || []).some((b) => b.kind === kind && !b.brief && b.tap);
  if (!(briefed.briefs || []).some((b) => b.kind === kind && !b.brief)) owe(briefed, kind, {}, at);
  briefed.briefs = briefed.briefs.map((b) => (b.kind === kind && !b.brief ? { ...b, brief: { heading, text: body, at } } : b));
  if (!beside({ kind }) && briefed.phase !== PLANNER_PHASE[kind]) {
    leaveNew(briefed);
    briefed.phase = PLANNER_PHASE[kind];
    delete briefed.staged_at;
  }
  await writeJSON(source.file, itemFile);
  // The owner's tap wrote its own "<Kind> requested" line; a brief nobody tapped for is the orchestrator's own start, and its line reads "<Kind> started". The event wakes the
  // board's auto pass, which launches the agent.
  if (!tapped) await appendCommand(site, key, { command: `${kind}-started` });
  await appendEvent({ dir: site }, 'brief-written', { key, kind });
  return { heading, lines: [`${name}: "${heading}" added to its notes; the board launches its ${{ [VISUAL]: 'visual agent', [REVIEWER]: 'reviewer' }[kind] ?? `${kind} planner`} from it`] };
}
// The card's oldest written brief of kind taken off the card, once the agent's record holds it (startPlanner, startVisual).
async function dropBrief(site, key, kind) {
  const { source, itemFile, item } = await loadItem(site, key);
  const entry = (item.briefs || []).find((b) => b.kind === kind && b.brief);
  if (!entry) return;
  item.briefs = item.briefs.filter((b) => b !== entry);
  if (!item.briefs.length) delete item.briefs;
  await writeJSON(source.file, itemFile);
}
// A brief put back on the card for its agent to launch from again (a visual agent the usage limit stopped).
export async function restoreBrief(site, key, entry) {
  const { source, itemFile, item } = await loadItem(site, key);
  item.briefs = [...(item.briefs || []), entry];
  await writeJSON(source.file, itemFile);
}
// The oldest written brief of kind on the card, left on it, or null.
const briefOn = async (site, key, kind) => ((await loadItem(site, key)).item.briefs || []).find((b) => b.kind === kind && b.brief) ?? null;
const noBrief = async (site, key, kind) => fail(`${await cardName(site, key)} has no ${kind} brief; the orchestrator writes it with item brief ${key} --kind ${kind} --file <draft.md>`);
// A question published on a ready or staging card leaves the owner something to decide, so the card is grilling until
// the answer's Send stages it again.
async function grillAgain(site, key) {
  const loaded = await loadItem(site, key).catch(() => null);
  if (!loaded || !['ready', 'staging'].includes(loaded.item.phase) || leftTodo(loaded.item)) return;
  loaded.item.phase = 'grilling';
  delete loaded.item.staged_at;
  await writeJSON(loaded.source.file, loaded.itemFile);
}

// The ids of a topic's answered questions that Claude acting on the card resolves.
function answeredOnClaude(views) {
  return views.filter((q) => q.state === 'answered' || (q.state === 'requested' && q.request.kind === 'grill-more')).map((q) => q.id);
}

function setResolved(owner, ids, note, at = new Date().toISOString()) {
  for (const q of owner.items || []) if (ids.includes(q.id)) Object.assign(q, { resolved: note, resolved_at: at });
}

async function markResolved(site, owner, ids, note) {
  setResolved(owner, ids, note);
  await writeJSON(ownerFile(site), owner);
  return ownerFile(site);
}

// waitsOn (close | implement) also puts the note in the question's card's thread and marks that card waiting on the owner's
// Done or Implement, the card marked first so no state between shows Implement
// (docs/adr/2026-11-13-2030-question-resolve-takes-close-so-implement-never-flashes.md).
export async function resolveQuestion(site, id, note, { waitsOn } = {}) {
  needSite(site);
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const q = (owner.items || []).find((x) => x.id === id);
  if (!q) fail(`no question "${id}" in owner.json`);
  const { answers, requests } = await ownerEvents(site);
  const view = ownerQuestion(q, answers, requests);
  // A question Send already resolved ANSWERED still takes --close or --implement, which mark its card waiting.
  if (view.state === 'resolved' && !(waitsOn && q.resolved === ANSWERED)) return ownerFile(site);
  // docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md
  if (view.state === 'requested' && view.request.kind === 'grill-more') fail(`${id} waits on the grill the owner sent it to; the grill's next question add resolves it`);
  if (view.state === 'requested') fail(`${id} waits on the prototype the owner asked for; question add with round_of ${id} resolves it`);
  const said = waitsOn ? messageText(note) : text(note, '--note');
  const key = cardOfTopic(q.topic);
  if (waitsOn && !key) fail(`${id} is not a card's question (topic ${q.topic}), so there is no card to mark waiting on ${waitsOn}`);
  if (pageTopic(q.url)) roundSettled(owner, q, answers);
  if (waitsOn) await markWaiting(site, key, waitsOn);
  const file = await markResolved(site, owner, [id], said);
  if (waitsOn) await appendMessage(site, key, { text: said });
  await clearWaitedNext(site, q.topic);
  // docs/adr/2026-11-07-1213-a-grill-waits-for-every-answer-before-it-changes-phase.md: a question the orchestrator
  // closes counts as answered, so the grilling card it leaves with nothing open moves on.
  const moved = key && (await loadItem(site, key).catch(() => null))?.item.phase === 'grilling' ? await moveOnAnswered(site, key) : null;
  // The mark holds the phase it was set in, so a card the answer moved on is marked again where it still owes it: a
  // close anywhere, an Implement only where it is owed.
  if (waitsOn && moved && (waitsOn === 'close' || OWES_IMPLEMENT.includes(moved))) await markWaiting(site, key, waitsOn);
  return file;
}

// docs/adr/2026-11-05-1000-a-question_for_several_cards_moves_to_the_card_built_first.md
// The triage's merge of questions that ask one thing. ids are open questions, the first the one that stays: it moves
// onto card `to` (topic item:<to>). The others resolve "Duplicate of <to's ref>'s question <first>". Each card in
// `block`, in order, is then blocked by the one before it (the first by `to`) and related to `to`.
export async function moveQuestions(site, ids, to, block = []) {
  needSite(site);
  const [kept, ...others] = [...new Set(ids)];
  if (!kept) fail('question move takes the ids of the questions to merge');
  await loadItem(site, to);
  const chain = [to, ...block];
  if (new Set(chain).size !== chain.length) fail('question move names a task twice');
  for (const key of block) await loadItem(site, key);
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const { answers, requests } = await ownerEvents(site);
  for (const id of [kept, ...others]) {
    const q = (owner.items || []).find((x) => x.id === id) || fail(`no question "${id}" in owner.json`);
    const { state } = ownerQuestion(q, answers, requests);
    if (state !== 'open') fail(`${id} is ${state}; question move takes open questions`);
  }
  for (const [i, key] of block.entries()) {
    const { item } = await loadItem(site, key);
    const deps = [...(item.deps || []), chain[i]].join(',');
    await setItem(site, key, { deps, relate: to });
  }
  const ref = await cardName(site, to);
  Object.assign(owner.items.find((x) => x.id === kept), { topic: `item:${to}` });
  setResolved(owner, others, `Duplicate of ${ref}'s question ${kept}`);
  await writeJSON(ownerFile(site), owner);
  return ownerFile(site);
}

// docs/adr/2026-11-02-1607-a-pick-with-no-note-settles-a-prototype-round.md
// Each owner answer with a note and no take resolves its question, noting "Answered with a note", in one write.
export async function resolveNoteAnswers(site, answers) {
  const ids = answers.filter(({ choice, note }) => !choice && String(note || '').trim()).map((a) => a.id);
  const owner = ids.length ? await readJSON(ownerFile(site), { topics: [], items: [] }) : null;
  if (!owner?.items?.some((q) => ids.includes(q.id))) return;
  setResolved(owner, ids, 'Answered with a note');
  await writeJSON(ownerFile(site), owner);
}

// docs/adr/2026-11-15-1200-an-answered-question-folds-on-send.md
// Each owner answer to a card's question that Send leaves unresolved (a gate's is resolved by settleAnswers) resolves
// its question, noting ANSWERED, so it folds at once; the orchestrator's answer wait ends at its next thread line.
export async function resolveSentAnswers(site, answers) {
  const { owner, asked } = await topicQuestionsAll(site);
  const sent = new Set(answers.map((a) => String(a.id)));
  const ids = asked.filter((q) => sent.has(q.id) && q.state === 'answered' && cardOfTopic(q.topic) && !Object.keys(GATES).some((f) => q[f])).map((q) => q.id);
  if (ids.length) await markResolved(site, owner, ids, ANSWERED);
}

// docs/adr/2026-11-03-0504-a-prototype-pick-is-the-builds-go.md
// Refuses while no answer settles q's round.
function roundSettled(owner, q, answers) {
  const n = roundOf(q);
  const round = owner.items.filter((x) => x.topic === q.topic && roundOf(x) === n).map((x) => ownerQuestion(x, answers));
  if (!roundSettledBy(round, n)) fail(`${q.id} is in prototype round ${n}, which no pick has settled yet; a pick settles it`);
}

// The owner's answers, each with whether it has a reply, and prototype requests, from the event log: what
// domain.mjs ownerQuestion reads a question's state from. → {answers, requests}
async function ownerEvents(site) {
  const events = await readLog(path.join(site, 'data', 'events.jsonl'));
  const replies = await readReplyIndex(path.join(site, 'data', 'replies'));
  const answers = events.filter((e) => e.kind === 'owner-answer').map((e) => ({ ...e, reply: e.reply || replies.has(e.id) }));
  return { answers, requests: events.filter((e) => e.kind === 'prototype-request' || e.kind === 'grill-more') };
}

// docs/adr/2026-11-08-0900-send-records-once-and-follow-ups-fail-on-their-own.md
// The answers whose question still waits for one: open. An answer to a question owner.json doesn't hold is kept for the
// caller to refuse.
export async function unrecorded(site, answers) {
  const { asked } = await topicQuestionsAll(site);
  const state = new Map(asked.map((q) => [q.id, q.state]));
  return answers.filter((a) => !state.has(String(a.id)) || state.get(String(a.id)) === 'open');
}
// Why an answer can't be sent: its question is handed to a prototype or the grill, which resolves it with the next round
// (docs/adr/2026-11-15-1100-grill-more-hands-its-question-to-the-grill.md). → the reason, or null.
export async function handedOver(site, answers) {
  const { asked } = await topicQuestionsAll(site);
  const waiting = asked.find((q) => q.state === 'requested' && answers.some((a) => String(a.id) === q.id));
  return waiting ? `${waiting.id} waits on the ${waiting.request.kind === 'grill-more' ? 'grill' : 'prototype'} the owner asked for; its next round resolves it.` : null;
}
async function topicQuestionsAll(site) {
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const { answers, requests } = await ownerEvents(site);
  return { owner, asked: (owner.items || []).map((q) => ownerQuestion(q, answers, requests)) };
}

export async function topicQuestions(site, topic) {
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const { answers, requests } = await ownerEvents(site);
  const asked = (owner.items || []).filter((q) => q.topic === topic).map((q) => ownerQuestion(q, answers, requests));
  return { owner, asked };
}
const cardQuestions = (site, key) => topicQuestions(site, `item:${key}`);

const resolveAnswered = (site, key, note) => resolveAnsweredOn(site, `item:${key}`, note);
async function resolveAnsweredOn(site, topic, note) {
  if (!site) return [];
  const { owner, asked } = await topicQuestions(site, topic);
  const ids = answeredOnClaude(asked);
  if (ids.length) await markResolved(site, owner, ids, note);
  await clearWaitedNext(site, topic);
  return ids.map((id) => `resolved: ${id}`);
}

// docs/adr/2026-11-03-1313-an-answer-stops-waiting-once-its-acted-on.md
// A Next set while its card had an open question waits on the card's questions (the item file entry's next_on_questions).
const hasOpenQuestion = async (site, key) => Boolean(site) && (await cardQuestions(site, key)).asked.some((q) => q.state === 'open');
function setNext(item, next, waitsOnQuestions) {
  item.next = text(next, '--next');
  item.next_at = new Date().toISOString();
  if (waitsOnQuestions) item.next_on_questions = true; else delete item.next_on_questions;
}
// Clears that Next once none of the card's questions is left unresolved: the card then reads "Next: none set yet".
// topic is the card's question topic, item:<key>; any other topic, or a card no longer on the board, has no Next to clear.
async function clearWaitedNext(site, topic) {
  const key = topic.startsWith('item:') && !topic.startsWith('item:ask:') ? topic.slice(5) : null;
  if (!key) return;
  let loaded;
  try { loaded = await loadItem(site, key); } catch (e) { if (e instanceof BoardError) return; throw e; }
  const { source, itemFile, item } = loaded;
  if (!item.next_on_questions) return;
  if ((await cardQuestions(site, key)).asked.some((q) => q.state !== 'resolved')) return;
  delete item.next;
  delete item.next_at;
  delete item.next_on_questions;
  await writeJSON(source.file, itemFile);
}

// A build's start clears the card's Next, whatever it waits on: the card reads its builder line
// (docs/adr/2026-11-03-1718-a-card-reads-starting-from-its-tap-with-one-dispatched-mark.md).
async function clearNext(site, key) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (item.next === undefined && item.next_on_questions === undefined) return;
  delete item.next;
  delete item.next_at;
  delete item.next_on_questions;
  await writeJSON(source.file, itemFile);
}

// Closing a card resolves its questions (topic item:<key>) that have an answer, and refuses while one has none, naming
// `by`, unless force. → resolve(): writes the resolutions and returns `resolved: <id>` lines. Changes nothing itself.
async function closeQuestions(site, key, by, force) {
  if (!site) return async () => [];
  const { owner, asked } = await cardQuestions(site, key);
  const open = asked.filter((q) => q.state === 'open').map((q) => q.id);
  if (open.length && !force) fail(`${by}: ${key} has ${open.length === 1 ? 'an open question' : 'open questions'} ${open.join(', ')} with no answer yet; pass --force to close the task and resolve ${open.length === 1 ? 'it' : 'them'} too`);
  const ids = asked.filter((q) => q.state !== 'resolved').map((q) => q.id);
  return async () => {
    if (ids.length) await markResolved(site, owner, ids, 'Closed with the task');
    return ids.map((id) => `resolved: ${id}`);
  };
}

// Refuses what `item set <key> --status done --text <said>` (with ownerStep and check, land's --owner-step and --check)
// would refuse for its questions or its text, writing nothing, so board.mjs land can check before it lands.
export async function checkClose(site, key, said, ownerStep, check) {
  await loadItem(site, key);
  messageText(said);
  optional(ownerStep, (v) => text(v, '--owner-step'));
  optional(check, (v) => checkSpec(v));
  await closeQuestions(needSite(site), key, 'land', false);
}

// docs/adr/2026-11-03-0504-a-prototype-pick-is-the-builds-go.md
// The card's noTakePicked, from owner.json and the owner's answers. → {id, note}, or null.
async function unpickedPrototype(site, key) {
  const owner = await readJSON(ownerFile(site), { items: [] });
  const { answers, requests } = await ownerEvents(site);
  return noTakePicked((owner.items || []).map((q) => ownerQuestion(q, answers, requests)), key);
}
const clip = (s) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

// docs/adr/2026-11-02-1806-only-the-owner-or-auto-build-starts-a-card-run.md
// The owner's words on this board that can ask for a card run: an ask, an edit to one, a card message, an answer's note.
// An ask the orchestrator filed (askItem, data.asked) is not the owner's.
const OWNER_WORDS = { ask: 'text', 'ask-edited': 'text', 'item-message': 'text', 'owner-answer': 'note' };
// → words, once they quote what the owner wrote on this board; else it refuses, naming flag.
async function ownerQuote(site, words, flag) {
  const quoted = text(words, flag).replace(/\s+/g, ' ');
  const said = (await readLog(path.join(site, 'data', 'events.jsonl'))).filter((e) => !e.data?.asked).map((e) => String(e.data?.[OWNER_WORDS[e.kind]] ?? '').replace(/\s+/g, ' ').toLowerCase());
  if (!said.some((t) => t.includes(quoted.toLowerCase()))) fail(`${flag} must quote the owner's words in an ask, task message or answer note on this board`);
  return quoted;
}

// → the thread line a session's card run writes once the hub starts it; refuses words the owner didn't write here.
export async function askedGate(site, key, asked) {
  needSite(site);
  if (asked === undefined) fail(`only the owner's Serve / Build and the hub's Auto-build start a task run; pass --asked "<the owner's words>" quoting where the owner asked for ${key}'s run`);
  return `Running at the owner's ask: "${await ownerQuote(site, asked, '--asked')}"`;
}

async function checkAsk(site, eventId, name = '--from-ask') {
  domId(eventId, name);
  const known = (await readLog(path.join(needSite(site), 'data', 'events.jsonl'))).some((e) => e.id === eventId && e.kind === 'ask');
  return known ? eventId : fail(`no ask "${eventId}" in this site's data/events.jsonl`);
}

// docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md
// A card's stored lane (todo, progress, review, done), written only here, with lane_at; a move to Done writes closed_at
// and a move out of it reopened_at, which the next move to Done clears.
// docs/adr/2026-11-11-1200-every-lane-has-phases.md: the card's phase in the lane is written with it (setPhase), phase
// when given, else what the move says: a card coming back to Todo from another lane is ready, as a build left it, one
// staying in Todo keeps its phase, a build's start reads reading, a close merged when one of its PRs merged or it landed
// (landed) and closed otherwise, and In Review's waits for the board's settle pass (domain.mjs movesOf). → the lane it
// left, undefined for a card never placed.
function placeIn(item, to, now = new Date().toISOString(), phase = movedPhase(item, to)) {
  if (!LANES[to]) throw new Error(`no lane "${to}"`);
  const from = item.lane;
  setPhase(item, to, phase);
  item.lane = to;
  item.lane_at = now;
  if (to === 'done') { item.closed_at = now; delete item.reopened_at; }
  else if (from === 'done') item.reopened_at = now;
  return from;
}
function movedPhase(item, to, landed = false) {
  if (to === 'todo') return leftTodo(item) ? 'ready' : item.phase ?? null;
  if (to === 'progress') return 'reading';
  if (to === 'done') return landed || storedPRs(item).some((p) => p.merged_at) ? 'merged' : 'closed';
  return null;
}
// A card's phase in lane `to`, one of that lane's PHASES; null takes it off, which a new Todo card reads as new.
function setPhase(item, to, phase) {
  if (phase !== null && !PHASES[to].includes(phase)) throw new Error(`no ${LANES[to]} phase "${phase}"`);
  if (phase === null) delete item.phase; else item.phase = phase;
}
// Moves the card at key to lane `to`, with why as a move line in its thread, and phase as its phase there, unless it is
// there already. A card's first placement writes no line, and nor does a phase change within its lane. → the line, or
// null. snapshot, the lane and phase the move was made from ({lane, phase}), skips the move when the file
// reads another: a tap made since the board was built stands, and the next settle builds from it
// (docs/adr/2026-11-09-2100-a-settle-move-never-undoes-a-tap-made-after-its-snapshot.md). The file is read, checked and
// written under its lock, so a tap written while the move waited for the lock is the one it checks
// (docs/adr/2026-11-09-2230-a-settle-move-checks-its-snapshot-under-the-item-files-lock.md).
export async function moveCard(site, key, to, why, phase, snapshot) {
  const { source } = await loadItem(site, key);
  const { id } = parseKey(key);
  const now = new Date().toISOString();
  const moved = await withFileLock(source.file, async () => {
    const itemFile = JSON.parse(await fs.readFile(source.file, 'utf8'));
    const item = itemFile.items.find((it) => it.id === id) || fail(`item file "${source.slug}" has no item "${id}"`);
    if (snapshot && ((item.lane ?? null) !== snapshot.lane || (item.phase ?? null) !== snapshot.phase)) return false;
    if (item.lane === to && (phase === undefined || (item.phase ?? null) === phase)) return false;
    let from;
    if (item.lane === to) setPhase(item, to, phase);
    else from = placeIn(item, to, now, phase);
    await replace(source.file, JSON.stringify(itemFile, null, 2) + '\n');
    // A phase change within the lane and a first placement write no line.
    return from !== undefined;
  });
  if (!moved) return null;
  const line = { ts: now, who: 'claude', kind: MOVE, text: `Moved to ${LANES[to]}: ${text(why, 'why')}` };
  await appendLine(threadFile(site, key), line);
  return line.text;
}
// docs/adr/2026-10-29-1639-cards-wait-on-explicit-blocked-by-links.md: a Done card, or one reopened since, has finished
// for the cards waiting on it.
const closed = (item) => item?.lane === 'done' || Boolean(item?.reopened_at);
// Whether the card has left Todo: it is stored in another lane.
const leftTodo = (item) => Boolean(item?.lane) && item.lane !== 'todo';
export const isFinished = async (site, key) => closed((await loadItem(site, key)).item);
// docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md, docs/adr/2026-11-07-0700-staging-then-ready.md,
// docs/adr/2026-11-11-1200-every-lane-has-phases.md, docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md: a Todo
// card's phase. Staging is the board's alone, set on an owner action; --phase takes the rest. --state was its name
// before every lane had phases.
const AGENT_PHASES = ['ready', 'discussing', 'grilling', 'prototyping'];
const AGENT_PHASE_LIST = 'ready, discussing, grilling or prototyping';
// The phases a planner works the card in.
const PLANNED = ['grilling', 'prototyping'];
function checkPhase(phase, state) {
  if (state !== undefined) fail(`--state is now --phase: pass --phase ${AGENT_PHASES.includes(state) ? state : AGENT_PHASE_LIST}`);
  if (phase === 'staging') fail(`--phase staging is set by the board, on an owner action; pass ${AGENT_PHASE_LIST}`);
  if (phase !== undefined && !AGENT_PHASES.includes(phase)) fail(`--phase takes ${AGENT_PHASE_LIST}`);
}
const QUICK_NOT_SMALL = (key) => `${key} came from a Quick build ask, which goes ready only when small (--size small) with no open question; discuss it instead: reply with --phase discussing, and the owner's Implement after the discussion readies it at any size`;
const NOT_STAGED = "a task goes ready only from staging, which the board sets on the owner's Send, Implement or Reply";
// Whether ask eventId asked for an Implement: the New task sheet's Implement, or an Implement on its New card. The
// orchestrator files it --from-ask --phase ready, its filing the judgment staging would ask for
// (docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md).
async function quickAsk(site, eventId) {
  const events = await readLog(path.join(needSite(site), 'data', 'events.jsonl'));
  return events.some((e) => (e.kind === 'ask' && e.id === eventId && e.data?.quick === true) || (e.kind === 'item-message' && e.data?.key === `ask:${eventId}` && e.data?.intent === 'build'));
}
// docs/adr/2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md: a Slack @kickflip discusses
// first, whoever sent it, so its ask goes ready only once the owner stages its card, even with an Implement on it.
const SLACK_DISCUSSES = (ask) => `ask "${ask}" came from a Slack @kickflip, which always discusses first: file it --phase discussing; the owner's Implement after the discussion readies it`;
async function fromSlack(site, eventId) {
  const events = await readLog(path.join(needSite(site), 'data', 'events.jsonl'));
  return events.some((e) => e.kind === 'ask' && e.id === eventId && e.data?.routed?.via === 'slack');
}
// A Next asking the owner to mark the card ready ("Mark ready", "mark it ready").
const ASKS_READY = /^mark (?:it |this |the (?:task|card) )?ready\b/i;
// docs/adr/2026-11-03-1904-a-card-holds-several-prs-across-repos.md: each --pr adds a PR, owner/repo#n or a bare number in the
// board's repo (repo), to the card's list; one it already holds stays as it is. An older pr: <n> moves into the list.
function addPRs(item, refs, repo) {
  const added = [].concat(refs).map((ref) => parsePRRef(ref) || fail(`--pr takes a PR number or owner/repo#<n>, not "${ref}"`));
  const same = (a, b) => a.number === b.number && (a.repo || repo || null) === (b.repo || repo || null);
  const list = storedPRs(item);
  for (const p of added) if (!list.some((q) => same(q, p))) list.push(p);
  delete item.pr;
  item.prs = list;
}
const depKey =(slug, dep) => (String(dep).includes('/') ? String(dep) : `${slug}/${dep}`);
// A dep is a card, by key or by bare id in item file slug. → the keys of the cards deps waits on
const depCards = (slug, deps) => [...new Set((deps || []).map((d) => depKey(slug, d)))];
async function unfinishedDeps(site, slug, item) {
  const keys = depCards(slug, item.deps);
  const deps = await Promise.all(keys.map((k) => loadItem(site, k).then(({ item: d }) => d, () => null)));
  return keys.filter((k, i) => deps[i] && !closed(deps[i]));
}
// The names of what blocks item (at key) from starting: each unfinished dep's card name, then its blocked-until condition.
async function blockerNames(site, key, item) {
  const deps = await Promise.all((await unfinishedDeps(site, parseKey(key).file, item)).map((k) => cardName(site, k)));
  return item.blocked_until ? [...deps, item.blocked_until] : deps;
}
// What blocks the card at key (item, else its item file entry) as words after "blocked": "by #53, #54 and until <condition>",
// or '' when nothing does.
export async function blockWords(site, key, item) {
  item ??= (await loadItem(site, key)).item;
  const deps = await Promise.all((await unfinishedDeps(site, parseKey(key).file, item)).map((k) => cardName(site, k)));
  return [deps.length && `by ${deps.join(', ')}`, item.blocked_until && `until ${item.blocked_until}`].filter(Boolean).join(' and ');
}
// docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md: a card In Progress is one started with
// none of a PR, a pushed branch or a held Merge, which keep it In Review: a build runs on it, or its build handed back.
const inProgress = (item, records) => !hasPR(item) && !item.pushed && !item.merge_ready && !closed(item)
  && (Boolean(handedBackAt(records)) || records.some((r) => r?.started && !r.done && builds(r)));
// → the keys of the blocked cards whose last unfinished dep was key and no condition blocks.
async function unblockedBy(site, key) {
  const out = [];
  for (const s of await itemSources(site)) {
    const itemFile = await readJSON(s.file, null);
    for (const it of Array.isArray(itemFile?.items) ? itemFile.items : []) {
      if (closed(it) || it.blocked_until || !depCards(s.slug, it.deps).includes(key)) continue;
      if (!(await unfinishedDeps(site, s.slug, it)).length) out.push(`${s.slug}/${it.id}`);
    }
  }
  return out;
}

// docs/adr/2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping.md: --split-into for card key, closing as a split: a comma
// list of cards (deps entries), none of them key. → {entries: each card's full key, words: what it split into, "#a, #b",
// waiters: the keys of the open cards with a dep on key}. It refuses a waiter that is one of the cards it splits into,
// which would wait on itself.
async function splitPlan(site, key, splitInto) {
  const slug = parseKey(key).file;
  const entries = depCards(slug, await depList(site, slug, splitInto));
  if (!entries.length) fail('--split-into takes the tasks the split filed, <id>,<file>/<id>');
  if (entries.includes(key)) fail(`${key} can't be split into itself`);
  const words = await Promise.all(entries.map((d) => cardName(site, d)));
  const waiters = [];
  for (const s of await itemSources(site)) {
    for (const it of (await readJSON(s.file, null))?.items || []) {
      const own = `${s.slug}/${it.id}`;
      if (closed(it) || !(it.deps || []).some((d) => depKey(s.slug, d) === key)) continue;
      if (entries.includes(own)) fail(`${own} waits on ${key} and is one of the tasks it splits into, so it would wait on itself`);
      waiters.push(own);
    }
  }
  return { entries, words: words.join(', '), waiters };
}

// Each waiter of the split card key (splitPlan) trades its dep on key for the split's entries, each card entry by bare id
// in the waiter's own item file, and gets a line in its thread.
async function moveWaiters(site, key, { entries, words, waiters }) {
  for (const s of await itemSources(site)) {
    const mine = waiters.filter((w) => parseKey(w).file === s.slug);
    if (!mine.length) continue;
    const itemFile = await readJSON(s.file, null);
    for (const it of itemFile.items.filter((x) => mine.includes(`${s.slug}/${x.id}`))) {
      const moved = entries.map((d) => (parseKey(d).file === s.slug ? parseKey(d).id : d));
      it.deps = [...new Set([...it.deps.filter((d) => depKey(s.slug, d) !== key), ...moved])];
    }
    await writeJSON(s.file, itemFile);
  }
  const card = await cardName(site, key);
  for (const w of waiters) await appendStatus(site, w, 'split-moved', { card, to: words });
}

// docs/adr/2026-11-07-1500-an-unblock-past-todo-waits-on-the-orchestrator.md: a card past Todo records when its block
// ended, which domain.mjs orchestratorWaitOf reads as a wait until the session writes on the card. ts is its Unblocked line's.
// A ready card in Todo records it as recheck_at, which keeps the pull off it until the orchestrator re-checks its notes
// against what landed and releases it with item set --phase ready --text
// (docs/adr/2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md). One still planning is judged in staging.
async function markUnblocked(site, key, ts) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (leftTodo(item)) item.unblocked_at = ts;
  else if (item.phase === 'ready') item.recheck_at = ts;
  else return;
  await writeJSON(source.file, itemFile);
}

// docs/adr/2026-11-17-0700-a-recheck-whose-blocker-touched-none-of-the-tasks-files-releases-itself.md
// The paths a task's notes name: tokens with a folder slash or a file extension of letters. A token names a changed file
// when it is that file, a folder holding it, or a bare file name (SKILL.md) ending the file's path.
const namedPaths = (markdown) => [...new Set((markdown.match(/[\w.-]+(?:\/[\w.-]+)+|[\w-]+\.[a-z]\w+/gi) || []).map((t) => t.replace(/^\.\/|[.\/]+$/g, '')).filter((t) => /[a-z]/i.test(t)))];
const namesFile = (named, file) => file === named || file.startsWith(`${named}/`) || (!named.includes('/') && file.endsWith(`/${named}`));

// A card waiting on its recheck whose blocker landed files (the paths its diff changed) none of its notes name has the
// wait ended here. Notes naming no path, or no notes, leave the wait to the orchestrator. → whether it released.
async function releaseRecheck(site, key, files) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (!item.recheck_at) return false;
  const markdown = await itemNotes(source.dir, item);
  const named = markdown ? namedPaths(markdown) : [];
  if (!named.length || files.some((f) => named.some((n) => namesFile(n, f)))) return false;
  delete item.recheck_at;
  await writeJSON(source.file, itemFile);
  return true;
}

async function checkNextDeps(site, key, item, next) {
  const mentions = new Set(next.match(/#?[\w-]+(?:\.[\w-]+)*(?:\/[\w-]+(?:\.[\w-]+)*)*/g) || []);
  const deps = new Set(depCards(parseKey(key).file, item.deps));
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    for (const other of itemFile?.items || []) {
      const otherKey = `${source.slug}/${other.id}`;
      if (otherKey === key || deps.has(otherKey) || closed(other)) continue;
      const names = [other.id, refOf(itemFile, other), other.ticket].filter(Boolean).flatMap((id) => [id, `${source.slug}/${id}`]);
      if (names.some((name) => mentions.has(name))) fail(`--next names unfinished task ${otherKey}; add it with --blocked-by`);
    }
  }
}

// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
// Ready means a builder can start from the card alone: it has a size, a notes file, and that file names the id of every
// question on the card the owner answered, bar a gate question (prototype_gate, next_gate) answered with no note (docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md).
const NOTES_COMMAND = (key) => `item notes ${key} --heading "<heading>" --file <draft.md>`;
function checkSizeAndNotes(key, item) {
  const starts = 'a builder starts from it, so pass';
  if (!item.size) fail(`${key} has no size; ${starts} --size small or large with --phase ready`);
  if (!item.plan) fail(`${key} has no notes file; a builder starts from it, so add its notes with ${NOTES_COMMAND(key)} before --phase ready`);
}
async function checkNotesComplete(site, key, dir, item) {
  checkSizeAndNotes(key, item);
  const notes = await fs.readFile(await planPath(dir, item.plan), 'utf8');
  const left = (await cardQuestions(site, key)).asked.filter((q) => q.answers.length && !notes.includes(q.id) && !((q.prototype_gate || q.next_gate) && !q.answers.at(-1).note)).map((q) => q.id);
  if (left.length) fail(`${key}'s notes leave out the answered question${left.length === 1 ? '' : 's'} ${left.join(', ')}; record each answer in its notes, naming its id, with ${NOTES_COMMAND(key)} before it is ready`);
}

// docs/adr/2026-10-29-1639-a-full-plan-opens-as-a-page-on-the-site.md
// With missingOk, a notes file that doesn't exist yet gives the path it would have.
async function planPath(dir, rel, { missingOk = false } = {}) {
  const bad = (why) => fail(`a notes file is a .md file inside ${dir}, named relative to it: "${rel}" ${why}`);
  if (typeof rel !== 'string' || !rel.trim()) bad('is empty');
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) bad('leaves the folder');
  if (path.extname(rel).toLowerCase() !== '.md') bad('is not a .md file');
  const root = await fs.realpath(dir);
  const real = await fs.realpath(path.resolve(dir, rel)).catch(() => missingOk ? path.resolve(root, rel) : bad('does not exist'));
  if (!real.startsWith(root + path.sep)) bad('leaves the folder');
  return real;
}

// → {itemFile, item, markdown}: the item's notes file (stored in `plan`) once it passes planPath's checks, or with no file
// its short `notes` text, so notes written before the page existed still show; otherwise a BoardError.
export async function readNotes(site, key) {
  const { source, itemFile, item } = await loadItem(site, key);
  const markdown = await itemNotes(source.dir, item);
  if (markdown === null) fail(`${key} has no notes`);
  return { itemFile, item, markdown };
}

// → the notes of item in the item file at dir, as readNotes reads them, or null for none; a notes file that fails
// planPath's checks is a BoardError.
export async function itemNotes(dir, item) {
  if (item.plan) return fs.readFile(await planPath(dir, item.plan), 'utf8');
  return typeof item.notes === 'string' && item.notes.trim() ? item.notes : null;
}

// docs/adr/2026-10-29-1729-a-device-app-card-carries-an-install-link.md
// iOS installs over the air only from an itms-services:// manifest link, and Android from an https .apk.
function installOf({ install, installSha, installLabel, clearInstall }) {
  if (install === undefined) {
    if (installSha !== undefined || installLabel !== undefined) fail('--install-sha and --install-label go with --install <url>');
    return clearInstall ? null : undefined;
  }
  if (clearInstall) fail('pass --install or --clear-install, not both');
  let url;
  try { url = new URL(String(install).trim()); } catch { url = null; }
  if (!url || !['https:', 'itms-services:'].includes(url.protocol)) fail(`--install takes an https:// or itms-services:// URL, not "${install}"`);
  if (url.protocol === 'itms-services:' && !(url.searchParams.get('action') === 'download-manifest' && /^https:\/\//.test(url.searchParams.get('url') || ''))) {
    fail('--install: an itms-services:// URL needs ?action=download-manifest&url=https://…/manifest.plist');
  }
  const sha = installSha === undefined ? undefined : /^[0-9a-f]{7,40}$/i.test(installSha) ? installSha.toLowerCase() : fail(`--install-sha takes a commit sha of 7 to 40 hex digits, not "${installSha}"`);
  return { url: String(install).trim(), ...(installLabel === undefined ? {} : { label: text(installLabel, '--install-label') }), built_at: new Date().toISOString(), ...(sha ? { sha } : {}) };
}

export async function setMainInstall(site, { install, installSha }) {
  const built = installOf({ install, installSha });
  if (!built) fail('main set needs --install <url>');
  const file = path.join(needSite(site), 'data', 'main.json');
  await writeJSON(file, { install: built });
  return { file, lines: ['main install set'] };
}

// "Merged PR #6." or "Merged PRs #6, owner/site#1.", naming the PRs as prNames does; "Merged." with none.
export const mergedLine = (prs, repo) => (prs.length ? `Merged PR${prs.length > 1 ? 's' : ''} ${prNames(prs, repo)}.` : 'Merged.');

// docs/adr/2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md
// The thread line closing a card writes as its last: --text, the orchestrator's message, which a close on a site
// needs; or the board's status line, closing ([kind, inputs]) or for a merge mergedLine's. → {text} or {status}, or null.
function closingLine(site, key, merged, text, repo, closing) {
  if (closing) return { status: closing };
  if (merged && text === undefined) return { status: ['merged', { words: mergedLine(merged, repo) }] };
  if (text === undefined && site) fail(`--done needs --text "<what was done, or why it closes without landing>", which becomes ${key}'s last thread line`);
  return text === undefined ? null : { text };
}
// Marks each of merged [{repo?, number, at?}] that the card holds with its merge time, merged_at.
function markMerged(item, merged, repo) {
  const now = new Date().toISOString();
  const same = (a, b) => a.number === b.number && (a.repo || repo || null) === (b.repo || repo || null);
  item.prs = storedPRs(item).map((p) => {
    const m = merged.find((q) => same(p, q));
    return m && !p.merged_at ? { ...p, merged_at: m.at || now } : p;
  });
  delete item.pr;
}

// docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md
// → the item file, and when a dep finishes the items it unblocked as `unblocked: <key>` lines; closing (done) adds a
// `resolved: <id>` line per question it resolved (closeQuestions), and moves the card to Done. merged, a merge's close,
// is the PRs that merged [{repo?, number, at?}], each marked on the card with its merged_at. start, a build's start
// (startBuilder), moves the card to In Progress after the checks a build's start makes; handBack, builder done's with
// judgment calls, closes its open records marked handed_back for the orchestrator's check. A handover (--pr, --pushed,
// --merge-ready) moves it to In Review, and a block on a card In Progress back to Todo.
// text is the closing line (closingLine), the orchestrator's words, or closing the board's ([kind, inputs], a status
// line of hub-lines.mjs); with fromAsk text is the item's first thread line.
// ownerStep is the owner step builder done or land records, and ownerDone the owner's Done, which alone clears it
// (docs/adr/2026-11-04-0158-a-card-whose-code-landed-stays-in-review-while-an-owner-step-remains.md). check is the
// step's code check (--check "<name> <args>", "" to remove it), kept as owner_check {check, since, broken?} while the
// step remains (docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md). risk is the builder's judgment of its
// change, low, medium or high, which builder done records and the PR's Slack link shows (prLink). replyOn (--reply-on)
// is the orchestrator's reply on a card this call links or unlinks while its owner waits on that reply (replyFirst).
async function changeItem(site, key, { replyOn, risk, ticket, newTicket, status, clearStatus, done, splitInto, merged, landed, landedFiles, start, handBack, next, clearNext, pr, pushed, mergeReady, ghSince, fromAsk, phase, state, block, unblock, pickUpAt, deps, blockedUntil, blockReason, parent, split: splitOfParent, related, relate, unrelate, install, installSha, installLabel, clearInstall, title, size, model, force, text: said, closing, who, by, command, ownerStep, ownerDone, check, finishAsk, triaged }, options) {
  if (status !== undefined || clearStatus) fail(`--status${clearStatus ? ' and --clear-status are' : ' is'} gone: a task's lane is stored and moves itself. Close it with --done --text "<what was done, or why it closes without landing>"`);
  if (merged) done = true;
  if (related !== undefined && (relate !== undefined || unrelate !== undefined)) fail('pass --related, or --relate and --unrelate, not both');
  checkPhase(phase, state);
  if (force && !done) fail('--force goes with --done');
  if (splitInto !== undefined && !done) fail('--split-into goes with --done');
  if (splitInto !== undefined && said !== undefined) fail('--split-into writes the closing line; drop --text');
  const split = splitInto === undefined ? null : await splitPlan(site, key, splitInto);
  if (split) said = `Split into ${split.words}`;
  if (fromAsk !== undefined && done) fail('--from-ask opens a task; close it in another call');
  if (said !== undefined) messageText(said);
  if (ownerStep !== undefined) text(ownerStep, '--owner-step');
  if (risk !== undefined && !RISKS.includes(risk)) fail(`--risk takes low, medium or high, not "${risk}"`);
  const spec = check === undefined || check === '' ? check : checkSpec(check);
  if (said !== undefined && fromAsk === undefined && !done && phase !== 'ready') fail('--text goes with --from-ask, --done, or --phase ready on a staging task');
  if (fromAsk !== undefined && said === undefined) fail('--from-ask needs --text "<first line>", the item\'s first thread line after the ask');
  if (next !== undefined && clearNext) fail('pass --next or --clear-next, not both');
  if (typeof next === 'string' && !next.trim()) [next, clearNext] = [undefined, true];
  const hold = holdOf({ block, unblock, pickUpAt });
  const built = installOf({ install, installSha, installLabel, clearInstall });
  if ([done, start, handBack, next, clearNext, pr, pushed, mergeReady, ghSince, fromAsk, phase, hold, deps, blockedUntil, blockReason, parent, related, relate, unrelate, built, title, size, model, ticket, newTicket, ownerStep, check, risk].every((v) => v === undefined || v === false)) fail('nothing to set: pass --done, --next, --clear-next, --pr, --pushed, --gh-since, --from-ask, --phase, --blocked, --unblocked, --pick-up-at, --blocked-by, --blocked-until, --block-reason, --parent, --related, --relate, --unrelate, --install, --clear-install, --title, --size, --model, --ticket, --new-ticket or --check');
  const ask = fromAsk === undefined ? undefined : await checkAsk(site, fromAsk);
  if (ask) await refuseMoved(site, ask);
  if (ask) await refuseFiled(site, ask, key);
  const { source, itemFile, item } = await loadItem(site, key);
  const file = parseKey(key).file;
  const before = { parent: item.parent, deps: (item.deps || []).map((d) => depKey(file, d)), wasNew: inIntake(item) };
  // docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md: filing a Quick build ask is the orchestrator's
  // judgment, so it goes ready from any phase, as does sorting the New card one became
  // (docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md).
  // A card item triage sorted is still its filing while it keeps the phase triage gave it
  // (docs/adr/2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md).
  const askOf = ask ?? (!item.phase || item.triaged?.phase === item.phase ? item.from_ask : undefined);
  const quick = askOf !== undefined && await quickAsk(site, askOf);
  // An answered card the orchestrator sorts after all is work: it goes back to Todo in that phase.
  if (phase !== undefined && item.answered_at && !item.closed_at) {
    delete item.answered_at;
    if (leftTodo(item)) placeIn(item, 'todo', undefined, null);
  }
  if (phase !== undefined && leftTodo(item)) fail(`--phase sets a Todo task's phase; ${key} is ${LANES[item.lane]}, where the board sets it`);
  if (phase === 'ready' && askOf !== undefined && !['staging', 'ready'].includes(item.phase) && await fromSlack(site, askOf)) fail(SLACK_DISCUSSES(askOf));
  if (phase === 'ready' && !quick && !['staging', 'ready'].includes(item.phase)) fail(`${key} reads ${item.phase || 'new'}, not staging; ${NOT_STAGED}`);
  // docs/adr/2026-11-14-1500-a-quick-ask-goes-ready-only-when-small-with-no-open-question.md: an Implement is no
  // discussion, so only a small change goes ready on it; the owner's tap after a discussion (staging) settles any size.
  if (phase === 'ready' && quick && !['staging', 'ready'].includes(item.phase) && (size ?? item.size) !== 'small') fail(QUICK_NOT_SMALL(key));
  if (ask && item.from_ask && item.from_ask !== ask) fail(`${key} came from ask "${item.from_ask}", so ask "${ask}" can't be its from-ask; to fold it in: item relate-ask ${ask} ${key} --summary "<line>"`);
  // docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md
  if (ask && hold && phase !== undefined && !item.phase) fail('a task filed blocked is filed New and takes no --phase; drop --phase, or drop --blocked to file it in a phase');
  if (ask && phase === undefined && !item.phase && !hold) fail('--from-ask files a task, which reads New until it has a phase: pass --phase discussing, grilling, prototyping, or ready for a Quick build ask, or --blocked to file it for later');
  const wasFinished = closed(item);
  if (split && wasFinished) fail(`${key} is already Done, so the tasks waiting on it were unblocked then; move them with item set <key> --blocked-by`);
  if (ownerStep !== undefined && wasFinished) fail(`${key} is already Done, so its ticket closed; an owner step goes on the command that finishes the task: land --owner-step, or builder done before the merge`);
  if (ownerStep !== undefined) item.owner_step = text(ownerStep, '--owner-step');
  if (ownerDone) delete item.owner_step;
  if (spec !== undefined && !item.owner_step) fail(`--check goes with an owner step, which ${key} doesn't have: pass --owner-step "<the step>" with it on builder done or land`);
  // Setting the same check again clears its broken mark and keeps when it was attached.
  if (spec) item.owner_check = { check: spec, since: item.owner_check?.check === spec ? item.owner_check.since : new Date().toISOString() };
  if (spec === '' || !item.owner_step) delete item.owner_check;
  const records = await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)));
  // docs/adr/2026-11-12-2300-a-finished-ask-waits-in-todo-with-an-orange-close.md: nothing landed for an ask no build
  // ran on, so the orchestrator's --done on it is refused; it waits in Todo for the owner's Done (reply --close).
  if (finishAsk && done && item.from_ask && !merged && !landed && !ownerDone && !closing && !split && !wasFinished
    && !records.some((r) => r && builds(r)) && !item.branch && !hasPR(item) && !item.pushed && !item.merge_ready) {
    fail(`${key} is an ask no build ran on, so nothing landed to mark Done; post the answer with reply ${key} --text "<answer>" --close (or thread ${key} --close) and it waits in Todo for the owner's Done`);
  }
  const owedBefore = owesNext(item, records);
  if (title !== undefined) item.title = cardTitle(title);
  setBuildChoice(item, { size, model });
  if (risk !== undefined) item.risk = risk;
  if (deps !== undefined) {
    const list = await depList(site, parseKey(key).file, deps);
    if (list.length) item.deps = list; else delete item.deps;
  }
  // docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md: a block waits on cards (deps) or a condition,
  // with one reason for either, which goes when the block does. lifted: the condition this call cleared, if any.
  const lifted = blockedUntil === '' ? item.blocked_until : undefined;
  if (blockedUntil !== undefined) {
    if (blockedUntil === '') delete item.blocked_until; else item.blocked_until = text(blockedUntil, '--blocked-until');
  }
  if (blockReason) {
    if (!item.deps?.length && !item.blocked_until) fail('--block-reason goes with a block: --blocked-by or --blocked-until');
    item.block_reason = text(blockReason, '--block-reason');
  }
  if (blockReason === '' || (!item.deps?.length && !item.blocked_until)) delete item.block_reason;
  if (parent !== undefined) {
    const to = await parentKey(site, parseKey(key).file, key, parent);
    if (to) item.parent = to; else delete item.parent;
  }
  // docs/adr/2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md: a split child keeps the answers its parent's grill got.
  if (splitOfParent && !item.parent) fail(SPLIT_NEEDS_PARENT);
  if (splitOfParent) await copyGates(site, item);
  const linked = parent !== undefined || related !== undefined || relate !== undefined || unrelate !== undefined ? await linksOf(site, key) : null;
  let unlink = related === undefined ? null : await setRelated(site, key, item, related);
  const relating = relate === undefined ? [] : await relatedKeys(site, key, relate, '--relate');
  if (relate !== undefined) item.related = [...new Set([...(item.related || []).map((r) => depKey(file, r)), ...relating])];
  const unrelating = unrelate === undefined ? [] : await relatedKeys(site, key, unrelate, '--unrelate');
  if (unrelate !== undefined) unlink = await unrelateCards(site, key, item, unrelating);
  // The cards that get a line from this call: each it links or unlinks, and, as it leaves New, the ones its held
  // Related to lines go to (postHeldLinks).
  const relatedBefore = [...linked?.related || []];
  const relatedAfter = related !== undefined ? (item.related || []).map((r) => depKey(file, r)) : [...relatedBefore.filter((k) => !unrelating.includes(k)), ...relating];
  const writeReply = await replyFirst(site, [
    ...relatedAfter.filter((k) => !relatedBefore.includes(k)), ...relatedBefore.filter((k) => !relatedAfter.includes(k)),
    ...(item.parent && item.parent !== before.parent ? [item.parent] : []),
    ...(item.deps || []).map((d) => depKey(file, d)).filter((k) => !before.deps.includes(k)),
    ...(before.wasNew && phase !== undefined ? (await linksOf(site, key)).related : []),
  ], replyOn);
  if (hold !== undefined) setHold(item, hold);
  if (start && item.held) {
    fail(item.pick_up_at ? `${key} is blocked until ${item.pick_up_at}, when the board unblocks it; start it early only with item set ${key} --unblocked`
      : `${key} is blocked by the owner; start it only once they unblock it, with item set ${key} --unblocked`);
  }
  const handover = pr !== undefined || pushed !== undefined || mergeReady !== undefined;
  // A card that leaves Todo is never still blocked by the owner, nor waiting on a re-check.
  if (start || done || handBack || handover) {
    clearHold(item);
    delete item.recheck_at;
  }
  if (start) {
    const blockers = await unfinishedDeps(site, parseKey(key).file, item);
    if (blockers.length) fail(`${key} is blocked by ${blockers.join(', ')}; start it once ${blockers.length === 1 ? 'that is' : 'those are'} done`);
    if (item.blocked_until) fail(`${key} is blocked until ${item.blocked_until}; start it once that holds and the block is cleared with --blocked-until ""`);
  }
  const unpicked = start && site ? await unpickedPrototype(site, key) : null;
  if (unpicked) fail(`${key} has no take picked: the owner's answer to ${unpicked.id} picks none${unpicked.note ? ` ("${clip(unpicked.note)}")` : ''}, so it prototypes again: draw the next round from that note, or grill when the note asks a question, and build once a take is picked`);
  const resolve = done ? await closeQuestions(site, key, '--done', force) : async () => [];
  const lastLine = done ?closingLine(site, key, merged, said, boardRepoOf(site, itemFile), closing) : null;
  if (merged) markMerged(item, merged, boardRepoOf(site, itemFile));
  if (next !== undefined) {
    setNext(item, next, await hasOpenQuestion(site, key));
    await checkNextDeps(site, key, item, item.next);
  }
  if (clearNext) { delete item.next; delete item.next_at; delete item.next_on_questions; }
  // A build starting acts on whatever a Next set during the card's questions waited on.
  if (start && next === undefined && item.next_on_questions) { delete item.next; delete item.next_at; delete item.next_on_questions; }
  // The In Review lane sorts by this first arrival, which no later PR, push, merge-ready, tap or land rewrites.
  if (handover && !item.review_since) item.review_since = new Date().toISOString();
  if (pr !== undefined) addPRs(item, pr, boardRepoOf(site, itemFile));
  // docs/adr/2026-11-02-1850-a-board-can-work-on-any-git-remote.md
  if (pushed !== undefined) {
    if (!listBoards().find((b) => samePath(b.dir, needSite(site)))?.remote) fail('--pushed is for a board whose repo is a plain git remote; on GitHub, open a PR and pass --pr');
    if (hasPR(item)) fail(`${key} has a PR; its PR says when it merges`);
    try { validateBranch(pushed); } catch { fail('--pushed takes the name of the branch you pushed'); }
    item.pushed = { branch: pushed, at: new Date().toISOString() };
    item.branch = pushed;
  }
  // docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md: a verified branch that waits for the owner's Merge.
  if (mergeReady !== undefined) {
    item.merge_ready = { branch: mergeReady, at: new Date().toISOString() };
    item.branch = mergeReady;
  }
  if (done) { delete item.merge_ready; delete item.waits_on_owner; }
  // docs/adr/2026-11-15-0715-a-merge-mode-done-card-shows-its-commit-as-a-badge.md: the commit a land fast-forwarded the base to.
  if (typeof landed === 'string') item.landed_sha = landed;
  if (ghSince !== undefined) {
    if (typeof ghSince !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(ghSince) || Number.isNaN(Date.parse(ghSince))) fail('--gh-since takes an ISO-8601 UTC time such as 2026-10-23T11:00:00Z');
    item.gh_since = ghSince;
  }
  if (ask) item.from_ask = ask;
  // docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md: ready leaves the owner nothing to decide.
  if (phase === 'ready' && site) {
    const open = (await cardQuestions(site, key)).asked.filter((q) => q.state === 'open').map((q) => q.id);
    if (open.length) fail(`${key} has ${open.length === 1 ? 'an open question' : 'open questions'} ${open.join(', ')}; it is ready once the owner has answered ${open.length === 1 ? 'it' : 'them'}`);
    await checkNotesComplete(site, key, source.dir, item);
    // A title builder start would refuse is caught here, when the orchestrator readies the card, not at the pull.
    const untitled = startTitleFault(key, item.title);
    if (untitled) fail(untitled);
  }
  // docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md: a staging card goes ready on
  // the orchestrator's judgment against the whole board, which --text records in its notes.
  const judged = phase === 'ready' && item.phase === 'staging' && fromAsk === undefined;
  if (judged && said === undefined) fail(`${key} goes ready from staging on your judgment: pass --text "<what you checked it against on the board>", which goes into its notes`);
  // docs/adr/2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md: a ready card whose block ended goes back to
  // the pull on the orchestrator's re-check, which --text records in its notes.
  const rechecked = phase === 'ready' && item.phase === 'ready' && Boolean(item.recheck_at) && fromAsk === undefined;
  if (rechecked && said === undefined) fail(`${key}'s block ended, so it builds once you re-check its notes against what landed: pass --text "<what you re-checked>", which goes into its notes`);
  if (phase === 'ready' && !judged && !rechecked && said !== undefined && fromAsk === undefined && !done) fail(`${key} reads ${item.phase || 'no phase'}, not staging, so there is no judgment for --text to record`);
  const readied = phase === 'ready' && item.phase !== 'ready';
  // The orchestrator's check is the readied line's words; --from-ask's --text is a message of its own.
  const readiedLine = judged ? readiedText(said) : undefined;
  let left = false;
  if (phase !== undefined) {
    // docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md: sent from discussing, staging or
    // ready to a grill or prototype, or sorted into one from New, the card owes the orchestrator's brief for its round,
    // which the board launches the planner from.
    if (PLANNED.includes(phase) && !PLANNED.includes(item.phase)) owe(item, phase === 'grilling' ? 'grill' : 'prototype');
    left = leaveNew(item);
    item.phase = phase;
    if (phase === 'discussing') dropOwed(item);
    delete item.recheck_at;
    delete item.staged_at;
    delete item.unfiled;
    delete item.filed_held;
    delete item.ready_main;
    if (phase === 'ready') item.ready_at = new Date().toISOString(); else delete item.ready_at;
    if (triaged) item.triaged = { at: new Date().toISOString(), phase };
  }
  // docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md: a Next never asks for the phase the card is in.
  if (item.phase === 'ready' && ASKS_READY.test(item.next ?? '')) fail(`${key} would read ready with Next "${item.next}", which asks for the phase it is already in; pass --next with what happens next, or --clear-next`);
  if (built) item.install = built;
  if (built === null) delete item.install;
  // docs/adr/2026-11-03-0237-an-in-progress-card-always-has-a-builder-line-or-a-next.md: a build's start goes with its record.
  if (!owedBefore && !start && owesNext(item, records)) fail(`that leaves ${key} In Progress with nothing building and no Next; pass --next "<what happens next>"`);
  // docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md: a block on a card In
  // Progress keeps it there, and asks its running build, the board's or a session's, to pause at its next stopping
  // point (requestPause); one already landing lands, since land refuses a blocked card.
  const blocked = (deps !== undefined || blockedUntil) && !done && inProgress(item, records) ? await blockWords(site, key, item) : '';
  // The moves this write makes (docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md): a close
  // and a block write their own lines, the rest a move line.
  const repo = boardRepoOf(site, itemFile);
  let moveLine = null;
  const moveTo = (to, why) => { if (item.lane !== to && placeIn(item, to, undefined, movedPhase(item, to, landed)) !== undefined && why) moveLine = `Moved to ${LANES[to]}: ${why}`; };
  if (done) moveTo('done', null);
  else if (handover && item.lane !== 'done') {
    moveTo('review', pr !== undefined ? `PR ${prNames([].concat(pr).map(parsePRRef), repo)} opened` : pushed !== undefined ? `${pushed} pushed for its merge` : 'verified, it waits for your Merge');
  } else if (start && !closed(item)) {
    // docs/adr/2026-11-15-1500-a-pull-and-its-build-start-are-one-status-line.md: a build the pull just started already
    // has its line, the pull's own "Moved to In Progress: slot available".
    const pulled = (await readLog(threadFile(site, key))).at(-1)?.line === 'pulled';
    moveTo('progress', pulled ? null : 'a build started');
  }
  // docs/adr/2026-11-10-1600-tickets-are-made-at-ready.md: a card going ready with no ticket gets one, on a board with a source.
  const madeAtReady = phase === 'ready' && !item.ticket && ticket === undefined && !newTicket && Boolean(site && await boardSource(site));
  if (madeAtReady) newTicket = true;
  if (newTicket && item.ticket) fail(`${key} already has ticket ${item.ticket}`);
  const linking = ticket !== undefined || newTicket;
  if (linking) await assignTicket(site, itemFile, item, ticket, options, source.dir);
  await writeJSON(source.file, itemFile);
  await writeReply();
  if (madeAtReady) await appendStatus(site, key, 'ticket-made', { ticket: item.ticket });
  if (moveLine) await appendLine(threadFile(site, key), { ts: item.lane_at, who: 'claude', kind: MOVE, text: moveLine });
  if (judged) await appendNotes(site, key, `Ready (orchestrator, ${noteStamp()})`, said);
  if (rechecked) await appendNotes(site, key, `Re-checked (orchestrator, ${noteStamp()})`, said);
  if (readied) await appendCommand(site, key, { command: 'readied', ...(readiedLine === undefined ? {} : { text: readiedLine }) });
  if (blocked) {
    const pausing = site && !(await isLanding(site, key)) && await requestPause(site, key, { cause: 'blocked', words: `blocked ${blocked}` });
    await appendStatus(site, key, pausing ? 'blocked-pausing' : 'blocked-stays', { blocked });
  }
  if (unlink) await unlink();
  if (linked) await postLinkLines(site, key, linked, await linksOf(site, key));
  if (left) await postHeldLinks(site, key);
  const resolved = await resolve();
  // docs/adr/2026-11-01-1813-an-answered-question-stops-waiting-once-claude-acts-on-its-card.md
  // Ready checked that the notes name every answered question, so it resolves them as item notes does.
  if (phase === 'ready' && site) resolved.push(...await resolveAnswered(site, key, "Recorded in the task's notes"));
  if (start) resolved.push(...await resolveAnswered(site, key, 'Acted on: build started'));
  if (ask) resolved.push(...(await appendMessage(site, key, { text: said })).lines);
  if (lastLine && site) {
    const written = command ? await appendCommand(site, key, { command, text: lastLine.text, who, by })
      : lastLine.status ? await appendStatus(site, key, ...lastLine.status) : await appendMessage(site, key, { text: lastLine.text });
    resolved.push(...written.lines);
  }
  if (title !== undefined && site && item.lane === 'todo') await clearRefusal(site, key);
  // The ticket stays open while the card waits on its owner step.
  const target = item.owner_step && done ? null : ticketTarget({ start, done, handover });
  const moved = target && await moveTicket(await boardSource(site), item, target, { ...options, repo });
  if (moved) resolved.push(moved);
  // A builder that forgot builder done would keep the card In Progress after it was handed back; a hand-back's records
  // close marked handed_back, and a handover or a close ends the hand-back.
  if (handover || done || handBack) {
    await closeBuilders(source.dir, item.id, done, handBack ? { handedBack: new Date().toISOString() } : { endHandBack: true });
    await publishStaged(site, key);
  }
  // An ask is in one card's thread: becoming this item moves it out of a card it was folded into.
  const links = ask ? await readAskLinks(site) : {};
  if (routeRecord(links, ask) !== undefined) { delete links[ask]; await writeJSON(askLinksFile(site), { links }); }
  if (lifted && !closed(item) && !(await unfinishedDeps(site, parseKey(key).file, item)).length) {
    const { line } = await appendStatus(site, key, 'unblocked', { lifted });
    await markUnblocked(site, key, line.ts);
    await appendEvent({ dir: site }, 'card-unblocked', { key });
    resolved.unshift(`unblocked: ${key}`);
  }
  if (!done || wasFinished) return { file: source.file, lines: resolved };
  if (split) await moveWaiters(site, key, split);
  const unblocked = await unblockedBy(site, key);
  // The owner reads a card's wait in its thread, so the line that ends it goes there too.
  const card = await cardName(site, key);
  for (const k of unblocked) {
    const { line } = await appendStatus(site, k, 'unblocked-done', { card });
    await markUnblocked(site, k, line.ts);
    if (landedFiles && await releaseRecheck(site, k, landedFiles)) await appendStatus(site, k, 'recheck-released', { card });
    else await appendEvent({ dir: site }, 'card-unblocked', { key: k });
  }
  return { file: source.file, lines: [...unblocked.map((k) => `unblocked: ${k}`), ...resolved] };
}

// --size and --model, which builder pick reads while the hub's Claude model is Auto: a small card gets Sonnet, and a
// card's own model wins over its size; "" clears either
// (docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md).
function setBuildChoice(item, { size, model }) {
  for (const [field, value, choices] of [['size', size, ['small', 'large']], ['model', model, ['opus', 'sonnet']]]) {
    if (value === undefined) continue;
    if (value === '') delete item[field];
    else item[field] = choices.includes(value) ? value : fail(`--${field} takes ${choices.join(' or ')}, or "" to clear it`);
  }
}

// docs/adr/2026-10-29-1639-a-card-can-be-held-and-every-card-button-confirms.md, docs/adr/2026-11-02-1727-a-card-can-be-held-until-a-time.md
// docs/adr/2026-11-15-2230-the-owners-hold-is-a-block.md
// The owner's block --blocked, --unblocked and --pick-up-at ask for, stored as the item's held and pick_up_at: {until}
// blocks the card, until null meaning until the owner unblocks it, null unblocks it, and undefined leaves it.
// --pick-up-at "" clears the time, which unblocks the card.
function holdOf({ block, unblock, pickUpAt }) {
  if ([block, unblock, pickUpAt !== undefined].filter(Boolean).length > 1) fail('pass one of --blocked, --unblocked and --pick-up-at');
  if (pickUpAt !== undefined) return pickUpAt === '' ? null : { until: pickUpTime(pickUpAt) };
  return block ? { until: null } : unblock ? null : undefined;
}
// A past time is refused, so a typo can't start a card at once.
function pickUpTime(value) {
  const ms = typeof value === 'string' && AT_RE.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) fail('--pick-up-at takes an ISO time such as 2026-11-04T09:00, the host’s local time unless it names an offset, or "" to unblock the task');
  if (ms <= Date.now()) fail(`--pick-up-at ${value} has passed; pass a later time, or --unblocked to unblock the task now`);
  return new Date(ms).toISOString();
}
// A card that has left Todo is never still blocked by the owner, so a build's start, a hand-back, --done, --pr,
// --pushed and --merge-ready drop their block and its pick-up time.
function clearHold(item) {
  delete item.held;
  delete item.pick_up_at;
}
function setHold(item, hold) {
  if (hold) item.held = true; else delete item.held;
  if (hold?.until) item.pick_up_at = hold.until; else delete item.pick_up_at;
  item.held_at = new Date().toISOString();
}

// A card the owner blocked whose pick-up time `until` has passed, as board/server.mjs checkPickUps finds it: unblocked in its item file
// file. announce first adds a thread line and, unless a dep is unfinished or a condition blocks it, card-unblocked {key, until}, as a finished
// dep does; it is false when those were sent before a restart cut the write short.
export async function pickUp(site, key, until, { announce = true } = {}) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (announce) {
    const at = new Date(until).toLocaleString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    await appendStatus(site, key, 'hold-ended', { at });
    if (!item.blocked_until && !(await unfinishedDeps(site, parseKey(key).file, item)).length) await appendEvent({ dir: site }, 'card-unblocked', { key, until });
  }
  setHold(item, null);
  await writeJSON(source.file, itemFile);
}

// The owner's Block, Unblock, Done or Reopen tap (card-hold {key, hold, until?}, card-done {key} or card-reopen {key}), or
// a Full person's, whose data.shared_by {login, name} names their thread line, recorded in the item file as the board
// server takes it, with a thread line; a Done closes the card and unblocks blocked cards as item set --done does
// (docs/adr/2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md). → the item set result, or null
// when there is nothing to write.
export async function recordOwnerTap(site, kind, data) {
  const key = String(data?.key || '');
  const { file: slug, id } = parseKey(key);
  const { source, itemFile } = await loadItemFile(site, slug);
  // The owner's line, so it answers none of their messages that wait on Claude.
  const by = data.shared_by ? data.shared_by.name || data.shared_by.login : undefined;
  // docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md: each tap's line is its status line.
  const said = { text: COMMANDS.done, who: 'love', by, command: 'done' };
  const item = itemFile.items.find((it) => it.id === id) || fail(`item file "${slug}" has no item "${id}"`);
  // docs/adr/2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md: a Done card's Reopen moves it
  // back to Todo, discussing, its conversation open again; a card not in Done has nothing to reopen.
  if (kind === 'card-reopen') {
    if (item.lane !== 'done') return null;
    await appendCommand(site, key, { who: 'love', by, command: 'reopened' });
    return moveCard(site, key, 'todo', 'you reopened it', 'discussing');
  }
  // A Done card waiting on its owner step closes on the owner's Done; any other card in Done has nothing to write.
  const stepOpen = kind === 'card-done' && Boolean(item.owner_step);
  if (!stepOpen && item.lane === 'done') return null;
  if (kind === 'card-done') return setItem(site, key, { done: true, force: true, ownerDone: true, ...said });
  const until = data.hold ? (typeof data.until === 'string' ? new Date(data.until).toISOString() : null) : undefined;
  setHold(item, data.hold ? { until } : null);
  await writeJSON(source.file, itemFile);
  // A block pauses the card's running build at its next stopping point, and stops its other agents, a landing build's
  // included, so their records close: an open record with an exited process is relaunched
  // (docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md). Its pause keeps the cause
  // held, the key builder records already carry (domain.mjs PAUSE_CLEARS).
  if (data.hold) {
    if (!(await isLanding(site, key))) await requestPause(site, key, { cause: 'held', words: 'blocked' });
    await closeBuilders(source.dir, id, false, { held: true });
    await publishStaged(site, key);
  }
  const at = until && new Date(until).toLocaleString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return appendCommand(site, key, data.hold ? { text: at ? `${COMMANDS.hold} until ${at}` : COMMANDS.hold, who: 'love', by, command: 'hold' }
    : { who: 'love', by, command: 'resume' });
}

// --check's text → its stored form, or refuses it (shared/owner-check.mjs parseCheck).
function checkSpec(value) {
  try { return checkText(parseCheck(value)); } catch (e) { return fail(e.message); }
}

// docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md: the hub's poll found the owner step's check
// passing, so the card closes as the owner's Done closes it, its line naming what the check found. check is the check
// the poll ran; a card whose step or check changed since is left alone. → the item set result, or null.
export async function passOwnerCheck(site, key, check, found) {
  const { item } = await loadItem(site, key);
  if (!item.owner_step || item.owner_check?.check !== check) return null;
  return setItem(site, key, { done: true, force: true, ownerDone: true, closing: ['check-passed', { found }] });
}

// The hub's poll couldn't run the owner step's check several times in a row: the card reads it broken, the poll stops
// running it, a thread line says so and owner-check-broken {key, check, error} wakes the session to fix it with item set
// --check. The owner's Done still closes the card. → true when it marked the check, false when the card moved on.
export async function breakOwnerCheck(site, key, check, error) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (!item.owner_step || item.owner_check?.check !== check) return false;
  item.owner_check.broken = error;
  await writeJSON(source.file, itemFile);
  await appendStatus(site, key, 'check-broken', { error });
  await appendEvent({ dir: site }, 'owner-check-broken', { key, check, error });
  return true;
}

// A comma list of deps, each an item that exists; "" is none.
async function depList(site, slug, deps) {
  const list = [...new Set(String(deps).split(',').map((d) => d.trim()).filter(Boolean))];
  for (const d of list) await loadItem(site, depKey(slug, d));
  return list;
}

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
// --parent for card key of item file slug (key null for a new card): the key of a card that exists, neither key itself nor
// one of its descendants (the walk up its ancestors stops at one that no longer exists); "" is none.
async function parentKey(site, slug, key, parent) {
  if (!String(parent).trim()) return null;
  const to = depKey(slug, String(parent).trim());
  if (to === key) fail("--parent: a task can't be its own Parent");
  for (let at = to; at;) {
    // Only the new Parent must exist; an ancestor that is gone can't be a descendant of key, so the walk ends there.
    const loaded = at === to ? await loadItem(site, at) : await loadItem(site, at).catch((e) => { if (e instanceof BoardError) return null; throw e; });
    if (!loaded) break;
    const { item } = loaded;
    if (item.parent && depKey(parseKey(at).file, item.parent) === key) fail(`--parent: ${to} is a child of ${key}, so it can't be its Parent`);
    at = item.parent ? depKey(parseKey(at).file, item.parent) : null;
  }
  return to;
}

// A --related, --relate or --unrelate list for card key (<file>/<id>, or <file> for a card not made yet): a comma list
// of cards that exist, as keys, without repeats.
async function relatedKeys(site, key, value, flag) {
  const slug = key.split('/')[0];
  const list = [...new Set(String(value).split(',').map((r) => r.trim()).filter(Boolean).map((r) => depKey(slug, r)))];
  if (list.includes(key)) fail(`${flag}: a task can't be related to itself`);
  for (const r of list) await loadItem(site, r);
  return list;
}

// docs/adr/2026-11-16-1700-a-filed-task-links-where-it-came-from-and-the-tasks-it-names.md
const UNSOURCED = 'a task you file names where it came from';
const SPLIT_NEEDS_PARENT = "--split copies the Parent's gates, so it goes with --parent <the task split>";
// docs/adr/2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md: a split child keeps the answers its parent's grill got.
async function copyGates(site, item) {
  const { gates } = (await loadItem(site, item.parent)).item;
  if (gates) item.gates = { ...gates };
}
// The cards words name, [{key, name}] in board order: by T-<n>, GH-<n> or another id of that shape, #<ticket>, or
// <file>/<id>, matching a card's id, ref, ticket or key. A name inside double quotes is someone's quoted words, the
// owner's mostly, and names nothing.
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;
const TASK_NAME = /(?<![\w/#.-])(?:[\w.-]+\/[\w.-]+|[A-Z][A-Z0-9]*-\d+|#\d+)/g;
async function namedTasks(site, words) {
  const said = new Set((String(words).replace(QUOTED, ' ').match(TASK_NAME) || []).map((n) => n.replace(/\.+$/, '')));
  if (!said.size) return [];
  const { tickets } = settingsOf(await boardConfig(site));
  const named = [];
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    for (const it of itemFile?.items || []) {
      const key = `${source.slug}/${it.id}`;
      const name = [key, it.id, refOf(itemFile, it, tickets), it.ticket].find((n) => n && said.has(n));
      if (name) named.push({ key, name });
    }
  }
  return named;
}
const listed = (all) => (all.length < 2 ? all.join('') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`);
// docs/adr/2026-11-16-0946-a-link-onto-a-card-awaiting-a-reply-needs-that-reply-first.md
// The orchestrator's words name only tasks that exist: a T-<n> at or past the board's next number (nextTaskId), bare or
// keyed by one of its item files, is a guess at a key item add has yet to print. Quoted words are someone else's.
const TASK_NUMBER = /(?<![\w#.-])(?:([\w.-]+)\/)?T-([1-9]\d*)(?![\w-])/g;
export async function refuseUnborn(site, words) {
  if (!site || words === undefined) return;
  const next = Number((await nextTaskId(site)).slice(2));
  const slugs = new Set((await itemSources(site)).map((s) => s.slug));
  for (const [, slug, n] of String(words).replace(QUOTED, ' ').matchAll(TASK_NUMBER)) {
    if ((slug === undefined || slugs.has(slug)) && Number(n) >= next) fail(`T-${n} doesn't exist yet: file it first and name the key item add printed`);
  }
}
// Whether the owner's word on card key waits on the orchestrator's reply: the board server lists a reply wait for it
// (data/orchestrator-waits.json, domain.mjs orchestratorWaitsOf), and no message of the orchestrator's on the card, nor
// its reply to one of the owner's messages there, came since, which that list takes a moment to catch up with.
async function awaitsReply(site, key) {
  const wait = ((await readJSON(path.join(site, 'data', 'orchestrator-waits.json'), {})).waits || []).find((w) => w.key === key && w.kind === 'reply');
  if (!wait) return false;
  const since = String(wait.since);
  if ((await readLog(threadFile(site, key))).some((m) => (m.who || 'claude') === 'claude' && !m.kind && !m.command && String(m.ts) > since)) return false;
  const said = (await readLog(path.join(site, 'data', 'events.jsonl'))).filter((e) => e.kind === 'item-message' && e.data?.key === key && String(e.ts) >= since);
  for (const e of said) if ((await replyFilesOf(path.join(site, 'data', 'replies'), e.id)).length) return false;
  return true;
}
// A link a command makes or drops posts a line on each card it names (keys), so a link onto a card whose owner waits
// on the orchestrator's reply needs that reply (replyOn, --reply-on), which the board writes on that card before the
// link's line. → the reply's write, run before the link lines; refuses before anything is written.
async function replyFirst(site, keys, replyOn) {
  const waiting = [];
  for (const key of site ? new Set(keys) : []) if (await awaitsReply(site, key)) waiting.push(key);
  if (replyOn === undefined) {
    if (waiting.length) fail(`${listed(waiting)} ${waiting.length === 1 ? 'waits' : 'wait'} on your reply to the owner: pass --reply-on "<your reply>", which the board writes there before the link's line`);
    return async () => {};
  }
  if (!waiting.length) fail('--reply-on writes your reply on a linked card the owner waits on, and none of the cards linked does');
  if (waiting.length > 1) fail(`${listed(waiting)} each wait on your reply to the owner, and --reply-on is one reply: answer each with reply <task> --text first`);
  messageText(replyOn);
  await refuseUnborn(site, replyOn);
  return async () => { await appendMessage(site, waiting[0], { text: replyOn }); };
}
// A New card holds back the Related to line on each card it is related to (postAskLinks), as the owner can't open it
// yet; once it leaves New, each of those cards without a standing Related to line for it gets one.
async function postHeldLinks(site, key) {
  for (const other of (await linksOf(site, key)).related) {
    const last = (await readLog(threadFile(site, other))).filter((m) => ['related', 'unrelated'].includes(m.command) && m.card === key).at(-1);
    if (last?.command !== 'related') await appendCommand(site, other, { command: 'related', card: key });
  }
}
// A new task's words (what) must link each task they name, by any link in links (keys): → refuses naming the rest.
async function refuseUnlinked(site, what, words, links) {
  const unlinked = (await namedTasks(site, words)).filter((n) => !links.includes(n.key));
  if (!unlinked.length) return;
  const one = unlinked.length === 1;
  fail(`${what} names ${listed(unlinked.map((n) => `${n.name} (${n.key})`))} without linking ${one ? 'it' : 'them'}: add --relate ${unlinked.map((n) => n.key).join(',')}, or link ${one ? 'it' : 'each'} as --parent, --blocked-by or --blocks`);
}
// The latest text of ask eventId: its last edit's, else its own.
async function askWordsOf(site, eventId) {
  const events = await readLog(path.join(site, 'data', 'events.jsonl'));
  const edit = events.filter((e) => e.kind === 'ask-edited' && e.data?.id === eventId && typeof e.data?.text === 'string')
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1);
  return edit ? edit.data.text : events.find((e) => e.id === eventId && e.kind === 'ask')?.data?.text || '';
}
// The issue numbers of the board's repo that words name, as #N, GH-N or the issue's URL; quoted words name none. A PR
// is never an issue: a /pull/<n> URL isn't one, nor is a #N or GH-N the hub's GitHub state knows as a PR of the repo.
async function issuesNamed(words, repo) {
  const bare = String(words).replace(QUOTED, ' ');
  const prs = Object.keys((await readJSON(githubStateFile(), {})).prs || {}).map((k) => /^(.+)#(\d+)$/.exec(k)).filter((m) => m && m[1].toLowerCase() === String(repo).toLowerCase()).map((m) => Number(m[2]));
  const found = [...bare.matchAll(/(?<![\w/#.-])(?:#|GH-)([1-9]\d*)(?![\w-])/g)].map((m) => Number(m[1])).filter((n) => !prs.includes(n));
  for (const m of bare.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)(?!\d)/g)) if (m[1].toLowerCase() === String(repo).toLowerCase()) found.push(Number(m[2]));
  return [...new Set(found)];
}
// docs/adr/2026-11-16-2000-an-ask-places-every-issue-it-names.md
// On a GitHub board, an ask's words (what) must place each issue of the board's repo they name: as the card's ticket, or
// through a link (links, keys) to a task holding it. Whether it is the ask's topic, a parent, a blocker or only related
// stays the orchestrator's call; the refusal names the options. canTicket: the command can give the card a --ticket.
async function refuseUnplaced(site, what, words, { links, ticket, repo, canTicket }) {
  if ((await boardSource(site))?.source !== 'github') return;
  const held = new Set();
  for (const key of links) held.add((await loadItem(site, key)).item.ticket);
  const own = /^(?:#|GH-)?([1-9]\d*)$/.exec(String(ticket ?? ''));
  if (own) held.add(`#${own[1]}`);
  const unplaced = (await issuesNamed(words, repo)).filter((n) => !held.has(`#${n}`));
  if (!unplaced.length) return;
  const one = unplaced.length === 1;
  const topic = canTicket ? `if ${one ? 'it is' : 'one is'} the ask's direct topic, add --ticket ${one ? unplaced[0] : '<issue>'} so the owner's Done closes it; otherwise ` : '';
  fail(`${what} names issue ${listed(unplaced.map((n) => `#${n}`))} without placing ${one ? 'it' : 'them'}: ${topic}link the task that holds ${one ? 'it' : 'each'} as --relate, --parent or --blocked-by (an issue no task holds yet: item add <file>/GH-<n> imports it first)`);
}
// The cards card key is linked with, whichever card stores the link: its Parent and children, its Related to, and the
// tasks it waits on or blocks.
async function linkedWith(site, key) {
  const linked = new Set();
  for (const entry of await itemSources(site)) {
    for (const it of (await readJSON(entry.file, null))?.items || []) {
      const own = `${entry.slug}/${it.id}`;
      const out = [it.parent, ...it.related || [], ...it.deps || []].filter(Boolean).map((r) => depKey(entry.slug, r));
      if (own === key) out.forEach((k) => linked.add(k));
      else if (out.includes(key)) linked.add(own);
    }
  }
  return linked;
}

// A link shows on both cards whichever stores it, so taking one off means taking it off the other card too: → the
// write that drops key from the Related to of each other card that drop(<its key>) picks, run once key's own item file
// file is written.
const dropLinksTo = (site, key, drop) => async () => {
  for (const entry of await itemSources(site)) {
    const itemFile = await readJSON(entry.file, null);
    let changed = false;
    for (const it of Array.isArray(itemFile?.items) ? itemFile.items : []) {
      const own = `${entry.slug}/${it.id}`;
      if (own === key || !drop(own) || !(it.related || []).some((r) => depKey(entry.slug, r) === key)) continue;
      it.related = it.related.filter((r) => depKey(entry.slug, r) !== key);
      if (!it.related.length) delete it.related;
      changed = true;
    }
    if (changed) await writeJSON(entry.file, itemFile);
  }
};

// docs/adr/2026-11-06-1130-linking-two-cards-posts-a-keyed-line-in-both-threads.md
// The links card key has, whichever card stores them: the cards it is Related to and its Parent (keys).
async function linksOf(site, key) {
  const related = new Set();
  let parent = null;
  for (const entry of await itemSources(site)) {
    for (const it of (await readJSON(entry.file, null))?.items || []) {
      const own = `${entry.slug}/${it.id}`;
      const stored = (it.related || []).map((r) => depKey(entry.slug, r));
      if (own === key) { stored.forEach((r) => related.add(r)); if (it.parent) parent = depKey(entry.slug, it.parent); }
      else if (stored.includes(key)) related.add(own);
    }
  }
  return { related, parent };
}

// A keyed line in each thread (domain.mjs COMMANDS) for every link key gained or lost between before and after
// (linksOf): Related to or Unrelated from, and Follow-up in the Parent's thread with Follow-up of in the child's. A card
// filed with its Parent (item add --parent) reads Created ticket in its Parent's thread and Created from in its own.
// held: key is a New card, whose Related to line in the other card's thread waits until it leaves New (postHeldLinks).
async function postLinkLines(site, key, before, after, { spunOut = false, held = false } = {}) {
  const both = async (command, other, mine = command, theirs = command) => {
    await appendCommand(site, key, { command: mine, card: other });
    await appendCommand(site, other, { command: theirs, card: key });
  };
  for (const other of after.related) if (!before.related.has(other)) await (held ? appendCommand(site, key, { command: 'related', card: other }) : both('related', other));
  for (const other of before.related) if (!after.related.has(other)) await both('unrelated', other);
  if (after.parent && after.parent !== before.parent) await (spunOut ? both('created-from', after.parent, 'created-from', 'created') : both('followup-of', after.parent, 'followup-of', 'followup'));
}

// --related for card key: the list replaces the cards it is related to; "" is none. Each card the list leaves out
// loses its own link to key too.
async function setRelated(site, key, item, related) {
  const list = await relatedKeys(site, key, related, '--related');
  if (list.length) item.related = list; else delete item.related;
  return dropLinksTo(site, key, (own) => !list.includes(own));
}

// --unrelate for card key: the listed cards come off its Related to, and key off theirs; the rest stay.
function unrelateCards(site, key, item, list) {
  const kept = (item.related || []).filter((r) => !list.includes(depKey(parseKey(key).file, r)));
  if (kept.length) item.related = kept; else delete item.related;
  return dropLinksTo(site, key, (own) => list.includes(own));
}

export const boardRepoOf = (site, itemFile) => (site && listBoards().find((b) => samePath(b.dir, site))?.github) || itemFile.repo;

// → one report per PR on the card, in its order, each naming its repo.
export async function prReport(site, key) {
  const { itemFile, item } = await loadItem(site, key);
  if (!hasPR(item)) fail(`${key} has no PR`);
  const prs = cardPRs(item, boardRepoOf(site, itemFile));
  if (!prs.length) fail(`${key} has no repo`);
  const since = item.gh_since || '1970-01-01T00:00:00Z';
  try {
    const me = settingsOf(await boardConfig(site)).github_login || await githubLogin();
    return await Promise.all(prs.map(async ({ repo, number }) => ({ repo, ...reportOf(await fetchPR({ repo, pr: number, since }), { pr: number, since, me }) })));
  } catch (e) { fail(e.message); }
}

// `pr comment` and `pr reply`: Claude's words on a PR, a number in the board's repo or owner/repo#n in another, posted
// as the board's github-login with the prefix and marker added (hub/pr-report.mjs postToPR), so the next `pr` leaves
// them out. → {lines}
export async function postPR(site, pr, { replyTo, body }) {
  const command = replyTo === undefined ? 'pr comment' : 'pr reply';
  const ref = parsePRRef(pr) || fail(`${command} takes a PR number or owner/repo#<n>`);
  if (replyTo !== undefined && !/^[1-9]\d*$/.test(replyTo)) fail('pr reply takes the id of the review comment it answers');
  const words = text(body, '--body').trim();
  if (words.startsWith(CLAUDE_PREFIX.trim()) || words.includes(CLAUDE_MARK)) fail(`${command} adds the ${CLAUDE_PREFIX.trim()} prefix and the claude-bridge marker itself; pass only your words`);
  const repo = ref.repo || boardRepoOf(needSite(site), {}) || fail(`${command} needs a board on GitHub; this board has no repo there`);
  try {
    const url = await postToPR({ repo, pr: ref.number, replyTo, words, login: settingsOf(await boardConfig(site)).github_login });
    return { lines: [`posted on PR ${ref.repo ? pr : `#${pr}`}: ${url}`] };
  } catch (e) { fail(e.message); }
}

const boardSource = async (site) => storedTickets((await boardConfig(site)).tickets);

// docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md
// `board.mjs merge`: merges the card's PRs with gh --squash, in the card's order, once GitHub reads every open one
// approved, green and CLEAN (domain.mjs mergeBlockers, the test the Merge button uses), then records the card merged
// (docs/adr/2026-11-03-1904-a-card-holds-several-prs-across-repos.md). A PR already merged or closed is left as it is. It refuses
// commits after the newest approval unless afterApproval says why they're trivial, and a card with manual steps unless
// confirmed quotes the owner. A refusal names every reason, each after its PR's name on a card with several, and also
// goes in the card's thread when tapped, the owner's Merge tap (server.mjs).
export async function mergeCard(site, key, { afterApproval, confirmed, tapped } = {}) {
  needSite(site);
  const { itemFile, item } = await loadItem(site, key);
  if (!hasPR(item)) fail(`${key} has no PR`);
  if (closed(item)) fail(`${key} is done`);
  // docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md: auto-merge's refusal too.
  const blocked = await blockWords(site, key, item);
  if (blocked) {
    if (tapped) await appendStatus(site, key, 'merge-blocked', { blocked });
    fail(`Not merged: blocked ${blocked}.`);
  }
  const repo = boardRepoOf(site, itemFile);
  const prs = cardPRs(item, repo);
  if (!prs.length) fail(`${key} has no repo`);
  const now = new Date().toISOString();
  // docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md: GitHub's limit refusing a read or the merge
  // goes in the card's thread with its reset.
  const limited = (until) => appendStatus(site, key, 'gh-limited', { what: 'Not merged', words: limitWords(until) });
  let fetched;
  try { fetched = await Promise.all(prs.map((p) => fetchPR({ repo: p.repo, pr: p.number, comments: false }))); } catch (e) {
    if (e.limited) await limited(e.limited);
    fail(e.message);
  }
  const states = fetched.map(({ view }) => view);
  if (allLanded(states)) {
    const merged = prs.map((p, i) => ({ ...p, at: states[i].mergedAt })).filter((_, i) => states[i].state === 'MERGED');
    return setItem(site, key, { merged, closing: ['already-merged', { prs: prNames(merged, repo), many: merged.length > 1 }] });
  }
  const open = prs.map((p, i) => ({ ...p, ...fetched[i] })).filter(({ view }) => view.state === 'OPEN');
  // docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md: a card no reviewer is on merges with no approval.
  const needsApproval = reviewersOf(itemFile, (await boardConfig(site)).reviewers || []).length > 0;
  const reasons = [];
  let after = false;
  // docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md: the board's rebase-only pushes
  // after the approval are trivial, and the merge says so.
  let rebasedOnly = false;
  for (const p of open) {
    const { view, reviews } = p;
    const { failing, pending } = reportOf(p, { pr: p.number, since: now, me: null });
    const own = mergeBlockers({ ...view, checks: { state: failing.length ? 'fail' : pending ? 'pending' : 'pass', failing, pending } }, { needsApproval });
    const approved = reviews.filter((r) => r.state === 'APPROVED').sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at))).at(-1)?.commit_id;
    let later = Boolean(approved && view.headRefOid && approved !== view.headRefOid);
    if (later && afterApproval === undefined && onlyRebased(item, approved, view.headRefOid)) { later = false; rebasedOnly = true; }
    after ||= later;
    if (later && afterApproval === undefined) own.push('commits after the approval: pass --after-approval "<why they are trivial>" when they are, else ask the approver to look again');
    reasons.push(...(prs.length > 1 ? own.map((r) => `${prNames([p], repo)} ${r}`) : own));
  }
  if (!open.length) reasons.push(prs.length > 1 ? 'every PR is closed' : 'PR is closed');
  if (afterApproval !== undefined && !after) fail('--after-approval: no commit came after the approval; drop it');
  const steps = item.manual_steps?.length ? (confirmed === undefined ? null : await ownerQuote(site, confirmed, '--confirmed')) : undefined;
  if (confirmed !== undefined && steps === undefined) fail(`--confirmed: ${key} has no manual steps; drop it`);
  if (steps === null) reasons.push('manual steps: merge only on the owner\'s word, with --confirmed "<their words>"');
  if (reasons.length) {
    const why = `Not merged: ${reasons.join('; ')}.`;
    if (tapped) await appendStatus(site, key, 'merge-refused', { why: reasons.join('; ') });
    fail(why);
  }
  // docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md: the squash commit is the
  // PR's title, with no " (#N)", over its body and the card's trailers. docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md:
  // every PR's title is a Conventional subject before any merges.
  const sources = [];
  for (const p of open) {
    const viewed = await gh(['pr', 'view', String(p.number), '--repo', p.repo, '--json', 'title,body,commits']);
    if (viewed.limited) await limited(viewed.limited);
    if (viewed.status !== 0) fail(`gh pr view ${prNames([p], repo)} failed: ${viewed.stderr.trim().split('\n')[0] || `gh exited ${viewed.status}`}`);
    const source = JSON.parse(viewed.stdout);
    const fault = subjectFault(source.title);
    if (fault) fail(`PR ${prNames([p], repo)}'s title "${source.title}" ${fault}; retitle it with gh pr edit ${p.number} --repo ${p.repo} --title "<type>(<scope>): <summary>" and merge again`);
    sources.push(source);
  }
  const done = [];
  for (const [n, p] of open.entries()) {
    const { title, body, commits } = sources[n];
    const message = ['--subject', title, '--body', squashBody(await cardName(site, key), body, commits)];
    const merged = await gh(['pr', 'merge', String(p.number), '--repo', p.repo, '--squash', ...message], { timeout: 120_000 });
    if (merged.limited) await limited(merged.limited);
    if (merged.status !== 0) fail(`gh pr merge ${prNames([p], repo)} failed: ${merged.stderr.trim().split('\n')[0] || `gh exited ${merged.status}`}${done.length ? ` (merged ${prNames(done, repo)} before it)` : ''}`);
    done.push(p);
  }
  // The merge is the board's status line, and the orchestrator's words on it, when it gave any, its message after.
  const said = [afterApproval !== undefined && `After the approval: ${text(afterApproval, '--after-approval')}`,
    rebasedOnly && `After the approval: only the board's rebase onto ${item.rebased.at(-1).base}.`, steps && `The owner's word on the manual steps: "${steps}"`].filter(Boolean);
  const set = await setItem(site, key, { merged: done });
  if (said.length) await appendMessage(site, key, { text: said.join(' ') });
  return set;
}

// docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md
// The card's verified branch waiting for the owner's Merge ({branch, at, tapped?}), or null.
export async function heldMerge(site, key) {
  return (await loadItem(site, key)).item.merge_ready || null;
}
// The owner's Merge on a held card. tapped, the tap's time, is the go that the land it starts, and a lander after it,
// finish on. → the held merge
export async function tapMerge(site, key) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (!item.merge_ready || closed(item)) fail(`${key} isn't waiting for its Merge`);
  const blocked = await blockWords(site, key, item);
  if (blocked) fail(`${key} is blocked ${blocked}, so its Merge waits until nothing blocks it`);
  item.merge_ready.tapped = new Date().toISOString();
  await writeJSON(source.file, itemFile);
  return item.merge_ready;
}
// The Claude model of the card's newest builder record that kept a worktree, for its lander.
export async function builderModel(site, key) {
  const { source, item } = await loadItem(site, key);
  const records = (await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)))).filter((r) => r?.worktree?.path && r.kind !== HELPER);
  return records.sort((a, b) => String(b.started).localeCompare(String(a.started)))[0]?.model;
}

// Links ticket, or makes one from the card's title and body (its notes file, else body), in the board's source, setting
// item.ticket, and ticket_created when kickflip made it. A board with no source has no tickets, so its cards stay tasks
// (docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md). The one way a ticket is made or linked
// (board/ticket-paths.test.mjs).
async function assignTicket(site, itemFile, item, ticket, options, dir, body) {
  const source = (await boardSource(site)) || fail(NO_SOURCE);
  try {
    body ??= ticket === undefined && item.plan ? await fs.readFile(await planPath(dir, item.plan), 'utf8') : item.notes || '';
    const r = await resolveTicket(source, { ticket, title: item.title, body, repo: boardRepoOf(site, itemFile) }, options);
    item.ticket = r.ticket;
    if (r.created) item.ticket_created = true; else delete item.ticket_created;
  } catch (e) { if (e instanceof BoardError) throw e; fail(e.message); }
}
const NO_SOURCE = 'this board has no ticket source, so its tasks get no tickets; pick GitHub issues or Linear in Board settings first';
// The next task's id, T-<n> past the highest on the board, its Done archive included, so a key is never reused. Run under
// the tickets lock (ticketWrite).
// A card dropped from its item file (dropCard) leaves its number there as last_task.
async function nextTaskId(site) {
  const ids = [];
  const dropped = [];
  for (const entry of await itemSources(site)) {
    const itemFile = await readJSON(entry.file, {});
    ids.push(...(itemFile.items || []).map((it) => it.id));
    dropped.push(Number(itemFile.last_task) || 0);
  }
  if (site) ids.push(...(await readArchive(site)).map((a) => a.item?.id));
  return `T-${Math.max(0, ...dropped, ...ids.map((id) => Number(/^T-([1-9]\d*)$/.exec(String(id))?.[1] || 0))) + 1}`;
}

const ticketWrite = (site, fn) => withFileLock(path.join(site || wavesDir(), 'tickets'), fn, { heartbeat: true });
export const setItem = (site, key, changes, options) => (changes.ticket !== undefined || changes.newTicket || changes.phase === 'ready'
  ? ticketWrite(site, () => changeItem(site, key, changes, options)) : changeItem(site, key, changes, options));
export const addItem = (site, key, details, options) => ticketWrite(site, () => createItem(site, key, details, options));

// Card added, just written, blocks each of blocked (ids in its item file, or keys), which gains it as a dep, and waits
// on each of deps: on a site, an Unblocks and a Blocked by line, one in each thread, for each.
async function blockLines(site, added, blocked, deps, options) {
  const { file: slug, id } = parseKey(added);
  for (const other of blocked) {
    const target = depKey(slug, other);
    const { item: waiting } = await loadItem(site, target);
    await changeItem(site, target, { deps: [...(waiting.deps || []), parseKey(target).file === slug ? id : added].join(',') }, options);
    if (site) {
      await appendCommand(site, added, { command: 'unblocks', card: target });
      await appendCommand(site, target, { command: 'blocked-by', card: added });
    }
  }
  for (const other of site ? deps : []) {
    await appendCommand(site, added, { command: 'blocked-by', card: depKey(slug, other) });
    await appendCommand(site, depKey(slug, other), { command: 'unblocks', card: added });
  }
}

// → {file, key}. A new card starts in Todo, placed as it is made, as a task with no ticket unless ticket links one or
// newTicket makes one (docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md). key is <file>/<id>, or
// <file> alone, which names the card from its ticket, or T-<n> for a task. parent is the card it was spun out of
// (docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md); split, a split of that Parent, copies its gates.
// docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md: phase files the card at once, with
// relate its Related to. docs/adr/2026-11-06-1700-a-boards-lessons-live-in-the-product.md: with intake and a site, phase
// is required, so no card an agent adds reads New; a card added with no phase starts discussing. filed is the
// orchestrator's item add on a board, which names where the task came from and links the tasks it names.
async function createItem(site, key, { title, notes, notesFrom, before, deps, ticket, newTicket, pickUpAt, block, parent, split, size, model, phase, state, relate, fromAsk, text: said, intake = false, filed = false, replyOn }, options) {
  const { file: slug, id } = key.includes('/') ? parseKey(key) : { file: key };
  if (id !== undefined) domId(id, 'the item id');
  checkPhase(phase, state);
  if (said !== undefined) text(said, '--text');
  // docs/adr/2026-11-13-2050-a-task-filed-by-the-orchestrator-opens-with-its-first-message.md
  if (said !== undefined && fromAsk === undefined && phase !== 'discussing') fail('--text goes with --from-ask, or with --phase discussing');
  if (fromAsk !== undefined && said === undefined) fail('--from-ask needs --text "<first line>", the item\'s first thread line after the ask');
  if (ticket !== undefined && newTicket) fail('pass --ticket <id> to link a ticket or --new-ticket to make one, not both');
  // docs/adr/2026-11-16-1100-a-task-the-orchestrator-files-comes-in-as-an-ask-through-new.md
  if (split && parent === undefined) fail(SPLIT_NEEDS_PARENT);
  if (intake && site && parent !== undefined) fail(`a task filed from another comes in as an ask: item add ${slug} --ask "<the request>" --parent ${parent}${split ? ' --split' : ''}, which triage titles, notes and sorts`);
  // docs/adr/2026-11-16-1700-a-filed-task-links-where-it-came-from-and-the-tasks-it-names.md: a task of your own names
  // the tasks it touches; the owner's (an ask's filing, an imported ticket) need not.
  const imported = ticket !== undefined || (id !== undefined && Boolean(ticketNamed(await boardSource(site), id)));
  if (filed && fromAsk === undefined && !imported && relate === undefined) fail(`${UNSOURCED}: pass --relate <the tasks it touches>, or file one from another task with item add ${slug} --ask "<the request>" --parent <that task>`);
  // docs/adr/2026-11-10-1100-item-add-files-an-ask-in-one-command.md: every refusal below comes before assignTicket, so it writes nothing.
  const ask = fromAsk === undefined ? undefined : await checkAsk(site, fromAsk);
  if (ask) await refuseMoved(site, ask);
  if (ask) await refuseFiled(site, ask);
  const hold = holdOf({ block, pickUpAt });
  if (ask && phase === undefined && !hold) fail('--from-ask files a task, which reads New until it has a phase: pass --phase discussing, grilling, prototyping, or ready for a Quick build ask, or --blocked to file it for later');
  if (phase === 'ready' && ask && await fromSlack(site, ask)) fail(SLACK_DISCUSSES(ask));
  if (phase === 'ready' && !(ask && await quickAsk(site, ask))) fail(ask ? `ask "${ask}" is not a Quick build ask, so item add files it discussing, grilling or prototyping` : 'item add files a task discussing, grilling or prototyping; ready is for a Quick build ask, filed with --from-ask');
  if (phase === 'ready' && size !== undefined && size !== 'small') fail(QUICK_NOT_SMALL(key));
  if (phase === 'ready' && !size) fail(`a new ready task has no size; a builder starts from it, so pass --size small or large with --phase ready`);
  // docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md: a new card has no questions yet, so its notes
  // are complete once they hold more than its title.
  if (phase === 'ready' && !(notes ?? '').trim() && notesFrom === undefined) fail('a new ready task has no notes; a builder starts from them, so pass --notes or --notes-from with --phase ready');
  if (intake && site && phase === undefined && !hold) fail('item add files a task on a board: pass --phase discussing, grilling or prototyping, or --blocked to file it for later');
  // A card an agent files stands alone from the start; an ask-born card starts from the ask's text instead.
  if (intake && site && !ask && !(notes ?? '').trim() && notesFrom === undefined) fail('item add files a task with notes: pass --notes "<text>" or --notes-from <draft.md>, so the card stands alone; a split takes its slice of the parent\'s proposed split');
  const proposes = await refuseSecondProposal(site, title);
  const { source, itemFile } = await loadItemFile(site, slug);
  if (id !== undefined && itemFile.items.some((it) => it.id === id)) fail(`item file "${slug}" already has an item "${id}"`);
  const created = new Date().toISOString();
  // An agent's card is titled Conventionally; the board's own (an architecture review's) waits for a retitle before its build.
  const item = { id, title: intake ? cardTitle(title) : text(title, '--title'), created, lane: 'todo', lane_at: created };
  if (parent !== undefined) item.parent = await parentKey(site, slug, null, parent) || fail('--parent takes a task, such as <file>/<id>');
  // docs/adr/2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md: a split child keeps the answers its parent's grill got.
  if (split) await copyGates(site, item);
  if (notes !== undefined && notesFrom !== undefined) fail('pass --notes or --notes-from, not both');
  // The ticket's body is the draft or the --notes text; the notes file heads the text with the card's title.
  const body = notesFrom !== undefined ? await refuseCardNotes(site, notesFrom, '--notes-from', () => `${DRAFT_HINT}, and link that task with --relate`)
    : notes === undefined ? '' : text(notes, '--notes');
  if (notesFrom !== undefined && !body.trim()) fail(`--notes-from ${notesFrom} is empty`);
  const seed = notesFrom !== undefined ? body : `# ${item.title}\n${body && `\n${body}\n`}`;
  setBuildChoice(item, { size, model });
  if (deps !== undefined) item.deps = await depList(site, slug, deps);
  // before: each task listed gains the new one as a dep in the same write; checked before anything is written.
  const blocked = before === undefined ? [] : await depList(site, slug, before);
  if (hold) setHold(item, hold);
  if (hold && ask && phase === undefined) item.filed_held = true;
  if (relate !== undefined) item.related = await relatedKeys(site, key, relate, '--relate');
  const linked = [item.parent, ...item.related || [], ...[...item.deps || [], ...blocked].map((d) => depKey(slug, d))];
  if (filed) await refuseUnlinked(site, 'the new task', `${item.title}\n${body}`, linked);
  const writeReply = await replyFirst(site, linked.filter(Boolean), replyOn);
  if (ask) item.from_ask = ask;
  // docs/adr/2026-11-15-1000-every-new-ticket-starts-discussing.md: a task added with no phase, held or not, starts discussing.
  const opened = phase === undefined && !ask && Boolean(site);
  if (phase !== undefined) item.phase = phase;
  else if (opened) item.phase = 'discussing';
  if (PLANNED.includes(phase)) owe(item, phase === 'grilling' ? 'grill' : 'prototype');
  // docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md: an id in the source's own form names the ticket to link.
  const named = id === undefined ? null : ticketNamed(await boardSource(site), id);
  if (named && ticket !== undefined && ticketNamed(await boardSource(site), ticket) !== named) fail(`--ticket ${ticket} is not the ticket ${id} names`);
  // docs/adr/2026-11-10-1600-tickets-are-made-at-ready.md: a Quick build is filed ready, so it gets its ticket here.
  const madeAtReady = phase === 'ready' && !named && ticket === undefined && !newTicket && Boolean(await boardSource(site));
  if (madeAtReady) newTicket = true;
  if (named && newTicket) fail(`${id} names ticket ${named}, so --new-ticket would make another; drop --new-ticket`);
  if (ticket !== undefined || newTicket || named) await assignTicket(site, itemFile, item, ticket ?? named ?? undefined, options, source.dir, body);
  if (id === undefined && item.ticket) {
    item.id = cardIdOf(item.ticket);
    if (itemFile.items.some((it) => it.id === item.id)) fail(`item file "${slug}" already has an item "${item.id}"; link ${item.ticket} with item add ${slug}/<id> --ticket ${item.ticket}`);
  } else if (id === undefined) item.id = await nextTaskId(site);
  item.plan = freeNotesName(source.dir, item.id);
  await writeNotesFile(path.join(source.dir, item.plan), seed);
  const added = `${slug}/${item.id}`;
  itemFile.items.push(item);
  await writeJSON(source.file, itemFile);
  await writeReply();
  await blockLines(site, added, blocked, intake ? item.deps || [] : [], options);
  if (ask) {
    await appendMessage(site, added, { text: said });
    // An ask is in one card's thread: becoming this item moves it out of a card it was folded into.
    const links = await readAskLinks(site);
    if (routeRecord(links, ask) !== undefined) { delete links[ask]; await writeJSON(askLinksFile(site), { links }); }
  }
  if (madeAtReady && site) await appendStatus(site, added, 'ticket-made', { ticket: item.ticket });
  if (site) await postLinkLines(site, added, { related: new Set(), parent: null }, await linksOf(site, added), { spunOut: true });
  if (said !== undefined && !ask) await appendMessage(site, added, { text: said });
  if (proposes) await markDescription(site, { description_proposal: added, description_checked_at: created });
  return { file: source.file, key: added, lines: [] };
}

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
// Moves each item file's follow-ups, a list kept beside its items until then, into its items, once: each keeps its id,
// title, ticket and notes, its date as when it was made, and its Filed from as its Parent; a done one is in Done,
// closed at its thread's last line. An item file whose follow-up has a card's id is left as it is, and named in the refusal.
// Run by the board server as it starts. → one line per item file moved.
export const migrateFollowups = (site) => ticketWrite(site, async () => {
  const lines = [];
  for (const entry of await itemSources(site)) {
    const itemFile = await readJSON(entry.file, null);
    if (!Array.isArray(itemFile?.items) || !Array.isArray(itemFile.followups)) continue;
    const clash = itemFile.followups.find((f) => itemFile.items.some((it) => it.id === f.id));
    if (clash) fail(`${entry.slug}: follow-up ${clash.id} has the id of a task; rename one, then restart the board`);
    const moved = [];
    for (const { id, title, from, filed, done, ...rest } of itemFile.followups) {
      const closedAt = done ? (site && (await readLog(threadFile(site, `${entry.slug}/${id}`))).map((l) => l.ts).filter(Boolean).sort().pop()) || filed : null;
      moved.push({ id, title, ...(filed ? { created: filed } : {}), ...(from ? { parent: depKey(entry.slug, from) } : {}),
        ...(done ? { lane: 'done', ...(closedAt ? { lane_at: closedAt, closed_at: closedAt } : {}) } : {}), ...rest });
    }
    const { followups, ...kept } = itemFile;
    await writeJSON(entry.file, { ...kept, items: [...itemFile.items, ...moved] });
    lines.push(`${entry.slug}: ${moved.length} follow-ups moved to tasks (${moved.filter((m) => m.lane === 'done').length} done)`);
  }
  return lines;
});

// docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md
// A card's status becomes the facts that replace it: merged, done and dropped put it in Done, closed at the status's
// time, merged also marking each of its PRs merged then; held becomes its held flag; checking marks its newest build
// record handed back. Every other status goes, and the board's first build places the card. → whether it changed.
function statusToFacts(item, records = []) {
  if (item.status === undefined && item.status_at === undefined && item.merged_at === undefined) return false;
  const at = item.merged_at || item.status_at || new Date().toISOString();
  if (['merged', 'done', 'dropped'].includes(item.status)) Object.assign(item, { lane: 'done', lane_at: at, closed_at: at });
  if (item.status === 'merged' || item.merged_at) { item.prs = storedPRs(item).map((p) => ({ ...p, merged_at: p.merged_at || at })); delete item.pr; }
  if (item.status === 'held') item.held = true;
  const newest = records.filter((r) => r.started && builds(r) && r.kind !== HELPER).sort((a, b) => String(a.started).localeCompare(String(b.started))).at(-1);
  if (item.status === 'checking' && newest) newest.handed_back = at;
  delete item.status; delete item.status_at; delete item.merged_at;
  return true;
}

// statusToFacts over every card of a site's item files and its archive. Run by the board server as it starts. → one
// line per file changed.
export const migrateStatuses = (site, archived = () => readArchive(site)) => ticketWrite(site, async () => {
  const lines = [];
  for (const entry of await itemSources(site)) {
    const itemFile = await readJSON(entry.file, null);
    let changed = 0;
    for (const it of Array.isArray(itemFile?.items) ? itemFile.items : []) {
      const files = it.status === 'checking' ? await builderFiles(entry.dir, it.id) : [];
      const records = await Promise.all(files.map((f) => readJSON(f, null)));
      if (!statusToFacts(it, records.filter(Boolean))) continue;
      changed++;
      for (const [i, r] of records.entries()) if (r?.handed_back) await writeJSON(files[i], r);
    }
    if (!changed) continue;
    await writeJSON(entry.file, itemFile);
    lines.push(`${entry.slug}: ${changed} tasks' statuses became lanes and facts`);
  }
  await archiveWrite(site, async () => {
    const cards = await archived();
    const changed = cards.filter((c) => c.item && statusToFacts(c.item)).length;
    if (!changed) return;
    await writeArchive(site, cards);
    lines.push(`archive: ${changed} tasks' statuses became lanes and facts`);
  });
  return lines;
});

// docs/adr/2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md
// Each card not in Done with no gates takes gates.prototype from its prototype_gate questions the owner answered yes
// or no, the newest answer deciding; a yes reads ran once its card is past grilling or its thread has the
// prototype-round line after it. A next_gate answer is always kept as it is given (keepGate), so it needs no backfill.
// Run by the board server as it starts. → one line per item file changed.
export const migrateGates = (site) => ticketWrite(site, async () => {
  const { asked } = await topicQuestionsAll(site);
  const lines = [];
  for (const entry of await itemSources(site)) {
    const itemFile = await readJSON(entry.file, null);
    let changed = 0;
    for (const it of Array.isArray(itemFile?.items) ? itemFile.items : []) {
      if (it.gates || it.lane === 'done') continue;
      const key = `${entry.slug}/${it.id}`;
      const last = asked.filter((q) => q.topic === `item:${key}` && q.prototype_gate).flatMap((q) => q.answers).filter((a) => ['yes', 'no'].includes(a.choice))
        .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1);
      if (!last) continue;
      const ran = last.choice === 'yes' && (it.phase !== 'grilling'
        || (await readLog(threadFile(site, key))).some((l) => l.line === 'prototype-round' && String(l.ts) > String(last.ts)));
      it.gates = { prototype: ran ? 'ran' : last.choice };
      changed++;
    }
    if (!changed) continue;
    await writeJSON(entry.file, itemFile);
    lines.push(`${entry.slug}: ${changed} tasks keep their gate answers`);
  }
  return lines;
});

// docs/adr/2026-11-16-1400-todo-sorts-strictly-by-created.md
// Each live card with no created time takes the time of the first line of its thread. Todo sorts strictly by created, so
// this runs as the board server starts, once. A card with no thread keeps none and lists last in Todo.
// → one line per item file changed.
export const migrateCreated = (site) => ticketWrite(site, async () => {
  const lines = [];
  for (const entry of await itemSources(site)) {
    const itemFile = await readJSON(entry.file, null);
    let changed = 0;
    for (const it of Array.isArray(itemFile?.items) ? itemFile.items : []) {
      if (it.created) continue;
      const first = (await readLog(threadFile(site, `${entry.slug}/${it.id}`)))[0];
      if (!first?.ts) continue;
      it.created = first.ts;
      changed++;
    }
    if (!changed) continue;
    await writeJSON(entry.file, itemFile);
    lines.push(`${entry.slug}: ${changed} tasks took their first event as created`);
  }
  return lines;
});

// docs/adr/2026-11-11-1200-every-lane-has-phases.md
// A card's Todo `state` becomes its `phase`, and a Done card with none takes how it closed: merged when one of its PRs
// merged, or with no PRs when a build ran on it, which landed it; closed otherwise. → whether it changed.
function stateToPhase(item, built) {
  const doneWithout = item.lane === 'done' && !PHASES.done.includes(item.phase);
  if (!('state' in item) && !doneWithout) return false;
  if ('state' in item && item.state !== undefined) item.phase = item.state;
  delete item.state;
  if (doneWithout) {
    const prs = storedPRs(item);
    item.phase = prs.some((p) => p.merged_at) || (!prs.length && built) ? 'merged' : 'closed';
  }
  return true;
}
// stateToPhase over every card of a site's item files and its archive, before the board server's other start-up
// passes. → one line per file changed.
export const migratePhases = (site, archived = () => readArchive(site)) => ticketWrite(site, async () => {
  const lines = [];
  const sources = await itemSources(site);
  // Read only for a Done card with no phase yet, the one stateToPhase asks it of.
  const built = async (dir, it) => Boolean(dir) && it.lane === 'done' && !PHASES.done.includes(it.phase) && (await Promise.all((await builderFiles(dir, it.id)).map((f) => readJSON(f, null)))).some((r) => r?.started && builds(r));
  for (const entry of sources) {
    const itemFile = await readJSON(entry.file, null);
    let changed = 0;
    for (const it of Array.isArray(itemFile?.items) ? itemFile.items : []) if (stateToPhase(it, await built(entry.dir, it))) changed++;
    if (!changed) continue;
    await writeJSON(entry.file, itemFile);
    lines.push(`${entry.slug}: ${changed} tasks' states became phases`);
  }
  await archiveWrite(site, async () => {
    const cards = await archived();
    let changed = 0;
    for (const c of cards) if (c.item && stateToPhase(c.item, await built(sources.find((e) => e.slug === (c.file || parseKey(c.key).file))?.dir, c.item))) changed++;
    if (!changed) return;
    await writeArchive(site, cards);
    lines.push(`archive: ${changed} tasks' states became phases`);
  });
  return lines;
});

// docs/adr/2026-11-17-0400-a-card-outside-in-progress-never-keeps-a-build-step-phase.md
// A card stored outside In Progress that still holds a build step as its phase (reading, building, checking, landing) loses
// it, and a Done card then reads how it closed. Run by the board server as it starts. → one line per item file changed.
export const clearBuildPhases = (site) => ticketWrite(site, async () => {
  const lines = [];
  for (const entry of await itemSources(site)) {
    const itemFile = await readJSON(entry.file, null);
    const stale = (Array.isArray(itemFile?.items) ? itemFile.items : []).filter((it) => it.lane && it.lane !== 'progress' && PHASES.progress.includes(it.phase));
    if (!stale.length) continue;
    for (const it of stale) delete it.phase;
    await writeJSON(entry.file, itemFile);
    lines.push(`${entry.slug}: ${stale.length} tasks outside In Progress lost a build step phase`);
  }
  return lines;
});

// docs/adr/2026-11-15-1000-every-new-ticket-starts-discussing.md
// A Todo card with no phase that no ask made, which the arrival grill used to take, becomes discussing, once, silently. Run by the board server as it starts. → one line per item file changed.
export const discussNewCards = (site) => ticketWrite(site, async () => {
  const lines = [];
  for (const entry of await itemSources(site)) {
    const itemFile = await readJSON(entry.file, null);
    const fresh = (Array.isArray(itemFile?.items) ? itemFile.items : []).filter((it) => !it.phase && !it.from_ask && !it.unfiled && !it.answered_at
      && !leftTodo(it) && !hasPR(it));
    if (!fresh.length) continue;
    for (const it of fresh) {
      it.phase = 'discussing';
      delete it.filed_held;
    }
    await writeJSON(entry.file, itemFile);
    lines.push(`${entry.slug}: ${fresh.length} new tasks moved to discussing`);
  }
  return lines;
});

// docs/adr/2026-11-07-0700-staging-then-ready.md
// An Implement message's wait from before staging, implement_at, becomes staging, keeping its time as staged_at; a card
// already ready, which the old release would have started, stays ready. Run by the board server as it starts. → one
// line per item file changed.
export const stageImplementAsks = (site) => ticketWrite(site, async () => {
  const lines = [];
  for (const entry of await itemSources(site)) {
    const itemFile = await readJSON(entry.file, null);
    const asked = (Array.isArray(itemFile?.items) ? itemFile.items : []).filter((it) => it.implement_at);
    if (!asked.length) continue;
    for (const it of asked) {
      if (it.phase !== 'ready') Object.assign(it, { phase: 'staging', staged_at: it.implement_at });
      delete it.implement_at;
    }
    await writeJSON(entry.file, itemFile);
    lines.push(`${entry.slug}: ${asked.length} Implement asks moved to staging or ready`);
  }
  return lines;
});

// docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md
// data/done-archive.json {cards: [{key, file, archived_at, closed_at, item, questions, asks}]}, newest closed first:
// the Done cards that left the board, each with when it closed (its Done card's sortAt), its item file entry and its
// resolved questions from owner.json. The board build never reads it; GET /api/done builds a page of its cards as they
// page in (docs/adr/2026-11-04-1056-archived-done-cards-are-built-as-they-page-in.md), and GET /api/thread reads an
// archived card's entry. An empty archive is no file. Its thread, notes and builder records stay where they are. asks
// are the asks the card was made from that its move linked to it in data/ask-links.json, so the board still reads them
// as gone into that card.
export const archiveFile = (site) => path.join(site, 'data', 'done-archive.json');
const archiveWrite = (site, fn) => withFileLock(path.join(site, 'done-archive'), fn, { heartbeat: true });
export const readArchive = async (site) => (await readJSON(archiveFile(site), { cards: [] })).cards || [];
// One read of the archive for the start-up passes that take a `cards` reader: the board server hands the same one to each, so
// the file is read once as it starts. The passes that write the archive write the cards they were given, so the held
// copy stays what the file holds.
export const archiveReader = (site) => {
  let held;
  return async () => (held ??= await readArchive(site));
};
// An entry's place, which GET /api/done's before= cursor names: newest first by its closing time, then by key.
export const archiveRank = (a) => `${a.closed_at || ''}|${a.key}`;
const byClosed = (a, b) => (archiveRank(a) < archiveRank(b) ? 1 : archiveRank(a) > archiveRank(b) ? -1 : 0);
// How many cards the archive holds, kept in data/done-archive-count.json beside it so /api/board never reads the archive.
// An archive from before the count was kept is counted once, when first asked.
const archiveCountFile = (site) => path.join(site, 'data', 'done-archive-count.json');
export async function archiveCount(site) {
  const kept = (await readJSON(archiveCountFile(site), null))?.count;
  if (Number.isInteger(kept)) return kept;
  const count = (await readArchive(site)).length;
  // Counted from the archive as it stands, so no server is told of it.
  await replace(archiveCountFile(site), JSON.stringify({ count }, null, 2) + '\n', { told: false });
  return count;
}
async function writeArchive(site, cards) {
  if (cards.length) await writeJSON(archiveFile(site), { cards: cards.sort(byClosed) });
  else await remove(archiveFile(site));
  await writeJSON(archiveCountFile(site), { count: cards.length });
}

// Moves picks [{key, closed_at, prs?}] (server.mjs from domain.mjs archivedOf) from their item files to the archive,
// with their resolved questions; a pick no longer finished in its item file stays. The archive is written first, so
// a stop part way leaves a card in both, and the next run moves it again. prs is the card's PR views as the board
// last read them: each PR GitHub was read for keeps its CI, reviews and Codex count on the archived item (keptPRs).
// → the keys moved.
export const archiveCards = (site, picks) => archiveWrite(site, async () => {
  const wanted = new Map(picks.map((p) => [p.key, p]));
  const at = new Date().toISOString();
  const moved = [];
  const writes = [];
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    if (!Array.isArray(itemFile?.items)) continue;
    const leaving = itemFile.items.filter((it) => wanted.has(`${source.slug}/${it.id}`) && it.lane === 'done');
    if (!leaving.length) continue;
    for (const item of leaving) {
      const pick = wanted.get(`${source.slug}/${item.id}`);
      moved.push({ ...pick, file: source.slug, archived_at: at, item: pick.prs ? keptPRs(item, pick.prs) : item });
    }
    writes.push([source.file, { ...itemFile, items: itemFile.items.filter((it) => !leaving.includes(it)) }]);
  }
  if (!moved.length) return [];
  const owner = await readJSON(ownerFile(site), { items: [] });
  const topics = new Map(moved.map((m) => [`item:${m.key}`, m]));
  for (const m of moved) m.questions = (owner.items || []).filter((q) => q.topic === `item:${m.key}` && q.resolved);
  const links = await readAskLinks(site);
  for (const m of moved) m.asks = m.item.from_ask && routeRecord(links, m.item.from_ask) === undefined ? [m.item.from_ask] : [];
  const keys = new Set(moved.map((m) => m.key));
  await writeArchive(site, [...(await readArchive(site)).filter((a) => !keys.has(a.key)), ...moved.map(({ key, file, archived_at, closed_at, item, questions, asks }) => ({ key, file, archived_at, closed_at, item, questions, asks }))]);
  if (moved.some((m) => m.asks.length)) await writeJSON(askLinksFile(site), { links: { ...links, ...Object.fromEntries(moved.flatMap((m) => m.asks.map((id) => [id, m.key]))) } });
  for (const [file, itemFile] of writes) await writeJSON(file, itemFile);
  const kept = (owner.items || []).filter((q) => !(topics.has(q.topic) && q.resolved));
  if (kept.length !== (owner.items || []).length) await writeJSON(ownerFile(site), { ...owner, items: kept });
  return [...keys];
});

// docs/adr/2026-11-06-1547-a-cards-pr-badges-stay-once-added.md
// item with each stored PR that a view in views [{repo, number, state, checks, reviews}] read from GitHub
// marked kept: {checks, reviews}, the last state its badges draw once the board no longer reads the hub's check for it.
function keptPRs(item, views) {
  if (!hasPR(item)) return item;
  const prs = storedPRs(item).map((p) => {
    const v = views.find((w) => w.state && w.number === p.number && (!p.repo || p.repo === w.repo));
    return v ? { ...p, kept: { checks: v.checks, reviews: v.reviews } } : p;
  });
  const { pr, ...rest } = item;
  return { ...rest, prs };
}

// Puts archived card key back in its item file, with its questions, for a command that names it. → whether it was
// archived.
async function restoreArchived(site, key) {
  if (!site || !existsSync(archiveFile(site))) return false;
  return archiveWrite(site, async () => {
    const archive = await readArchive(site);
    const entry = archive.find((a) => a.key === key);
    if (!entry) return false;
    const source = (await itemSources(site)).find((s) => s.slug === entry.file);
    const itemFile = source && await readJSON(source.file, null);
    if (!Array.isArray(itemFile?.items)) return false;
    if (!itemFile.items.some((it) => it.id === entry.item.id)) await writeJSON(source.file, { ...itemFile, items: [...itemFile.items, entry.item] });
    const owner = await readJSON(ownerFile(site), { items: [] });
    const have = new Set((owner.items || []).map((q) => q.id));
    const back = (entry.questions || []).filter((q) => !have.has(q.id));
    if (back.length) await writeJSON(ownerFile(site), { ...owner, items: [...(owner.items || []), ...back] });
    const links = await readAskLinks(site);
    const linked = (entry.asks || []).filter((id) => routeRecord(links, id) === key);
    if (linked.length) await writeJSON(askLinksFile(site), { links: Object.fromEntries(Object.entries(links).filter(([id]) => !linked.includes(id))) });
    await writeArchive(site, archive.filter((a) => a !== entry));
    return true;
  });
}

// docs/adr/2026-11-04-1056-archived-done-cards-are-built-as-they-page-in.md
// Drops what nothing reads, once: an archive entry's page card, keeping its sortAt as closed_at; an item file entry's summary and an item file's internal flag;
// and a question's push_tag and no_change, in owner.json and in the archive. It also renames a question's
// suggested.card to suggested.task. Writes only a file that held one. Run by the board server as it starts.
const DEAD_QUESTION_FIELDS = ['push_tag', 'no_change'];
const renameSuggestedCard = ({ card, ...rest }) => ({ ...rest, task: card });
const stripQuestion = ({ suggested, ...q }) => ({
  ...Object.fromEntries(Object.entries(q).filter(([k]) => !DEAD_QUESTION_FIELDS.includes(k))),
  ...(suggested ? { suggested: 'card' in suggested ? renameSuggestedCard(suggested) : suggested } : {}),
});
const stripItem = ({ summary, ...it }) => it;
const holdsDead = (q) => DEAD_QUESTION_FIELDS.some((k) => k in q) || 'card' in (q.suggested || {});
export const stripDeadFields = (site, archived = () => readArchive(site)) => archiveWrite(site, async () => {
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    if (Array.isArray(itemFile?.items) && ('internal' in itemFile || itemFile.items.some((it) => 'summary' in it))) {
      const { internal, ...rest } = itemFile;
      await writeJSON(source.file, { ...rest, items: itemFile.items.map(stripItem) });
    }
  }
  const owner = await readJSON(ownerFile(site), null);
  if ((owner?.items || []).some(holdsDead)) await writeJSON(ownerFile(site), { ...owner, items: owner.items.map(stripQuestion) });
  const archive = await archived();
  if (archive.some((a) => 'card' in a || 'summary' in a.item || (a.questions || []).some(holdsDead))) {
    await writeArchive(site, archive.map(({ card, ...a }) => ({ ...a, ...(card ? { closed_at: a.closed_at || card.sortAt } : {}),
      item: stripItem(a.item), questions: (a.questions || []).map(stripQuestion) })));
  }
});

// docs/adr/2026-11-09-2100-a-lineup-is-called-a-wave-and-the-wave-file-an-item-file.md
// The rename of "lineup" to "wave" and of the wave file to the item file, over every board in the manifest, once (its
// `migrated` list records 'wave-names'). Run by the hub as it starts, before it starts any board. On each board: a
// board.json items file named wave.json is renamed items.json beside it, keeping its slug (written to board.json when
// it had none), so card keys, threads and topics keep their names; each item file's `lineups` becomes `waves`, and each
// lineup-<slug>.md note beside it wave-<slug>.md; in every data/*.json a whole string wave:<slug> (a wave file's
// triage topic) becomes file:<slug>, then lineup:<slug> becomes wave:<slug>; an archive entry's `wave` becomes `file`,
// and an architecture review's {wave, lineup} its {wave} or {file}. events.jsonl and the threads stay as written.
// → the routes of the boards it ran on
export async function migrateWaveNames() {
  return withManifestLock(async () => {
    const manifest = readManifest();
    const done = Array.isArray(manifest.migrated) ? manifest.migrated : [];
    if (done.includes('wave-names') || !Object.keys(manifest.sites || {}).length) return [];
    const routes = [];
    for (const { route, dir } of listBoards(manifest)) {
      await renameWaveNames(dir);
      routes.push(route);
    }
    manifest.migrated = [...done, 'wave-names'];
    await writeManifest(manifest);
    return routes;
  });
}

const readPlain = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const writePlain = (file, value) => replace(file, JSON.stringify(value, null, 2) + '\n');
const renamedTopic = (v) => (typeof v !== 'string' ? v : v.replace(/^wave:([a-z0-9-]+)$/, 'file:$1').replace(/^lineup:([a-z0-9-]+)$/, 'wave:$1'));
const renameTopics = (v) => (Array.isArray(v) ? v.map(renameTopics)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [renamedTopic(k), renameTopics(x)])) : renamedTopic(v));

async function renameWaveNames(site) {
  const boardFile = path.join(site, 'board.json');
  const cfg = await readPlain(boardFile).catch(() => null);
  if (cfg && typeof cfg.items === 'string' && cfg.items !== 'waves' && path.basename(cfg.items) === 'wave.json') {
    const items = path.join(path.dirname(cfg.items), 'items.json');
    if (existsSync(path.resolve(site, cfg.items))) await fs.rename(path.resolve(site, cfg.items), path.resolve(site, items));
    await writePlain(boardFile, { ...cfg, items, slug: cfg.slug || 'wave' });
  }
  for (const source of await itemSources(site)) {
    const itemFile = await readPlain(source.file).catch(() => null);
    if (!Array.isArray(itemFile?.lineups)) continue;
    const { lineups, ...rest } = itemFile;
    await writePlain(source.file, { ...rest, waves: [...(rest.waves || []), ...lineups] });
    for (const { slug } of lineups) await fs.rename(path.join(source.dir, `lineup-${slug}.md`), path.join(source.dir, `wave-${slug}.md`)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }
  const data = path.join(site, 'data');
  for (const name of (await fs.readdir(data).catch(() => [])).filter((f) => f.endsWith('.json'))) {
    const file = path.join(data, name);
    const before = await fs.readFile(file, 'utf8');
    let value;
    try { value = JSON.parse(before); } catch { continue; }
    value = renameTopics(value);
    if (name === 'done-archive.json' && Array.isArray(value.cards)) value.cards = value.cards.map(({ wave, ...a }) => (wave === undefined ? a : { ...a, file: wave }));
    if (name === 'arch-reviews.json' && Array.isArray(value.reviews)) value.reviews = value.reviews.map(({ wave, lineup, ...r }) => (lineup ? { ...r, wave } : { ...r, file: wave }));
    if (JSON.stringify(value) !== JSON.stringify(JSON.parse(before))) await writePlain(file, value);
  }
}

// docs/adr/2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping.md
// The drop of waves, over every board in the manifest, once (its `migrated` list records 'drop-waves'). Run by the hub
// as it starts, after migrateWaveNames, before it starts any board. In each item file a dep wave:<slug> becomes the
// cards that wave held, by bare id in their own file, and `waves` goes; every other dep, Parent and Related to stays.
// The wave-<slug>.md notes stay on disk as written. → the routes of the boards it changed
export async function migrateDropWaves() {
  return withManifestLock(async () => {
    const manifest = readManifest();
    const done = Array.isArray(manifest.migrated) ? manifest.migrated : [];
    if (done.includes('drop-waves') || !Object.keys(manifest.sites || {}).length) return [];
    const routes = [];
    for (const { route, dir } of listBoards(manifest)) if (await dropWaves(dir)) routes.push(route);
    manifest.migrated = [...done, 'drop-waves'];
    await writeManifest(manifest);
    return routes;
  });
}

async function dropWaves(site) {
  const sources = await itemSources(site);
  const files = await Promise.all(sources.map((s) => readPlain(s.file).catch(() => null)));
  const held = new Map(sources.flatMap((s, i) => (files[i]?.waves || [])
    .map((w) => [`wave:${w.slug}`, (w.items || w.phases.flat()).map((id) => `${s.slug}/${id}`)])));
  const waveDep = (d) => String(d).startsWith('wave:');
  let changed = false;
  for (const [i, s] of sources.entries()) {
    const itemFile = files[i];
    if (!itemFile || !('waves' in itemFile || (itemFile.items || []).some((it) => (it.deps || []).some(waveDep)))) continue;
    const { waves, ...rest } = itemFile;
    for (const it of rest.items || []) {
      if (!(it.deps || []).some(waveDep)) continue;
      const own = (key) => (parseKey(key).file === s.slug ? parseKey(key).id : key);
      it.deps = [...new Set(it.deps.flatMap((d) => (waveDep(d) ? (held.get(d) || []).map(own) : [d])))].filter((d) => d !== it.id);
    }
    await writePlain(s.file, rest);
    changed = true;
  }
  return changed;
}

// One record per agent on an item: agents/<id>.json for agent main, agents/<id>@<agent>.json for any other
// (server.mjs readAgents reads both). dir, when given, is the directory holding the item file; the item is not looked up.
async function builderFile(site, key, dir, agent = 'main') {
  const { id } = parseKey(key);
  if (!/^[\w-]{1,40}$/.test(agent)) fail(`--agent takes a name of letters, digits, "_" and "-", not "${agent}"`);
  const name = agent === 'main' ? `${id}.json` : `${id}@${agent}.json`;
  if (dir) return path.join(path.resolve(dir), 'agents', name);
  const { source } = await loadItem(site, key);
  return path.join(source.dir, 'agents', name);
}
const isoTime = (v, name) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fail(`${name} takes an ISO time such as 2026-10-23T16:30:00-07:00`));

// A progress line is a phase and a detail of at most DETAIL_CAP characters, the room a status line leaves once its head
// ("Codex checking: ") takes its part; a longer one is refused by lineFault, never cut
// (docs/adr/2026-11-03-0128-a-builder-status-line-is-a-phase-and-a-short-detail.md). The phases are In Progress's
// (domain.mjs PHASES).
const BUILD_PHASES = PHASES.progress;
const DETAIL_CAP = BRIEF_LINE_LIMIT - 20;
const PHASE_LIST = 'reading, building, checking or landing';
// A planner's line takes no phase: it reads its kind's word, and a --phase passed for one is dropped
// (docs/adr/2026-11-04-0131-every-new-task-is-grilled-or-prototyped-at-once.md).
function progressLine(site, phase, detail, name) {
  if (!site) fail(`${name} needs --site, since the line goes to the item's thread`);
  if (phase !== undefined && !BUILD_PHASES.includes(phase)) fail(`--phase takes ${PHASE_LIST}, not "${phase}"`);
  const words = text(detail, name);
  const long = lineFault(words, DETAIL_CAP);
  if (long) fail(`${name} ${long}. Say it shorter.`);
  return { phase, detail: words };
}
const forAgent = (line, planner, name) => {
  if (planner) return { detail: line.detail };
  if (line.phase === undefined) fail(`${name} needs --phase ${PHASE_LIST}`);
  return line;
};

// A status line lives only in the item's thread, as {kind: 'status'} (domain.mjs builderOf reads it). A progress line
// keeps its phase and reads "Building: <detail>", or "Codex building: <detail>" for an agent other than main, named by
// its kind, or by its name for a helper ("Tests building: <detail>"). A line that repeats the thread's last status line is skipped.
// A planner's line is marked planner and led by its kind's word, whichever agent it runs as ("Prototyping: …")
// (docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md,
// docs/adr/2026-11-04-0131-every-new-task-is-grilled-or-prototyped-at-once.md).
async function statusToThread(site, key, agent = 'main', builder, { phase, detail }, ts, { live = false } = {}) {
  const planner = plans(builder);
  const who = planner || agent === 'main' ? '' : builder.kind === HELPER ? agent : modelName(builder) || builder.kind || agent;
  const head = planner ? PLANNER_WORD[builder.kind] : [who, phase].filter(Boolean).join(' ');
  const repeat = new RegExp(`^(?:${head}|${phase ?? head})\\s*:?\\s+`, 'i');
  const body = head ? `${head[0].toUpperCase()}${head.slice(1)}: ${detail.replace(repeat, '')}` : detail;
  const file = threadFile(site, key);
  if ((await readLog(file)).filter((m) => m.kind === 'status').pop()?.text === body) return;
  await appendLine(file, { ts, who: 'claude', kind: 'status', run: builder.started, ...(phase ? { phase } : {}), ...(planner ? { planner: true } : {}), ...(live ? { live: true } : {}), text: body });
}

// The thread's status line for a card whose open run ended on Claude's login error: LOGGED_OUT_WORDS, once until another
// status line follows it (statusToThread skips a repeat of the last one).
export async function noteLoggedOut(site, key) {
  const { source } = await loadItem(site, key);
  const records = await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)));
  const run = records.filter((r) => r?.started && !r.done && r.session?.log).sort((a, b) => Number(builds(b)) - Number(builds(a)))[0];
  if (run) await statusToThread(site, key, 'main', run, { detail: LOGGED_OUT_WORDS }, new Date().toISOString());
}

// The card's newest build record, a lander's included: a lander's run folds into the build it lands (domain.mjs sectionOf),
// and after a failed land its record is the card's only live one. A status line written with no run while a record is
// open would draw loose, so that is an error; with no record open there is no run to keep (a card never built).
async function newestBuild(site, key) {
  const { source } = await loadItem(site, key);
  const records = (await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)))).filter((r) => r?.started);
  const newest = records.filter(builds).sort((a, b) => String(b.started).localeCompare(String(a.started)))[0];
  if (!newest && records.some((r) => !r.done)) fail(`${key} has an open run but no build to keep a status line's run`);
  return newest ?? {};
}

// docs/adr/2026-11-13-2030-a-test-run-reports-live-lines-the-thread-does-not-show.md
// A test run's words for a card, under phase (building for a builder's run, landing for a land's): {start, update, end},
// each taking words and writing them as the card's newest status line, as `builder progress` does for the card's open
// build (or its newest, once handed back). The start and the result stay in the thread; an update is a live line, which sets the card's line and keeps a
// running build from reading stale but is not shown in the thread (domain.mjs threadOf).
export async function testReport(site, key, { phase }) {
  // Like the landing line, it joins the section of the card's newest build, which is closed once the build handed back.
  const record = await newestBuild(site, key);
  const say = (live) => async (words) => {
    const line = progressLine(site, phase, words, 'a test report');
    await statusToThread(site, key, 'main', record, line, new Date().toISOString(), { live });
  };
  return { start: say(false), update: say(true), end: say(false) };
}

// The key of the card whose open build keeps the worktree at dir, or null.
export async function cardOfWorktree(site, dir) {
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    for (const it of itemFile?.items ?? []) {
      const records = await Promise.all((await builderFiles(source.dir, it.id)).map((f) => readJSON(f, null)));
      if (records.some((r) => r?.started && !r.done && r.worktree?.path === path.resolve(dir))) return `${source.slug}/${it.id}`;
    }
  }
  return null;
}

// The model a planner runs without --model (owner, #111's grill).
// A visual agent writes one page and should come back fast (owner, gh298-agent). A reviewer hunts for what is wrong,
// which takes the stronger model.
const PLANNER_MODEL = { prototype: 'sonnet', grill: 'opus', [VISUAL]: 'sonnet', [REVIEWER]: 'opus' };

// worktree, when given, makes the builder's worktree once every flag has passed (board/worktree.mjs makeWorktree), told
// the worktrees the card's other open builder records keep ({busy: [path]}), and returns {path, branch, repo}, which the
// record keeps for `board.mjs land`, and remade, the line saying it remade a leftover worktree, which goes in the output
// and the card's thread. A build (--kind build, claude or codex) on an
// open card marks it building first, refusing what item set --status building refuses
// (docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md).
// dispatch marks the record open before its agent runs, as dispatched: 'tap' for the owner's Build tap
// (startTappedBuild), 'hub' for a pull or a planner the board server starts
// (docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md), or 'session' for the session's --dispatch right before it launches some other agent. A
// builder's own start on that open record takes it up: --kind build keeps the record's kind, its Claude model and
// worktree stay, and the record starts again at now, no longer dispatched. A session's dispatch on a record the tap
// opened leaves it as it is, and a start under another agent name refuses until main's tap-opened record is taken up
// (docs/adr/2026-11-03-0219-a-build-tap-starts-the-build-in-the-board-server.md,
// docs/adr/2026-11-03-0513-the-session-opens-the-builder-record-when-it-dispatches-an-agent.md,
// docs/adr/2026-11-03-1718-a-card-reads-starting-from-its-tap-with-one-dispatched-mark.md).
// A build's start clears the card's Next.
// worktree makes the card's worktree (board/worktree.mjs boardWorktree), as --worktree and the tap ask. ownWorktree makes
// it only for a main build whose record keeps none, so every build on a board works in a worktree
// (docs/adr/2026-10-30-1654-every-builder-works-in-a-worktree.md, docs/adr/2026-11-03-1842-more-of-the-skill-moves-into-code.md).
// A Claude build takes the hub's Claude model when it is Opus or Sonnet, refusing a --model it rules out, and otherwise
// the pick's, which reads the card's size and model (docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md).
// → {file, lines, kind, model, reason, worktree}: model is the Claude model or null, reason the pick's, worktree the path or null;
// {file, alreadyOpen: true, lines: []} for a session's dispatch on a record the tap opened.
export async function startBuilder(site, key, { label, phase, progress, dir, agent = 'main', kind, model, eta, worktree, ownWorktree, dispatch, brief, target }) {
  if (phase !== undefined && progress === undefined) fail('--phase goes with --progress "<detail>"');
  const asLine = optional(progress, (v) => progressLine(site, phase, v, '--progress'));
  const file = await builderFile(site, key, dir, agent);
  const now = new Date().toISOString();
  const given = optional(kind, (v) => (/^[\w.-]{1,30}$/.test(v) ? v : fail('--kind takes a short word such as claude or codex')));
  // A legacy --kind opus or sonnet is kind claude with that model.
  const asked = providerOf(given);
  const askedModel = model ?? (given === 'opus' || given === 'sonnet' ? given : undefined);
  // docs/adr/2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md: --kind build takes the pick's kind.
  const build = ['build', ...PICKED].includes(asked);
  const before = await readJSON(file, null);
  const tapOpen = (record) => ['tap', 'hub'].includes(record?.dispatched) && !record.done;
  if (dispatch === 'session' && tapOpen(before)) return { file, alreadyOpen: true, lines: [] };
  // A visual agent, a reviewer or a helper runs beside any other, the tap's record included.
  if (agent !== 'main' && !beside({ kind: given }) && given !== HELPER && tapOpen(await readJSON(await builderFile(site, key, dir), null))) fail(`the Implement tap opened ${key}'s main builder record and no agent has taken it up; run builder start ${key} without --agent first`);
  const takeUp = before?.dispatched && !before.done ? before : null;
  const was = build && !dir ? (await loadItem(site, key)).item : undefined;
  const marking = build && !dir && !closed(was) && was.lane !== 'progress';
  // docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md: a card goes into In Progress titled as its PR will be.
  const untitled = marking && startTitleFault(key, was.title);
  if (untitled) fail(untitled, startTitleBrief(was.title));
  // A record with unverified judgment calls is a build not yet checked: a start on it resumes that build, a
  // dispatched one included (docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md).
  const resumed = before && unverifiedCalls(before).length ? before : null;
  const pick = takeUp && asked === 'build' ? { kind: providerOf(takeUp.kind), model: takeUp.model, reason: { tap: "The owner's Build tap picked it.", hub: "The board's pull picked it." }[takeUp.dispatched] ?? "The session's dispatch picked it." } : build ? builderPick({ card: was ?? {}, dir: site }) : null;
  if (pick && asked !== 'build' && asked !== pick.kind) fail(`--kind ${asked}: ${pick.kind} builds now. ${pick.reason} Pass --kind ${pick.kind}, or --kind build.`);
  const k = pick ? pick.kind : asked;
  // docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md: each kind is held by its own usage.
  const gate = readUsageGate({ dir: site });
  // docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md: a start that takes up a dispatched record isn't held, the dispatch was the gate.
  if (!(takeUp && !dispatch) && heldFor(gate, k)) throw new BoardError(pauseReasonFor(gate, k));
  const line = asLine && forAgent(asLine, plans({ kind: k }), '--progress');
  if (model !== undefined && !['opus', 'sonnet'].includes(model)) fail('--model takes opus or sonnet');
  if (askedModel !== undefined && k === 'codex') fail('--model is for kind claude; codex needs none');
  if (k === 'claude') refuseUnforced(site, askedModel);
  const claude = k === 'claude' ? askedModel ?? pick?.model ?? (takeUp && providerOf(takeUp.kind) === 'claude' ? takeUp.model : undefined) ?? 'opus'
    : plans({ kind: k }) ? askedModel ?? (takeUp?.kind === k ? takeUp.model : undefined) ?? PLANNER_MODEL[k]
    : k === HELPER ? askedModel ?? before?.model : undefined;
  const record = {
    label: label === undefined ? 'Builder' : text(label, '--label'), ...(k ? { kind: k } : {}), ...(claude ? { model: claude } : {}), started: now,
    ...(eta === undefined ? {} : { eta: isoTime(eta, '--eta') }), ...(dispatch ? { dispatched: dispatch } : {}),
    ...(resumed ? { calls: resumed.calls, ...(resumed.verified ? { verified: resumed.verified } : {}) } : {}),
    // docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md: a lander's record keeps the verification
    // it lands, so a lander that stops partway hands the card back still verified (relaunchLander).
    ...(!resumed && label === LANDER && before?.verified ? { verified: before.verified } : {}),
    ...(launchedSession(before) ? { session: before.session } : {}),
    // A planner's or visual agent's record keeps the brief the board launched it from (startPlanner, startVisual).
    ...((brief ?? takeUp?.brief) && plans({ kind: k }) ? { brief: brief ?? takeUp.brief } : {}),
    // A reviewer's record keeps what it reviews, diff or plan (startReviewer).
    ...((target ?? takeUp?.target) && k === REVIEWER ? { target: target ?? takeUp.target } : {}),
    // A helper's record keeps what agent launch asked of it.
    ...(k === HELPER && before?.kind === HELPER ? { label: before.label, task: before.task, writes: before.writes, requested: before.requested } : {}),
  };
  const marked = marking ? await setItem(site, key, { start: true }) : { lines: [] };
  let wt;
  let remade = null;
  // A build started again on the card keeps the worktree its last record left, while that is still there.
  // So does one kept on the item file entry, which no record keeps.
  const left = ownWorktree && build && agent === 'main' ? [before?.worktree, was?.worktree].find((w) => w?.path && existsSync(w.path)) ?? null : null;
  const kept = (takeUp ?? resumed)?.worktree ?? left;
  const make = worktree ?? (build && agent === 'main' && !kept ? ownWorktree : undefined);
  try {
    if (make) {
      const others = await builderFiles(path.dirname(path.dirname(file)), parseKey(key).id);
      const busy = (await Promise.all(others.filter((f) => f !== file).map((f) => readJSON(f, null)))).filter((r) => r?.worktree?.path && !r.done).map((r) => r.worktree.path);
      ({ remade, ...wt } = await make({ busy }));
    } else wt = kept;
  } catch (e) {
    // A worktree that can't be made leaves the card unstarted, as it was.
    if (marking) await restoreLane(site, key, was);
    throw e;
  }
  await keepPastRun(file, before);
  await writeJSON(file, wt ? { ...record, worktree: wt } : record);
  // docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md: any other main build, not the
  // rebase run nor the lander of its hand-back, ends the card's rebase run, so its push isn't counted as one.
  if (was?.rebase_run && agent === 'main' && ![REBASE_LABEL, LANDER].includes(record.label)) await endRebaseRun(site, key);
  // docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md: the pick a build
  // started on, with what it read; a start taking up a dispatched record reuses the pick its dispatch recorded.
  if (pick?.inputs && site) {
    audit(boardAudit(site), { call: 'builder-pick', key, result: [k, k === 'claude' ? claude : null].filter(Boolean).join(' '), reason: pick.reason,
      inputs: { ...pick.inputs, ...(askedModel ? { askedModel } : {}), ...(dispatch ? { dispatch } : {}) } });
  }
  if (remade && site) await appendStatus(site, key, 'worktree-remade');
  if (line) await statusToThread(site, key, agent, record, line, now);
  const resolved = beside({ kind: given }) || given === HELPER ? [] : await resolveAnswered(site, key, 'Acted on: builder started');
  if (site && build) await clearNext(site, key);
  return {
    file, kind: k ?? null, model: claude ?? null, reason: pick?.reason ?? null, worktree: wt?.path ?? null,
    lines: [...(asked === 'build' ? [`kind: ${k}. ${pick.reason}`] : []), ...(modelName(record) ? [`model: ${modelName(record)}`] : []), ...(site ? [`ref: ${await cardName(site, key)}`] : []), ...(wt ? [`worktree: ${wt.path}`] : []), ...(remade ? [remade] : []), ...marked.lines, ...resolved],
  };
}

// docs/adr/2026-11-07-2100-a-cards-past-runs-keep-their-records-so-they-fold.md
// A start over a finished main record keeps that run beside it as agents/<id>@past-<started ms>.json, so the thread still
// folds its lines into a section. The copy holds the run's label, kind, model, times, log and summary, so its Builder
// message stays in the thread (docs/adr/2026-11-16-0830-a-builder-hands-back-with-a-summary-message.md), never its
// calls, worktree or hand-back, which belong to the open record.
async function keepPastRun(file, before) {
  if (!before?.started || !before.done || !file.endsWith('.json') || path.basename(file).includes('@')) return;
  const { label, kind, model, started, done, session, summary } = before;
  const past = path.join(path.dirname(file), `${path.basename(file, '.json')}@past-${Date.parse(started)}.json`);
  await writeJSON(past, { label, ...(kind ? { kind } : {}), ...(model ? { model } : {}), started, done, ...(session?.log ? { session: { log: session.log } } : {}), ...(summary ? { summary } : {}) });
}

// The owner's Build tap, in the board server: it refuses what a build's builder start refuses, in the owner's words,
// else starts the build as `builder start --kind build --worktree` does, with the record marked dispatched: 'tap', so the
// card is In Progress reading "starting" until its builder's first status line. A refusal is a status line
// of kind BUILD_REFUSED, which the Todo card shows while it is the card's newest line. worktree makes the worktree, as
// builder start's does (board/worktree.mjs boardWorktree). → {key, ref, kind, reason, worktree}, or null when refused
// (docs/adr/2026-11-03-0219-a-build-tap-starts-the-build-in-the-board-server.md).
// A card an unfinished dep blocks is bumped instead, with no record and no worktree (bumpBlocked), and so is a tap with
// every implementer slot taken (full, domain.mjs pullOf), for the pull to take first once one frees. → {key, ref, bumped:
// [what it waits on], line} (docs/adr/2026-11-05-0802-todo-has-no-queue.md,
// docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md).
// dispatch 'hub' is a pull the board server starts itself, or a resume on a card already In Progress.
export async function startTappedBuild(site, key, worktree, dispatch = 'tap', { full = false } = {}) {
  try {
    const { held, blockers } = await tapRefusals(site, key);
    if (held) await recordOwnerTap(site, 'card-hold', { key, hold: false });
    if (blockers.length) return await bumpBlocked(site, key, blockers);
    if (full) return await bumpBlocked(site, key, ['a free implementer slot']);
    try {
      const started = await startBuilder(site, key, { kind: 'build', worktree, dispatch });
      return { key, ref: await cardName(site, key), kind: started.kind, ...(started.model ? { model: started.model } : {}), reason: started.reason, worktree: started.worktree };
    } catch (e) {
      if (held) await restoreHold(site, key, held);
      throw e;
    }
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    await appendStatus(site, key, BUILD_REFUSED, { why: e.message, brief: e.brief });
    return null;
  }
}

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
// The board server's rebase run on a card whose open PR conflicts ({pr, conflict}, domain.mjs rebasesDue): the card's
// main builder record opens dispatched 'hub' and labelled Rebase, in the worktree its last build kept, else the one
// worktree makes from the PR's branch, and the card records rebase_run {pr, base, conflict, at} until the run's push
// (recordRebase). → {key, kind, model, worktree}, as startTappedBuild's
export async function startRebase(site, key, { pr, conflict, base }, worktree) {
  const { source, itemFile, item } = await loadItem(site, key);
  item.rebase_run = { pr, base, conflict, at: new Date().toISOString() };
  await writeJSON(source.file, itemFile);
  try {
    const started = await startBuilder(site, key, { kind: 'build', label: REBASE_LABEL, dispatch: 'hub', ownWorktree: worktree });
    return { key, kind: started.kind, ...(started.model ? { model: started.model } : {}), worktree: started.worktree };
  } catch (e) {
    await endRebaseRun(site, key);
    throw e;
  }
}
// The label a rebase run's builder record carries.
export const REBASE_LABEL = 'Rebase';
async function endRebaseRun(site, key) {
  const { source, itemFile, item } = await loadItem(site, key);
  delete item.rebase_run;
  await writeJSON(source.file, itemFile);
}
// The number of the card's PR in its board's repo, which a finish pushes to instead of opening one, or null.
export async function cardPR(site, key) {
  const { itemFile, item } = await loadItem(site, key);
  const repo = boardRepoOf(site, itemFile);
  return cardPRs(item, repo).find((p) => p.repo === repo)?.number ?? null;
}
// A push to the card's open PR: from a rebase run (rebase_run), recorded in rebased [{from, to, base, replayed, at}], the
// commits the run pushed, replayed when the push only replayed the PR's commits onto the base (finish.mjs), which
// mergeCard then counts as trivial after an approval. → whether it was a rebase run's
export async function recordRebase(site, key, { from, to, replayed }) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (!item.rebase_run) return false;
  item.rebased = [...(item.rebased || []), { from, to, base: item.rebase_run.base, replayed, at: new Date().toISOString() }];
  delete item.rebase_run;
  await writeJSON(source.file, itemFile);
  return true;
}
// Whether the card's rebase-only pushes lead from the approved commit to head, so only the board's rebases came after it.
// A run's push that added commits of its own breaks the chain.
const onlyRebased = (item, approved, head) => {
  const steps = new Map((item.rebased || []).filter((r) => r.replayed).map((r) => [r.to, r.from]));
  for (let at = head, seen = 0; at && seen <= steps.size; at = steps.get(at), seen++) if (at === approved) return true;
  return false;
};

// The refusals of a build's start that the owner can act on, worded for the card; startBuilder still makes every check.
// A card the owner blocked that hasn't started is no refusal: the tap leaves the block (docs/adr/2026-11-16-1030-implement-stages-a-blocked-card-and-keeps-the-block.md),
// and nor is a blocked one: the tap bumps it (docs/adr/2026-11-05-0802-todo-has-no-queue.md).
// → {held: the owner's block as stored, or null, blockers: the names of its unfinished deps and its blocked-until condition (blockerNames)}.
async function tapRefusals(site, key) {
  const gate = readUsageGate({ dir: site });
  if (holdsWork(gate)) fail(pauseReason(gate));
  const { item } = await loadItem(site, key);
  const held = item.held ? { held: item.held, pick_up_at: item.pick_up_at, held_at: item.held_at } : null;
  if (held && leftTodo(item)) fail("it's blocked. Unblock it, then tap Implement.");
  if (await unpickedPrototype(site, key)) fail('no take is picked on its prototypes, so it prototypes again. Pick a take from the next round, then tap Implement.');
  return { held, blockers: await blockerNames(site, key, item) };
}

// docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md
// A bare Implement, in the board server with no event: the card staged as an Implement with text stages it
// (stageImplement), for the orchestrator's review before it goes ready. "Marked as staged" is the thread's whole
// answer to the tap (docs/adr/2026-11-12-1100-an-implement-tap-reads-only-marked-as-staging.md).
export async function implementAsIs(site, key, sendId) {
  return stageImplement(site, key, { sendId });
}

// docs/adr/2026-11-05-0802-todo-has-no-queue.md
// An Implement on a card that can't start while blockers (their names) are unfinished: the card is bumped to the top of
// Todo (card-bump), where the pull takes it once nothing blocks it, and its thread says so. → {key, ref, bumped, line}.
async function bumpBlocked(site, key, blockers) {
  const names = blockers.join(', ');
  await appendEvent({ dir: site }, 'card-bump', { key });
  await appendStatus(site, key, 'cant-start-yet', { names });
  return { key, ref: await cardName(site, key), bumped: blockers, line: `bumped: ${key} waits on ${names}, so it stays in Todo, bumped to the top` };
}

// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
// A card pause rides on the card's open main build record as pause {cause, words, at, by?, until?, paused?, phase?}:
// cause blocked, held, usage or bumped (domain.mjs PAUSE_CLEARS), words what the card reads after "pausing · "
// ("blocked by #61"), by the card a bump-out made room for, until the reset of the usage limit that stopped the run.
// The builder's next progress report, call or ask is its stopping point (builderReply): the record reads paused at its
// phase, and the reply tells it to commit and stop. The board server resumes it once nothing pauses it (server.mjs).
async function openBuild(site, key) {
  const file = await builderFile(site, key);
  const record = await readJSON(file, null);
  return record?.started && !record.done && builds(record) ? { file, record } : null;
}

// Asks the card's running build to pause for cause; one already pausing keeps its first cause. → whether it asked
export async function requestPause(site, key, { cause, words, by, until }) {
  const open = await openBuild(site, key);
  if (!open || open.record.pause) return false;
  await writeJSON(open.file, { ...open.record, pause: { cause, words, at: new Date().toISOString(), ...(by ? { by } : {}), ...(until ? { until } : {}) } });
  return true;
}

// Marks the card's pausing build paused at the newest phase its build reported, with the thread line saying so.
// → its pause, or null when none was asked
export async function markPaused(site, key) {
  const open = await openBuild(site, key);
  const pause = open?.record.pause;
  if (!pause || pause.paused) return pause ?? null;
  const at = new Date().toISOString();
  const phase = (await readLog(threadFile(site, key))).filter((m) => m.kind === 'status' && m.phase && !m.planner && String(m.ts) >= String(open.record.started)).pop()?.phase;
  const paused = { ...pause, paused: at, ...(phase ? { phase } : {}) };
  await writeJSON(open.file, { ...open.record, pause: paused });
  await appendStatus(site, key, 'paused', { phase, words: pause.words, clear: PAUSE_CLEARS[pause.cause][0] });
  return paused;
}

// What the board says to the card's main builder after its own command (progress, call, ask, asks --wait): the news
// waiting for it (takeNews), then, at a stopping point it reached while a pause was asked, the reply that stops it, its
// record marked paused (markPaused). → its lines, none while neither waits
async function builderReply(site, key, { dir, agent = 'main' }) {
  if (!site || dir || agent !== 'main') return [];
  const news = await takeNews(site, key);
  const pause = await markPaused(site, key);
  return [...news, ...(pause ? [`Paused: ${pause.words}. Commit what you have now with \`git -c core.commentChar=';' commit -F <file>\`, then stop: end your turn and run nothing else. The board resumes this session, telling it so, once the pause clears.`] : [])];
}

// docs/adr/2026-11-16-0007-builder-resume-updates-a-running-builder-or-resumes-a-handed-back-one.md
// News is what reached a card In Progress for its builder after the build started: the orchestrator's builder resume,
// the owner's thread message, a notes section added. It waits on the card's main build record, running or handed back,
// as news [{at, from: orchestrator|owner|notes, text}], until it reaches the builder: a running one at its next command
// (builderReply), its PostToolUse hook (hooks-plugin board-messages.mjs, through data/builder-news/<session id>.json,
// which names the card), or the refusal of its builder done; a handed-back one in the brief it is resumed with (takeRerun).
const NEWS_FROM = { orchestrator: 'the orchestrator wrote: ', owner: 'the owner wrote: ', notes: 'its notes gained ' };
const newsPointer = (site, session) => path.join(site, 'data', 'builder-news', `${session}.json`);
const newsLines = (key, news) => [...news.map((n) => `New on ${key} while you build: ${NEWS_FROM[n.from]}${n.text}`),
  'Take it in before you hand back: build to it, and where it contradicts your notes, ask with builder ask.'];

// The card's main build record news reaches: one running, or one handed back. → {file, record} or null
async function newsBuild(site, key) {
  const { item } = await loadItem(site, key);
  if (item.lane !== 'progress') return null;
  const file = await builderFile(site, key);
  const record = await readJSON(file, null);
  return record?.started && builds(record) && (!record.done || record.handed_back) ? { file, record } : null;
}

// Adds news for the card's builder, when it has a running or handed-back build. → whether it did
export async function passNews(site, key, { from, text: said }) {
  const build = await newsBuild(site, key);
  if (!build) return false;
  const { file, record } = build;
  await writeJSON(file, { ...record, news: [...(record.news || []), { at: new Date().toISOString(), from, text: said }] });
  if (!record.done && record.session?.id) await writeJSON(newsPointer(site, record.session.id), { key });
  return true;
}

// The news waiting for the card's running build, taken off its record. → its lines, none while none waits
export async function takeNews(site, key) {
  const open = await openBuild(site, key);
  if (!open?.record.news) return [];
  const { news, ...rest } = open.record;
  await writeJSON(open.file, rest);
  if (rest.session?.id) await remove(newsPointer(site, rest.session.id));
  return newsLines(key, news);
}

// builder done refuses the main build while news waits for it, the refusal delivering it.
export async function refuseNews(site, key) {
  const lines = await takeNews(site, key);
  if (lines.length) fail(`${lines.join('\n')}\nRun builder done again once your build takes it in.`);
}

// `builder resume <key> --text <t>`, the orchestrator's: on a running build the text is news for it, with a thread line
// saying so; on a handed-back build it is news too, and the record is marked rerun {at, text} for the board server to
// resume the builder's own session with it (takeRerun). → {running}
export async function builderResume(site, key, said) {
  needSite(site);
  const words = text(said, '--text');
  const { item } = await loadItem(site, key);
  const name = await cardName(site, key);
  if (item.lane !== 'progress') fail(`builder resume takes a task In Progress; ${name} is in ${item.lane ?? 'todo'}`);
  const build = await newsBuild(site, key);
  if (!build) fail(`${name} has no running or handed-back build to resume`);
  const { file, record } = build;
  if (!record.done) {
    await passNews(site, key, { from: 'orchestrator', text: words });
    await appendStatus(site, key, 'builder-told', { text: words });
    return { running: true };
  }
  if (providerOf(record.kind ?? 'claude') !== 'claude' || !record.session?.id) fail(`${name}'s build has no Claude session the board launched to resume; start a new build instead`);
  if (record.rerun) fail(`${name} already waits on the board to resume its builder`);
  await passNews(site, key, { from: 'orchestrator', text: words });
  await writeJSON(file, { ...(await readJSON(file, null)), rerun: { at: new Date().toISOString(), text: words } });
  return { running: false };
}

// The board server's take of a handed-back build marked rerun: the record opens again, its hand-back, rerun mark and
// news off it, the card's Next cleared, and a "Resumed: <text>" line. → {record: the record it now is, news: the news's
// lines for the resume's brief}, or null when no build is marked
export async function takeRerun(site, key) {
  const build = await newsBuild(site, key);
  if (!build?.record.rerun) return null;
  const { file, record: { done, handed_back, rerun, news = [], ...rest } } = build;
  await writeJSON(file, rest);
  await clearNext(site, key);
  await appendStatus(site, key, 'builder-rerun', { text: rerun.text });
  return { record: rest, news: newsLines(key, news) };
}

// The card's paused build resumes: its pause comes off its record, and the thread says why. → {pause: the pause it had,
// record: the record it now is}, or null when it isn't paused
export async function resumePaused(site, key) {
  const open = await openBuild(site, key);
  const pause = open?.record.pause;
  if (!pause?.paused) return null;
  const { pause: _, ...rest } = open.record;
  await writeJSON(open.file, rest);
  await appendStatus(site, key, 'resumed', { clear: PAUSE_CLEARS[pause.cause][1] });
  return { pause, record: rest };
}

// A pause whose cause cleared before its builder stopped comes off its record with no line: the build never stopped.
export async function dropPause(site, key) {
  const open = await openBuild(site, key);
  if (!open?.record.pause || open.record.pause.paused) return;
  const { pause: _, ...rest } = open.record;
  await writeJSON(open.file, rest);
}

// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
// A build the board server started whose agent couldn't launch goes back to Todo: its open main record closes, the card
// goes back to Todo with no move line, and the thread says why, as a refusal the Todo card shows.
export async function abandonLaunch(site, key, why) {
  const file = await builderFile(site, key);
  const record = await readJSON(file, null);
  const now = new Date().toISOString();
  if (record && !record.done) await writeJSON(file, { ...record, done: now });
  const { source, itemFile, item } = await loadItem(site, key);
  if (item.lane === 'progress') placeIn(item, 'todo', now);
  await writeJSON(source.file, itemFile);
  await appendStatus(site, key, BUILD_REFUSED, { why });
}

// A planner the board server opened whose agent couldn't launch: its record, the agent's, closes and the thread says why.
// kind and inputs are its status line's (hub-lines.mjs).
export async function abandonPlanner(site, key, [kind, inputs], agent = 'main') {
  const file = await builderFile(site, key, undefined, agent);
  const record = await readJSON(file, null);
  if (record && !record.done) await writeJSON(file, { ...record, done: new Date().toISOString() });
  await publishStaged(site, key);
  await appendStatus(site, key, kind, inputs);
}

// docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md
// The session id of the agent the board server just launched on a card (headless.mjs launchBuilder), on its builder
// record, the main one unless agent names another, as session {id, pid, log: the log file's name, at}. The agent's own builder start keeps it (launchedSession).
export async function recordSession(site, key, id, pid, agent = 'main', log = null) {
  const file = await builderFile(site, key, undefined, agent);
  const record = await readJSON(file, null);
  await writeJSON(file, { ...record, session: { id, pid, log, at: new Date().toISOString() } });
}

// The card's open builder records, each as {pid, at}: the process the board server launched (null for an agent a
// session started itself) and when its session was recorded. Read before a tap closes them.
export async function openAgents(site, key) {
  const { source } = await loadItem(site, key);
  const records = await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)));
  return records.filter((r) => r && r.started && !r.done).map((r) => ({ pid: r.session?.pid ?? null, at: r.session?.at ?? null }));
}

// docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md
// The card's open builder records, each {kind, pid, at} as openAgents reads them.
export async function openRuns(site, key) {
  const { source } = await loadItem(site, key);
  const records = await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)));
  return records.filter((r) => r && r.started && !r.done).map((r) => ({ kind: r.kind ?? null, pid: r.session?.pid ?? null, at: r.session?.at ?? null }));
}
// The orchestrator's stop of the card's run (build, land), on each open build record as stopped {run, at}: the card
// reads the stop's words, and the server relaunches neither its builder nor its lander.
export async function markStopped(site, key, run) {
  const { source } = await loadItem(site, key);
  const at = new Date().toISOString();
  for (const file of await builderFiles(source.dir, parseKey(key).id)) {
    const record = await readJSON(file, null);
    if (record?.started && !record.done && builds(record)) await writeJSON(file, { ...record, stopped: { run, at } });
  }
}
// The orchestrator's stop of the land a held card's Merge tap started: merge_ready.stopped, read until the next tap.
export async function stopHeldMerge(site, key) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (!item.merge_ready) return;
  item.merge_ready.stopped = new Date().toISOString();
  await writeJSON(source.file, itemFile);
}
// docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md
// The orchestrator's stall of a card (item stall): stalled {reason, at} on its item file entry, which the card reads as red
// stalled and an Action needed until a message on the card clears it (clearStall). → the reason
export async function markStalled(site, key, reason) {
  const words = text(reason, 'item stall --reason');
  const { source, itemFile, item } = await loadItem(site, key);
  if (item.lane === 'done') fail(`${await cardName(site, key)} is done; there is nothing to stall`);
  item.stalled = { reason: words, at: new Date().toISOString() };
  await writeJSON(source.file, itemFile);
  return words;
}
// A message on a stalled card clears its stall, so the card reads as it is and the message reaches the orchestrator.
export async function clearStall(site, key) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (!item.stalled) return;
  delete item.stalled;
  await writeJSON(source.file, itemFile);
}
// The bump the card's land queues with: its latest card-bump when no card-unbump came after it and it was made after
// the card last closed, Done or merged, as the board reads a bump (domain.mjs workItem), else null.
export async function landFirst(site, key) {
  const { item } = await loadItem(site, key);
  const events = await readLog(path.join(site, 'data', 'events.jsonl'));
  const latest = (kind) => events.filter((e) => e.kind === kind && e.data?.key === key).map((e) => String(e.ts)).sort().pop() || '';
  const bump = latest('card-bump');
  if (!bump || latest('card-unbump') > bump) return null;
  const closedAt = [item.closed_at, ...storedPRs(item).map((p) => p.merged_at)].filter(Boolean).map(String).sort().pop() || '';
  return bump > closedAt ? bump : null;
}
// The orchestrator's bump (on) or unbump of a card, the event the owner's bump icon sends. → the event's time
export async function bumpCard(site, key, on) {
  const { item } = await loadItem(site, key);
  if (closed(item)) fail(`${await cardName(site, key)} is done; there is nothing to bump`);
  const id = await appendEvent({ dir: site }, on ? 'card-bump' : 'card-unbump', { key });
  return (await readLog(path.join(site, 'data', 'events.jsonl'))).find((e) => e.id === id).ts;
}

// Whether the card's latest status line is the finish step's landing line.
export async function isLanding(site, key) {
  return (await readLog(threadFile(site, key))).filter((m) => m.kind === 'status').pop()?.phase === 'landing';
}
// A record's session belongs to the agent now starting on it when a launch wrote it since the record last started or closed.
const launchedSession = (record) => Boolean(record?.session) && record.session.at > (record.done ?? record.started);

// The board server's start of a planner, kind grill or prototype, on a card: the main record opens, dispatched: 'hub',
// as builder start --kind <kind> does, from the card's oldest written brief of that kind, which moves onto the record
// (brief, the card's briefs entry: the record is written once with it, then the card drops it), or from kept, the entry a run the Block stopped had. A card with neither is refused
// (docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md).
// → {key, kind, model, brief, ...a grill's ask, or a prototype's asks}, or null while an agent already works on the
// card's main record. A prototype entry written before entries kept asks has its one ask as asks.
export async function startPlanner(site, key, kind, kept = null) {
  const file = await builderFile(site, key);
  const open = await readJSON(file, null);
  if (open && !open.done) return null;
  if (!kept && !(await briefOn(site, key, kind))) await noBrief(site, key, kind);
  const entry = kept ?? await briefOn(site, key, kind);
  const started = await startBuilder(site, key, { kind, dispatch: 'hub', brief: entry });
  if (!kept) await dropBrief(site, key, kind);
  const asked = kind === 'prototype' ? { asks: entry.asks ?? (entry.ask ? [entry.ask] : []) } : entry.ask;
  return { key, kind, model: started.model, brief: entry.brief, ...asked };
}

// docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
// docs/adr/2026-11-16-2300-review-in-a-thread-launches-a-reviewer.md
// The board server's start of the visual agent or reviewer (kind) for the card's oldest written brief of that kind
// (domain.mjs briefsDue): its own record, agent <kind>-<the brief's time in ms>, opens dispatched 'hub' beside any other
// agent on the card, and the brief moves onto it. A reviewer reviews the diff while the card's newest worktree is on
// disk, else the plan, and its record keeps which as target. → {key, kind, model, agent, brief, target?, ...its ask}, or
// null while one of its kind runs on the card; a card with no brief of the kind is refused.
async function startBeside(site, key, kind) {
  const { source } = await loadItem(site, key);
  const records = await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)));
  if (records.some((r) => r?.kind === kind && r.started && !r.done)) return null;
  const waiting = await briefOn(site, key, kind) ?? await noBrief(site, key, kind);
  const agent = besideAgent(kind, waiting.brief);
  const worktree = records.filter((r) => r?.worktree?.path).sort((a, b) => String(a.started || '').localeCompare(String(b.started || ''))).at(-1)?.worktree.path;
  const target = kind === REVIEWER ? (worktree && existsSync(worktree) ? 'diff' : 'plan') : undefined;
  const started = await startBuilder(site, key, { kind, agent, dispatch: 'hub', brief: waiting, target });
  await dropBrief(site, key, kind);
  return { key, kind, model: started.model, agent, brief: waiting.brief, ...(target ? { target } : {}), ...waiting.ask };
}
export const startVisual = (site, key) => startBeside(site, key, VISUAL);
export const startReviewer = (site, key) => startBeside(site, key, REVIEWER);

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// A helper's name: lowercase words joined by "-", never main nor a visual agent's or reviewer's.
const helperName = (name) => (typeof name === 'string' && /^[a-z][a-z0-9-]{0,29}$/.test(name) && name !== 'main' && !name.startsWith(`${VISUAL}-`) && !name.startsWith(`${REVIEWER}-`) ? name
  : fail('--name takes a short lowercase name such as tests or docs-pass: letters, digits and "-", not main, visual-… or reviewer-…'));
// The worktree the card's build works in, its main record's, else the one the card got on entering In Progress, while
// it is on disk; null when it has none.
async function cardWorktree(site, key) {
  const { item } = await loadItem(site, key);
  const main = await readJSON(await builderFile(site, key), null);
  return [main?.worktree, item.worktree].find((w) => w?.path && existsSync(w.path)) ?? null;
}

// A --model the Claude model that builds on the board rules out, its own Builders choice or else the hub's
// (usage-gate.mjs claudeModelFor), is refused while that choice is Opus or Sonnet.
function refuseUnforced(site, model) {
  const forced = claudeModelFor({ dir: site });
  if (model === undefined || forced === 'auto' || model === forced) return;
  fail(`--model ${model}: ${boardClaudeModel(site) ? "this board's" : "the hub's"} Claude model is ${forced === 'opus' ? 'Opus' : 'Sonnet'}. Pass --model ${forced}, or no --model.`);
}

// `agent launch <file/id> --name <n> --task <t> [--writes] [--model opus|sonnet]`: any session asks for a helper on an
// open card, which the board server launches headless (server.mjs launchHelpers) at once, on its card's implementer
// slot (docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md). Its record,
// agents/<id>@<name>.json, opens requested: {kind: helper, label: name, task, writes, model?, requested}, with no
// start until the server's. --model is a Claude model, refused when the hub's Claude model rules it out; without one
// the server takes builder pick's, as a build does. A helper that writes needs the card's worktree, since its own
// branches from the card's branch. → {lines}
export async function requestHelper(site, key, { name, task, writes, model }) {
  needSite(site);
  const agent = helperName(name);
  const job = text(task, '--task');
  if (model !== undefined && !['opus', 'sonnet'].includes(model)) fail('--model takes opus or sonnet');
  refuseUnforced(site, model);
  const { item } = await loadItem(site, key);
  if (closed(item)) fail(`${await cardName(site, key)} is Done; a helper needs an open task`);
  const file = await builderFile(site, key, undefined, agent);
  if (existsSync(file)) fail(`${key} already has an agent named ${agent}; pick another --name`);
  if (writes && !(await cardWorktree(site, key))) fail(`a helper that writes branches from ${key}'s worktree, and the task has none; start its build first, or drop --writes`);
  await writeJSON(file, { label: agent, kind: HELPER, task: job, writes: Boolean(writes), ...(model ? { model } : {}), requested: new Date().toISOString() });
  await appendStatus(site, key, 'helper-asked', { agent, writes });
  return { lines: [`helper ${agent} requested: the board launches it now`, `wait for it with agent wait ${key} --name ${agent}`] };
}

// The board server's start of helper name on the card, which domain.mjs pullOf let launch: its record opens dispatched
// 'hub' on builder pick's Claude model unless agent launch gave one, and one that writes gets its own worktree, made by
// make({repo, base, busy}) from the card's worktree's branch (board/worktree.mjs makeWorktree). → {key, kind, model,
// agent, task, writes, worktree}, worktree the helper's own path or null, or null when the record is no longer a
// requested helper.
export async function startHelper(site, key, name, make) {
  const file = await builderFile(site, key, undefined, name);
  const asked = await readJSON(file, null);
  if (asked?.kind !== HELPER || asked.started || asked.done) return null;
  const { item } = await loadItem(site, key);
  const pick = builderPick({ card: item, dir: site });
  const forced = claudeModelFor({ dir: site });
  const model = asked.model ?? (forced !== 'auto' ? forced : pick.kind === 'claude' ? pick.model : 'opus');
  const tree = asked.writes ? await cardWorktree(site, key) : null;
  if (asked.writes && !tree) fail(`${key} has no worktree for helper ${name} to branch from`);
  await writeJSON(file, { ...asked, model });
  const started = await startBuilder(site, key, { agent: name, kind: HELPER, dispatch: 'hub', worktree: tree ? ({ busy }) => make({ repo: tree.repo, base: tree.branch, busy }) : undefined });
  return { key, kind: HELPER, model, agent: name, task: asked.task, writes: asked.writes, worktree: started.worktree };
}

// What a helper's spawner reads of it: {record, card} with card the card's worktree (cardWorktree), refusing a name
// that is no helper on the card.
export async function helperOf(site, key, name) {
  const record = await readJSON(await builderFile(site, key, undefined, helperName(name)), null);
  if (record?.kind !== HELPER) fail(`${key} has no helper named ${name}`);
  return { record, card: await cardWorktree(site, key) };
}

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// `agent wait <file/id> --name <n> [--agent <spawner>] [--timeout <minutes>]`: blocks until helper name is done, then
// prints its hand-back, and for one that writes its branch to merge. While it waits, the spawner's open record carries
// waits: name, so the spawner doesn't count as running (domain.mjs pullOf idle). It
// gives up after timeout minutes (9, under a Bash tool call's 10), saying what the helper is doing, and refuses once
// the helper's process has gone without its done. alive(pid) says whether a process runs. It polls every ms, its
// deadline read off now(). → {lines}
export async function waitHelper(site, key, { name, agent = 'main', timeout = 9, every = 2000, now = Date.now, alive }) {
  needSite(site);
  const minutes = Number(timeout);
  if (!(minutes > 0)) fail('--timeout takes minutes, a number above 0');
  const helperFile = await builderFile(site, key, undefined, helperName(name));
  const spawnerFile = await builderFile(site, key, undefined, agent);
  const mark = async (waits) => {
    const spawner = await readJSON(spawnerFile, null);
    if (!spawner?.started || spawner.done) return;
    const { waits: _, ...rest } = spawner;
    await writeJSON(spawnerFile, waits ? { ...rest, waits } : rest);
  };
  const deadline = now() + minutes * 60_000;
  await mark(name);
  try {
    for (;;) {
      const helper = await readJSON(helperFile, null);
      if (helper?.kind !== HELPER) fail(`${key} has no helper named ${name}`);
      if (helper.done) {
        const tree = helper.writes && helper.worktree ? [`branch ${helper.worktree.branch} in ${helper.worktree.path}: merge it with agent merge ${key} --name ${name}`] : [];
        return { lines: [`helper ${name} done: ${helper.note ?? 'no hand-back'}`, ...tree] };
      }
      // A helper's name is never reused, so the session on its record is its own launch's.
      const pid = helper.session?.pid ?? null;
      if (pid && !alive(pid)) fail(`helper ${name}'s process exited without builder done; do its task yourself`);
      if (now() >= deadline) fail(`helper ${name} is still ${helper.started ? 'running' : 'waiting to launch'} after ${minutes} minutes; run agent wait again`);
      await new Promise((resolve) => setTimeout(resolve, every));
    }
  } finally {
    await mark(null);
  }
}

// Whether agent's open record on the card is a helper, whose builder done hands back its --text.
export async function isHelper(site, key, agent = 'main') {
  if (agent === 'main') return false;
  return (await readJSON(await builderFile(site, key, undefined, agent), null))?.kind === HELPER;
}

// Whether agent's open record on the card is a planner's run (domain.mjs plans), whose builder done writes its --text as
// the run's closing thread line.
export async function isPlanner(site, key, agent = 'main') {
  const record = await readJSON(await builderFile(site, key, undefined, agent), null);
  return Boolean(record?.started && !record.done && plans(record));
}

// `visual add <file/id> --file <html> --title <t>`: the visual agent's page, copied to the site's
// public/visuals/<card id>/<slug of title>.html, a new name each time, and a visual line in the card's thread linking it.
// → {lines: [the page's site-relative link]}
export async function addVisual(site, key, { file, title }) {
  needSite(site);
  const name = text(title, '--title');
  if (typeof file !== 'string' || !file.endsWith('.html')) fail('--file takes the page, an .html file');
  const html = await fs.readFile(path.resolve(file), 'utf8').catch(() => fail(`--file ${file} can't be read`));
  if (!html.trim()) fail(`--file ${file} is empty`);
  await loadItem(site, key);
  const { id } = parseKey(key);
  const dir = path.join(site, 'public', 'visuals', id);
  await fs.mkdir(dir, { recursive: true });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '') || 'visual';
  let page = `${slug}.html`;
  for (let n = 2; existsSync(path.join(dir, page)); n++) page = `${slug}-${n}.html`;
  await fs.writeFile(path.join(dir, page), html, { flag: 'wx' });
  const link = `visuals/${id}/${page}`;
  await appendLine(threadFile(site, key), { ts: new Date().toISOString(), who: 'claude', kind: VISUAL, text: text(name, '--name'), link: pageUrl(link, '--link') });
  return { lines: [link] };
}

// docs/adr/2026-11-16-2300-review-in-a-thread-launches-a-reviewer.md
// `reviewer post <file/id> --file <findings.json>`: the reviewer's findings, a JSON list of {severity: high|medium|low,
// at?: "<file>:<line>", text}, as one Reviewer message in the card's thread, most severe first (a stable sort, so the
// reviewer's order holds within a severity), headed by how many and what it reviewed, its newest reviewer record's target.
const SEVERITIES = ['high', 'medium', 'low'];
function finding(f, n) {
  const name = `finding ${n + 1}`;
  if (!f || typeof f !== 'object' || !SEVERITIES.includes(f.severity)) fail(`${name} needs severity high, medium or low`);
  return { severity: f.severity, ...(f.at === undefined ? {} : { at: text(f.at, `${name}'s at`) }), text: text(f.text, `${name}'s text`) };
}
export async function postFindings(site, key, { file }) {
  needSite(site);
  if (typeof file !== 'string') fail('reviewer post needs --file <findings.json>');
  const raw = await fs.readFile(path.resolve(file), 'utf8').catch(() => fail(`--file ${file} can't be read`));
  let list;
  try { list = JSON.parse(raw); } catch (e) { fail(`--file ${file} isn't JSON: ${e.message}`); }
  if (!Array.isArray(list)) fail(`--file ${file} holds a JSON list of findings: [{"severity": "high", "at": "<file>:<line>", "text": "<one sentence>"}]`);
  const findings = list.map(finding).map((f, i) => [f, i]).sort(([a, i], [b, j]) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || i - j).map(([f]) => f);
  const { source } = await loadItem(site, key);
  const records = await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)));
  const target = records.filter((r) => r?.kind === REVIEWER && r.started).sort((a, b) => String(a.started).localeCompare(String(b.started))).at(-1)?.target || 'plan';
  const n = findings.length;
  const words = n ? `${n} finding${n === 1 ? '' : 's'} on the ${target}${n > 1 ? ', most severe first' : ''}` : `No findings on the ${target}`;
  await appendLine(threadFile(site, key), { ts: new Date().toISOString(), who: REVIEWER, kind: REVIEWER, text: words, findings });
  return { lines: [`${await cardName(site, key)}: ${words}, posted in its thread`] };
}

// docs/adr/2026-11-05-2130-a-restarted-server-launches-the-build-its-pull-left-without-a-builder.md
// The builds the board server started (a pull, a Build tap, a queued start) whose launch it never made: a card not done
// whose main build record is open with dispatched still 'tap' or 'hub', since a builder's own `builder start` clears
// that mark. Those records keep the pick's kind and model and the worktree the start made, which the launch's brief
// names. A session's dispatch ('session') is left alone: the session launches that agent itself
// (docs/adr/2026-11-14-0730-a-board-server-holds-its-port-before-it-launches-anything.md).
// → [{key, kind, model}], launchBuilder's card for each.
export async function cutOffBuilds(site) {
  const out = [];
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    for (const item of itemFile?.items || []) {
      if (closed(item)) continue;
      const record = await readJSON(path.join(source.dir, 'agents', `${item.id}.json`), null);
      if (!record?.started || record.done || !['tap', 'hub'].includes(record.dispatched) || plans(record)) continue;
      out.push({ key: `${source.slug}/${item.id}`, kind: providerOf(record.kind), model: record.model });
    }
  }
  return out;
}

// docs/adr/2026-11-15-1630-a-pulled-card-whose-launch-was-lost-launches-again.md
// The cards In Progress that no build ever started on: open, in the lane since before `since` (ISO time), not held by
// the owner, with no agent record of any kind in their folder. A pull that a restart cut off after it moved the card
// and before it wrote the record leaves one. → [key]
export async function lostLaunches(site, since) {
  const out = [];
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    for (const item of itemFile?.items || []) {
      if (closed(item) || item.lane !== 'progress' || item.held || !(item.lane_at < since)) continue;
      if ((await builderFiles(source.dir, item.id)).length) continue;
      out.push(`${source.slug}/${item.id}`);
    }
  }
  return out;
}

// A tapped build that failed to start puts back the hold the tap cleared.
async function restoreHold(site, key, was) {
  const { source, itemFile, item } = await loadItem(site, key);
  for (const field of Object.keys(was)) if (was[field] === undefined) delete item[field]; else item[field] = was[field];
  await writeJSON(source.file, itemFile);
}

async function restoreLane(site, key, was) {
  const { source, itemFile, item } = await loadItem(site, key);
  for (const field of ['lane', 'lane_at', 'closed_at', 'reopened_at', 'phase']) if (was[field] === undefined) delete item[field]; else item[field] = was[field];
  await writeJSON(source.file, itemFile);
}

// `audit [<file/id>]`: the board's audit log (shared/audit.mjs), only that card's calls when given. → {lines}
export async function auditLog(site, key) {
  if (!site) fail('audit reads a board: pass --site <route>');
  if (key !== undefined) parseKey(key);
  return { lines: auditLines(readAudit(boardAudit(site), { key })) };
}

// A Todo card whose newest line is a refused start gets a line after it, which the pull reads as the refusal cleared
// (docs/adr/2026-11-16-0500-a-refused-start-returns-the-card-to-ready.md). A retitle clears the title refusal too.
async function clearRefusal(site, key) {
  const newest = (await readLog(threadFile(site, key))).filter((m) => !['status', MOVE].includes(m.kind)).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1);
  if (newest?.line === BUILD_REFUSED) await appendStatus(site, key, 'refusal-cleared');
}
const PICKED = ['codex', 'claude'];
// `builder pick`: the kind builder start takes for a card's build. → {lines: ["codex: <reason>" or "claude <opus|sonnet>: <reason>"]}
export async function pickBuilder(site, key) {
  const { item } = await loadItem(site, key);
  if (site && item.lane === 'todo') await clearRefusal(site, key);
  const { kind, model, reason } = builderPick({ card: item, dir: site });
  return { lines: [`${[kind, model].filter(Boolean).join(' ')}: ${reason}`] };
}

// The worktree the item's newest builder record keeps ({path, branch, repo}), or null when none keeps one.
export async function recordedWorktree(site, key, { dir } = {}) {
  const { id } = parseKey(key);
  const agents = path.dirname(await builderFile(site, key, dir));
  const files = await builderFiles(path.dirname(agents), id);
  const records = (await Promise.all(files.map((f) => readJSON(f, null)))).filter((r) => r?.worktree?.path && r.kind !== HELPER);
  return records.sort((a, b) => String(b.started).localeCompare(String(a.started)))[0]?.worktree ?? null;
}

// The card's newest session worth resuming, {id, worktree: the path its record keeps}: the newest builder record with
// both, a past lander's or resumed session's included, so a second land continues the newest one. Null when none has.
export async function recordedSession(site, key) {
  const { source } = await loadItem(site, key);
  const records = (await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)))).filter((r) => r?.session?.id && r.worktree?.path && r.kind !== HELPER);
  const newest = records.sort((a, b) => String(b.started).localeCompare(String(a.started)))[0];
  return newest ? { id: newest.session.id, worktree: newest.worktree.path, log: newest.session.log ?? null } : null;
}

export async function builderProgress(site, key, progress, { phase, dir, agent = 'main', eta, clearEta }) {
  if (eta !== undefined && clearEta) fail('pass --eta or --clear-eta, not both');
  const given = progressLine(site, phase, progress, 'builder progress');
  const file = await builderFile(site, key, dir, agent);
  const record = await readJSON(file, null);
  if (!record?.started || record.done) fail(`builder progress needs an open builder record on ${key}; run builder start first`);
  const line = forAgent(given, plans(record), 'builder progress');
  if (eta !== undefined) record.eta = isoTime(eta, '--eta');
  if (clearEta) delete record.eta;
  if (eta !== undefined || clearEta) await writeJSON(file, record);
  await statusToThread(site, key, agent, record, line, new Date().toISOString());
  return { file, lines: await builderReply(site, key, { dir, agent }) };
}

// The finish step's own landing line, so the card's fifth bar lights while it rebases and lands, whoever finishes it.
export async function landingLine(site, key) {
  const file = threadFile(site, key);
  if ((await readLog(file)).filter((m) => m.kind === 'status').pop()?.phase === 'landing') return;
  await appendLine(file, { ts: new Date().toISOString(), who: 'claude', kind: 'status', phase: 'landing', text: 'Landing: rebasing onto main and landing', run: (await newestBuild(site, key)).started });
}

// A judgment call is one line a builder records as it decides, kept on its record as {at, text}; the session's
// `builder verified` stamps the record verified {at, note}, which covers every call made before it. land refuses while
// any record on the card has a call after its stamp
// (docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md).
const unverifiedCalls = (record) => (record?.calls || []).filter((c) => !record.verified || c.at > record.verified.at);

export async function recordCall(site, key, call, { dir, agent = 'main' }) {
  const words = text(call, 'builder call');
  if (/\n/.test(words)) fail('builder call takes one line; record each call on its own');
  const file = await builderFile(site, key, dir, agent);
  const record = await readJSON(file, null);
  if (!record?.started || record.done) fail(`builder call needs an open builder record on ${key}; run builder start first`);
  await writeJSON(file, { ...record, calls: [...(record.calls || []), { at: new Date().toISOString(), text: words }] });
  return { file, lines: await builderReply(site, key, { dir, agent }) };
}

// docs/adr/2026-11-04-0247-a-builder-asks-the-orchestrator-mid-build.md
// A builder asks the orchestrator mid-build and carries on: the ask is a thread line {kind: builder-ask, ask: ask<n>,
// agent} written as "<model> builder", and a builder-ask {key, ask, agent, text} event wakes the board's session. The
// session's answer or deferral is a line {kind: builder-answer, ask, deferred?} written as claude, which the thread names
// Orchestrator; neither line is unread, pushed or answers the owner, so the card stays quiet. A deferral is also a
// "Question: …" call on the asking agent's record, so the build hands back for it, and the session's review puts it to
// the owner as a question naming the ask ("ask": "ask<n>") before `builder verified`.
// → [{id, agent, text, at, answer: {text, at} | null, deferred}], oldest first.
async function builderAsks(site, key) {
  const thread = await readLog(threadFile(site, key));
  const replies = new Map(thread.filter((m) => m.kind === BUILDER_ASK.answer).map((m) => [m.ask, m]));
  return thread.filter((m) => m.kind === BUILDER_ASK.ask).map((m) => {
    const reply = replies.get(m.ask);
    return { id: m.ask, agent: m.agent || 'main', text: m.text, at: m.ts, answer: reply ? { text: reply.text, at: reply.ts } : null, deferred: Boolean(reply?.deferred) };
  });
}

const boardTarget = (site) => listBoards().find((b) => samePath(b.dir, site)) ?? { dir: site };

export async function askOrchestrator(site, key, question, { agent = 'main' }) {
  needSite(site);
  const words = text(question, 'builder ask');
  if (/\n/.test(words)) fail('builder ask takes one line; ask each question on its own');
  const record = await readJSON(await builderFile(site, key, undefined, agent), null);
  if (!record?.started || record.done) fail(`builder ask needs an open builder record on ${key}; run builder start first`);
  const id = `ask${(await builderAsks(site, key)).length + 1}`;
  await appendLine(threadFile(site, key), { ts: new Date().toISOString(), who: `${modelName(record) || record.kind || 'Claude'} builder`, kind: BUILDER_ASK.ask, ask: id, agent, text: words });
  await appendEvent(boardTarget(site), 'builder-ask', { key, ask: id, agent, text: words });
  return { id, lines: await builderReply(site, key, { agent }) };
}

// The session's reply to a builder's ask: an answer, or with deferred its deferral to the owner.
export async function answerBuilder(site, key, id, reply, { deferred = false } = {}) {
  needSite(site);
  const said = text(reply, '--text');
  const ask = (await builderAsks(site, key)).find((a) => a.id === id) || fail(`no ask "${id}" on ${key}; builder asks ${key} lists them`);
  if (ask.answer) fail(`${id} on ${key} is already ${ask.deferred ? 'deferred' : 'answered'}`);
  const now = new Date().toISOString();
  await appendLine(threadFile(site, key), { ts: now, who: 'claude', kind: BUILDER_ASK.answer, ask: id, ...(deferred ? { deferred: true } : {}), text: said });
  if (deferred) {
    const file = await builderFile(site, key, undefined, ask.agent);
    const record = await readJSON(file, null);
    if (record) await writeJSON(file, { ...record, calls: [...(record.calls || []), { at: now, text: `Question: ${ask.text} (deferred to the owner)` }] });
  }
  return { lines: [] };
}

// → {lines}: each ask, then its answer, deferral or "waiting on the orchestrator". With wait it blocks until no ask is
// waiting on the orchestrator, giving up after timeout minutes (9, under a Bash tool call's 10) so the builder runs it again.
// It polls every ms, its deadline read off now(). A builder waiting is at a stopping point, so news for it or a pause
// asked meanwhile ends the wait with its reply (builderReply).
export async function listAsks(site, key, { wait = false, timeout = 9, every = 2000, now = Date.now } = {}) {
  needSite(site);
  const minutes = Number(timeout);
  if (!(minutes > 0)) fail('--timeout takes minutes, a number above 0');
  const deadline = now() + minutes * 60_000;
  for (;;) {
    const asks = await builderAsks(site, key);
    if (!asks.length) return { lines: ['no asks yet'] };
    const waiting = asks.filter((a) => !a.answer);
    const lines = asks.flatMap((a) => [`${a.id}. ${a.text}`, `  ${!a.answer ? 'waiting on the orchestrator' : `${a.deferred ? 'deferred' : 'answered'}: ${a.answer.text}`}`]);
    if (!wait || !waiting.length) return { lines };
    const reply = await builderReply(site, key, {});
    if (reply.length) return { lines: [...lines, ...reply] };
    if (now() >= deadline) fail(`${waiting.map((a) => a.id).join(', ')} still waiting on the orchestrator after ${minutes} minutes; run builder asks ${key} --wait again`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

// A question naming a builder's ask ("ask": "ask<n>") is that deferred ask put to the owner.
async function checkAskQuestion(site, q, name) {
  const key = q.topic.startsWith('item:') && !q.topic.startsWith('item:ask:') ? q.topic.slice(5) : fail(`${name}.ask goes on a task's question, topic item:<file>/<id>`);
  const ask = (await builderAsks(site, key)).find((a) => a.id === q.ask) || fail(`${name}.ask names no ask "${q.ask}" on ${key}; builder asks ${key} lists them`);
  if (!ask.deferred) fail(`${name}.ask names ${ask.id}, which the orchestrator ${ask.answer ? 'answered' : 'has not deferred'}; only a deferred ask goes to the owner`);
}

// → {lines}: each call numbered, then whether the session verified them.
export async function listCalls(site, key, { dir, agent = 'main' }) {
  const record = await readJSON(await builderFile(site, key, dir, agent), null);
  const calls = record?.calls || [];
  if (!calls.length) return { lines: ['no judgment calls recorded'] };
  const { verified } = record;
  const state = !unverifiedCalls(record).length ? `verified ${verified.at}${verified.note ? `: ${verified.note}` : ''}` : 'not verified yet';
  return { lines: [...calls.map((c, i) => `${i + 1}. ${c.text}`), state] };
}

// The session's review puts each deferred ask to the owner before it marks the calls verified. A build handed back with
// no calls is marked too, as builder done with none finishes: that is the way back for one whose verification was lost.
export async function verifyCalls(site, key, { dir, agent = 'main', note }) {
  const file = await builderFile(site, key, dir, agent);
  const record = await readJSON(file, null);
  const noCallsBack = Boolean(record?.done && record.handed_back) && !record.calls?.length;
  if (!unverifiedCalls(record).length && !noCallsBack) fail(`${key} has no unverified judgment calls${agent === 'main' ? '' : ` from agent ${agent}`}; builder calls ${key} lists them`);
  if (site) {
    const put = new Set((await readJSON(ownerFile(site), { items: [] })).items?.filter((q) => q.topic === `item:${key}` && q.ask).map((q) => q.ask));
    const owed = (await builderAsks(site, key)).find((a) => a.deferred && a.agent === agent && !put.has(a.id));
    if (owed) fail(`${owed.id} on ${key} was deferred to the owner; add its question with "ask": "${owed.id}" first`);
  }
  await writeJSON(file, { ...record, verified: { at: new Date().toISOString(), ...(note === undefined ? {} : { note: text(note, '--note') }) } });
  return file;
}

// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
// What a headless builder's brief is built from: {key, ref, title, notes: the notes file's path or null, worktree: the
// newest record's worktree path or null, answers: the owner's answer to each deferred ask put to them, [{ask, question,
// answer}], links: its cardLinks, prototype: its kept prototype answer, gates.prototype, or null}.
export async function briefFacts(site, key) {
  const { source, item } = await loadItem(site, key);
  const said = (q, a) => [(q.options || []).find((o) => o.id === a.choice)?.label, a.note].filter(Boolean).join(': ') || 'answered';
  const answers = (await cardQuestions(site, key)).asked.filter((q) => q.ask && q.answers.length).map((q) => ({ ask: q.ask, question: q.question, answer: said(q, q.answers.at(-1)) }));
  return { key, ref: await cardName(site, key), title: item.title || key, notes: item.plan ? path.join(source.dir, item.plan) : null, thread: threadFile(site, key), worktree: (await recordedWorktree(site, key))?.path ?? null, answers, links: await cardLinks(site, key),
    rebasePR: item.rebase_run?.pr ?? null, prototype: item.gates?.prototype ?? null };
}

// docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md
// The cards on the board that card key links: its Parent, the cards it depends on, and the cards it is Related to
// (set on either card), in that order. → [{relation: parent|depends on|related, ref, title, status, notes: the notes
// file's path or null, thread: the thread file's path}]; a link to a card no longer on the board is left out.
async function cardLinks(site, key) {
  const cards = new Map();
  for (const entry of await itemSources(site)) {
    for (const it of (await readJSON(entry.file, null))?.items || []) cards.set(`${entry.slug}/${it.id}`, { entry, it });
  }
  const slug = parseKey(key).file;
  const { it: item } = cards.get(key);
  const back = [...cards].filter(([, c]) => (c.it.related || []).some((r) => depKey(c.entry.slug, r) === key)).map(([k]) => k);
  const linked = [
    ...(item.parent ? [['parent', depKey(slug, item.parent)]] : []),
    ...(item.deps || []).map((d) => ['depends on', depKey(slug, d)]),
    ...[...new Set([...(item.related || []).map((r) => depKey(slug, r)), ...back])].map((k) => ['related', k]),
  ].filter(([, k]) => cards.has(k));
  return Promise.all(linked.map(async ([relation, k]) => {
    const { entry, it } = cards.get(k);
    return { relation, ref: await cardName(site, k), title: it.title || k, lane: LANES[it.lane || 'todo'], notes: it.plan ? path.join(entry.dir, it.plan) : null, thread: threadFile(site, k) };
  }));
}

// docs/adr/2026-11-14-0031-a-land-step-reads-landables-skips.md
// The cards whose verified build waits to land: handed back (domain.mjs handedBackAt) and not done, every call on their
// records verified. A lander lands one with no skip; skip says why one gets none (domain.mjs landStep reads it as the
// card's step): {step: 'worktree-gone'}, else {step: 'blocked', blocked: blockWords' words}, else {step: 'asking'}
// while a question on it is open. A gone worktree goes first, as the one the orchestrator must act on.
// → [{key, verified, kind, model, skip}], verified the newest verification's time, and kind and model the newest
// record's, so the lander runs as the agent that built the card.
export async function landable(site) {
  const out = [];
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    for (const item of itemFile?.items || []) {
      if (closed(item)) continue;
      const records = (await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)))).filter(Boolean);
      if (!handedBackAt(records)) continue;
      const verified = records.map((r) => r.verified?.at).filter(Boolean).sort().at(-1);
      if (!verified || records.some((r) => unverifiedCalls(r).length)) continue;
      const key = `${source.slug}/${item.id}`;
      const builds = records.filter((r) => r.kind !== HELPER).sort((a, b) => String(b.started).localeCompare(String(a.started)));
      const newest = builds.find((r) => r.worktree?.path);
      const blocked = await blockWords(site, key, item);
      const skip = !newest || !existsSync(newest.worktree.path) ? { step: 'worktree-gone' }
        : blocked ? { step: 'blocked', blocked }
        : (await cardQuestions(site, key)).asked.some((q) => q.state === 'open') ? { step: 'asking' } : null;
      const built = newest ?? builds[0];
      out.push({ key, verified, kind: providerOf(built?.kind), model: built?.model, skip });
    }
  }
  return out;
}

// A card whose lander stopped partway (its process gone) keeps the lander's record open, the verification on it
// (startBuilder); this closes that record as handed back, so landable finds the card again and the board server's
// land step for it (domain.mjs landStep) relaunches or faults it, counting from its data/landers.json entry.
export async function relaunchLander(site, key) {
  await setItem(site, key, { handBack: true });
}

// `board.mjs lander <card>`, the orchestrator's restart of a card's land: hands back a lander's open record as
// relaunchLander does, and drops the card's data/landers.json entry, so the server's next pass launches the land as a
// verification's first, with its relaunch to spend again. Refuses a card with neither.
export async function restartLander(site, key) {
  const { source, item } = await loadItem(site, key);
  const records = await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)));
  const file = path.join(site, 'data', 'landers.json');
  const sent = await readJSON(file, {});
  const open = records.some((r) => r?.started && !r.done);
  if (!open && !Object.hasOwn(sent, key)) fail(`${key} has no open builder and no lander; only a task whose lander stopped or exited has a land to restart`);
  if (open) await relaunchLander(site, key);
  delete sent[key];
  await replace(file, JSON.stringify(sent) + '\n');
}

// land's check: refuses while a builder record on the card holds unverified calls, naming the commands per agent.
export async function checkCallsVerified(site, key, { dir } = {}) {
  const { id } = parseKey(key);
  const files = await builderFiles(path.dirname(path.dirname(await builderFile(site, key, dir))), id);
  const owing = [];
  for (const file of files) {
    if (!unverifiedCalls(await readJSON(file, null)).length) continue;
    const agent = path.basename(file, '.json').slice(String(id).length + 1) || 'main';
    owing.push(agent === 'main' ? '' : ` --agent ${agent}`);
  }
  if (!owing.length) return;
  fail(`land: ${key} has judgment calls nobody verified yet; check them with ${owing.map((a) => `builder calls ${key}${a}`).join(', ')}, then run ${owing.map((a) => `builder verified ${key}${a}`).join(', ')}`);
}

// docs/adr/2026-11-16-0830-a-builder-hands-back-with-a-summary-message.md
// docs/adr/2026-11-16-1915-the-hub-status-opens-the-load-sheet-at-any-load-collapsed.md: builder done refuses while
// processes the build started still run detached in its worktree, naming them. find: detached.mjs detachedIn.
export async function refuseDetached(site, key, { agent = 'main' }, find) {
  const record = await readJSON(await builderFile(site, key, undefined, agent), null);
  if (!record?.started || record.done || !record.worktree?.path) return;
  const left = find(record.worktree.path, Date.parse(record.started));
  if (!left.length) return;
  fail(`builder done refuses while ${key}'s build leaves processes running detached: ${left.map((p) => `${p.pid} ${p.command}`).join('; ')}. `
    + `Stop them (kill ${left.map((p) => p.pid).join(' ')}) and run builder done again.`);
}

// `builder done --summary`: the done that ends a build, the main record of a build (no lander, rebase run, planner or
// install) handing back its judgment calls or finishing the worktree it keeps, owes a summary of what
// it built, which its record keeps and the thread shows as the Builder's message above its judgment calls (domain.mjs
// threadOf). Any other done refuses one.
export async function recordSummary(site, key, summary, { agent = 'main', next }) {
  const file = await builderFile(site, key, undefined, agent);
  const record = await readJSON(file, null);
  const owed = agent === 'main' && next === undefined && record?.started && !record.done && ![LANDER, REBASE_LABEL].includes(record.label) && !plans(record) && record.kind !== 'install'
    && (unverifiedCalls(record).length > 0 || Boolean(record.worktree?.path));
  if (!owed) {
    if (summary !== undefined) fail("--summary goes on the build's own done, the one that hands back its calls or finishes its worktree");
    return;
  }
  const words = typeof summary === 'string' ? summary.trim() : '';
  if (!words) fail(`builder done ends ${key}'s build: pass --summary "${SUMMARY_HINT}"`);
  await writeJSON(file, { ...record, summary: words });
}

// `builder done`'s hand-back for a record with unverified calls: its records close as handed back with the Next the calls ask
// for, a question first (docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md).
// → {lines}, or null when the record has none.
export async function handBackCalls(site, key, { dir, agent = 'main', next }) {
  const record = await readJSON(await builderFile(site, key, dir, agent), null);
  const calls = record && !record.done ? unverifiedCalls(record) : [];
  if (!calls.length) return null;
  if (next !== undefined) fail(`builder done sets ${key}'s Next itself while its record has judgment calls; run it without --next`);
  const asks = calls.some((c) => c.text.startsWith('Question:')) ? "Answer the builder's questions" : "Verify the builder's judgment calls";
  const set = await setItem(site, key, { handBack: true, next: asks });
  return { lines: [`handed back: Next "${asks}"`, ...set.lines] };
}

// docs/adr/2026-11-04-1611-finishing-a-build-is-one-step.md
// Whether `builder done` from agent finishes the card (board.mjs finishCard): the main build's open record that keeps a
// worktree. Refuses while another agent's record on the card is open, other than an install build, since finishing
// closes every record.
export async function finishesCard(site, key, { agent = 'main' }) {
  if (agent !== 'main') return false;
  const file = await builderFile(site, key, undefined, agent);
  const record = await readJSON(file, null);
  if (!record?.started || record.done || !record.worktree?.path) return false;
  const { id } = parseKey(key);
  for (const other of await builderFiles(path.dirname(path.dirname(file)), id)) {
    const r = other === file ? null : await readJSON(other, null);
    if (!r?.started || r.done || r.kind === 'install') continue;
    const name = path.basename(other, '.json').slice(String(id).length + 1);
    fail(`builder done would finish ${key} while agent ${name} is still open; run builder done ${key} --agent ${name} first`);
  }
  return true;
}

// What `builder verified` does next: null when the card is closed; {held: why} when it isn't a handed-back build whose
// every call is now verified (handed back and not done, no builder open, its main build's worktree still there); else
// {waits: [question id]} while the card's questions are open, or {} when verifying finishes it.
export async function verifiedFinish(site, key) {
  const { source, item } = await loadItem(site, key);
  if (closed(item)) return null;
  const records = (await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)))).filter(Boolean);
  if (!handedBackAt(records)) return { held: "the build hasn't handed back; run builder done first" };
  if (records.some((r) => unverifiedCalls(r).length)) return { held: 'a builder record still has unverified judgment calls' };
  if (records.some((r) => r.started && !r.done && r.kind !== 'install')) return { held: 'a builder record is still open' };
  const tree = await recordedWorktree(site, key);
  if (!tree || !existsSync(tree.path)) return { held: "the build's worktree is gone" };
  return { waits: (await cardQuestions(site, key)).asked.filter((q) => q.state === 'open').map((q) => q.id) };
}

// docs/adr/2026-11-02-1952-a-message-or-question-on-a-done-card-reopens-it.md: a done card the owner messaged since it closed reads
// reopened, and only the owner's Done closes it again.
export async function checkNotReopened(site, key) {
  const { item } = await loadItem(site, key);
  if (item.reopened_at) fail(`the owner reopened ${await cardName(site, key)}; it closes on the owner's Done`);
  if (item.lane !== 'done' || storedPRs(item).some((p) => p.merged_at)) return;
  const doneAt = String(item.closed_at || '');
  const events = await readLog(path.join(site, 'data', 'events.jsonl'));
  if (events.some((e) => e.kind === 'item-message' && e.data?.key === key && String(e.ts) > doneAt)) fail(`the owner reopened ${await cardName(site, key)} with a message; it closes on the owner's Done`);
}

// A card's live records: its past runs' (keepPastRun) are read by the thread alone.
async function builderFiles(fileDir, id) {
  const dir = path.join(fileDir, 'agents');
  return (await fs.readdir(dir).catch(() => []))
    .filter((n) => n === `${id}.json` || (n.startsWith(`${id}@`) && !n.startsWith(`${id}@past-`) && n.endsWith('.json')))
    .map((n) => path.join(dir, n));
}

// Closes the card's open builder records, an install build only with the card finished. handedBack marks each record it
// closes as handed back at that time (domain.mjs handedBackAt); endHandBack takes the mark off every record, so the
// hand-back ends. held marks each started record it closes hold_stopped, for the Unblock that relaunches it (takeHoldStopped),
// and leaves open a build a pause rides on (requestPause).
async function closeBuilders(fileDir, id, cardFinished, { handedBack, endHandBack = false, held = false } = {}) {
  const now = new Date().toISOString();
  for (const file of await builderFiles(fileDir, id)) {
    const record = await readJSON(file, null);
    if (!record) continue;
    if (record.done || (record.kind === 'install' && !cardFinished)) {
      if (endHandBack && record.handed_back) { const { handed_back, ...rest } = record; await writeJSON(file, rest); }
      continue;
    }
    if (held && record.pause) continue;
    const { eta, handed_back, ...rest } = record;
    await writeJSON(file, { ...rest, done: now, ...(handedBack ? { handed_back: handedBack } : {}), ...(held && record.started ? { hold_stopped: true } : {}) });
  }
}

// docs/adr/2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md
// The run a Block stopped on the card's main record, taken off it for the Unblock that relaunches it: → {kind, label,
// brief}, brief a planner's briefs entry (startPlanner) or null, or null when the hold stopped none.
export async function takeHoldStopped(site, key) {
  const file = await builderFile(site, key);
  const record = await readJSON(file, null);
  if (!record?.hold_stopped) return null;
  const { hold_stopped, ...rest } = record;
  await writeJSON(file, rest);
  return { kind: record.kind ?? null, label: record.label ?? null, brief: record.brief ?? null };
}

// The record stays, marked done, so the item's thread can show when the agent finished (domain.mjs threadOf).
// startedBetween [from, to] (ms) leaves a record alone unless it started in that window, so a caller closing an
// agent's own record never closes one a later agent restarted on the same item. next sets the item's Next. requireNext,
// for `builder done`, refuses closing the last open record of a card that would then sit In Progress with no Next
// (docs/adr/2026-11-03-0237-an-in-progress-card-always-has-a-builder-line-or-a-next.md); the SubagentStop hook and a board's
// close stop records whatever the card is left with.
export async function stopBuilder(site, key, { dir, agent, startedBetween, note, next, requireNext = false }) {
  const file = await builderFile(site, key, dir, agent);
  const record = await readJSON(file, null);
  if (!record || record.done) return file;
  if (startedBetween) {
    const started = Date.parse(record.started);
    if (!(started >= startedBetween[0] && started <= startedBetween[1])) return file;
  }
  const { eta, ...rest } = record;
  const done = new Date().toISOString();
  const stopped = { ...rest, done, ...(note ? { note } : {}) };
  const { id } = parseKey(key);
  const fileDir = path.dirname(path.dirname(file));
  const records = await Promise.all((await builderFiles(fileDir, id)).map((f) => (f === file ? stopped : readJSON(f, null))));
  const last = !records.some((r) => r?.started && !r.done);
  const source = dir ? { file: path.join(fileDir, 'wave.json') } : (await loadItem(site, key)).source;
  const itemFile = await readJSON(source.file, null);
  const item = itemFile?.items?.find((it) => it.id === id);
  if (next !== undefined) {
    setNext(item || fail(`${key} has no item to set --next on`), next, await hasOpenQuestion(site, key));
    if (site) await checkNextDeps(site, key, item, item.next);
  }
  if (requireNext && item && owesNext(item, records)) {
    fail(`builder done closes ${key}'s last open builder, which leaves it In Progress with no Next; pass --next "<what happens next>", or record a judgment call with builder call ${key} or land`);
  }
  await writeJSON(file, stopped);
  await publishStaged(site, key, { screen: record.kind === 'grill' });
  if (next !== undefined) await writeJSON(source.file, itemFile);
  return file;
}

// A planner's `builder done`: stopBuilder, then, if the card is still in the planner's phase with no question open,
// staged or screening for it, a fault line (domain.mjs orchestratorWaitOf reads it as a wait). A grill on a card that
// keeps its prototype answer (gates.prototype) may have nothing to ask: that card moves on instead (moveOnAnswered).
// → {file, lines}
export async function stopPlanner(site, key, flags) {
  const record = await readJSON(await builderFile(site, key, undefined, flags.agent), null);
  const kind = record?.kind;
  const file = await stopBuilder(site, key, flags);
  // docs/adr/2026-11-14-2015-a-clean-visual-end-with-no-page-reads-unplaced.md: a visual agent's page is a visual thread line since its record started.
  if (kind === VISUAL) {
    if (!record.started || record.done) return { file, lines: [] };
    const placed = (await readLog(threadFile(site, key))).some((m) => m.kind === VISUAL && String(m.ts) >= record.started);
    if (placed) return { file, lines: [] };
    const { line, lines } = await appendStatus(site, key, 'visual-unplaced', {});
    return { file, lines: [line.text, ...lines] };
  }
  const { phase, gates } = (await loadItem(site, key)).item;
  const asked = await hasOpenQuestion(site, key) || Boolean((await readJSON(stagedFile(site), {}))[key]);
  if (phase !== { grill: 'grilling', prototype: 'prototyping' }[kind] || asked) return { file, lines: [] };
  if (kind === 'grill' && gates?.prototype && await moveOnAnswered(site, key)) return { file, lines: [] };
  const { line, lines } = await appendStatus(site, key, 'planner-unasked', { kind });
  return { file, lines: [line.text, ...lines] };
}

// docs/adr/2026-11-12-1000-a-planner-whose-process-is-gone-closes-at-once.md
// Each open planner record (grill, prototype, visual) of a process the board launched, which alive(record) says is gone,
// closes now. failure(record) is the words its run failed with, or null for a clean end: a failure closes as
// planner-failed (abandonPlanner); a clean grill, prototype or visual as `builder done` closes it (stopPlanner, so
// planner-unasked when no question came, visual-unplaced when no page did). A run the usage limit stopped, which
// limited(record) says with the limit's reset (else null), closes with no line, for the server to relaunch after the
// reset. → [{key, kind, failed, limited?: {until, brief}}]
export async function closeGonePlanners(site, { alive, failure, limited = () => null }) {
  const closed = [];
  for (const source of await itemSources(site)) {
    // Only the records of the cards the board builds with theirs: a Done card's are finished, and an archived card's
    // (gone from the item file) were finished before it was archived.
    const items = (await readJSON(source.file, null))?.items;
    const open = new Set(Array.isArray(items) ? items.filter((it) => it.lane !== 'done').map((it) => it.id) : []);
    const files = (await fs.readdir(path.join(source.dir, 'agents')).catch(() => []))
      .filter((n) => n.endsWith('.json') && !n.includes('@past-') && open.has(n.slice(0, -'.json'.length).split('@')[0]));
    for (const name of files) {
      const [id, ...named] = name.slice(0, -'.json'.length).split('@');
      const file = path.join(source.dir, 'agents', name);
      const record = await readJSON(file, null);
      if (!record?.started || record.done || !plans(record) || !record.session?.pid || alive(record)) continue;
      const key = `${source.slug}/${id}`;
      const agent = named.join('@') || 'main';
      const until = limited(record);
      if (until) {
        await stopBuilder(site, key, { agent });
        closed.push({ key, kind: record.kind, failed: null, limited: { until, brief: record.brief ?? null } });
        continue;
      }
      const failed = failure(record);
      if (failed) await abandonPlanner(site, key, ['planner-failed', { kind: record.kind === VISUAL ? 'visual agent' : record.kind, error: failed }], agent);
      else await stopPlanner(site, key, { agent });
      closed.push({ key, kind: record.kind, failed });
    }
  }
  return closed;
}

export async function openBoardBuilders(site) {
  const builders = [];
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    for (const item of itemFile?.items || []) {
      for (const file of await builderFiles(source.dir, item.id)) {
        const record = await readJSON(file, null);
        if (!record?.started || record.done) continue;
        const name = path.basename(file, '.json');
        builders.push({ key: `${source.slug}/${item.id}`, agent: name.slice(String(item.id).length + 1) || 'main', label: record.label || 'Builder', started: record.started, kind: record.kind ?? null, pid: record.session?.pid ?? null });
      }
    }
  }
  return builders;
}

export async function closeBoardBuilders(site) {
  const builders = await openBoardBuilders(site);
  for (const builder of builders) await stopBuilder(site, builder.key, {
    agent: builder.agent, note: 'Board closed. Builder record stopped; work is kept for reopening.',
  });
  return builders;
}
