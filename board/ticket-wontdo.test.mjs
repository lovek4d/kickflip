// docs/adr/2026-11-28-0400-a-pulled-tasks-wont-do-closes-its-issue-and-an-issue-closed-upstream-closes-its-task.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketCli, site, write, read, lines } from './board-fixture.mjs';

async function pulledBoard(t) {
  const { saveBoardSettings, ghAnswers, cli, err } = await ticketCli(t);
  const { setItem } = await import('./cards.mjs');
  await saveBoardSettings(site('audit'), { tickets: { source: 'github' } });
  const waveFile = site('audit', 'data', 'items.json');
  write(waveFile, { ...read(waveFile), repo: 'o/r' });
  ghAnswers.view = { state: 'OPEN', assignees: [] };
  assert.equal(await cli('item', 'add', 'audit/GH-61', '--phase', 'grilling', '--title', 'feat: crash on start', '--ticket', '#61', '--relate', 'audit/A1'), 0, err.join('\n'));
  const file = read(waveFile);
  file.items.find((it) => it.id === 'GH-61').ticket_pulled = true;
  write(waveFile, file);
  const calls = [];
  const run = async (cmd, argv) => {
    calls.push(argv);
    return { status: 0, stdout: argv[0] === 'api' ? 'love\n' : argv[1] === 'view' ? JSON.stringify(ghAnswers.view) : '' };
  };
  const thread = () => lines(site('audit', 'data', 'threads', 'audit__GH-61.jsonl')).filter((m) => /^ticket-/.test(m.line ?? '')).map((m) => m.text);
  return { setItem, calls, run, thread };
}

test('a pulled task closed Done with no build closes its unassigned issue as not planned', async (t) => {
  const { setItem, calls, run, thread } = await pulledBoard(t);
  await setItem(site('audit'), 'audit/GH-61', { done: true, force: true, text: 'Not doing this.' }, { run });
  assert.deepEqual(calls.find((a) => a[1] === 'close'), ['issue', 'close', '61', '--repo', 'o/r', '--reason', 'not planned']);
  assert.deepEqual(thread(), ['Closed #61 as not planned.']);
});

test('a pulled task that landed a build keeps the usual assignee rule: an unassigned issue is left', async (t) => {
  const { setItem, calls, run, thread } = await pulledBoard(t);
  await setItem(site('audit'), 'audit/GH-61', { done: true, force: true, landed: 'abc1234', text: 'Landed.' }, { run });
  assert.equal(calls.some((a) => a[1] === 'close'), false);
  assert.deepEqual(thread(), []);
});
