// A logged-out Claude shows red and pushes once per episode (docs/adr/2026-11-14-1500-a-logged-out-claude-shows-red-and-pushes-once.md).
// The hub board's tmux pane is read for Claude Code's login prompt, and the logs of headless runs for a final auth error.
// logged-out-state.json {<route or 'headless'>: {since}} holds each open episode; it clears when the text is gone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hubBoard, readJSON, saveJSON } from './boards.mjs';
import { tmuxName, runTmux } from './sessions.mjs';
import { deliver } from './push.mjs';

export const LOGIN_TEXT = /Please run \/login|Not logged in|Invalid API key|OAuth token has expired|authentication_error|Failed to authenticate/i;
export const HEADLESS_RECENT_MS = 10 * 60_000;
export const loggedOutText = (text) => LOGIN_TEXT.test(text);
export const loggedOutFile = () => path.join(os.homedir(), '.claude', 'kickflip', 'logged-out-state.json');
export const loggedOutRoutes = (file = loggedOutFile()) => new Set(Object.keys(readJSON(file, {})));

// Whether a log written in the last HEADLESS_RECENT_MS ends on an error result that carries the login text.
function headlessLoggedOut(dir, now) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return false; }
  return names.some((name) => {
    try {
      const file = path.join(dir, name);
      if (now.getTime() - fs.statSync(file).mtimeMs > HEADLESS_RECENT_MS) return false;
      const last = fs.readFileSync(file, 'utf8').split('\n').reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.type === 'result');
      return Boolean(last?.is_error) && loggedOutText(String(last.result ?? ''));
    } catch { return false; }
  });
}

// → {loggedOut: [route or 'headless'], pushed: [..], failed: [message]}
export async function checkLoggedOut({ manifest, now = new Date(), tmux = runTmux, logDir = path.join(os.homedir(), '.claude', 'kickflip', 'logs'), stateFile = loggedOutFile(), push = deliver } = {}) {
  const state = readJSON(stateFile, {});
  const next = {};
  const out = { loggedOut: [], pushed: [], failed: [] };
  const found = [];
  const hub = hubBoard(manifest);
  if (hub) {
    const name = tmuxName(hub.route);
    if (tmux(['has-session', '-t', `=${name}`]).status === 0 && loggedOutText(tmux(['capture-pane', '-p', '-t', `=${name}:`]).stdout)) found.push({ key: hub.route, who: `${hub.title}'s session`, url: `/${hub.route}/` });
  }
  if (headlessLoggedOut(logDir, now)) found.push({ key: 'headless', who: 'a background run', url: '/' });
  for (const f of found) {
    out.loggedOut.push(f.key);
    if (state[f.key]) { next[f.key] = state[f.key]; continue; }
    try {
      await push({ title: 'Claude is logged out: run /login', body: `${f.who} hit the login prompt. /login in any claude fixes them all.`, url: f.url, tag: `logged-out-${f.key}` }, { kind: 'fault', immediate: true, at: now });
      next[f.key] = { since: now.toISOString() };
      out.pushed.push(f.key);
    } catch (e) { out.failed.push(`${f.key}: could not push that Claude is logged out (${e.message})`); }
  }
  if (JSON.stringify(next) !== JSON.stringify(state)) saveJSON(stateFile, next);
  return out;
}
