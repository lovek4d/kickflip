import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { freePorts } from '../shared/test-helpers.mjs';

// docs/adr/2026-11-16-1500-new-code-restarts-on-a-busy-board-once-no-land-is-landing.md
// The hub stops a board server with SIGTERM for new code; the server finishes the passes and requests it has started
// (close()) and exits 0, rather than dying partway through a write.
test('a board server run as a script exits 0 on SIGTERM once its started passes have finished', async (t) => {
  const site = path.join(home, 'site');
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(site, 'data', 'owner.json'), '{"items":[]}');
  const [port] = await freePorts(1);
  const server = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), site], {
    env: { ...process.env, PORT: String(port), KICKFLIP_CLAUDE: 'true', KICKFLIP_CODEX: 'true' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => server.kill('SIGKILL'));
  let out = '';
  server.stdout.on('data', (chunk) => { out += chunk; });
  while (!out.includes('site on http')) await once(server.stdout, 'data');
  server.kill('SIGTERM');
  const [code, signal] = await once(server, 'exit');
  assert.deepEqual([code, signal], [0, null]);
});
