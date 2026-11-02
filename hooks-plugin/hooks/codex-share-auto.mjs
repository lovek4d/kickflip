#!/usr/bin/env node
// SessionStart and UserPromptSubmit: the hub setting is the default for every session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexStatus, effectiveCodexShare } from '../../shared/codex.mjs';
import { readUsageGate } from '../../shared/usage-gate.mjs';

process.stdout.on('error', () => {});
try {
  let stored;
  try { stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'kickflip', 'settings.json'), 'utf8')).codexShare; } catch {}
  const codexShare = effectiveCodexShare(stored, codexStatus());
  const line = readUsageGate().pause_at;
  if (codexShare === 'auto') {
    console.log(`The hub's Codex setting is auto: unless this session's codex-share-mode file says otherwise, run as codex-share auto. Hand implementation and review to Codex as ~/.claude/skills/codex-share/SKILL.md describes (read it first); while Codex is past the pause line (${line}%) or out of usage, Opus builders take over until it resets. Say so in one line the first time it applies in this session.`);
  } else if (codexShare === 'always') {
    console.log(`The hub's Codex setting is always on: unless this session's codex-share-mode file says otherwise, run as codex-share on. Hand implementation and review to Codex as ~/.claude/skills/codex-share/SKILL.md describes (read it first); while Codex is past the pause line (${line}%), Opus builders take over until it resets, and while Codex is out of usage, pause that work until the usage-reset probe answers. Say so in one line the first time it applies in this session.`);
  }
} catch { /* Errors are silent and never fail the session. */ }
process.exitCode = 0;
