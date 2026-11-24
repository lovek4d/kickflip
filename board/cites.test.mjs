// docs/adr/2026-11-24-2100-outside-text-cites-only-external-refs-and-a-subject-ends-with-its-ticket.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citeFault, externalRef, renderCites } from './cites.mjs';

const tasks = [
  { key: 'hub/T-810', id: 'T-810', ticket: '#1145', prs: [], landed: 'abcdef1234' },
  { key: 'hub/T-830', id: 'T-830', ticket: '#1161', prs: [{ repo: 'o/r', number: 1170 }], landed: null },
  { key: 'hub/T-726', id: 'T-726', ticket: null, prs: [{ repo: 'o/r', number: 40 }, { repo: 'x/y', number: 3 }], landed: null },
  { key: 'hub/T-753', id: 'T-753', ticket: null, prs: [], landed: '0123456789' },
  { key: 'hub/T-834', id: 'T-834', ticket: null, prs: [], landed: null },
  { key: 'lin/ENG-4', id: 'ENG-4', ticket: 'ENG-4', prs: [], landed: null },
];

test("a task's external form is its ticket with its PR, else its PR, else its landed commit, else nothing", () => {
  assert.equal(externalRef(tasks[0], 'o/r'), '#1145');
  assert.equal(externalRef(tasks[1], 'o/r'), '#1161, PR #1170');
  assert.equal(externalRef(tasks[2], 'o/r'), 'PR #40, x/y#3');
  assert.equal(externalRef(tasks[3], 'o/r'), 'commit 0123456');
  assert.equal(externalRef(tasks[4], 'o/r'), null);
});

test('outside text that names a task key is refused, naming what to cite, or to leave it out when it never left the board', () => {
  assert.equal(citeFault(tasks, ['Follow-up from #1145, as in PR #1170.'], 'o/r'), null);
  assert.equal(citeFault(tasks, ['Follow-up from T-810 and hub/T-830; see T-834.'], 'o/r'),
    'the text leaves the board, where a task key means nothing: cite T-810 as #1145; cite T-830 as #1161, PR #1170; leave T-834 out, as it never left the board. Outside text cites only tickets, PRs and commits');
  assert.match(citeFault(tasks, [undefined, 'like T-753'], 'o/r'), /cite T-753 as commit 0123456\./);
});

test("a key no card holds, a ticket that is its card's own id, and a key inside a URL or a longer word pass", () => {
  for (const text of ['A quoted example, "T-123", stays.', 'ENG-4 is the Linear issue.', 'https://example.com/T-810', 'see visuals/notes#T-810', 'XT-810 and T-8100']) {
    assert.equal(citeFault(tasks, [text], 'o/r'), null, text);
  }
});

test("a ticket's body made from notes writes each task key as its external form, and one that never left the board as an earlier task", () => {
  assert.equal(renderCites(tasks, "Follow-up from T-834's builder; cites T-810, hub/T-830 and T-123.", 'o/r'),
    "Follow-up from an earlier task's builder; cites #1145, #1161, PR #1170 and T-123.");
});
