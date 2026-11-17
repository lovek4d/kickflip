// A board's architecture review of its repo, which the header's bulb starts
// (docs/adr/2026-11-02-1813-the-bulb-runs-an-architecture-review-of-the-boards-repo.md). The board server makes the
// review's audit card, then appends `arch-review` for the session, which follows the mattpocock skills. Each finding
// filed becomes a Child of the audit card that waits on it.
// data/arch-reviews.json {reviews: [{key, file?, title, repo, at}]}: file is the review's own item file, on a board over
// ~/.claude/waves.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boardRepo } from '../hub/board-repo.mjs';
import { samePath } from '../hub/boards.mjs';
import { cloneRoot } from '../shared/repos.mjs';
import { readUsageGate, pauseReason, holdsWork } from '../shared/usage-gate.mjs';
import { reviewWaits } from '../shared/skills.mjs';
import { ANSWERED, unlanded } from './domain.mjs';
import { BoardError } from './checks.mjs';
import { addItem, appendStatus, cardName, parseKey, setItem } from './cards.mjs';
import { resolveQuestion, topicQuestions } from './questions.mjs';
import { startBuilder } from './runs.mjs';
import { boardConfig, editJSON, itemSources, readJSON, wavesDir, writeJSON } from './files.mjs';

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
// newest review whose audit card the board still has: {key, ref, title, at, open, running, findings, built}. It is open
// while its audit card isn't Done, and running while open with no question asked yet. findings counts the audit's
// questions, prototype rounds apart; built counts the audit card's Children that are Done and weren't dropped.
export function archOf(reviews, items, questions, { repo, waits }) {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const view = (r) => {
    const card = byKey.get(r.key);
    if (!card) return null;
    const open = card.lane !== 'done';
    return {
      key: r.key, ref: card.ref, title: r.title, at: r.at, open, running: open && !card.questions,
      findings: questions.filter((q) => q.topic === `item:${r.key}` && !q.round_of && !q.confirm_of).length,
      built: items.filter((i) => i.parent?.key === r.key && i.lane === 'done' && !unlanded(i)).length,
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

// Makes the review's audit card on the board at site (route board.route) and records it. The caller
// checks that no review is open. → {key, data}: the audit card and the arch-review event's data.
export async function startReview(site, board, { now = new Date(), home = os.homedir() } = {}) {
  const waits = reviewWaits(home);
  if (waits) throw Object.assign(new BoardError(waits), { status: 409 });
  const gate = readUsageGate({ home, dir: site });
  if (holdsWork(gate)) throw Object.assign(new BoardError(pauseReason(gate)), { status: 409 });
  const target = boardRepo(board.route);
  const name = repoName(target);
  const title = `Architecture ${dayOf(now)}`;

  // made: {file} for the review's own item file on a board over ~/.claude/waves, where a card needs a file to live in.
  let made = {}, key;
  if ((await boardConfig(site)).items === 'waves') {
    const fileSlug = await freeSlug(`arch-${stampOf(now)}`, (slug) => exists(path.join(wavesDir(), slug)));
    const file = path.join(wavesDir(), fileSlug, 'wave.json');
    await writeJSON(file, { title, ...(target.github ? { repo: target.github } : {}), items: [] });
    key = (await addItem(site, `${fileSlug}/audit`, { title: `Architecture review of ${name}` })).key;
    made = { file: fileSlug };
  } else {
    const [source] = await itemSources(site);
    key = (await addItem(site, source.slug, { title: `Architecture review of ${name}` })).key;
  }

  await startBuilder(site, key, { label: 'Architecture review' });
  await appendStatus(site, key, 'arch-review', { card: name });

  await editJSON(recordsFile(site), (records) => {
    records.reviews = [...(records.reviews || []), { key, ...made, title, repo: target.repo, at: now.toISOString() }];
  });

  const data = { key, repo: target.repo, github: target.github || null, branch: target.branch || null, ...made, ...(target.repo && samePath(target.repo, cloneRoot()) ? { scope: HUB_SCOPE } : {}) };
  return { key, data };
}

// docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md
// `board.mjs arch file <key>`: each answered finding of the audit card becomes a card in its item file, titled with
// the picked option's label, its detail, practice and the owner's note as notes, a Child of the audit card and blocked
// by it, and its question resolved; a Skip pick resolves its question alone. A question with no answer yet stays.
// Once none is left, the audit card closes as done. → {lines}
export async function fileFindings(site, key) {
  if (!(await readReviews(site)).some((r) => r.key === key)) fail(`${key} is not an architecture review's audit task`);
  const { file, id } = parseKey(key);
  const { asked } = await topicQuestions(site, `item:${key}`);
  const lines = [];
  // Send resolves an answered question ANSWERED at once, so that counts as answered until filed or skipped.
  for (const q of asked.filter((x) => x.state === 'answered' || (x.state === 'resolved' && x.resolved === ANSWERED && x.answers.length))) {
    const answer = q.answers.at(-1);
    const option = q.options.find((o) => o.id === answer.choice);
    if (!option) continue;
    if (option.id === 'skip' || option.label === 'Skip') {
      await resolveQuestion(site, q.id, 'Skipped.', { overAnswered: true });
      lines.push(`skipped: ${q.id}`);
      continue;
    }
    const notes = [option.detail, ...(option.practice || []).map((l) => `- ${l}`), answer.note.trim() && `Owner's note: ${answer.note.trim()}`, `From the finding: ${q.question}`].filter(Boolean).join('\n\n');
    const added = await addItem(site, file, { title: option.label, notes, deps: id, parent: key });
    const ref = await cardName(site, added.key);
    await resolveQuestion(site, q.id, `Filed as ${ref}.`, { overAnswered: true });
    lines.push(`filed: ${ref} from ${q.id}`, ...(added.lines || []));
  }
  const left = (await topicQuestions(site, `item:${key}`)).asked.filter((x) => x.state !== 'resolved');
  if (left.length) return { lines: [...lines, `waiting: ${left.map((x) => x.id).join(', ')}`] };
  const filed = (await topicQuestions(site, `item:${key}`)).asked.filter((x) => /^Filed as /.test(x.resolved || '')).map((x) => x.resolved.slice(9, -1));
  const closed = await setItem(site, key, { done: true, closing: ['findings-settled', { filed: filed.join(', ') }] });
  return { lines: [...lines, ...closed.lines, `closed: ${await cardName(site, key)}`] };
}
