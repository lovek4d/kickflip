import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEX_SHARE_VALUES = ['auto', 'always', 'off'];

// Codex has a Homebrew cask but no apt package; npm installs it anywhere else.
const UNUSABLE = {
  'not installed': (platform) => ({ words: "Codex isn't installed on the host.", fix: platform === 'darwin' ? 'brew install --cask codex' : 'npm i -g @openai/codex' }),
  'not logged in': () => ({ words: "Codex isn't logged in on the host.", fix: 'codex login' }),
};

const executable = (file) => {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); } catch { return false; }
};

// Looks for a codex executable on env.PATH without running it.
export const codexOnPath = (env = process.env) => (env.PATH || '').split(path.delimiter).some((dir) => dir && executable(path.join(dir, 'codex')));

// Codex is usable when installed and logged in (~/.codex/auth.json); running out of usage doesn't count.
// → {usable, reason: null | 'not installed' | 'not logged in', words, fix}: words and fix say why and what to run.
export function codexStatus({ home = os.homedir(), env = process.env, installed = codexOnPath(env), platform = process.platform } = {}) {
  const reason = !installed ? 'not installed' : !fs.existsSync(path.join(home, '.codex', 'auth.json')) ? 'not logged in' : null;
  return reason ? { usable: false, reason, ...UNUSABLE[reason](platform) } : { usable: true, reason: null, words: null, fix: null };
}

// The hub reads this on every sidebar poll, so the PATH lookup is kept cacheMs; fresh: true looks again.
// The login check runs every time, so a `codex login` shows on the next poll.
export function codexStatusReader({ home, env, now = Date.now, cacheMs = 60_000 } = {}) {
  let installed;
  let at = -Infinity;
  return ({ fresh = false } = {}) => {
    if (fresh || now() - at >= cacheMs) { installed = codexOnPath(env); at = now(); }
    return codexStatus({ home, installed });
  };
}

// The Codex setting in effect (docs/adr/0092-codex-share-follows-whether-codex-is-usable.md): Off while Codex isn't
// usable, whatever is stored; else the stored choice, or Auto when none was made.
export const effectiveCodexShare = (stored, status) =>
  !status.usable ? 'off' : CODEX_SHARE_VALUES.includes(stored) ? stored : 'auto';
