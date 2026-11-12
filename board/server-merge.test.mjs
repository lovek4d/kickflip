import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeGh, prView, writePR, writeReviews, calls } from '../shared/fake-gh.mjs';
import { freePorts, boardListening } from '../shared/test-helpers.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'server-merge-'));
let child;
after(() => { child?.kill(); fs.rmSync(home, { recursive: true, force: true }); });

// docs/adr/2026-11-04-2045-the-merge-tap-and-auto-merge-run-in-code.md
test("the Merge tap merges the card in the board server, and a refusal answers the owner and goes in the card's thread, with no event to wake the session", async () => {
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7, lane: 'review' }, { id: 'A2', title: 'Two', pr: 8, lane: 'progress' }] }));
  fs.writeFileSync(path.join(data, 'owner.json'), '{"items":[]}');
  const approval = (head) => [{ id: 1, user: { login: 'ann' }, state: 'APPROVED', submitted_at: '2026-11-04T10:00:00Z', commit_id: head }];
  writePR(home, 7, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', head: 'aaa' })); writeReviews(home, 7, approval('aaa'));
  writePR(home, 8, prView({ failing: ['build'] })); writeReviews(home, 8, []);
  const [port] = await freePorts();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs'), site], { env: { ...process.env, HOME: home, PORT: String(port), PREFIX: '', PATH: `${fakeGh(home)}:${process.env.PATH}` } });
  await boardListening(child);
  const tap = (key) => fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'card-merge', key }) });
  const items = () => JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8')).items;
  const thread = (key) => fs.readFileSync(path.join(data, 'threads', `${key.replace('/', '__')}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse).map((l) => l.text);
  const events = () => (fs.existsSync(path.join(data, 'events.jsonl')) ? fs.readFileSync(path.join(data, 'events.jsonl'), 'utf8') : '');

  const refused = await tap('t/A2');
  assert.equal(refused.status, 400);
  const why = 'Not merged: review: review required; failing: build; merge state: blocked.';
  assert.deepEqual(await refused.json(), { error: why });
  assert.deepEqual(thread('t/A2'), [why]);
  assert.equal(items()[1].lane, 'progress');

  const merged = await tap('t/A1');
  assert.equal(merged.status, 200);
  assert.deepEqual(calls(home).filter((a) => a[1] === 'merge'), [['pr', 'merge', '7', '--repo', 'o/r', '--squash', '--subject', 'feat: the work', '--body', 'Checked it.\n\nRefs: A1\nCo-Authored-By: Claude <noreply@anthropic.com>']]);
  assert.deepEqual([items()[0].lane, items()[0].prs.map((p) => [p.number, typeof p.merged_at])], ['done', [[7, 'string']]]);
  assert.equal(thread('t/A1').at(-1), 'Merged PR #7.');
  assert.doesNotMatch(events(), /card-merge/);
});
