import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBoard } from '../shared/test-helpers.mjs';
import { listBoards } from '../hub/boards.mjs';

// docs/adr/2026-11-09-1556-boards-read-pr-state-from-the-hubs-check.md: the board reads each PR from the hub's
// github-state.json and runs no gh of its own for it. docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md:
// while GitHub's limit holds GraphQL for gh's account, each PR carries the reset, for its badges to dim.
test("hub polling, the server's PR reads and cards follow manifest repo changes and retain the wave fallback", async (t) => {
  const reset = new Date(Date.now() + 3_600_000).toISOString();
  const site = path.join(home, 'site');
  const bin = path.join(home, 'bin');
  const manifestFile = path.join(home, '.claude/kickflip/manifest.json');
  const limitFile = path.join(home, '.claude/kickflip/gh-limit.json');
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
  process.env.PATH = `${bin}:${process.env.PATH}`;
  fs.writeFileSync(path.join(home, '.claude/kickflip/github-state.json'), JSON.stringify({ prs: Object.fromEntries(['new/project', 'another/project', 'old/project']
    .map((repo) => [`${repo}#7`, { state: 'OPEN', title: repo, isDraft: true, url: `https://github.com/${repo}/pull/7`, at: '2026-11-09T12:00:00.000Z' }])) }));
  const entry = { dir: site, cmd: [process.execPath, fileURLToPath(new URL('./server.mjs', import.meta.url))] };
  const { base } = await startBoard(t, { site });
  for (const github of ['new/project', 'another/project', undefined]) {
    fs.writeFileSync(manifestFile, JSON.stringify({ sites: { board: { ...entry, github } } }));
    if (github === 'another/project') fs.writeFileSync(limitFile, JSON.stringify({ primary: { core: reset } }));
    if (github === undefined) fs.writeFileSync(limitFile, JSON.stringify({ primary: { graphql: reset } }));
    const repo = github || 'old/project';
    assert.equal(listBoards()[0].prs[0].repo, repo);
    const response = await fetch(`${base}/api/board`);
    assert.equal(response.status, 200);
    const card = (await response.json()).items.find((item) => item.id === 'A1');
    assert.equal(card.repo, repo);
    assert.equal(card.pr.title, repo);
    assert.equal(card.pr.url, `https://github.com/${repo}/pull/7`);
    assert.equal(card.pr.limited, github ? null : reset, "only GraphQL's limit dims the badges, which the hub's check reads on it");
  }
  assert.equal(fs.existsSync(log), false, 'the board runs no gh for its PRs');
});
