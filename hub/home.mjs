// The site list every board's sidebar shows, and what `/` opens (docs/adr/0050-a-sidebar-of-every-board-replaces-the-hub-home.md):
// each site's status word and lane chips (docs/adr/0037-the-hub-home-shows-status-not-descriptions.md), the hub's
// health, and the board a first visit opens.
import { siteIcon } from './icons.mjs';

const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

// One site's GET /_claude/needs body as the hub keeps it, or null when it isn't the contract
// (docs/adr/0010-sites-report-what-waits-through-claude-needs.md). lanes and building are optional.
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

// The most urgent thing a site is doing, or null when it is calm. state is the hub's process state.
export function siteStatus({ state, working, count: waiting, building } = {}) {
  if (state === 'down') return { tone: 'down', word: 'Down' };
  if (state === 'starting') return { tone: 'starting', word: 'Starting' };
  if (state === 'stopped') return { tone: 'starting', word: 'Stopped' };
  if (working) return { tone: 'working', word: 'Working' };
  if (waiting) return { tone: 'needs', word: `${waiting} need you` };
  if (building) return { tone: 'building', word: 'Building' };
  return null;
}

// null when the site reports no lanes; [] when every lane is empty.
export function laneChips(lanes) {
  if (!lanes) return null;
  return [['review', 'review'], ['progress', 'doing'], ['todo', 'todo']]
    .filter(([k]) => lanes[k] > 0).map(([lane, word]) => ({ lane, text: `${lanes[lane]} ${word}` }));
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The row's sub line HTML, or '' when there is nothing to say. needs is readNeeds' result or null. Its classes are
// styled by board/public/sidebar.css.
export function statusLine(state, needs) {
  const s = siteStatus({ state, ...needs });
  const chips = state === 'up' ? laneChips(needs?.lanes) : null;
  const word = s ? `<span class="dot t-${s.tone}${s.tone === 'working' ? ' pulse' : ''}" aria-hidden="true"></span><span class="word t-${s.tone}">${esc(s.word)}</span>` : '';
  const lanes = chips === null ? '' : chips.length ? chips.map((c) => `<span class="lc lc-${c.lane}">${esc(c.text)}</span>`).join('') : '<span>nothing open</span>';
  return word || lanes ? `${word}${lanes ? `<span class="lcs">${lanes}</span>` : ''}` : '';
}

// The sidebar's site rows, from hub.mjs status() rows, each site's readNeeds answer (a Map by route) and the set of
// routes that are boards. icon and sub are HTML that board/public/ui-sidebar.js places as given.
export function sidebarSites(rows, waiting, boards) {
  return rows.map((r) => {
    const needs = waiting.get(r.route) ?? null;
    return {
      route: r.route, title: r.title, board: boards.has(r.route), state: r.state, count: needs?.count || 0,
      changedAt: r.changedAt || 0, icon: siteIcon(r.route, r), sub: statusLine(r.state, needs),
    };
  });
}

// The board a device opens at `/` when it has no last board: the one with the most waiting on the owner, the most
// recently changed among equals; null with no board, since `/` opens only a board.
export function startRoute(sites) {
  return sites.filter((s) => s.board).sort((a, b) => b.count - a.count || b.changedAt - a.changedAt || a.route.localeCompare(b.route))[0]?.route ?? null;
}

// The hub's health from the sites' process states and each board's linksOf states ({<route>: [{link, state}]}): a site
// is broken while it is down or one of its links reads broken; a link still settling doesn't count
// (docs/adr/0046-hub-links-turn-red-only-after-a-grace-period.md).
export function hubHealth(sites, linksByRoute = {}) {
  const broken = sites.filter((s) => s.state === 'down' || (linksByRoute[s.route] || []).some((l) => l.state === 'broken'));
  const up = sites.filter((s) => s.state === 'up').length;
  return {
    tone: broken.length ? 'down' : 'ok',
    word: broken.length ? `${broken.length} broken` : 'Healthy',
    detail: `${up} of ${sites.length} site${sites.length === 1 ? '' : 's'} up`,
    broken: broken.map((s) => s.route),
  };
}
