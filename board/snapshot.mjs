// docs/adr/2026-11-17-2200-card-state-comes-from-one-snapshot-reader.md
// The one reader of what domain.mjs buildBoard turns into cards: a board's item files with their builder records, its
// data files, the hub's PR check and its manifest entry. The board server, the CLI (store.mjs) and the tests' fixtures
// all read a board through it, so a card's lane, what blocks it and whether it has finished come from one build
// whichever process asks, with the server down too.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boardConfig, itemSources, readJSON, readLog } from './files.mjs';
import { buildBoard } from './domain.mjs';
import { topicItems } from './review.mjs';
import { transcriptMovedAt } from './transcript.mjs';
import { alive as runAlive, landable, queuedPlanners, readLanders } from './runs.mjs';
import { BoardError } from './checks.mjs';
import { readActedOn, readArchivedTags, readAgents, readAskLinks, readDelivered, readHidden, readReplyIndex, readWorking, replyFilesOf, threadFile } from './cards.mjs';
import { itemNotes, readScreening } from './questions.mjs';
import { opensPRs, settingsOf } from './settings.mjs';
import { boardAt, githubStateFile } from '../hub/boards.mjs';
import { limitedUntil } from '../shared/gh.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { cardPRs, prKeyOf } from '../shared/card-prs.mjs';
import { launchHeldWords, readUsageGate } from '../shared/usage-gate.mjs';
import { runLoggedOut } from '../hub/login-error.mjs';

const dataOf = (site) => path.join(site, 'data');
const repliesOf = (site) => path.join(dataOf(site), 'replies');

// What the board reads from outside data/ and the item files' folder, whose writes signal changes: board.json, this
// board's entry in the hub's manifest (its GitHub repo, git remote and branch) and the Slack bridge's topic items.
// hostBusy: whether the host holds new work (docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md), which a card's
// try reads. landHeld {<kind>: words or null, bumped: {<kind>: words or null}}: what holds the server's launches of each
// kind, and of a bumped card's, which a verified card's land step reads (domain.mjs landStep).
export async function outsideData(site) {
  const here = path.resolve(site);
  const self = boardAt(here);
  const gate = readUsageGate({ dir: here });
  return { cfg: await boardConfig(here), github: self?.github, local: self?.local, hub: self?.hub, remote: self?.remote, branch: self?.branch, topicItems: topicItems(),
    hostBusy: gate.machine.state === 'busy', landHeld: { claude: launchHeldWords(gate, 'claude'), codex: launchHeldWords(gate, 'codex'),
      bumped: { claude: launchHeldWords(gate, 'claude', true), codex: launchHeldWords(gate, 'codex', true) } } };
}

// The last 40 lines of a hub run's log, data/try/<name>.log, from at most its last 64 KiB; [] with no log.
export async function tryLogTail(site, name) {
  let file;
  try {
    file = await fs.open(path.join(site, 'data', 'try', `${name}.log`), 'r');
    const { size } = await file.stat();
    const start = Math.max(0, size - 64 * 1024);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    if (start) lines.shift();
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-40);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  } finally { await file?.close(); }
}

// Hidden events leave every list a page reads (docs/adr/2026-10-29-1639-dismissals-hide-on-the-server.md).
export async function shownEvents(site) {
  const hidden = await readHidden(site);
  return (await readLog(path.join(dataOf(site), 'events.jsonl'))).filter((e) => !hidden.has(e.id));
}

// e with its replies oldest first, and reply, the newest ({md|html|json, at}), or null.
// index, when given, is readReplyIndex's of the replies folder: a build lists the folder once for all its events.
export async function withReply(site, e, index) {
  const replies = repliesOf(site);
  const replied = await Promise.all((index ? index.get(e.id) || [] : await replyFilesOf(replies, e.id)).map(async ({ name, ext }) => {
    const f = path.join(replies, name);
    try {
      const [text, st] = await Promise.all([fs.readFile(f, 'utf8'), fs.stat(f)]);
      return [{ [ext]: ext === 'json' ? JSON.parse(text) : text, at: st.mtime.toISOString() }];
    } catch { return []; }
  }));
  const all = replied.flat();
  return { ...e, reply: all.at(-1) || null, replies: all };
}

// docs/adr/2026-11-09-1556-boards-read-pr-state-from-the-hubs-check.md: a PR's state is the hub's last check of it,
// its summary in github-state.json (hub/github.mjs summarize), with the fields the board's badges draw; null before
// the hub has checked it. limited is when GitHub's limit on the check's GraphQL resets while it holds, else null, for the
// badges to dim (docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md).
const prViewOf = (s, limited) => (s ? { title: s.title, url: s.url, state: s.state, isDraft: s.isDraft, reviewDecision: s.reviewDecision, mergeStateStatus: s.mergeStateStatus,
  mergeable: s.mergeable, checks: s.checks, failing: s.failing, mergedAt: s.mergedAt, headRefName: s.headRefName, headRefOid: s.headRefOid, updatedAt: s.updatedAt,
  reviews: s.reviews, limited } : null);

async function latestReply(site) {
  const replies = repliesOf(site);
  const names = await fs.readdir(replies).catch(() => []);
  const times = await Promise.all(names.map((n) => fs.stat(path.join(replies, n)).then((st) => st.mtimeMs, () => 0)));
  const last = Math.max(0, ...times);
  return last ? new Date(last).toISOString() : null;
}

// The item files the board reads, each with its builder records.
export async function liveFiles(site) {
  return (await Promise.all((await itemSources(site)).map(async (s) => {
    const itemFile = await readJSON(s.file, null);
    if (!itemFile || !Array.isArray(itemFile.items)) return null;
    // A Done card's builders are finished, so the board's build reads only the other cards' records, and none of an
    // archived card, which the item file no longer holds.
    const open = new Set(itemFile.items.filter((it) => it.lane !== 'done').map((it) => it.id));
    return { slug: s.slug, dir: s.dir, itemFile, agents: await readAgents(path.join(s.dir, 'agents'), open) };
  }))).filter(Boolean);
}

// {<key>: true} of the cards, among the files' liveFiles', that have an open run whose log ends on Claude's login error
// (hub/login-error.mjs), its logs under home. A run that resumes after /login writes a new log, which the record names
// from then on.
export async function loggedOutCards(files, home = os.homedir()) {
  const logs = path.join(home, '.claude', 'kickflip', 'logs');
  const out = Object.create(null);
  for (const { slug, agents } of files) {
    for (const [id, byAgent] of Object.entries(agents || {})) {
      if (Object.values(byAgent).some((r) => r?.started && !r.done && r.session?.log && runLoggedOut(path.join(logs, r.session.log)))) out[`${slug}/${id}`] = true;
    }
  }
  return out;
}

// The notes of every card in the item files, files liveFiles', by key: its markdown (questions.mjs itemNotes), or null with
// none or a notes file it can't read, which GET /api/notes answers 404.
export async function cardNotesOf(files) {
  return Object.fromEntries(await Promise.all(files.flatMap(({ slug, dir, itemFile }) => itemFile.items.map(async (it) => {
    try { return [`${slug}/${it.id}`, await itemNotes(dir, it)]; } catch (e) {
      if (e instanceof BoardError || e.code === 'ENOENT') return [`${slug}/${it.id}`, null];
      throw e;
    }
  }))));
}

// The item files with archive entries' items (cards.mjs readArchive) back among their cards, so an archived card links
// to the live cards it names and that name it, as it did on the board, with their builder records.
async function withArchived(site, entries) {
  const files = await liveFiles(site);
  for (const a of entries) {
    const into = files.find((w) => w.slug === a.file);
    if (into) into.itemFile.items.push(a.item);
    else files.push({ slug: a.file, itemFile: { items: [a.item] }, agents: {} });
  }
  await Promise.all(files.filter((w) => w.dir).map(async (w) => {
    const ids = new Set(entries.filter((a) => a.file === w.slug).map((a) => a.item.id));
    if (ids.size) Object.assign(w.agents, await readAgents(path.join(w.dir, 'agents'), ids));
  }));
  return files;
}

// The item files, their threads and the board's settings: what buildBoard needs for the cards alone. A board that
// opens no PRs has no reviewers on its cards; its list stays in board.json
// (docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md).
async function itemSnapshot(site, { cfg, github, local, hub, remote, branch }, files) {
  const data = dataOf(site);
  files ??= await liveFiles(site);
  const threadLines = Object.create(null);
  await Promise.all(files.flatMap(({ slug, itemFile }) => itemFile.items.map(async (it) => {
    threadLines[`${slug}/${it.id}`] = await readLog(threadFile(site, `${slug}/${it.id}`));
  })));
  const settings = settingsOf(cfg);
  return { github, remote, branch, reviewers: opensPRs({ github, local, hub }, settingsOf(cfg, { hub })) ? cfg.reviewers || [] : [], fromWaves: cfg.items === 'waves',
    autoMerge: settings.auto_merge, skipDraft: settings.skip_draft, autoBuild: settings.auto_build, tickets: settings.tickets, files, threads: threadLines,
    working: await readWorking(site), delivered: await readDelivered(site), actedOn: await readActedOn(site), autoReview: settings.auto_review,
    incoming: await readJSON(path.join(data, 'incoming.json'), null), reviewRecords: await readJSON(path.join(data, 'reviews.json'), {}) };
}

const NEEDS_REPLY = new Set(['ask', 'owner-answer', 'grill-more', 'visual-request', 'review-request', 'item-message', 'overnight-triage']);

// Reads every source buildBoard needs for board site: item files and their builder records, PR state from the hub's
// GitHub check (prViewOf), item threads, page events with Claude's replies, owner questions and legacy review-link
// fallbacks; outside is outsideData's. home is the HOME whose run logs it reads.
// - archived: archive entries (cards.mjs readArchive), whose cards and questions it reads beside the item files' and
//   owner.json's, and no PR state for them: their badges draw what they kept (cards.mjs keptPRs).
// - items: true reads the item files, their threads and settings alone, enough for the cards' builders.
export async function readSnapshot(site, outside, { archived = [], items: itemsOnly = false, home = os.homedir() } = {}) {
  const here = path.resolve(site);
  const data = dataOf(here);
  const items = await itemSnapshot(here, outside, archived.length ? await withArchived(here, archived) : undefined);
  if (itemsOnly) return items;
  const { files, threads: threadLines, working } = items;
  const prs = Object.create(null);
  const archivedKeys = new Set(archived.map((a) => a.key));
  const checked = (await readJSON(githubStateFile(), {})).prs || {};
  const limited = limitedUntil({ budget: 'graphql' });
  for (const { slug, itemFile } of files) {
    const repo = items.github || itemFile.repo;
    for (const it of itemFile.items) {
      for (const p of cardPRs(it, repo)) prs[prKeyOf(p)] = archivedKeys.has(`${slug}/${it.id}`) ? null : prViewOf(routeRecord(checked, prKeyOf(p)), limited);
    }
  }
  const replyIndex = await readReplyIndex(repliesOf(here));
  const pageEvents = await Promise.all((await shownEvents(here)).map((e) => (NEEDS_REPLY.has(e.kind) || routeRecord(working, e.id) ? withReply(here, e, replyIndex) : { ...e, reply: null, replies: [] })));
  await Promise.all(pageEvents.filter((e) => e.kind === 'ask').map(async (e) => {
    const lines = await readLog(threadFile(here, `ask:${e.id}`));
    if (lines.length) threadLines[`ask:${e.id}`] = lines;
  }));

  const moved = Object.create(null);
  for (const { agents } of files) {
    for (const record of Object.values(agents || {}).flatMap((byAgent) => Object.values(byAgent))) {
      const dir = record.worktree?.path;
      const at = dir && !record.done ? transcriptMovedAt(dir) : null;
      if (at !== null) moved[dir] = at;
    }
  }

  // alive and landers: each run's process and each verification's lander (runs.mjs).
  const alive = await runAlive(here);
  const landers = await readLanders(here);
  // landSkips {<key>: skip}: what runs.mjs landable skips each verified card for, so its land step reads what
  // runs.mjs tick will do. Only a card with a verified record can wait to land, so with none landable isn't read.
  const verifiedAny = files.some(({ agents }) => Object.values(agents || {}).some((byAgent) => Object.values(byAgent).some((r) => r?.verified)));
  const landSkips = verifiedAny ? Object.fromEntries((await landable(here)).filter((c) => c.skip).map((c) => [c.key, c.skip])) : {};

  const tries = await readJSON(path.join(data, 'try.json'), null);
  return {
    // docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md: main's log tail rides the board while its build is failing.
    mainLog: tries?.main?.state === 'failed' ? await tryLogTail(here, 'main') : null,
    ...items, moved, alive, loggedOut: await loggedOutCards(files, home), try: tries, main: await readJSON(path.join(data, 'main.json'), null), prs, events: pageEvents, askLinks: await readAskLinks(here), archivedTags: await readArchivedTags(here),
    checked: await readJSON(path.join(data, 'checked.json'), null), watcher: await readJSON(path.join(data, 'watcher.json'), null), replyAt: await latestReply(here),
    owner: ((owner) => ({ ...owner, items: [...(owner.items || []), ...archived.flatMap((a) => a.questions || [])] }))(await readJSON(path.join(data, 'owner.json'), { items: [] })),
    topicItems: outside.topicItems, prSlack: await readJSON(path.join(data, 'pr-slack.json'), {}), hostBusy: outside.hostBusy,
    screening: await readScreening(here), queuedPlanners: await queuedPlanners(here), landers, landHeld: outside.landHeld, landSkips,
  };
}

// The cards of board site as its page draws them, by key: buildBoard of readSnapshot's whole read, so a CLI command
// reads the lane, blockedBy and finished the page shows, with the server down too. With no site (a command without
// --site), the cards of ~/.claude/waves' item files alone.
// Board site as its page draws it: buildBoard of readSnapshot's whole read, with each card's thread (threadViews).
export const builtBoard = async (site) => buildBoard(await readSnapshot(site, await outsideData(site)));
export async function builtCards(site) {
  const { items } = buildBoard(site ? await readSnapshot(site, await outsideData(site)) : { files: await liveFiles() });
  return new Map(items.filter((i) => i.kind === 'work').map((i) => [i.key, i]));
}
