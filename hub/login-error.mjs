// Claude Code's login error, in a pane or in a headless run's log (docs/adr/2026-11-14-1500-a-logged-out-claude-shows-red-and-pushes-once.md).
import fs from 'node:fs';
import path from 'node:path';
import { lastMatch } from './usage.mjs';

export const LOGIN_TEXT = /Please run \/login|Not logged in|Invalid API key|OAuth token has expired|authentication_error|Failed to authenticate/i;
export const loggedOutText = (text) => LOGIN_TEXT.test(text);

// Whether the newest result event in a run's stream-json log is an error that carries the login text.
export const runLoggedOut = (file) => {
  const last = lastMatch(file, '"type":"result"', (o) => (o?.type === 'result' ? o : null));
  return Boolean(last?.is_error) && loggedOutText(String(last.result ?? ''));
};

// The logs, by file name, of the open runs recorded in a board's agents directory (data/agents/<id>.json, <id>@<agent>.json).
export const openRunLogs = (agentsDir) => {
  let names;
  try { names = fs.readdirSync(agentsDir); } catch { return []; }
  return names.filter((n) => n.endsWith('.json')).flatMap((n) => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(agentsDir, n), 'utf8'));
      return r?.started && !r.done && r.session?.log ? [r.session.log] : [];
    } catch { return []; }
  });
};
