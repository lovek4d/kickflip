// The board's change numbers (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md). One counter, n, steps once
// for each built board that differs from the one before; each card, question and topic carries the number of its last
// change as changed, and the board carries n as its version. A page that holds the board at some number asks for what
// came after it, and patchSince answers from the current board alone: every record whose number is above it, the
// removals above it, and each other part of the board, sent whole, that changed above it. server.mjs keeps the state in
// data/sync.json, so a restart carries on counting; public/ui-patch.js applies the patch on the page.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

// Each list of records and the field that names a record in it.
export const LISTS = { items: 'key', owner: 'id', ownerTopics: 'id' };
// Fields of a page board that are neither records nor stamped parts.
const OWN = new Set(['version', 'generatedAt', 'onHost', ...Object.keys(LISTS)]);
// The removals kept; a since older than the newest one dropped gets the whole board.
export const TOMBSTONES_KEPT = 1000;

const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(v) ?? '').digest('base64url').slice(0, 16);

// A board's stamped things by id → hash: each record (`<list>:<id>`, its own changed left out), each list's order
// (`order:<list>`) and each other part (`part:<name>`).
function hashes(board) {
  const out = new Map();
  for (const [name, id] of Object.entries(LISTS)) {
    const list = board[name] || [];
    for (const { changed: _, ...r } of list) out.set(`${name}:${r[id]}`, hash(r));
    out.set(`order:${name}`, hash(list.map((r) => r[id])));
  }
  for (const [k, v] of Object.entries(board)) if (!OWN.has(k)) out.set(`part:${k}`, hash(v));
  return out;
}

// The state of a sync file that doesn't exist yet. It counts from start, the time in ms it begins, so a number a page
// holds from an earlier file is below its floor and gets the whole board. floor is the lowest since it can answer.
export const freshSync = (start) => ({ n: start, floor: start, stamps: {}, hashes: {}, tombstones: [] });

// → {sync, board}: sync moved on by board (n stepped once when anything in it changed or went), and board with n as its
// version and each record's changed. Leaves sync and board as they were.
export function stamp(sync, board) {
  const now = hashes(board);
  const changed = [...now].filter(([id, h]) => sync.hashes[id] !== h);
  const gone = Object.keys(sync.hashes).filter((id) => !now.has(id));
  let next = sync;
  if (changed.length || gone.length) {
    const n = sync.n + 1;
    const stamps = { ...sync.stamps };
    const kept = { ...sync.hashes };
    for (const [id, h] of changed) { stamps[id] = n; kept[id] = h; }
    for (const id of gone) { delete stamps[id]; delete kept[id]; }
    const tombstones = [...sync.tombstones.filter((t) => !now.has(t.id)), ...gone.map((id) => ({ id, n }))];
    const dropped = tombstones.splice(0, Math.max(0, tombstones.length - TOMBSTONES_KEPT));
    next = { n, floor: Math.max(sync.floor, dropped.at(-1)?.n ?? sync.floor), stamps, hashes: kept, tombstones };
  }
  const out = { ...board, version: next.n };
  for (const [name, id] of Object.entries(LISTS)) {
    if (board[name]) out[name] = board[name].map((r) => ({ ...r, changed: next.stamps[`${name}:${r[id]}`] }));
  }
  return { sync: next, board: out };
}

// board is the one sync last stamped. → {since, version, generatedAt, set, unset, lists: {<list>: {set, drop, order?}}}
// with what changed after since, or null when since is no number this sync can answer from.
export function patchSince(sync, board, since) {
  if (!Number.isInteger(since) || since < sync.floor || since > sync.n) return null;
  const after = (id) => sync.stamps[id] > since;
  const gone = sync.tombstones.filter((t) => t.n > since).map((t) => t.id);
  const set = {};
  for (const [k, v] of Object.entries(board)) if (!OWN.has(k) && after(`part:${k}`)) set[k] = v;
  const unset = gone.filter((id) => id.startsWith('part:')).map((id) => id.slice('part:'.length));
  const lists = {};
  for (const [name, id] of Object.entries(LISTS)) {
    const p = {
      set: (board[name] || []).filter((r) => r.changed > since),
      drop: gone.filter((g) => g.startsWith(`${name}:`)).map((g) => g.slice(name.length + 1)),
      ...(after(`order:${name}`) ? { order: (board[name] || []).map((r) => r[id]) } : {}),
    };
    if (p.set.length || p.drop.length || p.order) lists[name] = p;
  }
  return { since, version: sync.n, generatedAt: board.generatedAt, set, unset, lists };
}

// data/sync.json → the state it holds, or a fresh one starting now when there is none.
export async function readSync(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return freshSync(Date.now());
  }
}

export async function writeSync(file, sync) {
  await fs.writeFile(file + '.tmp', JSON.stringify(sync) + '\n');
  await fs.rename(file + '.tmp', file);
}
