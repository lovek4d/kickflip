// A board's session permissions (docs/adr/2026-11-03-1921-board-settings-grant-a-boards-session-permissions.md): a fixed
// list of switches, each one allow rule that the hub writes into the board folder's .claude/settings.local.json, which
// Claude Code reads for sessions in that folder alone. The hub keeps every other key and rule there, and switching one
// off removes only its own rule. A refusal is a matching command the session was still refused or asked about while its
// switch was on; the board's data/permission-refusals.json {<id>: {command, how: 'denied' | 'asked', at}} keeps the
// latest, and a change to that switch clears it. A switch that needs a release script
// (docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md) can't be turned on while the board
// has none: the repo's HEAD has no .kickflip/release, or, on a board whose scripts are in kickflip, its site has no
// scripts/release; that switch's rule names the board's release script
// (docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md).
import fs from 'node:fs/promises';
import path from 'node:path';
import { BoardError } from './checks.mjs';
import { writeJSON } from './files.mjs';
import { hasReleaseScript, releaseShownOf } from './release.mjs';
import { scriptShownOf, scriptsOf } from './build-script.mjs';

export const PERMISSIONS = [
  { id: 'pushMain', name: 'Push main after a land', allows: 'Pushes main to origin as each task lands, and lets the session push it.', rule: 'Bash(git push origin main)' },
  { id: 'runRelease', name: 'Run release script', allows: 'Runs the board’s release script ship after main as a release task lands, and lets the session run the script.', rule: 'Bash(.kickflip/release *)', needsReleaseScript: true },
  { id: 'draftPr', name: 'Open draft PRs', allows: 'Lets the session open a PR as a draft.', rule: 'Bash(gh pr create --draft *)' },
  { id: 'approvePr', name: 'Approve PRs', allows: 'Lets the session review a PR with gh: approve, request changes or comment. It reviews only PRs the owner names on the board.', rule: 'Bash(gh pr review *)' },
];

// folder: the board's repo, its session's folder (hub/board-repo.mjs boardRepo's repo).
export function settingsFile(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new BoardError('This board has no repo folder recorded, so it has no settings.local.json to write. Set its repo first.');
  return path.join(folder, '.claude', 'settings.local.json');
}
const refusalsFile = (site) => path.join(site, 'data', 'permission-refusals.json');

async function readJSON(file, fallback, what) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw new BoardError(`${what} isn’t a JSON object, so the hub leaves it as it is. Fix it by hand first.`);
}

const allowOf = (settings) => (Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : []);
// The rule a switch writes for the board in site: Run release script's names the board's release script.
const ruleOf = (permission, site) => (permission.needsReleaseScript ? `Bash(${releaseShownOf(site)} *)` : permission.rule);

// → {<id>: boolean}
export async function readPermissions(folder, site) {
  const allow = allowOf(await readJSON(settingsFile(folder), {}, settingsFile(folder)));
  return Object.fromEntries(PERMISSIONS.map((p) => [p.id, allow.includes(ruleOf(p, site))]));
}

// Turns one switch on or off in the folder's settings.local.json and clears its refusal in the board's site folder.
// → readPermissions's answer after the write
export async function setPermission(folder, site, id, on) {
  const permission = PERMISSIONS.find((p) => p.id === id);
  if (!permission || typeof on !== 'boolean') throw new BoardError(`Send {id, on} with id one of ${PERMISSIONS.map((p) => p.id).join(', ')} and on true or false.`);
  const file = settingsFile(folder);
  const settings = await readJSON(file, {}, file);
  if (settings.permissions !== undefined && (typeof settings.permissions !== 'object' || Array.isArray(settings.permissions) || settings.permissions === null)) throw new BoardError(`${file}’s permissions isn’t an object, so the hub leaves it as it is. Fix it by hand first.`);
  const allow = allowOf(settings);
  if (on && unavailable(folder, site, permission)) throw new BoardError(`${unavailable(folder, site, permission)}, so ${permission.name} stays off.`);
  const rule = ruleOf(permission, site);
  if (allow.includes(rule) !== on) {
    settings.permissions = { ...settings.permissions, allow: on ? [...allow, rule] : allow.filter((r) => r !== rule) };
    await writeJSON(file, settings);
  }
  const refusals = await readRefusals(site);
  if (refusals[id]) {
    delete refusals[id];
    await writeJSON(refusalsFile(site), refusals);
  }
  return readPermissions(folder, site);
}

// Once the board in site moved its scripts' home away from `from` ('repo' | 'kickflip'), an on Run release script
// switch stays on: its rule now names the new home's release script.
export async function followScriptsHome(folder, site, from) {
  const file = settingsFile(folder);
  const settings = await readJSON(file, {}, file);
  const permission = PERMISSIONS.find((p) => p.needsReleaseScript);
  const old = `Bash(${scriptShownOf({ dir: site, scripts: from }, 'release')} *)`;
  const rule = ruleOf(permission, site);
  const allow = allowOf(settings);
  if (old === rule || !allow.includes(old)) return;
  settings.permissions = { ...settings.permissions, allow: allow.map((r) => (r === old ? rule : r)) };
  await writeJSON(file, settings);
}

export const readRefusals = (site) => readJSON(refusalsFile(site), {}, refusalsFile(site));

// The switch whose rule allows a Bash command, as Claude Code matches it: `*` stands for any run of characters.
export function permissionFor(command, site) {
  if (typeof command !== 'string') return null;
  return PERMISSIONS.find((p) => {
    const pattern = /^Bash\((.*)\)$/.exec(ruleOf(p, site))[1];
    return new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(command.trim());
  }) || null;
}

// A hook's input from the board's session: a PermissionDenied (auto mode refused, how 'denied') or a PermissionRequest
// (the session asked, how 'asked') for a Bash command one of the folder's switches allows while it is on. → the
// switch's id it recorded, or null
export async function recordRefusal(folder, site, input, now = new Date()) {
  if (input?.tool_name !== 'Bash') return null;
  const permission = permissionFor(input.tool_input?.command, site);
  if (!permission || !(await readPermissions(folder, site))[permission.id]) return null;
  const refusals = await readRefusals(site);
  refusals[permission.id] = { command: input.tool_input.command, how: input.hook_event_name === 'PermissionDenied' ? 'denied' : 'asked', at: now.toISOString() };
  await writeJSON(refusalsFile(site), refusals);
  return permission.id;
}

// Why permission can't be turned on for the board in site, whose repo is folder, or null.
const unavailable = (folder, site, permission) => {
  if (!permission.needsReleaseScript || hasReleaseScript(folder, 'HEAD', site)) return null;
  return scriptsOf(site).scripts === 'kickflip' ? `No ${releaseShownOf(site)} in kickflip` : `No ${releaseShownOf(site)} in this repo`;
};

// GET and POST /api/permissions's answer: each switch with its state, refusal, and unavailable, why it can't be turned on.
export async function permissionsView(folder, site) {
  const [on, refusals] = await Promise.all([readPermissions(folder, site), readRefusals(site)]);
  return { file: settingsFile(folder), permissions: PERMISSIONS.map(({ needsReleaseScript, ...p }) => ({ ...p, rule: ruleOf({ needsReleaseScript, rule: p.rule }, site), on: on[p.id], refused: on[p.id] ? refusals[p.id] || null : null, unavailable: unavailable(folder, site, { needsReleaseScript }) })) };
}
