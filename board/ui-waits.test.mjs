import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fixedDate } from '../shared/fixed-clock.mjs';

// docs/adr/2026-11-15-0930-the-board-header-counts-what-waits-on-the-orchestrator.md
const NOW = new Date(2026, 10, 15, 12).getTime();
const context = vm.createContext({ Date: fixedDate(() => NOW), location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout });
for (const file of ['ui-icon-text.js', 'ui.js','ui-progress-bar.js', 'ui-icon-text.js', 'ui-waits.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
const { WAIT_WORDS, waitsTone, waitsChip, waitsList, waitsTitle } = context.BoardUI;

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]).replace(/\s+/g, ' ').trim();
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();
// The server sends each wait's tone (domain.mjs waitTone); the page draws it and computes none.
const toneAt = (kind, minutes) => (kind !== 'limbo' && minutes >= 30 ? 'red' : minutes >= 15 ? 'orange' : 'grey');
const wait = (ref, kind, minutes, title = `Task ${ref}`) => ({ key: `b/${ref}`, ref, title, kind, since: ago(minutes), tone: toneAt(kind, minutes) });

test("the count takes the strongest tone the server sent, red over orange over grey, whatever the wait's age", () => {
  assert.equal(waitsTone([{ ...wait('T-1', 'calls', 100), tone: 'grey' }]), 'grey', 'the sent tone wins over the age');
  assert.equal(waitsTone([wait('T-1', 'intake', 2), wait('T-2', 'calls', 14)]), 'grey');
  assert.equal(waitsTone([wait('T-1', 'intake', 2), wait('T-2', 'calls', 15)]), 'orange');
  assert.equal(waitsTone([wait('T-1', 'intake', 29), wait('T-2', 'calls', 30)]), 'red');
  // docs/adr/2026-11-15-1600-a-card-owing-nobody-or-with-the-owners-word-last-waits-on-the-orchestrator.md: a limbo
  // wait is the orchestrator's backlog, so it goes no further than orange, its row too.
  assert.equal(waitsTone([wait('T-1', 'limbo', 3000)]), 'orange');
  assert.match(waitsList([wait('T-1', 'limbo', 3000)], []), /it-orange/);
  assert.equal(waitsTone([wait('T-1', 'limbo', 10)]), 'grey');
});

test('the chip is gone at 0, and otherwise counts the waits as "n waiting" at every width, in the oldest wait\'s colour', () => {
  assert.equal(waitsChip([]), '');
  const chip = waitsChip([wait('T-1', 'intake', 2), wait('T-2', 'calls', 34), wait('T-3', 'answer', 18)]);
  assert.match(chip, /^<button type="button" class="waits-chip" data-waits aria-haspopup="dialog" aria-label="3 waiting on the orchestrator"/);
  assert.match(chip, /<span class="it it-red"><span class="it-i it-dot" aria-hidden="true"><\/span><\/span>/);
  assert.match(chip, /<span class="it-i it-dot" aria-hidden="true"><\/span><\/span>3 waiting<\/button>$/);
  assert.doesNotMatch(chip, /on orchestrator<\/|class="(short|full)"/);
  assert.equal(waitsTitle(3), 'Waiting on the orchestrator · 3');
});

test('the list keeps the file\'s order, each row its ref, title, kind in plain words and live duration, a card\'s row opening the card', () => {
  const waits = [
    wait('T-9', 'calls', 34, 'Sidebar <remembers> folds'),
    wait('T-2', 'intake', 4),
    { key: 'ev-1', ref: '2026-11-13', title: 'Overnight triage 2026-11-13', kind: 'triage', since: ago(0), tone: 'grey' },
  ];
  const html = waitsList(waits, [{ key: 'b/T-9' }, { key: 'b/T-2' }]);
  assert.equal(text(html), "T-9 Sidebar <remembers> folds verify the builder's calls (34m) T-2 Task T-2 sort the new task (4m) 2026-11-13 Overnight triage 2026-11-13 run the overnight triage");
  const rows = html.match(/<li[^>]*>/g);
  assert.deepEqual(rows, ['<li class="waits-row">', '<li class="waits-row">', '<li class="waits-row">']);
  assert.match(html, /<button type="button" class="waits-open" data-wait-open="b\/T-9">/);
  assert.equal((html.match(/data-wait-open=/g) || []).length, 2, 'the triage has no card to open');
  assert.match(html, /<span class="it it-red">[^]*\(34m\)/);
  assert.match(html, /<span class="it it-grey">[^]*\(4m\)/);
});

test('every kind a wait can carry has plain words', () => {
  const domain = fs.readFileSync(new URL('./domain.mjs', import.meta.url), 'utf8');
  // A card's waits name their kind; an event's wait (domain.mjs eventWaits) takes the event's kind, its waitOf key.
  const kinds = new Set([...domain.matchAll(/kind: '([\w-]+)', since/g), ...domain.matchAll(/^ {4}'([\w-]+)': \(e\) =>/gm)].map((m) => m[1]));
  assert.ok(['intake', 'triage', 'calls', 'pr-review', 'slack-question'].every((k) => kinds.has(k)));
  for (const kind of kinds) assert.equal(typeof WAIT_WORDS[kind], 'string', `${kind} has no words`);
});
