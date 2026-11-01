import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('hub polling, server PR fetches and cards follow manifest repo changes and retain the wave fallback', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-repo-')));
  const site = path.join(home, 'site');
  const bin = path.join(home, 'bin');
  const manifestFile = path.join(home, '.claude/kickflip/manifest.json');
  const log = path.join(home, 'gh.jsonl');
  fs.mkdirSync(site);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ items: 'wave.json', slug: 'w' }));
  fs.writeFileSync(path.join(site, 'wave.json'), JSON.stringify({ repo: 'old/project', items: [{ id: 'A1', pr: 7 }] }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
const repo = argv[argv.indexOf('--repo') + 1];
console.log(JSON.stringify(argv[0] === 'api' ? [] : { state: 'OPEN', title: repo, isDraft: true }));
`, { mode: 0o755 });
  const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
  const entry = { dir: site, cmd: [process.execPath, server] };
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import http from 'node:http';
      import { mock } from 'node:test';
      let server;
      mock.method(http.Server.prototype, 'listen', function () { server = this; return this; });
      process.argv[2] = ${JSON.stringify(site)};
      await import(${JSON.stringify(server)});
      const { listBoards } = await import(${JSON.stringify(fileURLToPath(new URL('../hub/boards.mjs', import.meta.url)))});
      const results = [];
      for (const github of ['new/project', 'another/project', undefined]) {
        fs.writeFileSync(${JSON.stringify(manifestFile)}, JSON.stringify({ sites: { board: { ...${JSON.stringify(entry)}, github } } }));
        const response = await new Promise((resolve) => {
          const req = { method: 'GET', url: '/api/board', headers: {} };
          const res = {
            req,
            writeHead(status) { this.status = status; return this; },
            end(body) { resolve({ status: this.status, body: JSON.parse(body) }); },
          };
          server.emit('request', req, res);
        });
        results.push({ github, polled: listBoards()[0].prs[0].repo, ...response });
      }
      console.log(JSON.stringify(results));
      process.exit(0);
    `], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    const results = JSON.parse(result.stdout);
    assert.equal(results.length, 3);
    for (const { github, polled, status, body } of results) {
      const repo = github || 'old/project';
      assert.equal(polled, repo);
      assert.equal(status, 200);
      const card = body.items.find((item) => item.id === 'A1');
      assert.equal(card.repo, repo);
      assert.equal(card.pr.title, repo);
      assert.equal(card.pr.url, `https://github.com/${repo}/pull/7`);
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(calls.some((argv) => argv[0] === 'pr' && argv[argv.indexOf('--repo') + 1] === repo));
      assert.ok(calls.some((argv) => argv[0] === 'api' && argv[1] === `repos/${repo}/pulls/7/comments?per_page=100`));
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
