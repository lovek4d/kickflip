// Claude Code's workspace trust for a clone the hub made (docs/adr/2026-11-02-1549-the-hub-trusts-the-clones-it-makes.md).
// `claude --bg` refuses a folder whose `projects[<repo root>].hasTrustDialogAccepted` isn't true in `.claude.json`
// under CLAUDE_CONFIG_DIR, else the home folder (Claude Code docs, permissions, "Project allow rules and workspace
// trust"). Claude Code rewrites that file from memory, so a write can be lost to one it makes at the same moment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const claudeConfigFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
// Errors end as a failed start's error line, which keeps 200 characters.
const shown = (file) => file.startsWith(os.homedir() + path.sep) ? `~${file.slice(os.homedir().length)}` : file;

function load(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`${shown(file)} doesn't exist; run claude once to make it`);
    throw e;
  }
  let config = null;
  try { config = JSON.parse(text); } catch {}
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${shown(file)} isn't valid JSON`);
  return config;
}

const marked = (config, key) => config.projects?.[key]?.hasTrustDialogAccepted === true;

// Writes beside the file's real path, so a symlinked config stays a symlink and the rename stays on one volume.
function save(file, config, key) {
  const target = fs.realpathSync(file);
  const { mode } = fs.statSync(target);
  const projects = { ...config.projects, [key]: { ...config.projects?.[key], hasTrustDialogAccepted: true } };
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.kickflip-${randomUUID()}`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ ...config, projects }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(temp, mode & 0o7777);
    fs.renameSync(temp, target);
  } catch (e) { fs.rmSync(temp, { force: true }); throw e; }
}

// Marks dir's realpath trusted, keeping every other key, and checks the mark survived, writing once more if a Claude
// write dropped it. Never creates or overwrites a config that is missing or not valid JSON. → the key it marked
export function trustFolder(dir) {
  const file = claudeConfigFile();
  const key = fs.realpathSync(dir);
  let config = load(file);
  for (let writes = 0; !marked(config, key); writes++) {
    if (writes === 2) throw new Error(`a running Claude session overwrote the trust mark in ${shown(file)}; retry`);
    save(file, config, key);
    config = load(file);
  }
  return key;
}
