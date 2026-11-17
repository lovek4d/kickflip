#!/usr/bin/env node
// A Claude Code PermissionRequest hook for the background sessions the hub starts and resumes (sessions.mjs
// BG_SETTINGS): it hands the prompt to the hub on 127.0.0.1 (KICKFLIP_HUB_PORT, else 4500), waits for the owner's answer
// on its board's page or the hub page, and prints it as the decision (docs/adr/2026-10-30-1516-background-sessions-prompts-come-to-the-phone.md).
// A hook that times out or prints no decision leaves the session on a dialog nobody sees, so every path prints one
// and exits 0 before BG_SETTINGS's timeout: a deny with a note when the hub can't be reached, drops the prompt or
// the owner doesn't answer by the hub's deadline.
import fs from 'node:fs';

const BASE = `http://127.0.0.1:${Number(process.env.KICKFLIP_HUB_PORT || 4500)}`;
// The longest this waits, whatever deadline the hub gives; prompts.mjs WAIT_MS.
const WAIT_CAP = 10 * 60_000;
const HARD_STOP = WAIT_CAP + 30_000;
const RETRY_MS = 2000; // poll: permission-hook-retry

const FALLBACK = "The hub's permission hook failed; ask this as an open question on your board's task instead.";
const deny = (message) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } });

let printed = false;
function finish(out) {
  if (printed) return;
  printed = true;
  fs.writeSync(1, JSON.stringify(out) + '\n');
  process.exit(0);
}
process.on('uncaughtException', () => finish(deny(FALLBACK)));
process.on('unhandledRejection', () => finish(deny(FALLBACK)));
setTimeout(() => finish(deny(FALLBACK)), HARD_STOP).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const { hookOutput, NO_ANSWER, UNREACHABLE, DROPPED, POLL_MS } = await import('./prompts.mjs');

  let id;
  let deadline;
  // A hub that is down refuses at once; a slow one is waited for, up to HARD_STOP
  // (docs/adr/2026-11-13-2232-the-permission-hook-waits-for-a-slow-hub-to-take-its-prompt.md).
  try {
    const r = await fetch(`${BASE}/_hub/prompts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    if (!r.ok) throw new Error(`hub ${r.status}`);
    const body = await r.json();
    if (body?.state === 'answered') {
      if (input.tool_name !== 'AskUserQuestion' && body.answer?.choice === 'allow') return finish(hookOutput(input, body.answer));
      return finish(deny(FALLBACK));
    }
    ({ id, deadline } = body);
  } catch { return finish(deny(UNREACHABLE)); }
  const until = Math.min(Date.parse(deadline) || Infinity, Date.now() + WAIT_CAP);

  for (let left = until - Date.now(); left > 0; left = until - Date.now()) {
    const ms = Math.min(POLL_MS, left);
    let r;
    try {
      r = await fetch(`${BASE}/_hub/prompts/${encodeURIComponent(id)}/wait?ms=${ms}`, { signal: AbortSignal.timeout(ms + 10_000) });
    } catch { await sleep(Math.min(RETRY_MS, Math.max(0, until - Date.now()))); continue; }
    if (r.status === 404) return finish(deny(DROPPED));
    let body = null;
    try { body = await r.json(); } catch {}
    if (body?.state === 'answered') return finish(hookOutput(input, body.answer));
    if (!r.ok) await sleep(Math.min(RETRY_MS, Math.max(0, until - Date.now())));
  }
  try { await fetch(`${BASE}/_hub/prompts/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(2000) }); } catch {}
  return finish(deny(NO_ANSWER));
}

main().catch(() => finish(deny(FALLBACK)));
