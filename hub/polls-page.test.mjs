import { inProcessHub } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { pollsPage, pollLine } from './polls-page.mjs';
import { POLLS, GROUPS } from '../shared/polls.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the Polls page lists every poll under its group, fastest first, with its cadence, where it runs and file:line', () => {
  const html = pollsPage({ lineOf: (p) => `${p.where}:7` });
  const groups = [...html.matchAll(/<details class="poll-group[^"]*" open><summary><h2>([^<]+)<\/h2><span class="count">(\d+)<\/span>/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(groups, GROUPS.map((g) => [g.name, POLLS.filter((p) => p.group === g.id).length]));
  for (const g of GROUPS) {
    const section = html.split(`<h2>${g.name}</h2>`)[1].split('<details class="poll-group')[0];
    const names = [...section.matchAll(/<b class="poll-name">([^<]+)<\/b>/g)].map((m) => m[1]);
    const order = POLLS.filter((p) => p.group === g.id).sort((a, b) => a.every - b.every).map((p) => p.name);
    assert.deepEqual(names, order, g.id);
  }
  const plain = text(html);
  assert.match(plain, /Reconcile [^.]+\. Hub hub\/hub\.mjs:7 every 2 s \(2 × 1 s\)/);
  assert.match(plain, /Nightly suite check .* every 15 min \(60 × 15 s\)/);
  assert.match(plain, /Board check, stream down [^.]+\. Each open page board\/public\/app\.js:7 every 15 s/);
  assert.match(plain, /Review digest .* quiet hours’ end/);
  // Tick and Board minute open into their steps; back-offs are greyed.
  assert.match(html, /<details class="poll-steps"><summary>[\s\S]*?Tick[\s\S]*?11 steps/);
  assert.match(html, /<details class="poll-steps"><summary>[\s\S]*?Board minute[\s\S]*?12 steps/);
  assert.match(html, /<details class="poll-group muted" open><summary><h2>Back-offs, not polls<\/h2>/);
  assert.doesNotMatch(plain, /Board stream ping|End unshared/);
});

test("a poll's line is its `poll: <id>` comment's in its file", () => {
  const reconcile = POLLS.find((p) => p.id === 'reconcile');
  const n = fs.readFileSync(path.join(ROOT, 'hub/hub.mjs'), 'utf8').split('\n').findIndex((l) => l.includes('poll: reconcile')) + 1;
  assert.ok(n > 0);
  assert.equal(pollLine(reconcile), `hub/hub.mjs:${n}`);
});

test('the hub serves the Polls page, and hub settings link it', async (t) => {
  const hub = await inProcessHub(t);
  const r = await fetch(`${hub.base}/_hub/polls`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const html = await r.text();
  assert.match(html, /<a class="back" href="\/_hub\/">‹ Hub<\/a><h1>Polls<\/h1>/);
  assert.match(html, /hub\/hub\.mjs:\d+/);

  const context = { HubUI: { esc: (s) => String(s) }, HubKit: { durationPicker: () => '' } };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'board/public/view-hub-settings.js'), 'utf8'), context);
  assert.match(context.HubSettings.markup(), /<a class="hub-setting" id="polls" href="\/_hub\/polls">.*Polls.*<\/a>/);
});
