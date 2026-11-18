// docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md
// The one place a headless worker (a builder, lander or planner) starts. Each kind of agent is an entry: its binary,
// its command line, and how its output names its session. Callers pass the kind and never branch on it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { claudeBin, inherited } from '../hub/sessions.mjs';
import { backgroundArgv, onPath } from './background.mjs';

// The repo's shared .git for a worktree (or a repo) at cwd, where its commits land. → an absolute path, or null outside git.
function gitCommonDir(cwd) {
  try { return path.resolve(cwd, execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { return null; }
}

const AGENTS = {
  // claude -p in auto mode on model, Opus when none is given, and with resume, in that session, carrying on from it
  // (docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md). Its log is one stream-json
  // event per line, which the board's log sheet reads (app-reader.js); the first, the init event, carries the session id.
  claude: {
    bin: claudeBin,
    args: ({ prompt, model = 'opus', resume }) => [...(resume ? ['--resume', resume] : []), '-p', prompt, '--permission-mode', 'auto', '--model', model, '--output-format', 'stream-json', '--verbose'],
    session: (line) => { try { const e = JSON.parse(line); return e.type === 'system' && e.subtype === 'init' ? e.session_id ?? null : null; } catch { return null; } },
  },
  // codex exec under workspace-write: a worker runs the board CLI, which writes the board's site folder, and commits,
  // which write the repo's .git outside a worktree, so both are writable too; network is on for gh. Its log is plain
  // text, whose banner names the session.
  codex: {
    bin: () => process.env.KICKFLIP_CODEX || 'codex',
    args: ({ prompt, cwd, site }) => [
      'exec', '--color', 'never', '--cd', cwd, '--sandbox', 'workspace-write',
      ...[site, gitCommonDir(cwd)].filter(Boolean).flatMap((dir) => ['--add-dir', dir]),
      '-c', 'sandbox_workspace_write.network_access=true', prompt,
    ],
    session: (line) => line.match(/^session id: (\S+)/)?.[1] ?? null,
  },
};

// How long a launch waits for the agent to name its session before going on without it, so a pull never stalls on an
// agent that stays silent (docs/adr/2026-11-13-2234-a-limit-a-person-sees-stays-and-its-test-passes-the-runner.md).
const SESSION_WAIT_MS = 15_000;

// Reads log from offset as it grows until a line names the session, the child exits, or wait ms run out (never, for
// Infinity). → the id or null.
function sessionOf(child, log, offset, session, wait) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (id) => { if (done) return; done = true; clearInterval(poll); clearTimeout(cap); child.off('exit', exited); resolve(id); };
    const scan = () => {
      const text = fs.readFileSync(log, 'utf8').slice(offset);
      for (const line of text.split('\n')) { const id = session(line); if (id) return finish(id); }
    };
    const poll = setInterval(scan, 100); // poll: agent-session-wait
    const cap = Number.isFinite(wait) ? setTimeout(() => finish(null), wait) : undefined;
    const exited = () => { scan(); finish(null); };
    child.once('exit', exited);
  });
}

// Starts an agent of kind (claude | codex) on prompt at background priority (background.mjs), detached in cwd, without the launching session's CLAUDE_*
// environment, its output going to log as it runs. model is Claude's (opus | sonnet); resume a Claude session id to carry
// on; site is the board's site folder. bin overrides the kind's binary. sessionWait is how many ms to wait for the session
// id. onSpawn(pid) is called as the process starts, before it names its session. → {pid, sessionId, log} once it has named its session (sessionId null if it exited or took too long first); rejects
// when it can't start.
export function launchAgent({ kind, model, cwd, site, prompt, log, bin, resume, sessionWait = SESSION_WAIT_MS, onSpawn }) {
  const agent = AGENTS[kind];
  if (!agent) throw new Error(`no agent of kind ${kind}`);
  const command = bin ?? agent.bin();
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, 'a');
  const offset = fs.fstatSync(out).size;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !inherited(k)));
  if (path.isAbsolute(command)) env.PATH = `${path.dirname(command)}:${env.PATH || ''}`;
  // The background wrapper starts whatever it's given, so a missing agent is caught here, not as the wrapper's exit.
  if (!onPath(command, env.PATH)) { fs.closeSync(out); return Promise.reject(Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })); }
  const [wrapper, ...wrapped] = backgroundArgv([command, ...agent.args({ prompt, model, cwd, site, resume })]);
  return new Promise((resolve, reject) => {
    const child = spawn(wrapper, wrapped, { cwd, env, detached: true, stdio: ['ignore', out, out] });
    child.once('spawn', async () => {
      fs.closeSync(out);
      onSpawn?.(child.pid);
      const sessionId = await sessionOf(child, log, offset, agent.session, sessionWait);
      child.unref();
      resolve({ pid: child.pid, sessionId, log });
    });
    child.once('error', (e) => { fs.closeSync(out); reject(e); });
  });
}
