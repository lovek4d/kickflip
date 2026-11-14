#!/usr/bin/env node
// A PreToolUse hook on Bash that refuses `git push` and broad kills (pkill, killall, kill of a process group) in a
// builder session, one whose cwd is inside ~/.claude/kickflip/worktrees. The board's own PR push runs inside node, not
// through this tool, so it isn't blocked. `git add` in every form passes: builders commit in their worktrees
// (docs/adr/2026-11-14-0720-a-builder-guard-refuses-push-and-broad-kills.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKTREES = path.join(os.homedir(), '.claude', 'kickflip', 'worktrees') + path.sep;

// Each simple command of a line, as its words with leading VAR=value, sudo, command and exec dropped. Quoted text
// stays one word, so `echo "git push"` has no push command.
function commands(line) {
  const out = [];
  let words = [], word = '', quote = null, started = false;
  const endWord = () => { if (started) words.push(word); word = ''; started = false; };
  const endCommand = () => { endWord(); while (/^[A-Za-z_]\w*=/.test(words[0]) || ['sudo', 'command', 'exec', 'xargs'].includes(words[0])) words.shift(); if (words.length) out.push(words); words = []; };
  for (const c of line) {
    if (quote) { if (c === quote) quote = null; else word += c; }
    else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c) && c !== '\n') endWord();
    else if (';&|\n()'.includes(c)) endCommand();
    else { word += c; started = true; }
  }
  endCommand();
  return out;
}

function refusal([name, ...args]) {
  if (name === 'pkill' || name === 'killall') return `${name} can hit other cards' runs`;
  if (name === 'kill' && args.some((a, i) => a === '0' || a === '--' || (i > 0 && /^-\d+$/.test(a)))) return 'a kill of a process group can hit other cards\' runs';
  if (name === 'git') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]) ? 2 : 1;
    if (args[i] === 'push') return 'git push';
  }
  return null;
}

process.stdout.on('error', () => {});
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash' && (input.cwd + path.sep).startsWith(WORKTREES)) {
    const what = commands(String(input.tool_input?.command)).map(refusal).find(Boolean);
    if (what) console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: what === 'git push'
        ? 'A builder never pushes: the board pushes after land. Commit in your worktree and finish with `builder done`.'
        : `A builder session refuses ${what}. Stop one process by its pid, or the board's own stop commands.`,
    } }));
  }
} catch {}
process.exitCode = 0;
