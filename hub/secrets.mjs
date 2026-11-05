// The hub's tokens, one file for every integration (docs/adr/2026-11-05-0141-the-hub-sends-reviewer-slack-messages-with-its-own-token.md):
// ~/.claude/kickflip/secrets.json, mode 600, outside any repo, {linear?: {...}, slack?: {...}}. Each section belongs to
// its integration's module (linear.mjs, slack.mjs), and only that module's status, never a token, leaves for a page.
// A linear.json from before this file moves in on the first read.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dirOf = (home = os.homedir()) => path.join(home, '.claude', 'kickflip');
export const secretsFile = (home) => path.join(dirOf(home), 'secrets.json');

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function readAll(home) {
  const file = secretsFile(home);
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  const legacy = path.join(dirOf(home), 'linear.json');
  if (fs.existsSync(legacy)) {
    let linear = null;
    try { linear = JSON.parse(fs.readFileSync(legacy, 'utf8')); } catch {}
    if (!saved.linear && linear) { saved = { ...saved, linear }; write(file, saved); }
    fs.rmSync(legacy, { force: true });
  }
  return saved;
}

// → the integration's saved section, or null
export const readSecret = (name, home) => readAll(home)[name] || null;

// Replaces the integration's section; null removes it.
export function writeSecret(name, value) {
  const { [name]: _, ...rest } = readAll();
  write(secretsFile(), value ? { ...rest, [name]: value } : rest);
}
