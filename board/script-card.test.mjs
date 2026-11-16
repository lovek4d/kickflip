import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// docs/adr/2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md
const context = vm.createContext({ location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout });
for (const file of ['ui-icon-text.js', 'ui.js','ui-links.js', 'ui-enums.js', 'ui-threads.js', 'ui-markdown.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
const ui = context.BoardUI;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]).replace(/\s+/g, ' ').trim();

const body = ['#!/bin/sh', ...Array.from({ length: 40 }, (_, i) => `echo "line ${i}" && kill <pid>`)].join('\n');
const offer = (script) => ui.threadMessages([{ ts: '2026-11-14T12:00:00Z', who: 'claude', text: 'Stops the stuck builder; my rules refuse kill.', script: { id: 's1', body, sha: 'abc', host: 'mac', user: 'love', ...script } }]);

test('a script offer shows where it runs and every line of the script, escaped, with Run to hold and Decline while it waits', () => {
  const html = offer({ state: 'waiting' });
  assert.match(text(html), /Stops the stuck builder; my rules refuse kill\. ⚠ Runs on mac as love Shell script · 41 lines/);
  assert.ok(text(html).includes(body.replace(/\n/g, ' ')));
  assert.doesNotMatch(html, /<pid>/);
  assert.match(html, /<button type="button" class="script-run resolves" data-script-run="s1" data-sha="abc">.*Hold to run<\/button><button type="button" data-script-decline="s1">Decline<\/button>/);
  assert.match(text(html), /Nothing runs until you hold Run\. Only the board’s owner can run it\./);
});

test('a script offer reads running with its live log, finished with its output folded, failed in red with its tail, declined or replaced, with no buttons', () => {
  const running = offer({ state: 'running', log: 'script-s1.log' });
  assert.match(text(running), /Running on mac… Live output/);
  assert.match(running, /href="log\.html\?file=script-s1\.log"/);

  const finished = offer({ state: 'finished', exit: 0, ms: 3100, output: 'one\ntwo\n', log: 'script-s1.log' });
  assert.match(text(finished), /✓ Finished · exit 0 · 3\.1 s Output · 2 lines one two Full output/);
  assert.match(finished, /<details class="script-fold"><summary>/);

  const output = Array.from({ length: 30 }, (_, i) => `out ${i}`).join('\n') + '\n';
  const failed = offer({ state: 'failed', exit: 137, ms: 600000, timedOut: true, output, log: 'script-s1.log' });
  assert.match(failed, /class="script-offer failed"/);
  assert.match(text(failed), /✕ Failed · exit 137 · 600\.0 s · stopped at its time limit out 10 .* out 29 Full output/);
  assert.doesNotMatch(text(failed), /out 9 /);

  assert.match(text(offer({ state: 'declined' })), /Declined · nothing ran \d/);
  assert.match(text(offer({ state: 'replaced' })), /Replaced by a newer script · nothing ran \d/);
  for (const state of ['running', 'finished', 'failed', 'declined', 'replaced']) assert.doesNotMatch(offer({ state, exit: 1, output: '' }), /data-script-run|data-script-decline/, state);
});
