#!/usr/bin/env node
// A PreToolUse hook on Bash that refuses a command that reads the watcher's output (a background task's .output file
// or $O; a command naming wait-events.mjs, such as a read of its source, is no read of its output) through a filter that can drop `waits` lines: rg/grep -v, head, tail, awk, sed deleting or -n,
// or an rg/grep for anything but waits or events. A dropped waits line is a card left waiting on the orchestrator
// unseen. These pass: `rg '^waits' $O` whole, with `cut` after it, and any filter after an `rg '^event'` selection,
// which only narrows events (docs/adr/2026-11-15-1930-the-watcher-collapses-repeat-waits-and-a-hook-refuses-filtering-them.md).
import fs from 'node:fs';

// The pipelines of a line, each as its stages' words; quoted text stays one word, so a pattern with | is one word.
function pipelines(line) {
  const out = [];
  let stages = [], words = [], word = '', quote = null, started = false;
  const endWord = () => { if (started) words.push(word); word = ''; started = false; };
  const endStage = () => { endWord(); if (words.length) stages.push(words); words = []; };
  const endPipeline = () => { endStage(); if (stages.length) out.push(stages); stages = []; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; else word += c; }
    else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === '|' && line[i + 1] !== '|') endStage();
    else if (/\s/.test(c) && c !== '\n') endWord();
    else if (';&|\n()'.includes(c)) endPipeline();
    else { word += c; started = true; }
  }
  endPipeline();
  return out;
}

const READS_WATCHER = /\$\{?O\}?(?![\w])|\.output\b/;

// → whether the pipeline can drop a waits line before an events selection narrows it
function drops(stages) {
  for (const [name, ...args] of stages) {
    if (['rg', 'grep', 'egrep'].includes(name)) {
      if (args.some((a) => /^-[a-zA-Z]*v/.test(a) || a === '--invert-match')) return true;
      const pattern = args.find((a) => !a.startsWith('-'));
      if (/waits/.test(pattern)) continue;
      if (/event/.test(pattern)) return false;
      return true;
    }
    if (['head', 'tail', 'awk'].includes(name)) return true;
    if (name === 'sed' && args.some((a) => a === '-n' || /(^|[\s;/'"])d($|[\s;}'"])/.test(a))) return true;
  }
  return false;
}

process.stdout.on('error', () => {});
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash') {
    const bad = pipelines(String(input.tool_input?.command)).some((stages) => stages.some((w) => w.some((x) => READS_WATCHER.test(x))) && drops(stages));
    if (bad) console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: "That filter can drop waits lines, and a dropped one is a card left waiting on you unseen. Read them whole with `rg '^waits' $O` (`| cut -c1-150` is fine); the watcher already prints a repeat once, on one `waits still waiting:` line.",
    } }));
  }
} catch {}
process.exitCode = 0;
