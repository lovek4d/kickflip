// Questions and notes: a card's questions to the owner (owner.json), staged while its planner runs and screened before
// they show, their gates, answers and resolution, the prototype takes they point at, the card's notes file, and the
// planner work around them: staging, discussing, briefs and grill rounds. Written through files.mjs
// (docs/adr/2026-11-17-1137-cards-questions-asks-and-settings-leave-store-mjs.md).
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HAD_IMPLEMENT, COMMANDS, noTakePicked, picksTake, IMPLEMENT_SKIPPED, ANSWERED, ownerQuestion, plans, refOf, roundOf, roundSettledBy, VISUAL, REVIEWER, beside, OWES_IMPLEMENT, markedState } from './domain.mjs';
import { appendEvent } from '../hub/boards.mjs';
import { withFileLock } from '../hub/locks.mjs';
import { boardConfig, itemSources, readJSON, readLog, replace, writeJSON } from './files.mjs';
import { builtCards } from './snapshot.mjs';
import { BRIEF_LINE_LIMIT, lineFault } from './hub-lines.mjs';
import { hasPR } from '../shared/card-prs.mjs';
import { BoardError, fail, needSite, text, optional, pageUrl, bool, domId, onlyKeys } from './checks.mjs';
import { settingsOf } from './settings.mjs';
import { leaveNew } from './asks.mjs';
import { passNews, checkAskQuestion, builderFiles } from './runs.mjs';
import { ownerFile, parseKey, loadItemFile, loadItem, readReplyIndex, appendStatus, appendMessage, messageText, appendCommand, cardName, askCardOf, checkAsk, shownCard, leftTodo, checkSpec, namedTasks, linkedWith, ticketWrite, setItem, readArchive } from './cards.mjs';

// data/staged-questions.json {<file>/<id>: [question]}: questions added to a card while a planner of it runs, held back from
// owner.json until it finishes (docs/adr/2026-11-06-0100-a-grills-questions-appear-together-once-the-grill-is-done.md).
export const stagedFile = (site) => path.join(site, 'data', 'staged-questions.json');
// data/screening.json {<file>/<id>: <iso>}: the cards whose grill has finished with questions staged, which wait on the
// orchestrator to screen them, since when, until question publish, or SCREEN_AFTER, publishes them
// (docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md).
const screeningFile = (site) => path.join(site, 'data', 'screening.json');
export const SCREEN_AFTER = 15 * 60 * 1000;
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
    if (!q.next_gate && q.options.some((o) => o.id === 'implement' || /^implement\b/i.test(o.label))) fail(`${name} has an Implement option; only a grill's closing question, next_gate, offers Implement (choosing it stages the task), and a final visual ends on the card's Implement tap`);
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
export async function publishStaged(site, key, { screen = false } = {}) {
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

// docs/adr/2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md: while judging a staged card, as a ready one
// whose block ended is judged again, the orchestrator answers a question that what landed made stale again, in its
// notes, as it settles a screened one.
async function settleStale(site, id, said) {
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const q = (owner.items || []).find((x) => x.id === id && x.topic?.startsWith('item:'));
  if (!q) fail(`no staged question "${id}"; question settle takes a question a finished grill left for you to screen, or a staged task's question`);
  const key = q.topic.slice('item:'.length);
  if ((await loadItem(site, key)).item.phase !== 'staging') fail(`${key} isn't staged, so its question ${id} stays answered as it is`);
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
  const takes = new Map();
  for (const a of answers) {
    const q = asked.get(String(a.id));
    const key = cardOfTopic(q?.topic);
    if (key && picksTake(q, a.choice)) takes.set(key, { question: String(a.id), choice: String(a.choice), ...(a.note ? { note: String(a.note) } : {}) });
  }
  const prototype = [];
  const staged = [];
  for (const [key, said] of byCard) {
    if (!(await loadItem(site, key).catch(() => null))) continue;
    await followUp(site, key, 'writing them into its notes', async () => {
      await appendNotes(site, key, `Answers (owner, ${noteStamp()})`, said.join('\n'));
      const moved = await moveOnAnswered(site, key, takes.get(key));
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
// any other stageable card to staging; a take pick leaves the card discussing and owing the final visual's brief
// (docs/adr/2026-11-17-1800-a-take-pick-owes-a-final-visual-brief.md). The move to prototyping owes the orchestrator's prototype brief.
// → 'prototyping', 'discussing', 'staging' or null when the card stays.
export async function moveOnAnswered(site, key, take) {
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
  // A card the owner's Implement already staged keeps its place: the pick is in its notes, and no visual is owed.
  if (take && ['staging', 'ready'].includes(item.phase)) return null;
  if (take) {
    await discuss(site, key);
    const { source, itemFile, item: picked } = await loadItem(site, key);
    owe(picked, VISUAL, take);
    await writeJSON(source.file, itemFile);
    return 'discussing';
  }
  if (['prototyping', 'discussing'].includes(item.phase)) {
    await discuss(site, key);
    return 'discussing';
  }
  await stage(site, key);
  return 'staging';
}

// Drops item's gates.next, the owner's Keep discussing, once a move has acted on it or overridden it; gates goes with
// it when nothing else is kept.
export function spendNext(item) {
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
export const cardOfTopic = (topic) => (typeof topic === 'string' && topic.startsWith('item:') && !topic.startsWith('item:ask:') ? topic.slice(5) : null);
const pad2 = (n) => String(n).padStart(2, '0');
// The owner's time on a notes heading, MM/DD HH:MM in the host's local time.
export const noteStamp = (d = new Date()) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
export function freeNotesName(dir, id) {
  let name = `${notesBase(id)}-notes.md`;
  for (let n = 2; existsSync(path.join(dir, name)); n++) name = `${notesBase(id)}-notes-${n}.md`;
  return name;
}
export const writeNotesFile = (file, content) => replace(file, content, { mode: NOTES_MODE });
const notesHeading = (v) => (/\n/.test(text(v, '--heading')) ? fail('--heading is one line, the section\'s title') : text(v, '--heading'));
const withSection = (notes, heading, body) => `${notes.replace(/\n*$/, '\n')}\n## ${heading}\n${body.replace(/^\n+|\s+$/g, '')}\n`;

// Appends a section, ## heading then body, to the card's notes, first making the card's <id>-notes.md when it has
// none, or starting its named file again, with a thread line saying so, when that file is gone. → its file name.
export async function appendNotes(site, key, heading, body) {
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
export async function refuseCardNotes(site, draft, flag, hint) {
  if (draft === '-') return readFileSync(0, 'utf8');
  const real = await fs.realpath(draft).catch(() => fail(`${flag} ${draft}: no such file`));
  for (const card of await cardsWithNotes(site)) {
    if (await realNotes(card) === real) fail(`${flag} ${draft} is the notes file of ${card.ref} "${card.title}" (${card.key}), and a task's notes are its own; ${hint(card)}`);
  }
  return fs.readFile(real, 'utf8');
}
export const DRAFT_HINT = 'write a draft of your own outside the board\'s data folder';

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
  const cards = await builtCards(site);
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    let changed = false;
    for (const item of itemFile?.items || []) {
      const card = cards.get(`${source.slug}/${item.id}`);
      if (item.phase !== 'ready' || card?.lane !== 'todo' || card.finished) continue;
      if (!item.ready_main) {
        item.ready_main = main;
        item.ready_at ??= now.toISOString();
        changed = true;
      } else if (item.ready_main !== main && now - Date.parse(item.ready_at) >= READY_EXPIRES_MS) {
        Object.assign(item, { phase: 'staging', staged_at: now.toISOString() });
        delete item.ready_at;
        delete item.ready_main;
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
export async function markWaiting(site, key, on) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (on === 'implement') refuseImplementOwed(key, item);
  item.waits_on_owner = ownerMark(item, on);
  await writeJSON(source.file, itemFile);
}
export const ownerMark = (item, on) => ({ on, at: new Date().toISOString(), ...markedState(item) });
function refuseImplementOwed(key, item) {
  const { phase, lane } = markedState(item);
  const had = HAD_IMPLEMENT[lane === 'todo' ? phase : lane];
  if (had) fail(`${key} is already ${had}, so it owes no Implement: write in its thread without --implement`);
}
// The readied line's words: "Marked as ready · " and the orchestrator's check whole, which item set refuses when the
// line can't hold it (lineFault), for the orchestrator to rewrite; it is never cut.
const READIED_LEAD = `${COMMANDS.readied} · `;
export function readiedText(said) {
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
export function owe(item, kind, ask = {}, at = new Date().toISOString(), tap = false) {
  const briefs = item.briefs || [];
  const owed = briefs.find((b) => b.kind === kind && !b.brief);
  const requested = !Object.keys(ask).length ? {} : kind === 'prototype' ? { asks: [...(owed?.asks || []), ask] } : { ask };
  const asked = { ...requested, ...(tap ? { tap } : {}) };
  item.briefs = owed ? briefs.map((b) => (b === owed ? { ...b, ...asked } : b)) : [...briefs, { kind, at, ...asked }];
}
// A card sent back to its conversation owes nothing: its unwritten briefs go, the written ones stay for their launch.
export function dropOwed(item) {
  if (!item.briefs) return;
  item.briefs = item.briefs.filter((b) => b.brief);
  if (!item.briefs.length) delete item.briefs;
}
// The owner's Grill or Prototype tap (kind grill or prototype) on a Todo card: the card owes the orchestrator's brief for
// it, and a discussing, ready or staging card moves to grilling or prototyping. A Visual or Review tap (kind visual or
// reviewer) owes that agent's brief on any open card and moves no phase.
export async function planAgain(site, key, kind, ask = {}) {
  const { source, itemFile, item } = await loadItem(site, key);
  const card = await shownCard(site, key);
  if (card.finished || (!beside({ kind }) && card.lane !== 'todo')) return;
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
// `item brief <key> --kind grill|prototype|visual [--final] --file <draft.md>`: the orchestrator's brief for the card's
// next agent of that kind, appended to its notes as "Brief for <kind> round N" and set on the kind's owed entry, or on a
// new one when the orchestrator briefs an agent nobody asked for. A grill or prototype brief moves the Todo card to that
// phase; the board server launches the agent from it. A visual brief with --final draws a UI change's final visual,
// whose agent places its page marking the card's Implement (addVisual)
// (docs/adr/2026-11-17-1600-a-final-visual-ends-on-the-cards-implement.md). → {heading, lines}
export async function writeBrief(site, key, { kind, file, final }) {
  needSite(site);
  if (!BRIEF_KINDS.includes(kind)) fail(`item brief needs --kind grill, prototype, ${VISUAL} or ${REVIEWER}`);
  if (final && kind !== VISUAL) fail(`item brief --final is for a ${VISUAL}; a ${kind} is never final`);
  if (file === undefined) fail('item brief needs --file <draft.md>: what the discussion settled, what is still open, what the agent should cover and the files that matter');
  const name = await cardName(site, key);
  const { item } = await loadItem(site, key);
  const card = await shownCard(site, key);
  if (card.finished) fail(`${name} is done; there is nothing to brief`);
  if (!beside({ kind }) && card.lane !== 'todo') fail(`${name} is past Todo, so it gets no ${kind}`);
  const body = (await refuseCardNotes(site, file, '--file', () => `${DRAFT_HINT}, holding only the brief`)).trim();
  if (!body) fail(`${file} is empty`);
  const notes = item.plan ? (await readNotes(site, key)).markdown : '';
  const heading = `Brief for ${kind} round ${(notes.match(new RegExp(`^## Brief for ${kind} round \\d+`, 'gm')) || []).length + 1}`;
  await appendNotes(site, key, heading, body);
  const { source, itemFile, item: briefed } = await loadItem(site, key);
  const at = new Date().toISOString();
  const tapped = (briefed.briefs || []).some((b) => b.kind === kind && !b.brief && b.tap);
  if (!(briefed.briefs || []).some((b) => b.kind === kind && !b.brief)) owe(briefed, kind, {}, at);
  briefed.briefs = briefed.briefs.map((b) => (b.kind === kind && !b.brief ? { ...b, brief: { heading, text: body, at, ...(final ? { final: true } : {}) } } : b));
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
export async function dropBrief(site, key, kind) {
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
export const briefOn = async (site, key, kind) => ((await loadItem(site, key)).item.briefs || []).find((b) => b.kind === kind && b.brief) ?? null;
export const noBrief = async (site, key, kind) => fail(`${await cardName(site, key)} has no ${kind} brief; the orchestrator writes it with item brief ${key} --kind ${kind} --file <draft.md>`);
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
export async function resolveQuestion(site, id, note, { waitsOn, overAnswered } = {}) {
  needSite(site);
  const owner = await readJSON(ownerFile(site), { topics: [], items: [] });
  const q = (owner.items || []).find((x) => x.id === id);
  if (!q) fail(`no question "${id}" in owner.json`);
  const { answers, requests } = await ownerEvents(site);
  const view = ownerQuestion(q, answers, requests);
  // A question Send already resolved ANSWERED still takes --close or --implement, which mark its card waiting, and arch file's filing.
  if (view.state === 'resolved' && !((waitsOn || overAnswered) && q.resolved === ANSWERED)) return ownerFile(site);
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
export async function topicQuestionsAll(site) {
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
export const cardQuestions = (site, key) => topicQuestions(site, `item:${key}`);

export const resolveAnswered = (site, key, note) => resolveAnsweredOn(site, `item:${key}`, note);
export async function resolveAnsweredOn(site, topic, note) {
  if (!site) return [];
  const { owner, asked } = await topicQuestions(site, topic);
  const ids = answeredOnClaude(asked);
  if (ids.length) await markResolved(site, owner, ids, note);
  await clearWaitedNext(site, topic);
  return ids.map((id) => `resolved: ${id}`);
}

// docs/adr/2026-11-03-1313-an-answer-stops-waiting-once-its-acted-on.md
// A Next set while its card had an open question waits on the card's questions (the item file entry's next_on_questions).
export const hasOpenQuestion = async (site, key) => Boolean(site) && (await cardQuestions(site, key)).asked.some((q) => q.state === 'open');
export function setNext(item, next, waitsOnQuestions) {
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
export async function clearNext(site, key) {
  const { source, itemFile, item } = await loadItem(site, key);
  if (item.next === undefined && item.next_on_questions === undefined) return;
  delete item.next;
  delete item.next_at;
  delete item.next_on_questions;
  await writeJSON(source.file, itemFile);
}

// Closing a card resolves its questions (topic item:<key>) that have an answer, and refuses while one has none, naming
// `by`, unless force. → resolve(): writes the resolutions and returns `resolved: <id>` lines. Changes nothing itself.
export async function closeQuestions(site, key, by, force) {
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
export async function unpickedPrototype(site, key) {
  const owner = await readJSON(ownerFile(site), { items: [] });
  const { answers, requests } = await ownerEvents(site);
  return noTakePicked((owner.items || []).map((q) => ownerQuestion(q, answers, requests)), key);
}
export const clip = (s) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

// docs/adr/2026-11-02-1806-only-the-owner-or-auto-build-starts-a-card-run.md
// The owner's words on this board that can ask for a card run: an ask, an edit to one, a card message, an answer's note.
// An ask the orchestrator filed (askItem, data.asked) is not the owner's.
const OWNER_WORDS = { ask: 'text', 'ask-edited': 'text', 'item-message': 'text', 'owner-answer': 'note' };
// → words, once they quote what the owner wrote on this board; else it refuses, naming flag.
export async function ownerQuote(site, words, flag) {
  const quoted = text(words, flag).replace(/\s+/g, ' ');
  const said = (await readLog(path.join(site, 'data', 'events.jsonl'))).filter((e) => !e.data?.asked).map((e) => String(e.data?.[OWNER_WORDS[e.kind]] ?? '').replace(/\s+/g, ' ').toLowerCase());
  if (!said.some((t) => t.includes(quoted.toLowerCase()))) fail(`${flag} must quote the owner's words in an ask, task message or answer note on this board`);
  return quoted;
}

// docs/adr/2026-10-29-1639-a-full-plan-opens-as-a-page-on-the-site.md
// With missingOk, a notes file that doesn't exist yet gives the path it would have.
export async function planPath(dir, rel, { missingOk = false } = {}) {
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
