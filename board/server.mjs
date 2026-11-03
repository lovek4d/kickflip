#!/usr/bin/env node
// Shared board server for kickflip sites: node board/server.mjs <site dir>. The hub
// runs it with PORT and PREFIX (/<route>) set, and strips the prefix before forwarding.
// It writes page events, hidden events and uploads; agent sessions write the other files
// below through bin/board.mjs (store.mjs):
//   reply, thread, topic add, question add|resolve, prototype add|rm, item set|relate-ask, ask progress|done, followup add|done,
//   lineup create|add|remove|set|finish,
//   builder start|progress|done (bin/agent.mjs is an alias for builder), main set.
// <site dir>/board.json: {title, items, slug, reviewers, rules, auto_merge, auto_build, auto_pull, github_login}. auto_build asks the hub to
// run each card's .kickflip/build after each push, and hides the cards' Serve / Build; main always builds after a merge.
// auto_merge (false when absent) lets the session merge
// an approved, green, clean PR itself; off, the card shows the owner's Merge (store.mjs settingsOf). rules are the owner's standing instructions to this
// board's session [{id, text, by, at}] (board.mjs rules, hub/rules.mjs). reviewers are the board's own [{name, slack_user, dm,
// github}] (board.mjs reviewers), which the settings page lists and new waves copy. items is "waves" (every ~/.claude/waves/*/wave.json,
// the default) or a wave.json-format file relative to the site dir; slug names a file's items
// (its keys are <slug>/<id>), defaulting to the file's basename. An item's review_link_ts maps
// reviewer names to {ts, channel, reactions?}; review.mjs also reads older sent-link records. from_ask names the ask event that created the item,
// and next is Claude's next step for it. install {url, label?, built_at, sha?} is a device build the card's Install
// button opens (board.mjs item set --install); public/installs/ holds its files, served without a login like all of
// public/, since iOS's installer fetches the manifest and .ipa with no cookies. A builder working on an item has a record in
// agents/<id>.json (or agents/<id>@<agent>.json for each further agent) beside the wave file. A wave's followups [{id, title, from, filed, done}] are
// Linear tickets filed along the way; they are Todo cards of their wave until done. A wave's lineups [{slug, title, goal,
// items, finished_at?}] are the owner's waves over its cards (store.mjs createLineup). domain.mjs
// decides lanes and card state from what this server reads.
//   GET  /, /settings.html, /questions.html, /notes.html
//                                the app shell, public/app.html, whose views these pages are (../hub/shell.mjs shellHtml;
//                                docs/adr/0055-one-app-for-the-whole-hub.md). /index.html redirects to /
//   GET  /prototype-<topic>.html a topic recorded in data/prototypes.json is public/prototype.html with its record
//                                filled in (prototypePage); /prototype.html itself is 404
//   GET  /...                    the site's public/, then this template's public/, then the
//                                starter's, then ../shared for colors.css (directories serve index.html; in .html, each <!--header {…}-->
//                                becomes public/ui-page-header.js's header({…}), then {{title}} board.json's title).
//                                A page's relative .js and .css links gain ?v=<version>; a file asked for by its
//                                current version caches for a year, anything else revalidates by ETag. Every
//                                text response, the API's included, is gzipped when the request accepts it;
//                                API JSON stays no-store
//   GET  /api/board              the board's title (board.json's, as the page shows it), its reviewers' names, the Hold sheet's
//                                holdChoices [{value, label, until}] (../hub/views.mjs durationChoices), and lanes of those items, with
//                                per-item review_link_ts and legacy ~/.claude/slack-bridge/topics/*.json fallbacks,
//                                data/owner.json and GitHub (gh, cached for 45 s).
//                                owner.json: {topics: [{id, title, summary}], items: [{id, topic,
//                                question, context, url, options, urgent, resolved, resolved_at, round, round_of, confirm_of}]};
//                                Waiting on you shows an open `urgent` question alone, first
//                                checks comes from data/checked.json (board.mjs checked),
//                                whether the board hears its events (../hub/boards.mjs listenState) and Claude's latest writes;
//                                an ask's In Progress mark from data/ask-progress.json (board.mjs ask).
//                                links: [{link, ok, detail, state, since?}], whether each hub link reaches this
//                                board, state reading broken only past the link's grace period
//                                (../hub/boards.mjs linksOf), null when the manifest has no board here; setup:
//                                {events, github} while the join handshake's checklist shows, else null
//   GET  /api/links              {links}: the same list alone
//   GET  /api/thread?key=w/id    data/threads/<w>__<id>.jsonl ({ts, who, text, link, via}; who is
//                                claude, love or a reviewer's name; via github or slack) plus the page's own
//                                events for that key, its from_ask ask and the asks folded into it (data/ask-links.json),
//                                each with its own thread, and a line for
//                                each builder record's start and finish, oldest first; hidden events are left out. key ask:<event id> is that ask's thread:
//                                the ask, a link line for each work item made from it (from_ask) or related to it
//                                (data/ask-links.json), then data/threads/ask__<event id>.jsonl and item-message
//                                events whose key is ask:<event id>
//   GET  /api/notes?item=w/id    {key, ref, title, markdown}: the item's notes file, only a .md inside its wave's
//                                folder, or with no file its short notes text (store.mjs readNotes); otherwise 404
//                                {error}. /api/plan is the same, for pages loaded before the rename
//   GET  /api/notes?wave=<slug>  {title, markdown}: a lineup's goal, order and note (store.mjs readLineupNotes)
//   GET  /plan.html?…            redirects to notes.html with the same query, since pushes and threads link it
//   POST /_claude/events         {kind, ...data} → one line in data/events.jsonl; wakes Claude.
//                                ask, item-message and owner-answer may carry files: [upload]
//                                An owner-answer with a note and no take resolves its question (store.mjs
//                                resolveNoteAnswer).
//                                prototype-request {key?, question?, note?} asks for prototypes of a card, or of one question
//                                builder-nudge {key} asks the session to check a builder. The server also appends
//                                builder-stalled {key, silentSince} once per silent spell, tracked in data/builder-stalled.json
//                                item set appends card-unblocked {key} when a waiting card's last dep finishes,
//                                including held cards, so the owning session hears it whoever ran the command.
//                                card-hold {key, hold: true, for} is a Hold sheet chip or its Custom time
//                                (../hub/duration.mjs durationEnd), stored as {key, hold: true, until} or, for
//                                Forever, {key, hold: true}; a choice that ends in the past or past 30 days → 400 {error}.
//                                Within a minute of a held card's until or pick_up_at the server resumes it
//                                (store.mjs pickUp), at most once per time even across a restart.
//                                With auto_pull on, the server appends card-pull {key} for the top pullable Todo card
//                                while the board is idle (domain.mjs pullOf), one pull at a time, tracked in data/pulled.json
//   POST /api/upload             the raw file as the body, its name URI-encoded in x-filename and its
//                                type in content-type → data/uploads/<ms>-<safe name>, returning the
//                                upload {name, url, path, type, size}: url is relative to the site
//                                (uploads/<file>) and path is absolute. Over 20 MB → 413
//   GET  /uploads/<file>         a stored upload with its type; nothing else under data/ is served
//   POST /api/hide               {id, hidden} → data/hidden.json; the page clears an event for
//                                every device, without waking Claude
//   GET  /api/rules              {board, hub}: board.json's rules and the hub's from settings.json (hub/rules.mjs)
//   POST /api/rules              {rules: [{id?, text}], base: [id]} → board.json's rules (store.mjs saveBoardRules), and
//                                when anything changed a `rules {scope: "board", added, edited, removed}` event, which
//                                wakes Claude. → {rules, id}; a bad list → 400 {error}
//   GET  /api/settings           the board's settings, {auto_merge, auto_build, auto_pull} (store.mjs readBoardSettings)
//   POST /api/settings           {auto_merge?: boolean, auto_build?: boolean, auto_pull?: boolean} → board.json, keeping its other keys, and when the value moved a
//                                `settings {<changed setting>: value}` event, which wakes Claude. → {settings, id}; a bad body → 400 {error}
//   POST /api/try                {key}: forwards a card build or main retry to the hub's loopback /_hub/build
//   GET  /api/try/main/log       {lines}: last 40 lines of main's log, from at most its last 64 KiB
// data/try.json is the hub's run state; data/main.json holds main's published install link.
//   GET  /_claude/events         events not hidden, newest first, each with Claude's reply if written
//   GET  /_claude/needs          {items: [{kind, text, url}], working, summary, lanes: {review, progress, todo}, building}:
//                                one item per Needs you line, each pending prompt of this board's session among them
//                                (../hub/prompts.mjs), the count of events Claude is working on, a one-line
//                                summary, the open cards in each lane, and whether a builder works on a card
//                                (domain.mjs needsAnswer); the hub badges the site's row and writes its status line with them
//   GET  /api/stream             server-sent events: `event: change` shortly after a file the board reads changes, under
//                                the wave files' folder or data/. Never gzipped
//   GET  /_claude/health
// Every non-GET/HEAD request passes ../starter/cross-site.mjs before routing (403 plain text).
// Routes that parse JSON require application/json; /api/upload keeps the file's content type.
// Claude's reply to event <id> is data/replies/<id>.html, or .json.
import { topicItems } from './review.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { buildBoard, ITEM_EVENTS, needsAnswer, pullOf, refOf, threadOf } from './domain.mjs';
import { createReadStream, watch as watchFiles } from 'node:fs';
import { BoardError, boardConfig, pickUp, readPrototypes, takeFile, finishHandshake, itemSources, readAskLinks, readAskProgress, readBoardRules, readBoardSettings, readHandshake, readHidden, readLineupNotes, readNotes, readWorking, readUpload, resolveNoteAnswer, saveBoardRules, saveBoardSettings, saveUpload, setHidden, settingsOf, threadFile as siteThreadFile, wavesDir } from './store.mjs';
import { changed as rulesChanged, readHubRules } from '../hub/rules.mjs';
import { boardAt, listenState, linksOf } from '../hub/boards.mjs';
import { pendingFor, shown } from '../hub/prompts.mjs';
import { dropQueued } from '../hub/push.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { FOREVER, durationEnd } from '../hub/duration.mjs';
import { durationChoices } from '../hub/views.mjs';
import { VIEW_PAGES, shellHtml } from '../hub/shell.mjs';
import { crossSite, isJSON } from '../starter/cross-site.mjs';
import { readUsageGate } from '../shared/usage-gate.mjs';

const template = path.dirname(fileURLToPath(import.meta.url));
// The hub's Home Screen icon, versioned by mtime the way hub/hub.mjs iconUrl() does, so iOS refetches a replaced icon.
async function touchIcon() {
  const st = await fs.stat(path.join(template, '..', 'hub', 'icon-180.png')).catch(() => null);
  return `/_hub/icon-180.png?v=${st ? Math.floor(st.mtimeMs).toString(36) : '0'}`;
}
// Read on each page so an edit to the renderer is live on the next request, like the other static files.
async function pageHeaders(html) {
  if (!html.includes('<!--header ')) return html;
  const context = vm.createContext({});
  vm.runInContext(await fs.readFile(path.join(template, 'public', 'ui-page-header.js'), 'utf8'), context);
  return html.replace(/<!--header (\{.*?\})-->/g, (_, options) => context.BoardUI.header(JSON.parse(options)));
}
const here = path.resolve(process.argv[2] || process.cwd());
const roots = [path.join(here, 'public'), path.join(template, 'public'), path.join(template, '..', 'starter', 'public'), path.join(template, '..', 'shared')];
const data = path.join(here, 'data');
const events = path.join(data, 'events.jsonl');
const replies = path.join(data, 'replies');
const port = Number(process.env.PORT || 4600);
const prefix = (process.env.PREFIX || '').replace(/\/+$/, '');
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  // iOS's over-the-air installer fetches these itself and wants the manifest as XML; Android installs an .apk.
  '.plist': 'text/xml; charset=utf-8', '.ipa': 'application/octet-stream', '.apk': 'application/vnd.android.package-archive',
};

// Text goes gzipped to a browser that accepts it (docs/adr/0028-the-board-opens-on-the-last-visit.md).
const gzip = promisify(zlib.gzip);
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg\+xml)/;
async function send(res, code, headers, body) {
  const h = { ...headers };
  let out = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  if (COMPRESSIBLE.test(h['content-type'] || '')) {
    h.vary = 'accept-encoding';
    if (out.length >= 1024 && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '')) {
      try { out = await gzip(out); h['content-encoding'] = 'gzip'; } catch {}
    }
  }
  h['content-length'] = out.length;
  res.writeHead(code, h);
  res.end(res.req?.method === 'HEAD' ? undefined : out);
}
const json = (res, code, body) => send(res, code, { 'content-type': types['.json'], 'cache-control': 'no-store' }, JSON.stringify(body));

// A page names each local script and stylesheet by its version, so a pinned file caches for good and an edit
// reaches the browser through the page, which revalidates on every visit (docs/adr/0028-the-board-opens-on-the-last-visit.md).
const versionOf = (st) => `${Math.floor(st.mtimeMs).toString(36)}-${st.size.toString(36)}`;
const ASSET = /\b(src|href)="([\w.][\w./-]*\.(?:js|css))"/g;
async function versionAssets(html, p) {
  const dir = p.endsWith('/') ? p : path.posix.dirname(p);
  const refs = [...new Set([...html.matchAll(ASSET)].map((m) => m[2]))];
  const versions = new Map(await Promise.all(refs.map(async (ref) => {
    const file = await staticFile(path.posix.join(dir, ref));
    const st = file ? await fs.stat(file).catch(() => null) : null;
    return [ref, st ? versionOf(st) : null];
  })));
  return html.replace(ASSET, (m, attr, ref) => (versions.get(ref) ? `${attr}="${ref}?v=${versions.get(ref)}"` : m));
}
const sameTag = (header, etag) => String(header || '').split(',').map((t) => t.trim().replace(/^W\//, '')).includes(etag.replace(/^W\//, ''));
const readJSON = async (f, fallback) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fallback; } };
const readLines = async (f) => { try { return (await fs.readFile(f, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const threadFile = (key) => siteThreadFile(here, key);
// Hidden events leave every list a page reads (docs/adr/0008-dismissals-hide-on-the-server.md).
const shownEvents = async () => {
  const hidden = await readHidden(here);
  return (await readLines(events)).filter((e) => !hidden.has(e.id));
};

async function readBody(req, limit = 64 * 1024) {
  if (!isJSON(req.headers)) throw Object.assign(new Error('Send the body as application/json.'), { status: 403 });
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > limit) throw Object.assign(new Error('too large'), { status: 413 }); }
  return body ? JSON.parse(body) : {};
}

// Every page event, and the server's own such as a rules save, is one line here, which wakes the watcher. → its id
async function appendEvent(kind, data) {
  const e = { id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ts: new Date().toISOString(), kind, data };
  await fs.mkdir(replies, { recursive: true });
  await fs.appendFile(events, JSON.stringify(e) + '\n');
  return e.id;
}

async function withReply(e) {
  for (const ext of ['html', 'json']) {
    const f = path.join(replies, `${e.id}.${ext}`);
    try {
      const [text, st] = await Promise.all([fs.readFile(f, 'utf8'), fs.stat(f)]);
      return { ...e, reply: { [ext]: ext === 'json' ? JSON.parse(text) : text, at: st.mtime.toISOString() } };
    } catch {}
  }
  return { ...e, reply: null };
}

async function listEvents(kind, limit) {
  const working = await readWorking(here);
  let lines = await shownEvents();
  if (kind) lines = lines.filter((e) => e.kind === kind);
  return Promise.all(lines.reverse().slice(0, limit).map(async (e) => {
    const withR = await withReply(e);
    return withR.reply || !routeRecord(working, e.id) ? withR : { ...withR, working: routeRecord(working, e.id) };
  }));
}

// GitHub PR state, refreshed in the background when the board is read and the
// entry is older than 45 s. A PR's first read waits for gh.
const prCache = new Map();
const PR_FIELDS = 'number,title,url,state,isDraft,reviewDecision,mergeStateStatus,mergeable,statusCheckRollup,mergedAt,headRefName,headRefOid,updatedAt,latestReviews';
function ghPR(repo, n) {
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'view', String(n), '--repo', repo, '--json', PR_FIELDS], { timeout: 20000 }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}
// Codex findings are top-level review comments by its bot; one is answered once any reply cites it.
function ghCodexOpen(repo, n) {
  return new Promise((resolve) => {
    execFile('gh', ['api', `repos/${repo}/pulls/${n}/comments?per_page=100`], { timeout: 20000 }, (err, out) => {
      if (err) return resolve(0);
      try {
        const comments = JSON.parse(out);
        const answered = new Set(comments.map((c) => c.in_reply_to_id).filter(Boolean));
        resolve(comments.filter((c) => !c.in_reply_to_id && /codex/i.test(c.user?.login || '') && !answered.has(c.id)).length);
      } catch { resolve(0); }
    });
  });
}
function checksOf(rollup) {
  const list = rollup || [];
  let fail = 0, pending = 0;
  for (const c of list) {
    const concl = (c.conclusion || c.state || '').toUpperCase();
    const status = (c.status || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(concl)) fail++;
    else if ((status && status !== 'COMPLETED') || concl === 'PENDING' || concl === 'EXPECTED') pending++;
  }
  return { total: list.length, fail, pending, state: fail ? 'fail' : pending ? 'pending' : list.length ? 'pass' : 'none' };
}
async function prState(repo, n) {
  const key = `${repo}#${n}`;
  let entry = prCache.get(key);
  if (!entry) { entry = { at: 0, value: null, loading: null }; prCache.set(key, entry); }
  if (Date.now() - entry.at > 45000 && !entry.loading) {
    entry.loading = Promise.all([ghPR(repo, n), ghCodexOpen(repo, n)]).then(([v, codexOpen]) => {
      if (v) {
        const { statusCheckRollup, latestReviews, ...rest } = v;
        const reviews = Object.fromEntries((latestReviews || []).map((r) => [r.author?.login, r.state]));
        entry.value = { ...rest, checks: checksOf(statusCheckRollup), reviews, codexOpen };
      }
      entry.at = Date.now();
      entry.loading = null;
    });
  }
  if (!entry.value && entry.loading) await entry.loading;
  return entry.value;
}

const config = () => boardConfig(here);

async function latestReply() {
  const names = await fs.readdir(replies).catch(() => []);
  const times = await Promise.all(names.map((n) => fs.stat(path.join(replies, n)).then((st) => st.mtimeMs, () => 0)));
  const last = Math.max(0, ...times);
  return last ? new Date(last).toISOString() : null;
}

// {<item id>: {<agent>: record}} from agents/<id>.json (agent main) and agents/<id>@<agent>.json (store.mjs builderFile).
async function readAgents(dir) {
  let files = [];
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')); } catch {}
  const records = await Promise.all(files.map((f) => readJSON(path.join(dir, f), null)));
  const out = Object.create(null);
  files.forEach((f, i) => {
    if (!records[i]) return;
    const [id, agent = 'main'] = path.basename(f, '.json').split('@');
    (out[id] ||= Object.create(null))[agent] = records[i];
  });
  return out;
}

async function itemSnapshot() {
  const cfg = await config();
  const fromWaves = cfg.items === 'waves';
  const sources = await itemSources(here);
  const waves = (await Promise.all(sources.map(async (s) => {
    const wave = await readJSON(s.file, null);
    if (!wave || !Array.isArray(wave.items)) return null;
    return { slug: s.slug, wave, agents: await readAgents(path.join(s.dir, 'agents')) };
  }))).filter(Boolean);

  const threadLines = Object.create(null);
  await Promise.all(waves.flatMap(({ slug, wave }) => wave.items.map(async (it) => {
    threadLines[`${slug}/${it.id}`] = await readLines(threadFile(`${slug}/${it.id}`));
  })));
  return { github: boardAt(here)?.github, reviewers: cfg.reviewers || [], fromWaves, autoMerge: settingsOf(cfg).auto_merge, autoBuild: settingsOf(cfg).auto_build, tickets: settingsOf(cfg).tickets, waves, threads: threadLines };
}

// Reads every source buildBoard needs: wave files and their builder records,
// PR state from gh, item threads, page events with Claude's replies, owner
// questions and legacy review-link fallbacks.
async function snapshot() {
  const items = await itemSnapshot();
  const { waves, threads: threadLines } = items;
  const prs = Object.create(null);
  await Promise.all(waves.flatMap(({ wave }) => {
    const repo = items.github || wave.repo;
    return repo ? wave.items.filter((it) => it.pr).map(async (it) => { prs[`${repo}#${it.pr}`] = await prState(repo, it.pr); }) : [];
  }));
  const needsReply = new Set(['ask', 'owner-answer', 'grill-more', 'item-message', 'wave-triage']);
  const working = await readWorking(here);
  const pageEvents = await Promise.all((await shownEvents()).map((e) => (needsReply.has(e.kind) || routeRecord(working, e.id) ? withReply(e) : { ...e, reply: null })));
  await Promise.all(pageEvents.filter((e) => e.kind === 'ask').map(async (e) => {
    const lines = await readLines(threadFile(`ask:${e.id}`));
    if (lines.length) threadLines[`ask:${e.id}`] = lines;
  }));

  return {
    ...items, route: prefix.slice(1) || path.basename(here), try: await readJSON(path.join(data, 'try.json'), null), main: await readJSON(path.join(data, 'main.json'), null), prs, events: pageEvents, working, askLinks: await readAskLinks(here), askProgress: await readAskProgress(here),
    checked: await readJSON(path.join(data, 'checked.json'), null), watcher: await readJSON(path.join(data, 'watcher.json'), null), replyAt: await latestReply(),
    owner: await readJSON(path.join(data, 'owner.json'), { items: [] }),
    topicItems: await topicItems(),
  };
}

let checkingStalled = false;
async function checkStalled() {
  if (checkingStalled) return;
  checkingStalled = true;
  try {
    const file = path.join(data, 'builder-stalled.json');
    const previous = await readJSON(file, {});
    const current = Object.create(null);
    let sent;
    for (const { key, lane, builder } of buildBoard(await itemSnapshot()).items) {
      if (lane === 'done' || !builder?.stalled) continue;
      current[key] = builder.silentSince;
      if (routeRecord(previous, key) !== builder.silentSince) {
        // The event log covers a restart between appending an event and saving its marker.
        sent ||= await readLines(events);
        if (!sent.some((e) => e.kind === 'builder-stalled' && e.data?.key === key && e.data?.silentSince === builder.silentSince)) {
          await appendEvent('builder-stalled', { key, silentSince: builder.silentSince });
        }
      }
    }
    if (JSON.stringify(current) !== JSON.stringify(previous)) {
      await fs.mkdir(data, { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify(current) + '\n');
      await fs.rename(file + '.tmp', file);
    }
  } catch (err) {
    console.error('Builder check failed:', err.message);
  } finally {
    checkingStalled = false;
  }
}

// The setup checklist after a join's handshake (hub/boards.mjs handshake), or null: when the board never had one, or
// once the session acked the newest hello and the GitHub link passed, which marks it done for good.
async function setupOf(links) {
  const h = await readHandshake(here);
  if (!h?.hello?.id || h.done_at) return null;
  const steps = { events: h.ack?.id === h.hello.id, github: Boolean(links?.find((l) => l.link === 'github')?.ok) };
  if (steps.events && steps.github) { await finishHandshake(here); return null; }
  return steps;
}

async function board() {
  const { title, reviewers } = await config();
  const self = boardAt(here);
  const listen = self ? listenState(self) : 'deaf';
  const built = buildBoard({ ...(await snapshot()), listen, prompts: self ? pendingFor(self.route).map(shown) : [] });
  const links = self ? linksOf(self, { listen }) : null;
  return { generatedAt: new Date().toISOString(), title, reviewers: (reviewers || []).map((r) => r?.name).filter((n) => typeof n === 'string'), ...built, links, setup: await setupOf(links),
    holdChoices: durationChoices(new Date(), 'until you resume it') };
}

async function itemOf(key) {
  const [slug, id] = key.split('/');
  const source = (await itemSources(here)).find((s) => s.slug === slug);
  const wave = source ? await readJSON(source.file, null) : null;
  const item = (Array.isArray(wave?.items) && wave.items.find((it) => it.id === id)) || null;
  return { item, agents: item ? routeRecord(await readAgents(path.join(source.dir, 'agents')), id) || {} : {} };
}

// The work items an ask became (their from_ask) or was related to (data/ask-links.json), as domain.mjs threadOf's links.
async function askLinksOf(askId) {
  const related = routeRecord(await readAskLinks(here), askId);
  const { tickets } = settingsOf(await config());
  const links = [];
  for (const s of await itemSources(here)) {
    const wave = await readJSON(s.file, null);
    for (const it of Array.isArray(wave?.items) ? wave.items : []) {
      const key = `${s.slug}/${it.id}`;
      if (it.from_ask === askId) links.unshift({ key, ref: refOf(wave, it.id, tickets), became: true });
      else if (key === related) links.push({ key, ref: refOf(wave, it.id, tickets), became: false });
    }
  }
  return links;
}

async function thread(key) {
  const owner = await readJSON(path.join(data, 'owner.json'), { items: [] });
  const asked = new Set((owner.items || []).filter((q) => q.topic === `item:${key}`).map((q) => q.id));
  const { item, agents } = key.startsWith('ask:') ? { item: null, agents: {} } : await itemOf(key);
  const own = key.startsWith('ask:');
  const askId = own ? key.slice(4) : item?.from_ask || null;
  // A work item's thread holds the asks it came from or that were folded into it, with their threads (domain.mjs threadOf).
  const moved = own ? [] : Object.entries(await readAskLinks(here)).filter(([, k]) => k === key).map(([id]) => id);
  const askIds = [askId, ...moved].filter(Boolean);
  const keys = new Set([key, ...askIds.map((id) => `ask:${id}`)]);
  const mine = (await shownEvents()).filter((e) => (keys.has(e.data?.key) && ITEM_EVENTS.includes(e.kind)) || (e.kind === 'owner-answer' && asked.has(e.data?.id))
    || (e.kind === 'ask' && askIds.includes(e.id)) || e.kind === 'ask-edited');
  const lines = (await Promise.all([...keys].map((k) => readLines(threadFile(k))))).flat();
  return threadOf(key, { lines, events: await Promise.all(mine.map(withReply)), owner, working: await readWorking(here), fromAsk: askId,
    links: own ? await askLinksOf(askId) : [], agents, moved });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function staticFile(rel) {
  for (const root of roots) {
    let file = path.resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    const st = await fs.stat(file).catch(() => null);
    if (st?.isDirectory()) file = path.join(file, 'index.html');
    if (await fs.stat(file).then((x) => x.isFile(), () => false)) return file;
  }
  return null;
}

// A recorded prototype's page is the template with its record filled in; a topic not recorded falls through to the
// site's own files, so questions on hand-written pages keep opening them.
const PROTOTYPE_TEMPLATE = path.join(template, 'public', 'prototype.html');
async function recordedPrototype(p) {
  const topic = /^\/prototype-([a-z0-9-]+)\.html$/.exec(p)?.[1];
  return topic ? (await readPrototypes(here)).find((r) => r.topic === topic) || null : null;
}
// Inside <script type="application/json">, so "<" is escaped and the record can't close the element.
const scriptJSON = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
async function prototypePage(proto) {
  const takes = await Promise.all(proto.takes.map(async (t) => {
    const src = `prototypes/${proto.topic}/${t.key}.js`;
    const st = await fs.stat(takeFile(here, proto.topic, t.key)).catch(() => null);
    return { key: t.key, label: t.label, src: st?.isFile() ? `${src}?v=${versionOf(st)}` : null, file: src };
  }));
  const title = `${proto.title} · prototype`;
  const header = { lead: 'back', backHref: proto.card ? `./#item=${encodeURIComponent(proto.card)}` : './', title, controls: false };
  const fill = { prototypeTitle: esc(title), prototypeHeader: `<!--header ${scriptJSON(header).replace(/>/g, '\\u003e')}-->`, prototypeData: scriptJSON({ topic: proto.topic, title: proto.title, takes }) };
  return (await fs.readFile(PROTOTYPE_TEMPLATE, 'utf8')).replace(/\{\{(prototypeTitle|prototypeHeader|prototypeData)\}\}/g, (_, k) => fill[k]);
}

async function upload(req, res) {
  try {
    const name = decodeURIComponent(String(req.headers['x-filename'] || ''));
    return json(res, 200, await saveUpload(here, req, { name, type: req.headers['content-type'], length: Number(req.headers['content-length']) || 0 }));
  } catch (e) {
    if (!(e instanceof BoardError) && !(e instanceof URIError)) throw e;
    // Drain, not close: closing mid-body makes the hub's proxy fail with 502 before it reads this 413.
    req.resume();
    return json(res, e.status || 400, { error: e.message });
  }
}

// Scriptable types run sandboxed, so an uploaded page or SVG can't act as the site.
const SCRIPTABLE = /^(text\/html|image\/svg\+xml|application\/(xhtml\+)?xml|text\/xml)$/;
async function sendUpload(req, res, file) {
  const u = await readUpload(here, file);
  if (!u) { res.writeHead(404).end(); return; }
  res.writeHead(200, {
    'content-type': u.type.startsWith('text/') ? `${u.type}; charset=utf-8` : u.type,
    'content-length': u.size,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(u.name)}`,
    'cache-control': 'private, max-age=86400',
    'x-content-type-options': 'nosniff',
    ...(SCRIPTABLE.test(u.type) ? { 'content-security-policy': 'sandbox' } : {}),
  });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(u.path).pipe(res);
}

// Each page holds one stream and reloads on its signal (docs/adr/0031-the-board-reloads-on-a-change-signal.md). It is
// written straight to the socket, never through send(): a gzipped event stream waits in the compressor.
const streams = new Set();
function stream(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  streams.add(res);
  req.on('close', () => streams.delete(res));
}
const broadcast = (text) => { for (const res of streams) res.write(text); };
// Keeps proxies from idling the stream out, and lets a phone notice a dead one.
setInterval(() => broadcast(': ping\n\n'), 25000).unref();

// A burst of writes, such as a rename after a temp file, sends one signal; a steady stream of them still sends one
// every CHANGE_MAX.
const CHANGE_QUIET = 100;
const CHANGE_MAX = 500;
let changeTimer = null;
let changeFirst = 0;
function changed() {
  const now = Date.now();
  if (!changeTimer) changeFirst = now;
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    broadcast(`event: change\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    checkStalled();
  }, Math.max(0, Math.min(CHANGE_QUIET, changeFirst + CHANGE_MAX - now)));
}
// A folder that doesn't exist yet, or whose watch fails, is retried; the first watch after a retry signals, since a
// write may have landed meanwhile.
function watchTree(dir) {
  let retried = false;
  const start = () => {
    let w;
    try { w = watchFiles(dir, { recursive: true }, (_, name) => { if (!String(name || '').endsWith('.tmp')) changed(); }); }
    catch { retried = true; setTimeout(start, 2000).unref(); return; }
    if (retried) changed();
    w.on('error', () => { w.close(); retried = true; setTimeout(start, 2000).unref(); });
  };
  start();
}
async function watchBoard() {
  const sources = (await config()).items === 'waves' ? [wavesDir()] : (await itemSources(here)).map((s) => s.dir);
  const dirs = [...new Set([data, ...sources].map((d) => path.resolve(d)))];
  for (const dir of dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(o + path.sep)))) watchTree(dir);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD' && crossSite(req.headers)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('Requests must come from the app’s own pages.');
      return;
    }
    const url = new URL(req.url, 'http://site');
    let p = url.pathname;
    if (prefix && (p === prefix || p.startsWith(prefix + '/'))) p = p.slice(prefix.length) || '/';

    if (p === '/_claude/health') return json(res, 200, { ok: true });
    if (p === '/api/board') return json(res, 200, await board());
    if (p === '/api/links') return json(res, 200, { links: (await board()).links });
    if (p === '/api/stream' && req.method === 'GET') return stream(req, res);
    if (p === '/_claude/needs') {
      return json(res, 200, needsAnswer(await board()));
    }
    if (p === '/api/thread') return json(res, 200, await thread(String(url.searchParams.get('key') || '')));
    if (p === '/api/notes' && url.searchParams.has('wave')) {
      try { return json(res, 200, await readLineupNotes(here, String(url.searchParams.get('wave')), settingsOf(await config()).tickets)); }
      catch (e) { if (e instanceof BoardError) return json(res, 404, { error: e.message }); throw e; }
    }
    if (p === '/api/notes' || p === '/api/plan') {
      const key = String(url.searchParams.get('item') || '');
      try {
        const { wave, item, markdown } = await readNotes(here, key);
        return json(res, 200, { key, ref: refOf(wave, item.id, settingsOf(await config()).tickets), title: item.title, markdown });
      } catch (e) { if (e instanceof BoardError) return json(res, 404, { error: e.message }); throw e; }
    }
    if (p === '/_claude/events' && req.method === 'POST') {
      const body = await readBody(req);
      const kind = String(body.kind || 'message').slice(0, 64);
      delete body.kind;
      if (kind === 'card-hold' && body.hold && body.for !== undefined) {
        const end = durationEnd(new Date(), body.for);
        if (!end) return json(res, 400, { error: 'That hold ends in the past or more than 30 days on. Pick another time.' });
        delete body.for;
        if (end !== FOREVER) body.until = end.toISOString();
      }
      const id = await appendEvent(kind, body);
      if (kind === 'owner-answer') {
        try { await dropQueued([`q-${body.id}`], path.basename(here)); } catch {}
        await resolveNoteAnswer(here, body);
      }
      return json(res, 200, { id });
    }
    if (p === '/api/rules' && req.method === 'GET') return json(res, 200, { board: await readBoardRules(here), hub: readHubRules() });
    if (p === '/api/rules' && req.method === 'POST') {
      const body = await readBody(req);
      let saved;
      try { saved = await saveBoardRules(here, body.rules, body.base ?? []); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
      const id = rulesChanged(saved.changes) ? await appendEvent('rules', { scope: 'board', ...saved.changes }) : null;
      return json(res, 200, { rules: saved.rules, id });
    }
    if (p === '/api/settings' && req.method === 'GET') return json(res, 200, { settings: await readBoardSettings(here) });
    if (p === '/api/try/main/log' && req.method === 'GET') {
      let file;
      try {
        file = await fs.open(path.join(here, 'data', 'try', 'main.log'), 'r');
        const { size } = await file.stat();
        const start = Math.max(0, size - 64 * 1024);
        const buffer = Buffer.alloc(size - start);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
        if (start) lines.shift();
        if (lines.at(-1) === '') lines.pop();
        return json(res, 200, { lines: lines.slice(-40) });
      } catch (e) {
        if (e.code === 'ENOENT') return json(res, 200, { lines: [] });
        throw e;
      } finally { await file?.close(); }
    }
    if (p === '/api/try' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'key') || typeof body.key !== 'string') return json(res, 400, { error: 'Send only the card key.' });
      try {
        const response = await fetch(`http://127.0.0.1:${process.env.KICKFLIP_HUB_PORT || 4500}/_hub/build`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ route: prefix.slice(1) || path.basename(here), key: body.key }), signal: AbortSignal.timeout(10_000),
        });
        return json(res, response.status, await response.json());
      } catch (e) { return json(res, 502, { error: `Could not start the build: ${e.message}` }); }
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      let saved;
      try { saved = await saveBoardSettings(here, body); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
      const id = saved.changed.length ? await appendEvent('settings', Object.fromEntries(saved.changed.map((k) => [k, saved.settings[k]]))) : null;
      return json(res, 200, { settings: saved.settings, id });
    }
    if (p === '/api/hide' && req.method === 'POST') {
      const body = await readBody(req);
      try { await setHidden(here, String(body.id || ''), body.hidden !== false); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
      return json(res, 200, { ok: true });
    }
    if (p === '/_claude/events' && req.method === 'GET') {
      return json(res, 200, await listEvents(url.searchParams.get('kind'), Math.min(500, Number(url.searchParams.get('limit') || 100))));
    }
    if (p === '/api/upload' && req.method === 'POST') return await upload(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (p.startsWith('/uploads/')) return await sendUpload(req, res, decodeURIComponent(p.slice(9)));
    if (p === '/plan.html') { res.writeHead(302, { location: `notes.html${url.search}`, 'cache-control': 'no-store' }).end(); return; }
    if (p === '/index.html') { res.writeHead(302, { location: `./${url.search}`, 'cache-control': 'no-store' }).end(); return; }

    const shell = VIEW_PAGES.has(p.slice(1));
    const proto = shell ? null : await recordedPrototype(p);
    const file = shell ? null : proto ? PROTOTYPE_TEMPLATE : p === '/prototype.html' ? null : await staticFile(decodeURIComponent(p));
    if (!shell && !file) { res.writeHead(404).end(); return; }
    const ext = shell ? '.html' : path.extname(file).toLowerCase();
    const st = shell ? null : await fs.stat(file);
    let body = shell ? Buffer.from(shellHtml({ touchIcon: await touchIcon() })) : proto ? Buffer.from(await prototypePage(proto)) : await fs.readFile(file);
    if (!shell && ext === '.html') body = (await pageHeaders(body.toString('utf8'))).replaceAll('{{title}}', esc((await config()).title)).replaceAll('{{touchIcon}}', await touchIcon());
    if (!shell && ext === '.html') body = Buffer.from(await versionAssets(body, p));
    const etag = ext === '.html' ? `W/"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20)}"` : `W/"${versionOf(st)}"`;
    const pinned = ext !== '.html' && url.searchParams.get('v') === versionOf(st);
    const headers = { 'content-type': routeRecord(types, ext) || 'application/octet-stream', 'cache-control': pinned ? 'public, max-age=31536000, immutable' : 'no-cache', etag };
    if (sameTag(req.headers['if-none-match'], etag)) { res.writeHead(304, { etag, 'cache-control': headers['cache-control'], vary: 'accept-encoding' }).end(); return; }
    return await send(res, 200, headers, body);
  } catch (err) {
    if (!res.headersSent) {
      if (err.status === 403) res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(err.message);
      else res.writeHead(err.status || (err.code === 'ENOENT' ? 404 : 400)).end();
    }
  }
});

// docs/adr/0118-a-card-can-be-held-until-a-time.md
let checkingPickUps = false;
async function checkPickUps() {
  if (checkingPickUps) return;
  checkingPickUps = true;
  try {
    const now = Date.now();
    const due = buildBoard({ ...(await itemSnapshot()), events: await shownEvents(), now }).items
      .filter((it) => it.heldUntil && it.lane !== 'done' && Date.parse(it.heldUntil) <= now);
    // The resumed wave file stops a second pick-up; the event log covers a restart between the event and that write.
    const sent = due.length ? await readLines(events) : [];
    for (const { key, heldUntil: until } of due) {
      await pickUp(here, key, until, { announce: !sent.some((e) => e.kind === 'card-unblocked' && e.data?.key === key && e.data?.until === until) });
    }
  } catch (err) {
    console.error('Pick-up check failed:', err.message);
  } finally {
    checkingPickUps = false;
  }
}

// docs/adr/0123-an-idle-board-pulls-in-its-top-todo-card.md
// data/pulled.json {key, at}: key is the pulled card while it stays pullable, at when the marker last changed.
let checkingPulls = false;
async function checkPulls() {
  if (checkingPulls) return;
  checkingPulls = true;
  try {
    const file = path.join(data, 'pulled.json');
    const marker = await readJSON(file, {});
    const save = async (key) => {
      await fs.mkdir(data, { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify({ key, at: new Date().toISOString() }) + '\n');
      await fs.rename(file + '.tmp', file);
    };
    if (!settingsOf(await config()).auto_pull) { if (marker.key) await save(null); return; }
    const log = await readLines(events);
    const hidden = await readHidden(here);
    const { items } = buildBoard({ ...(await itemSnapshot()), events: log.filter((e) => !hidden.has(e.id)), owner: await readJSON(path.join(data, 'owner.json'), { items: [] }) });
    const { idle, pullable } = pullOf(items);
    // The event log covers a restart between appending card-pull and saving the marker.
    const lastPull = log.filter((e) => e.kind === 'card-pull').at(-1);
    const current = lastPull && String(lastPull.ts) > String(marker.at || '') ? lastPull.data?.key : marker.key;
    if (current && pullable.includes(current)) return;
    if (!idle || !pullable.length || readUsageGate().state === 'paused') { if (current) await save(null); return; }
    const key = pullable[0];
    await appendEvent('card-pull', { key });
    await fs.mkdir(path.dirname(threadFile(key)), { recursive: true });
    await fs.appendFile(threadFile(key), JSON.stringify({ ts: new Date().toISOString(), who: 'claude', text: 'Pulled in: the board was idle.' }) + '\n');
    await save(key);
  } catch (err) {
    console.error('Pull check failed:', err.message);
  } finally {
    checkingPulls = false;
  }
}

await watchBoard();
setInterval(checkStalled, 60000).unref();
setInterval(checkPickUps, 60000).unref();
setInterval(checkPulls, 60000).unref();
await checkStalled();
await checkPickUps();
await checkPulls();
server.listen(port, '127.0.0.1', () => console.log(`site on http://127.0.0.1:${port}/ (prefix ${prefix || 'none'})`));
