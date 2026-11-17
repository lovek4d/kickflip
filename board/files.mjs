// docs/adr/2026-11-17-0521-every-process-writes-site-data-through-one-files-module.md
// How every process (the CLI through store.mjs, the board server, the hub) reads and writes a board's data files: JSON
// files replaced by a rename of a tmp file of the write's own, a value read earlier merged under the file's lock with
// what others wrote since, a locked edit from read to rename, JSON-lines appends, the event log's one append, and the
// change signal each write sends the board servers that show the file (wrote).
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { isBoardSite, readManifest } from '../hub/boards.mjs';
import { withFileLock } from '../hub/locks.mjs';
import { merge3 } from './merge3.mjs';

export const sitesDir = () => path.join(os.homedir(), '.claude', 'kickflip', 'sites');
export const wavesDir = () => path.join(os.homedir(), '.claude', 'waves');

// An object read from a file carries the text it was read from, so writeJSON can merge in what others wrote meanwhile.
const READ_AS = Symbol('read as');
export const readJSON = async (f, fallback) => {
  let text;
  try { text = await fs.readFile(f, 'utf8'); } catch { return fallback; }
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value, [READ_AS]: text } : value;
  } catch { return fallback; }
};

export const boardConfig = async (site) => ({ title: 'Board', items: 'waves', ...(site ? await readJSON(path.join(site, 'board.json'), {}) : {}) });

// Each item file the board shows: {slug, dir, file}. Builder records sit in <dir>/agents.
export async function itemSources(site) {
  const cfg = await boardConfig(site);
  if (cfg.items === 'waves') {
    try {
      return (await fs.readdir(wavesDir(), { withFileTypes: true })).filter((d) => d.isDirectory())
        .map((d) => ({ slug: d.name, dir: path.join(wavesDir(), d.name), file: path.join(wavesDir(), d.name, 'wave.json') }));
    } catch { return []; }
  }
  const file = path.resolve(site, cfg.items);
  return [{ slug: cfg.slug || path.basename(cfg.items, '.json'), dir: path.dirname(file), file }];
}

// docs/adr/2026-11-16-0205-the-event-log-and-threads-are-parsed-once-and-archived-cards-agent-files-go-unread.md
// The lines of an append-only JSON-lines file (data/events.jsonl, a thread), each parsed once in this process: a read
// stats the file and parses only the bytes appended since the last, read from the start of the last whole line it
// kept, so a file rewritten under it shows in bytes that no longer match and is read whole again, as is one replaced
// (another inode) or rewritten to the same length. A last line with no newline counts once it parses, and is left out
// while it is still being written. A broken whole line makes the file read as empty. → a new array each call, of
// frozen lines, so no caller changes what another reads.
const logs = new Map();
const frozen = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) frozen(v[k]); }
  return v;
};
const parseLines = (text) => text.split('\n').filter(Boolean).map((l) => frozen(JSON.parse(l)));
export async function readLog(file) {
  let st;
  try { st = await fs.stat(file); } catch { logs.delete(file); return []; }
  let kept = logs.get(file);
  if (kept && (kept.ino !== st.ino || st.size <= kept.size)) {
    if (st.size === kept.size && st.mtimeMs === kept.mtimeMs) return [...kept.lines, ...kept.open];
    kept = null;
  }
  for (;;) {
    const from = kept ? kept.end - kept.tail.length : 0;
    const fh = await fs.open(file).catch(() => null);
    if (!fh) { logs.delete(file); return []; }
    let buf;
    try {
      buf = Buffer.alloc(Math.max(0, st.size - from));
      buf = buf.subarray(0, (await fh.read(buf, 0, buf.length, from)).bytesRead);
    } finally { await fh.close(); }
    if (kept && !buf.subarray(0, kept.tail.length).equals(kept.tail)) { kept = null; continue; }
    const start = kept ? kept.tail.length : 0;
    const lastNewline = buf.lastIndexOf(10);
    let parsed;
    try { parsed = lastNewline >= start ? parseLines(buf.subarray(start, lastNewline + 1).toString('utf8')) : []; } catch { logs.delete(file); return []; }
    let open = [];
    try { open = parseLines(buf.subarray(lastNewline + 1).toString('utf8')); } catch {}
    const tailFrom = lastNewline > 0 ? buf.lastIndexOf(10, lastNewline - 1) + 1 : 0;
    const next = {
      ino: st.ino, size: from + buf.length, mtimeMs: st.mtimeMs, end: from + lastNewline + 1,
      tail: lastNewline >= 0 ? Buffer.from(buf.subarray(tailFrom, lastNewline + 1)) : Buffer.alloc(0),
      lines: kept ? kept.lines.concat(parsed) : parsed, open,
    };
    logs.set(file, next);
    return [...next.lines, ...next.open];
  }
}

// docs/adr/2026-11-16-0312-a-store-write-tells-its-board-server.md
// The board servers running in this process, by site: startServer's changed(file), which a write in their folders calls
// directly. → a function that stops it
const servers = new Map();
export function tellOnWrite(site, changed) {
  servers.set(path.resolve(site), changed);
  return () => servers.delete(path.resolve(site));
}
const inside = (dir, file) => file === dir || file.startsWith(dir + path.sep);
// After each write, each board whose data/ or item file's folder holds file is told: one served in this process through
// its changed(file), any other by a POST of {file} to /_claude/changed on its port in the hub's manifest, not waited on.
// A board server in this process is told of a write to its data/ before the write returns, so a read the writer makes
// next builds the board with it. A board whose server isn't up reads the write as it starts, or its minute pass signals
// it (signalMissedWrites).
export function wrote(file) {
  file = path.resolve(file);
  const ports = new Map(Object.values(readManifest().sites || {}).filter(isBoardSite).map((s) => [path.resolve(s.dir), s.port]));
  for (const site of new Set([...servers.keys(), ...ports.keys()])) {
    const tell = () => {
      if (servers.has(site)) return servers.get(site)(file);
      if (!ports.get(site)) return;
      return fetch(`http://127.0.0.1:${ports.get(site)}/_claude/changed`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file }), signal: AbortSignal.timeout(10000),
      }).then((r) => r.body?.cancel(), () => {});
    };
    if (inside(path.join(site, 'data'), file)) tell();
    else itemSources(site).then((sources) => { if (sources.some((s) => inside(path.resolve(s.dir), file))) tell(); }, () => {});
  }
}

// text replaces file by a rename of a tmp file named for this write alone, so two writes of one file at once each
// rename their own. told false: a file no board shows (a cache of what the board just read, a server pass's own marker),
// so telling would only build the board again for nothing. mode: the file's mode.
export async function replace(file, text, { told = true, mode } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tmp, text, mode === undefined ? undefined : { mode });
  await fs.rename(tmp, file);
  if (told) wrote(file);
}
export async function remove(file, { told = true } = {}) {
  await fs.rm(file, { force: true });
  if (told) wrote(file);
}
const jsonText = (value) => JSON.stringify(value, null, 2) + '\n';
// value replaces file. One read through readJSON, or passed as from when value was made from such a read, is written
// under the file's lock, merged with whatever was written to the file since that read (merge3), so concurrent
// processes' changes to different parts of one file all survive.
export function writeJSON(file, value, { from = value, told = true } = {}) {
  const readAs = from?.[READ_AS];
  const { [READ_AS]: _, ...mine } = value ?? {};
  if (readAs === undefined) return replace(file, jsonText(value), { told });
  return withFileLock(file, async () => {
    const base = JSON.parse(readAs);
    const current = JSON.parse(await fs.readFile(file, 'utf8').catch(() => readAs));
    await replace(file, jsonText(merge3(base, mine, current)), { told });
  });
}
// One locked read, edit and write of a JSON object file ({} when there is none): edit changes the object it is given, the
// lock held from the read to the rename, so no other write of the file comes between. → edit's answer
export function editJSON(file, edit, { told = true } = {}) {
  return withFileLock(file, async () => {
    const value = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'));
    const out = await edit(value);
    await replace(file, jsonText(value), { told });
    return out;
  });
}
export async function appendLine(file, value, { told = true } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(value) + '\n');
  if (told) wrote(file);
}

// The board's event log, which its orchestrator's watcher reads: every process appends to it here, with one id scheme,
// e, the time in base 36, then five random base-36 characters.
export const eventsFile = (site) => path.join(site, 'data', 'events.jsonl');
export const eventId = (at = new Date()) => 'e' + at.getTime().toString(36) + Array.from(crypto.randomBytes(5), (b) => (b % 36).toString(36)).join('');
// [[kind, data, id?]] → their ids, every line in one append at `at`, which tells the board as each write does.
export async function appendEvents(site, list, at = new Date()) {
  const file = eventsFile(site);
  const lines = list.map(([kind, data, id = eventId(at)]) => ({ id, ts: at.toISOString(), kind, data }));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, lines.map((e) => JSON.stringify(e) + '\n').join(''));
  wrote(file);
  return lines.map((e) => e.id);
}
export const appendEvent = async (site, kind, data, at) => (await appendEvents(site, [[kind, data]], at))[0];
