// The board's data migrations: each rewrites old data into the shape the code now reads, once, and leaves data
// already in that shape as it is. The board server runs the per-board ones as it starts; the hub runs migrateWaveNames
// and migrateDropWaves over every board in the manifest before it starts any. Their writes go through files.mjs.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PHASES, builds, HELPER } from './domain.mjs';
import { listBoards, readManifest, withManifestLock, writeManifest } from '../hub/boards.mjs';
import { itemSources, readJSON, readLog, replace, writeJSON } from './files.mjs';
import { hasPR, storedPRs } from '../shared/card-prs.mjs';
// The card, question and archive functions store.mjs still holds.
import { BoardError, archiveWrite, builderFiles, depKey, leftTodo, ownerFile, parseKey, readArchive, threadFile, ticketWrite, topicQuestionsAll, writeArchive } from './store.mjs';

const fail = (msg) => { throw new BoardError(msg); };

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
