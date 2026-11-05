#!/usr/bin/env node
// A PreToolUse hook on Edit|Write that refuses a hand edit of the JSON files board.mjs owns on a board site: the
// site's board.json, every .json under its data/, and the wave file(s) board.json's `items` names. It denies, not asks,
// because a headless session has nobody to ask, and the reason names the board.mjs command that makes the change.
// Notes .md files, question drafts (<site>/drafts/) and Bash writes stay open
// (docs/adr/2026-11-05-2330-a-hook-refuses-hand-edits-to-board-data-files.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listBoards } from '../../hub/boards.mjs';

process.stdout.on('error', () => {});

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (dir, file) => !path.relative(dir, file).startsWith('..') && !path.isAbsolute(path.relative(dir, file));

// → the file's kind on this board ('wave', 'board' or 'data'), or null when it is not board-owned
function ownedKind(board, file) {
  const dir = real(board.dir);
  let items = 'waves';
  try { items = JSON.parse(fs.readFileSync(path.join(dir, 'board.json'), 'utf8')).items || 'waves'; } catch {}
  if (file === path.join(dir, 'board.json')) return 'board';
  if (items === 'waves' ? path.basename(file) === 'wave.json' && inside(real(path.join(os.homedir(), '.claude', 'waves')), file) : file === real(path.resolve(dir, items))) return 'wave';
  if (file.endsWith('.json') && inside(path.join(dir, 'data'), file)) return 'data';
  return null;
}

const HINTS = {
  wave: 'A card changes with `board.mjs --site <route> item add|set <wave>/<id> …`',
  board: 'Board settings change with `board.mjs --site <route> rules|reviewers …` or the settings page',
  data: 'Board data changes with a board.mjs command (`item set`, `thread`, `topic add`, `question add --file <draft>`, `reply`, `builder …`); its usage text lists them',
};

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const target = input.tool_input?.file_path;
  if (input.hook_event_name === 'PreToolUse' && ['Edit', 'Write'].includes(input.tool_name) && typeof target === 'string') {
    const file = path.join(real(path.dirname(path.resolve(target))), path.basename(target));
    for (const board of listBoards()) {
      const kind = ownedKind(board, file);
      if (!kind) continue;
      console.log(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: `${path.basename(file)} is board data on /${board.route}, and a hand edit skips the checks the pages rely on. ${HINTS[kind]}. A change board.mjs can't make needs a new board.mjs command. Question drafts go in ${path.join(board.dir, 'drafts')}/, where Edit and Write stay open.`,
      } }));
      break;
    }
  }
} catch {}
process.exitCode = 0;
