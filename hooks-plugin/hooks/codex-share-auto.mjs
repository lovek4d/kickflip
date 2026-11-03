#!/usr/bin/env node
// SessionStart and UserPromptSubmit: every session runs as the hub setting (docs/adr/0105-the-hubs-codex-share-is-the-only-codex-setting.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexStatus, effectiveCodexShare } from '../../shared/codex.mjs';

process.stdout.on('error', () => {});
try {
  let stored;
  try { stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'kickflip', 'settings.json'), 'utf8')).codexShare; } catch {}
  const codexShare = effectiveCodexShare(stored, codexStatus());
  const pick = 'Before each build, run `board.mjs builder pick <key>`: it prints codex or claude (with its model) and why, from this setting and the pause line, and builder start refuses the other kind (--kind build takes the pick). Hand codex builds and reviews to Codex as ~/.claude/skills/codex-share/SKILL.md describes (read it first).';
  if (codexShare === 'auto') {
    console.log(`The hub's Codex setting is auto: run as codex-share auto. ${pick} When Codex reports it is out of usage, Opus builders take over until it resets.`);
  } else if (codexShare === 'always') {
    console.log(`The hub's Codex setting is always on: run as codex-share on. ${pick} When Codex reports it is out of usage, pause that work until the usage-reset probe answers.`);
  }
} catch { /* Errors are silent and never fail the session. */ }
process.exitCode = 0;
