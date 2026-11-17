// The hub's settings file, ~/.claude/kickflip/settings.json, and its per-key accessors. Every writer goes through
// update(), which holds hub/locks.mjs withFileLock across the read and the write, so two processes changing different keys
// at once, such as a board's pause and a hub rules edit, both survive. Hub Web Push settings (quiet hours, notifications)
// are in hub/push.mjs and write through update() too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withFileLock, withFileLockSync } from '../hub/locks.mjs';
import { CODEX_SHARE_VALUES, codexStatus, effectiveCodexShare } from './codex.mjs';

export const settingsFile = (home = os.homedir()) => path.join(home, '.claude', 'kickflip', 'settings.json');

// The whole file, or {} when it is missing or unreadable.
export function read(home = os.homedir()) {
  try {
    const value = JSON.parse(fs.readFileSync(settingsFile(home), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

const write = (change, home) => {
  const file = settingsFile(home);
  const next = change(read(home));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return next;
};

// change(current) → the whole next file, built from the file as it is on disk under the lock; a throw writes nothing.
// → the file written.
export const update = (change, home = os.homedir()) => withFileLock(settingsFile(home), () => write(change, home));

// update for the one caller that can't await (tailscale.mjs repickDaemon): the same lock, held by blocking the thread.
export const updateSync = (change, home = os.homedir()) => withFileLockSync(settingsFile(home), () => write(change, home));

// status: a codex.mjs codexStatus. → the Codex setting in effect, codex.mjs effectiveCodexShare.
export const readCodexShare = (status = codexStatus(), home = os.homedir()) => effectiveCodexShare(read(home).codexShare, status);

// Throws {status: 400} for a value that isn't a choice, and {status: 409} with the fix while Codex isn't usable.
export async function setCodexShare(value, status = codexStatus(), home = os.homedir()) {
  if (!CODEX_SHARE_VALUES.includes(value)) throw Object.assign(new Error('codex-share takes auto, always, or off'), { status: 400 });
  if (!status.usable) throw Object.assign(new Error(`${status.words} Run ${status.fix}, then choose again.`), { status: 409 });
  await update((file) => ({ ...file, codexShare: value }), home);
  return value;
}

// Auto update (docs/adr/2026-11-13-2345-a-checkbox-under-the-hubs-version-turns-auto-update-off.md): off only when settings.json
// says autoUpdate: false; unset is on.
export const readAutoUpdate = (home = os.homedir()) => read(home).autoUpdate !== false;

export async function setAutoUpdate(on, home = os.homedir()) {
  await update(({ autoUpdate: _, ...rest }) => (on ? rest : { ...rest, autoUpdate: false }), home);
}

// docs/adr/2026-11-16-0700-land-test-runs-take-turns-on-the-host.md
// Land test runs at once on the host: the hub's one number, 1 to 99, MAX_LAND_TESTS unless settings.json says otherwise.
export const MAX_LAND_TESTS = 1;
const validLandTests = (value) => Number.isInteger(value) && value >= 1 && value <= 99;
export const readLandTests = (home = os.homedir()) => {
  const stored = read(home).landTests;
  return validLandTests(stored) ? stored : MAX_LAND_TESTS;
};
// Throws {status: 400} for a value that isn't a whole number from 1 to 99.
export async function setLandTests(value, home = os.homedir()) {
  const n = /^\d+$/.test(String(value)) ? Number(value) : value;
  if (!validLandTests(n)) throw Object.assign(new Error('land-tests takes a whole number from 1 to 99'), { status: 400 });
  await update((file) => ({ ...file, landTests: n }), home);
  return n;
}

// Which Claude model builds a card that Claude builds (docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md),
// Hub settings' Builders: opus or sonnet forces it, auto leaves it to the card (usage-gate.mjs builderPick). A
// board's own Builders choice overrides it (usage-gate.mjs claudeModelFor). A missing or unknown stored value is auto.
export const CLAUDE_MODEL_VALUES = ['opus', 'auto', 'sonnet'];
export const readClaudeModel = (home = os.homedir()) => {
  const stored = read(home).claudeModel;
  return CLAUDE_MODEL_VALUES.includes(stored) ? stored : 'auto';
};

// Throws {status: 400} for a value that isn't a choice.
export async function setClaudeModel(value, home = os.homedir()) {
  if (!CLAUDE_MODEL_VALUES.includes(value)) throw Object.assign(new Error('claude-model takes opus, auto or sonnet'), { status: 400 });
  await update((file) => ({ ...file, claudeModel: value }), home);
  return value;
}

// Hub settings' Orchestrators: the model each board's own session runs on unless its owner record names one
// (hub/sessions.mjs startArgv). Auto has no say here. A missing or unknown stored value is opus.
export const ORCHESTRATOR_MODEL_VALUES = ['opus', 'sonnet'];
export const readOrchestratorModel = (home = os.homedir()) => {
  const stored = read(home).orchestratorModel;
  return ORCHESTRATOR_MODEL_VALUES.includes(stored) ? stored : 'opus';
};
// Throws {status: 400} for a value that isn't a choice.
export async function setOrchestratorModel(value, home = os.homedir()) {
  if (!ORCHESTRATOR_MODEL_VALUES.includes(value)) throw Object.assign(new Error('orchestrator-model takes opus or sonnet'), { status: 400 });
  await update((file) => ({ ...file, orchestratorModel: value }), home);
  return value;
}
