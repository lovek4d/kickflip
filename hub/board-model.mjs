// A board's orchestrator model: Board settings' Orchestrators, Hub default or an override, Opus or Sonnet, kept on its
// manifest owner record as `model` (none on Hub default) and passed to its session as --model at each start, the hub's
// Orchestrators choice when the record names none (sessions.mjs startArgv)
// (docs/adr/2026-11-16-0945-a-board-setting-picks-opus-or-sonnet-for-its-orchestrator.md,
// docs/adr/2026-11-16-1030-builders-and-orchestrators-each-take-a-hub-default-a-board-can-override.md).
import { hubBoard, isBoardSite, readManifest, withManifestLock, writeManifest } from './boards.mjs';
import { routeRecord } from './routes.mjs';
import { freshSession, runTmux, tmuxName } from './sessions.mjs';
import { liveSessions } from './live.mjs';
import { ORCHESTRATOR_MODEL_VALUES, readOrchestratorModel, setOrchestratorModel } from './push.mjs';
import { orchestratorsView } from '../shared/model-views.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function boardSite(route, manifest) {
  const site = routeRecord(manifest.sites, route);
  if (!isBoardSite(site)) refuse('Board not found.', 404);
  return site;
}

// → {orchestrators: shared/model-views.mjs orchestratorsView, hub}: hub when the board is the hub board, whose session
// runs in tmux
export function boardModel(route, manifest = readManifest()) {
  const site = boardSite(route, manifest);
  return { orchestrators: orchestratorsView(readOrchestratorModel(), site.owner?.model ?? null), hub: site.hub === true };
}

// When a change of the model a board's session runs on reaches it, as `applies`:
// - 'now': the hub board's session is idle in its tmux pane, which gets `/model <model>` typed into it, as the hub
//   types /compact (sessions.mjs compactFullContexts).
// - 'next start': the hub board's session is busy or not running; a foreground resume takes --model.
// - 'new session': any other board's session runs in the background, where nothing can be typed, and a resume keeps
//   the options it started with (sessions.mjs resumeArgv), so it takes a fresh session (restartOnModel).
function applyModel(route, site, model, { live, tmux }) {
  if (site.hub !== true) return 'new session';
  if (live()?.get(site.owner?.session)?.status !== 'idle') return 'next start';
  const target = `=${tmuxName(route)}:`;
  const typed = tmux(['send-keys', '-t', target, '-l', `/model ${model}`]);
  return typed.status === 0 && tmux(['send-keys', '-t', target, 'Enter']).status === 0 ? 'now' : 'next start';
}

// Records {model: opus | sonnet} on the board's owner record, or drops it for {model: null}, Hub default.
// → {orchestrators, applies} (applyModel)
export async function changeBoardModel(route, input, { live = liveSessions, tmux = runTmux } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'model')) refuse('Send only model.');
  if (input.model !== null && !ORCHESTRATOR_MODEL_VALUES.includes(input.model)) refuse('Model must be opus, sonnet or null for Hub default.');
  const { model } = input;
  const site = await withManifestLock(async () => {
    const manifest = readManifest();
    const current = boardSite(route, manifest);
    const { model: _, ...owner } = current.owner || {};
    current.owner = model ? { ...owner, model } : owner;
    current.updated = new Date().toISOString();
    await writeManifest(manifest);
    return current;
  });
  const hub = readOrchestratorModel();
  return { orchestrators: orchestratorsView(hub, model), applies: applyModel(route, site, model || hub, { live, tmux }) };
}

// Hub settings' Orchestrators: saves the hub's choice, which reaches the hub board's session as a change of its own
// would when its owner record names no model; every other board on Hub default takes it at its next new session.
// → {model, applies: applyModel's for the hub board, or null when no hub board follows the hub's choice}
export function changeHubOrchestratorModel(value, { manifest = readManifest(), live = liveSessions, tmux = runTmux } = {}) {
  const model = setOrchestratorModel(value);
  const board = hubBoard(manifest);
  return { model, applies: board && !board.owner?.model ? applyModel(board.route, board, model, { live, tmux }) : null };
}

// Settings' Restart the session now: a fresh session on the board's model in place of its background one
// (sessions.mjs freshSession). → freshSession's answer
export async function restartOnModel(route, { live = liveSessions, stop, run } = {}) {
  if (boardSite(route, readManifest()).hub === true) refuse('The hub board’s session switches model in its tmux pane.', 409);
  try { return await freshSession(route, { live, stop, run }); } catch (e) { refuse(e.message, e.reason === 'none' ? 409 : 502); }
}
