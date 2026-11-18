// The site list every board's sidebar shows, and what `/` opens (docs/adr/2026-10-29-1639-a-sidebar-of-every-board-replaces-the-hub-home.md):
// each site's status word and lane chips (docs/adr/2026-10-29-1639-the-hub-home-shows-status-not-descriptions.md), the hub's
// health, and the board a first visit opens.
import { siteIcon } from './icons.mjs';
import { contextFull } from './usage.mjs';

const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

// One site's GET /_claude/needs body as the hub keeps it, or null when it isn't the contract
// (docs/adr/2026-10-29-1639-sites-report-what-waits-through-claude-needs.md). lanes and building are optional.
export function readNeeds(body) {
  const { items, working, summary, lanes, building } = body || {};
  if (!Array.isArray(items)) return null;
  const kinds = [...new Set(items.map((i) => String(i?.kind || '').trim()).filter(Boolean))];
  const laneOk = lanes && typeof lanes === 'object' && ['review', 'progress', 'todo'].every((k) => lanes[k] === undefined || (Number.isInteger(lanes[k]) && lanes[k] >= 0));
  return {
    count: items.length,
    working: count(working),
    summary: typeof summary === 'string' && summary.trim() ? summary.trim() : items.length ? `${items.length} waiting${kinds.length ? `: ${kinds.join(', ')}` : ''}` : '',
    lanes: laneOk ? { review: count(lanes.review), progress: count(lanes.progress), todo: count(lanes.todo) } : null,
    building: building === true,
  };
}

// The most urgent thing a site is doing (what waits on the owner is a red chip first in the lane chips, see statusLine), or null when it is calm. state is the hub's process state; listen is a board's
// boards.mjs listenState, or 'full' for a deaf board whose context is full (usage.mjs contextFull), and undefined for a
// site that isn't a board. lessons is a course page's lesson count (new-course.mjs courseLessons), which reads green
// once there is one.
// → {shape, colour, word}, the shape and colour from board/public/ui-icon-text.js's enums, which draws them.
export function siteStatus({ state, working, building, listen, lessons } = {}) {
  const fault = (word) => ({ shape: 'dot', colour: 'red', word });
  if (state === 'down') return fault('down');
  if (listen === 'logged-out') return fault('logged out: run /login');
  if (listen === 'full') return fault('context full');
  if (listen === 'deaf') return fault('not listening');
  if (state === 'starting') return { shape: 'dot', colour: 'orange', word: 'starting' };
  if (state === 'stopped') return { shape: 'dot', colour: 'grey', word: 'stopped' };
  if (working) return { shape: 'pulse', colour: 'orange', word: 'working' };
  if (listen === 'waking') return { shape: 'dot', colour: 'grey', word: 'waking…' };
  if (listen === 'asleep') return { shape: 'dot', colour: 'grey', word: 'asleep' };
  if (building) return { shape: 'dot', colour: 'orange', word: 'implementing' };
  if (lessons) return { shape: 'dot', colour: 'green', word: `${lessons} lesson${lessons === 1 ? '' : 's'}` };
  return null;
}

// null when the site reports no lanes; [] when every lane is empty.
export function laneChips(lanes) {
  if (!lanes) return null;
  return [['review', 'review'], ['progress', 'doing'], ['todo', 'todo']]
    .filter(([k]) => lanes[k] > 0).map(([lane, word]) => ({ lane, text: `${lanes[lane]} ${word}` }));
}

// The row's sub line as data, which board/public/ui-sidebar.js draws: {status: siteStatus' answer or null, stale, chips},
// chips null when the site reports no lanes and [] when it has nothing open; null when there is nothing to say. needs is
// readNeeds' result or null; listen and lessons as siteStatus takes them.
export function statusLine(state, needs, listen, lessons) {
  const status = siteStatus({ state, ...needs, listen, lessons });
  const lane = state === 'up' ? laneChips(needs?.lanes) : null;
  const chips = needs?.count ? [{ lane: 'needs', text: `${needs.count} need you` }, ...(lane || [])] : lane;
  if (!status && chips === null) return null;
  return { status, stale: needs?.stale === true, chips };
}

export const NEEDS_STALE_MS = 15_000;
// A board's needs read against its last good answer: a failed read (null) keeps the last good one, marked stale from
// NEEDS_STALE_MS after that good read. → {good: {at, needs} or null, needs: what the row shows}
export function holdNeeds(good, read, readAt, now) {
  if (read) return { good: { at: readAt, needs: read }, needs: read };
  if (!good) return { good: null, needs: null };
  return { good, needs: now - good.at >= NEEDS_STALE_MS ? { ...good.needs, stale: true } : good.needs };
}

// The sidebar's site rows, from hub.mjs status() rows, each site's readNeeds answer (a Map by route), the set of
// routes that are boards and each board's boards.mjs listenState (a Map by route). icon is HTML that board/public/ui-sidebar.js
// places as given, and sub is statusLine's data, which it draws. created is when the site joined the hub, null when the manifest has no time, which ui-sidebar.js
// switchKeys orders by. ctx is the board's owner session's context reading {percent, at} (usage.mjs), else null.
export function sidebarSites(rows, waiting, boards, listens = new Map(), contexts = new Map()) {
  return rows.map((r) => {
    const needs = waiting.get(r.route) ?? null;
    const listen = boards.has(r.route) ? listens.get(r.route) ?? 'listening' : undefined;
    const reading = contexts.get(r.route) ?? null;
    const ctx = reading && { ...reading, full: reading.percent >= CTX_FULL_PERCENT };
    const heard = contextFull(listen, ctx) ? 'full' : listen;
    return {
      route: r.route, title: r.title, board: boards.has(r.route), state: r.state, count: needs?.count || 0,
      changedAt: r.changedAt || 0, created: r.created || null, icon: siteIcon(r.route, r), sub: statusLine(r.state, needs, heard, r.lessons), listen: heard, ctx,    };
  });
}

// A board's context reads red (full) from this percent; the sidebar draws the ctx.full flag.
export const CTX_FULL_PERCENT = 90;
// The Hub row reads busy once the host has been busy this long and no usage pause reads first; busy past BUSY_BANNER_MS
// adds the banner at the sidebar's top.
export const BUSY_MS = 60_000;
export const BUSY_BANNER_MS = 30 * 60_000;

// The usage gate as the sidebar carries it: machine gains busy and banner, from the host's busy-since and the clock here.
export function sidebarPause(gate, now) {
  const age = gate.machine.state === 'busy' ? now - Date.parse(gate.machine.since) : 0;
  const busy = age >= BUSY_MS && gate.state !== 'paused';
  return { ...gate, machine: { ...gate.machine, busy, banner: busy && age > BUSY_BANNER_MS } };
}

// A board row under the hub's pause or its own (boardGate, the board's usage gate, else null) reads grey paused,
// unless its status is red: a fault keeps its word (AGENTS.md colour order). The row carries that gate as pause.
export function heldSite(site, hubPaused, boardGate) {
  const held = site.board && (hubPaused || boardGate?.state === 'paused') && site.sub?.status?.colour !== 'red';
  const out = boardGate ? { ...site, pause: boardGate } : site;
  return held ? { ...out, sub: { stale: false, chips: null, ...site.sub, status: { shape: 'dot', colour: 'grey', word: 'paused' } } } : out;
}

// The board a device opens at `/` when it has no last board: the one with the most waiting on the owner, the most
// recently changed among equals; null with no board, since `/` opens only a board.
export function startRoute(sites) {
  return sites.filter((s) => s.board).sort((a, b) => b.count - a.count || b.changedAt - a.changedAt || a.route.localeCompare(b.route))[0]?.route ?? null;
}

// The hub's health from the sites' process states and each board's linksOf states (a Map by route)
// (docs/adr/2026-11-03-0501-the-hub-reads-healthy-degraded-or-a-site-down.md): red only while a site is down, amber degraded
// while a board link reads broken, else healthy, which reads alone. A link still settling doesn't count
// (docs/adr/2026-10-29-1639-hub-links-turn-red-only-after-a-grace-period.md). The hub running older code is no health state: the
// New hub version banner is its only sign (docs/adr/2026-11-16-0600-older-code-reads-only-as-the-new-server-version-banner.md).
export function hubHealth(sites, linksByRoute = new Map()) {
  const down = sites.filter((s) => s.state === 'down').length;
  const failing = sites.reduce((n, s) => n + (linksByRoute.get(s.route) || []).filter((l) => l.state === 'broken').length, 0);
  const up = sites.filter((s) => s.state === 'up').length;
  return {
    tone: down ? 'down' : failing ? 'wait' : 'ok',
    word: down ? `${down} site${down === 1 ? '' : 's'} down` : failing ? 'degraded' : 'healthy',
    detail: down || failing ? `${up} of ${sites.length} site${sites.length === 1 ? '' : 's'} up${failing ? ` · ${failing} link${failing === 1 ? '' : 's'} failing` : ''}` : '',
  };
}
