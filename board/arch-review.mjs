// A board's architecture review of its repo, which the header's bulb starts
// (docs/adr/2026-11-02-1813-the-bulb-runs-an-architecture-review-of-the-boards-repo.md). The board server makes the review's wave
// and its first card, the audit, then appends `arch-review` for the session, which follows the mattpocock skills.
// data/arch-reviews.json {reviews: [{key, wave | file, title, repo, at}]}: wave is the review's wave's slug, or on a
// board over ~/.claude/waves file is its item file's.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boardRepo } from '../hub/board-repo.mjs';
import { samePath } from '../hub/boards.mjs';
import { cloneRoot } from '../shared/repos.mjs';
import { readUsageGate, pauseReason, holdsWork } from '../shared/usage-gate.mjs';
import { reviewWaits } from '../shared/skills.mjs';
import { unlanded } from './domain.mjs';
import { BoardError, addItem, appendStatus, boardConfig, cardName, changeWave, createWave, itemSources, parseKey, readJSON, resolveQuestion, setItem, startBuilder, topicQuestions, wavesDir } from './store.mjs';

const recordsFile = (site) => path.join(site, 'data', 'arch-reviews.json');
export const readReviews = async (site) => (await readJSON(recordsFile(site), { reviews: [] })).reviews || [];

// A board whose repo is the running kickflip clone reviews kickflip's own code, the board template and the model, and
// reads the live data only for its shapes.
export const HUB_SCOPE = {
  paths: ['hub/', 'board/', 'shared/', 'CONTEXT.md', 'docs/adr/'],
  data: ['~/.claude/kickflip/manifest.json', '~/.claude/kickflip/sites/*/data/items.json', '~/.claude/kickflip/sites/*/data/owner.json', '~/.claude/kickflip/sites/*/data/events.jsonl'],
};

export const repoName = ({ github, repo }) => (github ? github.split('/').pop() : path.basename(repo || '')) || 'this repo';

// The bulb's state in /api/board: {repo, waits, last}. waits is why a review can't start yet, else null. last is the
// newest review whose audit card the board still has: {key, ref, wave, at, open, running, findings, built}. It is open
// while its audit card isn't Done, and running while open with no question asked yet. findings counts the audit's
// questions, prototype rounds apart; built counts the wave's other cards that are Done and weren't dropped.
export function archOf(reviews, items, questions, { repo, waits }) {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const view = (r) => {
    const card = byKey.get(r.key);
    if (!card) return null;
    const inWave = (i) => i.key !== r.key && (r.wave ? i.wave?.slug === r.wave : i.file === r.file);
    const open = card.lane !== 'done';
    return {
      key: r.key, ref: card.ref, wave: r.title, at: r.at, open, running: open && !card.questions,
      findings: questions.filter((q) => q.topic === `item:${r.key}` && !q.round_of && !q.confirm_of).length,
      built: items.filter((i) => inWave(i) && i.lane === 'done' && !unlanded(i)).length,
    };
  };
  return { repo, waits, last: [...reviews].reverse().map(view).find(Boolean) || null };
}

const stampOf = (now) => now.toLocaleDateString('en-CA').replaceAll('-', '');
const dayOf = (now) => now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

async function freeSlug(base, taken) {
  let slug = base;
  for (let n = 2; await taken(slug); n++) slug = `${base}-${n}`;
  return slug;
}

const fail = (msg) => { throw new BoardError(msg); };
const exists = (file) => fs.stat(file).then(() => true, () => false);

// Makes the review's wave and its audit card on the board at site (route board.route) and records it. The caller
// checks that no review is open. → {key, data}: the audit card and the arch-review event's data.
export async function startReview(site, board, { now = new Date(), home = os.homedir() } = {}) {
  const waits = reviewWaits(home);
  if (waits) throw Object.assign(new BoardError(waits), { status: 409 });
  const gate = readUsageGate({ home, dir: site });
  if (holdsWork(gate)) throw Object.assign(new BoardError(pauseReason(gate)), { status: 409 });
  const target = boardRepo(board.route);
  const name = repoName(target);
  const title = `Architecture ${dayOf(now)}`;
  const base = `arch-${stampOf(now)}`;
  const sources = await itemSources(site);
  const fromWaves = (await boardConfig(site)).items === 'waves';

  // made: {wave} for the review's wave, or {file} for its own item file on a board over ~/.claude/waves.
  let made, key;
  if (fromWaves) {
    const fileSlug = await freeSlug(base, (slug) => exists(path.join(wavesDir(), slug)));
    const file = path.join(wavesDir(), fileSlug, 'wave.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ title, ...(target.github ? { repo: target.github } : {}), items: [] }, null, 2) + '\n');
    key = (await addItem(site, `${fileSlug}/audit`, { title: `Architecture review of ${name}` })).key;
    made = { file: fileSlug };
  } else {
    const [source] = sources;
    const waves = (await Promise.all(sources.map(async (s) => (await readJSON(s.file, {}))?.waves || []))).flat();
    made = { wave: await freeSlug(base, (slug) => sources.some((s) => s.slug === slug) || waves.some((w) => w.slug === slug)) };
    key = (await addItem(site, source.slug, { title: `Architecture review of ${name}` })).key;
  }

  if (made.wave) {
    await createWave(site, made.wave, {
      title, goal: `Act on the architecture review of ${name}`, cards: [key],
      note: `${await cardName(site, key)} is the audit of ${name}: its Notes are the report, and it asks one question per finding. Each finding you don't skip becomes a task after it, built from the option you pick.`,
    });
  }
  await startBuilder(site, key, { label: 'Architecture review' });
  await appendStatus(site, key, 'arch-review', { card: name });

  const reviews = await readReviews(site);
  reviews.push({ key, ...made, title, repo: target.repo, at: now.toISOString() });
  await fs.mkdir(path.dirname(recordsFile(site)), { recursive: true });
  await fs.writeFile(recordsFile(site) + '.tmp', JSON.stringify({ reviews }, null, 2) + '\n');
  await fs.rename(recordsFile(site) + '.tmp', recordsFile(site));

  const data = { key, repo: target.repo, github: target.github || null, branch: target.branch || null, ...made, ...(target.repo && samePath(target.repo, cloneRoot()) ? { scope: HUB_SCOPE } : {}) };
  return { key, data };
}

// docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md
// `board.mjs arch file <key>`: each answered finding of the audit card becomes a card in the review's wave, titled
// with the picked option's label, its detail, practice and the owner's note as notes, blocked by the audit card in the
// review's wave (with no wave, by the item file's newest card), and its question resolved; a Skip pick resolves its question alone.
// A question with no answer yet stays. Once none is left, the audit card closes as
// done. → {lines}
export async function fileFindings(site, key) {
  const review = (await readReviews(site)).find((r) => r.key === key) || fail(`${key} is not an architecture review's audit task`);
  const { file } = parseKey(key);
  const { asked } = await topicQuestions(site, `item:${key}`);
  const lines = [];
  for (const q of asked.filter((x) => x.state === 'answered')) {
    const answer = q.answers.at(-1);
    const option = q.options.find((o) => o.id === answer.choice);
    if (!option) continue;
    if (option.id === 'skip' || option.label === 'Skip') {
      await resolveQuestion(site, q.id, 'Skipped.');
      lines.push(`skipped: ${q.id}`);
      continue;
    }
    const notes = [option.detail, ...(option.practice || []).map((l) => `- ${l}`), answer.note.trim() && `Owner's note: ${answer.note.trim()}`, `From the finding: ${q.question}`].filter(Boolean).join('\n\n');
    const newest = (await readJSON((await itemSources(site)).find((s) => s.slug === file).file, { items: [] })).items.at(-1)?.id;
    const added = await addItem(site, file, { title: option.label, notes, ...(review.wave ? {} : { deps: newest }) });
    if (review.wave) await changeWave(site, review.wave, { add: added.key, after: key });
    const ref = await cardName(site, added.key);
    await resolveQuestion(site, q.id, `Filed as ${ref}.`);
    lines.push(`filed: ${ref} from ${q.id}`, ...(added.lines || []));
  }
  const left = (await topicQuestions(site, `item:${key}`)).asked.filter((x) => x.state !== 'resolved');
  if (left.length) return { lines: [...lines, `waiting: ${left.map((x) => x.id).join(', ')}`] };
  const filed = (await topicQuestions(site, `item:${key}`)).asked.filter((x) => /^Filed as /.test(x.resolved || '')).map((x) => x.resolved.slice(9, -1));
  const closed = await setItem(site, key, { done: true, closing: ['findings-settled', { filed: filed.join(', ') }] });
  return { lines: [...lines, ...closed.lines, `closed: ${await cardName(site, key)}`] };
}
