#!/usr/bin/env node
// A Claude Code PermissionDenied hook for the sessions the hub starts and resumes (sessions.mjs BG_SETTINGS): auto mode
// refused a Bash command, so it hands the hook's input to the hub on 127.0.0.1 (KICKFLIP_HUB_PORT, else 4500), which
// notes it under the board setting that allows that command (board/permissions.mjs recordRefusal). The hook can't
// reverse the refusal, so it prints nothing and always exits 0, whether or not the hub answered.
const BASE = `http://127.0.0.1:${Number(process.env.KICKFLIP_HUB_PORT || 4500)}`;

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
await fetch(`${BASE}/_hub/permission-denied`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw, signal: AbortSignal.timeout(5000) }).catch(() => {});
