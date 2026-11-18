// Asks: an ask is a task card from the moment it arrives. Filing, titling, answering, relating, triaging, moving and
// handing off an ask, a board's asks to other boards, replies to events (writeReply), and the session's reviews of
// incoming PRs. Written through files.mjs (docs/adr/2026-11-17-1137-cards-questions-asks-and-settings-leave-store-mjs.md).
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { LANES, boardAsksOf, implementAsk, slackSourced } from './domain.mjs';
import { appendEvent, isListening, listBoards, samePath } from '../hub/boards.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { appendLine, boardConfig, itemSources, readJSON, readLog, remove, replace, writeJSON } from './files.mjs';
import { HUB, hubText } from './hub-lines.mjs';
import { postReview, reviewsSince, CLAUDE_PREFIX, CLAUDE_MARK } from '../hub/pr-report.mjs';
import { hasPR } from '../shared/card-prs.mjs';
import { BoardError, fail, needSite, text, cardTitle, domId } from './checks.mjs';
import { settingsOf, boardRepoOf, boardTarget } from './settings.mjs';
import { freeNotesName, writeNotesFile, ownerMark, dropOwed, resolveAnsweredOn } from './questions.mjs';
import { threadFile, ownerFile, parseKey, loadItemFile, loadItem, replyFilesOf, freshenPush, uploadsDir, uploadMeta, STORED, appendStatus, appendMessage, messageText, askLinksFile, readAskLinks, cardName, askCardOf, checkAsk, placeIn, leftTodo, depKey, depList, parentKey, relatedKeys, UNSOURCED, SPLIT_NEEDS_PARENT, refuseUnborn, replyFirst, refuseUnlinked, askWordsOf, refuseUnplaced, linkedWith, linksOf, postLinkLines, nextTaskId, ticketWrite, setItem, blockLines } from './cards.mjs';

const readLines = async (f) => { try { return (await fs.readFile(f, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

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
  // docs/adr/2026-11-16-1700-replies-to-a-slack-message-post-into-its-slack-thread.md: slack is the reply for the caller to
  // queue to its Slack thread (slack-store.mjs queueSlackReply), or null.
  const slack = key && !key.startsWith('ask:') && slackSourced(event) && (card || await loadItem(site, key)).item.lane !== 'done' ? { key, name: path.basename(file, '.md') } : null;
  const lines = key ? await freshenPush(site, key, md) : [];
  // docs/adr/2026-11-01-1813-an-answered-question-stops-waiting-once-claude-acts-on-its-card.md
  if (card) lines.push(...await resolveAnsweredOn(site, `item:${card.key}`, 'Acted on: replied'));
  return { file, lines, slack };
}

// Whether the card an ask became is still New: nothing has sorted, answered or started it.
const stillNew = (item) => !item.phase && !item.answered_at && !leftTodo(item) && !hasPR(item) && !item.filed_held;
// docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md: the card an ask became, given its first
// phase, records when the orchestrator ingested it, which the New strip's line to the card reads (domain.mjs ingested).
// Call it before the phase is set. → whether the card left New, so its caller posts its held links once it is written
// (postHeldLinks).
export function leaveNew(item) {
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
export async function askItem(site, file, { text: request, parent, split, relate, deps, before, from, by = 'orchestrator', replyOn }, options) {
  needSite(site);
  if (file.includes('/')) fail(`item add --ask files a task keyed by the board's next number; pass the item file alone, ${file.split('/')[0]}`);
  const words = text(request, '--ask');
  if (!ASKERS.includes(by)) fail('--by takes orchestrator, builder or planner');
  if (by !== 'orchestrator' && parent === undefined) fail(`--by ${by} names the task whose ${by} asked: pass --parent <that task>`);
  if (split && parent === undefined) fail(SPLIT_NEEDS_PARENT);
  if (from !== undefined && by !== 'orchestrator') fail('--from names the task the orchestrator filed this from; --by builder and --by planner take --parent');
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
  const source = from === undefined ? undefined : depKey(file.split('/')[0], String(from).trim());
  if (source) await loadItem(site, source);
  const asked = by === 'orchestrator' ? { by, ...(source ? { from: source, ref: await cardName(site, source) } : {}) } : { by, key: links.parent, ref: await cardName(site, links.parent) };
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
export async function refuseFiled(site, eventId, key) {
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
export const inIntake = (item) => (item.from_ask ? stillNew(item) : Boolean(item.unfiled) && !item.phase);
// Every command that writes to a card refuses while it is still in intake: item triage is the one that sorts it.
// A name without a "/" is an ask's event id: the card the ask became is the one written to, if it has one.
export async function refuseInIntake(site, keys) {
  for (const name of keys) {
    const card = name.includes('/') ? { key: name, ...(await loadItem(site, name)) } : await askCardOf(needSite(site), name);
    if (!card) continue;
    const { key, item } = card;
    if (inIntake(item)) fail(`${key} is still in New: sort it first with item triage ${key} --title "<type>(<scope>): <summary>" --phase ${TRIAGE_PHASES.join('|')}, or --fold-into <task>; the owner's Implement (a Quick build ask) takes item triage ${key} --title with no --phase, which stages it`);
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
  // docs/adr/2026-11-17-0543-a-quick-ask-is-triaged-into-staging.md: the owner's Implement stages the task it asked for,
  // so its triage takes no phase but staging, and the orchestrator judges it from there as any staged task.
  const implement = item.from_ask !== undefined && implementAsk(await readLog(path.join(site, 'data', 'events.jsonl')), item.from_ask);
  if (implement && ((phase ?? 'staging') !== 'staging' || title === undefined)) fail(IMPLEMENT_STAGES(key));
  if (!implement && (title === undefined || phase === undefined)) fail(`item triage needs --title "<type>(<scope>): <summary>" and --phase ${TRIAGE_PHASES.join('|')}, or --fold-into <task> for a duplicate`);
  if (!implement && !TRIAGE_PHASES.includes(phase)) fail(`item triage --phase takes ${TRIAGE_PHASES.join(', ')}; ready follows the investigation, with item set ${key} --phase ready`);
  if (said !== undefined) fail('item triage --text goes only with --fold-into, whose line it joins; a triaged task shows no Triaged line, so put what you know in its notes (item notes)');
  if (item.from_ask) {
    const file = parseKey(key).file;
    const links = new Set(await linkedWith(site, key));
    for (const k of [parent, ...String(relate ?? '').split(','), ...String(deps ?? '').split(',')]) if (k !== undefined && k.trim()) links.add(depKey(file, k.trim()));
    await refuseUnplaced(site, 'the ask', await askWordsOf(site, item.from_ask), { links: [...links], ticket: ticket ?? item.ticket, repo: boardRepoOf(site, (await loadItemFile(site, file)).itemFile), canTicket: true });
  }
  return setItem(site, key, { title, phase: implement ? 'staging' : phase === 'visual' ? 'discussing' : phase, relate, parent, split, deps, ticket, replyOn, triaged: true }, options);
}
const IMPLEMENT_STAGES = (key) => `${key} came with the owner's Implement, which stages it: run item triage ${key} --title "<type>(<scope>): <summary>" with its links and no --phase, then judge it as any staged task: item set ${key} --phase ready --text "<what you checked>", or --phase grilling or prototyping with a thread line saying why`;
export const IMPLEMENT_NOT_FILED = (ask) => `ask "${ask}" came with the owner's Implement, which stages its task: item triage stages its New card, never a --from-ask filing`;

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
export async function refuseMoved(site, eventId) {
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
// docs/adr/2026-11-18-2200-a-board-asks-a-board-on-another-of-your-hubs-while-its-online.md
// A question this board put to another board, one line each in data/board-asks.jsonl {id, to, text, key?, at}: id is
// the board-ask event's on the board at `to`, a route in this hub or <hub>/<route> on another of the owner's hubs, and
// key the card it was asked from. Its answer comes back as a board-answer {id, from, key?, question, text} event in this
// board's log (answerBoardAsk in this hub, takePeerAnswer from another).
const boardAsksFile = (site) => path.join(site, 'data', 'board-asks.jsonl');
// How a line names the board at `to`: /<route> in this hub, <hub>/<route> on another.
const named = (to) => (to.includes('/') ? to : `/${to}`);
const PEER_ROUTE = /^([^/\s]+)\/([^/\s]+)$/;
// One request to this hub's loopback /_hub/peers/<what> (hub.mjs), which relays it to another of the owner's hubs:
// GET with no body, else a JSON POST. → its JSON answer; throws its refusal, or that this hub doesn't answer.
async function viaHub(what, body) {
  let r;
  try {
    r = await fetch(`http://127.0.0.1:${process.env.KICKFLIP_HUB_PORT || 4500}/_hub/peers/${what}`, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (e) { fail(`this hub doesn't answer (${e.cause?.code || e.cause?.message || e.name}), so nothing went to another hub`); }
  const answer = await r.json().catch(() => ({}));
  if (!r.ok) fail(answer.error || `this hub answered ${r.status}`);
  return answer;
}
// Asks the board at route a one-line question: there, a board-ask {text, from {route, title, key?, ref?}} event, which
// wakes its orchestrator, shows in its New strip and waits on it until answered (domain.mjs boardAskWaits); while no
// orchestrator listens there, the event waits in its log. A route <hub>/<route> is a board on another of the owner's
// hubs: the question goes through this hub to that one (takePeerAsk there), and is refused while that hub can't take
// it. Here, the record, and on card from, if given, the quiet "Asked <route>: <question>" line.
export async function askBoard(site, route, question, { from } = {}) {
  needSite(site);
  const words = text(question, 'ask');
  if (/\n/.test(words)) fail('ask takes one line; ask each question on its own');
  const peer = PEER_ROUTE.exec(String(route ?? ''));
  const target = peer ? null : targetBoard(site, route, 'ask', `ask ${route}`);
  if (from !== undefined) await loadItem(site, from);
  const asker = { route: path.basename(site), title: (await boardConfig(site)).title, ...(from !== undefined ? { key: from, ref: await cardName(site, from) } : {}) };
  const { id, listening } = peer
    ? await viaHub('ask', { hub: peer[1], route: peer[2], text: words, from: asker })
    : { id: await appendEvent(target, 'board-ask', { text: words, from: asker }), listening: isListening(target) };
  await appendLine(boardAsksFile(site), { id, to: route, text: words, ...(from !== undefined ? { key: from } : {}), at: new Date().toISOString() });
  if (from !== undefined) await appendStatus(site, from, 'board-asked', { route, question: words });
  return { id, lines: listening ? [] : [`queued: ${named(route)}'s orchestrator isn't listening, so it answers once it is`] };
}

// Another of the owner's hubs asking a board here (hub.mjs /_hub/peer/ask): body {route, text, from {hub, host, route,
// title, key?, ref?}}, filed as askBoard files a question within this hub, from naming the asking hub as well.
// → {id, listening}
export async function takePeerAsk(body) {
  const words = text(body?.text, 'ask');
  if (/\n/.test(words)) fail('ask takes one line; ask each question on its own');
  const { route, from } = body;
  if (![from?.hub, from?.host, from?.route].every((v) => typeof v === 'string' && v)) fail('an ask from another hub names its hub, host and route');
  const boards = listBoards();
  const target = boards.find((b) => b.route === route) || fail(`no board at /${route}; the boards are ${boards.map((b) => b.route).join(', ') || 'none'}`);
  const asker = { hub: from.hub, host: from.host, route: from.route, title: String(from.title || from.route), ...(from.key ? { key: String(from.key), ref: String(from.ref || from.key) } : {}) };
  return { id: await appendEvent(target, 'board-ask', { text: words, from: asker }), listening: isListening(target) };
}

// The orchestrator's answer to question id another board asked this one: here, a board-ask-answered {id, text} event,
// record-only, which ends its wait and its New strip entry; on the asking board, the answer as an ordinary message
// on the card it was asked from, written as this board's route with via board, and a board-answer event, which wakes
// that board's orchestrator. A question from another hub's board goes back through this hub to that one
// (takePeerAnswer there). The record here goes last, so an answer that didn't reach the asking board still waits.
export async function answerBoardAsk(site, id, answer) {
  needSite(site);
  const words = messageText(answer);
  const ask = boardAsksOf(await readLog(path.join(site, 'data', 'events.jsonl'))).find((a) => a.id === id)
    || fail(`no question "${id}" from another board on this board; the waits lines name each one`);
  if (ask.answer) fail(`question ${id} is already answered`);
  const here = { route: path.basename(site), title: (await boardConfig(site)).title };
  if (ask.from.hub) await viaHub('answer', { hub: ask.from.hub, id, route: ask.from.route, text: words, from: here });
  else {
    const asker = listBoards().find((b) => b.route === ask.from.route)
      || fail(`/${ask.from.route}, which asked question ${id}, is no longer in the hub's manifest`);
    await deliverAnswer(asker, { id, key: ask.from.key, question: ask.text, text: words, from: here });
  }
  await appendEvent(boardTarget(site), 'board-ask-answered', { id, text: words });
  return { route: ask.from.hub ? `${ask.from.hub}/${ask.from.route}` : ask.from.route, lines: [] };
}
// On the asking board: the answer on the card it was asked from, named for the answering board (<hub>/<route> from
// another hub), and the board-answer event.
async function deliverAnswer(asker, { id, key, question, text: words, from }) {
  if (key) await appendMessage(asker.dir, key, { text: words, who: from.hub ? `${from.hub}/${from.route}` : from.route, via: 'board' });
  await appendEvent(asker, 'board-answer', { id, from, ...(key ? { key } : {}), question, text: words });
}
// Another of the owner's hubs answering a question a board here asked it (hub.mjs /_hub/peer/answer): body {id, route,
// text, from {hub, route, title}}, route the asking board. The card and the question come from the asking board's own
// record of what it asked whom. → {}
export async function takePeerAnswer(body) {
  const words = messageText(body?.text);
  const { id, route, from } = body;
  if (![id, from?.hub, from?.route].every((v) => typeof v === 'string' && v)) fail('an answer from another hub names its question, hub and route');
  const asker = listBoards().find((b) => b.route === route) || fail(`no board at /${route}, which asked question ${id}`);
  const to = `${from.hub}/${from.route}`;
  const asked = (await readLines(boardAsksFile(asker.dir))).find((a) => a.id === id && a.to === to)
    || fail(`/${route} asked ${to} no question ${id}`);
  await deliverAnswer(asker, { id, key: asked.key, question: asked.text, text: words, from: { hub: from.hub, route: from.route, title: String(from.title || from.route) } });
  return {};
}

// This hub's boards and each of the owner's other hubs' (through this hub's /_hub/peers/boards). → {lines}: "<route>:
// <title>" for each board here, then each other hub's as <hub>/<route>, or the line saying why a hub, or all of them,
// can't be listed.
export async function listAllBoards() {
  const here = listBoards().map((b) => `${b.route}: ${b.title}`);
  let hubs;
  try { ({ hubs } = await viaHub('boards')); } catch (e) { if (e instanceof BoardError) return { lines: [...here, `other hubs: ${e.message}`] }; throw e; }
  return { lines: [...here, ...hubs.flatMap((h) => (h.error ? [`${h.hub}: ${h.error}`] : h.boards.map((b) => `${h.hub}/${b.route}: ${b.title}`)))] };
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
      // Another hub's board is read only when it's asked, so its orchestrator reads as awaited.
      if (PEER_ROUTE.test(a.to)) return `waiting on ${a.to}'s orchestrator`;
      const board = boards.find((b) => b.route === a.to);
      return board && isListening(board) ? `waiting on /${a.to}'s orchestrator` : `queued: /${a.to}'s orchestrator isn't listening`;
    };
    const lines = asks.flatMap((a) => [`${a.id} ${named(a.to)}: ${a.text}`, `  ${state(a)}`]);
    const waiting = asks.filter((a) => !answers.has(a.id));
    if (!wait || !waiting.length) return { lines };
    if (now() >= deadline) fail(`${waiting.map((a) => a.id).join(', ')} still waiting on ${[...new Set(waiting.map((a) => named(a.to)))].join(', ')} after ${minutes} minutes; run asks --wait again`);
    // poll: board-asks-wait
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
