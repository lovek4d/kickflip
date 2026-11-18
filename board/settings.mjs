// A board's settings: board.json's settings, pause, description and reviewers, its rules, the setup handshake,
// and the board's own entry in the hub's manifest (boardTarget, boardRepoOf). Written through files.mjs
// (docs/adr/2026-11-17-1137-cards-questions-asks-and-settings-leave-store-mjs.md).
import path from 'node:path';
import { MAX_IMPLEMENTERS, MAX_SERVES } from './domain.mjs';
import { appendEvent, listBoards, readManifest, samePath, withManifestLock, writeManifest } from '../hub/boards.mjs';
import { pauseEnd } from '../shared/usage-gate.mjs';
import { readLandTests, setLandTests, CLAUDE_MODEL_VALUES, settingsFile as hubSettingsFile } from '../shared/hub-settings.mjs';
import { ticketSource } from './tickets.mjs';
import { LINEAR_NEEDS_KEY, linearStatus, linearWorks } from '../hub/linear.mjs';
import { itemSources, readJSON, readLog, writeJSON } from './files.mjs';
import { followScriptsHome, readPermissions } from './permissions.mjs';
import { kickflipHeld, validBuildTarget } from './build-script.mjs';
import { RuleError, rulesOf, addRule, editRule, removeRule, applyRules, readHubRules, writeHubRules } from '../hub/rules.mjs';
import { BoardError, fail, needSite, text, bool, domId, onlyKeys } from './checks.mjs';
import { loadItem, openKeys } from './cards.mjs';

// The join handshake (docs/adr/2026-10-29-1639-one-board-registry-for-every-hub-feature.md): data/handshake.json
// {ping: {id, at, session}, ack: {id, at} | null, done_at?}, written by hub/boards.mjs handshake.
// A file an older board wrote keeps its ping under `hello`, which reads as the ping.
// The board shows its setup checklist until the session acks the newest ping and the hub's GitHub check reaches it.
const handshakeFile = (site) => path.join(site, 'data', 'handshake.json');
export async function readHandshake(site) {
  const h = await readJSON(handshakeFile(site), null);
  if (!h?.hello) return h;
  const { hello, ...rest } = h;
  return { ...rest, ping: rest.ping || hello };
}

export async function ackPing(site, eventId) {
  needSite(site);
  domId(eventId, 'the event id');
  const event = (await readLog(path.join(site, 'data', 'events.jsonl'))).find((e) => e.id === eventId);
  if (event?.kind !== 'ping' && event?.kind !== 'hello') fail(`no ping event "${eventId}" in this site's data/events.jsonl`);
  const h = (await readHandshake(site)) || {};
  if (h.ping?.id && h.ping.id !== eventId) fail(`"${eventId}" is an older ping; ack the newest, "${h.ping.id}"`);
  await writeJSON(handshakeFile(site), { ...h, ping: h.ping || { id: eventId, at: event.ts, session: null }, ack: { id: eventId, at: new Date().toISOString() } });
  return handshakeFile(site);
}

// The board server marks the checklist done once both pass, so a later broken link shows on the Hub links dot, not as setup.
export async function finishHandshake(site) {
  const h = await readHandshake(site);
  if (h && !h.done_at) await writeJSON(handshakeFile(site), { ...h, done_at: new Date().toISOString() });
}

// Board and item file reviewers share {name, slack_user, dm, github}.
const REVIEWER_FIELDS = { name: /^[^\n]{1,40}$/, slack_user: /^U[A-Z0-9]+$/, dm: /^D[A-Z0-9]+$/, github: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/ };
export const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
function checkReviewers(list, name) {
  if (!Array.isArray(list)) fail(`${name} must be a JSON array of reviewers`);
  list.forEach((r, i) => {
    const at = `${name}[${i}]`;
    onlyKeys(r, Object.keys(REVIEWER_FIELDS), at);
    for (const [k, re] of Object.entries(REVIEWER_FIELDS)) if (typeof r[k] !== 'string' || !re.test(r[k].trim())) fail(`${at}.${k} must match ${re}`);
    if (list.slice(0, i).some((o) => sameName(o.name, r.name))) fail(`${name} names "${r.name}" twice`);
  });
  return list.map((r) => Object.fromEntries(Object.keys(REVIEWER_FIELDS).map((k) => [k, r[k].trim()])));
}

// The board's list, also written to each item file with an unfinished card, so its open PRs reach the same people.
async function writeReviewers(site, change) {
  const { file, reviewers } = await writeBoardJSON(site, (cfg) => {
    const reviewers = checkReviewers(change(cfg.reviewers || []), 'the reviewers');
    return { set: { reviewers }, reviewers };
  });
  const lines = [];
  const open = await openKeys(site);
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, null);
    if (!(itemFile?.items || []).some((it) => open.has(`${source.slug}/${it.id}`))) continue;
    await writeJSON(source.file, { ...itemFile, reviewers });
    lines.push(`item file ${source.slug}: reviewers copied`);
  }
  return { file, lines };
}

export const setReviewers = (site, list) => writeReviewers(site, () => checkReviewers(list, 'the reviewer file'));

// One reviewer or an array; each replaces the board's reviewer of the same name, ignoring case, or is added.
export function addReviewers(site, input) {
  const added = checkReviewers(Array.isArray(input) ? input : [input], 'the reviewer file');
  return writeReviewers(site, (list) => [...list.map((r) => added.find((a) => sameName(a.name, r.name)) || r), ...added.filter((a) => !list.some((r) => sameName(a.name, r.name)))]);
}

export function removeReviewers(site, names) {
  return writeReviewers(site, (list) => {
    const unknown = names.filter((n) => !list.some((r) => sameName(r.name, n)));
    if (unknown.length) fail(`this board has no reviewer ${unknown.map((n) => `"${n}"`).join(', ')}`);
    return list.filter((r) => !names.some((n) => sameName(r.name, n)));
  });
}

// Rules: the hub's in settings.json and this board's in board.json `rules` (../hub/rules.mjs;
// docs/adr/2026-10-29-1639-rules-live-on-settings-at-hub-and-board-level.md). The settings page and the CLI both write board.json,
// so board rule, setting and reviewer writes run one at a time.
const ruleCall = (fn) => { try { return fn(); } catch (e) { if (e instanceof RuleError) fail(e.message); throw e; } };
export const readBoardRules = async (site) => rulesOf(await readJSON(path.join(site, 'board.json'), {}));

let boardWrites = Promise.resolve();
// change(cfg) → {keys to set in board.json, ...anything else to return}
function writeBoardJSON(site, change) {
  const write = boardWrites.then(async () => {
    const file = path.join(needSite(site), 'board.json');
    const cfg = await readJSON(file, {});
    const { set, ...result } = change(cfg);
    await writeJSON(file, { ...cfg, ...set });
    return { file, ...result };
  });
  boardWrites = write.catch(() => {});
  return write;
}
const writeBoardRules = (site, change) => writeBoardJSON(site, (cfg) => {
  const result = ruleCall(() => change(rulesOf(cfg)));
  return { set: { rules: result.rules }, ...result };
});

const validGithubLogin = (value) => typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
export const storedTickets = (value) => { try { return value ? ticketSource(value) : null; } catch { return null; } };
// A board's settings in board.json (docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md): auto_merge,
// auto_build, auto_review and idle_notification, off when absent, max_implementers, a
// whole number from 1 to 99 and MAX_IMPLEMENTERS when absent
// (docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md), max_serves, the same and MAX_SERVES
// when absent (docs/adr/2026-11-12-0112-a-card-serve-stays-up-while-its-worktree-does.md), skip_draft, off when
// absent (docs/adr/2026-11-04-1913-a-board-can-skip-the-draft.md), prs, on unless false, and on the hub board (board is its listBoards
// entry, `hub: true`) off unless true (opensPRs; docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md,
// docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md), tickets, its one
// ticket source, and github_login, absent when unset or invalid (docs/adr/2026-11-01-1348-a-board-has-one-ticket-source.md),
// tool_use, normal unless high (docs/adr/2026-11-14-1500-a-tool-use-setting-sets-how-readily-the-orchestrator-uses-tools.md),
// and build_target, the `.kickflip/build-<target>` the hub runs, absent for `.kickflip/build`
// (docs/adr/2026-11-05-1823-board-settings-picks-which-build-script-a-board-runs.md), and scripts, kickflip when the
// board runs its scripts from its site's scripts/, absent for the repo's .kickflip/
// (docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md).
const validCap = (value) => Number.isInteger(value) && value >= 1 && value <= 99;
const CAPS = ['max_implementers', 'max_serves'];
const TOOL_USE = ['normal', 'high'];
export const settingsOf = (cfg, board) => {
  const tickets = storedTickets(cfg?.tickets);
  return { auto_merge: cfg?.auto_merge === true, auto_build: cfg?.auto_build === true,
    max_implementers: validCap(cfg?.max_implementers) ? cfg.max_implementers : MAX_IMPLEMENTERS,
    max_serves: validCap(cfg?.max_serves) ? cfg.max_serves : MAX_SERVES, auto_review: cfg?.auto_review === true,
    idle_notification: cfg?.idle_notification === true, skip_draft: cfg?.skip_draft === true, prs: board?.hub ? cfg?.prs === true : cfg?.prs !== false,
    tool_use: cfg?.tool_use === 'high' ? 'high' : 'normal',
    ...(tickets ? { tickets } : {}), ...(validGithubLogin(cfg?.github_login) ? { github_login: cfg.github_login } : {}),
    ...(validBuildTarget(cfg?.build_target) ? { build_target: cfg.build_target } : {}),
    ...(kickflipHeld(cfg) ? { scripts: 'kickflip' } : {}),
    // Builders, overriding Hub settings' (usage-gate.mjs claudeModelFor); none on Hub default.
    ...(CLAUDE_MODEL_VALUES.includes(cfg?.claude_model) ? { claude_model: cfg.claude_model } : {}) };
};
// Pause board (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md): a shared/usage-gate.mjs
// pauseEnd choice, or off, saved as board.json's paused_until, which readUsageGate reads with the board's dir. It is no
// board setting: the gate, not a settings event, tells the session. → the end as an ISO time or forever, or null.
export async function setBoardPause(site, choice, now = new Date()) {
  let end;
  try { end = pauseEnd(choice, now); } catch (e) { fail(e.message); }
  await writeBoardJSON(site, () => ({ set: { paused_until: end ?? undefined } }));
  return end;
}
// max_land_tests is the hub's, not the board's: land test runs at once on the host (push.mjs readLandTests), shown in
// Board Settings beside Maximum tasks in progress and saved to the hub's settings.json for every board.
export async function readBoardSettings(site) {
  const dir = needSite(site);
  return { ...settingsOf(await readJSON(path.join(dir, 'board.json'), {}), listBoards().find((b) => samePath(b.dir, dir))), max_land_tests: readLandTests() };
}
// A board's description is the hub's, in its manifest entry, where the router reads it on each request
// (hub/router.mjs routingBoards): description, with description_source, new-board, triage or settings, and
// description_at, the ISO time it was set. → {description, source, at}; source and at are '' for a board whose
// description was set before they were stored.
export const DESCRIPTION_LIMIT = 240;
const manifestRoute = (site) => listBoards().find((b) => samePath(b.dir, needSite(site)))?.route;
export function readBoardDescription(site) {
  const entry = readManifest().sites?.[manifestRoute(site)] || {};
  return { description: String(entry.description || ''), source: entry.description_source || '', at: entry.description_at || '' };
}
// source is where the text came from: 'settings' (Board Settings) or 'triage' (an approved proposal).
export async function saveBoardDescription(site, text, source = 'settings', now = new Date()) {
  const description = String(text ?? '').trim();
  if (!description) fail('A board needs a description');
  if (description.length > DESCRIPTION_LIMIT) fail(`A description is at most ${DESCRIPTION_LIMIT} characters`);
  if (!['settings', 'triage'].includes(source)) fail('a description is set from settings or triage');
  await markDescription(site, { description, description_source: source, description_at: now.toISOString() });
  return readBoardDescription(site);
}

// docs/adr/2026-11-16-2100-overnight-triage-proposes-a-stale-board-description.md
// An overnight triage's proposal to change a board's description is the task titled descriptionProposalTitle(route).
// The manifest entry keeps description_proposal, that task's key, and description_checked_at, when a triage last judged
// the description. A proposal is open while its task isn't Done; closing the task ends it, with nothing to clear.
const DESCRIPTION_CHECK_DAYS = 7;
const descriptionProposalTitle = (route) => `chore(board): update /${route}'s description`;
async function openProposal(site, entry) {
  const key = entry.description_proposal;
  if (!key) return null;
  try { return (await loadItem(site, key)).item.lane === 'done' ? null : key; } catch (e) { if (e instanceof BoardError) return null; throw e; }
}
// → {description, source, at, checked, proposal}: checked is when a triage last judged it ('' never), proposal the open
// proposal's task key, else null.
export async function describeBoard(site) {
  const entry = readManifest().sites?.[manifestRoute(site)] || {};
  return { ...readBoardDescription(site), checked: entry.description_checked_at || '', proposal: await openProposal(site, entry) };
}
// Whether tonight's overnight triage judges the description: the board is in the hub's manifest, no proposal is open,
// and the description is empty or neither set nor checked in DESCRIPTION_CHECK_DAYS.
export async function descriptionDue(site, now = new Date()) {
  if (!manifestRoute(site)) return false;
  const { description, at, checked, proposal } = await describeBoard(site);
  if (proposal) return false;
  if (!description) return true;
  const last = Math.max(Date.parse(at) || 0, Date.parse(checked) || 0);
  return now.getTime() - last >= DESCRIPTION_CHECK_DAYS * 86400000;
}
export async function markDescription(site, fields) {
  const route = manifestRoute(site) || fail('this board isn’t in the hub’s manifest');
  await withManifestLock(async () => {
    const manifest = readManifest();
    manifest.sites[route] = { ...manifest.sites[route], ...fields };
    await writeManifest(manifest);
  });
}
// A triage that judged the description still right records when, so the next check is DESCRIPTION_CHECK_DAYS away.
export async function checkedDescription(site, now = new Date()) {
  await markDescription(site, { description_checked_at: now.toISOString() });
  return describeBoard(site);
}
// item add of a proposal's title: refused while one is open; → the board's route when the title is this board's proposal.
export async function refuseSecondProposal(site, title) {
  const route = site && manifestRoute(site);
  if (!route || String(title).trim() !== descriptionProposalTitle(route)) return null;
  const entry = readManifest().sites[route];
  const open = await openProposal(site, entry);
  if (open) fail(`/${route} already has an open description proposal, ${open}; it ends when that task closes`);
  return route;
}
// Whether cards on a board open PRs: a board on GitHub that builds from its shared clone, not its folder
// (hub/boards.mjs buildsLocally), or the hub board, which builds from its folder, with its PRs setting on (Landing is
// Draft PR or Ready PR; docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md). board is a
// listBoards entry or hub/board-repo.mjs boardRepo's answer, settings settingsOf's.
export const opensPRs = (board, settings) => Boolean(board?.github) && (!board.local || board.hub === true) && settings.prs;

// changes {auto_merge?: boolean, auto_build?: boolean,max_implementers?: 1..99, max_serves?: 1..99, auto_review?: boolean, idle_notification?: boolean, skip_draft?: boolean, prs?: boolean, tool_use?: 'normal' | 'high', tickets?: source, github_login?: login | null, build_target?: target | null, scripts?: 'repo' | 'kickflip', claude_model?: 'opus' | 'auto' | 'sonnet' | null} → {file, settings, changed}; changed lists the keys whose value moved.
// PRs off on a board on GitHub that builds from its shared clone needs its Push main switch on, since each land there
// then pushes main (permissions.mjs pushMain).
export async function saveBoardSettings(site, changes) {
  onlyKeys(changes, ['auto_merge', 'auto_build','max_implementers', 'max_serves', 'max_land_tests', 'auto_review', 'idle_notification', 'skip_draft', 'prs', 'tool_use', 'tickets', 'github_login', 'build_target', 'scripts', 'claude_model'], 'the settings');
  if (!Object.keys(changes).length) fail('the settings name nothing to change');
  changes = { ...changes };
  // The hub's number is written to the hub's settings, after the board's own changes are checked.
  const { max_land_tests: landTests, ...own } = changes;
  changes = own;
  for (const [k, v] of Object.entries(changes)) {
    if (k === 'tickets') {
      // None is stored as no tickets key (docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md).
      try { changes.tickets = ticketSource(v) ?? undefined; } catch (e) { fail(e.message); }
      if (changes.tickets?.source === 'linear' && !linearWorks()) fail(LINEAR_NEEDS_KEY);
      // Issues need a repo on GitHub, as Board Settings' Tickets row shows (dialogs.js ticketsControl).
      const board = changes.tickets?.source === 'github' && site ? listBoards().find((b) => samePath(b.dir, site)) : null;
      if (board && !board.github) fail('GitHub issues need the board’s repo on GitHub, and this board’s repo isn’t; pick none or linear');
    }
    else if (k === 'github_login') {
      if (v === '' || v === null) changes.github_login = undefined;
      else if (!validGithubLogin(v)) fail('github_login must be a GitHub login');
    } else if (k === 'build_target') {
      if (v === null) changes.build_target = undefined;
      else if (!validBuildTarget(v)) fail('build_target must name .kickflip/build-<target>: letters, digits, ".", "_" or "-", or null for .kickflip/build');
    } else if (k === 'scripts') {
      if (!['repo', 'kickflip'].includes(v)) fail('scripts must be repo or kickflip');
      if (v === 'repo') changes.scripts = undefined;
    } else if (k === 'tool_use') {
      if (!TOOL_USE.includes(v)) fail('tool_use must be normal or high');
    } else if (k === 'claude_model') {
      if (v === null) changes.claude_model = undefined;
      else if (!CLAUDE_MODEL_VALUES.includes(v)) fail('claude_model must be opus, auto, sonnet or null for Hub default');
    } else if (CAPS.includes(k)) {
      if (!validCap(v)) fail(`${k} must be a whole number from 1 to 99`);
    } else bool(v, k);
  }
  if (changes.prs === false) {
    const board = site ? listBoards().find((b) => samePath(b.dir, site)) : null;
    if (board?.github && !board.local && !(await readPermissions(board.owner?.repo)).pushMain) fail('Merge lands each task on main and pushes it, so turn on Push main after a land first');
  }
  if (landTests !== undefined) {
    try { await setLandTests(landTests); } catch { fail('max_land_tests must be a whole number from 1 to 99'); }
  }
  let from;
  const saved = await writeBoardJSON(site, (cfg) => {
    const board = site ? listBoards().find((b) => samePath(b.dir, site)) : null;
    const before = settingsOf(cfg, board);
    from = before.scripts || 'repo';
    const settings = { ...settingsOf({ ...cfg, ...changes }, board), max_land_tests: readLandTests() };
    return { set: changes, settings, changed: [...Object.keys(changes).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(settings[k])), ...(landTests === undefined ? [] : ['max_land_tests'])] };
  });
  // A move of the scripts' home keeps an on Run release script switch on, for the new home's release script.
  const folder = saved.changed.includes('scripts') ? listBoards().find((b) => samePath(b.dir, site))?.owner?.repo : null;
  if (folder) await followScriptsHome(folder, site, from);
  return saved;
}
// Once Hub has no Linear key, each board in the manifest on Linear falls back to no ticket source, and its session
// hears of it as any source change, by a settings event. Its old cards keep their Linear tickets. Run by the hub as it
// starts and when Hub settings removes the key
// (docs/adr/2026-11-04-0227-every-new-card-gets-a-ticket-in-the-boards-current-source.md). → one line per board moved
export async function fallBackFromLinear() {
  if (linearStatus().set) return [];
  const lines = [];
  for (const board of listBoards()) {
    if ((await readBoardSettings(board.dir)).tickets?.source !== 'linear') continue;
    await saveBoardSettings(board.dir, { tickets: { source: 'none' } });
    await appendEvent(board, 'settings', { tickets: null });
    lines.push(`/${board.route} fell back to no ticket source: Hub has no Linear key`);
  }
  return lines;
}
// The CLI's `settings set <name> <value>`; names are the board.json keys with "-" for "_".
export async function setBoardSetting(site, name, value) {
  const key = String(name).replace(/-/g, '_');
  const names = ['auto_merge', 'auto_build','max_implementers', 'max_serves', 'max_land_tests', 'auto_review', 'idle_notification', 'skip_draft', 'prs', 'tool_use', 'github_login', 'tickets', 'build_target', 'scripts', 'claude_model'];
  if (!names.includes(key)) fail(`no board setting "${name}"; settings are ${names.map((k) => k.replace(/_/g, '-')).join(', ')}`);
  if (key === 'tickets') {
    let tickets;
    try { tickets = JSON.parse(value); } catch { fail('settings set tickets takes the source as JSON, such as {"source":"github"}'); }
    const { file, settings } = await saveBoardSettings(site, { tickets });
    return { file, lines: settingsLines({ tickets: settings.tickets }) };
  }
  if (key === 'github_login') {
    const { file, settings } = await saveBoardSettings(site, { github_login: value });
    return { file, lines: [`github-login ${settings.github_login || 'unset'}`] };
  }
  if (key === 'build_target') {
    const { file, settings } = await saveBoardSettings(site, { build_target: value === 'default' ? null : value });
    return { file, lines: [`build-target ${settings.build_target || 'default'}`] };
  }
  if (key === 'scripts') {
    const { file, settings } = await saveBoardSettings(site, { scripts: value });
    return { file, lines: [`scripts ${settings.scripts || 'repo'}`] };
  }
  if (key === 'tool_use') {
    const { file, settings } = await saveBoardSettings(site, { tool_use: value });
    return { file, lines: [`tool-use ${settings.tool_use}`] };
  }
  if (key === 'claude_model') {
    const { file, settings } = await saveBoardSettings(site, { claude_model: value === 'hub' ? null : value });
    return { file, lines: settingsLines({ claude_model: settings.claude_model }) };
  }
  if (CAPS.includes(key) || key === 'max_land_tests') {
    const { file, settings } = await saveBoardSettings(site, { [key]: /^\d+$/.test(value) ? Number(value) : value });
    return { file, lines: [`${name} ${settings[key]}`] };
  }
  if (!['on', 'off'].includes(value)) fail(`settings set ${name} takes on or off, not "${value}"`);
  const { file, settings } = await saveBoardSettings(site, { [key]: value === 'on' });
  return { file, lines: [`${name} ${settings[key] ? 'on' : 'off'}`] };
}
export const settingsLines = (settings) => Object.entries(settings).map(([k, v]) => `setting ${k.replace(/_/g, '-')} ${k === 'tickets' ? JSON.stringify(v ?? { source: 'none' }) : k === 'github_login' || k === 'tool_use' || CAPS.includes(k) ? v : k === 'scripts' ? v || 'repo' : k === 'build_target' ? v || 'default' : k === 'claude_model' ? v || 'hub' : v ? 'on' : 'off'}`);

// change(list) → {rules, rule} from hub/rules.mjs; → {file, lines} naming the rule's id.
async function changeRules(site, hub, change) {
  const r = hub ? ruleCall(() => change(readHubRules())) : await writeBoardRules(site, change);
  if (hub) { try { await writeHubRules(r.rules); } catch (e) { if (e instanceof RuleError) fail(e.message); throw e; } }
  return { file: hub ? hubSettingsFile() : r.file, lines: [`id ${r.rule.id}`] };
}

// An id given without --hub that names a hub rule, or the reverse, says which flag it needed.
async function checkRuleId(site, id, hub) {
  const ids = (list) => list.map((r) => r.id);
  if (!hub) needSite(site);
  const [mine, other] = hub ? [ids(readHubRules()), site ? ids(await readBoardRules(site)) : []] : [ids(await readBoardRules(site)), ids(readHubRules())];
  if (mine.includes(id)) return;
  fail(`no ${hub ? 'hub' : 'board'} rule "${id}"${other.includes(id) ? `; it is a ${hub ? 'board' : 'hub'} rule, so ${hub ? 'drop' : 'pass'} --hub` : ''}`);
}

// The hub rules, then this board's with --site: one `<hub|board> <id> <owner|claude> <text>` line each.
export async function listRules(site) {
  const line = (scope) => (r) => `${scope} ${r.id} ${r.by === 'claude' ? 'claude' : 'owner'} ${r.text}`;
  return { lines: [...readHubRules().map(line('hub')), ...(site ? (await readBoardRules(site)).map(line('board')) : [])] };
}

export function addRuleTo(site, { text, hub = false, by }) {
  if (!hub) needSite(site);
  return changeRules(site, hub, (list) => addRule(list, { text, by }));
}

export async function editRuleIn(site, id, { text, hub = false }) {
  await checkRuleId(site, id, hub);
  return changeRules(site, hub, (list) => editRule(list, id, text));
}

export async function removeRuleFrom(site, id, { hub = false }) {
  await checkRuleId(site, id, hub);
  return changeRules(site, hub, (list) => removeRule(list, id));
}

// Board Settings' save (server.mjs POST /api/rules). → {file, rules, changes}
export const saveBoardRules = (site, incoming, base) => writeBoardRules(site, (list) => applyRules(list, incoming, base));

export const boardRepoOf = (site, itemFile) => (site && listBoards().find((b) => samePath(b.dir, site))?.github) || itemFile.repo;

export const boardTarget = (site) => listBoards().find((b) => samePath(b.dir, site)) ?? { dir: site };
