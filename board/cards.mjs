// Cards: a board's item files and each card in them, its thread (status lines, messages, uploads, the owner's reads and
// pushes), its lane, phase, deps, links and PRs, the one write that changes a card (setItem) and the one that adds one
// (addItem), merges, and the Done archive. A site is a directory under ~/.claude/kickflip/sites; `site` null means a
// board over ~/.claude/waves alone. Written through files.mjs (docs/adr/2026-11-17-1137-cards-questions-asks-and-settings-leave-store-mjs.md).
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { nodeBin } from '../bin/install.mjs';
import { gh, limitWords } from '../shared/gh.mjs';
import { squashBody, startTitleFault, subjectFault } from './commit-message.mjs';
import { fileURLToPath } from 'node:url';
import { COMMANDS, LANES, MOVE, PHASES, ITEM_EVENTS, SCRIPT_EVENTS, scriptStateOf, handedBackAt, blockWordsOf, threadOf, builds, mergeBlockers, owesNext, pushTag, refOf, HELPER, implementAsk } from './domain.mjs';
import { githubStateFile, appendEvent, listBoards, samePath } from '../hub/boards.mjs';
import { builderRepo } from './worktree.mjs';
import { reviseQueued, pushKindError } from '../hub/push.mjs';
import { AT_RE } from '../hub/duration.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { resolveTicket, ticketNamed, ticketTarget, moveTicket, cardIdOf } from './tickets.mjs';
import { validateBranch } from '../hub/repos.mjs';
import { withFileLock } from '../hub/locks.mjs';
import { appendLine, boardConfig, itemSources, readJSON, readLog, remove, replace, sitesDir, wavesDir, writeJSON } from './files.mjs';
import { builtCards, shownEvents } from './snapshot.mjs';
import { SCRIPT_LIMIT, runsAs, scriptLogName, scriptSha } from './scripts.mjs';
import { HUB, WAIT_OVER, MESSAGE_LIMIT, hubLineOf, hubText, detailOf } from './hub-lines.mjs';
import { fetchPR, reportOf, githubLogin, postToPR, CLAUDE_PREFIX, CLAUDE_MARK } from '../hub/pr-report.mjs';
import { allLanded, cardPRs, hasPR, parsePRRef, prNames, storedPRs } from '../shared/card-prs.mjs';
import { reviewersOf } from './review.mjs';
import { parseCheck, checkText } from '../shared/owner-check.mjs';
import { BoardError, fail, needSite, text, optional, cardTitle, pageUrl, domId } from './checks.mjs';
import { storedTickets, settingsOf, markDescription, refuseSecondProposal, boardRepoOf, boardTarget } from './settings.mjs';
import { leaveNew, refuseFiled, inIntake, IMPLEMENT_NOT_FILED, refuseMoved } from './asks.mjs';
import { pageServed, publishStaged, cardOfTopic, noteStamp, freeNotesName, writeNotesFile, appendNotes, refuseCardNotes, DRAFT_HINT, markWaiting, readiedText, owe, dropOwed, cardQuestions, resolveAnswered, hasOpenQuestion, setNext, closeQuestions, unpickedPrototype, clip, ownerQuote, planPath, itemNotes } from './questions.mjs';
import { onlyRebased, requestPause, isLanding, clearRefusal, builderFiles, closeBuilders } from './runs.mjs';

export async function siteDir(route) {
  if (!/^[\w-]+$/.test(route || '')) fail(`--site takes a route such as ios-orchestrator, not "${route}"`);
  const dir = path.join(sitesDir(), route);
  if (!(await fs.stat(dir).then((s) => s.isDirectory(), () => false))) fail(`no site at ${dir}`);
  return dir;
}

export const threadFile = (site, key) => path.join(site, 'data', 'threads', key.replace(/[^\w.-]+/g, '__') + '.jsonl');
export const ownerFile = (site) => path.join(site, 'data', 'owner.json');
export function parseKey(key) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(key || '');
  return m ? { file: m[1], id: m[2] } : fail(`expected <file>/<id>, not "${key}"`);
}

export async function loadItemFile(site, slug) {
  const source = (await itemSources(site)).find((s) => s.slug === slug) || fail(`this board has no item file "${slug}"`);
  const itemFile = await readJSON(source.file, null);
  if (!itemFile || !Array.isArray(itemFile.items)) fail(`${source.file} is not an item file with items[]`);
  return { source, itemFile };
}

// A card in the archive comes back to its item file for any command that names it (restoreArchived).
export async function loadItem(site, key) {
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

// An event handed to the session, such as an ask or a thread message, reads "Working on it" until Claude replies to it
// (or, in a thread, writes a later line); domain.mjs decides which. The owner's words are handed over by board.mjs inbox
// read, other kinds by the watcher's print
// (docs/adr/2026-11-18-1300-requests-arrive-as-a-signal-and-inbox-read-hands-over-the-words.md).
const workingFile = (site) => path.join(site, 'data', 'working.json');
export async function readWorking(site) {
  return (await readJSON(workingFile(site), {})).events || {};
}

// The kinds marked working as they are handed to the session (docs/adr/2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md).
export const WORKING_KINDS = ['ask', 'item-message', 'overnight-triage', 'board-ask'];
export async function markWorking(site, eventIds) {
  if (!eventIds.length) return;
  const at = new Date().toISOString();
  const events = await readWorking(site);
  await writeJSON(workingFile(site), { events: { ...events, ...Object.fromEntries(eventIds.map((id) => [id, routeRecord(events, id) || at])) } });
}

// docs/adr/2026-11-15-1700-a-card-reads-thinking-from-its-events-delivery-until-the-orchestrator-writes.md
// data/delivered.json {since, events: {<event id>: ts}}: when each event was first handed to the session, the owner's
// words by board.mjs inbox read and every other waking kind by bin/wait-events.mjs's print
// (docs/adr/2026-11-18-1300-requests-arrive-as-a-signal-and-inbox-read-hands-over-the-words.md); since is the board's
// first stamp, written by a watcher's start with no events, so an event sent before it counts as handed when sent
// (domain.mjs handedAt).
const deliveredFile = (site) => path.join(site, 'data', 'delivered.json');
export async function readDelivered(site) {
  return readJSON(deliveredFile(site), {});
}
export async function markDelivered(site, eventIds) {
  const at = new Date().toISOString();
  const { since, events = {} } = await readDelivered(site);
  if (!eventIds.length && since) return;
  await writeJSON(deliveredFile(site), { since: since || at, events: { ...events, ...Object.fromEntries(eventIds.map((id) => [id, routeRecord(events, id) || at])) } });
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
// docs/adr/2026-11-18-2345-a-report-for-the-owner-goes-to-a-visual-never-a-local-path.md
// A thread line names no path on the machine the owner can't open: the session scratchpad (/private/tmp/claude-…), /tmp
// and ~/.claude/jobs. A report goes to a visual on its task instead.
const LOCAL_PATH = /(?<![\w./-])(?:\/private\/tmp\/|\/tmp\/|(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.claude\/jobs\/)/;
export function refuseLocalPaths(texts, key) {
  const found = texts.filter((t) => typeof t === 'string').map((t) => LOCAL_PATH.exec(t)?.[0]).find(Boolean);
  if (found) fail(`the text names a path the owner can't open (${found}…); put a report in a visual (board.mjs visual add ${key || '<task>'} --file <report.md> --title <t>, or item brief ${key || '<task>'} --kind visual) and keep the line to a summary and its link`);
}
// The cards owner.json's questions ids are asked on, for the question commands' ACTS entries.
export async function questionCards(site, ids) {
  const owner = await readJSON(ownerFile(site), { items: [] });
  return (owner.items || []).filter((q) => ids.includes(q.id)).map((q) => cardOfTopic(q.topic)).filter(Boolean);
}

// The asks whose text the session was just handed again, an edit inbox read printed or a sorting command's refusal,
// have their working mark moved to now: that is when the session read their latest text.
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
// its back arrow goes to its own href, the card or the board, rather than back out of the app (router.js entryOf,
// ui-page-header.js backStep), and a prototype page tied to a question (?q=) sends the owner to the card's thread
// instead once that question has a pick.
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
export async function freshenPush(site, key, message) {
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
export const uploadsDir = (site) => path.join(site, 'data', 'uploads');
export const uploadMeta = (site, file) => path.join(uploadsDir(site), '.meta', `${file}.json`);
export const STORED = /^\d+-[\w.-]+$/;
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
// wait, on a wait line (hub-lines.mjs WAIT_LINES), is {for: the card it waits on, retry}, kept for its live line (domain.mjs builderOf).
export async function appendStatus(site, key, kind, inputs = {}, { link, questions, pid, wait } = {}) {
  needSite(site);
  await checkThreadKey(site, key);
  const line = { ts: new Date().toISOString(), who: 'claude', kind: HUB, line: kind, text: hubText(kind, inputs), ...(detailOf(kind, inputs) ? { detail: detailOf(kind, inputs) } : {}), ...(link ? { link } : {}), ...(questions ? { questions } : {}), ...(pid ? { pid } : {}), ...(wait ? { waitFor: wait.for, ...(wait.retry ? { retry: true } : {}) } : {}) };
  await appendLine(threadFile(site, key), line);
  return { line, lines: hubLineOf(line).fault ? await freshenPush(site, key, line.text) : [] };
}
// The end of the wait whose wait line is stamped `of` (hub-lines.mjs WAIT_OVER).
export async function appendWaitOver(site, key, of) {
  needSite(site);
  await checkThreadKey(site, key);
  await appendLine(threadFile(site, key), { ts: new Date().toISOString(), who: 'claude', kind: WAIT_OVER, of });
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
// key is <file>/<id>, or ask:<event id> for an ask's thread.
// A message holds at most MESSAGE_LIMIT characters; a longer one is refused for the orchestrator to rewrite shorter or
// move into a page it links. A comment brought in from GitHub or Slack is kept whole.
// script: a file whose text the message offers for the owner to run on a work card
// (docs/adr/2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md), stored whole on the line with
// its id, hash, and the host and user the board server runs it as.
export async function appendMessage(site, key, { text: body, link, log, who = 'claude', via, close, implement, script: scriptFile }) {
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
  const page = optional(link, (v) => pageUrl(v, '--link'));
  if (page !== undefined) await pageServed(site, page, '--link');
  const line = { ts: new Date().toISOString(), who: who.trim(), text: words, link: page, log, via, script };
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
export async function appendCommand(site, key, { command, text: words = COMMANDS[command], who = 'claude', card, sendId, ts = new Date().toISOString() }) {
  const line = { ts, who, command, text: words, ...(sendId ? { sendId } : {}), ...(card ? { card } : {}) };
  await appendLine(threadFile(site, key), line);
  return { lines: [] };
}

// An ask folded into an existing work item: data/ask-links.json ({links: {<ask event id>: <file>/<id>}}) names the item,
// whose thread then holds the ask, marked moved, and one summary line; the ask has no card of its own
// (docs/adr/2026-10-29-1639-the-plus-makes-a-new-card.md).
export const askLinksFile = (site) => path.join(site, 'data', 'ask-links.json');
export async function readAskLinks(site) {
  return (await readJSON(askLinksFile(site), {})).links || {};
}

// docs/adr/2026-11-18-2330-agents-read-the-cards-thread-and-notes-stop-copying-it.md
// A card's thread as the page shows it, read from the board's files: the card's thread lines with the owner's messages
// and answers, and the asks it came from or folded in, in order (domain.mjs threadOf), one "<time> <who>: <text>" line
// each. The owner's words live in the events log and are copied nowhere else.
export async function readThread(site, key) {
  const { item } = await loadItem(site, key);
  const links = await readAskLinks(site);
  const moved = Object.entries(links).filter(([, k]) => k === key).map(([id]) => id);
  const askIds = [item.from_ask, ...moved].filter(Boolean);
  const keys = new Set([key, ...askIds.map((id) => `ask:${id}`)]);
  const owner = await readJSON(ownerFile(site), { items: [] });
  const asked = new Set((owner.items || []).filter((q) => q.topic === `item:${key}`).map((q) => q.id));
  const events = (await shownEvents(site)).filter((e) => (keys.has(e.data?.key) && ITEM_EVENTS.includes(e.kind))
    || (e.kind === 'owner-answer' && asked.has(e.data?.id)) || (e.kind === 'ask' && askIds.includes(e.id)) || e.kind === 'ask-edited');
  const lines = (await Promise.all([...keys].map((k) => readLog(threadFile(site, k))))).flat();
  const thread = threadOf(key, { lines, events, owner, fromAsk: item.from_ask || null, moved });
  return thread.map((m) => `${m.ts} ${m.who}: ${String(m.text ?? '').trim()}`);
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
export async function askCardOf(site, eventId) {
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    const item = (Array.isArray(itemFile?.items) ? itemFile.items : []).find((i) => i.from_ask === eventId);
    if (item) return { source, itemFile, item, key: `${source.slug}/${item.id}` };
  }
  return null;
}
// → the thread line a session's card run writes once the hub starts it; refuses words the owner didn't write here.
export async function askedGate(site, key, asked) {
  needSite(site);
  if (asked === undefined) fail(`only the owner's Serve / Build and the hub's Auto-build start a task run; pass --asked "<the owner's words>" quoting where the owner asked for ${key}'s run`);
  return `Running at the owner's ask: "${await ownerQuote(site, asked, '--asked')}"`;
}

export async function checkAsk(site, eventId, name = '--from-ask') {
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
export function placeIn(item, to, now = new Date().toISOString(), phase = movedPhase(item, to)) {
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
// docs/adr/2026-11-17-2200-card-state-comes-from-one-snapshot-reader.md: the card at key as the board draws it
// (snapshot.mjs builtCards), its lane, blockedBy and finished, one in the archive brought back first (loadItem).
export async function shownCard(site, key) {
  await loadItem(site, key);
  return (await builtCards(site)).get(key);
}
// Whether another open card on the board carries ticket.
async function sharedOpen(site, key, ticket) {
  if (!ticket) return false;
  const open = await openKeys(site);
  for (const s of await itemSources(site)) {
    for (const it of (await readJSON(s.file, null))?.items || []) {
      const own = `${s.slug}/${it.id}`;
      if (own !== key && it.ticket === ticket && open.has(own)) return true;
    }
  }
  return false;
}
// The keys of the open cards the board draws: not finished (domain.mjs workItem's finished).
export const openKeys = async (site) => new Set([...(await builtCards(site)).values()].filter((c) => !c.finished).map((c) => c.key));
// Whether the card has left Todo: it is stored in another lane. A command writing the card's stored lane reads it; a
// guard on the lane reads the card's (shownCard).
export const leftTodo = (item) => Boolean(item?.lane) && item.lane !== 'todo';
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
const FROM_ASK_PHASE = '--from-ask files a task, which reads New until it has a phase: pass --phase discussing, grilling or prototyping, or --blocked to file it for later';
const NOT_STAGED = "a task goes ready only from staging, which the board sets on the owner's Send, Implement or Reply";
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
export const depKey =(slug, dep) => (String(dep).includes('/') ? String(dep) : `${slug}/${dep}`);
// A dep is a card, by key or by bare id in item file slug. → the keys of the cards deps waits on
export const depCards = (slug, deps) => [...new Set((deps || []).map((d) => depKey(slug, d)))];
// The names of what blocks built card from starting: each dep it waits on, then its blocked-until condition.
export const blockerNames = (card) => [...card.blockedBy.map((d) => d.ref), ...(card.blockedUntil ? [card.blockedUntil] : [])];
// docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md: a card In Progress is one started with
// none of a PR, a pushed branch or a held Merge, which keep it In Review: a build runs on it, or its build handed back.
// finished is the built card's.
const inProgress = (item, records, finished) => !hasPR(item) && !item.pushed && !item.merge_ready && !finished
  && (Boolean(handedBackAt(records)) || records.some((r) => r?.started && !r.done && builds(r)));
// → the keys of the open cards waiting on key that nothing blocks now: no dep they wait on and no condition.
async function unblockedBy(site, key) {
  return [...(await builtCards(site)).values()]
    .filter((c) => !c.finished && !c.blockedUntil && !c.blockedBy.length && c.blockers.some((d) => d.key === key)).map((c) => c.key);
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
  const open = await openKeys(site);
  for (const s of await itemSources(site)) {
    for (const it of (await readJSON(s.file, null))?.items || []) {
      const own = `${s.slug}/${it.id}`;
      if (!open.has(own) || !(it.deps || []).some((d) => depKey(s.slug, d) === key)) continue;
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

// docs/adr/2026-11-17-0700-a-recheck-whose-blocker-touched-none-of-the-tasks-files-releases-itself.md
// The paths a task's notes name: tokens with a folder slash or a file extension of letters. A token names a changed file
// when it is that file, a folder holding it, or a bare file name (SKILL.md) ending the file's path.
const namedPaths = (markdown) => [...new Set((markdown.match(/[\w.-]+(?:\/[\w.-]+)+|[\w-]+\.[a-z]\w+/gi) || []).map((t) => t.replace(/^\.\/|[.\/]+$/g, '')).filter((t) => /[a-z]/i.test(t)))];
const namesFile = (named, file) => file === named || file.startsWith(`${named}/`) || (!named.includes('/') && file.endsWith(`/${named}`));

// docs/adr/2026-11-17-2028-a-wait-a-block-held-is-owed-from-the-blocks-end.md: a card records when its block ended as
// unblocked_at, ts its Unblocked line's, which domain.mjs orchestratorWaitsOf reads as when each wait the block held is
// owed from. A ready card in Todo goes back to staging for the orchestrator to judge again against what landed
// (docs/adr/2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md), unless its blocker landed files (the paths
// its diff changed) none its notes name: then it stays ready. Notes naming no path, or no notes, send it to staging.
// → whether it stayed ready.
async function markUnblocked(site, key, ts, landedFiles) {
  const { source, itemFile, item } = await loadItem(site, key);
  item.unblocked_at = ts;
  const markdown = item.phase === 'ready' && !leftTodo(item) && landedFiles ? await itemNotes(source.dir, item) : null;
  const named = markdown ? namedPaths(markdown) : [];
  const staysReady = named.length > 0 && !landedFiles.some((f) => named.some((n) => namesFile(n, f)));
  if (item.phase === 'ready' && !leftTodo(item) && !staysReady) {
    Object.assign(item, { phase: 'staging', staged_at: ts });
    delete item.ready_at;
    delete item.ready_main;
  }
  await writeJSON(source.file, itemFile);
  return staysReady;
}

export async function checkNextDeps(site, key, item, next) {
  const mentions = new Set(next.match(/#?[\w-]+(?:\.[\w-]+)*(?:\/[\w-]+(?:\.[\w-]+)*)*/g) || []);
  const deps = new Set(depCards(parseKey(key).file, item.deps));
  const open = await openKeys(site);
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    for (const other of itemFile?.items || []) {
      const otherKey = `${source.slug}/${other.id}`;
      if (otherKey === key || deps.has(otherKey) || !open.has(otherKey)) continue;
      const names = [other.id, refOf(itemFile, other), other.ticket].filter(Boolean).flatMap((id) => [id, `${source.slug}/${id}`]);
      if (names.some((name) => mentions.has(name))) fail(`--next names unfinished task ${otherKey}; add it with --blocked-by`);
    }
  }
}

// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
// docs/adr/2026-11-19-1500-readying-no-longer-needs-answers-copied-into-the-notes.md
// Ready means a builder can start from the card alone: it has a size and a notes file. The owner's answers stay in the
// card's thread, which the builder reads, so the notes need not name them.
const NOTES_COMMAND = (key) => `item notes ${key} --heading "<heading>" --file <draft.md>`;
function checkSizeAndNotes(key, item) {
  const starts = 'a builder starts from it, so pass';
  if (!item.size) fail(`${key} has no size; ${starts} --size small or large with --phase ready`);
  if (!item.plan) fail(`${key} has no notes file; a builder starts from it, so add its notes with ${NOTES_COMMAND(key)} before --phase ready`);
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

const RISKS = ['low', 'medium', 'high'];
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
// change, low, medium or high, which builder done records and the PR's Slack link shows (slack-store.mjs prLink). replyOn (--reply-on)
// is the orchestrator's reply on a card this call links or unlinks while its owner waits on that reply (replyFirst).
async function changeItem(site, key, { replyOn, risk, ticket, newTicket, status, clearStatus, done, splitInto, merged, landed, landedFiles, start, handBack, next, clearNext, pr, pushed, base, mergeReady, ghSince, fromAsk, phase, state, block, unblock, pickUpAt, deps, blockedUntil, blockReason, parent, split: splitOfParent, related, relate, unrelate, install, installSha, installLabel, clearInstall, title, size, model, force, text: said, closing, who, command, ownerStep, ownerDone, check, finishAsk, triaged, release }, options) {
  if (status !== undefined || clearStatus) fail(`--status${clearStatus ? ' and --clear-status are' : ' is'} gone: a task's lane is stored and moves itself. Close it with --done --text "<what was done, or why it closes without landing>"`);
  if (merged) done = true;
  if (related !== undefined && (relate !== undefined || unrelate !== undefined)) fail('pass --related, or --relate and --unrelate, not both');
  // Staging is the board's: here, item triage keeping the owner's Implement (triageItem).
  checkPhase(triaged && phase === 'staging' ? undefined : phase, state);
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
  if ([done, start, handBack, next, clearNext, pr, pushed, base, mergeReady, ghSince, fromAsk, phase, hold, deps, blockedUntil, blockReason, parent, related, relate, unrelate, built, title, size, model, ticket, newTicket, ownerStep, check, risk].every((v) => v === undefined || v === false)) fail('nothing to set: pass --done, --next, --clear-next, --pr, --pushed, --base, --gh-since, --from-ask, --phase, --blocked, --unblocked, --pick-up-at, --blocked-by, --blocked-until, --block-reason, --parent, --related, --relate, --unrelate, --install, --clear-install, --title, --size, --model, --ticket, --new-ticket or --check');
  const ask = fromAsk === undefined ? undefined : await checkAsk(site, fromAsk);
  if (ask) await refuseMoved(site, ask);
  if (ask) await refuseFiled(site, ask, key);
  if (ask && implementAsk(await readLog(path.join(site, 'data', 'events.jsonl')), ask)) fail(IMPLEMENT_NOT_FILED(ask));
  const { source, itemFile, item } = await loadItem(site, key);
  // The card as the board draws it before this write: the guards read its lane, blockedBy and finished.
  const shown = await shownCard(site, key);
  const file = parseKey(key).file;
  const before = { parent: item.parent, deps: (item.deps || []).map((d) => depKey(file, d)), wasNew: inIntake(item) };
  // An answered card the orchestrator sorts after all is work: it goes back to Todo in that phase.
  const backToTodo = phase !== undefined && Boolean(item.answered_at) && !item.closed_at;
  if (backToTodo) {
    delete item.answered_at;
    if (leftTodo(item)) placeIn(item, 'todo', undefined, null);
  }
  const lane = backToTodo ? 'todo' : shown.lane;
  if (phase !== undefined && lane !== 'todo') fail(`--phase sets a Todo task's phase; ${key} is ${LANES[lane]}, where the board sets it`);
  // docs/adr/2026-11-17-0543-a-quick-ask-is-triaged-into-staging.md: every task goes ready from staging, a Quick build
  // ask's too, which item triage stages.
  if (phase === 'ready' && !['staging', 'ready'].includes(item.phase)) fail(`${key} reads ${item.phase || 'new'}, not staging; ${NOT_STAGED}`);
  if (ask && item.from_ask && item.from_ask !== ask) fail(`${key} came from ask "${item.from_ask}", so ask "${ask}" can't be its from-ask; to fold it in: item relate-ask ${ask} ${key} --summary "<line>"`);
  // docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md
  if (ask && hold && phase !== undefined && !item.phase) fail('a task filed blocked is filed New and takes no --phase; drop --phase, or drop --blocked to file it in a phase');
  if (ask && phase === undefined && !item.phase && !hold) fail(FROM_ASK_PHASE);
  const wasFinished = shown.finished;
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
  // A card that leaves Todo is never still blocked by the owner.
  if (start || done || handBack || handover) clearHold(item);
  if (start) {
    const blockers = shown.blockedBy.map((d) => d.key);
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
  // docs/adr/2026-11-21-2333-a-task-can-keep-its-own-pr-base.md: the branch the card's PR targets, which builderRepo
  // reads for its worktree, its brief, its finish and its rebase runs.
  if (base !== undefined) {
    if (base !== '') {
      try { validateBranch(base); } catch { fail('--base takes the name of the branch its PR targets'); }
    }
    if (!builderRepo(needSite(site)).remote) fail(`--base is for a board whose finish pushes its task's branch (a PR or a remote); this board lands in its own folder`);
    if (base === '') delete item.base; else item.base = base;
  }
  // docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md: a verified branch that waits for the owner's Merge.
  if (mergeReady !== undefined) {
    item.merge_ready = { branch: mergeReady, at: new Date().toISOString() };
    item.branch = mergeReady;
  }
  if (done) { delete item.merge_ready; delete item.waits_on_owner; }
  // docs/adr/2026-11-18-0200-a-release-card-waits-in-in-review-until-its-release-is-published.md: a land that is a
  // release ({version, pkg}, finish.mjs) keeps it for the hub's watch (hub/release-watch.mjs); any other close, the
  // owner's Done or the orchestrator's, ends it.
  if (done && release) item.release = { version: release.version, tag: `v${release.version}`, ...(release.pkg ? { pkg: release.pkg } : {}), since: new Date().toISOString(), state: release.untagged ? 'untagged' : 'publishing' };
  else if (done) delete item.release;
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
    checkSizeAndNotes(key, item);
    // A title builder start would refuse is caught here, when the orchestrator readies the card, not at the pull.
    const untitled = startTitleFault(key, item.title);
    if (untitled) fail(untitled);
  }
  // docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md: a staging card goes ready on
  // the orchestrator's judgment against the whole board, which --text records in its notes.
  const judged = phase === 'ready' && item.phase === 'staging' && fromAsk === undefined;
  if (judged && said === undefined) fail(`${key} goes ready from staging on your judgment: pass --text "<what you checked it against on the board>", which goes into its notes`);
  if (phase === 'ready' && !judged && said !== undefined && fromAsk === undefined && !done) fail(`${key} reads ${item.phase || 'no phase'}, not staging, so there is no judgment for --text to record`);
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
    delete item.staged_at;
    delete item.unfiled;
    delete item.filed_held;
    delete item.ready_main;
    if (phase === 'ready') item.ready_at = new Date().toISOString(); else delete item.ready_at;
    if (phase === 'staging') item.staged_at = new Date().toISOString();
    if (triaged) item.triaged = { at: new Date().toISOString(), phase };
  }
  // docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md: a Next never asks for the phase the card is in.
  if (item.phase === 'ready' && ASKS_READY.test(item.next ?? '')) fail(`${key} would read ready with Next "${item.next}", which asks for the phase it is already in; pass --next with what happens next, or --clear-next`);
  if (built) item.install = built;
  if (built === null) delete item.install;
  // docs/adr/2026-11-03-0237-an-in-progress-card-always-has-a-builder-line-or-a-next.md: a build's start goes with its record.
  // docs/adr/2026-11-19-1200-clearing-a-next-hands-the-card-to-the-restart.md: clearing a Next is the way to the restart.
  if (!owedBefore && !start && !clearNext && owesNext(item, records)) fail(`that leaves ${key} In Progress with nothing building and no Next; pass --next "<what happens next>"`);
  // docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md: a block on a card In
  // Progress keeps it there, and asks its running build, the board's or a session's, to pause at its next stopping
  // point (requestPause); one already landing lands, since land refuses a blocked card.
  const blocking = (deps !== undefined || blockedUntil) && !done;
  // The moves this write makes (docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md): a close
  // and a block write their own lines, the rest a move line.
  const repo = boardRepoOf(site, itemFile);
  let moveLine = null;
  const moveTo = (to, why) => { if (item.lane !== to && placeIn(item, to, undefined, movedPhase(item, to, landed)) !== undefined && why) moveLine = `Moved to ${LANES[to]}: ${why}`; };
  if (done) moveTo('done', null);
  else if (handover && item.lane !== 'done') {
    moveTo('review', pr !== undefined ? `PR ${prNames([].concat(pr).map(parsePRRef), repo)} opened` : pushed !== undefined ? `${pushed} pushed for its merge` : 'verified, it waits for your Merge');
  } else if (start && !wasFinished) {
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
  // The card as the board draws it after this write, for what a block or its lifting does.
  const after = blocking || lifted ? await shownCard(site, key) : null;
  const blocked = blocking && inProgress(item, records, after.finished) ? blockWordsOf(after) : '';
  await writeReply();
  if (madeAtReady) await appendStatus(site, key, 'ticket-made', { ticket: item.ticket });
  if (moveLine) await appendLine(threadFile(site, key), { ts: item.lane_at, who: 'claude', kind: MOVE, text: moveLine });
  if (judged) await appendNotes(site, key, `Ready (orchestrator, ${noteStamp()})`, said);
  if (readied) await appendCommand(site, key, { command: 'readied', ...(readiedLine === undefined ? {} : { text: readiedLine }) });
  // The line and the wait share one moment, as stage writes them (domain.mjs markWaitStarts).
  if (phase === 'staging') await appendCommand(site, key, { command: 'staged', ts: item.staged_at });
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
    const written = command ? await appendCommand(site, key, { command, text: lastLine.text, who })
      : lastLine.status ? await appendStatus(site, key, ...lastLine.status) : await appendMessage(site, key, { text: lastLine.text });
    resolved.push(...written.lines);
  }
  if (title !== undefined && site && item.lane === 'todo') await clearRefusal(site, key);
  // The ticket stays open while the card waits on its owner step or its release, while another open card shares it, and
  // when the card closed on a PR closed unmerged.
  const keepsTicket = done && (item.owner_step || item.release || closing?.[0] === 'prs-closed' || await sharedOpen(site, key, item.ticket));
  const target = keepsTicket ? null : ticketTarget({ start, done, handover });
  const moved = target && await moveTicket(await boardSource(site), item, target, { ...options, repo });
  if (moved) {
    const { line, lines } = await appendStatus(site, key, moved.kind, moved.inputs);
    resolved.push(...lines, line.text);
  }
  if (target) await keepTicketRetry(site, key, moved?.kind === 'ticket-failed' ? target : null);
  // A builder that forgot builder done would keep the card In Progress after it was handed back; a hand-back's records
  // close marked handed_back, and a handover or a close ends the hand-back.
  if (handover || done || handBack) {
    await closeBuilders(source.dir, item.id, done, handBack ? { handedBack: new Date().toISOString() } : { endHandBack: true });
    await publishStaged(site, key);
  }
  // An ask is in one card's thread: becoming this item moves it out of a card it was folded into.
  const links = ask ? await readAskLinks(site) : {};
  if (routeRecord(links, ask) !== undefined) { delete links[ask]; await writeJSON(askLinksFile(site), { links }); }
  if (lifted && !after.finished && !after.blockedBy.length) {
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
    if (await markUnblocked(site, k, line.ts, landedFiles)) await appendStatus(site, k, 'recheck-released', { card });
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
    const card = await shownCard(site, key);
    if (!card.blockedUntil && !card.blockedBy.length) await appendEvent({ dir: site }, 'card-unblocked', { key, until });
  }
  setHold(item, null);
  await writeJSON(source.file, itemFile);
}

// docs/adr/2026-11-22-0200-a-card-carries-board-only-tags.md
// A tag's name as stored: trimmed, its runs of spaces one space. A tag is free text of 1 to 48 characters with no comma
// (item set --tag takes a comma list); two names differing only in case are the same tag.
const TAG_MAX = 48;
export function tagName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) fail('a tag needs a name');
  if (name.includes(',')) fail(`a tag takes no comma: "${name}"`);
  if (name.length > TAG_MAX) fail(`a tag is ${TAG_MAX} characters at most: "${name}" is ${name.length}`);
  return name;
}
const sameTag = (a, b) => a.toLowerCase() === b.toLowerCase();
// A card's tags with add put on (each it lacks, in order) and drop taken off, matched whatever their case. → [names]
export function retagged(tags = [], { add = [], drop = [] }) {
  const kept = tags.filter((t) => !drop.some((d) => sameTag(t, d)));
  for (const t of add) if (!kept.some((k) => sameTag(k, t))) kept.push(t);
  return kept;
}
// The tags --tag puts on card key and --untag takes off (comma lists, or the one name the owner's Tag… picker sends), each
// change a Tagged or Untagged line in its thread from who, with the tap's sendId. A card in any lane takes them, Done
// included. → {tagged, untagged} with the names changed, or null when nothing changed.
export async function tagItem(site, key, { tag, untag, who = 'claude', sendId }) {
  const names = (list) => (list === undefined ? [] : Array.isArray(list) ? list : String(list).split(',')).map(tagName);
  const add = names(tag);
  const drop = names(untag);
  const { source, itemFile, item } = await loadItem(site, key);
  const before = item.tags || [];
  const after = retagged(before, { add, drop });
  const tagged = after.filter((t) => !before.includes(t));
  const untagged = before.filter((t) => !after.includes(t));
  if (!tagged.length && !untagged.length) return null;
  if (after.length) item.tags = after; else delete item.tags;
  await writeJSON(source.file, itemFile);
  // An item file off any board (no --site) has no thread.
  if (!site) return { tagged, untagged };
  for (const t of untagged) await appendCommand(site, key, { who, command: 'untagged', text: `${COMMANDS.untagged} ${t}`, sendId });
  for (const t of tagged) await appendCommand(site, key, { who, command: 'tagged', text: `${COMMANDS.tagged} ${t}`, sendId });
  return { tagged, untagged };
}

// docs/adr/2026-11-22-1200-an-archived-tag-greys-out-and-leaves-the-picker.md
// The board's archived tags, data/tags.json {archived: [names]}: tags the picker no longer offers, still on their cards.
// Names match whatever their case; a tag no card carries can be archived too. Writes run one at a time.
export const tagsFile = (site) => path.join(site, 'data', 'tags.json');
export const readArchivedTags = async (site) => (await readJSON(tagsFile(site), { archived: [] })).archived || [];
let tagWrites = Promise.resolve();
// Archives tag name (archived true) or restores it. → true, or false when it already was so.
export function archiveTag(site, name, archived) {
  const tag = tagName(name);
  const write = tagWrites.then(async () => {
    const before = await readArchivedTags(site);
    const after = archived ? (before.some((t) => sameTag(t, tag)) ? before : [...before, tag]) : before.filter((t) => !sameTag(t, tag));
    if (after.length === before.length) return false;
    await writeJSON(tagsFile(site), { archived: after });
    return true;
  });
  tagWrites = write.catch(() => {});
  return write;
}

// The owner's Block, Unblock, Done or Reopen tap (card-hold {key, hold, until?}, card-done {key} or card-reopen {key}),
// or a Tag… pick (card-tag {key, tag, on}, tagItem),
// recorded in the item file as the board server takes it, with a thread line; a Done closes the card and unblocks blocked cards as item set --done does
// (docs/adr/2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md). → the item set result, or null
// when there is nothing to write.
export async function recordOwnerTap(site, kind, data) {
  const key = String(data?.key || '');
  if (kind === 'tag-archive') return archiveTag(site, data.tag, Boolean(data.on));
  if (kind === 'card-tag') return tagItem(site, key, { [data.on ? 'tag' : 'untag']: [String(data.tag ?? '')], who: 'love', sendId: data.sendId });
  const { file: slug, id } = parseKey(key);
  const { source, itemFile } = await loadItemFile(site, slug);
  // The owner's line, so it answers none of their messages that wait on Claude.
  // docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md: each tap's line is its status line.
  const said = { text: COMMANDS.done, who: 'love', command: 'done' };
  const item = itemFile.items.find((it) => it.id === id) || fail(`item file "${slug}" has no item "${id}"`);
  // docs/adr/2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md: a Done card's Reopen moves it
  // docs/adr/2026-11-18-2359-a-done-card-stays-done-when-commented-and-only-reopen-moves-it-back.md: a Done card's
  // Reopen moves it back to In Review, for more discussion on that work; a card not in Done has nothing to reopen.
  if (kind === 'card-reopen') {
    if (item.lane !== 'done') return null;
    await appendCommand(site, key, { who: 'love', command: 'reopened' });
    return moveCard(site, key, 'review', 'you reopened it');
  }
  // A staged or ready Todo card's Cancel takes it back to discussing, its Implement owed again, its ticket kept;
  // a card in any other place or phase has nothing to cancel.
  if (kind === 'card-cancel') {
    if (item.lane !== 'todo' || !['staging', 'ready'].includes(item.phase)) return null;
    await appendCommand(site, key, { who: 'love', command: 'cancelled' });
    delete item.staged_at;
    delete item.ready_at;
    delete item.ready_main;
    item.phase = 'discussing';
    await writeJSON(source.file, itemFile);
    return 'discussing';
  }
  // A Done card waiting on its owner step or its release closes on the owner's Done; any other card in Done has nothing
  // to write.
  const stepOpen = kind === 'card-done' && Boolean(item.owner_step || item.release);
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
  return appendCommand(site, key, data.hold ? { text: at ? `${COMMANDS.hold} until ${at}` : COMMANDS.hold, who: 'love', command: 'hold' }
    : { who: 'love', command: 'resume' });
}

// --check's text → its stored form, or refuses it (shared/owner-check.mjs parseCheck).
export function checkSpec(value) {
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

// docs/adr/2026-11-18-0200-a-release-card-waits-in-in-review-until-its-release-is-published.md: the hub's release watch
// (hub/release-watch.mjs) read version's tag run and npm. found: {state, url, failure, words}, state publishing,
// published or failed, url the run's, failure a failed run's first failing test or null, words what published found. A
// change of state is written on the item; published and failed each post a line, failed red, and failed wakes the
// orchestrator with release-failed {key, version, url, failure}. A card whose release moved on is left alone.
// → true when it wrote.
export async function markRelease(site, key, version, { state, url, failure, words }) {
  const { source, itemFile, item } = await loadItem(site, key);
  const was = item.release;
  if (!was || was.version !== version || item.lane !== 'done') return false;
  if (was.state === state && was.url === url) return false;
  item.release = { ...was, state, ...(url ? { url } : {}), ...(failure ? { failure } : {}) };
  if (!failure) delete item.release.failure;
  await writeJSON(source.file, itemFile);
  const link = url ? { link: url } : {};
  if (state === 'published') await appendStatus(site, key, 'release-published', { version, words }, link);
  if (state === 'failed') {
    await appendStatus(site, key, 'release-failed', { version, failure }, link);
    await appendEvent({ dir: site }, 'release-failed', { key, version, url, failure });
  }
  return true;
}

// docs/adr/2026-11-21-2349-a-failed-ticket-move-is-retried-on-the-hubs-poll-and-an-untagged-release-offers-its-tag.md
// A card's ticket move that failed (tickets.mjs moveTicket's ticket-failed) is kept on the item as ticket_retry, the
// target it asked for, for the hub's poll to try again (hub/ticket-retry.mjs); a later move of the card's ticket that
// went through, or needed nothing, clears it.
async function keepTicketRetry(site, key, target) {
  const { source, itemFile, item } = await loadItem(site, key);
  if ((item.ticket_retry ?? null) === target) return;
  if (target) item.ticket_retry = target; else delete item.ticket_retry;
  await writeJSON(source.file, itemFile);
}

// One retry of the card's failed ticket move, with no new line while it fails again: a card no longer where the move
// wanted it (a Done ticket's card reopened) has it dropped. → true when the move went through.
export async function retryTicketMove(site, key, ctx = {}) {
  const { itemFile, item } = await loadItem(site, key);
  const target = item.ticket_retry;
  if (!target) return false;
  if (target === 'done' && item.lane !== 'done') { await keepTicketRetry(site, key, null); return false; }
  const moved = await moveTicket(await boardSource(site), item, target, { ...ctx, repo: boardRepoOf(site, itemFile) });
  if (moved?.kind === 'ticket-failed') return false;
  await keepTicketRetry(site, key, null);
  if (moved) await appendStatus(site, key, moved.kind, moved.inputs);
  return true;
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
export async function depList(site, slug, deps) {
  const list = [...new Set(String(deps).split(',').map((d) => d.trim()).filter(Boolean))];
  for (const d of list) await loadItem(site, depKey(slug, d));
  return list;
}

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
// --parent for card key of item file slug (key null for a new card): the key of a card that exists, neither key itself nor
// one of its descendants (the walk up its ancestors stops at one that no longer exists); "" is none.
export async function parentKey(site, slug, key, parent) {
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
export async function relatedKeys(site, key, value, flag) {
  const slug = key.split('/')[0];
  const list = [...new Set(String(value).split(',').map((r) => r.trim()).filter(Boolean).map((r) => depKey(slug, r)))];
  if (list.includes(key)) fail(`${flag}: a task can't be related to itself`);
  for (const r of list) await loadItem(site, r);
  return list;
}

// docs/adr/2026-11-16-1700-a-filed-task-links-where-it-came-from-and-the-tasks-it-names.md
export const UNSOURCED = 'a task you file names where it came from';
export const SPLIT_NEEDS_PARENT = "--split copies the Parent's gates, so it goes with --parent <the task split>";
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
export async function namedTasks(site, words) {
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
export async function replyFirst(site, keys, replyOn) {
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
export async function refuseUnlinked(site, what, words, links) {
  const unlinked = (await namedTasks(site, words)).filter((n) => !links.includes(n.key));
  if (!unlinked.length) return;
  const one = unlinked.length === 1;
  fail(`${what} names ${listed(unlinked.map((n) => `${n.name} (${n.key})`))} without linking ${one ? 'it' : 'them'}: add --relate ${unlinked.map((n) => n.key).join(',')}, or link ${one ? 'it' : 'each'} as --parent, --blocked-by or --blocks`);
}
// The latest text of ask eventId: its last edit's, else its own.
export async function askWordsOf(site, eventId) {
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
export async function refuseUnplaced(site, what, words, { links, ticket, repo, canTicket }) {
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
export async function linkedWith(site, key) {
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
export async function linksOf(site, key) {
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
export async function postLinkLines(site, key, before, after, { spunOut = false, held = false } = {}) {
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

export const boardSource = async (site) => storedTickets((await boardConfig(site)).tickets);

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
  const card = await shownCard(site, key);
  if (card.finished) fail(`${key} is done`);
  // docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md: auto-merge's refusal too.
  const blocked = blockWordsOf(card);
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
  const card = await shownCard(site, key);
  if (!item.merge_ready || card.finished) fail(`${key} isn't waiting for its Merge`);
  const blocked = blockWordsOf(card);
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
export async function nextTaskId(site) {
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

export const ticketWrite = (site, fn) => withFileLock(path.join(site || wavesDir(), 'tickets'), fn, { heartbeat: true });
export const setItem = (site, key, changes, options) => (changes.ticket !== undefined || changes.newTicket || changes.phase === 'ready'
  ? ticketWrite(site, () => changeItem(site, key, changes, options)) : changeItem(site, key, changes, options));
export const addItem = (site, key, details, options) => ticketWrite(site, () => createItem(site, key, details, options));

// Card added, just written, blocks each of blocked (ids in its item file, or keys), which gains it as a dep, and waits
// on each of deps: on a site, an Unblocks and a Blocked by line, one in each thread, for each.
export async function blockLines(site, added, blocked, deps, options) {
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
async function createItem(site, key, { title, notes, notesFrom, before, deps, ticket, newTicket, pickUpAt, block, parent, split, size, model, phase, state, relate, fromAsk, text: said, implement, intake = false, filed = false, replyOn }, options) {
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
  if (ask && implementAsk(await readLog(path.join(site, 'data', 'events.jsonl')), ask)) fail(IMPLEMENT_NOT_FILED(ask));
  if (ask && phase === undefined && !hold) fail(FROM_ASK_PHASE);
  // docs/adr/2026-11-17-0543-a-quick-ask-is-triaged-into-staging.md: a task goes ready only from staging.
  if (phase === 'ready') fail(`item add files a task discussing, grilling or prototyping; ${NOT_STAGED}`);
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
  if (site) await postLinkLines(site, added, { related: new Set(), parent: null }, await linksOf(site, added), { spunOut: true });
  if (said !== undefined && !ask) await appendMessage(site, added, { text: said });
  if (implement) await markWaiting(site, added, 'implement');
  if (proposes) await markDescription(site, { description_proposal: added, description_checked_at: created });
  return { file: source.file, key: added, lines: [] };
}

// docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md
// data/done-archive.json {cards: [{key, file, archived_at, closed_at, item, questions, asks}]}, newest closed first:
// the Done cards that left the board, each with when it closed (its Done card's sortAt), its item file entry and its
// resolved questions from owner.json. The board build never reads it; GET /api/done builds a page of its cards as they
// page in (docs/adr/2026-11-04-1056-archived-done-cards-are-built-as-they-page-in.md), and GET /api/thread reads an
// archived card's entry. An empty archive is no file. Its thread, notes and builder records stay where they are. asks
// are the asks the card was made from that its move linked to it in data/ask-links.json, so the board still reads them
// as gone into that card.
export const archiveFile = (site) => path.join(site, 'data', 'done-archive.json');
export const archiveWrite = (site, fn) => withFileLock(path.join(site, 'done-archive'), fn, { heartbeat: true });
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
// The entries holding every word, any case, in their title, key, id or ticket: the board search's match (public/ui-cards.js
// cardMatches) over what an entry holds. No words keeps every entry.
export const archiveMatching = (entries, words) => entries.filter((a) => {
  const hay = [a.item?.title, a.key, a.item?.id, a.item?.ticket, ...(a.item?.linear || [])].filter(Boolean).join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
});
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
export async function writeArchive(site, cards) {
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
