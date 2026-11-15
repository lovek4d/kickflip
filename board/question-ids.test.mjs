import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, write, board, question } from './board-fixture.mjs';

const refusal = /names the question "t9-audit"; name its task instead, e\.g\. "the question on w\/A1", and quote its words if needed/;

test('text to the owner refuses a question id, live or archived, and ids stay valid as arguments', async () => {
  write(site('orch', 'data', 'owner.json'), { items: [question('t9-audit', { topic: 'item:w/A1' })] });
  write(site('orch', 'data', 'done-archive.json'), { cards: [{ key: 'w/Z9', questions: [question('old-one', { topic: 'item:w/Z9' })] }] });
  const refused = [
    ['thread', 'w/A1', '--text', 'please answer t9-audit'],
    ['thread', 'w/A1', '--text', 'see (old-one).'],
    ['item', 'set', 'w/A1', '--text', 'answer t9-audit'],
    ['item', 'add', 'w/B1', '--title', 'feat: x', '--text', 'answer t9-audit'],
    ['item', 'triage', 'w/A1', '--text', 'answer t9-audit'],
    ['push', '--kind', 'reminder', '--title', 'answer t9-audit'],
    ['push', '--kind', 'reminder', '--title', 'x', '--body', 'answer t9-audit'],
  ];
  for (const args of refused) {
    const r = await board(...args, '--site', 'orch');
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /names the question "(t9-audit|old-one)"/, args.join(' '));
  }
  assert.match((await board('thread', 'w/A1', '--text', 'answer t9-audit', '--site', 'orch')).err, refusal);
  const ok = await board('thread', 'w/A1', '--text', 'the question on w/A1 about t9-auditor', '--site', 'orch');
  assert.equal(ok.code, 0, ok.err);
  assert.equal((await board('question', 'resolve', 't9-audit', '--note', 'done', '--site', 'orch')).code, 0);
});

test('reply refuses a question id in its --file', async () => {
  write(site('orch', 'data', 'owner.json'), { items: [question('t9-audit', { topic: 'item:w/A1' })] });
  write(site('orch', 'data', 'replies', 'e1.html'), '<p>x</p>');
  write(site('orch', 'draft.md'), 'answer t9-audit');
  const r = await board('reply', 'e1', '--site', 'orch', '--file', site('orch', 'draft.md'));
  assert.equal(r.code, 1);
  assert.match(r.err, /names the question "t9-audit"/);
});
