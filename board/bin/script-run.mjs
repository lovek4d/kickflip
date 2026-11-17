#!/usr/bin/env node
// node board/bin/script-run.mjs <site> <key> <id> <cwd>: runs the script offer id on card key, whose Run the board
// server has recorded, once, in cwd, its output in ~/.claude/kickflip/logs/script-<id>.log, then posts its
// script-result event (docs/adr/2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md). The
// server starts it detached, so a restart of the server doesn't stop the run.
import path from 'node:path';
import { readScriptOffer, recordScriptResult } from '../cards.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { logsDir, runScript, scriptLogName, scriptPidName } from '../scripts.mjs';

const [site, key, id, cwd] = process.argv.slice(2);
mkdirSync(logsDir(), { recursive: true });
writeFileSync(path.join(logsDir(), scriptPidName(id)), String(process.pid));
const { offer } = await readScriptOffer(site, key, id);
const { exit, timedOut, output, ms } = await runScript({ body: offer.body, cwd, log: path.join(logsDir(), scriptLogName(id)) });
await recordScriptResult(site, key, id, { exit, timedOut, output, ms });
