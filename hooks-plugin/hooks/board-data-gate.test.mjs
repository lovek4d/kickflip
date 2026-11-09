import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./board-data-gate.mjs', import.meta.url));
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };

test('Edit and Write on board JSON and card notes are denied with the board.mjs command; drafts, other sites and other tools pass', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-data-gate-')));
  const sites = path.join(home, '.claude', 'kickflip', 'sites');
  const board = path.join(sites, 'orch');
  const page = path.join(sites, 'page');
  write(path.join(home, '.claude', 'kickflip', 'manifest.json'), { sites: {
    orch: { dir: board, port: 1, cmd: [process.execPath, '/skill/board/server.mjs', board] },
    page: { dir: page, port: 2, cmd: ['node', 'server.mjs'] },
  } });
  write(path.join(board, 'board.json'), { items: 'waves' });
  const run = (tool_name, file_path, name = 'PreToolUse') => {
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: name, tool_name, tool_input: { file_path } }), env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.deepEqual([r.status, r.stderr], [0, '']);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  const denied = (tool, file) => { const o = run(tool, file); assert.equal(o?.permissionDecision, 'deny', file); return o.permissionDecisionReason; };

  assert.match(denied('Edit', path.join(board, 'data', 'owner.json')), /board\.mjs/);
  assert.match(denied('Write', path.join(board, 'data', 'agents', 'x.json')), /board\.mjs/);
  assert.match(denied('Edit', path.join(board, 'board.json')), /rules\|reviewers/);
  assert.match(denied('Write', path.join(home, '.claude', 'waves', 'w', 'wave.json')), /item add\|set/);
  assert.match(denied('Edit', path.join(board, 'data', 'sub', '..', 'items.json')), /board\.mjs/);

  // docs/adr/2026-11-09-1100-the-board-owns-a-cards-notes-file.md
  assert.match(denied('Edit', path.join(board, 'data', 'a-notes.md')), /item notes <file>\/<id> --heading/);
  assert.match(denied('Write', path.join(home, '.claude', 'waves', 'w', 'a1-notes.md')), /item notes/);
  for (const ok of [path.join(board, 'drafts', 'a1-grill.md'), path.join(board, 'drafts', 'q-x.json'), path.join(page, 'data', 'x.json'), path.join(home, 'other.json')]) assert.equal(run('Write', ok), null, ok);
  assert.equal(run('Read', path.join(board, 'data', 'owner.json')), null);
  assert.equal(run('Edit', path.join(board, 'data', 'owner.json'), 'PostToolUse'), null);

  write(path.join(board, 'board.json'), { items: 'data/items.json' });
  assert.match(denied('Edit', path.join(board, 'data', 'items.json')), /item add\|set/);
  assert.equal(run('Write', path.join(home, '.claude', 'waves', 'w', 'wave.json')), null);
  fs.rmSync(home, { recursive: true, force: true });
});
