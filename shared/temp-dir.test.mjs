// docs/adr/2026-11-22-2345-a-closed-tasks-worktree-goes-and-the-hub-sweeps-what-is-left.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const script = `import { tempDir } from ${JSON.stringify(new URL('./temp-dir.mjs', import.meta.url).href)};
console.log(tempDir('signalled-'));
setInterval(() => {}, 1000);
`;

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`a process ended by ${signal} removes the temp dirs it made, and still ends by that signal`, async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    const dir = await new Promise((resolve) => child.stdout.setEncoding('utf8').once('data', (d) => resolve(d.trim())));
    assert.ok(fs.existsSync(dir));
    const ended = new Promise((resolve) => child.once('exit', (code, sig) => resolve(sig)));
    child.kill(signal);
    assert.equal(await ended, signal);
    assert.equal(fs.existsSync(dir), false);
  });
}
