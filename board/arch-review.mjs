// A board's architecture review of its repo, which the header's bulb starts
// (docs/adr/2026-11-02-1813-the-bulb-runs-an-architecture-review-of-the-boards-repo.md). The board server makes the review's wave
// and its first card, the audit, then appends `arch-review` for the session, which follows the mattpocock skills.
// data/arch-reviews.json {reviews: [{key, wave, lineup, title, repo, at}]}: wave is the lineup's slug, or on a board
// over ~/.claude/waves the wave file's, which lineup false marks.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boardRepo } from '../hub/board-repo.mjs';
import { samePath } from '../hub/boards.mjs';
import { cloneRoot } from '../shared/repos.mjs';
import { readUsageGate, pauseReason, holdsWork } from '../shared/usage-gate.mjs';
import { reviewWaits } from '../shared/skills.mjs';
import { unlanded } from './domain.mjs';
import { BoardError, addItem, appendStatus, boardConfig, cardName, changeLineup, createLineup, itemSources, parseKey, readJSON, resolveQuestion, setItem, startBuilder, topicQuestions, wavesDir } from './store.mjs';

const recordsFile = (site) => path.join(site, 'data', 'arch-reviews.json');
export const readReviews = async (site) => (await readJSON(recordsFile(site), { reviews: [] })).reviews || [];

// A board whose repo is the running kickflip clone reviews kickflip's own code, the board template and the model, and
// reads the live data only for its shapes.
export const HUB_SCOPE = {
  paths: ['hub/', 'board/', 'shared/', 'CONTEXT.md', 'docs/adr/'],
  data: ['~/.claude/kickflip/manifest.json', '~/.claude/kickflip/sites/*/data/wave.json', '~/.claude/kickflip/sites/*/data/owner.json', '~/.claude/kickflip/sites/*/data/events.jsonl'],
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
    const inWave = (i) => i.key !== r.key && (r.lineup ? i.lineup?.slug === r.wave : i.wave === r.wave);
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

  let waveSlug, lineupSlug = null, key;
  if (fromWaves) {
    waveSlug = await freeSlug(base, (slug) => exists(path.join(wavesDir(), slug)));
    const file = path.join(wavesDir(), waveSlug, 'wave.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ title, ...(target.github ? { repo: target.github } : {}), items: [] }, null, 2) + '\n');
    key = (await addItem(site, `${waveSlug}/audit`, { title: `Architecture review of ${name}` })).key;
  } else {
    const [source] = sources;
    const lineups = (await Promise.all(sources.map(async (s) => (await readJSON(s.file, {}))?.lineups || []))).flat();
    lineupSlug = await freeSlug(base, (slug) => sources.some((s) => s.slug === slug) || lineups.some((l) => l.slug === slug));
    waveSlug = source.slug;
    key = (await addItem(site, waveSlug, { title: `Architecture review of ${name}` })).key;
  }

  if (lineupSlug) {
    await createLineup(site, lineupSlug, {
      title, goal: `Act on the architecture review of ${name}`, steps: [key],
      note: `${await cardName(site, key)} is the audit of ${name}: its Notes are the report, and it asks one question per finding. Each finding you don't skip becomes a card after it, built from the option you pick.`,
    });
  }
  await startBuilder(site, key, { label: 'Architecture review' });
  await appendStatus(site, key, 'arch-review', { card: name });

  const reviews = await readReviews(site);
  reviews.push({ key, wave: lineupSlug || waveSlug, lineup: Boolean(lineupSlug), title, repo: target.repo, at: now.toISOString() });
  await fs.mkdir(path.dirname(recordsFile(site)), { recursive: true });
  await fs.writeFile(recordsFile(site) + '.tmp', JSON.stringify({ reviews }, null, 2) + '\n');
  await fs.rename(recordsFile(site) + '.tmp', recordsFile(site));

  const data = { key, repo: target.repo, github: target.github || null, branch: target.branch || null, wave: lineupSlug || waveSlug, lineup: Boolean(lineupSlug), ...(target.repo && samePath(target.repo, cloneRoot()) ? { scope: HUB_SCOPE } : {}) };
  return { key, data };
}

// docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md
// `board.mjs arch file <key>`: each answered finding of the audit card becomes a card in the review's wave, titled
// with the picked option's label, its detail, practice and the owner's note as notes, chained after the wave's last
// card (a lineup's, else the wave file's newest), and its question resolved; a Skip pick resolves its question alone.
// A question with no answer yet stays. Once none is left, the audit card closes as
// done. → {lines}
export async function fileFindings(site, key) {
  const review = (await readReviews(site)).find((r) => r.key === key) || fail(`${key} is not an architecture review's audit card`);
  const { wave } = parseKey(key);
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
    const newest = (await readJSON((await itemSources(site)).find((s) => s.slug === wave).file, { items: [] })).items.at(-1)?.id;
    const added = await addItem(site, wave, { title: option.label, notes, ...(review.lineup ? {} : { deps: newest }) });
    if (review.lineup) await changeLineup(site, review.wave, { add: added.key });
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
