import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// docs/adr/2026-11-09-1556-boards-read-pr-state-from-the-hubs-check.md: the board reads each PR from the hub's
// github-state.json and runs no gh of its own for it. docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md:
// while GitHub's limit holds GraphQL for gh's account, each PR carries the reset, for its badges to dim.
test("hub polling, the server's PR reads and cards follow manifest repo changes and retain the wave fallback", async () => {
  const reset = new Date(Date.now() + 3_600_000).toISOString();
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
  fs.writeFileSync(path.join(home, '.claude/kickflip/github-state.json'), JSON.stringify({ prs: Object.fromEntries(['new/project', 'another/project', 'old/project']
    .map((repo) => [`${repo}#7`, { state: 'OPEN', title: repo, isDraft: true, url: `https://github.com/${repo}/pull/7`, at: '2026-11-09T12:00:00.000Z' }])) }));
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
        if (github === 'another/project') fs.writeFileSync(${JSON.stringify(path.join(home, '.claude/kickflip/gh-limit.json'))}, JSON.stringify({ primary: { core: ${JSON.stringify(reset)} } }));
        if (github === undefined) fs.writeFileSync(${JSON.stringify(path.join(home, '.claude/kickflip/gh-limit.json'))}, JSON.stringify({ primary: { graphql: ${JSON.stringify(reset)} } }));
        const response = await new Promise((resolve) => {
          const req = { method: 'GET', url: '/api/board', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
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
      assert.equal(card.pr.limited, github ? null : reset, "only GraphQL's limit dims the badges, which the hub's check reads on it");
    }
    assert.equal(fs.existsSync(log), false, 'the board runs no gh for its PRs');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
