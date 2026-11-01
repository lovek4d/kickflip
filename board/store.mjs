// The board's data files and the only code that writes them, uploads included. A site is a directory under
// ~/.claude/kickflip/sites; `site` null means a board over ~/.claude/waves alone. Every write
// is validated first, JSON files are replaced by rename, and JSONL files are appended to.
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ITEM_STATUSES, ownerQuestion, refOf } from './domain.mjs';
import { installScriptError } from './install-script.mjs';
import { appendEvent, listBoards, samePath } from '../hub/boards.mjs';
import { reviseQueued, flushQueue, queueStatus } from '../hub/push.mjs';
import { holdLine } from '../hub/schedule.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { ticketSource, ticketIn, resolveTicket, ticketTarget, moveTicket, titleTickets, mcpCreateLine } from './tickets.mjs';
import { withFileLock } from '../hub/locks.mjs';
import { storedPath } from '../bin/install.mjs';
import { RuleError, rulesOf, addRule, editRule, removeRule, applyRules, readHubRules, writeHubRules } from '../hub/rules.mjs';

export class BoardError extends Error {}
const fail = (msg) => { throw new BoardError(msg); };

export const sitesDir = () => path.join(os.homedir(), '.claude', 'kickflip', 'sites');
export const wavesDir = () => path.join(os.homedir(), '.claude', 'waves');

export const readJSON = async (f, fallback) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fallback; } };
const readLines = async (f) => { try { return (await fs.readFile(f, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

async function replace(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}
const writeJSON = (file, value) => replace(file, JSON.stringify(value, null, 2) + '\n');
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
const needSite = (site) => site || fail('this command needs --site <route>');
const text = (v, name) => (typeof v === 'string' && v.trim() ? v.trim() : fail(`${name} must be non-empty text`));
const optional = (v, check) => (v === undefined ? undefined : check(v));
const PROTOTYPE_PAGE = /^prototype-[\w-]+\.html(?:[?#]\S*)?$/;
const pageUrl = (v, name) => (typeof v === 'string' && (PROTOTYPE_PAGE.test(v) || /^https?:\/\/\S+$/.test(v)) ? v : fail(`${name} must be an http(s) URL or a site page such as prototype-<topic>.html?q=<id>`));
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

async function loadItem(site, key) {
  const { wave: slug, id } = parseKey(key);
  const loaded = await loadWave(site, slug);
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
  return { file, lines: key ? await freshenPush(site, key, htmlText(html)) : [] };
}

// An event the session has started, such as an ask or a thread message, reads "Working on it" until
// Claude replies to it (or, in a thread, writes a later line); domain.mjs decides which.
const workingFile = (site) => path.join(site, 'data', 'working.json');
export async function readWorking(site) {
  return (await readJSON(workingFile(site), {})).events || {};
}

export async function setWorking(site, eventId) {
  needSite(site);
  domId(eventId, 'the event id');
  const known = (await readLines(path.join(site, 'data', 'events.jsonl'))).some((e) => e.id === eventId);
  if (!known) fail(`no event "${eventId}" in this site's data/events.jsonl`);
  const events = await readWorking(site);
  await writeJSON(workingFile(site), { events: { ...events, [eventId]: new Date().toISOString() } });
  return workingFile(site);
}

// Replies ride along on the next push (docs/adr/0011-replies-ride-along-on-the-next-push.md).
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

const REPLIES = /(?:^| · )(and \d+ repl(?:y|ies))$/;
export const withReplies = (body, n) => [body, n && `and ${n} ${n === 1 ? 'reply' : 'replies'}`].filter(Boolean).join(' · ');

// The push tag tied to a thread: ask-<event id> for ask:<event id>, item-<wave>/<id> for a work item.
export const pushTag = (key) => (key.startsWith('ask:') ? `ask-${key.slice(4)}` : `item-${key}`);

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

// Where a push lands (docs/adr/0036-a-push-lands-where-the-owner-answers.md). A card or ask link (#item=) gains
// &reply, so the board opens that thread with its reply box focused. A page other than the board gains from=push, so
// the back arrow of a page outside the page tree goes to the card or the board
// (docs/adr/0058-back-follows-the-page-tree.md), and a prototype page tied to a question (?q=) sends the owner to the
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
// after the push went shows as the thread's unread mark (docs/adr/0030-pushes-go-by-kind-and-each-arrives-on-its-own.md).
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
// key is <wave>/<id>, or ask:<event id> for an ask's thread.
export async function appendThread(site, key, { text: body, link, who = 'claude', via }) {
  needSite(site);
  if (String(key).startsWith('ask:')) await checkAsk(site, key.slice(4), 'the ask');
  else {
    const { wave: slug, id } = parseKey(key);
    const { wave } = await loadWave(site, slug);
    if (![...wave.items, ...(wave.followups || [])].some((it) => it.id === id)) fail(`wave "${slug}" has no item or follow-up "${id}"`);
  }
  if (!/^[^\n]{1,40}$/.test(who.trim())) fail('--who takes claude, love or a reviewer\'s name');
  if (via !== undefined && !VIA.includes(via)) fail(`--via takes ${VIA.join(' or ')}`);
  const line = { ts: new Date().toISOString(), who: who.trim(), text: text(body, '--text'), link: optional(link, (v) => pageUrl(v, '--link')), via };
  const file = threadFile(site, key);
  await appendLine(file, line);
  return { file, lines: line.who === 'claude' && !via ? await freshenPush(site, key, line.text) : [] };
}

// An ask folded into an existing work item: data/ask-links.json ({links: {<ask event id>: <wave>/<id>}}) names the item,
// whose thread then holds the ask, marked moved, and one summary line; the ask has no card of its own
// (docs/adr/0047-the-plus-makes-a-new-card.md).
const askLinksFile = (site) => path.join(site, 'data', 'ask-links.json');
export async function readAskLinks(site) {
  return (await readJSON(askLinksFile(site), {})).links || {};
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
// (docs/adr/0035-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md). moved {route, title, id} is a done
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
const UNSTARTED = [undefined, 'planned', 'waiting'];
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
  const started = items.find(({ it }) => it.pr || !UNSTARTED.includes(it.status));
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
  const edited = events.filter((e) => e.kind === 'ask-edited' && e.data?.id === eventId && typeof e.data?.text === 'string')
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).pop();
  const files = [];
  for (const f of ask.data?.files || []) files.push(await copyUpload(site, target.dir, f));
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
  for (const key of state?.items || []) await setItem(site, key, { status: 'dropped', force: true });
  return { file: path.join(target.dir, 'data', 'events.jsonl'), lines: [`moved to ${link}`, ...(state?.items || []).map((k) => `dropped: ${k}`)] };
}

// When the session last checked GitHub, and how often it checks (docs/adr/0021-the-board-shows-github-checks-and-watcher-health.md).
const checkedFile = (site) => path.join(site, 'data', 'checked.json');
// idle: no timer checks until the next wave, so the last check is never late.
export async function writeChecked(site, every, { idle = false } = {}) {
  needSite(site);
  if (idle && every !== undefined) fail('pass --every or --idle, not both');
  const minutes = idle ? null : /^[1-9]\d{0,3}$/.test(String(every ?? '30')) ? Number(every ?? '30') : fail('--every takes the minutes between checks, such as 30');
  await writeJSON(checkedFile(site), idle ? { at: new Date().toISOString(), every: null, idle: true } : { at: new Date().toISOString(), every: minutes });
  return { file: checkedFile(site), lines: await flushAfterTick() };
}

// A tick's pushes go out as it ends rather than at the next slot (docs/adr/0030-pushes-go-by-kind-and-each-arrives-on-its-own.md).
async function flushAfterTick() {
  const st = queueStatus(new Date());
  if (st.hold) return st.count ? [`queued pushes held: ${holdLine(st.hold)}`] : [];
  const r = await flushQueue();
  return r ? [`sent ${r.sent} of ${r.count} queued push${r.count === 1 ? '' : 'es'}${r.ok ? '' : '; the rest stay queued'}`] : [];
}

// The join handshake (docs/adr/0040-one-board-registry-for-every-hub-feature.md): data/handshake.json
// {hello: {id, at, session}, ack: {id, at} | null, done_at?}, written by hub/boards.mjs handshake.
// The board shows its setup checklist until the session acks the newest hello and the hub's GitHub check reaches it.
const handshakeFile = (site) => path.join(site, 'data', 'handshake.json');
export const readHandshake = (site) => readJSON(handshakeFile(site), null);

export async function ackHello(site, eventId) {
  needSite(site);
  domId(eventId, 'the event id');
  const event = (await readLines(path.join(site, 'data', 'events.jsonl'))).find((e) => e.id === eventId);
  if (event?.kind !== 'hello') fail(`no hello event "${eventId}" in this site's data/events.jsonl`);
  const h = (await readHandshake(site)) || {};
  if (h.hello?.id && h.hello.id !== eventId) fail(`"${eventId}" is an older hello; ack the newest, "${h.hello.id}"`);
  await writeJSON(handshakeFile(site), { ...h, hello: h.hello || { id: eventId, at: event.ts, session: null }, ack: { id: eventId, at: new Date().toISOString() } });
  return handshakeFile(site);
}

// The board server marks the checklist done once both pass, so a later broken link shows on the Hub links dot, not as setup.
export async function finishHandshake(site) {
  const h = await readHandshake(site);
  if (h && !h.done_at) await writeJSON(handshakeFile(site), { ...h, done_at: new Date().toISOString() });
}

// The board's own reviewers, in board.json `reviewers`, in the wave.json record format slack-bridge reads.
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

async function writeReviewers(site, change) {
  const file = path.join(needSite(site), 'board.json');
  const cfg = await readJSON(file, {});
  await writeJSON(file, { ...cfg, reviewers: checkReviewers(change(cfg.reviewers || []), 'the reviewers') });
  return file;
}

export const setReviewers = (site, list) => writeReviewers(site, () => checkReviewers(list, 'the reviewer file'));

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
// docs/adr/0039-rules-live-on-settings-at-hub-and-board-level.md). The settings page and the CLI both write board.json,
// so board rule and setting writes run one at a time.
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

const storedTickets = (value) => { try { return value ? ticketSource(value) : null; } catch { return null; } };
// A board's settings in board.json (docs/adr/0052-auto-merge-is-a-board-setting-off-by-default.md): auto_merge, off
// when absent, and tickets, its one ticket source, absent when unset or invalid
// (docs/adr/0081-a-board-has-one-ticket-source.md).
export const settingsOf = (cfg) => {
  const tickets = storedTickets(cfg?.tickets);
  return { auto_merge: cfg?.auto_merge === true, ...(tickets ? { tickets } : {}) };
};
export async function readBoardSettings(site) {
  return settingsOf(await readJSON(path.join(needSite(site), 'board.json'), {}));
}
export async function readInstallScript(site) {
  return (await boardConfig(needSite(site))).install_script ?? '';
}

export function saveInstallScript(site, changes) {
  onlyKeys(changes, ['install_script'], 'the install script setting');
  if (changes.install_script !== '') {
    const error = installScriptError(changes.install_script);
    if (error) fail(error);
  }
  const installScript = storedPath(changes.install_script);
  return writeBoardJSON(site, (cfg) => ({
    set: { install_script: installScript }, install_script: installScript,
    changed: (cfg.install_script ?? '') !== installScript,
  }));
}
// changes {auto_merge: boolean, tickets: source} → {file, settings, changed}; changed lists the keys whose value moved.
export function saveBoardSettings(site, changes) {
  onlyKeys(changes, ['auto_merge', 'tickets'], 'the settings');
  if (!Object.keys(changes).length) fail('the settings name nothing to change');
  changes = { ...changes };
  for (const [k, v] of Object.entries(changes)) {
    if (k === 'tickets') { try { changes.tickets = ticketSource(v); } catch (e) { fail(e.message); } }
    else bool(v, k);
  }
  return writeBoardJSON(site, (cfg) => {
    const before = settingsOf(cfg);
    const settings = { ...before, ...changes };
    return { set: changes, settings, changed: Object.keys(changes).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(settings[k])) };
  });
}
// The CLI's `settings set <name> on|off`; names are the board.json keys with "-" for "_".
export async function setBoardSetting(site, name, value) {
  const key = String(name).replace(/-/g, '_');
  if (key !== 'auto_merge') fail(`no board setting "${name}"; settings are ${Object.keys(settingsOf({})).map((k) => k.replace(/_/g, '-')).join(', ')}`);
  if (!['on', 'off'].includes(value)) fail(`settings set ${name} takes on or off, not "${value}"`);
  const { file, settings } = await saveBoardSettings(site, { [key]: value === 'on' });
  return { file, lines: [`${name} ${settings[key] ? 'on' : 'off'}`] };
}
export const settingsLines = (settings) => Object.entries(settings).map(([k, v]) => `setting ${k.replace(/_/g, '-')} ${k === 'tickets' ? JSON.stringify(v) : v ? 'on' : 'off'}`);

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

// docs/adr/0048-a-questions-takes-show-inline.md: rows of at most 4 boxes {text, tone?, to?}, `to` naming boxes of the
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

// A prototype is a topic recorded here, served as prototype-<topic>.html from one template (board/public/prototype.html,
// board/server.mjs), whose takes are the site's public/prototypes/<topic>/<KEY>.js (docs/adr/0089-the-board-serves-every-prototype-from-one-template.md).
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
const pageTopic = (url) => /^prototype-(.+)\.html$/.exec(path.posix.basename(String(url || '').split(/[?#]/)[0]))?.[1];

export async function addPrototype(site, { topic, title, card, takes = [] }) {
  needSite(site);
  prototypeTopic(topic);
  text(title, '--title');
  if (!takes.length) fail('prototype add needs a --take KEY:"Label" for each take');
  const parsed = takes.map(prototypeTake);
  const twice = parsed.find((t, i) => parsed.findIndex((u) => u.key === t.key) !== i);
  if (twice) fail(`--take ${twice.key} is given twice`);
  if (card !== undefined) await loadItem(site, card);
  const list = await readPrototypes(site);
  if (list.some((p) => p.topic === topic)) fail(`prototype ${topic} is already recorded; run prototype rm ${topic} first, or pick another topic`);
  if (await fs.stat(path.join(site, 'public', `prototype-${topic}.html`)).then(() => true, () => false)) {
    fail(`public/prototype-${topic}.html is a hand-written page that questions may link; pick another topic`);
  }
  const record = { topic, title: title.trim(), ...(card === undefined ? {} : { card }), takes: parsed, at: new Date().toISOString() };
  await writeJSON(prototypesFile(site), { prototypes: [...list, record] });
  return { file: prototypesFile(site), lines: [`page prototype-${topic}.html`, ...parsed.map((t) => `take ${t.key} ${takeFile(site, topic, t.key)}`)] };
}

export async function listPrototypes(site) {
  needSite(site);
  const list = await readPrototypes(site);
  return { lines: list.length ? list.map((p) => `${p.topic} · ${p.title} · ${p.takes.map((t) => `${t.key}: ${t.label}`).join(', ')}${p.card ? ` · ${p.card}` : ''}`) : ['no prototypes recorded'] };
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
  if (ids.join() !== keys.join()) fail(`${name}.options ids ${ids.join(', ')} must be ${file}'s takes in order: ${keys.join(', ')}`);
  for (const key of keys) {
    if (!(await fs.stat(takeFile(site, topic, key)).then((s) => s.isFile(), () => false))) fail(`${field} take ${key} has no file yet; write ${takeFile(site, topic, key)}`);
  }
}

// A question file holds one question or an array of them; all are checked before any is added.
export async function addQuestions(site, input) {
  needSite(site);
  const questions = Array.isArray(input) ? input : [input];
  if (!questions.length) fail('the question file is empty');
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const items = owner.items || [];
  const taken = new Set(items.map((q) => q.id));
  const topics = new Set((owner.topics || []).map((t) => t.id));
  for (const [i, q] of questions.entries()) {
    const name = `question ${q?.id ?? i + 1}`;
    onlyKeys(q, ['id', 'topic', 'source', 'question', 'context', 'url', 'urgent', 'options'], name);
    if (taken.has(domId(q.id, `${name}.id`))) fail(`question id "${q.id}" is already used`);
    taken.add(q.id);
    text(q.topic, `${name}.topic`);
    if (q.topic.startsWith('item:ask:')) await checkAsk(site, q.topic.slice(9), `${name}.topic`);
    else if (q.topic.startsWith('item:')) await loadItem(site, q.topic.slice(5));
    else if (!topics.has(q.topic)) fail(`topic "${q.topic}" is not declared; add it with: topic add ${q.topic} --title <t>`);
    text(q.question, `${name}.question`);
    for (const k of ['source', 'context']) optional(q[k], (v) => text(v, `${name}.${k}`));
    optional(q.url, (v) => pageUrl(v, `${name}.url`));
    optional(q.urgent, (v) => bool(v, `${name}.urgent`));
    checkOptions(q.options, name);
    await checkPrototype(site, q, name);
  }
  // A question re-asked on the same card and prototype replaces the open one, so the owner never answers both.
  const at = new Date().toISOString();
  const replaced = [];
  for (const q of questions) {
    const topic = pageTopic(q.url);
    if (!topic) continue;
    for (const old of items) {
      if (old.resolved || old.topic !== q.topic || pageTopic(old.url) !== topic) continue;
      Object.assign(old, { resolved: `Replaced by ${q.id}`, resolved_at: at });
      replaced.push(old.id);
    }
  }
  await writeJSON(ownerFile(site), { ...owner, topics: owner.topics || [], items: [...items, ...questions] });
  return { file: ownerFile(site), lines: replaced.map((id) => `replaced: ${id}`) };
}

async function markResolved(site, owner, ids, note) {
  const at = new Date().toISOString();
  for (const q of owner.items || []) if (ids.includes(q.id)) Object.assign(q, { resolved: note, resolved_at: at });
  await writeJSON(ownerFile(site), owner);
  return ownerFile(site);
}

export async function resolveQuestion(site, id, note) {
  needSite(site);
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  if (!(owner.items || []).some((x) => x.id === id)) fail(`no question "${id}" in owner.json`);
  return markResolved(site, owner, [id], text(note, '--note'));
}

// Closing a card resolves its questions (topic item:<key>) that have an answer, and refuses while one has none, naming
// `by`, unless force. → resolve(): writes the resolutions and returns `resolved: <id>` lines. Changes nothing itself.
async function closeQuestions(site, key, by, force) {
  if (!site) return async () => [];
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const answers = (await readLines(path.join(site, 'data', 'events.jsonl'))).filter((e) => e.kind === 'owner-answer');
  const asked = (owner.items || []).filter((q) => q.topic === `item:${key}`).map((q) => ownerQuestion(q, answers));
  const open = asked.filter((q) => q.state === 'open').map((q) => q.id);
  if (open.length && !force) fail(`${by}: ${key} has ${open.length === 1 ? 'an open question' : 'open questions'} ${open.join(', ')} with no answer yet; pass --force to close the card and resolve ${open.length === 1 ? 'it' : 'them'} too`);
  const ids = asked.filter((q) => q.state !== 'resolved').map((q) => q.id);
  return async () => {
    if (ids.length) await markResolved(site, owner, ids, 'Closed with the card');
    return ids.map((id) => `resolved: ${id}`);
  };
}

// docs/adr/0091-a-prototype-answer-with-a-note-gets-a-confirm-round.md
// → {id, note} of the newest owner answer to the card's questions that link a prototype page, when it has a note; else null.
async function unconfirmedPrototype(site, key) {
  const owner = await readJSON(ownerFile(site), { items: [] });
  const ids = new Set((owner.items || []).filter((q) => q.topic === `item:${key}` && pageTopic(q.url)).map((q) => q.id));
  const last = (await readLines(path.join(site, 'data', 'events.jsonl'))).filter((e) => e.kind === 'owner-answer' && ids.has(e.data?.id)).at(-1);
  const note = String(last?.data?.note || '').replace(/\s+/g, ' ').trim();
  return note ? { id: last.data.id, note } : null;
}

// → the thread line --confirmed writes once the card builds, or null; refuses a start the gate holds.
async function confirmGate(site, key, confirmed) {
  const open = site ? await unconfirmedPrototype(site, key) : null;
  if (confirmed === undefined) {
    if (open) fail(`${key} waits on a confirm round: the owner's answer to ${open.id} has a note ("${clip(open.note)}"); post the final version with prototype add and question add, or pass --confirmed "<the owner's words>" when that note says go`);
    return null;
  }
  const words = text(confirmed, '--confirmed').replace(/\s+/g, ' ');
  if (!open) fail(`${key} has no prototype answer with a note to confirm; drop --confirmed`);
  if (!open.note.toLowerCase().includes(words.toLowerCase())) fail(`--confirmed must quote the owner's note on ${open.id}: "${clip(open.note)}"`);
  return `Building on the owner's go in their answer to ${open.id}: "${words}"`;
}
const clip = (s) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

async function checkAsk(site, eventId, name = '--from-ask') {
  domId(eventId, name);
  const known = (await readLines(path.join(needSite(site), 'data', 'events.jsonl'))).some((e) => e.id === eventId && e.kind === 'ask');
  return known ? eventId : fail(`no ask "${eventId}" in this site's data/events.jsonl`);
}

// docs/adr/0020-cards-wait-on-explicit-blocked-by-links.md
const FINISHED = ['done', 'merged', 'dropped'];
function clearBuildingStatus(item) {
  if (!['building', 'fixing'].includes(item?.status)) return false;
  delete item.status;
  item.status_at = new Date().toISOString();
  return true;
}
const depKey = (slug, dep) => (String(dep).includes('/') ? String(dep) : `${slug}/${dep}`);
async function unfinishedDeps(site, slug, item) {
  const keys = (item.deps || []).map((d) => depKey(slug, d));
  const deps = await Promise.all(keys.map((k) => loadItem(site, k).then(({ item: d }) => d, () => null)));
  return keys.filter((k, i) => deps[i] && !FINISHED.includes(deps[i].status));
}
async function unblockedBy(site, key) {
  const out = [];
  for (const s of await itemSources(site)) {
    const wave = await readJSON(s.file, null);
    for (const it of Array.isArray(wave?.items) ? wave.items : []) {
      if (![undefined, 'planned', 'waiting', 'held'].includes(it.status) || !(it.deps || []).some((d) => depKey(s.slug, d) === key)) continue;
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
      const names = [other.id, refOf(wave, other.id)].flatMap((id) => [id, `${source.slug}/${id}`]);
      if (names.some((name) => mentions.has(name))) fail(`--next names unfinished card ${otherKey}; add it with --deps`);
    }
  }
}

// docs/adr/0024-a-full-plan-opens-as-a-page-on-the-site.md
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

// docs/adr/0051-a-device-app-card-carries-an-install-link.md
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

// → the wave file, and when a dep finishes the items it unblocked as `unblocked: <key>` lines; closing
// (done, merged, dropped) adds a `resolved: <id>` line per question it resolved (closeQuestions).
// notesFile is the --notes-file (alias --plan) file, kept in the item's `plan`.
async function changeItem(site, key, { ticket, status, clearStatus, next, clearNext, pr, fromAsk, held, unheld, notesFile, deps, install, installSha, installLabel, clearInstall, title, force, confirmed }, options) {
  if (status !== undefined && clearStatus) fail('pass --status or --clear-status, not both');
  if (confirmed !== undefined && status !== 'building') fail('--confirmed goes with --status building');
  if (force && !FINISHED.includes(status)) fail(`--force goes with --status ${FINISHED.join(', ')}`);
  if (next !== undefined && clearNext) fail('pass --next or --clear-next, not both');
  if (typeof next === 'string' && !next.trim()) [next, clearNext] = [undefined, true];
  if (held && unheld) fail('pass --held or --unheld, not both');
  const built = installOf({ install, installSha, installLabel, clearInstall });
  if ([status, clearStatus, next, clearNext, pr, fromAsk, held, unheld, notesFile, deps, built, title, ticket].every((v) => v === undefined || v === false)) fail('nothing to set: pass --status, --clear-status, --next, --clear-next, --pr, --from-ask, --held, --unheld, --notes-file, --deps, --install, --clear-install, --title or --ticket');
  const ask = fromAsk === undefined ? undefined : await checkAsk(site, fromAsk);
  if (ask) await refuseMoved(site, ask);
  const { source, wave, item } = await loadItem(site, key);
  const wasFinished = FINISHED.includes(item.status);
  if (notesFile !== undefined) { await planPath(source.dir, notesFile); item.plan = path.normalize(notesFile); }
  if (title !== undefined) item.title = text(title, '--title');
  if (deps !== undefined) {
    const list = await depList(site, parseKey(key).wave, deps);
    if (list.length) item.deps = list; else delete item.deps;
  }
  // docs/adr/0023-a-card-can-be-held-and-every-card-button-confirms.md
  if (held) item.held = true;
  if (unheld) { delete item.held; if (item.status === 'held') delete item.status; }
  if (held || unheld) item.held_at = new Date().toISOString();
  if (status === 'building' && (item.held || item.status === 'held')) fail(`${key} is held; start it only once the owner resumes it, with item set ${key} --unheld`);
  if (status !== undefined) item.status = ITEM_STATUSES.includes(status) ? status : fail(`--status takes ${ITEM_STATUSES.join(', ')}`);
  if (status === 'building') {
    const blockers = await unfinishedDeps(site, parseKey(key).wave, item);
    if (blockers.length) fail(`${key} is blocked by ${blockers.join(', ')}; start it once ${blockers.length === 1 ? 'that is' : 'those are'} done or merged`);
  }
  const confirmLine = status === 'building' ? await confirmGate(site, key, confirmed) : null;
  const resolve = FINISHED.includes(status) ? await closeQuestions(site, key, `--status ${status}`, force) : async () => [];
  if (clearStatus) delete item.status;
  // A card-done newer than status_at reads "Closing…" (domain.mjs workItem).
  if (status !== undefined || clearStatus) item.status_at = new Date().toISOString();
  if (next !== undefined) {
    item.next = text(next, '--next');
    await checkNextDeps(site, key, item, item.next);
  }
  if (clearNext) delete item.next;
  if (pr !== undefined) {
    item.pr = /^[1-9]\d*$/.test(String(pr)) ? Number(pr) : fail('--pr takes a PR number');
    clearBuildingStatus(item);
  }
  if (ask) item.from_ask = ask;
  if (built) item.install = built;
  if (built === null) delete item.install;
  const mcpLine = ticket !== undefined || (ask && !item.ticket && !item.linear?.length) ? await assignTicket(site, key, wave, item, ticket, options, source.dir, setTicketCommand(site, key)) : null;
  await writeJSON(source.file, wave);
  const resolved = await resolve();
  if (confirmLine) resolved.push(...(await appendThread(site, key, { text: confirmLine })).lines);
  if (mcpLine) resolved.push(mcpLine);
  const target = ticketTarget({ status, pr });
  const moved = target && await moveTicket(await boardSource(site), item, target, { ...options, repo: boardRepoOf(site, wave) });
  if (moved) resolved.push(moved);
  // A builder that forgot builder done would keep the card In Progress after it was handed back.
  if (pr !== undefined || HANDED_BACK.includes(status)) await closeBuilders(source.dir, item.id, FINISHED.includes(status));
  // An ask is in one card's thread: becoming this item moves it out of a card it was folded into.
  const links = ask ? await readAskLinks(site) : {};
  if (routeRecord(links, ask) !== undefined) { delete links[ask]; await writeJSON(askLinksFile(site), { links }); }
  if (!FINISHED.includes(status) || wasFinished) return { file: source.file, lines: resolved };
  const unblocked = await unblockedBy(site, key);
  // The owner reads a card's wait in its thread, so the line that ends it goes there too.
  const ts = new Date().toISOString();
  for (const k of unblocked) {
    await appendLine(threadFile(site, k), { ts, who: 'claude', text: `Unblocked: ${item.id} is ${status}.` });
    await appendEvent({ dir: site }, 'card-unblocked', { key: k });
  }
  return { file: source.file, lines: [...unblocked.map((k) => `unblocked: ${k}`), ...resolved] };
}

// A comma list of deps, each an item that exists; "" is none.
async function depList(site, slug, deps) {
  const list = [...new Set(String(deps).split(',').map((d) => d.trim()).filter(Boolean))];
  for (const d of list) await loadItem(site, depKey(slug, d));
  return list;
}

const boardRepoOf = (site, wave) => (site && listBoards().find((b) => samePath(b.dir, site))?.github) || wave.repo;
const boardSource = async (site) => storedTickets((await boardConfig(site)).tickets);

// Sets item.ticket from the board's source, and ticket_created when kickflip made it. self is the card's <wave>/<id>:
// an Internal ticket another card holds is refused. → null, or the line asking the session to make a Linear issue
// through its MCP and link it with link, the board.mjs command that sets this card's ticket.
async function assignTicket(site, self, wave, item, ticket, options, dir, link) {
  try {
    const cfg = await boardConfig(site);
    const source = ticketSource(cfg.tickets || { source: 'internal' });
    const ownId = (w, it) => (w.internal === true ? String(it.id).replace(/^S(\d+)$/, `${source.prefix}-$1`) : null);
    if (ticket === undefined && source.source === 'internal' && ticketIn(source, ownId(wave, item))) ticket = ownId(wave, item);
    let max = 0;
    if (source.source === 'internal') {
      for (const entry of await itemSources(site)) {
        const w = await readJSON(entry.file, {});
        for (const it of [...(w.items || []), ...(w.followups || [])]) {
          const ids = [it.ticket, ownId(w, it)];
          max = Math.max(max, ...ids.map((id) => ticketIn(source, id) || 0));
          if (ticket !== undefined && `${entry.slug}/${it.id}` !== self && ids.includes(ticket)) throw Object.assign(new BoardError(`${ticket} is already the ticket of ${entry.slug}/${it.id}`), { held: true });
        }
      }
    }
    const body = ticket === undefined && source.source !== 'internal' && item.plan ? await fs.readFile(await planPath(dir, item.plan), 'utf8') : item.notes || '';
    const r = await resolveTicket(source, { ticket, title: item.title, body, repo: boardRepoOf(site, wave), next: max + 1 }, options);
    if (r.mcp) { delete item.ticket; delete item.ticket_created; return mcpCreateLine(source, item.title, link); }
    item.ticket = r.ticket;
    if (r.created && source.source !== 'internal') item.ticket_created = true; else delete item.ticket_created;
    return null;
  } catch (e) { if (e instanceof BoardError) throw e; fail(e.message); }
}

const ticketWrite = (site, fn) => withFileLock(path.join(site || wavesDir(), 'tickets'), fn, { heartbeat: true });
export const setItem = (site, key, changes, options) => (changes.ticket !== undefined || changes.fromAsk !== undefined
  ? ticketWrite(site, () => changeItem(site, key, changes, options)) : changeItem(site, key, changes, options));
export const addItem = (site, key, details, options) => ticketWrite(site, () => createItem(site, key, details, options));
export const addFollowup = (site, slug, details, options) => ticketWrite(site, () => createFollowup(site, slug, details, options));

// → the wave file. A new card starts unstarted: planned, or waiting when it names deps.
async function createItem(site, key, { title, notes, deps, notesFile, ticket }, options) {
  const { wave: slug, id } = parseKey(key);
  domId(id, 'the item id');
  const { source, wave } = await loadWave(site, slug);
  if (wave.items.some((it) => it.id === id)) fail(`wave "${slug}" already has an item "${id}"`);
  const item = { id, title: text(title, '--title'), created: new Date().toISOString() };
  if (notes !== undefined) item.notes = text(notes, '--notes');
  if (deps !== undefined) item.deps = await depList(site, slug, deps);
  if (notesFile !== undefined) { await planPath(source.dir, notesFile); item.plan = path.normalize(notesFile); }
  item.status = item.deps?.length ? 'waiting' : 'planned';
  const line = await assignTicket(site, key, wave, item, ticket, options, source.dir, setTicketCommand(site, key));
  wave.items.push(item);
  await writeJSON(source.file, wave);
  return { file: source.file, lines: line ? [line] : [] };
}

async function createFollowup(site, slug, { id, title, from, ticket }, options) {
  const { source, wave } = await loadWave(site, slug);
  domId(id, '--id');
  const followups = wave.followups || [];
  if (followups.some((f) => f.id === id)) fail(`wave "${slug}" already has follow-up ${id}`);
  const item = { id, title: text(title, '--title'), ...(from === undefined ? {} : { from: text(from, '--from') }), filed: new Date().toISOString().slice(0, 10) };
  const line = await assignTicket(site, `${slug}/${id}`, wave, item, ticket, options, source.dir, setTicketCommand(site, `${slug}/${id}`, true));
  followups.push(item);
  await writeJSON(source.file, { ...wave, followups });
  return { file: source.file, lines: line ? [line] : [] };
}

// `followup set <wave> <id> --ticket <id>`: links a follow-up's ticket, as item set --ticket does a card's.
export const setFollowupTicket = (site, slug, id, ticket) => ticketWrite(site, async () => {
  const { source, wave } = await loadWave(site, slug);
  const f = (wave.followups || []).find((x) => x.id === id) || fail(`wave "${slug}" has no follow-up "${id}"`);
  await assignTicket(site, `${slug}/${id}`, wave, f, text(ticket, '--ticket'), undefined, source.dir);
  await writeJSON(source.file, wave);
  return source.file;
});

const setTicketCommand = (site, key, followup = false) => {
  const where = site ? `--site ${path.basename(site)} ` : '';
  return followup ? `board.mjs ${where}followup set ${key.replace('/', ' ')}` : `board.mjs ${where}item set ${key}`;
};

// `tickets backfill`: each open card and follow-up with no ticket links the first id in its title, or in its legacy
// `linear` list, that belongs to the board's source, else gets a new ticket. An Internal id another card holds is only
// a mention, so that card gets a new one. Done cards are left alone. dryRun writes nothing and calls no source. A Linear
// board without Hub's key links ids on their pattern and prints a create line for each of the rest.
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
    for (const it of [...wave.items, ...(wave.followups || [])]) {
      if (it.ticket) held.add(it.ticket);
      if (wave.internal === true && source.source === 'internal') held.add(String(it.id).replace(/^S(\d+)$/, `${source.prefix}-$1`));
    }
  }
  const lines = [];
  const counts = { linked: 0, created: 0, failed: 0, mcp: 0 };
  for (const { entry, wave } of waves) {
    for (const it of [...wave.items, ...(wave.followups || [])]) {
      const followup = !wave.items.includes(it);
      if (it.ticket || (followup ? it.done : FINISHED.includes(it.status))) continue;
      const key = `${entry.slug}/${it.id}`;
      const found = [...titleTickets(source, it.title), ...(it.linear || []).filter((id) => ticketIn(source, id))]
        .find((id) => source.source !== 'internal' || !held.has(id));
      if (dryRun) {
        counts[found ? 'linked' : 'created']++;
        lines.push(`${key} would ${found ? `link ${found}` : 'get a new ticket'}`);
        continue;
      }
      try {
        const mcp = await assignTicket(site, key, wave, it, found, options, entry.dir, setTicketCommand(site, key, wave.items.includes(it) === false));
        if (mcp) { counts.mcp++; lines.push(`${key} ${mcp}`); continue; }
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
    : `linked ${counts.linked}, created ${counts.created}, failed ${counts.failed}${counts.mcp ? `, ${counts.mcp} to create through the Linear MCP` : ''}`;
  return { lines: [...lines, `backfill${dryRun ? ' (dry run)' : ''}: ${total}`] };
}

export async function finishFollowup(site, slug, id, { force } = {}) {
  const { source, wave } = await loadWave(site, slug);
  const f = (wave.followups || []).find((x) => x.id === id) || fail(`wave "${slug}" has no follow-up "${id}"`);
  const resolve = await closeQuestions(site, `${slug}/${id}`, 'followup done', force);
  f.done = true;
  await writeJSON(source.file, wave);
  return { file: source.file, lines: await resolve() };
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

// A progress line lives only in the item's thread, as {kind: 'status'} (domain.mjs builderOf reads it),
// prefixed with the agent's kind unless it is main, and skipped when it repeats the thread's last status line.
const progressLine = (site, v, name) => (site ? text(v, name).slice(0, 160) : fail(`${name} needs --site, since the line goes to the item's thread`));
async function statusToThread(site, key, agent = 'main', kind, line, ts) {
  const who = agent === 'main' ? '' : kind || agent;
  const body = who ? `${who[0].toUpperCase()}${who.slice(1)}: ${line}` : line;
  const file = threadFile(site, key);
  if ((await readLines(file)).filter((m) => m.kind === 'status').pop()?.text === body) return;
  await appendLine(file, { ts, who: 'claude', kind: 'status', text: body });
}

// worktree, when given, makes the builder's worktree once every flag has passed (board/worktree.mjs makeWorktree) and
// returns {path, branch, repo}, which the record keeps for `board.mjs land`.
export async function startBuilder(site, key, { label, progress, dir, agent = 'main', kind, eta, worktree }) {
  const line = optional(progress, (v) => progressLine(site, v, '--progress'));
  const file = await builderFile(site, key, dir, agent);
  const now = new Date().toISOString();
  const k = optional(kind, (v) => (/^[\w.-]{1,30}$/.test(v) ? v : fail('--kind takes a short word such as opus or codex')));
  const record = {
    label: label === undefined ? 'Builder' : text(label, '--label'), ...(k ? { kind: k } : {}), started: now,
    ...(eta === undefined ? {} : { eta: isoTime(eta, '--eta') }),
  };
  const wt = worktree ? await worktree() : null;
  await writeJSON(file, wt ? { ...record, worktree: wt } : record);
  if (line) await statusToThread(site, key, agent, k, line, now);
  return { file, lines: wt ? [`worktree: ${wt.path}`] : [] };
}

// The worktree the item's newest builder record keeps ({path, branch, repo}), or null when none keeps one.
export async function recordedWorktree(site, key, { dir } = {}) {
  const { id } = parseKey(key);
  const agents = path.dirname(await builderFile(site, key, dir));
  const files = await builderFiles(path.dirname(agents), id);
  const records = (await Promise.all(files.map((f) => readJSON(f, null)))).filter((r) => r?.worktree?.path);
  return records.sort((a, b) => String(b.started).localeCompare(String(a.started)))[0]?.worktree ?? null;
}

export async function builderProgress(site, key, progress, { dir, agent = 'main', eta, clearEta }) {
  if (eta !== undefined && clearEta) fail('pass --eta or --clear-eta, not both');
  const line = progressLine(site, progress, 'builder progress');
  const file = await builderFile(site, key, dir, agent);
  const now = new Date().toISOString();
  const { progress: _line, progress_at: _at, done: _done, ...next } = await readJSON(file, { label: 'Builder', started: now });
  if (eta !== undefined) next.eta = isoTime(eta, '--eta');
  if (clearEta) delete next.eta;
  await writeJSON(file, next);
  await statusToThread(site, key, agent, next.kind, line, now);
  return file;
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
// agent's own record never closes one a later agent restarted on the same item.
export async function stopBuilder(site, key, { dir, agent, startedBetween, note }) {
  const file = await builderFile(site, key, dir, agent);
  const record = await readJSON(file, null);
  if (!record || record.done) return file;
  if (startedBetween) {
    const started = Date.parse(record.started);
    if (!(started >= startedBetween[0] && started <= startedBetween[1])) return file;
  }
  const { eta, ...rest } = record;
  const done = new Date().toISOString();
  await writeJSON(file, { ...rest, done, ...(note ? { note } : {}) });
  if (note) await statusToThread(site, key, agent, record.kind, note, done);
  const { id } = parseKey(key);
  const waveDir = path.dirname(path.dirname(file));
  const records = await Promise.all((await builderFiles(waveDir, id)).map((f) => readJSON(f, null)));
  if (records.some((r) => r?.started && !r.done)) return file;
  const source = dir ? { file: path.join(waveDir, 'wave.json') } : (await loadItem(site, key)).source;
  const wave = await readJSON(source.file, null);
  const item = wave?.items?.find((it) => it.id === id);
  if (clearBuildingStatus(item)) await writeJSON(source.file, wave);
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
