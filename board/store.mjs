// The board's data files and the only code that writes them, uploads included. A site is a directory under
// ~/.claude/kickflip/sites; `site` null means a board over ~/.claude/waves alone. Every write
// is validated first, JSON files are replaced by rename, and JSONL files are appended to.
import fs from 'node:fs/promises';
import { constants as fsConstants, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUILD_REFUSED, BUILDER_ASK, COMMANDS, ITEM_STATUSES, MAX_IMPLEMENTERS, MAX_PLANNERS, builds, lineupPhases, mergeBlockers, modelName, noTakePicked, ownerQuestion, plans, QUESTION_REOPEN, PLANNER_WORD, providerOf, owesNext, pushTag, refOf, roundOf, roundSettledBy, VISUAL, visualAgent } from './domain.mjs';
import { GITHUB_STATE, appendEvent, listBoards, samePath } from '../hub/boards.mjs';
import { readUsageGate, pauseReason, pauseReasonFor, heldFor, holdsWork, builderPick, pauseEnd } from '../shared/usage-gate.mjs';
import { reviseQueued, pushKindError, readClaudeModel } from '../hub/push.mjs';
import { AT_RE } from '../hub/duration.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { ticketSource, ticketIn, resolveTicket, ticketTarget, moveTicket, titleTickets, cardIdOf } from './tickets.mjs';
import { LINEAR_NEEDS_KEY, linearStatus, linearWorks } from '../hub/linear.mjs';
import { validateBranch } from '../hub/repos.mjs';
import { withFileLock } from '../hub/locks.mjs';
import { audit, auditLines, boardAudit, readAudit } from '../shared/audit.mjs';
import { merge3 } from './merge3.mjs';
import { fetchPR, reportOf, githubLogin, postToPR, postReview, reviewsSince, CLAUDE_PREFIX, CLAUDE_MARK } from '../hub/pr-report.mjs';
import { allLanded, cardPRs, hasPR, parsePRRef, prKeyOf, prNames, prURL, storedPRs } from '../shared/card-prs.mjs';
import { reviewLinks, topicItems, reviewersOf } from './review.mjs';
import { readiness } from '../hub/readiness.mjs';
import { slackDay } from '../hub/slack.mjs';
import { storedPath } from '../bin/install.mjs';
import { readPermissions } from './permissions.mjs';
import { validBuildTarget } from './build-script.mjs';
import { parseCheck, checkText } from '../shared/owner-check.mjs';
import { RuleError, rulesOf, addRule, editRule, removeRule, applyRules, readHubRules, writeHubRules } from '../hub/rules.mjs';
import { shareEntries, validLogin } from '../hub/share.mjs';

export class BoardError extends Error {}
const fail = (msg) => { throw new BoardError(msg); };

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

async function replace(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
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
}

export async function siteDir(route) {
  if (!/^[\w-]+$/.test(route || '')) fail(`--site takes a route such as ios-orchestrator, not "${route}"`);
  const dir = path.join(sitesDir(), route);
  if (!(await fs.stat(dir).then((s) => s.isDirectory(), () => false))) fail(`no site at ${dir}`);
  return dir;
}

export const boardConfig = async (site) => ({ title: 'Board', items: 'waves', ...(site ? await readJSON(path.join(site, 'board.json'), {}) : {}) });

// Each wave the board shows: {slug, dir, file}. Builder records sit in <dir>/agents.
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
// data/staged-questions.json {<wave>/<id>: [question]}: questions added to a card while a planner of it runs, held back from
// owner.json until it finishes (docs/adr/2026-11-06-0100-a-grills-questions-appear-together-once-the-grill-is-done.md).
const stagedFile = (site) => path.join(site, 'data', 'staged-questions.json');
const needSite = (site) => site || fail('this command needs --site <route>');
const text = (v, name) => (typeof v === 'string' && v.trim() ? v.trim() : fail(`${name} must be non-empty text`));
const optional = (v, check) => (v === undefined ? undefined : check(v));
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
  return m ? { wave: m[1], id: m[2] } : fail(`expected <wave>/<id>, not "${key}"`);
}

async function loadWave(site, slug) {
  const source = (await itemSources(site)).find((s) => s.slug === slug) || fail(`this board has no wave "${slug}"`);
  const wave = await readJSON(source.file, null);
  if (!wave || !Array.isArray(wave.items)) fail(`${source.file} is not a wave file with items[]`);
  return { source, wave };
}

// A card in the archive comes back to its wave file for any command that names it (restoreArchived).
async function loadItem(site, key) {
  const { wave: slug, id } = parseKey(key);
  let loaded = await loadWave(site, slug);
  if (!loaded.wave.items.some((it) => it.id === id) && await restoreArchived(site, key)) loaded = await loadWave(site, slug);
  const item = loaded.wave.items.find((it) => it.id === id) || fail(`wave "${slug}" has no item "${id}"`);
  return { ...loaded, item };
}

export async function writeReply(site, eventId, html) {
  needSite(site);
  domId(eventId, 'the event id');
  const event = (await readLines(path.join(site, 'data', 'events.jsonl'))).find((e) => e.id === eventId);
  if (!event) fail(`no event "${eventId}" in this site's data/events.jsonl`);
  const file = path.join(site, 'data', 'replies', `${eventId}.html`);
  await replace(file, text(html, 'the reply'));
  const key = event.kind === 'ask' ? `ask:${eventId}` : event.kind === 'item-message' && typeof event.data?.key === 'string' ? event.data.key : null;
  const lines = key ? await freshenPush(site, key, htmlText(html)) : [];
  // docs/adr/2026-11-01-1813-an-answered-question-stops-waiting-once-claude-acts-on-its-card.md
  const triaged = event.kind === 'wave-triage' ? ['lineup', 'wave'].filter((k) => typeof event.data?.[k] === 'string').map((k) => `${k}:${event.data[k]}`) : [];
  const topic = event.kind === 'ask' ? `item:ask:${eventId}` : triaged[0];
  if (topic) lines.push(...await resolveAnsweredOn(site, topic, 'Acted on: replied'));
  return { file, lines };
}

// An event the watcher handed the session, such as an ask or a thread message, reads "Working on it" until
// Claude replies to it (or, in a thread, writes a later line); domain.mjs decides which.
const workingFile = (site) => path.join(site, 'data', 'working.json');
export async function readWorking(site) {
  return (await readJSON(workingFile(site), {})).events || {};
}

// The kinds bin/wait-events.mjs marks working as it hands them to the session (docs/adr/2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md).
export const WORKING_KINDS = ['ask', 'item-message', 'wave-triage', 'overnight-triage'];
export async function markWorking(site, eventIds) {
  if (!eventIds.length) return;
  const at = new Date().toISOString();
  const events = await readWorking(site);
  await writeJSON(workingFile(site), { events: { ...events, ...Object.fromEntries(eventIds.map((id) => [id, routeRecord(events, id) || at])) } });
}

// Replies ride along on the next push (docs/adr/2026-10-29-1639-replies-ride-along-on-the-next-push.md).
const pushStateFile = (site) => path.join(site, 'data', 'push-state.json');

// Reply files modified after the site's last recorded push and no later than `until`; 0 before its first push.
export async function repliesSincePush(site, until) {
  needSite(site);
  const last = Date.parse((await readJSON(pushStateFile(site), {})).last_push);
  if (Number.isNaN(last)) return 0;
  const dir = path.join(site, 'data', 'replies');
  const names = (await fs.readdir(dir).catch(() => [])).filter((n) => /\.(html|json)$/.test(n));
  const times = await Promise.all(names.map((n) => fs.stat(path.join(dir, n)).then((st) => st.mtimeMs, () => 0)));
  return times.filter((t) => t > last && t <= until.getTime()).length;
}

export async function recordPush(site, at) {
  await writeJSON(pushStateFile(needSite(site)), { last_push: at.toISOString() });
  return pushStateFile(site);
}

const KICKFLIP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kickflip.mjs');
function pushCommand() {
  if (!process.env.KICKFLIP_PUSH_CMD) return [process.execPath, KICKFLIP, 'push'];
  try {
    const cmd = JSON.parse(process.env.KICKFLIP_PUSH_CMD);
    if (Array.isArray(cmd) && cmd.length && cmd.every((a) => typeof a === 'string')) return cmd;
  } catch {}
  throw new BoardError('KICKFLIP_PUSH_CMD must be a JSON array of strings');
}

// Runs kickflip push with {kind, title, body?, url?, tag?, urgent?, now?}, adding "· and N replies" to the body for the
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
  const args = [...pre, ...Object.entries(flags).flatMap(([k, v]) => (v === undefined ? [] : [`--${k}`, v])), ...(f.urgent ? ['--urgent'] : []), ...(f.now ? ['--now'] : [])];
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

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function htmlText(html) {
  return html.replace(/<details[\s\S]*?<\/details>/gi, '\n').replace(/<(?:br|\/?(?:p|div|li|ul|ol|h\d|blockquote|pre|tr|summary))\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(?:#(x[\da-f]{1,6}|\d{1,7})|(\w+));/gi, (m, num, name) => {
      const code = num && parseInt(num.replace(/^x/i, ''), /^x/i.test(num) ? 16 : 10);
      return num ? (code <= 0x10ffff ? String.fromCodePoint(code) : m) : routeRecord(ENTITIES, name.toLowerCase()) ?? m;
    });
}

// Where a push lands (docs/adr/2026-10-29-1639-a-push-lands-where-the-owner-answers.md). A card or ask link (#item=) gains
// &reply, so the board opens that thread with its reply box focused. A page other than the board gains from=push, so
// the back arrow of a page outside the page tree goes to the card or the board
// (docs/adr/2026-10-30-1125-back-follows-the-page-tree.md), and a prototype page tied to a question (?q=) sends the owner to the
// card's thread instead once that question has a pick.
export function pushUrl(url) {
  if (!url || !url.startsWith('/')) return url;
  const u = new URL(url, 'http://board');
  if (/^#item=[^&]+$/.test(u.hash)) u.hash = `${u.hash}&reply`;
  if (/\/[\w-]+\.html$/.test(u.pathname) && !u.pathname.endsWith('/index.html')) u.searchParams.set('from', 'push');
  return u.pathname + u.search + u.hash;
}
const threadUrl = (site, key) => `/${path.basename(site)}/#item=${encodeURIComponent(key)}&reply`;

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

const VIA = ['github', 'slack'];
// key is <wave>/<id>, or ask:<event id> for an ask's thread. by: the shared person whose tap an owner line is, by name
// (docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md).
// command is a button's key (domain.mjs COMMANDS), which makes the line its status line.
export async function appendThread(site, key, { text: body, link, log, who = 'claude', via, kind, by, command }) {
  needSite(site);
  if (String(key).startsWith('ask:')) await checkAsk(site, key.slice(4), 'the ask');
  else await loadItem(site, key);
  if (!/^[^\n]{1,40}$/.test(who.trim())) fail('--who takes claude, love or a reviewer\'s name');
  if (via !== undefined && !VIA.includes(via)) fail(`--via takes ${VIA.join(' or ')}`);
  const line = { ts: new Date().toISOString(), who: who.trim(), text: text(body, '--text'), link: optional(link, (v) => pageUrl(v, '--link')), log, via, kind, by, command };
  const file = threadFile(site, key);
  await appendLine(file, line);
  return { file, lines: line.who === 'claude' && !via ? await freshenPush(site, key, line.text) : [] };
}

// An ask folded into an existing work item: data/ask-links.json ({links: {<ask event id>: <wave>/<id>}}) names the item,
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
    const wave = source && await readJSON(source.file, null);
    if (!wave) return m[2];
    const card = (wave.items || []).find((it) => it.id === m[2]);
    return refOf(wave, card || { id: m[2] }, tickets);
  }
  const folded = site ? routeRecord(await readAskLinks(site), ask) : undefined;
  if (folded) return cardName(site, folded);
  for (const s of sources) {
    const wave = await readJSON(s.file, null);
    const it = (Array.isArray(wave?.items) ? wave.items : []).find((i) => i.from_ask === ask);
    if (it) return refOf(wave, it, tickets);
  }
  return `task ${ask}`;
}

// The card an event in data/events.jsonl belongs to (cardName), or "the <kind> event" for one about no card.
export async function eventCard(site, eventId) {
  const e = (await readLines(path.join(site, 'data', 'events.jsonl'))).find((x) => x.id === eventId);
  if (e?.kind === 'ask') return cardName(site, `ask:${eventId}`);
  if (typeof e?.data?.key === 'string') return cardName(site, e.data.key);
  return `the ${e?.kind} event`;
}

export async function relateAsk(site, eventId, key, summary) {
  needSite(site);
  domId(eventId, 'the event id');
  const known = (await readLines(path.join(site, 'data', 'events.jsonl'))).some((e) => e.id === eventId && e.kind === 'ask');
  if (!known) fail(`no ask "${eventId}" in this site's data/events.jsonl`);
  await refuseMoved(site, eventId);
  await loadItem(site, key);
  const line = { ts: new Date().toISOString(), who: 'claude', text: text(summary, '--summary') };
  const links = await readAskLinks(site);
  await writeJSON(askLinksFile(site), { links: { ...links, [eventId]: key } });
  await appendLine(threadFile(site, key), line);
  return askLinksFile(site);
}

// Moves a folded ask back out of the card it was folded into, to a card of its own.
export async function unfoldAsk(site, eventId) {
  await checkAsk(site, eventId, 'the ask');
  const links = await readAskLinks(site);
  if (routeRecord(links, eventId) === undefined) fail(`ask "${eventId}" is not folded into a card`);
  delete links[eventId];
  await writeJSON(askLinksFile(site), { links });
  return askLinksFile(site);
}

// Claude's latest mark on each ask, data/ask-progress.json {asks: {<ask event id>: {state, at, next?, moved?}}}: progress
// keeps an answered ask in In Progress until the owner's ask-done or a done mark is newer
// (docs/adr/2026-10-29-1639-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md). moved {route, title, id} is a done
// mark that names the ask moveAsk sent to another board.
const askProgressFile = (site) => path.join(site, 'data', 'ask-progress.json');
export async function readAskProgress(site) {
  return (await readJSON(askProgressFile(site), {})).asks || {};
}

async function refuseMoved(site, eventId) {
  const moved = routeRecord(await readAskProgress(site), eventId)?.moved;
  if (moved) fail(`ask "${eventId}" was moved to /${moved.route}; it lives there now`);
}

export async function markAsk(site, eventId, state, next) {
  await checkAsk(site, eventId, 'the ask');
  await refuseMoved(site, eventId);
  const asks = await readAskProgress(site);
  await writeJSON(askProgressFile(site), { asks: { ...asks, [eventId]: { state, at: new Date().toISOString(), ...(next === undefined ? {} : { next: text(next, '--next') }) } } });
  return askProgressFile(site);
}

// Why an ask is no longer New on this board, or null. An ask that became work items is New to moveAsk while none of
// them has started; it returns them as `items`.
const UNSTARTED = [undefined];
async function askNotNew(site, eventId, events) {
  const named = `ask "${eventId}"`;
  if (events.some((e) => e.kind === 'ask-withdrawn' && e.data?.id === eventId && !e.data?.key)) return { why: `${named} was deleted by the owner` };
  const mark = routeRecord(await readAskProgress(site), eventId);
  if (mark?.moved) return { why: `${named} was already moved to /${mark.moved.route}` };
  const folded = routeRecord(await readAskLinks(site), eventId);
  if (folded) return { why: `${named} is folded into ${folded}; run ask unfold ${eventId} first` };
  const items = [];
  for (const s of await itemSources(site)) {
    const wave = await readJSON(s.file, null);
    for (const it of Array.isArray(wave?.items) ? wave.items : []) if (it.from_ask === eventId) items.push({ key: `${s.slug}/${it.id}`, it });
  }
  const started = items.find(({ it }) => hasPR(it) || !UNSTARTED.includes(it.status));
  if (started) return { why: `${named} became ${started.key}, which has started` };
  if (items.length) return { items: items.map((i) => i.key) };
  const replied = await Promise.all(['html', 'json'].map((ext) => fs.stat(path.join(site, 'data', 'replies', `${eventId}.${ext}`)).then(() => true, () => false)));
  const answered = replied.some(Boolean) || Boolean(mark) || events.some((e) => e.kind === 'ask-done' && e.data?.id === eventId)
    || (await readLines(threadFile(site, `ask:${eventId}`))).some((m) => (m.who || 'claude') === 'claude' && m.kind !== 'status');
  return answered ? { why: `${named} is not New: Claude already answered it` } : null;
}

// A copy of an upload in another site's data/uploads under a fresh stored name, or the file's name alone when this
// site no longer has it, so the other board never shows a broken link.
async function copyUpload(from, to, f) {
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
// of its uploads and `from {route, title, id}`, which wakes that board's session; here, a done mark naming it, and a
// line in the ask's thread linking to its card there. Work items the ask became, none of them started, are dropped.
export async function moveAsk(site, eventId, route) {
  needSite(site);
  domId(eventId, 'the event id');
  if (typeof route !== 'string' || !route.trim()) fail('ask move needs --to <route>, the board to move it to');
  const events = await readLines(path.join(site, 'data', 'events.jsonl'));
  const ask = events.find((e) => e.id === eventId && e.kind === 'ask') || fail(`no ask "${eventId}" in this site's data/events.jsonl`);
  const boards = listBoards();
  const target = boards.find((b) => b.route === route)
    || fail(`--to ${route}: no board at /${route} in the hub's manifest; the boards are ${boards.map((b) => b.route).join(', ') || 'none'}`);
  if (samePath(target.dir, site)) fail(`--to ${route}: that is this board`);
  const state = await askNotNew(site, eventId, events);
  if (state?.why) fail(state.why);
  const edits = events.filter((e) => e.kind === 'ask-edited' && e.data?.id === eventId && typeof e.data?.text === 'string')
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const edited = edits.at(-1);
  const files = [];
  for (const f of [...(ask.data?.files || []), ...edits.flatMap((e) => e.data.files || [])]) files.push(await copyUpload(site, target.dir, f));
  const from = { route: path.basename(site), title: (await boardConfig(site)).title, id: eventId };
  const body = edited ? edited.data.text : ask.data?.text || '';
  const id = await appendEvent(target, 'ask', { text: body, ...(files.length ? { files } : {}), from });
  const moved = { route, title: target.title, id };
  const at = new Date().toISOString();
  const asks = await readAskProgress(site);
  await writeJSON(askProgressFile(site), { asks: { ...asks, [eventId]: { state: 'done', at, moved } } });
  const link = `/${route}/#item=${encodeURIComponent(`ask:${id}`)}`;
  await appendLine(threadFile(site, `ask:${eventId}`), { ts: at, who: 'claude', text: `Moved to ${target.title}.`, link });
  // The ask has already gone to the other board, so a dropped card's open question can't stop it.
  for (const key of state?.items || []) await setItem(site, key, { status: 'dropped', force: true, text: `Dropped: its ask moved to ${target.title}.` });
  return { file: path.join(target.dir, 'data', 'events.jsonl'), lines: [`moved to ${link}`, ...(state?.items || []).map((k) => `dropped: ${k}`)] };
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
  const event = (await readLines(path.join(site, 'data', 'events.jsonl'))).find((e) => e.id === eventId);
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

// Board and wave reviewers share {name, slack_user, dm, github}.
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

// The board's list, also written to each wave file with an unfinished card, so its open PRs reach the same people.
async function writeReviewers(site, change) {
  const { file, reviewers } = await writeBoardJSON(site, (cfg) => {
    const reviewers = checkReviewers(change(cfg.reviewers || []), 'the reviewers');
    return { set: { reviewers }, reviewers };
  });
  const lines = [];
  for (const source of await itemSources(site)) {
    const wave = await readJSON(source.file, null);
    if (!(wave?.items || []).some((it) => !FINISHED.includes(it.status))) continue;
    await writeJSON(source.file, { ...wave, reviewers });
    lines.push(`wave ${source.slug}: reviewers copied`);
  }
  return { file, lines };
}

export const setReviewers = (site, list) => writeReviewers(site, () => checkReviewers(list, 'the reviewer file'));

// docs/adr/2026-11-07-0300-slack-sends-hang-off-prs-and-go-out-from-the-hub-tick.md
// data/pr-slack.json {<owner/repo#n>: {head, links: {<reviewer>: {channel, ts, reactions: [emoji]}}, replies: [{id, text,
// to: {<reviewer>: {ts}}}]}}: each PR's Slack messages, apart from the cards that hold it. Every reviewer of a PR has
// their own link message, in the owner's DM with them, and the same thread replies and reactions. head is the commit
// the thread last told about. A message carries ts once posted, and posting_at while its post is out or after its ts
// couldn't be recorded; either way it is never posted again.
const prSlackFile = (site) => path.join(needSite(site), 'data', 'pr-slack.json');
export const readPRSlack = (site) => readJSON(prSlackFile(site), {});
const held = (message) => Boolean(message?.ts || message?.posting_at);

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

// due: one of review due's links; post(channel) → ts.
export const postLink = (site, due, channel, post) => postOnce(prSlackFile(site), (all) => {
  const rec = all[due.pr] ||= { head: due.head, links: {}, replies: [] };
  rec.head ??= due.head;
  return Object.assign(rec.links[due.reviewer] ||= { reactions: [] }, { channel });
}, () => post(channel));
// due: one of review due's replies; post() → ts.
export const postReply = (site, due, post) => postOnce(prSlackFile(site), (all) => all[due.pr].replies.find((r) => r.id === due.id).to[due.reviewer], post);
// due: one of review due's reactions, once Slack has it.
export const recordReaction = (site, due) => editJSON(prSlackFile(site), (all) => {
  const link = all[due.pr].links[due.reviewer];
  if (!link.reactions.includes(due.emoji)) link.reactions.push(due.emoji);
});

// A reply in the thread of every link already posted for the PR, owed to each of those reviewers. → their names
const queueReply = (site, pr, kind, text) => editJSON(prSlackFile(site), (all) => {
  const rec = all[pr];
  const names = Object.keys(rec?.links || {}).filter((name) => rec.links[name].ts);
  if (!names.length) return [];
  rec.replies.push({ id: `${kind}-${rec.replies.length + 1}`, text, to: Object.fromEntries(names.map((name) => [name, {}])) });
  return names;
});

// “New push to #n” and the subjects of the commits after the head the thread last told about, from the newest commits
// the hub's poll read; every one it read when that head is older than them all.
function pushText(gh, number, since) {
  const commits = gh.commits || [];
  const after = commits.findIndex((c) => c.oid === since);
  return [`New push to #${number}`, commits.slice(after + 1).map((c) => c.subject).join(' · ')].filter(Boolean).join('\n');
}

// Queues a push reply on each PR whose head moved since its thread last told about it. The hub runs this each poll,
// before it reads review due.
export async function queuePushes(site) {
  const cache = await readJSON(GITHUB_STATE, {});
  const moved = (pr, rec) => {
    const head = routeRecord(cache.prs, pr)?.head;
    return Boolean(head) && head !== rec.head && Object.values(rec.links).some((l) => l.ts);
  };
  // A poll with no head moved writes nothing.
  if (!Object.entries(await readPRSlack(site)).some(([pr, rec]) => moved(pr, rec))) return [];
  return editJSON(prSlackFile(site), (all) => {
    const queued = [];
    for (const [pr, rec] of Object.entries(all)) {
      if (!moved(pr, rec)) continue;
      const gh = routeRecord(cache.prs, pr);
      const names = Object.keys(rec.links).filter((name) => rec.links[name].ts);
      if (rec.head) {
        rec.replies.push({ id: `push-${rec.replies.length + 1}`, text: pushText(gh, pr.split('#')[1], rec.head), to: Object.fromEntries(names.map((name) => [name, {}])) });
        queued.push(pr);
      }
      rec.head = gh.head;
    }
    return queued;
  });
}

// The link message, in the owner's words: the PR's title, its link, then “+N/-M, K files”, one per line.
function linkText(gh, p, item) {
  const size = Number.isInteger(gh.additions) ? `+${gh.additions}/-${gh.deletions}, ${gh.files} file${gh.files === 1 ? '' : 's'}` : null;
  return [gh.title || item.title, prURL(p), size].filter(Boolean).join('\n');
}
const approved = (gh) => Boolean(gh?.approved) || gh?.reviewDecision === 'APPROVED';

// docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md
// `review due`: each Slack send still owed, from local state with no GitHub call; the hub sends them each poll.
// links: a fresh link to each reviewer of a card's PR that the hub last read open and out of draft, once per PR.
// replies: each thread reply not yet in a reviewer's thread. reactions: git_approved once anyone approved, then
// git_merged on merge or x on a close, on each posted link. digest: review digest's answer while one is due, else
// null. While Slack isn't ready → waiting and nothing owed.
export async function reviewDue(site, options) {
  needSite(site);
  const waiting = await readiness.waiting('slack');
  if (waiting) return { waiting, links: [], replies: [], reactions: [], digest: null };
  const cfg = await boardConfig(site);
  const cache = await readJSON(GITHUB_STATE, {});
  const record = await readPRSlack(site);
  const links = [];
  for (const source of await itemSources(site)) {
    const wave = await readJSON(source.file, {});
    const people = reviewersOf(wave, cfg.reviewers);
    for (const item of wave.items || []) {
      if (['done', 'dropped'].includes(item.status)) continue;
      for (const p of cardPRs(item, boardRepoOf(site, wave))) {
        const pr = prKeyOf(p);
        const gh = routeRecord(cache.prs, pr);
        if (gh?.state !== 'OPEN' || gh.isDraft) continue;
        for (const r of people) {
          if (held(record[pr]?.links?.[r.name]) || links.some((l) => l.pr === pr && l.reviewer === r.name)) continue;
          links.push({ pr, key: `${source.slug}/${item.id}`, reviewer: r.name, slack_user: r.slack_user, head: gh.head || null, text: linkText(gh, p, item) });
        }
      }
    }
  }
  const replies = [];
  const reactions = [];
  for (const [pr, rec] of Object.entries(record)) {
    const gh = routeRecord(cache.prs, pr);
    const wanted = [approved(gh) && 'git_approved', gh?.state === 'MERGED' ? 'git_merged' : gh?.state === 'CLOSED' && 'x'].filter(Boolean);
    for (const [name, link] of Object.entries(rec.links)) {
      if (!link.ts) continue;
      for (const emoji of wanted) if (!link.reactions.includes(emoji)) reactions.push({ pr, reviewer: name, channel: link.channel, ts: link.ts, emoji });
    }
    for (const reply of rec.replies) {
      for (const [name, sent] of Object.entries(reply.to)) if (!held(sent)) replies.push({ pr, id: reply.id, reviewer: name, channel: rec.links[name].channel, thread_ts: rec.links[name].ts, text: reply.text });
    }
  }
  const digest = await reviewDigest(site, options);
  return { links, replies, reactions, digest: digest.due ? digest : null };
}

// `review updated`: “Updated: <what changed>” queued in the thread of every posted link on the card's PRs, which the
// hub's next poll sends (docs/adr/2026-11-05-0141-the-hub-sends-reviewer-slack-messages-with-its-own-token.md).
export async function reviewUpdated(site, key, whatChanged) {
  needSite(site);
  const words = text(whatChanged, 'what changed');
  const { wave, item } = await loadItem(site, key);
  const sent = [];
  for (const p of cardPRs(item, boardRepoOf(site, wave))) sent.push(...await queueReply(site, prKeyOf(p), 'updated', `Updated: ${words}`));
  const names = [...new Set(sent)];
  return { lines: [names.length ? `Updated queued for ${names.join(', ')} on ${key}` : `no reviewer has a link to ${key}'s PRs; nothing queued`] };
}

// Whether a reviewer already has a link to one of the card's PRs, so its builder's done owes the Updated decision.
export async function cardLinked(site, key) {
  const { wave, item } = await loadItem(site, key);
  const record = await readPRSlack(site);
  return cardPRs(item, boardRepoOf(site, wave)).some((p) => Object.values(record[prKeyOf(p)]?.links || {}).some((l) => l.ts));
}

const digestFile = (site) => path.join(needSite(site), 'data', 'review-digests.json');

// `review digest`: each reviewer's PRs the hub last read open, out of draft, green and not approved, one item per PR
// with its digest reply's text, “<PR link> · <card title>” plus “ (<n> days old)” for a link over two days old.
// data/review-digests.json {digests: [{date, reviewer, channel, ts, replies: [{pr, text, ts}]}]} holds the day's sends,
// posted as postOnce posts. A reviewer is owed the day's digest until its header and every reply are posted, weekdays
// from 09:00 to 17:00 in the Slack timezone; a day missed by 17:00 is skipped.
export async function reviewDigest(site, { now = new Date() } = {}) {
  needSite(site);
  const cfg = await boardConfig(site);
  const cache = await readJSON(GITHUB_STATE, {});
  const record = await readPRSlack(site);
  const topics = topicItems();
  const reviewers = new Map();
  for (const source of await itemSources(site)) {
    const wave = await readJSON(source.file, {});
    const people = reviewersOf(wave, cfg.reviewers);
    for (const r of people) if (!reviewers.has(r.name)) reviewers.set(r.name, { name: r.name, slack_user: r.slack_user, dm: r.dm, items: [] });
    for (const item of wave.items || []) {
      if (['merged', 'done', 'dropped'].includes(item.status)) continue;
      const key = `${source.slug}/${item.id}`;
      const legacy = reviewLinks(wave, item, key, topics);
      for (const p of cardPRs(item, boardRepoOf(site, wave))) {
        const pr = prKeyOf(p);
        const gh = routeRecord(cache.prs, pr);
        if (gh?.state !== 'OPEN' || gh.isDraft || gh.failing?.length || approved(gh)) continue;
        for (const r of people) {
          const ts = record[pr]?.links?.[r.name]?.ts || routeRecord(legacy, r.name)?.ts || null;
          const age = ts ? (now.getTime() - Number(ts) * 1000) / 86400000 : null;
          const old = age > 2 ? Math.floor(age) : null;
          reviewers.get(r.name).items.push({ key, pr, title: item.title, url: prURL(p), sent_ts: ts, ...(old ? { days_old: old } : {}),
            text: `${prURL(p)} · ${item.title}${old ? ` (${old} days old)` : ''}` });
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
    const owed = sent ? !sent.posting_at && (!sent.ts || sent.replies.some((reply) => !held(reply))) : r.items.length > 0;
    return { ...r, owed, ...(sent ? { sent } : {}) };
  }).filter((r) => r.items.length || r.sent);
  return { date, due: !waiting && open && list.some((r) => r.owed), ...(waiting ? { waiting } : {}), reviewers: list };
}

// Posts a reviewer's owed digest for date: the header, then each reply not yet in its thread. A digest already begun
// keeps the PRs it began with. post({channel, text, thread_ts?}) → ts; header(n) → the header's text.
export async function postDigest(site, date, reviewer, { channel, header, post }) {
  const file = digestFile(site);
  const entry = (all) => (all.digests || []).find((d) => d.date === date && d.reviewer === reviewer.name);
  await editJSON(file, (all) => {
    if (entry(all)) return;
    all.digests = [...(all.digests || []).filter((d) => d.date === date), { date, reviewer: reviewer.name, channel, replies: reviewer.items.map((i) => ({ pr: i.pr, text: i.text })) }];
    delete all.last_date;
  });
  const sent = entry(await readJSON(file, {}));
  const top = sent.ts || await postOnce(file, entry, () => post({ channel: sent.channel, text: header(sent.replies.length) }));
  for (const [i, reply] of sent.replies.entries()) {
    if (!held(reply)) await postOnce(file, (all) => entry(all).replies[i], () => post({ channel: sent.channel, thread_ts: top, text: reply.text }));
  }
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
// auto_build, auto_pull (Auto implement Todo cards), auto_triage, auto_review and idle_notification, off when absent, max_implementers, a
// whole number from 1 to 99 and MAX_IMPLEMENTERS when absent
// (docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md), max_planners, the same and MAX_PLANNERS when
// absent (docs/adr/2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md), skip_draft, off when
// absent (docs/adr/2026-11-04-1913-a-board-can-skip-the-draft.md), prs, on unless false, and on the hub board (board is its listBoards
// entry, `hub: true`) off unless true (opensPRs; docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md,
// docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md), tickets, its one
// ticket source, and github_login, absent when unset or invalid (docs/adr/2026-11-01-1348-a-board-has-one-ticket-source.md),
// and build_target, the `.kickflip/build-<target>` the hub runs, absent for `.kickflip/build`
// (docs/adr/2026-11-05-1823-board-settings-picks-which-build-script-a-board-runs.md).
const validCap = (value) => Number.isInteger(value) && value >= 1 && value <= 99;
const CAPS = ['max_implementers', 'max_planners'];
export const settingsOf = (cfg, board) => {
  const tickets = storedTickets(cfg?.tickets);
  return { auto_merge: cfg?.auto_merge === true, auto_build: cfg?.auto_build === true, auto_pull: cfg?.auto_pull === true,
    max_implementers: validCap(cfg?.max_implementers) ? cfg.max_implementers : MAX_IMPLEMENTERS,
    max_planners: validCap(cfg?.max_planners) ? cfg.max_planners : MAX_PLANNERS, auto_triage: cfg?.auto_triage === true, auto_review: cfg?.auto_review === true,
    idle_notification: cfg?.idle_notification === true, skip_draft: cfg?.skip_draft === true, prs: board?.hub ? cfg?.prs === true : cfg?.prs !== false,
    ...(tickets ? { tickets } : {}), ...(validGithubLogin(cfg?.github_login) ? { github_login: cfg.github_login } : {}),
    ...(validBuildTarget(cfg?.build_target) ? { build_target: cfg.build_target } : {}) };
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
export async function readBoardSettings(site) {
  const dir = needSite(site);
  return settingsOf(await readJSON(path.join(dir, 'board.json'), {}), listBoards().find((b) => samePath(b.dir, dir)));
}
// Whether cards on a board open PRs: a board on GitHub that builds from its shared clone, not its folder
// (hub/boards.mjs buildsLocally), or the hub board, which builds from its folder, with its PRs setting on (Landing is
// Draft PR or Ready PR; docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md). board is a
// listBoards entry or hub/board-repo.mjs boardRepo's answer, settings settingsOf's.
export const opensPRs = (board, settings) => Boolean(board?.github) && (!board.local || board.hub === true) && settings.prs;

// changes {auto_merge?: boolean, auto_build?: boolean, auto_pull?: boolean, max_implementers?: 1..99, max_planners?: 1..99, auto_triage?: boolean, auto_review?: boolean, idle_notification?: boolean, skip_draft?: boolean, prs?: boolean, tickets?: source, github_login?: login | null, build_target?: target | null} → {file, settings, changed}; changed lists the keys whose value moved.
// PRs off on a board on GitHub that builds from its shared clone needs its Push main switch on, since each land there
// then pushes main (permissions.mjs pushMain).
export async function saveBoardSettings(site, changes) {
  onlyKeys(changes, ['auto_merge', 'auto_build', 'auto_pull', 'max_implementers', 'max_planners', 'auto_triage', 'auto_review', 'idle_notification', 'skip_draft', 'prs', 'tickets', 'github_login', 'build_target'], 'the settings');
  if (!Object.keys(changes).length) fail('the settings name nothing to change');
  changes = { ...changes };
  for (const [k, v] of Object.entries(changes)) {
    if (k === 'tickets') {
      try { changes.tickets = ticketSource(v); } catch (e) { fail(e.message); }
      if (changes.tickets.source === 'linear' && !linearWorks()) fail(LINEAR_NEEDS_KEY);
      // Issues need a repo on GitHub, as Board Settings' Tickets row shows (dialogs.js ticketsControl).
      const board = changes.tickets.source === 'github' && site ? listBoards().find((b) => samePath(b.dir, site)) : null;
      if (board && !board.github) fail('GitHub issues need the board’s repo on GitHub, and this board’s repo isn’t; pick internal or linear');
    }
    else if (k === 'github_login') {
      if (v === '' || v === null) changes.github_login = undefined;
      else if (!validGithubLogin(v)) fail('github_login must be a GitHub login');
    } else if (k === 'build_target') {
      if (v === null) changes.build_target = undefined;
      else if (!validBuildTarget(v)) fail('build_target must name .kickflip/build-<target>: letters, digits, ".", "_" or "-", or null for .kickflip/build');
    } else if (CAPS.includes(k)) {
      if (!validCap(v)) fail(`${k} must be a whole number from 1 to 99`);
    } else bool(v, k);
  }
  if (changes.prs === false) {
    const board = site ? listBoards().find((b) => samePath(b.dir, site)) : null;
    if (board?.github && !board.local && !(await readPermissions(board.owner?.repo)).pushMain) fail('Merge lands each card on main and pushes it, so turn on Push main after a land first');
  }
  return writeBoardJSON(site, (cfg) => {
    const board = site ? listBoards().find((b) => samePath(b.dir, site)) : null;
    const before = settingsOf(cfg, board);
    const settings = settingsOf({ ...cfg, ...changes }, board);
    return { set: changes, settings, changed: Object.keys(changes).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(settings[k])) };
  });
}
// Once Hub has no Linear key, each board in the manifest on Linear falls back to internal tickets, and its session
// hears of it as any source change, by a settings event. Its old cards keep their Linear tickets. Run by the hub as it
// starts and when Hub settings removes the key
// (docs/adr/2026-11-04-0227-every-new-card-gets-a-ticket-in-the-boards-current-source.md). → one line per board moved
export async function fallBackFromLinear() {
  if (linearStatus().set) return [];
  const lines = [];
  for (const board of listBoards()) {
    if ((await readBoardSettings(board.dir)).tickets?.source !== 'linear') continue;
    const { settings } = await saveBoardSettings(board.dir, { tickets: { source: 'internal' } });
    await appendEvent(board, 'settings', { tickets: settings.tickets });
    lines.push(`/${board.route} fell back to internal tickets: Hub has no Linear key`);
  }
  return lines;
}
// The CLI's `settings set <name> <value>`; names are the board.json keys with "-" for "_".
export async function setBoardSetting(site, name, value) {
  const key = String(name).replace(/-/g, '_');
  const names = ['auto_merge', 'auto_build', 'auto_pull', 'max_implementers', 'max_planners', 'auto_triage', 'auto_review', 'idle_notification', 'skip_draft', 'prs', 'github_login', 'tickets', 'build_target'];
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
  if (CAPS.includes(key)) {
    const { file, settings } = await saveBoardSettings(site, { [key]: /^\d+$/.test(value) ? Number(value) : value });
    return { file, lines: [`${name} ${settings[key]}`] };
  }
  if (!['on', 'off'].includes(value)) fail(`settings set ${name} takes on or off, not "${value}"`);
  const { file, settings } = await saveBoardSettings(site, { [key]: value === 'on' });
  return { file, lines: [`${name} ${settings[key] ? 'on' : 'off'}`] };
}
export const settingsLines = (settings) => Object.entries(settings).map(([k, v]) => `setting ${k.replace(/_/g, '-')} ${k === 'tickets' ? JSON.stringify(v) : k === 'github_login' || CAPS.includes(k) ? v : k === 'build_target' ? v || 'default' : v ? 'on' : 'off'}`);

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
// card's ref and the answer as they gave it.
function checkSuggested(s, options, at) {
  onlyKeys(s, ['option', 'card', 'answer'], at);
  if (!options.some((o) => o.id === text(s.option, `${at}.option`))) fail(`${at}.option names no option "${s.option}"`);
  text(s.card, `${at}.card`);
  text(s.answer, `${at}.answer`);
}

// A prototype is a topic recorded here, served as prototype-<topic>.html from one template (board/public/prototype.html,
// board/server.mjs), whose takes are the site's public/prototypes/<topic>/<KEY>.js (docs/adr/2026-11-01-1448-the-board-serves-every-prototype-from-one-template.md).
// A served round (served: its page's path) has no take files: the template frames that page from the board's base
// prototype worktree, which takes each take and state by message
// (docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md).
const prototypesFile = (site) => path.join(site, 'data', 'prototypes.json');
export const takeFile = (site, topic, key) => path.join(site, 'public', 'prototypes', topic, `${key}.js`);
export async function readPrototypes(site) {
  const list = site ? (await readJSON(prototypesFile(site), {})).prototypes : null;
  return Array.isArray(list) ? list : [];
}
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
  const list = await readPrototypes(site);
  if (list.some((p) => p.topic === topic)) fail(`prototype ${topic} is already recorded; run prototype rm ${topic} first, or pick another topic`);
  if (await fs.stat(path.join(site, 'public', `prototype-${topic}.html`)).then(() => true, () => false)) {
    fail(`public/prototype-${topic}.html is a hand-written page that questions may link; pick another topic`);
  }
  const record = { topic, title: title.trim(), ...(card === undefined ? {} : { card }), ...(served === undefined ? {} : { served }), takes: parsed,
    ...(named.length ? { states: named } : {}), at: new Date().toISOString() };
  await writeJSON(prototypesFile(site), { prototypes: [...list, record] });
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
  await writeJSON(prototypesFile(site), { prototypes: list.filter((p) => p.topic !== topic) });
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
    onlyKeys(q, ['id', 'topic', 'source', 'question', 'context', 'url', 'urgent', 'options', 'round_of', 'reask_of', 'ask', 'suggested', 'prototype_gate'], name);
    if (taken.has(domId(q.id, `${name}.id`))) fail(`question id "${q.id}" is already used`);
    taken.add(q.id);
    text(q.topic, `${name}.topic`);
    if (q.topic.startsWith('item:ask:')) await checkAsk(site, q.topic.slice(9), `${name}.topic`);
    else if (q.topic.startsWith('item:')) await loadItem(site, q.topic.slice(5));
    else if (q.topic.startsWith('lineup:')) await findLineup(site, q.topic.slice(7));
    else if (q.topic.startsWith('wave:')) await triagedWave(site, q.topic.slice(5));
    else if (!topics.has(q.topic)) fail(`topic "${q.topic}" is not declared; add it with: topic add ${q.topic} --title <t>`);
    text(q.question, `${name}.question`);
    for (const k of ['source', 'context']) optional(q[k], (v) => text(v, `${name}.${k}`));
    optional(q.url, (v) => pageUrl(v, `${name}.url`));
    optional(q.urgent, (v) => bool(v, `${name}.urgent`));
    checkOptions(q.options, name);
    optional(q.prototype_gate, (v) => checkGate(v, q, name));
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
  const lines = [];
  const held = [];
  for (const q of questions) {
    const card = q.topic.startsWith('item:') && !q.topic.startsWith('item:ask:') ? q.topic.slice(5) : null;
    const planner = card && await runningPlanner(site, card);
    if (!planner) continue;
    (staged[card] ||= []).push(q);
    held.push(q);
    lines.push(`staged: ${q.id} waits for ${card}'s ${planner} to finish; the card's staged questions then publish together`);
  }
  if (held.length) await writeJSON(stagedFile(site), staged);
  if (held.length === questions.length) return { file: stagedFile(site), lines, staged: held.length };
  return publishQuestions(site, owner, items, questions.filter((q) => !held.includes(q)), lines);
}

// The kind of the card's open planner record (grill or prototype), or null while none runs. A visual agent posts no
// questions, so it holds none back.
async function runningPlanner(site, key) {
  const { source } = await loadItem(site, key);
  for (const file of await builderFiles(source.dir, parseKey(key).id)) {
    const record = await readJSON(file, null);
    if (record?.started && !record.done && plans(record) && record.kind !== VISUAL) return record.kind;
  }
  return null;
}

// Publishes the card's staged questions in the order added, with one write, once no planner of it runs. A planner that
// finishes, fails or is stopped all end here, so none is lost.
async function publishStaged(site, key) {
  if (!site || await runningPlanner(site, key)) return;
  const staged = await readJSON(stagedFile(site), {});
  if (!staged[key]) return;
  const { [key]: questions, ...rest } = staged;
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  await publishQuestions(site, owner, owner.items || [], questions, []);
  await writeJSON(stagedFile(site), rest);
}

async function publishQuestions(site, owner, items, questions, lines) {
  // docs/adr/2026-11-01-1813-an-answered-question-stops-waiting-once-claude-acts-on-its-card.md
  const { answers, requests, reopens } = await ownerEvents(site);
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
    const views = items.filter((old) => old.topic === q.topic).map((old) => ownerQuestion(old, answers, requests, [], reopens));
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
  for (const key of new Set(questions.map((q) => cardOfTopic(q.topic)).filter(Boolean))) await grillAgain(site, key);
  return { file: ownerFile(site), lines: [...lines, ...replaced.map((id) => `replaced: ${id}`), ...resolved.map((id) => `resolved: ${id}`)] };
}

// docs/adr/2026-11-06-0130-every-grill-ends-with-a-prototype-question-the-board-acts-on.md
// prototype_gate: true marks a card's "Prototype round first?" question: options yes and no, on the card's own topic.
function checkGate(flag, q, name) {
  bool(flag, `${name}.prototype_gate`);
  if (!flag) return;
  if (!q.topic.startsWith('item:') || q.topic.startsWith('item:ask:')) fail(`${name}.prototype_gate goes on a card's topic, item:<wave>/<id>`);
  if (q.options?.map((o) => o.id).join() !== 'yes,no') fail(`${name}.prototype_gate takes exactly the options yes and no, in that order`);
}

// docs/adr/2026-11-06-0130-every-grill-ends-with-a-prototype-question-the-board-acts-on.md,
// docs/adr/2026-11-07-0700-staging-then-ready.md
// The owner's Send acted on with no orchestrator step. A prototype_gate question resolves; answered yes it moves its
// card, while still grilling, to prototyping. Every answer on a card goes into the card's notes verbatim. A card the
// Send leaves with nothing open is staged (stageable), but not one yes just moved to prototyping.
// → {prototype: [keys], staged: [keys]}: the cards whose prototype planner the server starts, and the cards staged.
export async function settleAnswers(site, answers) {
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const asked = new Map((owner.items || []).map((q) => [q.id, q]));
  const prototype = [];
  for (const a of answers) {
    const q = asked.get(String(a.id));
    if (!q?.prototype_gate || !['yes', 'no'].includes(a.choice)) continue;
    setResolved(owner, [q.id], `Prototype round: ${a.choice}. The board moved the card on.`);
    await writeJSON(ownerFile(site), owner);
    if (a.choice === 'no') continue;
    const key = q.topic.slice(5);
    if ((await loadItem(site, key)).item.state !== 'grilling') continue;
    await setItem(site, key, { state: 'prototyping' });
    await appendThread(site, key, { text: 'You asked for a prototype round, so the board moved the card to prototyping.' });
    prototype.push(key);
  }
  const byCard = new Map();
  for (const a of answers) {
    const q = asked.get(String(a.id));
    const key = cardOfTopic(q?.topic);
    if (key) byCard.set(key, [...(byCard.get(key) || []), answerLine(q, a)]);
  }
  const staged = [];
  for (const [key, said] of byCard) {
    if (!(await loadItem(site, key).catch(() => null))) continue;
    await addToNotes(site, key, `Answers (owner, ${noteStamp()})`, said.join('\n'));
    if (prototype.includes(key) || !(await stageable(site, key))) continue;
    await stage(site, key, 'answers');
    staged.push(key);
  }
  return { prototype, staged };
}

// docs/adr/2026-11-07-0700-staging-then-ready.md
// A card's key from a question topic, item:<wave>/<id>, or null for any other topic, an ask's included.
const cardOfTopic = (topic) => (typeof topic === 'string' && topic.startsWith('item:') && !topic.startsWith('item:ask:') ? topic.slice(5) : null);
const pad2 = (n) => String(n).padStart(2, '0');
// The owner's time on a notes heading, MM/DD HH:MM in the Mac's local time.
const noteStamp = (d = new Date()) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
// One answer as its notes line: the question, the option picked by its label, and the owner's note verbatim.
function answerLine(q, a) {
  const picked = a.choice === null || a.choice === undefined || a.choice === '' ? null : (q.options || []).find((o) => o.id === a.choice)?.label ?? String(a.choice);
  const note = String(a.note || '').trim();
  return `- ${q.id} (${q.question}): ${picked ? `${picked}.` : 'no option picked.'}${note ? ` Note, verbatim: "${note}"` : ''}`;
}
// Appends a section, ## heading then body, to the card's notes file, first making <id>-notes.md beside its wave file
// when the card has none.
async function addToNotes(site, key, heading, body) {
  const { source, wave, item } = await loadItem(site, key);
  let file;
  if (item.plan) file = await planPath(source.dir, item.plan);
  else {
    const base = String(item.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    let name = `${base}-notes.md`;
    for (let n = 2; existsSync(path.join(source.dir, name)); n++) name = `${base}-notes-${n}.md`;
    file = path.join(source.dir, name);
    await fs.writeFile(file, `# ${item.title}\n`, { flag: 'wx' });
    item.plan = name;
    await writeJSON(source.file, wave);
  }
  const notes = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, `${notes.replace(/\n*$/, '\n')}\n## ${heading}\n${body}\n`);
}
// Whether a Send leaves the card stageable: unstarted, with no PR, no planner or build running, no question open and a
// take picked on its prototypes.
async function stageable(site, key) {
  const { source, item } = await loadItem(site, key);
  if (![...UNSTARTED, 'held'].includes(item.status) || hasPR(item) || item.pushed) return false;
  const records = await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)));
  if (records.some((r) => r?.started && !r.done && r.kind !== VISUAL)) return false;
  if ((await cardQuestions(site, key)).asked.some((q) => q.state === 'open')) return false;
  return !(await unpickedPrototype(site, key));
}
// The thread line of each owner action that stages a card.
const STAGED_LINES = {
  answers: 'Staging: your answers are in its notes; the orchestrator judges them next.',
  implement: 'Staging: your Implement is in its notes; the orchestrator judges it next.',
  reply: 'Back to staging: your reply is in its notes; the orchestrator judges it before it goes ready again.',
};
// Stages the card, keeping the time of a stage it is already in, with why's thread line when it newly stages.
async function stage(site, key, why) {
  const { source, wave, item } = await loadItem(site, key);
  if (item.state === 'staging') return;
  Object.assign(item, { state: 'staging', staged_at: new Date().toISOString() });
  delete item.unfiled;
  await writeJSON(source.file, wave);
  await appendThread(site, key, { text: STAGED_LINES[why] });
}
// The owner's words from a thread message, text then any attached files, as one notes body, or '' when it carried none.
const messageWords = ({ text: said, files }) => [String(said || '').trim(), ...(Array.isArray(files) ? files : []).map((f) => `Attached: ${f?.path || f?.name || f}`)].filter(Boolean).join('\n');

// An Implement message on a Todo card, in the board server before its event: a held card is resumed, as the Build tap
// does; its open questions resolve as skipped; its words go into the notes; and it is staged in Todo.
export async function stageImplement(site, key, message) {
  const { item } = await loadItem(site, key);
  if (item.held || item.status === 'held') await recordOwnerTap(site, 'card-hold', { key, hold: false });
  const { owner, asked } = await cardQuestions(site, key);
  const open = asked.filter((q) => q.state === 'open').map((q) => q.id);
  if (open.length) await markResolved(site, owner, open, 'Skipped: you tapped Implement');
  const words = messageWords(message);
  if (words) await addToNotes(site, key, `Implement (owner, ${noteStamp()}), verbatim`, words);
  await stage(site, key, 'implement');
}
// A Reply on a ready Todo card: its words go into the notes, and it is staged again.
export async function stageReply(site, key, message) {
  const words = messageWords(message);
  if (words) await addToNotes(site, key, `Reply (owner, ${noteStamp()}), verbatim`, words);
  await stage(site, key, 'reply');
}
// The owner's Grill or Prototype tap (kind grill or prototype) on a ready or staging card takes it out of that state,
// to grilling or prototyping; the tap launches the planner itself.
export async function planAgain(site, key, kind) {
  const { source, wave, item } = await loadItem(site, key);
  if (!['ready', 'staging'].includes(item.state) || item.status) return;
  item.state = kind === 'prototype' ? 'prototyping' : 'grilling';
  delete item.staged_at;
  await writeJSON(source.file, wave);
}
// A question published on a ready or staging card leaves the owner something to decide, so the card is grilling until
// the answer's Send stages it again.
async function grillAgain(site, key) {
  const loaded = await loadItem(site, key).catch(() => null);
  if (!loaded || !['ready', 'staging'].includes(loaded.item.state) || loaded.item.status) return;
  loaded.item.state = 'grilling';
  delete loaded.item.staged_at;
  await writeJSON(loaded.source.file, loaded.wave);
  await appendThread(site, key, { text: 'A new question on it, so it is grilling until you answer.' });
}

// The ids of a topic's answered questions that Claude acting on the card resolves.
function answeredOnClaude(views) {
  return views.filter((q) => q.state === 'answered').map((q) => q.id);
}

function setResolved(owner, ids, note, at = new Date().toISOString()) {
  for (const q of owner.items || []) if (ids.includes(q.id)) Object.assign(q, { resolved: note, resolved_at: at });
}

async function markResolved(site, owner, ids, note) {
  setResolved(owner, ids, note);
  await writeJSON(ownerFile(site), owner);
  return ownerFile(site);
}

export async function resolveQuestion(site, id, note) {
  needSite(site);
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const q = (owner.items || []).find((x) => x.id === id);
  if (!q) fail(`no question "${id}" in owner.json`);
  const { answers, requests, reopens } = await ownerEvents(site);
  const view = ownerQuestion(q, answers, requests, [], reopens);
  if (view.state === 'resolved') return ownerFile(site);
  // docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md
  if (view.state === 'requested') fail(`${id} waits on the prototype the owner asked for; question add with round_of ${id} resolves it`);
  const said = text(note, '--note');
  if (pageTopic(q.url)) roundSettled(owner, q, answers);
  const file = await markResolved(site, owner, [id], said);
  await clearWaitedNext(site, q.topic);
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
  if (new Set(chain).size !== chain.length) fail('question move names a card twice');
  for (const key of block) await loadItem(site, key);
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const { answers, requests, reopens } = await ownerEvents(site);
  for (const id of [kept, ...others]) {
    const q = (owner.items || []).find((x) => x.id === id) || fail(`no question "${id}" in owner.json`);
    const { state } = ownerQuestion(q, answers, requests, [], reopens);
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

// docs/adr/2026-11-03-0504-a-prototype-pick-is-the-builds-go.md
// Refuses while no answer settles q's round.
function roundSettled(owner, q, answers) {
  const n = roundOf(q);
  const round = owner.items.filter((x) => x.topic === q.topic && roundOf(x) === n).map((x) => ownerQuestion(x, answers));
  if (!roundSettledBy(round, n)) fail(`${q.id} is in prototype round ${n}, which no pick has settled yet; a pick settles it`);
}

// The owner's answers, each with whether it has a reply, prototype requests and reopens, from the event log: what
// domain.mjs ownerQuestion reads a question's state from. → {answers, requests, reopens}
async function ownerEvents(site) {
  const events = await readLines(path.join(site, 'data', 'events.jsonl'));
  const answers = await Promise.all(events.filter((e) => e.kind === 'owner-answer').map(async (e) => {
    const replied = await Promise.all(['html', 'json'].map((ext) => fs.stat(path.join(site, 'data', 'replies', `${e.id}.${ext}`)).then((s) => s.isFile(), () => false)));
    return { ...e, reply: e.reply || replied.some(Boolean) };
  }));
  return { answers, requests: events.filter((e) => e.kind === 'prototype-request'), reopens: events.filter((e) => e.kind === QUESTION_REOPEN) };
}

export async function topicQuestions(site, topic) {
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const { answers, requests, reopens } = await ownerEvents(site);
  const asked = (owner.items || []).filter((q) => q.topic === topic).map((q) => ownerQuestion(q, answers, requests, [], reopens));
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
// A Next set while its card had an open question waits on the card's questions (the wave entry's next_on_questions).
const hasOpenQuestion = async (site, key) => Boolean(site) && (await cardQuestions(site, key)).asked.some((q) => q.state === 'open');
function setNext(item, next, waitsOnQuestions) {
  item.next = text(next, '--next');
  if (waitsOnQuestions) item.next_on_questions = true; else delete item.next_on_questions;
}
// Clears that Next once none of the card's questions is left unresolved: the card then reads "Next: none set yet".
// topic is the card's question topic, item:<key>; any other topic, or a card no longer on the board, has no Next to clear.
async function clearWaitedNext(site, topic) {
  const key = topic.startsWith('item:') && !topic.startsWith('item:ask:') ? topic.slice(5) : null;
  if (!key) return;
  let loaded;
  try { loaded = await loadItem(site, key); } catch (e) { if (e instanceof BoardError) return; throw e; }
  const { source, wave, item } = loaded;
  if (!item.next_on_questions) return;
  if ((await cardQuestions(site, key)).asked.some((q) => q.state !== 'resolved')) return;
  delete item.next;
  delete item.next_on_questions;
  await writeJSON(source.file, wave);
}

// A build's start clears the card's Next, whatever it waits on: the card reads its builder line
// (docs/adr/2026-11-03-1718-a-card-reads-starting-from-its-tap-with-one-dispatched-mark.md).
async function clearNext(site, key) {
  const { source, wave, item } = await loadItem(site, key);
  if (item.next === undefined && item.next_on_questions === undefined) return;
  delete item.next;
  delete item.next_on_questions;
  await writeJSON(source.file, wave);
}

// Closing a card resolves its questions (topic item:<key>) that have an answer, and refuses while one has none, naming
// `by`, unless force. → resolve(): writes the resolutions and returns `resolved: <id>` lines. Changes nothing itself.
async function closeQuestions(site, key, by, force) {
  if (!site) return async () => [];
  const { owner, asked } = await cardQuestions(site, key);
  const open = asked.filter((q) => q.state === 'open').map((q) => q.id);
  if (open.length && !force) fail(`${by}: ${key} has ${open.length === 1 ? 'an open question' : 'open questions'} ${open.join(', ')} with no answer yet; pass --force to close the card and resolve ${open.length === 1 ? 'it' : 'them'} too`);
  const ids = asked.filter((q) => q.state !== 'resolved').map((q) => q.id);
  return async () => {
    if (ids.length) await markResolved(site, owner, ids, 'Closed with the card');
    return ids.map((id) => `resolved: ${id}`);
  };
}

// Refuses what `item set <key> --status done --text <said>` (with ownerStep and check, land's --owner-step and --check)
// would refuse for its questions or its text, writing nothing, so board.mjs land can check before it lands.
export async function checkClose(site, key, said, ownerStep, check) {
  await loadItem(site, key);
  text(said, '--text');
  optional(ownerStep, (v) => text(v, '--owner-step'));
  optional(check, (v) => checkSpec(v));
  await closeQuestions(needSite(site), key, 'land', false);
}

// docs/adr/2026-11-03-0504-a-prototype-pick-is-the-builds-go.md
// The card's noTakePicked, from owner.json and the owner's answers. → {id, note}, or null.
async function unpickedPrototype(site, key) {
  const owner = await readJSON(ownerFile(site), { items: [] });
  const { answers, requests, reopens } = await ownerEvents(site);
  return noTakePicked((owner.items || []).map((q) => ownerQuestion(q, answers, requests, [], reopens)), key);
}
const clip = (s) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

// docs/adr/2026-11-02-1806-only-the-owner-or-auto-build-starts-a-card-run.md
// The owner's words on this board that can ask for a card run: an ask, an edit to one, a card message, an answer's note.
const OWNER_WORDS = { ask: 'text', 'ask-edited': 'text', 'item-message': 'text', 'owner-answer': 'note' };
// → words, once they quote what the owner wrote on this board; else it refuses, naming flag.
async function ownerQuote(site, words, flag) {
  const quoted = text(words, flag).replace(/\s+/g, ' ');
  const said = (await readLines(path.join(site, 'data', 'events.jsonl'))).map((e) => String(e.data?.[OWNER_WORDS[e.kind]] ?? '').replace(/\s+/g, ' ').toLowerCase());
  if (!said.some((t) => t.includes(quoted.toLowerCase()))) fail(`${flag} must quote the owner's words in an ask, card message or answer note on this board`);
  return quoted;
}

// → the thread line a session's card run writes once the hub starts it; refuses words the owner didn't write here.
export async function askedGate(site, key, asked) {
  needSite(site);
  if (asked === undefined) fail(`only the owner's Serve / Build and the hub's Auto-build start a card run; pass --asked "<the owner's words>" quoting where the owner asked for ${key}'s run`);
  return `Running at the owner's ask: "${await ownerQuote(site, asked, '--asked')}"`;
}

async function checkAsk(site, eventId, name = '--from-ask') {
  domId(eventId, name);
  const known = (await readLines(path.join(needSite(site), 'data', 'events.jsonl'))).some((e) => e.id === eventId && e.kind === 'ask');
  return known ? eventId : fail(`no ask "${eventId}" in this site's data/events.jsonl`);
}

// docs/adr/2026-10-29-1639-cards-wait-on-explicit-blocked-by-links.md
const FINISHED = ['done', 'merged', 'dropped'];
export const isFinished = async (site, key) => FINISHED.includes((await loadItem(site, key)).item.status);
// docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md, docs/adr/2026-11-07-0700-staging-then-ready.md:
// a card's state. Staging is the board's alone, set on an owner action; --state takes the rest.
const AGENT_STATES = ['ready', 'grilling', 'prototyping'];
function checkState(state) {
  if (state === 'staging') fail('--state staging is set by the board, on an owner action; pass ready, grilling or prototyping');
  if (state !== undefined && !AGENT_STATES.includes(state)) fail('--state takes ready, grilling or prototyping');
}
const NOT_STAGED = "a card goes ready only from staging, which the board sets on the owner's Send, Implement or Reply";
// Whether ask eventId asked for an Implement: the New task sheet's Implement, or an Implement on its New card. Filing
// it counts as its staging.
async function quickAsk(site, eventId) {
  const events = await readLines(path.join(needSite(site), 'data', 'events.jsonl'));
  return events.some((e) => (e.kind === 'ask' && e.id === eventId && e.data?.quick === true) || (e.kind === 'item-message' && e.data?.key === `ask:${eventId}` && e.data?.intent === 'build'));
}
// A Next asking the owner to mark the card ready ("Mark ready", "mark it ready").
const ASKS_READY = /^mark (?:it |this |the card )?ready\b/i;
function clearBuildingStatus(item) {
  if (!['building', 'fixing'].includes(item?.status)) return false;
  delete item.status;
  item.status_at = new Date().toISOString();
  return true;
}
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
async function unfinishedDeps(site, slug, item) {
  const keys = (item.deps || []).map((d) => depKey(slug, d));
  const deps = await Promise.all(keys.map((k) => loadItem(site, k).then(({ item: d }) => d, () => null)));
  return keys.filter((k, i) => deps[i] && !FINISHED.includes(deps[i].status));
}
// The names of what blocks item (at key) from starting: each unfinished dep's card name, then its blocked-until condition.
async function blockerNames(site, key, item) {
  const deps = await Promise.all((await unfinishedDeps(site, parseKey(key).wave, item)).map((k) => cardName(site, k)));
  return item.blocked_until ? [...deps, item.blocked_until] : deps;
}
// What blocks the card at key (item, else its wave entry) as words after "blocked": "by #53, #54 and until <condition>",
// or '' when nothing does.
export async function blockWords(site, key, item) {
  item ??= (await loadItem(site, key)).item;
  const deps = await Promise.all((await unfinishedDeps(site, parseKey(key).wave, item)).map((k) => cardName(site, k)));
  return [deps.length && `by ${deps.join(', ')}`, item.blocked_until && `until ${item.blocked_until}`].filter(Boolean).join(' and ');
}
// docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md: a card In Progress is one started with
// none of a PR, a pushed branch or a held Merge, which keep it In Review.
const inProgress = (item, records) => !hasPR(item) && !item.pushed && !item.merge_ready
  && (['building', 'fixing', 'checking'].includes(item.status) || records.some((r) => r?.started && !r.done && builds(r)));
// → the keys of the blocked cards whose last unfinished dep was key and no condition blocks.
async function unblockedBy(site, key) {
  const out = [];
  for (const s of await itemSources(site)) {
    const wave = await readJSON(s.file, null);
    for (const it of Array.isArray(wave?.items) ? wave.items : []) {
      if (![undefined, 'held'].includes(it.status) || it.blocked_until || !(it.deps || []).some((d) => depKey(s.slug, d) === key)) continue;
      if (!(await unfinishedDeps(site, s.slug, it)).length) out.push(`${s.slug}/${it.id}`);
    }
  }
  return out;
}

async function checkNextDeps(site, key, item, next) {
  const mentions = new Set(next.match(/[\w-]+(?:\.[\w-]+)*(?:\/[\w-]+(?:\.[\w-]+)*)*/g) || []);
  const deps = new Set((item.deps || []).map((d) => depKey(parseKey(key).wave, d)));
  for (const source of await itemSources(site)) {
    const wave = await readJSON(source.file, null);
    for (const other of wave?.items || []) {
      const otherKey = `${source.slug}/${other.id}`;
      if (otherKey === key || deps.has(otherKey) || FINISHED.includes(other.status)) continue;
      const names = [other.id, refOf(wave, other)].flatMap((id) => [id, `${source.slug}/${id}`]);
      if (names.some((name) => mentions.has(name))) fail(`--next names unfinished card ${otherKey}; add it with --deps`);
    }
  }
}

// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
// Ready means a builder can start from the card alone: it has a size, a notes file, and that file names the id of every
// question on the card the owner answered, bar a prototype_gate answered with no note (docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md).
function checkSizeAndNotes(key, item) {
  const starts = 'a builder starts from it, so pass';
  if (!item.size) fail(`${key} has no size; ${starts} --size small or large with --state ready`);
  if (!item.plan) fail(`${key} has no notes file; ${starts} --notes-file <file.md> with --state ready`);
}
async function checkNotesComplete(site, key, dir, item) {
  checkSizeAndNotes(key, item);
  const notes = await fs.readFile(await planPath(dir, item.plan), 'utf8');
  const left = (await cardQuestions(site, key)).asked.filter((q) => q.answers.length && !notes.includes(q.id) && !(q.prototype_gate && !q.answers.at(-1).note)).map((q) => q.id);
  if (left.length) fail(`${key}'s notes leave out the answered question${left.length === 1 ? '' : 's'} ${left.join(', ')}; record each answer in ${item.plan}, naming its id, before it is ready`);
}

// docs/adr/2026-10-29-1639-a-full-plan-opens-as-a-page-on-the-site.md
async function planPath(dir, rel) {
  const bad = (why) => fail(`a notes file is a .md file inside ${dir}, named relative to it: "${rel}" ${why}`);
  if (typeof rel !== 'string' || !rel.trim()) bad('is empty');
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) bad('leaves the folder');
  if (path.extname(rel).toLowerCase() !== '.md') bad('is not a .md file');
  const real = await fs.realpath(path.resolve(dir, rel)).catch(() => bad('does not exist'));
  if (!real.startsWith((await fs.realpath(dir)) + path.sep)) bad('leaves the folder');
  return real;
}

// → {wave, item, markdown}: the item's notes file (stored in `plan`) once it passes planPath's checks, or with no file
// its short `notes` text, so notes written before the page existed still show; otherwise a BoardError.
export async function readNotes(site, key) {
  const { source, wave, item } = await loadItem(site, key);
  if (item.plan) return { wave, item, markdown: await fs.readFile(await planPath(source.dir, item.plan), 'utf8') };
  if (typeof item.notes === 'string' && item.notes.trim()) return { wave, item, markdown: item.notes };
  fail(`${key} has no notes`);
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
// The thread line closing a card writes as its last: --text, which done and dropped need on a site, or for merged
// mergedLine's. → the line, or null.
function closingLine(site, key, item, status, text, repo) {
  if (status === 'merged') return text ?? (item.status === 'merged' ? null : mergedLine(storedPRs(item), repo));
  if (text === undefined && site) fail(`--status ${status} needs --text "<what was done or left>", which becomes ${key}'s last thread line`);
  return text ?? null;
}

// → the wave file, and when a dep finishes the items it unblocked as `unblocked: <key>` lines; closing
// (done, merged, dropped) adds a `resolved: <id>` line per question it resolved (closeQuestions).
// notesFile is the --notes-file (alias --plan) file, kept in the item's `plan`. text is the closing line
// (closingLine), or with fromAsk the item's first thread line.
// ownerStep is the owner step builder done or land records, and ownerDone the owner's Done, which alone clears it
// (docs/adr/2026-11-04-0158-a-card-whose-code-landed-stays-in-review-while-an-owner-step-remains.md). check is the
// step's code check (--check "<name> <args>", "" to remove it), kept as owner_check {check, since, broken?} while the
// step remains (docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md).
async function changeItem(site, key, { ticket, status, clearStatus, next, clearNext, pr, pushed, mergeReady, ghSince, fromAsk, state, held, unheld, pickUpAt, notesFile, deps, blockedUntil, blockReason, parent, related, relate, unrelate, install, installSha, installLabel, clearInstall, title, size, model, force, text: said, who, by, command, ownerStep, ownerDone, check, stopRun }, options) {
  if (status !== undefined && clearStatus) fail('pass --status or --clear-status, not both');
  if (related !== undefined && (relate !== undefined || unrelate !== undefined)) fail('pass --related, or --relate and --unrelate, not both');
  checkState(state);
  if (force && !FINISHED.includes(status)) fail(`--force goes with --status ${FINISHED.join(', ')}`);
  if (fromAsk !== undefined && FINISHED.includes(status)) fail('--from-ask opens a card; close it in another call');
  if (said !== undefined) text(said, '--text');
  if (ownerStep !== undefined) text(ownerStep, '--owner-step');
  const spec = check === undefined || check === '' ? check : checkSpec(check);
  if (said !== undefined && fromAsk === undefined && !FINISHED.includes(status)) fail(`--text goes with --from-ask or --status ${FINISHED.join(', ')}`);
  if (fromAsk !== undefined && said === undefined) fail('--from-ask needs --text "<first line>", the item\'s first thread line after the ask');
  if (next !== undefined && clearNext) fail('pass --next or --clear-next, not both');
  if (typeof next === 'string' && !next.trim()) [next, clearNext] = [undefined, true];
  const hold = holdOf({ held, unheld, pickUpAt });
  const built = installOf({ install, installSha, installLabel, clearInstall });
  if ([status, clearStatus, next, clearNext, pr, pushed, mergeReady, ghSince, fromAsk, state, hold, notesFile, deps, blockedUntil, blockReason, parent, related, relate, unrelate, built, title, size, model, ticket, ownerStep, check].every((v) => v === undefined || v === false)) fail('nothing to set: pass --status, --clear-status, --next, --clear-next, --pr, --pushed, --gh-since, --from-ask, --state, --held, --unheld, --pick-up-at, --notes-file, --deps, --blocked-until, --block-reason, --parent, --related, --relate, --unrelate, --install, --clear-install, --title, --size, --model, --ticket or --check');
  const ask = fromAsk === undefined ? undefined : await checkAsk(site, fromAsk);
  if (ask) await refuseMoved(site, ask);
  const { source, wave, item } = await loadItem(site, key);
  if (state === 'ready' && !['staging', 'ready'].includes(item.state) && !(ask && await quickAsk(site, ask))) fail(`${key} reads ${item.state || 'no state'}, not staging; ${NOT_STAGED}`);
  if (ask && item.from_ask && item.from_ask !== ask) fail(`${key} came from ask "${item.from_ask}", so ask "${ask}" can't be its from-ask; to fold it in: item relate-ask ${ask} ${key} --summary "<line>"`);
  // docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md
  if (ask && state === undefined && !item.state) fail('--from-ask files a card, which reads New until it has a state: pass --state ready, grilling or prototyping');
  const statusBefore = item.status;
  const wasFinished = FINISHED.includes(item.status);
  if (ownerStep !== undefined && wasFinished) fail(`${key} is already ${item.status}, so its ticket closed; an owner step goes on the command that finishes the card: land --owner-step, or builder done before the merge`);
  if (ownerStep !== undefined) item.owner_step = text(ownerStep, '--owner-step');
  if (ownerDone || status === 'dropped') delete item.owner_step;
  if (spec !== undefined && !item.owner_step) fail(`--check goes with an owner step, which ${key} doesn't have: pass --owner-step "<the step>" with it on builder done or land`);
  // Setting the same check again clears its broken mark and keeps when it was attached.
  if (spec) item.owner_check = { check: spec, since: item.owner_check?.check === spec ? item.owner_check.since : new Date().toISOString() };
  if (spec === '' || !item.owner_step) delete item.owner_check;
  const records = await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)));
  const owedBefore = owesNext(item, records);
  if (notesFile !== undefined) { await planPath(source.dir, notesFile); item.plan = path.normalize(notesFile); }
  if (title !== undefined) item.title = text(title, '--title');
  setBuildChoice(item, { size, model });
  if (deps !== undefined) {
    const list = await depList(site, parseKey(key).wave, deps);
    if (list.length) item.deps = list; else delete item.deps;
  }
  // docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md: a block waits on cards (deps) or a condition,
  // with one reason for either, which goes when the block does. lifted: the condition this call cleared, if any.
  const lifted = blockedUntil === '' ? item.blocked_until : undefined;
  if (blockedUntil !== undefined) {
    if (blockedUntil === '') delete item.blocked_until; else item.blocked_until = text(blockedUntil, '--blocked-until');
  }
  if (blockReason) {
    if (!item.deps?.length && !item.blocked_until) fail('--block-reason goes with a block: --deps or --blocked-until');
    item.block_reason = text(blockReason, '--block-reason');
  }
  if (blockReason === '' || (!item.deps?.length && !item.blocked_until)) delete item.block_reason;
  if (parent !== undefined) {
    const to = await parentKey(site, parseKey(key).wave, key, parent);
    if (to) item.parent = to; else delete item.parent;
  }
  let unlink = related === undefined ? null : await setRelated(site, key, item, related);
  if (relate !== undefined) item.related = [...new Set([...(item.related || []).map((r) => depKey(parseKey(key).wave, r)), ...await relatedKeys(site, key, relate, '--relate')])];
  if (unrelate !== undefined) unlink = await unrelateCards(site, key, item, await relatedKeys(site, key, unrelate, '--unrelate'));
  if (hold !== undefined) setHold(item, hold);
  if (status === 'building' && (item.held || item.status === 'held')) {
    fail(item.pick_up_at ? `${key} is held until ${item.pick_up_at}, when the board resumes it; start it early only with item set ${key} --unheld`
      : `${key} is held; start it only once the owner resumes it, with item set ${key} --unheld`);
  }
  if (status === 'planned' || status === 'waiting') fail(`--status ${status} is gone: an unstarted card has no status. Clear it with --clear-status`);
  if (status !== undefined) item.status = ITEM_STATUSES.includes(status) ? status : fail(`--status takes ${ITEM_STATUSES.join(', ')}`);
  if (LEAVES_TODO.includes(status) || pr !== undefined || pushed !== undefined || mergeReady !== undefined) clearHold(item);
  if (status === 'building') {
    const blockers = await unfinishedDeps(site, parseKey(key).wave, item);
    if (blockers.length) fail(`${key} is blocked by ${blockers.join(', ')}; start it once ${blockers.length === 1 ? 'that is' : 'those are'} done or merged`);
    if (item.blocked_until) fail(`${key} is blocked until ${item.blocked_until}; start it once that holds and the block is cleared with --blocked-until ""`);
  }
  const unpicked = status === 'building' && site ? await unpickedPrototype(site, key) : null;
  if (unpicked) fail(`${key} has no take picked: the owner's answer to ${unpicked.id} picks none${unpicked.note ? ` ("${clip(unpicked.note)}")` : ''}, so it prototypes again: draw the next round from that note, or grill when the note asks a question, and build once a take is picked`);
  const resolve = FINISHED.includes(status) ? await closeQuestions(site, key, `--status ${status}`, force) : async () => [];
  const lastLine = FINISHED.includes(status) ? closingLine(site, key, { ...item, status: statusBefore }, status, said, boardRepoOf(site, wave)) : null;
  if (clearStatus) delete item.status;
  // A newer status_at overrides the owner's card-done in domain.mjs.
  if (status !== undefined || clearStatus) item.status_at = new Date().toISOString();
  if (next !== undefined) {
    setNext(item, next, await hasOpenQuestion(site, key));
    await checkNextDeps(site, key, item, item.next);
  }
  if (clearNext) { delete item.next; delete item.next_on_questions; }
  // A build starting acts on whatever a Next set during the card's questions waited on.
  if (status === 'building' && next === undefined && item.next_on_questions) { delete item.next; delete item.next_on_questions; }
  // The In Review lane sorts by this first arrival, which no later PR, push, merge-ready, tap or land rewrites.
  if ((pr !== undefined || pushed !== undefined || mergeReady !== undefined) && !item.review_since) item.review_since = new Date().toISOString();
  if (pr !== undefined) {
    addPRs(item, pr, boardRepoOf(site, wave));
    clearBuildingStatus(item);
  }
  // docs/adr/2026-11-02-1850-a-board-can-work-on-any-git-remote.md
  if (pushed !== undefined) {
    if (!listBoards().find((b) => samePath(b.dir, needSite(site)))?.remote) fail('--pushed is for a board whose repo is a plain git remote; on GitHub, open a PR and pass --pr');
    if (hasPR(item)) fail(`${key} has a PR; its PR says when it merges`);
    try { validateBranch(pushed); } catch { fail('--pushed takes the name of the branch you pushed'); }
    item.pushed = { branch: pushed, at: new Date().toISOString() };
    item.branch = pushed;
    clearBuildingStatus(item);
  }
  // docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md: a verified branch that waits for the owner's Merge.
  if (mergeReady !== undefined) {
    item.merge_ready = { branch: mergeReady, at: new Date().toISOString() };
    item.branch = mergeReady;
    clearBuildingStatus(item);
  }
  if (FINISHED.includes(status)) delete item.merge_ready;
  if (ghSince !== undefined) {
    if (typeof ghSince !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(ghSince) || Number.isNaN(Date.parse(ghSince))) fail('--gh-since takes an ISO-8601 UTC time such as 2026-10-23T11:00:00Z');
    item.gh_since = ghSince;
  }
  if (ask) item.from_ask = ask;
  // docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md: ready leaves the owner nothing to decide.
  if (state === 'ready' && site) {
    const open = (await cardQuestions(site, key)).asked.filter((q) => q.state === 'open').map((q) => q.id);
    if (open.length) fail(`${key} has ${open.length === 1 ? 'an open question' : 'open questions'} ${open.join(', ')}; it is ready once the owner has answered ${open.length === 1 ? 'it' : 'them'}`);
    await checkNotesComplete(site, key, source.dir, item);
  }
  if (state !== undefined) {
    // docs/adr/2026-11-07-0700-staging-then-ready.md: sent back from staging or ready, the card gets its round from the board (domain.mjs roundsDue).
    if (state !== 'ready' && ['staging', 'ready'].includes(item.state)) item.round_at = new Date().toISOString();
    item.state = state;
    delete item.staged_at;
    delete item.unfiled;
  }
  // docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md: a Next never asks for the state the card is in.
  if (item.state === 'ready' && ASKS_READY.test(item.next ?? '')) fail(`${key} would read ready with Next "${item.next}", which asks for the state it is already in; pass --next with what happens next, or --clear-next`);
  if (built) item.install = built;
  if (built === null) delete item.install;
  // docs/adr/2026-11-03-0237-an-in-progress-card-always-has-a-builder-line-or-a-next.md: building and fixing go with a builder start.
  if (!owedBefore && !['building', 'fixing'].includes(status) && owesNext(item, records)) fail(`that leaves ${key} In Progress with nothing building and no Next; pass --next "<what happens next>"`);
  // docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md: a block on a card In Progress sends
  // it back to Todo. stopRun, item set's, stops its board-launched build first and refuses a session's; the worktree and
  // branch stay on its records, and its state stays, so the pull starts it again once nothing blocks it.
  const blocked = (deps !== undefined || blockedUntil) && status === undefined && !clearStatus && inProgress(item, records) ? await blockWords(site, key, item) : '';
  const stops = blocked && records.some((r) => r?.started && !r.done && builds(r)) ? await stopRun() : [];
  if (blocked) {
    delete item.status;
    item.status_at = new Date().toISOString();
  }
  if (ticket !== undefined || (ask && !item.ticket && !item.linear?.length)) await assignTicket(site, key, wave, item, ticket, options, source.dir);
  await writeJSON(source.file, wave);
  if (blocked) {
    await closeBuilders(source.dir, item.id, false);
    await appendLine(threadFile(site, key), { ts: new Date().toISOString(), who: 'claude', text: `Blocked ${blocked}: back to Todo. It starts again once nothing blocks it.` });
  }
  if (unlink) await unlink();
  const resolved = [...stops, ...await resolve()];
  // docs/adr/2026-11-01-1813-an-answered-question-stops-waiting-once-claude-acts-on-its-card.md
  // Ready checked that the notes name every answered question, so it resolves them as a new notes file does.
  if (notesFile !== undefined || (state === 'ready' && site)) resolved.push(...await resolveAnswered(site, key, "Recorded in the card's notes"));
  if (status === 'building') resolved.push(...await resolveAnswered(site, key, 'Acted on: build started'));
  if (ask) resolved.push(...(await appendThread(site, key, { text: said })).lines);
  if (lastLine && site) resolved.push(...(await appendThread(site, key, { text: lastLine, who, by, command })).lines);
  // The ticket stays open while the card waits on its owner step.
  const target = item.owner_step && FINISHED.includes(status) ? null : ticketTarget({ status, pr: pr ?? pushed ?? mergeReady });
  const moved = target && await moveTicket(await boardSource(site), item, target, { ...options, repo: boardRepoOf(site, wave) });
  if (moved) resolved.push(moved);
  // A builder that forgot builder done would keep the card In Progress after it was handed back.
  if (pr !== undefined || pushed !== undefined || mergeReady !== undefined || HANDED_BACK.includes(status)) await closeBuilders(source.dir, item.id, FINISHED.includes(status));
  if (pr !== undefined || pushed !== undefined || mergeReady !== undefined || HANDED_BACK.includes(status)) await publishStaged(site, key);
  // An ask is in one card's thread: becoming this item moves it out of a card it was folded into.
  const links = ask ? await readAskLinks(site) : {};
  if (routeRecord(links, ask) !== undefined) { delete links[ask]; await writeJSON(askLinksFile(site), { links }); }
  if (lifted && !FINISHED.includes(item.status) && !(await unfinishedDeps(site, parseKey(key).wave, item)).length) {
    await appendLine(threadFile(site, key), { ts: new Date().toISOString(), who: 'claude', text: `Unblocked: ${lifted}.` });
    await appendEvent({ dir: site }, 'card-unblocked', { key });
    resolved.unshift(`unblocked: ${key}`);
  }
  if (!FINISHED.includes(status) || wasFinished) return { file: source.file, lines: resolved };
  const unblocked = await unblockedBy(site, key);
  // The owner reads a card's wait in its thread, so the line that ends it goes there too.
  const ts = new Date().toISOString();
  for (const k of unblocked) {
    await appendLine(threadFile(site, k), { ts, who: 'claude', text: `Unblocked: ${await cardName(site, key)} is ${status}.` });
    await appendEvent({ dir: site }, 'card-unblocked', { key: k });
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
// The hold --held, --unheld and --pick-up-at ask for: {until} holds the card, until null meaning until the owner resumes
// it, null resumes it, and undefined leaves it. --pick-up-at "" clears the time, which resumes the card.
function holdOf({ held, unheld, pickUpAt }) {
  if ([held, unheld, pickUpAt !== undefined].filter(Boolean).length > 1) fail('pass one of --held, --unheld and --pick-up-at');
  if (pickUpAt !== undefined) return pickUpAt === '' ? null : { until: pickUpTime(pickUpAt) };
  return held ? { until: null } : unheld ? null : undefined;
}
// A past time is refused, so a typo can't start a card at once.
function pickUpTime(value) {
  const ms = typeof value === 'string' && AT_RE.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) fail('--pick-up-at takes an ISO time such as 2026-11-04T09:00, the Mac’s local time unless it names an offset, or "" to resume the card');
  if (ms <= Date.now()) fail(`--pick-up-at ${value} has passed; pass a later time, or --unheld to resume the card now`);
  return new Date(ms).toISOString();
}
// A card that has left Todo is never still held, so --status building, fixing, checking and the finished ones, --pr and
// --pushed drop its hold and pick-up time.
const LEAVES_TODO = ['building', 'fixing', 'checking', ...FINISHED];
function clearHold(item) {
  delete item.held;
  delete item.pick_up_at;
}
function setHold(item, hold) {
  if (hold) item.held = true; else delete item.held;
  if (hold?.until) item.pick_up_at = hold.until; else delete item.pick_up_at;
  if (!hold && item.status === 'held') delete item.status;
  item.held_at = new Date().toISOString();
}

// A held card whose pick-up time `until` has passed, as board/server.mjs checkPickUps finds it: resumed in its wave
// file. announce first adds a thread line and, unless a dep is unfinished or a condition blocks it, card-unblocked {key, until}, as a finished
// dep does; it is false when those were sent before a restart cut the write short.
export async function pickUp(site, key, until, { announce = true } = {}) {
  const { source, wave, item } = await loadItem(site, key);
  if (announce) {
    const at = new Date(until).toLocaleString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    await appendLine(threadFile(site, key), { ts: new Date().toISOString(), who: 'claude', text: `Resumed: its hold until ${at} ended.` });
    if (!item.blocked_until && !(await unfinishedDeps(site, parseKey(key).wave, item)).length) await appendEvent({ dir: site }, 'card-unblocked', { key, until });
  }
  setHold(item, null);
  await writeJSON(source.file, wave);
}

// The owner's Hold, Resume or Done tap (card-hold {key, hold, until?} or card-done {key}), or a Full person's, whose
// data.shared_by {login, name} names their thread line, recorded in the wave file as the board server takes it, with a thread line; a Done unblocks blocked cards as item set --status done does
// (docs/adr/2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md). A merged or dropped card, and a Hold on a
// are left as they are. → the item set result, or null when nothing was written.
export async function recordOwnerTap(site, kind, data) {
  const key = String(data?.key || '');
  const { wave: slug, id } = parseKey(key);
  const { source, wave } = await loadWave(site, slug);
  // The owner's line, so it answers none of their messages that wait on Claude.
  const by = data.shared_by ? data.shared_by.name || data.shared_by.login : undefined;
  // docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md: each tap's line is its status line.
  const said = { text: COMMANDS.done, who: 'love', by, command: 'done' };
  const item = wave.items.find((it) => it.id === id) || fail(`wave "${slug}" has no item "${id}"`);
  // A merged card waiting on its owner step closes on the owner's Done, staying merged.
  const stepOpen = kind === 'card-done' && Boolean(item.owner_step);
  if (!stepOpen && ['merged', 'dropped'].includes(item.status)) return null;
  if (kind === 'card-done') return setItem(site, key, { status: item.status === 'merged' ? 'merged' : 'done', force: true, ownerDone: true, ...said });
  const until = data.hold ? (typeof data.until === 'string' ? new Date(data.until).toISOString() : null) : undefined;
  setHold(item, data.hold ? { until } : null);
  await writeJSON(source.file, wave);
  // A hold stops the card's builders, so their records close: an open record with an exited process is relaunched.
  if (data.hold) { await closeBuilders(source.dir, id, false); await publishStaged(site, key); }
  const at = until && new Date(until).toLocaleString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return appendThread(site, key, data.hold ? { text: at ? `${COMMANDS.hold} until ${at}` : COMMANDS.hold, who: 'love', by, command: 'hold' }
    : { text: COMMANDS.resume, who: 'love', by, command: 'resume' });
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
  return setItem(site, key, { status: item.status === 'merged' ? 'merged' : 'done', force: true, ownerDone: true, text: `Check passed: ${found}. Closed.` });
}

// The hub's poll couldn't run the owner step's check several times in a row: the card reads it broken, the poll stops
// running it, a thread line says so and owner-check-broken {key, check, error} wakes the session to fix it with item set
// --check. The owner's Done still closes the card. → true when it marked the check, false when the card moved on.
export async function breakOwnerCheck(site, key, check, error) {
  const { source, wave, item } = await loadItem(site, key);
  if (!item.owner_step || item.owner_check?.check !== check) return false;
  item.owner_check.broken = error;
  await writeJSON(source.file, wave);
  await appendThread(site, key, { text: `The check for "${item.owner_step}" can't run (${error}), so it stopped; Claude is asked to fix it. Done still closes the card.` });
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
// --parent for card key of wave slug (key null for a new card): the key of a card that exists, neither key itself nor
// one of its descendants (the walk up its ancestors stops at one that no longer exists); "" is none.
async function parentKey(site, slug, key, parent) {
  if (!String(parent).trim()) return null;
  const to = depKey(slug, String(parent).trim());
  if (to === key) fail("--parent: a card can't be its own Parent");
  for (let at = to; at;) {
    // Only the new Parent must exist; an ancestor that is gone can't be a descendant of key, so the walk ends there.
    const loaded = at === to ? await loadItem(site, at) : await loadItem(site, at).catch((e) => { if (e instanceof BoardError) return null; throw e; });
    if (!loaded) break;
    const { item } = loaded;
    if (item.parent && depKey(parseKey(at).wave, item.parent) === key) fail(`--parent: ${to} is a child of ${key}, so it can't be its Parent`);
    at = item.parent ? depKey(parseKey(at).wave, item.parent) : null;
  }
  return to;
}

// A --related, --relate or --unrelate list for card key (<wave>/<id>, or <wave> for a card not made yet): a comma list
// of cards that exist, as keys, without repeats.
async function relatedKeys(site, key, value, flag) {
  const slug = key.split('/')[0];
  const list = [...new Set(String(value).split(',').map((r) => r.trim()).filter(Boolean).map((r) => depKey(slug, r)))];
  if (list.includes(key)) fail(`${flag}: a card can't be related to itself`);
  for (const r of list) await loadItem(site, r);
  return list;
}

// A link shows on both cards whichever stores it, so taking one off means taking it off the other card too: → the
// write that drops key from the Related to of each other card that drop(<its key>) picks, run once key's own wave
// file is written.
const dropLinksTo = (site, key, drop) => async () => {
  for (const entry of await itemSources(site)) {
    const wave = await readJSON(entry.file, null);
    let changed = false;
    for (const it of Array.isArray(wave?.items) ? wave.items : []) {
      const own = `${entry.slug}/${it.id}`;
      if (own === key || !drop(own) || !(it.related || []).some((r) => depKey(entry.slug, r) === key)) continue;
      it.related = it.related.filter((r) => depKey(entry.slug, r) !== key);
      if (!it.related.length) delete it.related;
      changed = true;
    }
    if (changed) await writeJSON(entry.file, wave);
  }
};

// --related for card key: the list replaces the cards it is related to; "" is none. Each card the list leaves out
// loses its own link to key too.
async function setRelated(site, key, item, related) {
  const list = await relatedKeys(site, key, related, '--related');
  if (list.length) item.related = list; else delete item.related;
  return dropLinksTo(site, key, (own) => !list.includes(own));
}

// --unrelate for card key: the listed cards come off its Related to, and key off theirs; the rest stay.
function unrelateCards(site, key, item, list) {
  const kept = (item.related || []).filter((r) => !list.includes(depKey(parseKey(key).wave, r)));
  if (kept.length) item.related = kept; else delete item.related;
  return dropLinksTo(site, key, (own) => list.includes(own));
}

export const boardRepoOf = (site, wave) => (site && listBoards().find((b) => samePath(b.dir, site))?.github) || wave.repo;

// → one report per PR on the card, in its order, each naming its repo.
export async function prReport(site, key) {
  const { wave, item } = await loadItem(site, key);
  if (!hasPR(item)) fail(`${key} has no PR`);
  const prs = cardPRs(item, boardRepoOf(site, wave));
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
    // The comment also goes in the thread of each reviewer's link to the PR, once the hub's next poll sends it.
    const told = await queueReply(site, prKeyOf({ repo, number: ref.number }), 'comment', `Comment on #${ref.number}: ${words}`);
    return { lines: [`posted on PR ${ref.repo ? pr : `#${pr}`}: ${url}`, ...(told.length ? [`queued for ${told.join(', ')}'s Slack thread`] : [])] };
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
  const { wave, item } = await loadItem(site, key);
  if (!hasPR(item)) fail(`${key} has no PR`);
  if (FINISHED.includes(item.status)) fail(`${key} is ${item.status}`);
  // docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md: auto-merge's refusal too.
  const blocked = await blockWords(site, key, item);
  if (blocked) {
    if (tapped) await appendThread(site, key, { text: `Not merged: blocked ${blocked}.` });
    fail(`Not merged: blocked ${blocked}.`);
  }
  const repo = boardRepoOf(site, wave);
  const prs = cardPRs(item, repo);
  if (!prs.length) fail(`${key} has no repo`);
  const now = new Date().toISOString();
  let fetched;
  try { fetched = await Promise.all(prs.map((p) => fetchPR({ repo: p.repo, pr: p.number, since: now }))); } catch (e) { fail(e.message); }
  const states = fetched.map(({ view }) => view);
  if (allLanded(states)) {
    const merged = prs.filter((_, i) => states[i].state === 'MERGED');
    return setItem(site, key, { status: 'merged', text: `PR${merged.length > 1 ? 's' : ''} ${prNames(merged, repo)} ${merged.length > 1 ? 'were' : 'was'} already merged.` });
  }
  const open = prs.map((p, i) => ({ ...p, ...fetched[i] })).filter(({ view }) => view.state === 'OPEN');
  // docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md: a card no reviewer is on merges with no approval.
  const needsApproval = reviewersOf(wave, (await boardConfig(site)).reviewers || []).length > 0;
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
    if (tapped) await appendThread(site, key, { text: why });
    fail(why);
  }
  const done = [];
  for (const p of open) {
    const error = await new Promise((resolve) => {
      execFile('gh', ['pr', 'merge', String(p.number), '--repo', p.repo, '--squash'], { encoding: 'utf8', timeout: 120_000 }, (e, stdout, stderr) => resolve(e ? String(stderr || e.message).trim().split('\n')[0] : null));
    });
    if (error) fail(`gh pr merge ${prNames([p], repo)} failed: ${error}${done.length ? ` (merged ${prNames(done, repo)} before it)` : ''}`);
    done.push(p);
  }
  const said = [mergedLine(done, repo), afterApproval !== undefined && `After the approval: ${text(afterApproval, '--after-approval')}`,
    rebasedOnly && `After the approval: only the board's rebase onto ${item.rebased.at(-1).base}.`, steps && `The owner's word on the manual steps: "${steps}"`];
  return setItem(site, key, { status: 'merged', text: said.filter(Boolean).join(' ') });
}

// docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md
// The card's verified branch waiting for the owner's Merge ({branch, at, tapped?}), or null.
export async function heldMerge(site, key) {
  return (await loadItem(site, key)).item.merge_ready || null;
}
// The owner's Merge on a held card. tapped, the tap's time, is the go that the land it starts, and a lander after it,
// finish on. → the held merge
export async function tapMerge(site, key) {
  const { source, wave, item } = await loadItem(site, key);
  if (!item.merge_ready || FINISHED.includes(item.status)) fail(`${key} isn't waiting for its Merge`);
  const blocked = await blockWords(site, key, item);
  if (blocked) fail(`${key} is blocked ${blocked}, so its Merge waits until nothing blocks it`);
  item.merge_ready.tapped = new Date().toISOString();
  await writeJSON(source.file, wave);
  return item.merge_ready;
}
// The Claude model of the card's newest builder record that kept a worktree, for its lander.
export async function builderModel(site, key) {
  const { source, item } = await loadItem(site, key);
  const records = (await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)))).filter((r) => r?.worktree?.path);
  return records.sort((a, b) => String(b.started).localeCompare(String(a.started)))[0]?.model;
}

// Sets item.ticket from the board's source, and ticket_created when kickflip made it. self is the card's <wave>/<id>:
// an Internal ticket another card holds is refused. Every path that makes a card comes through here
// (board/ticket-paths.test.mjs).
async function assignTicket(site, self, wave, item, ticket, options, dir) {
  try {
    const cfg = await boardConfig(site);
    const source = ticketSource(cfg.tickets || { source: 'internal' });
    const ownId = (w, it) => (w.internal === true ? String(it.id).replace(/^S(\d+)$/, `${source.prefix}-$1`) : null);
    if (ticket === undefined && source.source === 'internal' && ticketIn(source, ownId(wave, item))) ticket = ownId(wave, item);
    let max = 0;
    if (source.source === 'internal') {
      for (const entry of await itemSources(site)) {
        const w = await readJSON(entry.file, {});
        for (const it of w.items || []) {
          const ids = [it.ticket, ownId(w, it)];
          max = Math.max(max, ...ids.map((id) => ticketIn(source, id) || 0));
          if (ticket !== undefined && `${entry.slug}/${it.id}` !== self && ids.includes(ticket)) throw Object.assign(new BoardError(`${ticket} is already the ticket of ${entry.slug}/${it.id}`), { held: true });
        }
      }
    }
    const body = ticket === undefined && source.source !== 'internal' && item.plan ? await fs.readFile(await planPath(dir, item.plan), 'utf8') : item.notes || '';
    const r = await resolveTicket(source, { ticket, title: item.title, body, repo: boardRepoOf(site, wave), next: max + 1 }, options);
    item.ticket = r.ticket;
    if (r.created && source.source !== 'internal') item.ticket_created = true; else delete item.ticket_created;
  } catch (e) { if (e instanceof BoardError) throw e; fail(e.message); }
}

const ticketWrite = (site, fn) => withFileLock(path.join(site || wavesDir(), 'tickets'), fn, { heartbeat: true });
export const setItem = (site, key, changes, options) => (changes.ticket !== undefined || changes.fromAsk !== undefined
  ? ticketWrite(site, () => changeItem(site, key, changes, options)) : changeItem(site, key, changes, options));
export const addItem = (site, key, details, options) => ticketWrite(site, () => createItem(site, key, details, options));

// → {file, key}. A new card starts unstarted: no status. key is <wave>/<id>, or <wave>
// alone, which names the card from the ticket made or linked for it. parent is the card it was spun out of
// (docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md).
// docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md: state files the card at once, with
// relate its Related to. With intake, a site and no state, the card is unfiled, reading New, and a `card-added {key, title}`
// event wakes the board's session to file it; once filed it arrives in Todo and gets its grill
// (docs/adr/2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md) unless it is ready.
async function createItem(site, key, { title, notes, deps, notesFile, ticket, pickUpAt, parent, size, model, state, relate, intake = false }, options) {
  const { wave: slug, id } = key.includes('/') ? parseKey(key) : { wave: key };
  if (id !== undefined) domId(id, 'the item id');
  checkState(state);
  if (state === 'ready') fail("item add files a card grilling or prototyping; it reaches ready through staging, on the owner's Send, Implement or Reply");
  const { source, wave } = await loadWave(site, slug);
  if (id !== undefined && wave.items.some((it) => it.id === id)) fail(`wave "${slug}" already has an item "${id}"`);
  const item = { id, title: text(title, '--title'), created: new Date().toISOString() };
  if (parent !== undefined) item.parent = await parentKey(site, slug, null, parent) || fail('--parent takes a card, such as <wave>/<id>');
  if (notes !== undefined) item.notes = text(notes, '--notes');
  setBuildChoice(item, { size, model });
  if (deps !== undefined) item.deps = await depList(site, slug, deps);
  if (notesFile !== undefined) { await planPath(source.dir, notesFile); item.plan = path.normalize(notesFile); }
  if (pickUpAt !== undefined) setHold(item, { until: pickUpTime(pickUpAt) });
  if (relate !== undefined) item.related = await relatedKeys(site, key, relate, '--relate');
  if (state !== undefined) item.state = state;
  // Without a site there is no board session to file it.
  else if (intake && site) item.unfiled = true;
  await assignTicket(site, key, wave, item, ticket, options, source.dir);
  if (id === undefined) {
    item.id = cardIdOf(item.ticket);
    if (wave.items.some((it) => it.id === item.id)) fail(`wave "${slug}" already has an item "${item.id}"; link ${item.ticket} with item add ${slug}/<id> --ticket ${item.ticket}`);
  }
  const added = `${slug}/${item.id}`;
  wave.items.push(item);
  await writeJSON(source.file, wave);
  if (item.unfiled) await appendEvent(listBoards().find((b) => samePath(b.dir, site)) || { dir: site }, 'card-added', { key: added, title: item.title });
  return { file: source.file, key: added, lines: [] };
}

// `tickets backfill`: each open card with no ticket links the first id in its title, or in its legacy
// `linear` list, that belongs to the board's source, else gets a new ticket. An internal wave's card whose ticket is
// its own id has none outside the board, so under GitHub or Linear it gets one too. An Internal id another card holds is only
// a mention, so that card gets a new one. Done cards are left alone. dryRun writes nothing and calls no source.
// → {file, lines}: one line per card, then a count.
export const backfillTickets = (site, { dryRun = false } = {}, options) => ticketWrite(needSite(site), () => backfill(site, dryRun, options));
async function backfill(site, dryRun, options) {
  const source = (await boardSource(site)) || fail('this board has no ticket source yet; pick one in Board settings first');
  const held = new Set();
  const waves = [];
  for (const entry of await itemSources(site)) {
    const wave = await readJSON(entry.file, null);
    if (!Array.isArray(wave?.items)) continue;
    waves.push({ entry, wave });
    for (const it of wave.items) {
      if (it.ticket) held.add(it.ticket);
      if (wave.internal === true && source.source === 'internal') held.add(String(it.id).replace(/^S(\d+)$/, `${source.prefix}-$1`));
    }
  }
  const lines = [];
  const counts = { linked: 0, created: 0, failed: 0 };
  const ticketed = (wave, it) => it.ticket && !(source.source !== 'internal' && wave.internal === true && it.ticket === it.id);
  for (const { entry, wave } of waves) {
    for (const it of wave.items) {
      if (ticketed(wave, it) || FINISHED.includes(it.status)) continue;
      const key = `${entry.slug}/${it.id}`;
      const found = [...titleTickets(source, it.title), ...(it.linear || []).filter((id) => ticketIn(source, id))]
        .find((id) => source.source !== 'internal' || !held.has(id));
      if (dryRun) {
        counts[found ? 'linked' : 'created']++;
        lines.push(`${key} would ${found ? `link ${found}` : 'get a new ticket'}`);
        continue;
      }
      try {
        await assignTicket(site, key, wave, it, found, options, entry.dir);
        await writeJSON(entry.file, wave);
        held.add(it.ticket);
        counts[found ? 'linked' : 'created']++;
        lines.push(`${key} ${found ? 'linked' : 'created'} ${it.ticket}`);
      } catch (e) {
        if (!(e instanceof BoardError)) throw e;
        counts.failed++;
        lines.push(`${key} failed: ${e.message}`);
      }
    }
  }
  const total = dryRun ? `would link ${counts.linked}, create ${counts.created}`
    : `linked ${counts.linked}, created ${counts.created}, failed ${counts.failed}`;
  return { lines: [...lines, `backfill${dryRun ? ' (dry run)' : ''}: ${total}`] };
}

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
// Moves each wave file's follow-ups, a list kept beside its items until then, into its items, once: each keeps its id,
// title, ticket and notes, its date as when it was made, and its Filed from as its Parent; a done one is done, closed
// at its thread's last line. A wave whose follow-up has a card's id is left as it is, and named in the refusal.
// Run by the board server as it starts. → one line per wave file moved.
export const migrateFollowups = (site) => ticketWrite(site, async () => {
  const lines = [];
  for (const entry of await itemSources(site)) {
    const wave = await readJSON(entry.file, null);
    if (!Array.isArray(wave?.items) || !Array.isArray(wave.followups)) continue;
    const clash = wave.followups.find((f) => wave.items.some((it) => it.id === f.id));
    if (clash) fail(`${entry.slug}: follow-up ${clash.id} has the id of a card; rename one, then restart the board`);
    const moved = [];
    for (const { id, title, from, filed, done, ...rest } of wave.followups) {
      const closedAt = done ? (site && (await readLines(threadFile(site, `${entry.slug}/${id}`))).map((l) => l.ts).filter(Boolean).sort().pop()) || filed : null;
      moved.push({ id, title, ...(filed ? { created: filed } : {}), ...(from ? { parent: depKey(entry.slug, from) } : {}),
        ...(done ? { status: 'done' } : {}), ...(closedAt ? { status_at: closedAt } : {}), ...rest });
    }
    const { followups, ...kept } = wave;
    await writeJSON(entry.file, { ...kept, items: [...wave.items, ...moved] });
    lines.push(`${entry.slug}: ${moved.length} follow-ups moved to cards (${moved.filter((m) => m.status === 'done').length} done)`);
  }
  return lines;
});

// docs/adr/2026-11-05-0226-a-grill-with-nothing-left-to-ask-ends-ready.md
// Removes the statuses "planned" and "waiting" from every card of a site's wave files: an unstarted card has no status.
// Run by the board server as it starts. → one line per wave file changed.
export const dropPlannedStatus = (site) => ticketWrite(site, async () => {
  const lines = [];
  for (const entry of await itemSources(site)) {
    const wave = await readJSON(entry.file, null);
    const planned = (Array.isArray(wave?.items) ? wave.items : []).filter((it) => ['planned', 'waiting'].includes(it.status));
    if (!planned.length) continue;
    for (const it of planned) delete it.status;
    await writeJSON(entry.file, wave);
    lines.push(`${entry.slug}: ${planned.length} planned or waiting cards now have no status`);
  }
  return lines;
});

// docs/adr/2026-11-07-0700-staging-then-ready.md
// An Implement message's wait from before staging, implement_at, becomes staging, keeping its time as staged_at; a card
// already ready, which the old release would have started, stays ready. Run by the board server as it starts. → one
// line per wave file changed.
export const stageImplementAsks = (site) => ticketWrite(site, async () => {
  const lines = [];
  for (const entry of await itemSources(site)) {
    const wave = await readJSON(entry.file, null);
    const asked = (Array.isArray(wave?.items) ? wave.items : []).filter((it) => it.implement_at);
    if (!asked.length) continue;
    for (const it of asked) {
      if (it.state !== 'ready') Object.assign(it, { state: 'staging', staged_at: it.implement_at });
      delete it.implement_at;
    }
    await writeJSON(entry.file, wave);
    lines.push(`${entry.slug}: ${asked.length} Implement asks moved to staging or ready`);
  }
  return lines;
});

// docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md
// data/done-archive.json {cards: [{key, wave, archived_at, closed_at, item, questions, asks}]}, newest closed first:
// the Done cards that left the board, each with when it closed (its Done card's sortAt), its wave file entry and its
// resolved questions from owner.json. The board build never reads it; GET /api/done builds a page of its cards as they
// page in (docs/adr/2026-11-04-1056-archived-done-cards-are-built-as-they-page-in.md), and GET /api/thread reads an
// archived card's entry. An empty archive is no file. Its thread, notes and builder records stay where they are. asks
// are the asks the card was made from that its move linked to it in data/ask-links.json, so the board still reads them
// as gone into that card.
export const archiveFile = (site) => path.join(site, 'data', 'done-archive.json');
const archiveWrite = (site, fn) => withFileLock(path.join(site, 'done-archive'), fn, { heartbeat: true });
export const readArchive = async (site) => (await readJSON(archiveFile(site), { cards: [] })).cards || [];
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
  await writeJSON(archiveCountFile(site), { count });
  return count;
}
async function writeArchive(site, cards) {
  if (cards.length) await writeJSON(archiveFile(site), { cards: cards.sort(byClosed) });
  else await fs.rm(archiveFile(site), { force: true });
  await writeJSON(archiveCountFile(site), { count: cards.length });
}

// Moves picks [{key, closed_at}] (server.mjs from domain.mjs archivedOf) from their wave files to the archive,
// with their resolved questions; a pick no longer finished in its wave file stays. The archive is written first, so
// a stop part way leaves a card in both, and the next run moves it again. → the keys moved.
export const archiveCards = (site, picks) => archiveWrite(site, async () => {
  const wanted = new Map(picks.map((p) => [p.key, p]));
  const at = new Date().toISOString();
  const moved = [];
  const writes = [];
  for (const source of await itemSources(site)) {
    const wave = await readJSON(source.file, null);
    if (!Array.isArray(wave?.items)) continue;
    const leaving = wave.items.filter((it) => wanted.has(`${source.slug}/${it.id}`) && FINISHED.includes(it.status));
    if (!leaving.length) continue;
    for (const item of leaving) moved.push({ ...wanted.get(`${source.slug}/${item.id}`), wave: source.slug, archived_at: at, item });
    writes.push([source.file, { ...wave, items: wave.items.filter((it) => !leaving.includes(it)) }]);
  }
  if (!moved.length) return [];
  const owner = await readJSON(ownerFile(site), { items: [] });
  const topics = new Map(moved.map((m) => [`item:${m.key}`, m]));
  for (const m of moved) m.questions = (owner.items || []).filter((q) => q.topic === `item:${m.key}` && q.resolved);
  const links = await readAskLinks(site);
  for (const m of moved) m.asks = m.item.from_ask && routeRecord(links, m.item.from_ask) === undefined ? [m.item.from_ask] : [];
  const keys = new Set(moved.map((m) => m.key));
  await writeArchive(site, [...(await readArchive(site)).filter((a) => !keys.has(a.key)), ...moved.map(({ key, wave, archived_at, closed_at, item, questions, asks }) => ({ key, wave, archived_at, closed_at, item, questions, asks }))]);
  if (moved.some((m) => m.asks.length)) await writeJSON(askLinksFile(site), { links: { ...links, ...Object.fromEntries(moved.flatMap((m) => m.asks.map((id) => [id, m.key]))) } });
  for (const [file, wave] of writes) await writeJSON(file, wave);
  const kept = (owner.items || []).filter((q) => !(topics.has(q.topic) && q.resolved));
  if (kept.length !== (owner.items || []).length) await writeJSON(ownerFile(site), { ...owner, items: kept });
  return [...keys];
});

// Puts archived card key back in its wave file, with its questions, for a command that names it. → whether it was
// archived.
async function restoreArchived(site, key) {
  if (!site || !existsSync(archiveFile(site))) return false;
  return archiveWrite(site, async () => {
    const archive = await readArchive(site);
    const entry = archive.find((a) => a.key === key);
    if (!entry) return false;
    const source = (await itemSources(site)).find((s) => s.slug === entry.wave);
    const wave = source && await readJSON(source.file, null);
    if (!Array.isArray(wave?.items)) return false;
    if (!wave.items.some((it) => it.id === entry.item.id)) await writeJSON(source.file, { ...wave, items: [...wave.items, entry.item] });
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
// Drops what nothing reads, once: an archive entry's page card, keeping its sortAt as closed_at; a wave item's summary;
// and a question's push_tag and no_change, in owner.json and in the archive. Writes only a file that held one. Run by
// the board server as it starts.
const DEAD_QUESTION_FIELDS = ['push_tag', 'no_change'];
const stripQuestion = (q) => Object.fromEntries(Object.entries(q).filter(([k]) => !DEAD_QUESTION_FIELDS.includes(k)));
const stripItem = ({ summary, ...it }) => it;
const holdsDead = (q) => DEAD_QUESTION_FIELDS.some((k) => k in q);
export const stripDeadFields = (site) => archiveWrite(site, async () => {
  for (const source of await itemSources(site)) {
    const wave = await readJSON(source.file, null);
    if (Array.isArray(wave?.items) && wave.items.some((it) => 'summary' in it)) await writeJSON(source.file, { ...wave, items: wave.items.map(stripItem) });
  }
  const owner = await readJSON(ownerFile(site), null);
  if ((owner?.items || []).some(holdsDead)) await writeJSON(ownerFile(site), { ...owner, items: owner.items.map(stripQuestion) });
  const archive = await readArchive(site);
  if (archive.some((a) => 'card' in a || 'summary' in a.item || (a.questions || []).some(holdsDead))) {
    await writeArchive(site, archive.map(({ card, ...a }) => ({ ...a, ...(card ? { closed_at: a.closed_at || card.sortAt } : {}),
      item: stripItem(a.item), questions: (a.questions || []).map(stripQuestion) })));
  }
});

// A lineup is what the owner calls a wave: a named set of one wave file's cards in build order, kept in that file's
// `lineups` (docs/adr/2026-11-02-1202-a-wave-the-owner-asks-for-is-a-lineup-of-cards.md). Its note is lineup-<slug>.md beside
// the file. Its cards are in phases, and each card is blocked by every card of the phase before
// (docs/adr/2026-11-04-0238-a-wave-builds-in-phases.md); every write keeps them as `phases`, in place of a chain's `items`.
export const lineupNoteFile = (slug) => `lineup-${slug}.md`;
const lineupSlug = (v) => (typeof v === 'string' && /^[a-z0-9-]+$/.test(v) ? v : fail(`a wave's slug uses only a-z, 0-9 and "-", not "${v}"`));

async function findLineup(site, slug) {
  for (const source of await itemSources(site)) {
    const wave = await readJSON(source.file, null);
    const lineup = (wave?.lineups || []).find((l) => l.slug === slug);
    if (lineup) return { source, wave, lineup };
  }
  return fail(`this board has no wave "${slug}"; lineup create makes one`);
}

// A wave file's triage questions use topic wave:<slug>, and only a board over ~/.claude/waves shows its wave files as
// wave bands (domain.mjs waveBandsOf).
async function triagedWave(site, slug) {
  if ((await boardConfig(site)).items !== 'waves') fail(`topic wave:${slug} is for a board over ~/.claude/waves; a lineup's triage uses lineup:<slug>`);
  await loadWave(site, slug);
}

// The cards named by <wave>/<id> keys, all in one wave file and none in another open lineup. → their ids
function lineupCards(source, wave, keys, slug) {
  return keys.map((key) => {
    const { wave: from, id } = parseKey(key);
    if (from !== source.slug) fail(`${key} is not in wave file "${source.slug}"; a wave's cards share one file`);
    if (!wave.items.some((it) => it.id === id)) fail(`wave "${from}" has no item "${id}"`);
    const other = (wave.lineups || []).find((l) => l.slug !== slug && !l.finished_at && lineupPhases(l).flat().includes(id));
    if (other) fail(`${key} is already in the wave "${other.slug}"; lineup remove ${other.slug} ${key} first`);
    return id;
  });
}

// Each --phase value, "<wave>/<id>,…", as its keys. → [[key, …], …]
function phaseKeys(values) {
  const phases = [values ?? []].flat().map((v) => String(v).split(',').map((k) => k.trim()).filter(Boolean));
  if (!phases.length || phases.some((p) => !p.length)) fail('--phase takes one phase\'s cards, as <wave>/<id>,<wave>/<id>, once per phase in build order');
  return phases;
}

// Each card in members drops its blocked-by links to the others, then each card is blocked by every card of the phase
// before its own.
function chain(source, wave, members, phases) {
  const inLineup = new Set(members.map((id) => `${source.slug}/${id}`));
  for (const id of members) {
    const it = wave.items.find((x) => x.id === id);
    const deps = (it.deps || []).filter((d) => !inLineup.has(depKey(source.slug, d)));
    const at = phases.findIndex((p) => p.includes(id));
    if (at > 0) deps.push(...phases[at - 1]);
    if (deps.length) it.deps = deps; else delete it.deps;
  }
}

async function writeLineup(site, source, wave, lineup, note) {
  if (note !== undefined) await replace(path.join(source.dir, lineupNoteFile(lineup.slug)), `${text(note, 'the note').replace(/\n*$/, '\n')}`);
  await writeJSON(source.file, wave);
  const { tickets } = settingsOf(await boardConfig(site));
  return { file: source.file, lines: [`order: ${orderLine(wave, lineup.phases, tickets)}`] };
}

// A wave's phases by card label: one phase's cards by commas, the phases by arrows.
const orderLine = (wave, phases, tickets) => phases.map((p) => p.map((id) => refOf(wave, wave.items.find((it) => it.id === id) || { id }, tickets)).join(', ')).join(' → ');

export async function createLineup(site, slug, { title, goal, phases, note }) {
  lineupSlug(slug);
  const keys = phaseKeys(phases);
  if (note === undefined) fail('lineup create needs the wave note, as --note <text> or --file <path>');
  const sources = await itemSources(site);
  if (sources.some((s) => s.slug === slug)) fail(`"${slug}" is a wave file on this board; pick another slug`);
  for (const s of sources) if (((await readJSON(s.file, null))?.lineups || []).some((l) => l.slug === slug)) fail(`this board already has a wave "${slug}"`);
  const source = sources.find((s) => s.slug === parseKey(keys[0][0]).wave) || fail(`this board has no wave "${parseKey(keys[0][0]).wave}"`);
  const { wave } = await loadWave(site, source.slug);
  const ids = keys.map((p) => lineupCards(source, wave, p, slug));
  if (new Set(ids.flat()).size !== ids.flat().length) fail('--phase names a card twice');
  const lineup = { slug, title: text(title, '--title'), goal: text(goal, '--goal'), phases: ids, created: new Date().toISOString() };
  chain(source, wave, ids.flat(), ids);
  wave.lineups = [...(wave.lineups || []), lineup];
  return writeLineup(site, source, wave, lineup, note);
}

// Adds a card as a phase of its own after --after's phase (default last), removes one (an emptied phase goes) or puts
// every card in new phases (a band's ⋯ move, domain.mjs lineupMoved), then links the phases again; also renames, sets
// the goal or rewrites the note.
export async function changeLineup(site, slug, { add, after, remove, phases, title, goal, note }) {
  if ([add, remove, phases, title, goal, note].every((v) => v === undefined)) fail('nothing to change: pass --add, --remove, --phase, --title, --goal, --note or --file');
  if (after !== undefined && add === undefined) fail('--after goes with --add');
  const { source, wave, lineup } = await findLineup(site, slug);
  if (lineup.finished_at) fail(`the wave "${slug}" is finished`);
  lineup.phases = lineupPhases(lineup);
  delete lineup.items;
  const before = lineup.phases.flat();
  if (add !== undefined) {
    const [id] = lineupCards(source, wave, [add], slug);
    if (before.includes(id)) fail(`${add} is already in the wave "${slug}"`);
    const at = after === undefined ? lineup.phases.length : lineup.phases.findIndex((p) => p.includes(lineupCards(source, wave, [after], slug)[0])) + 1;
    if (at === 0) fail(`--after ${after} is not in the wave "${slug}"`);
    lineup.phases.splice(at, 0, [id]);
  }
  if (remove !== undefined) {
    const [id] = lineupCards(source, wave, [remove], slug);
    if (!before.includes(id)) fail(`${remove} is not in the wave "${slug}"`);
    if (before.length === 1) fail(`${remove} is the wave's last card; lineup finish ${slug} ends the wave`);
    lineup.phases = lineup.phases.map((p) => p.filter((x) => x !== id)).filter((p) => p.length);
  }
  if (phases !== undefined) {
    const ids = phaseKeys(phases).map((p) => lineupCards(source, wave, p, slug));
    const flat = ids.flat();
    if (flat.length !== before.length || new Set(flat).size !== flat.length || flat.some((id) => !before.includes(id))) fail("--phase lists each of the wave's cards once");
    lineup.phases = ids;
  }
  if (title !== undefined) lineup.title = text(title, '--title');
  if (goal !== undefined) lineup.goal = text(goal, '--goal');
  chain(source, wave, [...new Set([...before, ...lineup.phases.flat()])], lineup.phases);
  return writeLineup(site, source, wave, lineup, note);
}

// A finished wave's band leaves Todo; its cards keep their links.
export async function finishLineup(site, slug) {
  const { source, wave, lineup } = await findLineup(site, slug);
  lineup.finished_at = new Date().toISOString();
  await writeJSON(source.file, wave);
  return { file: source.file };
}

// → {title, markdown}: the wave's goal and order, then its note file.
export async function readLineupNotes(site, slug, tickets) {
  const { source, wave, lineup } = await findLineup(site, slug);
  const note = await fs.readFile(path.join(source.dir, lineupNoteFile(slug)), 'utf8').catch(() => '');
  return { title: lineup.title, markdown: `**Goal** ${lineup.goal}\n\n**Order** ${orderLine(wave, lineupPhases(lineup), tickets)}\n\n${note}` };
}

// One record per agent on an item: agents/<id>.json for agent main, agents/<id>@<agent>.json for any other
// (server.mjs readAgents reads both). dir, when given, is the directory holding the wave file; the item is not looked up.
async function builderFile(site, key, dir, agent = 'main') {
  const { id } = parseKey(key);
  if (!/^[\w-]{1,40}$/.test(agent)) fail(`--agent takes a name of letters, digits, "_" and "-", not "${agent}"`);
  const name = agent === 'main' ? `${id}.json` : `${id}@${agent}.json`;
  if (dir) return path.join(path.resolve(dir), 'agents', name);
  const { source } = await loadItem(site, key);
  return path.join(source.dir, 'agents', name);
}
const isoTime = (v, name) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fail(`${name} takes an ISO time such as 2026-10-23T16:30:00-07:00`));

// A progress line is a phase and a detail of at most DETAIL_CAP characters; a longer one is refused, never cut
// (docs/adr/2026-11-03-0128-a-builder-status-line-is-a-phase-and-a-short-detail.md).
const PHASES = ['reading', 'building', 'testing', 'checking', 'landing'];
const DETAIL_CAP = 80;
const PHASE_LIST = 'reading, building, testing, checking or landing';
// A planner's line takes no phase: it reads its kind's word, and a --phase passed for one is dropped
// (docs/adr/2026-11-04-0131-every-new-task-is-grilled-or-prototyped-at-once.md).
function progressLine(site, phase, detail, name) {
  if (!site) fail(`${name} needs --site, since the line goes to the item's thread`);
  if (phase !== undefined && !PHASES.includes(phase)) fail(`--phase takes ${PHASE_LIST}, not "${phase}"`);
  const words = text(detail, name);
  if (words.length > DETAIL_CAP) fail(`${name} is ${words.length} characters; the cap is ${DETAIL_CAP}. Say it shorter.`);
  return { phase, detail: words };
}
const forAgent = (line, planner, name) => {
  if (planner) return { detail: line.detail };
  if (line.phase === undefined) fail(`${name} needs --phase ${PHASE_LIST}`);
  return line;
};

// A status line lives only in the item's thread, as {kind: 'status'} (domain.mjs builderOf reads it). A progress line
// keeps its phase and reads "Testing: <detail>", or "Codex testing: <detail>" for an agent other than main, named by
// its kind; a line with no phase (builder done's note) reads "<detail>" or "Codex: <detail>". A line that repeats the
// thread's last status line is skipped.
// A planner's line is marked planner and led by its kind's word, whichever agent it runs as ("Prototyping: …")
// (docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md,
// docs/adr/2026-11-04-0131-every-new-task-is-grilled-or-prototyped-at-once.md).
async function statusToThread(site, key, agent = 'main', builder, { phase, detail }, ts) {
  const planner = plans(builder);
  const who = planner || agent === 'main' ? '' : modelName(builder) || builder.kind || agent;
  const head = planner ? PLANNER_WORD[builder.kind] : [who, phase].filter(Boolean).join(' ');
  const repeat = new RegExp(`^(?:${head}|${phase ?? head})\\s*:?\\s+`, 'i');
  const body = head ? `${head[0].toUpperCase()}${head.slice(1)}: ${detail.replace(repeat, '')}` : detail;
  const file = threadFile(site, key);
  if ((await readLines(file)).filter((m) => m.kind === 'status').pop()?.text === body) return;
  await appendLine(file, { ts, who: 'claude', kind: 'status', run: builder.started, ...(phase ? { phase } : {}), ...(planner ? { planner: true } : {}), text: body });
}

// The model a planner runs without --model (owner, #111's grill).
// A visual agent writes one page and should come back fast (owner, gh298-agent).
const PLANNER_MODEL = { prototype: 'sonnet', grill: 'opus', [VISUAL]: 'sonnet' };

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
export async function startBuilder(site, key, { label, phase, progress, dir, agent = 'main', kind, model, eta, worktree, ownWorktree, dispatch }) {
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
  // A visual agent runs beside any other, the tap's record included.
  if (agent !== 'main' && given !== VISUAL && tapOpen(await readJSON(await builderFile(site, key, dir), null))) fail(`the Implement tap opened ${key}'s main builder record and no agent has taken it up; run builder start ${key} without --agent first`);
  const takeUp = before?.dispatched && !before.done ? before : null;
  const was = build && !dir ? (await loadItem(site, key)).item : undefined;
  // A record with unverified judgment calls is a build not yet checked: a start on it resumes that build, a
  // dispatched one included (docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md).
  const resumed = before && unverifiedCalls(before).length ? before : null;
  const pick = takeUp && asked === 'build' ? { kind: providerOf(takeUp.kind), model: takeUp.model, reason: { tap: "The owner's Build tap picked it.", hub: "The board's pull picked it." }[takeUp.dispatched] ?? "The session's dispatch picked it." } : build ? builderPick({ card: was ?? {} }) : null;
  if (pick && asked !== 'build' && asked !== pick.kind) fail(`--kind ${asked}: ${pick.kind} builds now. ${pick.reason} Pass --kind ${pick.kind}, or --kind build.`);
  const k = pick ? pick.kind : asked;
  // docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md: each kind is held by its own usage.
  const gate = readUsageGate({ dir: site });
  if (heldFor(gate, k)) throw new BoardError(pauseReasonFor(gate, k));
  const line = asLine && forAgent(asLine, plans({ kind: k }), '--progress');
  if (model !== undefined && !['opus', 'sonnet'].includes(model)) fail('--model takes opus or sonnet');
  if (askedModel !== undefined && k === 'codex') fail('--model is for kind claude; codex needs none');
  const forced = k === 'claude' ? readClaudeModel() : 'auto';
  if (askedModel !== undefined && forced !== 'auto' && askedModel !== forced) fail(`--model ${askedModel}: the hub's Claude model is ${forced === 'opus' ? 'Opus' : 'Sonnet'}. Pass --model ${forced}, or no --model.`);
  const claude = k === 'claude' ? askedModel ?? pick?.model ?? (takeUp && providerOf(takeUp.kind) === 'claude' ? takeUp.model : undefined) ?? 'opus'
    : plans({ kind: k }) ? askedModel ?? (takeUp?.kind === k ? takeUp.model : undefined) ?? PLANNER_MODEL[k] : undefined;
  const record = {
    label: label === undefined ? 'Builder' : text(label, '--label'), ...(k ? { kind: k } : {}), ...(claude ? { model: claude } : {}), started: now,
    ...(eta === undefined ? {} : { eta: isoTime(eta, '--eta') }), ...(dispatch ? { dispatched: dispatch } : {}),
    ...(resumed ? { calls: resumed.calls, ...(resumed.verified ? { verified: resumed.verified } : {}) } : {}),
    ...(launchedSession(before) ? { session: before.session } : {}),
  };
  const marking = build && !dir && ![...FINISHED, 'building', 'fixing'].includes(was.status);
  const marked = marking ? await setItem(site, key, { status: 'building' }) : { lines: [] };
  let wt;
  let remade = null;
  // A build started again on the card keeps the worktree its last record left, while that is still there.
  // So does one the card was given on entering In Progress (ensureWorktree), which no record keeps.
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
    if (marking) await restoreStatus(site, key, was);
    throw e;
  }
  await writeJSON(file, wt ? { ...record, worktree: wt } : record);
  // docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md: any other main build, not the
  // rebase run nor the lander of its hand-back, ends the card's rebase run, so its push isn't counted as one.
  if (was?.rebase_run && agent === 'main' && ![REBASE_LABEL, 'Lander'].includes(record.label)) await endRebaseRun(site, key);
  // docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md: the pick a build
  // started on, with what it read; a start taking up a dispatched record reuses the pick its dispatch recorded.
  if (pick?.inputs && site) {
    audit(boardAudit(site), { call: 'builder-pick', key, result: [k, k === 'claude' ? claude : null].filter(Boolean).join(' '), reason: pick.reason,
      inputs: { ...pick.inputs, ...(askedModel ? { askedModel } : {}), ...(dispatch ? { dispatch } : {}) } });
  }
  if (remade && site) await appendThread(site, key, { text: remade });
  if (line) await statusToThread(site, key, agent, record, line, now);
  const resolved = given === VISUAL ? [] : await resolveAnswered(site, key, 'Acted on: builder started');
  if (site && build) await clearNext(site, key);
  return {
    file, kind: k ?? null, model: claude ?? null, reason: pick?.reason ?? null, worktree: wt?.path ?? null,
    lines: [...(asked === 'build' ? [`kind: ${k}. ${pick.reason}`] : []), ...(modelName(record) ? [`model: ${modelName(record)}`] : []), ...(site ? [`ref: ${await cardName(site, key)}`] : []), ...(wt ? [`worktree: ${wt.path}`] : []), ...(remade ? [remade] : []), ...marked.lines, ...resolved],
  };
}

// The owner's Build tap, in the board server: it refuses what a build's builder start refuses, in the owner's words,
// else starts the build as `builder start --kind build --worktree` does, with the record marked dispatched: 'tap', so the
// card is In Progress reading "starting" until its builder's first status line. A refusal is a thread line
// of kind BUILD_REFUSED, which the Todo card shows while it is the card's newest line. worktree makes the worktree, as
// builder start's does (board/worktree.mjs boardWorktree). → {key, ref, kind, reason, worktree}, or null when refused
// (docs/adr/2026-11-03-0219-a-build-tap-starts-the-build-in-the-board-server.md).
// A card an unfinished dep blocks is bumped instead, with no record and no worktree (bumpBlocked). → {key, ref, bumped:
// [blocker names], line} (docs/adr/2026-11-05-0802-todo-has-no-queue.md).
// dispatch 'hub' is a pull the board server starts itself.
export async function startTappedBuild(site, key, worktree, dispatch = 'tap') {
  try {
    const { held, blockers } = await tapRefusals(site, key);
    if (held) await recordOwnerTap(site, 'card-hold', { key, hold: false });
    if (blockers.length) return await bumpBlocked(site, key, blockers);
    try {
      const started = await startBuilder(site, key, { kind: 'build', worktree, dispatch });
      return { key, ref: await cardName(site, key), kind: started.kind, ...(started.model ? { model: started.model } : {}), reason: started.reason, worktree: started.worktree };
    } catch (e) {
      if (held) await restoreHold(site, key, held);
      throw e;
    }
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    await appendLine(threadFile(site, key), { ts: new Date().toISOString(), who: 'claude', kind: BUILD_REFUSED, text: `Couldn't start implementing: ${e.message}` });
    return null;
  }
}

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
// The board server's rebase run on a card whose open PR conflicts ({pr, conflict}, domain.mjs rebasesDue): the card's
// main builder record opens dispatched 'hub' and labelled Rebase, in the worktree its last build kept, else the one
// worktree makes from the PR's branch, and the card records rebase_run {pr, base, conflict, at} until the run's push
// (recordRebase). → {key, kind, model, worktree}, as startTappedBuild's
export async function startRebase(site, key, { pr, conflict, base }, worktree) {
  const { source, wave, item } = await loadItem(site, key);
  item.rebase_run = { pr, base, conflict, at: new Date().toISOString() };
  await writeJSON(source.file, wave);
  try {
    const started = await startBuilder(site, key, { kind: 'build', label: REBASE_LABEL, dispatch: 'hub', ownWorktree: worktree });
    return { key, kind: started.kind, ...(started.model ? { model: started.model } : {}), worktree: started.worktree };
  } catch (e) {
    await endRebaseRun(site, key);
    throw e;
  }
}
const REBASE_LABEL = 'Rebase';
async function endRebaseRun(site, key) {
  const { source, wave, item } = await loadItem(site, key);
  delete item.rebase_run;
  await writeJSON(source.file, wave);
}
// The number of the card's PR in its board's repo, which a finish pushes to instead of opening one, or null.
export async function cardPR(site, key) {
  const { wave, item } = await loadItem(site, key);
  const repo = boardRepoOf(site, wave);
  return cardPRs(item, repo).find((p) => p.repo === repo)?.number ?? null;
}
// A push to the card's open PR: from a rebase run (rebase_run), recorded in rebased [{from, to, base, replayed, at}], the
// commits the run pushed, replayed when the push only replayed the PR's commits onto the base (finish.mjs), which
// mergeCard then counts as trivial after an approval. → whether it was a rebase run's
export async function recordRebase(site, key, { from, to, replayed }) {
  const { source, wave, item } = await loadItem(site, key);
  if (!item.rebase_run) return false;
  item.rebased = [...(item.rebased || []), { from, to, base: item.rebase_run.base, replayed, at: new Date().toISOString() }];
  delete item.rebase_run;
  await writeJSON(source.file, wave);
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
// A held card that hasn't started is no refusal: the tap unholds it (docs/adr/2026-11-03-0234-a-held-todo-card-shows-build-in-place-of-unhold.md),
// and nor is a blocked one: the tap bumps it (docs/adr/2026-11-05-0802-todo-has-no-queue.md).
// → {held: its hold or null, blockers: the names of its unfinished deps and its blocked-until condition (blockerNames)}.
async function tapRefusals(site, key) {
  const gate = readUsageGate({ dir: site });
  if (holdsWork(gate)) fail(pauseReason(gate));
  const { item } = await loadItem(site, key);
  const held = item.held || item.status === 'held' ? { held: item.held, status: item.status, pick_up_at: item.pick_up_at, held_at: item.held_at } : null;
  if (held && ![...UNSTARTED, 'held'].includes(item.status)) fail("it's held. Unhold it, then tap Implement.");
  if (await unpickedPrototype(site, key)) fail('no take is picked on its prototypes, so it prototypes again. Pick a take from the next round, then tap Implement.');
  return { held, blockers: await blockerNames(site, key, item) };
}

// docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md
// A bare Implement, in the board server with no event: the owner's "Implementation requested" line, then the card marked
// ready as it is, then its build started as the Build tap does (startTappedBuild), or bumped while a dep blocks it. by
// names a Full person. One the tap refuses gets back the state it had. → startTappedBuild's result.
export async function implementAsIs(site, key, worktree, by) {
  await appendThread(site, key, { text: COMMANDS.implement, who: 'love', by, command: 'implement' });
  const { item: before } = await loadItem(site, key);
  const was = { state: before.state, unfiled: before.unfiled };
  await writeCardState(site, key, { state: 'ready', unfiled: undefined });
  const started = await startTappedBuild(site, key, worktree);
  if (!started) await writeCardState(site, key, was);
  return started;
}
async function writeCardState(site, key, { state, unfiled }) {
  const { source, wave, item } = await loadItem(site, key);
  if (state === undefined) delete item.state; else item.state = state;
  if (unfiled === undefined) delete item.unfiled; else item.unfiled = unfiled;
  await writeJSON(source.file, wave);
}

// docs/adr/2026-11-05-0802-todo-has-no-queue.md
// An Implement on a card that can't start while blockers (their names) are unfinished: the card is bumped to the top of
// Todo (card-bump), where the pull takes it once nothing blocks it, and its thread says so. → {key, ref, bumped, line}.
async function bumpBlocked(site, key, blockers) {
  const names = blockers.join(', ');
  await appendEvent({ dir: site }, 'card-bump', { key });
  await appendLine(threadFile(site, key), { ts: new Date().toISOString(), who: 'claude', text: `Can’t start yet: waits on ${names}. Bumped to the top of Todo.` });
  return { key, ref: await cardName(site, key), bumped: blockers, line: `bumped: ${key} waits on ${names}, so it stays in Todo, bumped to the top` };
}

// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
// A build the board server started whose agent couldn't launch goes back to Todo: its open main record closes, the card
// loses the building status the start gave it, and the thread says why, as a refusal the Todo card shows.
export async function abandonLaunch(site, key, why) {
  const file = await builderFile(site, key);
  const record = await readJSON(file, null);
  const now = new Date().toISOString();
  if (record && !record.done) await writeJSON(file, { ...record, done: now });
  const { source, wave, item } = await loadItem(site, key);
  if (item.status === 'building') { delete item.status; item.status_at = now; }
  await writeJSON(source.file, wave);
  await appendLine(threadFile(site, key), { ts: now, who: 'claude', kind: BUILD_REFUSED, text: `Couldn't start implementing: ${why}` });
}

// A planner the board server opened whose agent couldn't launch: its record, the agent's, closes and the thread says why.
export async function abandonPlanner(site, key, text, agent = 'main') {
  const file = await builderFile(site, key, undefined, agent);
  const record = await readJSON(file, null);
  if (record && !record.done) await writeJSON(file, { ...record, done: new Date().toISOString() });
  await publishStaged(site, key);
  await appendThread(site, key, { text });
}

// docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md
// The session id of the agent the board server just launched on a card (headless.mjs launchBuilder), on its builder
// record, the main one unless agent names another, as session {id, at}. The agent's own builder start keeps it (launchedSession).
export async function recordSession(site, key, id, pid, agent = 'main') {
  const file = await builderFile(site, key, undefined, agent);
  const record = await readJSON(file, null);
  await writeJSON(file, { ...record, session: { id, pid, at: new Date().toISOString() } });
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
  const { source, wave, item } = await loadItem(site, key);
  if (!item.merge_ready) return;
  item.merge_ready.stopped = new Date().toISOString();
  await writeJSON(source.file, wave);
}
// The bump the card's land queues with: its latest card-bump when no card-unbump came after it and it was made once the
// card's first build had started, as the board reads a bump (domain.mjs workItem), else null.
export async function landFirst(site, key) {
  const { source } = await loadItem(site, key);
  const events = await readLines(path.join(site, 'data', 'events.jsonl'));
  const latest = (kind) => events.filter((e) => e.kind === kind && e.data?.key === key).map((e) => String(e.ts)).sort().pop() || '';
  const bump = latest('card-bump');
  if (!bump || latest('card-unbump') > bump) return null;
  const records = await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)));
  const firstBuild = records.filter((r) => r && builds(r)).map((r) => String(r.started || '')).filter(Boolean).sort()[0] || '';
  return firstBuild && bump < firstBuild ? null : bump;
}
// The orchestrator's bump (on) or unbump of a card, the event the owner's bump icon sends. → the event's time
export async function bumpCard(site, key, on) {
  const { item } = await loadItem(site, key);
  if (FINISHED.includes(item.status)) fail(`${await cardName(site, key)} is ${item.status}; there is nothing to bump`);
  const id = await appendEvent({ dir: site }, on ? 'card-bump' : 'card-unbump', { key });
  return (await readLines(path.join(site, 'data', 'events.jsonl'))).find((e) => e.id === id).ts;
}

// Whether the card's latest status line is the finish step's landing line.
export async function isLanding(site, key) {
  return (await readLines(threadFile(site, key))).filter((m) => m.kind === 'status').pop()?.phase === 'landing';
}
// A record's session belongs to the agent now starting on it when a launch wrote it since the record last started or closed.
const launchedSession = (record) => Boolean(record?.session) && record.session.at > (record.done ?? record.started);

// The board server's start of a planner, kind grill or prototype, on a card: the main record opens, dispatched: 'hub',
// as builder start --kind <kind> does. → {key, kind, model}, or null while an agent already works on the card's main
// record.
export async function startPlanner(site, key, kind) {
  const open = await readJSON(await builderFile(site, key), null);
  if (open && !open.done) return null;
  const started = await startBuilder(site, key, { kind, dispatch: 'hub' });
  return { key, kind, model: started.model };
}

// docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
// The board server's start of the visual agent for request, a visual-request event on the card (domain.mjs
// visualsDue): its own record, agent visual-<request id>, opens dispatched 'hub' beside any other agent on the card.
// → {key, kind, model, agent}, or null while a visual agent runs on the card or the request already has its record.
export async function startVisual(site, key, request) {
  const { source } = await loadItem(site, key);
  const records = await Promise.all((await builderFiles(source.dir, parseKey(key).id)).map((f) => readJSON(f, null)));
  if (records.some((r) => r?.kind === VISUAL && r.started && !r.done)) return null;
  const agent = visualAgent(request);
  if (await readJSON(await builderFile(site, key, undefined, agent), null)) return null;
  const started = await startBuilder(site, key, { kind: VISUAL, agent, dispatch: 'hub' });
  return { key, kind: VISUAL, model: started.model, agent };
}

// `visual add <wave/id> --file <html> --title <t>`: the visual agent's page, copied to the site's
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
  await appendThread(site, key, { text: name, link, kind: VISUAL });
  return { lines: [link] };
}

// docs/adr/2026-11-05-2130-a-restarted-server-launches-the-build-its-pull-left-without-a-builder.md
// The builds the board server started (a pull, a Build tap, a queued start) whose launch it never made: a building card
// whose main build record is open with dispatched still set, since a builder's own `builder start` clears that mark.
// → [{key, kind, model}], launchBuilder's card for each.
export async function cutOffBuilds(site) {
  const out = [];
  for (const source of await itemSources(site)) {
    const wave = await readJSON(source.file, null);
    for (const item of wave?.items || []) {
      if (item.status !== 'building') continue;
      const record = await readJSON(path.join(source.dir, 'agents', `${item.id}.json`), null);
      if (!record?.started || record.done || !record.dispatched || plans(record)) continue;
      out.push({ key: `${source.slug}/${item.id}`, kind: providerOf(record.kind), model: record.model });
    }
  }
  return out;
}

// A tapped build that failed to start puts back the hold the tap cleared.
async function restoreHold(site, key, was) {
  const { source, wave, item } = await loadItem(site, key);
  for (const field of Object.keys(was)) if (was[field] === undefined) delete item[field]; else item[field] = was[field];
  await writeJSON(source.file, wave);
}

async function restoreStatus(site, key, was) {
  const { source, wave, item } = await loadItem(site, key);
  for (const field of ['status', 'status_at']) if (was[field] === undefined) delete item[field]; else item[field] = was[field];
  await writeJSON(source.file, wave);
}

// `audit [<wave/id>]`: the board's audit log (shared/audit.mjs), only that card's calls when given. → {lines}
export async function auditLog(site, key) {
  if (!site) fail('audit reads a board: pass --site <route>');
  if (key !== undefined) parseKey(key);
  return { lines: auditLines(readAudit(boardAudit(site), { key })) };
}

const PICKED = ['codex', 'claude'];
// `builder pick`: the kind builder start takes for a card's build. → {lines: ["codex: <reason>" or "claude <opus|sonnet>: <reason>"]}
export async function pickBuilder(site, key) {
  const { item } = await loadItem(site, key);
  const { kind, model, reason } = builderPick({ card: item });
  return { lines: [`${[kind, model].filter(Boolean).join(' ')}: ${reason}`] };
}

// A card moving to In Progress has its worktree before any builder runs: made by make (as builder start's) unless
// the card already has one on disk, and kept on the wave item until land removes it, since no builder record may exist yet.
export async function ensureWorktree(site, key, make) {
  const { source, wave, item } = await loadItem(site, key);
  if (item.worktree?.path && existsSync(item.worktree.path)) return null;
  const recorded = await recordedWorktree(site, key);
  if (recorded?.path && existsSync(recorded.path)) return null;
  const { remade, ...wt } = await make({ busy: [] });
  item.worktree = wt;
  await writeJSON(source.file, wave);
  return wt;
}

// The worktree the item's newest builder record keeps ({path, branch, repo}), or null when none keeps one.
export async function recordedWorktree(site, key, { dir } = {}) {
  const { id } = parseKey(key);
  const agents = path.dirname(await builderFile(site, key, dir));
  const files = await builderFiles(path.dirname(agents), id);
  const records = (await Promise.all(files.map((f) => readJSON(f, null)))).filter((r) => r?.worktree?.path);
  return records.sort((a, b) => String(b.started).localeCompare(String(a.started)))[0]?.worktree ?? null;
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
  return file;
}

// The finish step's own landing line, so the card's fifth bar lights while it rebases and lands, whoever finishes it.
export async function landingLine(site, key) {
  await loadItem(site, key);
  const file = threadFile(site, key);
  if ((await readLines(file)).filter((m) => m.kind === 'status').pop()?.phase === 'landing') return;
  await appendLine(file, { ts: new Date().toISOString(), who: 'claude', kind: 'status', phase: 'landing', text: 'Landing: rebasing onto main and landing' });
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
  return file;
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
  const thread = await readLines(threadFile(site, key));
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
  return { id, lines: [] };
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

// → {lines}: each ask, then its answer, deferral or "waiting on the orchestrator".
export async function listAsks(site, key) {
  needSite(site);
  const asks = await builderAsks(site, key);
  if (!asks.length) return { lines: ['no asks yet'] };
  return { lines: asks.flatMap((a) => [`${a.id}. ${a.text}`, `  ${!a.answer ? 'waiting on the orchestrator' : `${a.deferred ? 'deferred' : 'answered'}: ${a.answer.text}`}`]) };
}

// A question naming a builder's ask ("ask": "ask<n>") is that deferred ask put to the owner.
async function checkAskQuestion(site, q, name) {
  const key = q.topic.startsWith('item:') && !q.topic.startsWith('item:ask:') ? q.topic.slice(5) : fail(`${name}.ask goes on a card's question, topic item:<wave>/<id>`);
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

// The session's review puts each deferred ask to the owner before it marks the calls verified.
export async function verifyCalls(site, key, { dir, agent = 'main', note }) {
  const file = await builderFile(site, key, dir, agent);
  const record = await readJSON(file, null);
  if (!unverifiedCalls(record).length) fail(`${key} has no unverified judgment calls${agent === 'main' ? '' : ` from agent ${agent}`}; builder calls ${key} lists them`);
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
// answer}], links: its cardLinks}.
export async function briefFacts(site, key) {
  const { source, item } = await loadItem(site, key);
  const said = (q, a) => [(q.options || []).find((o) => o.id === a.choice)?.label, a.note].filter(Boolean).join(': ') || 'answered';
  const answers = (await cardQuestions(site, key)).asked.filter((q) => q.ask && q.answers.length).map((q) => ({ ask: q.ask, question: q.question, answer: said(q, q.answers.at(-1)) }));
  return { key, ref: await cardName(site, key), title: item.title || key, notes: item.plan ? path.join(source.dir, item.plan) : null, worktree: (await recordedWorktree(site, key))?.path ?? null, answers, links: await cardLinks(site, key),
    rebasePR: item.rebase_run?.pr ?? null };
}

// docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md
// The cards on the board that card key links: its Parent, the cards it depends on, and the cards it is Related to
// (set on either card), in that order. → [{relation: parent|depends on|related, ref, title, status, notes: the notes
// file's path or null}]; a link to a card no longer on the board is left out.
async function cardLinks(site, key) {
  const cards = new Map();
  for (const entry of await itemSources(site)) {
    for (const it of (await readJSON(entry.file, null))?.items || []) cards.set(`${entry.slug}/${it.id}`, { entry, it });
  }
  const slug = parseKey(key).wave;
  const { it: item } = cards.get(key);
  const back = [...cards].filter(([, c]) => (c.it.related || []).some((r) => depKey(c.entry.slug, r) === key)).map(([k]) => k);
  const linked = [
    ...(item.parent ? [['parent', depKey(slug, item.parent)]] : []),
    ...(item.deps || []).map((d) => ['depends on', depKey(slug, d)]),
    ...[...new Set([...(item.related || []).map((r) => depKey(slug, r)), ...back])].map((k) => ['related', k]),
  ].filter(([, k]) => cards.has(k));
  return Promise.all(linked.map(async ([relation, k]) => {
    const { entry, it } = cards.get(k);
    return { relation, ref: await cardName(site, k), title: it.title || k, status: it.status || 'not started', notes: it.plan ? path.join(entry.dir, it.plan) : null };
  }));
}

// The cards a headless lander lands: checking, every call on their records verified, none of their questions open,
// nothing blocking them, and their worktree still there. → [{key, verified, kind, model}], verified the newest verification's time, and kind and
// model the newest record's, so the lander runs as the agent that built the card.
export async function landable(site) {
  const out = [];
  for (const source of await itemSources(site)) {
    const wave = await readJSON(source.file, null);
    for (const item of wave?.items || []) {
      if (item.status !== 'checking') continue;
      const records = (await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)))).filter(Boolean);
      const verified = records.map((r) => r.verified?.at).filter(Boolean).sort().at(-1);
      if (!verified || records.some((r) => unverifiedCalls(r).length)) continue;
      const key = `${source.slug}/${item.id}`;
      if ((await cardQuestions(site, key)).asked.some((q) => q.state === 'open') || await blockWords(site, key, item)) continue;
      const newest = records.filter((r) => r.worktree?.path).sort((a, b) => String(b.started).localeCompare(String(a.started)))[0];
      if (newest && existsSync(newest.worktree.path)) out.push({ key, verified, kind: providerOf(newest.kind), model: newest.model });
    }
  }
  return out;
}

// data/landers.json {<key>: {verified, pid}}: the verification each launched lander was for and its process. A card
// whose lander stopped partway (the usage pause ends a headless run) stays at building with no process; this sets it back
// to checking and drops its entry, so landable finds it and the server launches a fresh lander. → the thread line.
export async function relaunchLander(site, key) {
  const { item } = await loadItem(site, key);
  if (item.status !== 'building') fail(`${key} is ${item.status || 'not started'}; only a card at building has a stopped lander to relaunch`);
  await setItem(site, key, { status: 'checking', next: 'A lander relaunches to land the verified build' });
  const file = path.join(site, 'data', 'landers.json');
  const sent = await readJSON(file, {});
  delete sent[key];
  await fs.writeFile(file + '.tmp', JSON.stringify(sent) + '\n');
  await fs.rename(file + '.tmp', file);
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

// `builder done`'s hand-back for a record with unverified calls: the card goes to checking with the Next the calls ask
// for, a question first (docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md).
// → {lines}, or null when the record has none.
export async function handBackCalls(site, key, { dir, agent = 'main', next }) {
  const record = await readJSON(await builderFile(site, key, dir, agent), null);
  const calls = record && !record.done ? unverifiedCalls(record) : [];
  if (!calls.length) return null;
  if (next !== undefined) fail(`builder done sets ${key}'s Next itself while its record has judgment calls; run it without --next`);
  const asks = calls.some((c) => c.text.startsWith('Question:')) ? "Answer the builder's questions" : "Verify the builder's judgment calls";
  const set = await setItem(site, key, { status: 'checking', next: asks });
  return { lines: [`handed back: checking, Next "${asks}"`, ...set.lines] };
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

// What `builder verified` does next: null when the card isn't a handed-back build whose every call is now verified
// (checking, no builder open, its newest worktree still there); else {waits: [question id]} while the card's questions
// are open, or {} when verifying finishes it.
export async function verifiedFinish(site, key) {
  const { source, item } = await loadItem(site, key);
  if (item.status !== 'checking') return null;
  const records = (await Promise.all((await builderFiles(source.dir, item.id)).map((f) => readJSON(f, null)))).filter(Boolean);
  if (records.some((r) => unverifiedCalls(r).length || (r.started && !r.done && r.kind !== 'install'))) return null;
  const tree = await recordedWorktree(site, key);
  if (!tree || !existsSync(tree.path)) return null;
  return { waits: (await cardQuestions(site, key)).asked.filter((q) => q.state === 'open').map((q) => q.id) };
}

// docs/adr/2026-11-02-1952-a-message-or-question-on-a-done-card-reopens-it.md: a done card the owner messaged since it closed reads
// reopened, and only the owner's Done closes it again.
export async function checkNotReopened(site, key) {
  const { item } = await loadItem(site, key);
  if (item.status !== 'done' || item.merged_at) return;
  const doneAt = String(item.status_at || '');
  const events = await readLines(path.join(site, 'data', 'events.jsonl'));
  if (events.some((e) => e.kind === 'item-message' && e.data?.key === key && String(e.ts) > doneAt)) fail(`the owner reopened ${await cardName(site, key)} with a message; it closes on the owner's Done`);
}

const HANDED_BACK = ['checking', 'done', 'merged', 'dropped'];

async function builderFiles(waveDir, id) {
  const dir = path.join(waveDir, 'agents');
  return (await fs.readdir(dir).catch(() => []))
    .filter((n) => n === `${id}.json` || (n.startsWith(`${id}@`) && n.endsWith('.json')))
    .map((n) => path.join(dir, n));
}

async function closeBuilders(waveDir, id, cardFinished) {
  const now = new Date().toISOString();
  for (const file of await builderFiles(waveDir, id)) {
    const record = await readJSON(file, null);
    if (!record || record.done || (record.kind === 'install' && !cardFinished)) continue;
    const { eta, ...rest } = record;
    await writeJSON(file, { ...rest, done: now });
  }
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
  const waveDir = path.dirname(path.dirname(file));
  const records = await Promise.all((await builderFiles(waveDir, id)).map((f) => (f === file ? stopped : readJSON(f, null))));
  const last = !records.some((r) => r?.started && !r.done);
  const source = dir ? { file: path.join(waveDir, 'wave.json') } : (await loadItem(site, key)).source;
  const wave = await readJSON(source.file, null);
  const item = wave?.items?.find((it) => it.id === id);
  if (next !== undefined) {
    setNext(item || fail(`${key} has no item to set --next on`), next, await hasOpenQuestion(site, key));
    if (site) await checkNextDeps(site, key, item, item.next);
  }
  const cleared = last && clearBuildingStatus(item);
  if (requireNext && item && owesNext(item, records)) {
    fail(`builder done closes ${key}'s last open builder, which leaves it In Progress with no Next; pass --next "<what happens next>", or hand it back with item set ${key} --status checking or land`);
  }
  await writeJSON(file, stopped);
  await publishStaged(site, key);
  if (note) await statusToThread(site, key, agent, record, { detail: note }, done);
  if (cleared || next !== undefined) await writeJSON(source.file, wave);
  return file;
}

export async function openBoardBuilders(site) {
  const builders = [];
  for (const source of await itemSources(site)) {
    const wave = await readJSON(source.file, null);
    for (const item of wave?.items || []) {
      for (const file of await builderFiles(source.dir, item.id)) {
        const record = await readJSON(file, null);
        if (!record?.started || record.done) continue;
        const name = path.basename(file, '.json');
        builders.push({ key: `${source.slug}/${item.id}`, agent: name.slice(String(item.id).length + 1) || 'main', label: record.label || 'Builder', started: record.started });
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
