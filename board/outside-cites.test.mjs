// docs/adr/2026-11-24-2100-outside-text-cites-only-external-refs-and-a-subject-ends-with-its-ticket.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { home, at, site, write, wave, onOrch } from './board-fixture.mjs';

test('a PR comment or reply, a review post and a Slack post that name a task key are refused before anything is sent, naming what to cite', async () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [...wave().items, { id: 'T-3', title: 'feat: three', landed_sha: 'abcdef1234' }] });
  const fault = 'the text leaves the board, where a task key means nothing: cite T-3 as commit abcdef1. Outside text cites only tickets, PRs and commits\n';
  const review = path.join(home, 'review.md');
  write(review, 'As in T-3, this holds.');
  for (const args of [
    ['pr', 'comment', '7', '--body', 'Fixed as in T-3.'],
    ['pr', 'reply', '7', '12', '--body', 'See w/T-3.'],
    ['review', 'post', '7', '--file', review, '--read-at', '2026-11-24T10:00:00Z'],
    ['slack', 'answer', 'e1', '--text', 'Done in T-3.'],
    ['slack', 'say', 'ann', '--text', 'T-3 landed.'],
  ]) assert.deepEqual(await onOrch(...args), { code: 1, out: '', err: fault }, args.join(' '));
});

test("a reply to a message that came from Slack goes into Slack, so it refuses a task key; a reply to one from the board doesn't", async () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [...wave().items, { id: 'T-3', title: 'feat: three' }] });
  write(site('orch', 'data', 'events.jsonl'), [
    { id: 'e1', ts: '2026-11-24T10:00:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'From Slack', slack: { thread: { channel: 'C1', thread_ts: '1.0' } } } },
    { id: 'e2', ts: '2026-11-24T10:01:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'From the board' } },
  ].map((e) => `${JSON.stringify(e)}\n`).join(''));
  assert.deepEqual(await onOrch('reply', 'e1', '--text', 'Like T-3.'), { code: 1, out: '', err: 'the text leaves the board, where a task key means nothing: leave T-3 out, as it never left the board. Outside text cites only tickets, PRs and commits\n' });
  assert.equal((await onOrch('reply', 'e2', '--text', 'Like T-3.')).code, 0);
});
