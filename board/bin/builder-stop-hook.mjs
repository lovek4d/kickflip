#!/usr/bin/env node
// A Claude Code SubagentStop hook: closes the builder records a subagent started and left open.
// Claude Code passes {agent_transcript_path, …} on stdin. It may run more than once for one agent,
// and a non-zero exit or stdout output would reach the session, so it is quiet and always exits 0.
import fs from 'node:fs';
import os from 'node:os';

// A record is the agent's own only if it started between its command and this long after the command's
// result; one started later belongs to an agent that restarted the item.
const START_WINDOW_MS = 2 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 1000;

const START = /(?:\bbuilder|\bagent\.mjs)\s+start\s+["']?([^\s"';|&]+)/g;
const flagIn = (text, name) => {
  const re = new RegExp(`--${name}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s"';|&)]+))`, 'g');
  let last;
  for (const m of text.matchAll(re)) last = m[1] ?? m[2] ?? m[3];
  return last;
};

// Each `builder start <key>` in one shell command → {key, site, agent, dir}. The --site can sit earlier in
// the command, as in B="node board.mjs --site <route>"; eval "$B builder start <key>".
function startsIn(command) {
  const found = [];
  for (const m of command.matchAll(START)) {
    const rest = command.slice(m.index);
    const segment = rest.slice(0, rest.search(/\n|;|&&|\|\||\|(?!\|)|$/));
    found.push({
      key: m[1],
      site: flagIn(segment, 'site') ?? flagIn(command.slice(0, m.index), 'site') ?? null,
      agent: flagIn(segment, 'agent') ?? 'main',
      dir: flagIn(segment, 'dir'),
    });
  }
  return found;
}

const expandHome = (p) => p.replace(/^~(?=\/|$)/, os.homedir()).replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, os.homedir());

function startsInTranscript(text) {
  const starts = [];
  const pending = new Map();
  for (const line of text.split('\n')) {
    const isStart = line.includes('"assistant"') && / start/.test(line) && /builder|agent\.mjs/.test(line);
    const isResult = pending.size && line.includes('tool_result') && [...pending.keys()].some((id) => line.includes(id));
    if (!isStart && !isResult) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const at = Date.parse(entry.timestamp);
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    if (entry.type === 'assistant' && !Number.isNaN(at)) {
      for (const c of content) {
        if (c?.type !== 'tool_use' || typeof c.input?.command !== 'string') continue;
        const found = startsIn(c.input.command).map((s) => ({ ...s, from: at - CLOCK_SKEW_MS, to: at + START_WINDOW_MS }));
        starts.push(...found);
        if (c.id && found.length) pending.set(c.id, found);
      }
    } else if (entry.type === 'user' && !Number.isNaN(at)) {
      for (const c of content) {
        const found = c?.type === 'tool_result' && pending.get(c.tool_use_id);
        if (!found) continue;
        for (const s of found) s.to = Math.max(s.to, at + START_WINDOW_MS);
        pending.delete(c.tool_use_id);
      }
    }
  }
  return starts;
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const transcript = input?.agent_transcript_path;
  if (typeof transcript !== 'string' || !transcript) throw new Error('no agent_transcript_path on stdin');
  const starts = startsInTranscript(fs.readFileSync(transcript, 'utf8'));
  if (!starts.length) return;
  (await import('../../bin/install.mjs')).migrateOnStart();
  const store = await import('../store.mjs');
  for (const s of starts) {
    try {
      if (s.site !== null && !/^[\w-]+$/.test(s.site)) throw new Error(`--site ${s.site} is not a route`);
      if (s.dir?.includes('$')) throw new Error(`--dir ${s.dir} names a shell variable`);
      if (s.key.includes('$') || s.agent.includes('$')) throw new Error('the key or --agent names a shell variable');
      const site = s.site === null ? null : await store.siteDir(s.site);
      const dir = s.dir === undefined ? undefined : expandHome(s.dir);
      await store.stopBuilder(site, s.key, { dir, agent: s.agent, startedBetween: [s.from, s.to] });
    } catch (e) {
      process.stderr.write(`builder-stop-hook: ${s.key}${s.agent === 'main' ? '' : ` --agent ${s.agent}`}: ${e.message}\n`);
    }
  }
}

try { await main(); } catch (e) { process.stderr.write(`builder-stop-hook: ${e.message}\n`); }
process.exitCode = 0;
