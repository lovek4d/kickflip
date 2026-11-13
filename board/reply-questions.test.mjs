// docs/adr/2026-11-12-2330-a-reply-posts-its-questions-after-it-in-one-command.md: reply and thread take
// --questions <file>, so a message's questions always sit after it in the thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { home, site, write, read, lines, board, question } from './board-fixture.mjs';

const threadFile = () => site('orch', 'data', 'threads', 'w__A1.jsonl');
const owned = () => read(site('orch', 'data', 'owner.json')).items;
const file = (content) => { write(path.join(home, 'qs.json'), content); return path.join(home, 'qs.json'); };
const ask = (id) => question(id, { topic: 'item:w/A1' });

test('thread --questions posts the message, then its questions asked after it', async () => {
  const r = await board('thread', 'w/A1', '--text', 'Two points.', '--questions', file([ask('q1'), ask('q2')]), '--site', 'orch');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.deepEqual(owned().map((q) => q.id), ['q1', 'q2']);
  const message = lines(threadFile()).find((l) => l.text === 'Two points.');
  assert.ok(owned().every((q) => q.asked_at >= message.ts));
  assert.match(r.out, /questions q1, q2 asked after it/);
});

async function askCard() {
  fs.appendFileSync(site('audit', 'data', 'events.jsonl'), JSON.stringify({ id: 'a1', ts: '2026-11-09T10:00:00Z', kind: 'ask', data: { text: 'Fix the header' } }) + '\n');
  process.env.HOME = home;
  const { fileAsk } = await import('./store.mjs');
  await fileAsk(site('audit'), 'a1');
}
const auditThread = () => site('audit', 'data', 'threads', 'audit__T-1.jsonl');
const auditOwned = () => read(site('audit', 'data', 'owner.json')).items;
const auditAsk = (id) => question(id, { topic: 'item:audit/T-1' });

test('reply --questions on a card answers it, then asks its questions after the reply', async () => {
  await askCard();
  const r = await board('reply', 'audit/T-1', '--text', 'One point.', '--questions', file(auditAsk('q1')), '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  const message = lines(auditThread()).find((l) => l.text === 'One point.');
  assert.ok(auditOwned()[0].asked_at >= message.ts);
});

test('a bad questions file is refused before the message posts', async () => {
  await askCard();
  const r = await board('reply', 'audit/T-1', '--text', 'Never posted.', '--questions', file([auditAsk('q1'), auditAsk('q1')]), '--site', 'audit');
  assert.equal(r.code, 1);
  assert.match(r.err, /already used/);
  const t = await board('thread', 'w/A1', '--text', 'Never posted.', '--questions', file([ask('q1'), ask('q1')]), '--site', 'orch');
  assert.equal(t.code, 1);
  assert.deepEqual(owned(), []);
  assert.equal(fs.existsSync(threadFile()), false);
  assert.equal(fs.existsSync(auditThread()) && lines(auditThread()).some((l) => l.text === 'Never posted.'), false);
});

test('--questions is refused beside --implement and --close, and posts nothing', async () => {
  for (const cmd of ['thread', 'reply']) {
    for (const flag of ['--implement', '--close']) {
      const r = await board(cmd, 'w/A1', '--text', 'Never posted.', flag, '--questions', file(ask('q1')), '--site', 'orch');
      assert.equal(r.code, 1, `${cmd} ${flag}`);
      assert.match(r.err, /--questions/);
    }
  }
  assert.deepEqual(owned(), []);
});
