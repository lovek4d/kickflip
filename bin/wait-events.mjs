#!/usr/bin/env node
// Waits for the next viewer event on a site, then exits so the owning Claude
// session wakes up. Run it as a background task; relaunch it after handling.
//   wait-events.mjs <route> <session-id>
// Watches the files in the site's manifest `watch` list (relative to its dir),
// counting lines that match `filter` (a regex; every line when unset).
// Prints and exits on:
//   event <file> <line>       new matching lines (several, batched for 2 s), then on a board:
//   rule hub <text>           each hub rule (settings.json `rules`), then
//   rule board <text>         each of the board's own (board.json `rules`): the owner's standing instructions,
//                             printed with every wake (docs/adr/0039-rules-live-on-settings-at-hub-and-board-level.md), then
//   setting <name> on|off     each board setting from board.json, such as auto-merge, absent ones off
//                             (docs/adr/0052-auto-merge-is-a-board-setting-off-by-default.md), then
//   usage paused <iso> <window> <used>%  while Claude is paused, after rules/settings; hub work events wait for reset
//   link <name> <detail>      each hub link that doesn't reach the board (../hub/boards.mjs linksOf), the list its
//                             Hub links sheet shows (docs/adr/0040-one-board-registry-for-every-hub-feature.md), at
//                             once, while the sheet still reads it settling
//                             (docs/adr/0046-hub-links-turn-red-only-after-a-grace-period.md); and `link hub
//                             <detail>` while the hub runs older code than its files (../hub/boards.mjs hubLink)
//   handed-over <owner json>  another session took the route over: stop, don't relaunch
//   site-removed              the route left the manifest: stop, don't relaunch
// On start it writes <site dir>/data/watcher.json {pid, since}, and adds exited_at when it exits; a board reads it
// to say whether a watcher runs (docs/adr/0021-the-board-shows-github-checks-and-watcher-health.md).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { routeRecord } from '../hub/routes.mjs';
import { readHubRules, rulesOf, ruleLines } from '../hub/rules.mjs';
import { boardAt, linksOf, hubLink } from '../hub/boards.mjs';
import { settingsLines, settingsOf } from '../board/store.mjs';
import { migrateOnStart } from './install.mjs';
import { readUsageGate, heldUsageEvent } from '../shared/usage-gate.mjs';

const [route, session] = process.argv.slice(2);
if (!route || !session) { console.error('usage: wait-events.mjs <route> <session-id>'); process.exit(2); }
migrateOnStart();
const MANIFEST = path.join(os.homedir(), '.claude', 'kickflip', 'manifest.json');

function site() {
  try { return routeRecord(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).sites, route) || null; } catch { return undefined; }
}
function matching(s) {
  const re = s.filter ? new RegExp(s.filter) : null;
  const res = Object.create(null);
  for (const f of s.watch || ['data/events.jsonl']) {
    let lines = [];
    try { lines = fs.readFileSync(path.resolve(s.dir, f), 'utf8').split('\n').filter(Boolean); } catch {}
    res[f] = re ? lines.filter((l) => re.test(l)) : lines;
  }
  return res;
}

const s0 = site();
if (!s0) { console.log('site-removed'); process.exit(0); }
// The cursor carries the counts across relaunches, so a line written while no watcher
// ran is still reported. Without it, the first run starts from the current counts.
const cursorFile = path.resolve(s0.dir, 'data', `.watch-cursor-${session}.json`);
const watcherFile = path.resolve(s0.dir, 'data', 'watcher.json');
try {
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(watcherFile, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
} catch {}
// A newer watcher may already own the file, so only this watcher's record gets its exit time.
process.on('exit', () => {
  try {
    const w = JSON.parse(fs.readFileSync(watcherFile, 'utf8'));
    if (w.pid === process.pid) fs.writeFileSync(watcherFile, JSON.stringify({ ...w, exited_at: new Date().toISOString() }));
  } catch {}
});
let base;
try { base = JSON.parse(fs.readFileSync(cursorFile, 'utf8')); } catch {}
if (!base) {
  base = Object.fromEntries(Object.entries(matching(s0)).map(([f, l]) => [f, l.length]));
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, JSON.stringify(base));
}

for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = site();
  if (s === undefined) continue;
  if (s === null) { console.log('site-removed'); process.exit(0); }
  if (s.owner?.session && s.owner.session !== session) { console.log('handed-over ' + JSON.stringify(s.owner)); process.exit(0); }
  const pending = (seen) => Object.fromEntries(Object.entries(seen).map(([f, lines]) => [f, [...(routeRecord(base.$usageHeld, f) || []), ...lines.slice(routeRecord(base, f) || 0)]]));
  const eligible = (line, gate) => gate.state !== 'paused' || !heldUsageEvent(line);
  const currentGate = readUsageGate();
  if (Object.values(pending(matching(s))).some((lines) => lines.some((line) => eligible(line, currentGate)))) {
    await new Promise((r) => setTimeout(r, 2000));
    const seen = matching(s);
    const gate = readUsageGate();
    const waiting = pending(seen);
    if (!Object.values(waiting).some((lines) => lines.some((line) => eligible(line, gate)))) continue;
    const held = Object.create(null);
    for (const [f, lines] of Object.entries(waiting)) {
      held[f] = lines.filter((line) => !eligible(line, gate));
      for (const line of lines.filter((line) => eligible(line, gate))) console.log(`event ${f} ${line}`);
    }
    // A board is a site with a board.json; other sites get no rules.
    let board = null;
    try { board = JSON.parse(fs.readFileSync(path.resolve(s.dir, 'board.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') board = {}; }
    if (board) for (const line of ruleLines(readHubRules(), rulesOf(board))) console.log(`rule ${line}`);
    if (board) for (const line of settingsLines(settingsOf(board))) console.log(line);
    if (gate.state === 'paused') console.log(`usage paused ${gate.resets_at} ${gate.window} ${gate.used}%`);
    // This watcher still runs, so the events link reads as reaching the board. A failure here must not keep the
    // cursor below from moving, or the same events would wake the session again.
    try {
      const self = board && boardAt(s.dir);
      if (self) for (const l of [...linksOf(self, { listen: 'listening' }), hubLink()]) if (!l.ok) console.log(`link ${l.link} ${l.detail}`);
    } catch (e) { console.log(`link registry could not check the links (${e.message})`); }
    const next = Object.fromEntries(Object.entries(seen).map(([f, l]) => [f, l.length]));
    if (Object.values(held).some((lines) => lines.length)) next.$usageHeld = held;
    fs.writeFileSync(cursorFile, JSON.stringify(next));
    process.exit(0);
  }
}
