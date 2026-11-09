// docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md: every event kind the board,
// the hub or a board page writes is record-only, or wakes the session with an action line and an entry in SKILL.md, and
// SKILL.md describes no event that nothing writes any more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RECORD_ONLY, PLAIN, ON_CARD, recordOnly } from './event-lines.mjs';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? (f.name === 'node_modules' ? [] : sources(path.join(dir, f.name)))
  : /\.m?js$/.test(f.name) && !/\.test\.mjs$/.test(f.name) && f.name !== 'event-lines.mjs' ? [path.join(dir, f.name)] : []));
const KIND = "'([a-z]+(?:-[a-z]+)*)'";
// A kind, or either side of a ternary between two.
const PICK = `(?:[\\w.!]+ \\? )?${KIND}(?: : ${KIND})?`;
const WRITERS = [
  new RegExp(`appendEvent\\((?:[^,()]+(?:\\([^()]*\\))?, )?${PICK}`, 'g'),
  new RegExp(`appendEvents\\((?:\\[(?:\\.\\.\\.\\([^?]*\\? )?|[\\w.]+\\.map\\(\\(\\w+\\) => )\\[\\[?${KIND},`, 'g'),
  new RegExp(`\\[\\[${KIND}, \\{`, 'g'),
  new RegExp(`sendToBoards\\([^;]*?, ${KIND}`, 'g'),
  new RegExp(`\\bevent\\(board, ${KIND}`, 'g'),
  new RegExp(`\\bsend\\(${PICK}`, 'g'),
  new RegExp(`\\w+: \\[${KIND}, \\{ key`, 'g'),
];
// Kinds a page sends that board/server.mjs's POST /_claude/events applies in code and records no event for: the Build
// and Merge taps, a wave's card move, an answers Send (each answer an owner-answer) and a reviewers Save (reviewers-*).
const NO_EVENT = ['card-build', 'card-merge', 'wave-move', 'owner-answers', 'reviewers'];

// Every kind the code writes: appendEvent and its callers, the hub's sendToBoards, and each page's send, with the
// thread's request map (Grill, Prototype, Visual).
function writtenKinds() {
  const kinds = new Set();
  for (const file of ['board', 'hub', 'bin', 'shared'].flatMap((d) => sources(path.join(root, d)))) {
    const s = fs.readFileSync(file, 'utf8');
    for (const re of WRITERS) for (const m of s.matchAll(re)) for (const k of m.slice(1).filter(Boolean)) kinds.add(k);
    for (const m of s.matchAll(/REQUEST_EVENT = \{([^}]*)\}/g)) for (const v of m[1].matchAll(/: '([a-z-]+)'/g)) kinds.add(v[1]);
  }
  for (const k of NO_EVENT) kinds.delete(k);
  return kinds;
}
const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
const event = (kind, data = { key: 'w/A1' }) => ({ id: 'e1', ts: '2026-11-07T10:00:00Z', kind, data });

test('the scan finds the writers it should, so a kind it misses is a scan to fix, not a pass', () => {
  const kinds = writtenKinds();
  for (const k of ['owner-answer', 'card-bump', 'card-unbump', 'grill-more', 'visual-request', 'usage-resumed', 'github-change', 'main-pulled', 'repo-changed', 'builder-ask', 'reviewers-added'])
    assert.ok(kinds.has(k), k);
  for (const k of NO_EVENT) assert.equal(kinds.has(k), false, k);
});

test('every kind the code writes is record-only, or has a line telling the session what to do', () => {
  const lined = (k) => Object.hasOwn(PLAIN, k) || Object.hasOwn(ON_CARD, k);
  const missing = [...writtenKinds()].filter((k) => !RECORD_ONLY.includes(k) && !lined(k));
  assert.deepEqual(missing, []);
});

test('every kind that wakes the session has an entry in SKILL.md', () => {
  const wakes = [...new Set([...writtenKinds(), ...Object.keys(PLAIN), ...Object.keys(ON_CARD)])].filter((k) => !recordOnly(JSON.stringify(event(k))));
  const absent = wakes.filter((k) => !new RegExp('`' + k + '[ `]').test(skill));
  assert.deepEqual(absent, []);
});

test('SKILL.md describes no event that nothing writes, and the record-only and line lists name only live kinds', () => {
  const known = new Set([...RECORD_ONLY, ...Object.keys(PLAIN), ...Object.keys(ON_CARD)]);
  const described = [...skill.matchAll(/`([a-z]+(?:-[a-z]+)+)(?: \{[^`]*\})?` event|`([a-z]+(?:-[a-z]+)+) \{[^`]*\}`/g)].map((m) => m[1] || m[2]);
  assert.deepEqual([...new Set(described.filter((k) => !known.has(k)))], []);
  for (const k of NO_EVENT) assert.equal(known.has(k), false, k);
});

test('usage-resumed and the taps the board applies itself are record-only; a bump, a typed message and an answer wake', () => {
  const quiet = (k) => recordOnly(JSON.stringify(event(k)));
  for (const k of ['usage-resumed', 'card-hold', 'card-done', 'card-unbump', 'grill-more', 'prototype-request', 'visual-request']) assert.equal(quiet(k), true, k);
  for (const k of ['card-bump', 'item-message', 'owner-answer', 'builder-ask', 'orchestrator-waits']) assert.equal(quiet(k), false, k);
  assert.equal(ON_CARD['card-bump']('#3', event('card-bump')), '#3 bumped: handle its waits lines first; with none, leave it');
});

test("every wait kind the board puts on the orchestrator's waits list is named in SKILL.md's Watch step, with what to do", () => {
  const domain = fs.readFileSync(path.join(root, 'board', 'domain.mjs'), 'utf8');
  const kinds = [...new Set([...domain.matchAll(/kind: '([a-z]+)', since/g)].map((m) => m[1]))];
  for (const k of ['ask', 'staging', 'screen', 'intake', 'triage', 'calls', 'stale']) assert.ok(kinds.includes(k), k);
  const watch = skill.split('\n').find((l) => l.startsWith('5. **Watch.**'));
  assert.deepEqual(kinds.filter((k) => !new RegExp('`' + k + '`(,| or| on)').test(watch)), []);
});

// docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md
test('a new task, a message in an ask thread and an agent-added card wake the session with what to do, and nothing hands intake off any more', () => {
  const wakes = (e) => !recordOnly(JSON.stringify(e));
  assert.equal(wakes({ id: 'a1', kind: 'ask', data: { text: 'Fix it' } }), true);
  assert.equal(wakes(event('card-added', { key: 'w/A2' })), true);
  assert.equal(wakes(event('item-message', { key: 'ask:a1', text: 'More' })), true);
  assert.equal(PLAIN.ask({ id: 'a1' }), 'new task a1 received: sort it: file it with item add --from-ask, fold it with item relate-ask, or answer it with reply');
  assert.equal(ON_CARD['card-added']('#7'), '#7 added by an agent: link it and file it: item notes, then item set --relate and --phase');
  assert.equal(ON_CARD['item-message']('the ask', event('item-message', { key: 'ask:a1' })), "message received from the ask's thread: reply in its thread");
  assert.equal(ON_CARD['item-message']('the ask', event('item-message', { key: 'ask:a1', text: '', intent: 'build' })), 'Implement asked on the ask: file it with item add --from-ask --phase ready, with its --size and notes');
  assert.equal(Object.hasOwn(ON_CARD, 'intake-handoff'), false);
});
