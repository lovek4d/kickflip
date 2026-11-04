// A board's session permissions (docs/adr/2026-11-03-1921-board-settings-grant-a-boards-session-permissions.md): a fixed
// list of switches, each one allow rule that the hub writes into the board folder's .claude/settings.local.json, which
// Claude Code reads for sessions in that folder alone. The hub keeps every other key and rule there, and switching one
// off removes only its own rule. A refusal is a matching command the session was still refused or asked about while its
// switch was on; the board's data/permission-refusals.json {<id>: {command, how: 'denied' | 'asked', at}} keeps the
// latest, and a change to that switch clears it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { BoardError } from './store.mjs';

export const PERMISSIONS = [
  { id: 'pushMain', name: 'Push main after a land', allows: 'Pushes main to origin as each card lands, and lets the session push it.', rule: 'Bash(git push origin main)' },
  { id: 'pushTags', name: 'Push release tags', allows: 'Lets the session push a v* release tag.', rule: 'Bash(git push origin v*)' },
  { id: 'draftPr', name: 'Open draft PRs', allows: 'Lets the session open a PR as a draft.', rule: 'Bash(gh pr create --draft *)' },
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

async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temp, file);
}

const allowOf = (settings) => (Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : []);

// → {<id>: boolean}
export async function readPermissions(folder) {
  const allow = allowOf(await readJSON(settingsFile(folder), {}, settingsFile(folder)));
  return Object.fromEntries(PERMISSIONS.map((p) => [p.id, allow.includes(p.rule)]));
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
  if (allow.includes(permission.rule) !== on) {
    settings.permissions = { ...settings.permissions, allow: on ? [...allow, permission.rule] : allow.filter((r) => r !== permission.rule) };
    await writeJSON(file, settings);
  }
  const refusals = await readRefusals(site);
  if (refusals[id]) {
    delete refusals[id];
    await writeJSON(refusalsFile(site), refusals);
  }
  return readPermissions(folder);
}

export const readRefusals = (site) => readJSON(refusalsFile(site), {}, refusalsFile(site));

// The switch whose rule allows a Bash command, as Claude Code matches it: `*` stands for any run of characters.
export function permissionFor(command) {
  if (typeof command !== 'string') return null;
  return PERMISSIONS.find((p) => {
    const pattern = /^Bash\((.*)\)$/.exec(p.rule)[1];
    return new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(command.trim());
  }) || null;
}

// A hook's input from the board's session: a PermissionDenied (auto mode refused, how 'denied') or a PermissionRequest
// (the session asked, how 'asked') for a Bash command one of the folder's switches allows while it is on. → the
// switch's id it recorded, or null
export async function recordRefusal(folder, site, input, now = new Date()) {
  if (input?.tool_name !== 'Bash') return null;
  const permission = permissionFor(input.tool_input?.command);
  if (!permission || !(await readPermissions(folder))[permission.id]) return null;
  const refusals = await readRefusals(site);
  refusals[permission.id] = { command: input.tool_input.command, how: input.hook_event_name === 'PermissionDenied' ? 'denied' : 'asked', at: now.toISOString() };
  await writeJSON(refusalsFile(site), refusals);
  return permission.id;
}

// GET and POST /api/permissions's answer: each switch with its state and refusal, and owner: whether this browser is the
// signed-in owner's, who alone may change them (on-host.mjs fromOwner).
export async function permissionsView(folder, site, owner) {
  const [on, refusals] = await Promise.all([readPermissions(folder), readRefusals(site)]);
  return { owner, file: settingsFile(folder), permissions: PERMISSIONS.map((p) => ({ ...p, on: on[p.id], refused: on[p.id] ? refusals[p.id] || null : null })) };
}
