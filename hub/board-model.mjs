// A board's orchestrator model, Opus or Sonnet, kept on its manifest owner record as `model` and passed to its session
// as --model at each start (docs/adr/2026-11-16-0945-a-board-setting-picks-opus-or-sonnet-for-its-orchestrator.md).
import { isBoardSite, readManifest, withManifestLock, writeManifest } from './boards.mjs';
import { routeRecord } from './routes.mjs';
import { DEFAULT_MODEL, freshSession, runTmux, tmuxName } from './sessions.mjs';
import { liveSessions } from './live.mjs';

export const MODELS = ['opus', 'sonnet'];
const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function boardSite(route, manifest) {
  const site = routeRecord(manifest.sites, route);
  if (!isBoardSite(site)) refuse('Board not found.', 404);
  return site;
}

// → {model, hub}: hub when the board is the hub board, whose session runs in tmux
export function boardModel(route, manifest = readManifest()) {
  const site = boardSite(route, manifest);
  return { model: site.owner?.model || DEFAULT_MODEL, hub: site.hub === true };
}

// Records {model} on the board's owner record. When the change reaches the session, as `applies`:
// - 'now': the hub board's session is idle in its tmux pane, which gets `/model <model>` typed into it, as the hub
//   types /compact (sessions.mjs compactFullContexts).
// - 'next start': the hub board's session is busy or not running; a foreground resume takes --model.
// - 'new session': any other board's session runs in the background, where nothing can be typed, and a resume keeps
//   the options it started with (sessions.mjs resumeArgv), so it takes a fresh session (restartOnModel).
// → {model, applies}
export async function changeBoardModel(route, input, { live = liveSessions, tmux = runTmux } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'model')) refuse('Send only model.');
  if (!MODELS.includes(input.model)) refuse('Model must be opus or sonnet.');
  const { model } = input;
  const site = await withManifestLock(async () => {
    const manifest = readManifest();
    const current = boardSite(route, manifest);
    current.owner = { ...current.owner, model };
    current.updated = new Date().toISOString();
    await writeManifest(manifest);
    return current;
  });
  if (site.hub !== true) return { model, applies: 'new session' };
  if (live()?.get(site.owner.session)?.status !== 'idle') return { model, applies: 'next start' };
  const target = `=${tmuxName(route)}:`;
  const typed = tmux(['send-keys', '-t', target, '-l', `/model ${model}`]);
  const sent = typed.status === 0 && tmux(['send-keys', '-t', target, 'Enter']).status === 0;
  return { model, applies: sent ? 'now' : 'next start' };
}

// Settings' Restart the session now: a fresh session on the board's model in place of its background one
// (sessions.mjs freshSession). → freshSession's answer
export async function restartOnModel(route, { live = liveSessions, stop, run } = {}) {
  if (boardSite(route, readManifest()).hub === true) refuse('The hub board’s session switches model in its tmux pane.', 409);
  try { return await freshSession(route, { live, stop, run }); } catch (e) { refuse(e.message, e.reason === 'none' ? 409 : 502); }
}
