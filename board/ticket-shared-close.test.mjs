// A ticket closes only when every card sharing it is done, and never on a PR closed unmerged: the board's close path
// leaves it open otherwise (board/cards.mjs changeItem), where the hub's poll already waits for every card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketCli, site, write, read, lines } from './board-fixture.mjs';

test('a done card leaves a ticket another open card shares, and the last card to finish closes it', async (t) => {
  const { saveBoardSettings, out, gh, ghAnswers, cli } = await ticketCli(t);
  await saveBoardSettings(site('audit'), { tickets: { source: 'github' } });
  const waveFile = site('audit', 'data', 'items.json');
  write(waveFile, { ...read(waveFile), repo: 'o/r' });
  ghAnswers.view = { state: 'OPEN', assignees: [{ login: 'love' }] };
  for (const id of ['S1', 'S2']) assert.equal(await cli('item', 'add', `audit/${id}`, '--phase', 'grilling', '--relate', 'audit/A1', '--title', `feat: ${id}`, '--ticket', '#50'), 0);
  const closes = () => gh.filter((argv) => argv[1] === 'close');
  const thread = (id) => lines(site('audit', 'data', 'threads', `audit__${id}.jsonl`)).filter((m) => /^ticket-/.test(m.line ?? ''));
  assert.equal(await cli('item', 'set', 'audit/S1', '--done', '--text', 'Done.'), 0);
  assert.deepEqual([closes().length, thread('S1').length], [0, 0]);
  assert.equal(await cli('item', 'set', 'audit/S2', '--done', '--text', 'Done.'), 0);
  assert.deepEqual(closes(), [['issue', 'close', '50', '--repo', 'o/r']]);
  assert.equal(out.at(-1), 'Closed #50.');
});

test('a card whose PR closed unmerged leaves its ticket open', async (t) => {
  const { saveBoardSettings, gh, ghAnswers, cli } = await ticketCli(t);
  const { setItem } = await import('./cards.mjs');
  await saveBoardSettings(site('audit'), { tickets: { source: 'github' } });
  const waveFile = site('audit', 'data', 'items.json');
  write(waveFile, { ...read(waveFile), repo: 'o/r' });
  ghAnswers.view = { state: 'OPEN', assignees: [{ login: 'love' }] };
  assert.equal(await cli('item', 'add', 'audit/U1', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: U1', '--ticket', '#51'), 0);
  await setItem(site('audit'), 'audit/U1', { merged: [], force: true, closing: ['prs-closed', { prs: '#9' }] }, { run: async (cmd, argv) => { gh.push(argv); return { status: 0, stdout: argv[0] === 'api' ? 'love\n' : argv[1] === 'view' ? JSON.stringify(ghAnswers.view) : '' }; } });
  assert.equal(read(waveFile).items.find((it) => it.id === 'U1').lane, 'done');
  assert.equal(gh.some((argv) => argv[1] === 'close'), false);
});
