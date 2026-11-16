import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fixedDate } from '../shared/fixed-clock.mjs';

// docs/adr/2026-11-15-0930-the-board-header-counts-what-waits-on-the-orchestrator.md
// docs/adr/2026-11-16-0856-the-waits-sheet-lists-one-row-per-card-for-what-the-orchestrator-owes-now.md
const NOW = new Date(2026, 10, 15, 12).getTime();
const context = vm.createContext({ Date: fixedDate(() => NOW), location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout });
for (const file of ['ui-icon-text.js', 'ui.js','ui-progress-bar.js', 'ui-icon-text.js', 'ui-waits.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
const { WAIT_WORDS, waitsRows, waitsTone, waitsChip, waitsList, waitsTitle } = context.BoardUI;

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]).replace(/\s+/g, ' ').trim();
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();
// The server sends each wait's tone (domain.mjs waitTone); the page draws it and computes none.
const toneAt = (kind, minutes) => (kind === 'limbo' ? 'grey' : minutes >= 30 ? 'red' : minutes >= 15 ? 'orange' : 'grey');
const wait = (ref, kind, minutes, title = `Task ${ref}`) => ({ key: `b/${ref}`, ref, title, kind, since: ago(minutes), tone: toneAt(kind, minutes) });
const triage = (id, minutes) => ({ key: id, ref: '2026-11-13', title: 'Overnight triage 2026-11-13', kind: 'triage', since: ago(minutes), tone: toneAt('triage', minutes) });

test("one row per card, for its oldest wait the orchestrator owes now, saying how many more; a lander's checking is not listed, an investigate only alone, and each no-card wait is its own row", () => {
  const rows = waitsRows([
    wait('T-1', 'answer', 5), wait('T-2', 'calls', 20), wait('T-1', 'reply', 9), wait('T-1', 'ask', 2),
    wait('T-3', 'checking', 40),
    wait('T-4', 'investigate', 50), wait('T-4', 'reply', 3),
    wait('T-5', 'investigate', 7),
    triage('ev-1', 1), triage('ev-2', 4),
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((r) => [r.key, r.kind, r.more]))), [
    ['b/T-1', 'reply', 2], ['b/T-2', 'calls', 0], ['b/T-4', 'reply', 0], ['b/T-5', 'investigate', 0], ['ev-1', 'triage', 0], ['ev-2', 'triage', 0],
  ]);
  assert.equal(waitsRows([wait('T-3', 'checking', 40)]).length, 0,'a checked build alone waits on its lander');
});

test('a freshly triaged card reads one row and counts one, and a card with two waits counts one', () => {
  const triaged = waitsRows([wait('T-458', 'investigate', 0)]);
  assert.equal(text(waitsList(triaged, [{ key: 'b/T-458' }])), 'T-458 Task T-458 investigate the task');
  assert.match(waitsChip(triaged), /aria-label="1 waiting on the orchestrator"[^]*<span class="q-badge tone-grey">1<\/span><\/button>$/);
  const two = waitsRows([wait('T-458', 'investigate', 1), wait('T-458', 'answer', 0)]);
  assert.match(waitsChip(two), /<span class="q-badge tone-grey">1<\/span><\/button>$/);
  assert.equal(text(waitsList(two, [{ key: 'b/T-458' }])), "T-458 Task T-458 act on the owner's answer");
  assert.equal(text(waitsList(waitsRows([wait('T-1', 'answer', 9), wait('T-1', 'reply', 3)]), [{ key: 'b/T-1' }])), "T-1 Task T-1 act on the owner's answer (9m) +1 more");
});

test("the count takes the strongest tone the server sent, red over orange over grey, whatever the wait's age, and limbo stays grey", () => {
  assert.equal(waitsTone([{ ...wait('T-1', 'calls', 100), tone: 'grey' }]), 'grey', 'the sent tone wins over the age');
  assert.equal(waitsTone([wait('T-1', 'intake', 2), wait('T-2', 'calls', 14)]), 'grey');
  assert.equal(waitsTone([wait('T-1', 'intake', 2), wait('T-2', 'calls', 15)]), 'orange');
  assert.equal(waitsTone([wait('T-1', 'intake', 29), wait('T-2', 'calls', 30)]), 'red');
  assert.equal(waitsTone([wait('T-1', 'limbo', 3000)]), 'grey');
  assert.match(waitsList([wait('T-1', 'limbo', 3000)], []), /class="waits-step it-grey"/);
});

test('the hourglass always shows, with no badge at 0, and otherwise badges the row count in the strongest tone', () => {
  const none = waitsChip([]);
  assert.match(none, /^<button type="button" class="ghost icon pages-switch waits-chip" data-waits aria-haspopup="dialog" aria-label="Nothing waiting on the orchestrator"/);
  assert.match(none, /<svg[^]*<\/svg><\/button>$/);
  assert.doesNotMatch(none, /q-badge/);
  const chip = waitsChip([wait('T-1', 'intake', 2), wait('T-2', 'calls', 34), wait('T-3', 'answer', 18)]);
  assert.match(chip, /^<button type="button" class="ghost icon pages-switch waits-chip" data-waits aria-haspopup="dialog" aria-label="3 waiting on the orchestrator"/);
  assert.match(chip, /<svg[^]*<\/svg><span class="q-badge tone-red">3<\/span><\/button>$/);
  assert.doesNotMatch(chip, /waiting<\/button>|it-dot/);
  assert.match(waitsChip([wait('T-1', 'calls', 20)]), /q-badge tone-orange/);
  assert.equal(waitsTitle(3), 'Waiting on the orchestrator · 3');
});

test("the list keeps the rows' order, each its ref, title, and step in plain words with its live duration in the age colour, no dot, a card's row opening the card", () => {
  const rows = [
    wait('T-9', 'calls', 34, 'Sidebar <remembers> folds'),
    wait('T-2', 'intake', 4),
    triage('ev-1', 0),
  ];
  const html = waitsList(rows, [{ key: 'b/T-9' }, { key: 'b/T-2' }]);
  assert.equal(text(html), "T-9 Sidebar <remembers> folds verify the builder's calls (34m) T-2 Task T-2 sort the new task (4m) 2026-11-13 Overnight triage 2026-11-13 run the overnight triage");
  assert.deepEqual(html.match(/<li[^>]*>/g), ['<li class="waits-row">', '<li class="waits-row">', '<li class="waits-row">']);
  assert.match(html, /<button type="button" class="waits-open" data-wait-open="b\/T-9">/);
  assert.equal((html.match(/data-wait-open=/g) || []).length, 2, 'the triage has no card to open');
  assert.match(html, /<span class="waits-step it-red">verify the builder&#39;s calls \(34m\)<\/span>/);
  assert.match(html, /<span class="waits-step it-grey">sort the new task \(4m\)<\/span>/);
  assert.doesNotMatch(html, /it-dot/);
});

test('every kind a wait can carry has plain words', () => {
  const domain = fs.readFileSync(new URL('./domain.mjs', import.meta.url), 'utf8');
  // A card's waits name their kind; an event's wait (domain.mjs eventWaits) takes the event's kind, its waitOf key.
  const kinds = new Set([...domain.matchAll(/kind: '([\w-]+)', since/g), ...domain.matchAll(/^ {4}'([\w-]+)': \(e\) =>/gm)].map((m) => m[1]));
  assert.ok(['intake', 'triage', 'calls', 'pr-review', 'slack-question'].every((k) => kinds.has(k)));
  for (const kind of kinds) assert.equal(typeof WAIT_WORDS[kind], 'string', `${kind} has no words`);
});
