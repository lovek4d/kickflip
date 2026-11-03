// A board's architecture review of its repo, which the header's bulb starts
// (docs/adr/0125-the-bulb-runs-an-architecture-review-of-the-boards-repo.md). The board server makes the review's wave
// and its first card, the audit, then appends `arch-review` for the session, which follows the mattpocock skills.
// data/arch-reviews.json {reviews: [{key, wave, lineup, title, repo, at}]}: wave is the lineup's slug, or on a board
// over ~/.claude/waves the wave file's, which lineup false marks.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boardRepo } from '../hub/board-repo.mjs';
import { readUsageGate, pauseReason } from '../shared/usage-gate.mjs';
import { reviewWaits } from '../shared/skills.mjs';
import { BoardError, addItem, appendThread, boardConfig, createLineup, itemSources, readJSON, startBuilder, wavesDir } from './store.mjs';

const recordsFile = (site) => path.join(site, 'data', 'arch-reviews.json');
export const readReviews = async (site) => (await readJSON(recordsFile(site), { reviews: [] })).reviews || [];

// The hub board reviews kickflip's own code, the board template and the model, and reads the live data only for its
// shapes.
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
      built: items.filter((i) => inWave(i) && i.lane === 'done' && i.status !== 'dropped').length,
    };
  };
  return { repo, waits, last: [...reviews].reverse().map(view).find(Boolean) || null };
}

const stampOf = (now) => now.toLocaleDateString('en-CA').replaceAll('-', '');
const dayOf = (now) => now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// The next id in the board's own numbering, PREFIX-n after its newest numbered card, else arch-<date>. A review's own
// wave file on a board over ~/.claude/waves starts with its audit, so there the card is <wave>/audit.
function nextId(items, now) {
  const numbered = items.map((it) => /^([A-Z][A-Z0-9]*)-([1-9]\d*)$/.exec(it.id)).filter(Boolean);
  if (numbered.length) {
    const prefix = numbered.at(-1)[1];
    return `${prefix}-${Math.max(...numbered.filter((m) => m[1] === prefix).map((m) => Number(m[2]))) + 1}`;
  }
  const base = `arch-${stampOf(now)}`;
  let id = base;
  for (let n = 2; items.some((it) => it.id === id); n++) id = `${base}-${n}`;
  return id;
}

async function freeSlug(base, taken) {
  let slug = base;
  for (let n = 2; await taken(slug); n++) slug = `${base}-${n}`;
  return slug;
}

const exists = (file) => fs.stat(file).then(() => true, () => false);

// Makes the review's wave and its audit card on the board at site (route board.route) and records it. The caller
// checks that no review is open. → {key, data}: the audit card and the arch-review event's data.
export async function startReview(site, board, { now = new Date(), home = os.homedir() } = {}) {
  const waits = reviewWaits(home);
  if (waits) throw Object.assign(new BoardError(waits), { status: 409 });
  const gate = readUsageGate({ home });
  if (gate.state === 'paused') throw Object.assign(new BoardError(pauseReason(gate)), { status: 409 });
  const target = boardRepo(board.route);
  const name = repoName(target);
  const title = `Architecture ${dayOf(now)}`;
  const base = `arch-${stampOf(now)}`;
  const sources = await itemSources(site);
  const fromWaves = (await boardConfig(site)).items === 'waves';

  let waveSlug, lineupSlug = null, id;
  if (fromWaves) {
    waveSlug = await freeSlug(base, (slug) => exists(path.join(wavesDir(), slug)));
    const file = path.join(wavesDir(), waveSlug, 'wave.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ title, ...(target.github ? { repo: target.github } : {}), items: [] }, null, 2) + '\n');
    id = 'audit';
  } else {
    const [source] = sources;
    const wave = await readJSON(source.file, { items: [] });
    const lineups = (await Promise.all(sources.map(async (s) => (await readJSON(s.file, {}))?.lineups || []))).flat();
    lineupSlug = await freeSlug(base, (slug) => sources.some((s) => s.slug === slug) || lineups.some((l) => l.slug === slug));
    waveSlug = source.slug;
    id = nextId(wave.items || [], now);
  }

  const key = `${waveSlug}/${id}`;
  await addItem(site, key, { title: `Architecture review of ${name}` });
  if (lineupSlug) {
    await createLineup(site, lineupSlug, {
      title, goal: `Act on the architecture review of ${name}`, cards: key,
      note: `${key.split('/')[1]} is the audit of ${name}: its Notes are the report, and it asks one question per finding. Each finding you don't skip becomes a card after it, built from the option you pick.`,
    });
  }
  await startBuilder(site, key, { label: 'Architecture review', progress: 'Waiting for Claude to start the review' });
  await appendThread(site, key, { text: `Started an architecture review of ${name}. Its report becomes this card's Notes, with one question per finding.` });

  const reviews = await readReviews(site);
  reviews.push({ key, wave: lineupSlug || waveSlug, lineup: Boolean(lineupSlug), title, repo: target.repo, at: now.toISOString() });
  await fs.mkdir(path.dirname(recordsFile(site)), { recursive: true });
  await fs.writeFile(recordsFile(site) + '.tmp', JSON.stringify({ reviews }, null, 2) + '\n');
  await fs.rename(recordsFile(site) + '.tmp', recordsFile(site));

  const data = { key, repo: target.repo, github: target.github || null, branch: target.branch || null, wave: lineupSlug || waveSlug, lineup: Boolean(lineupSlug), ...(target.hub ? { scope: HUB_SCOPE } : {}) };
  return { key, data };
}
