// A board's site as the hub serves it: its folder's board files and a free port. `kickflip join` makes them for a board
// it adds, and the hub for a New board as soon as its clone is ready, so the board opens empty while its orchestrator
// starts and the join takes the same site over (docs/adr/2026-11-17-0254-a-new-board-opens-empty-while-its-orchestrator-starts.md).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { kickflipHas, repoHas, onboardingItems } from '../board/onboarding.mjs';
import { storedPath, nodeBin } from '../bin/install.mjs';
import { cloneRoot } from '../shared/repos.mjs';

const FIRST_SITE_PORT = 4600;

// Whether something answers on the port.
export function connects(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(500, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}
function bindable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve(true)));
  });
}

// The first port from FIRST_SITE_PORT that no site, closed board or starting board's site of manifest m holds and
// nothing answers on. Throws when none is free.
export async function freePort(m) {
  const sites = [...Object.values(m.sites || {}), ...Object.values(m.closed || {}).map((c) => c.site), ...Object.values(m.starting || {}).map((s) => s.site)];
  const taken = new Set(sites.map((s) => s?.port));
  for (let p = FIRST_SITE_PORT; p < FIRST_SITE_PORT + 400; p++) {
    if (taken.has(p)) continue;
    if (!(await connects(p)) && (await bindable(p))) return p;
  }
  throw new Error('no free port found from ' + FIRST_SITE_PORT);
}

// The board template's files in dir: board.json with its title, items ("waves" or an item file, made when
// missing with the onboarding cards, board/onboarding.mjs) and, when given, tickets. repo and ref are where main's
// build and release scripts, CONTEXT.md and ADRs are looked for; dir's scripts/ holds the board's own in kickflip.
// → the board server's cmd for dir
export function boardFiles(dir, { title, items, tickets, repo, ref }) {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfgFile = path.join(dir, 'board.json');
  const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
  cfg.title = title;
  cfg.items = storedPath(items || cfg.items || 'waves');
  if (tickets) cfg.tickets = tickets;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  const itemsFile = cfg.items === 'waves' ? null : path.resolve(dir, cfg.items);
  if (itemsFile && !fs.existsSync(itemsFile)) {
    fs.mkdirSync(path.dirname(itemsFile), { recursive: true });
    const cards = onboardingItems(itemsFile, { has: { ...repoHas(repo, ref), kickflip: kickflipHas(dir) } });
    fs.writeFileSync(itemsFile, JSON.stringify({ title: cfg.title, items: cards }, null, 2) + '\n');
  }
  return [nodeBin(), path.join(cloneRoot(), 'board', 'server.mjs'), dir];
}
