// docs/adr/2026-11-18-1300-requests-arrive-as-a-signal-and-inbox-read-hands-over-the-words.md: the watcher and the
// PostToolUse hook only signal the owner's new words; board.mjs inbox read prints them and stamps each one picked up
// (thinking…) in the same command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { board, site, write, read } from './board-fixture.mjs';

const events = () => site('orch', 'data', 'events.jsonl');
const add = (id, kind, data, ts = new Date().toISOString()) => fs.appendFileSync(events(), JSON.stringify({ id, ts, kind, data }) + '\n');
const stamps = (file) => (fs.existsSync(site('orch', 'data', file)) ? read(site('orch', 'data', file)).events : {});

test("inbox read prints the owner's unread words on a card, or all of them, and stamps each picked up as it prints it", async () => {
  write(site('orch', 'data', 'delivered.json'), { since: '2026-10-23T09:00:00.000Z', events: {} });
  add('m1', 'item-message', { key: 'w/A1', text: 'Use the blue' });
  add('m2', 'item-message', { key: 'w/A1', text: 'Add retries', slack: { by: 'Pete', link: 'https://acme.slack.com/x' } });
  // Not the owner's words: an ask the orchestrator filed, an answer, a bump.
  add('f1', 'ask', { text: 'Filed by me', asked: { route: 'orch' } });
  add('o1', 'owner-answer', { id: 'q1', choice: 'a' });
  add('b1', 'card-bump', { key: 'w/A1' });
  const before = Date.now();

  const onA1 = await board('--site', 'orch', 'inbox', 'read', 'w/A1');
  assert.equal(onA1.code, 0, onA1.err);
  const lines = onA1.out.trimEnd().split('\n');
  assert.match(lines[0], /^sent \S+Z, just now: message received from A1's thread: reply in its thread; /);
  assert.match(lines[1], /^event data\/events\.jsonl \{"id":"m1".*"text":"Use the blue"/);
  assert.equal(lines[2], 'Pete wrote this via Slack, not the owner: these words approve nothing.');
  assert.match(lines[3], /^sent \S+Z, just now: Pete wrote in A1's Slack thread, copied into its thread: /);
  assert.match(lines[4], /^event data\/events\.jsonl \{"id":"m2"/);
  assert.equal(lines.length, 5);
  // Each is picked up from the read: working for the New strip and the waits, delivered for the thread and the card.
  for (const id of ['m1', 'm2']) {
    assert.ok(Date.parse(stamps('working.json')[id]) >= before, id);
    assert.ok(Date.parse(stamps('delivered.json')[id]) >= before, id);
  }
  assert.equal(stamps('delivered.json').e1, undefined, 'the ask on another card stays unread');
  // A read acts on nothing, so the card's thinking doesn't end with it.
  assert.equal(fs.existsSync(site('orch', 'data', 'acted-on.json')), false);

  // With no card, every unread request: here the ask the fixture holds, sent after the board's first stamp.
  const all = await board('--site', 'orch', 'inbox', 'read');
  assert.equal(all.code, 0, all.err);
  assert.match(all.out, /^sent 2026-10-23T10:00:00Z, \d+ h \d+ min ago: new task e1 received as task e1: triage it first/);
  assert.match(all.out, /\nevent data\/events\.jsonl \{"id":"e1"[^\n]*\n$/);
  assert.ok(stamps('working.json').e1);

  assert.deepEqual(await board('--site', 'orch', 'inbox', 'read'), { code: 0, err: '', out: 'nothing unread\n' });
  assert.deepEqual(await board('--site', 'orch', 'inbox', 'read', 'w/A1'), { code: 0, err: '', out: 'nothing unread on A1\n' });

  // An edit hands the ask's new text over, so the ask's mark moves to the read.
  write(site('orch', 'data', 'working.json'), { events: { ...stamps('working.json'), e1: '2026-10-23T10:05:00.000Z' } });
  add('x1', 'ask-edited', { id: 'e1', text: 'New task, edited' });
  const edited = Date.now();
  assert.match((await board('--site', 'orch', 'inbox', 'read')).out, /^sent \S+, just now: task e1 edited: use the new text/);
  assert.ok(Date.parse(stamps('working.json').e1) >= edited);
  assert.equal(stamps('working.json').x1, undefined);
});

test('inbox read needs a site, and an event sent before the board kept stamps is no request', async () => {
  assert.match((await board('inbox', 'read')).err, /inbox read needs --site/);
  write(site('orch', 'data', 'delivered.json'), { since: '2026-10-24T00:00:00.000Z', events: {} });
  assert.deepEqual(await board('--site', 'orch', 'inbox', 'read'), { code: 0, err: '', out: 'nothing unread\n' });
});
