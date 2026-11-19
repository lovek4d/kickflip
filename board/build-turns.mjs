// docs/adr/2026-11-19-0602-one-hub-wide-build-cap-boards-take-turns.md
// The hub's build slots, one count for every board on the host: Hub settings' Maximum tasks in progress
// (hub-settings.mjs readTasksInProgress). Each board server writes its entry in ~/.claude/kickflip/builds/, a file per
// board, {site, pid, held, wants, granted}: held its cards holding a slot (domain.mjs pullOf held), wants its pullable
// cards in its own order, each {key, first} with first its bump's time or null, and granted the cards another board's
// pass handed it, which it takes on its next pass. builds/turn.json {last} names the board the last turn went to. A
// board whose server is gone counts for nothing.
import fs from 'node:fs';
import path from 'node:path';
import { withFileLock } from '../hub/locks.mjs';

const buildsDir = (home) => path.join(home, '.claude', 'kickflip', 'builds');
const turnFile = (home) => path.join(buildsDir(home), 'turn.json');
const entryFile = (home, site) => path.join(buildsDir(home), `${encodeURIComponent(site)}.json`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readJSON = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeJSON = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
};

// The live boards' entries, every board but site's when site is given.
function liveBoards(home, site = null) {
  let names = [];
  try { names = fs.readdirSync(buildsDir(home)).filter((n) => n.endsWith('.json') && n !== 'turn.json'); } catch {}
  return names.map((n) => readJSON(path.join(buildsDir(home), n)))
    .filter((b) => b && Number.isInteger(b.pid) && alive(b.pid) && b.site !== site);
}
const counted = (b) => b.held + b.granted.length;

// boards [{site, held, wants, granted}], cap the hub's number of slots, last the board the last turn went to.
// The free slots, the cap less every board's held and granted ones, go first to the bumped cards, the earliest bump
// first whichever board it is on, then round the boards in order of site from the one after last, one card each per
// turn, a board with nothing wanted giving its turn up. A bump moves no turn.
// → {grants: Map site → keys granted now, last: the board the last turn went to}
export function turnsOf(boards, { cap, last = null }) {
  let free = cap - boards.reduce((n, b) => n + counted(b), 0);
  const grants = new Map(boards.map((b) => [b.site, []]));
  const left = new Map(boards.map((b) => [b.site, b.wants.filter((w) => !b.granted.includes(w.key))]));
  const give = (site, key) => {
    grants.get(site).push(key);
    left.set(site, left.get(site).filter((w) => w.key !== key));
    free--;
  };
  const bumped = boards.flatMap((b) => left.get(b.site).filter((w) => w.first).map((w) => ({ site: b.site, ...w })))
    .sort((a, b) => a.first.localeCompare(b.first));
  for (const w of bumped) if (free > 0) give(w.site, w.key);
  const sites = boards.map((b) => b.site).sort();
  const order = last === null ? sites : [...sites.filter((s) => s > last), ...sites.filter((s) => s <= last)];
  while (free > 0 && order.some((s) => left.get(s).length)) {
    for (const site of order) {
      if (free > 0 && left.get(site).length) { give(site, left.get(site)[0].key); last = site; }
    }
  }
  return { grants, last };
}

// One board's pass at the hub's slots, under the builds lock: the board at site, held holding that many slots and
// wanting wants, takes the cards granted it that it still wants, then the turns' share that falls to it now, and
// grants the other boards theirs (turnsOf). → {take: the keys this board starts now}
export async function claimBuilds({ home, site, held, wants, cap }) {
  fs.mkdirSync(buildsDir(home), { recursive: true });
  return withFileLock(turnFile(home), () => {
    const others = liveBoards(home, site);
    const carried = (readJSON(entryFile(home, site))?.granted || []).filter((k) => wants.some((w) => w.key === k));
    const me = { site, pid: process.pid, held: held + carried.length, wants: wants.filter((w) => !carried.includes(w.key)), granted: [] };
    const { grants, last } = turnsOf([...others, me], { cap, last: readJSON(turnFile(home))?.last ?? null });
    const take = [...carried, ...grants.get(site)];
    writeJSON(entryFile(home, site), { ...me, held: held + take.length, wants: wants.filter((w) => !take.includes(w.key)) });
    for (const b of others) {
      if (grants.get(b.site).length) writeJSON(entryFile(home, b.site), { ...b, granted: [...b.granted, ...grants.get(b.site)] });
    }
    writeJSON(turnFile(home), { last });
    return { take };
  });
}

// The slots every other live board holds or has been granted, for a pass that decides by the hub's free count.
export const othersHeld = ({ home, site }) => liveBoards(home, site).reduce((n, b) => n + counted(b), 0);

// Whether the board at site has cards granted it to take.
const hasGrants = ({ home, site }) => Boolean(readJSON(entryFile(home, site))?.granted?.length);

// Whether the board at site has a pass at the turns due with the hub's number at cap: a card granted it, or a card
// it wants while the boards hold fewer than cap, as after the owner raises the number.
export function turnDue({ home, site, cap }) {
  const mine = readJSON(entryFile(home, site));
  if (!mine) return false;
  return mine.granted.length > 0 || (mine.wants.length > 0 && othersHeld({ home, site }) + counted(mine) < cap);
}

// A closing board's entry leaves, so it holds no slot and gets no turn.
export const leaveTurns = ({ home, site }) => fs.rmSync(entryFile(home, site), { force: true });

// fn() each time another board's pass grants the board at site a card. → stops watching
export function watchGrants({ home, site }, fn) {
  fs.mkdirSync(buildsDir(home), { recursive: true });
  const name = path.basename(entryFile(home, site));
  const watcher = fs.watch(buildsDir(home), (_, file) => { if (file === name && hasGrants({ home, site })) fn(); });
  watcher.on('error', () => {});
  return () => watcher.close();
}
