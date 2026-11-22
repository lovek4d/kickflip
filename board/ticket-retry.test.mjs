// docs/adr/2026-11-21-2349-a-failed-ticket-move-is-retried-on-the-hubs-poll-and-an-untagged-release-offers-its-tag.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketCli, site, write, read, lines } from './board-fixture.mjs';

test("a card's failed ticket close is kept and retried by the hub's poll until it goes through, saying nothing more while it fails", async (t) => {
  const { saveBoardSettings, ghAnswers, cli } = await ticketCli(t);
  const { setItem } = await import('./cards.mjs');
  const { runTicketRetries } = await import('../hub/ticket-retry.mjs');
  await saveBoardSettings(site('audit'), { tickets: { source: 'github' } });
  const waveFile = site('audit', 'data', 'items.json');
  write(waveFile, { ...read(waveFile), repo: 'o/r' });
  ghAnswers.view = { state: 'OPEN', assignees: [{ login: 'love' }] };
  assert.equal(await cli('item', 'add', 'audit/R1', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: R1', '--ticket', '#60'), 0);
  const calls = [];
  let down = true;
  const run = async (cmd, argv) => {
    calls.push(argv);
    if (down && argv[1] === 'close') return { status: 1, stderr: 'TLS handshake timeout' };
    return { status: 0, stdout: argv[0] === 'api' ? 'love\n' : argv[1] === 'view' ? JSON.stringify(ghAnswers.view) : '' };
  };
  const item = () => read(waveFile).items.find((it) => it.id === 'R1');
  const thread = () => lines(site('audit', 'data', 'threads', 'audit__R1.jsonl')).filter((m) => /^ticket-/.test(m.line ?? ''));
  await setItem(site('audit'), 'audit/R1', { done: true, force: true, text: 'Done.' }, { run });
  assert.equal(item().ticket_retry, 'done');
  assert.deepEqual(thread().map((m) => m.line), ['ticket-failed']);
  const board = () => ({ route: 'audit', dir: site('audit'), files: [{ slug: 'audit', itemFile: read(waveFile) }] });
  const failed = [];
  await runTicketRetries([board()], failed, { run });
  assert.equal(item().ticket_retry, 'done', 'still failing, so kept');
  assert.equal(thread().length, 1, 'no second failure line');
  down = false;
  await runTicketRetries([board()], failed, { run });
  assert.equal(item().ticket_retry, undefined);
  assert.deepEqual(thread().map((m) => m.line), ['ticket-failed', 'ticket-closed']);
  assert.equal(calls.filter((a) => a[1] === 'close').length, 3);
  const before = calls.length;
  await runTicketRetries([board()], failed, { run });
  assert.equal(calls.length, before, 'a card with its move done is not tried again');
  assert.deepEqual(failed, []);
});
