import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeGh, prView, writePR, writeIssueComments, writeReviews, writeUser, writeAccounts, calls, tokens } from '../shared/fake-gh.mjs';
import { withNotes, boardWith, bin, home, at, site, write, read, lines, run, board, runAsync, wave, ticketCli, record, annReviewer, bobReviewer, reviewState, slackToken, digestCommand } from './board-fixture.mjs';

test('tickets link or are made in the board source through the CLI and an injected GitHub runner, and a board with none has none', async (t) => {
  const { saveBoardSettings } = await import('./store.mjs');
  const { main } = await import('./bin/board.mjs');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; });
  const out = [], err = [], calls = [];
  t.mock.method(console, 'log', (...args) => out.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => err.push(args.join(' ')));
  const cli = (...args) => main(withNotes(['--site', 'audit', ...args]), { run: async (cmd, argv) => {
    calls.push([cmd, argv]);
    const repo = argv[argv.indexOf('--repo') + 1];
    if (argv[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 41, url: `https://github.com/${repo}/issues/41` }) };
    return { status: 0, stdout: `https://github.com/${repo}/issues/42\n` };
  } });
  assert.equal(await cli('item', 'add', 'audit/B2', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: two', '--ticket', 'INT-19'), 1);
  assert.match(err.at(-1), /this board has no ticket source/);
  assert.equal(await cli('item', 'add', 'audit', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: a task'), 0);
  assert.equal(out.at(-1), 'T-1 added as audit/T-1');
  assert.equal(calls.length, 0);
  const waveFile = site('audit', 'data', 'items.json');
  write(waveFile, { ...read(waveFile), repo: 'o/r' });
  await saveBoardSettings(site('audit'), { tickets: { source: 'github' } });
  assert.equal(await cli('item', 'add', 'audit/F6', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: six', '--ticket', '#41'), 0);
  assert.equal(await cli('item', 'set', 'audit/F6', '--ticket', '41'), 0);
  assert.equal(await cli('item', 'add', 'audit/G7', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: seven', '--notes', 'Why this matters', '--new-ticket'), 0);
  write(path.join(home, 'notes.md'), '# Full notes');
  assert.equal(await cli('item', 'add', 'audit/H8', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: eight', '--notes-from', path.join(home, 'notes.md'), '--new-ticket'), 0);
  write(site('audit', 'data', 'events.jsonl'), JSON.stringify({ id: 'e1', kind: 'ask', data: { text: 'Ask' } }) + '\n');
  write(waveFile, { ...read(waveFile), items: [...read(waveFile).items, { id: 'I9', title: 'From ask', notes: 'Asked why' }] });
  assert.equal(await cli('item', 'set', 'audit/I9', '--from-ask', 'e1', '--phase', 'grilling', '--text', 'On it.'), 0);
  assert.equal(read(waveFile).items.at(-1).ticket, undefined);
  assert.equal(await cli('item', 'set', 'audit/I9', '--new-ticket'), 0);
  assert.equal(await cli('item', 'add', 'audit/github-follow', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: another follow', '--new-ticket'), 0);
  assert.deepEqual(calls, [
    ['gh', ['issue', 'view', '41', '--repo', 'o/r', '--json', 'number,url']],
    ['gh', ['issue', 'view', '41', '--repo', 'o/r', '--json', 'number,url']],
    ['gh', ['issue', 'create', '--repo', 'o/r', '--title', 'feat: seven', '--body', 'Why this matters']],
    ['gh', ['issue', 'create', '--repo', 'o/r', '--title', 'feat: eight', '--body', '# Full notes']],
    ['gh', ['issue', 'create', '--repo', 'o/r', '--title', 'From ask', '--body', 'Asked why']],
    ['gh', ['issue', 'create', '--repo', 'o/r', '--title', 'feat: another follow', '--body', 'Notes.']],
  ]);
  assert.equal(read(waveFile).items.at(-1).ticket, '#42');
  assert.equal(await cli('item', 'set', 'audit/F6', '--next', 'Then this'), 0);
  assert.equal(out.at(-1), '#41: next line set');
  assert.equal(await cli('item', 'add', 'audit', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: ten', '--notes', 'From the source', '--new-ticket'), 0);
  assert.deepEqual(calls.at(-1), ['gh', ['issue', 'create', '--repo', 'o/r', '--title', 'feat: ten', '--body', 'From the source']]);
  assert.equal(out.at(-1), '#42 added as audit/GH-42');
  assert.deepEqual(['id', 'ticket', 'ticket_created'].map((k) => read(waveFile).items.at(-1)[k]), ['GH-42', '#42', true]);
  const items = read(waveFile).items.length;
  assert.equal(await cli('item', 'add', 'audit', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: eleven', '--new-ticket'), 1);
  assert.equal(err.at(-1), 'item file "audit" already has an item "GH-42"; link #42 with item add audit/<id> --ticket #42');
  assert.equal(read(waveFile).items.length, items);
  const before = fs.readFileSync(waveFile, 'utf8');
  for (const response of [{ status: 1, stderr: 'No such issue' }, { status: 0, stdout: JSON.stringify({ number: 41, url: 'https://github.com/other/repo/issues/41' }) }]) {
    assert.equal(await main(['--site', 'audit', 'item', 'set', 'audit/F6', '--ticket', '#41'], { run: async () => response }), 1);
    assert.equal(fs.readFileSync(waveFile, 'utf8'), before);
  }
  write(at('kickflip', 'manifest.json'), { sites: { audit: { dir: site('audit'), cmd: [process.execPath, fileURLToPath(new URL('./server.mjs', import.meta.url))], github: 'board/chosen' } } });
  const script = `import assert from 'node:assert/strict';
    import { main } from ${JSON.stringify(new URL('./bin/board.mjs', import.meta.url).href)};
    process.exitCode = await main(['--site', 'audit', 'item', 'set', 'audit/F6', '--ticket', '#41'], { run: async (cmd, argv) => {
      assert.equal(cmd, 'gh');
      assert.deepEqual(argv, ['issue', 'view', '41', '--repo', 'board/chosen', '--json', 'number,url']);
      return { status: 0, stdout: JSON.stringify({ number: 41, url: 'https://github.com/board/chosen/issues/41' }) };
    } });`;
  const linked = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, HOME: home, KICKFLIP_CLAUDE: '/usr/bin/false' } });
  assert.equal(linked.status, 0, linked.stderr);
});

test("a Linear board creates and checks issues through Hub's key, and each card moves only its owner's or kickflip's ticket, one way", async (t) => {
  const { saveBoardSettings, main, out, err, world, linear, gh, ghAnswers, cli, item } = await ticketCli(t);
  await saveBoardSettings(site('audit'), { tickets: { source: 'linear', workspace: 'acme', team: 'ENG', project: 'proj-audit' } });
  write(path.join(home, 'notes.md'), '# Why it matters');
  assert.equal(await cli('item', 'add', 'audit/B2', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: two', '--notes-from', path.join(home, 'notes.md'), '--new-ticket'), 0);
  assert.deepEqual([item('B2').ticket, item('B2').ticket_created], ['ENG-101', true]);
  assert.deepEqual(world.issues['ENG-101'].input, { teamId: 'team-eng', projectId: 'proj-audit', title: 'feat: two', description: '# Why it matters' });
  world.issues['ENG-8'] = { team: 'OPS', assignee: 'user-me', state: 'o-todo' };
  world.issues['ENG-9'] = { team: 'ENG', assignee: 'someone', state: 's-todo' };
  world.issues['ENG-10'] = { team: 'ENG', assignee: 'user-me', state: 's-todo' };
  for (const [ticket, message] of [['ENG-50', 'Linear has no issue ENG-50.'], ['ENG-8', "ENG-8 is in Linear's OPS team, not ENG."], ['OPS-1', 'Ticket must match ENG-<number>.']]) {
    assert.equal(await cli('item', 'add', 'audit/C3', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: three', '--ticket', ticket), 1);
    assert.equal(err.at(-1), message);
  }
  assert.equal(await cli('item', 'add', 'audit/C3', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: three', '--ticket', 'ENG-9'), 0);
  assert.equal(await cli('item', 'add', 'audit/D4', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: four', '--ticket', 'ENG-10'), 0);
  assert.deepEqual([item('C3').ticket, item('C3').ticket_created, item('D4').ticket], ['ENG-9', undefined, 'ENG-10']);
  const stateOf = (id) => world.teams[0].states.find((s) => s.id === world.issues[id].state).name;
  // builder start's move of the ticket reaches Linear through the global fetch, not the CLI's injected one.
  t.mock.method(globalThis, 'fetch', linear.fetch);
  const start = (id) => cli('builder', 'start', `audit/${id}`, '--kind', 'claude');
  const said = (line) => out.slice(-4).includes(line);
  const moves = [
    ['B2', null, 'ENG-101', 'In Progress'], ['B2', ['--pr', '5'], 'ENG-101', 'In Review'], ['B2', ['--done', '--text', 'Done.'], 'ENG-101', 'Done'],
    ['D4', null, 'ENG-10', 'In Progress'], ['D4', ['--done', '--text', 'Merged.'], 'ENG-10', 'Done'],
  ];
  for (const [id, flags, ticket, state] of moves) {
    assert.equal(await (flags ? await cli('item', 'set', `audit/${id}`, ...flags) : await start(id)), 0);
    assert.ok(said(`ticket ${ticket}: moved to ${state}`), out.slice(-4).join('\n'));
    assert.equal(stateOf(ticket), state);
  }
  assert.equal(await cli('item', 'set', 'audit/B2', '--pr', '6'), 0);
  assert.equal(stateOf('ENG-101'), 'Done');
  assert.equal(await start('C3'), 0);
  assert.ok(said('ticket ENG-9: left as it is, not assigned to you'), out.slice(-4).join('\n'));
  assert.deepEqual([item('C3').lane, stateOf('ENG-9')], ['progress', 'Todo']);
  const before = linear.calls.length;
  for (const flags of [['--blocked'], ['--next', 'Then this']]) assert.equal(await cli('item', 'set', 'audit/C3', ...flags), 0);
  assert.equal(linear.calls.length, before);
  assert.equal(await cli('item', 'add', 'audit/E5', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: five', '--new-ticket'), 0);
  assert.equal(await cli('item', 'add', 'audit', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: named in linear', '--new-ticket'), 0);
  assert.equal(out.at(-1), 'ENG-103 added as audit/ENG-103');
  assert.deepEqual([item('ENG-103').ticket, world.issues['ENG-103'].input.title], ['ENG-103', 'feat: named in linear']);
  const offline = async () => { throw new Error('offline'); };
  globalThis.fetch.mock.mockImplementation(offline);
  assert.equal(await start('E5'), 0);
  assert.ok(said('ticket ENG-102: could not move to In Progress (Could not reach Linear: offline)'), out.slice(-4).join('\n'));
  assert.equal(item('E5').lane, 'progress');

  const waveFile = site('audit', 'data', 'items.json');
  write(waveFile, { ...read(waveFile), repo: 'o/r' });
  await saveBoardSettings(site('audit'), { tickets: { source: 'github' } });
  assert.equal(await cli('item', 'add', 'audit/F6', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: six', '--new-ticket'), 0);
  assert.equal(await cli('item', 'add', 'audit/G7', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: seven', '--ticket', '#41'), 0);
  assert.equal(await cli('item', 'add', 'audit/H8', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: eight', '--ticket', '#43', '--blocked-by', 'audit/F6'), 0);
  gh.length = 0;
  for (const id of ['F6', 'G7']) assert.equal(await start(id), 0);
  assert.equal(await cli('item', 'set', 'audit/G7', '--pr', '7'), 0);
  assert.deepEqual(gh, []);
  assert.equal(await cli('item', 'set', 'audit/F6', '--done', '--text', 'Done.'), 0);
  assert.equal(out.at(-1), 'ticket #42: closed');
  assert.deepEqual(gh, [['issue', 'close', '42', '--repo', 'o/r']]);
  // The line on the card it unblocked names the finished card by its ticket, not its id.
  assert.deepEqual(lines(site('audit', 'data', 'threads', 'audit__H8.jsonl')).map((m) => m.text).slice(-1), ['Unblocked: #42 is done.']);
  assert.equal(await cli('item', 'set', 'audit/G7', '--done', '--text', 'Merged.'), 0);
  assert.equal(out.at(-1), 'ticket #41: left as it is, not assigned to you');
  assert.equal(gh.some((argv) => argv[1] === 'close' && argv[2] === '41'), false);
  ghAnswers.view = { state: 'OPEN', assignees: [{ login: 'Love' }] };
  assert.equal(await cli('item', 'set', 'audit/G7', '--done', '--text', 'Done.'), 0);
  assert.equal(out.at(-1), 'ticket #41: closed');
  assert.deepEqual(gh.at(-1), ['issue', 'close', '41', '--repo', 'o/r']);
});

test("a board still on Linear after Hub's key went refuses new tickets and links, changing nothing, and its moves say the key is missing", async (t) => {
  const { saveBoardSettings, out, err, linear, cli, item } = await ticketCli(t);
  await saveBoardSettings(site('audit'), { tickets: { source: 'linear', workspace: 'acme', team: 'ENG', project: 'proj-audit' } });
  assert.equal(await cli('item', 'add', 'audit/B2', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: two', '--notes', 'Why', '--new-ticket'), 0);
  assert.equal(item('B2').ticket, 'ENG-101');
  const calls = linear.calls.length;
  write(at('kickflip', 'secrets.json'), {});
  const noKey = 'Hub has no Linear key, so this board can’t create Linear tickets; add it in Hub › Integrations › Linear, or pick another ticket source.';
  const waveFile = site('audit', 'data', 'items.json');
  write(site('audit', 'data', 'events.jsonl'), JSON.stringify({ id: 'e1', kind: 'ask', data: { text: 'Ask' } }) + '\n');
  write(waveFile, { ...read(waveFile), items: [...read(waveFile).items, { id: 'D4', title: 'Asked' }] });
  const before = fs.readFileSync(waveFile, 'utf8');
  for (const args of [['item', 'add', 'audit/C3', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: three', '--new-ticket'], ['item', 'add', 'audit', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: unnamed', '--new-ticket'], ['item', 'add', 'audit/later', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: later', '--new-ticket'],
    ['item', 'set', 'audit/B2', '--ticket', 'ENG-4'], ['item', 'set', 'audit/D4', '--new-ticket']]) {
    assert.equal(await cli(...args), 1, args.join(' '));
    assert.equal(err.at(-1), noKey);
  }
  assert.equal(fs.readFileSync(waveFile, 'utf8'), before);
  for (const args of [['builder', 'start', 'audit/B2', '--kind', 'claude'], ['item', 'set', 'audit/B2', '--pr', '9'], ['item', 'set', 'audit/B2', '--done', '--text', 'Done.']]) {
    assert.equal(await cli(...args), 0);
    assert.ok(out.slice(-4).includes('ticket ENG-101: not moved, Hub has no Linear key'), out.slice(-4).join('\n'));
  }
  assert.equal(linear.calls.length, calls);
});

test("the hub board files its cards as issues in its entry's GitHub repo, as any local board does, as its Tickets gh account, PR calls stay on the active account, and a missing account fails clearly", async () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  writeAccounts(dir, { lovek4d: 'token-lovek4d' });
  writePR(dir, 7, prView());
  write(at('kickflip', 'manifest.json'), { sites: { audit: { dir: site('audit'), hub: true, local: true, github: 'someone/fork', cmd: [process.execPath, bin('../server.mjs')] } } });
  write(site('audit', 'data', 'items.json'), { ...wave(), internal: true, items: [{ id: 'A1', title: 'One', ticket: 'A1' }, { id: 'Z9', title: 'Shipped', ticket: 'Z9', lane: 'done', closed_at: '2026-11-01T10:00:00Z' }] });
  const cli = (...args) => boardWith(['--site', 'audit', ...args], env);
  const last = async (...args) => (await cli(...args)).out.trim().split('\n').at(-1);
  assert.equal(await last('settings', 'set', 'tickets', '{"source":"github","account":"lovek4d"}'), 'setting tickets {"source":"github","account":"lovek4d"}');
  assert.equal((await cli('settings', 'set', 'github-login', 'owner')).code, 0);
  assert.equal((await cli('item', 'add', 'audit/B2', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: two', '--new-ticket')).code, 0);
  assert.equal((await cli('item', 'add', 'audit/C3', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: three', '--ticket', '#9')).code, 0);
  assert.equal(await last('item', 'set', 'audit/B2', '--done', '--text', 'Done.'), 'ticket #1: closed');
  assert.equal((await cli('item', 'set', 'audit/C3', '--pr', '7')).code, 0);
  const report = await cli('pr', 'audit/C3');
  assert.equal(report.code, 0, report.err);
  const issues = tokens(dir).filter((c) => c.args[0] === 'issue').map(({ args, token }) => [args[1], args[args.indexOf('--repo') + 1], token]);
  assert.deepEqual(issues, [
    ['create', 'someone/fork', 'token-lovek4d'], ['view', 'someone/fork', 'token-lovek4d'], ['close', 'someone/fork', 'token-lovek4d'],
  ]);
  const prs = tokens(dir).filter((c) => c.args[0] === 'pr');
  assert.deepEqual(prs.map((c) => c.args[4]), ['someone/fork']);
  assert.notEqual(prs[0].token, 'token-lovek4d');
  assert.equal((await cli('settings', 'set', 'tickets', '{"source":"github","account":"nobody"}')).code, 0);
  const issueCalls = () => calls(dir).filter((a) => a[0] === 'issue').length;
  const before = issueCalls();
  assert.deepEqual(await cli('item', 'add', 'audit/D4', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: four', '--new-ticket'), { code: 1, out: '', err: 'gh has no nobody account; run gh auth login\n' });
  assert.equal(await last('item', 'set', 'audit/C3', '--done', '--text', 'Done.'), 'ticket #9: could not move to Done (gh has no nobody account; run gh auth login)');
  assert.equal(issueCalls(), before);
  assert.equal((await cli('settings', 'set', 'tickets', '{"source":"github","account":"-bad"}')).code, 1);
});

test("a card with an owner step keeps its GitHub issue open when the session closes it; the owner's Done closes it", async () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  writeAccounts(dir, { lovek4d: 'token-lovek4d' });
  write(at('kickflip', 'manifest.json'), { sites: { audit: { dir: site('audit'), hub: true, local: true, github: 'someone/fork', cmd: [process.execPath, bin('../server.mjs')] } } });
  write(site('audit', 'data', 'items.json'), { ...wave(), internal: true, items: [{ id: 'A1', title: 'feat: one' }] });
  const cli = (...args) => boardWith(['--site', 'audit', ...args], env);
  assert.equal((await cli('settings', 'set', 'tickets', '{"source":"github","account":"lovek4d"}')).code, 0);
  assert.equal((await cli('item', 'add', 'audit/B2', '--phase', 'grilling', '--relate', 'audit/A1', '--title', 'feat: two', '--new-ticket')).code, 0);
  const file = site('audit', 'data', 'items.json');
  write(file, { ...read(file), items: read(file).items.map((it) => ({ ...it, owner_step: 'Tag the first release' })) });
  const closes = () => calls(dir).filter((a) => a[0] === 'issue' && a[1] === 'close').length;
  const session = await cli('item', 'set', 'audit/B2', '--done', '--text', 'Landed.');
  assert.equal(session.code, 0, session.err);
  assert.equal(closes(), 0);
  assert.equal(read(file).items.at(-1).owner_step, 'Tag the first release');
  const owner = spawnSync(process.execPath, ['--input-type=module', '-e', `import { recordOwnerTap } from ${JSON.stringify(path.join(path.dirname(bin('x')), '..', 'store.mjs'))}; await recordOwnerTap(${JSON.stringify(site('audit'))}, 'card-done', { key: 'audit/B2' });`],
    { encoding: 'utf8', env: { ...process.env, HOME: home, ...env } });
  assert.equal(owner.status, 0, owner.stderr);
  assert.equal(closes(), 1);
  assert.deepEqual([read(file).items.at(-1).lane, read(file).items.at(-1).owner_step], ['done', undefined]);
});

test("pr comment and pr reply post Claude's words through gh with the robot prefix and the claude-bridge marker, as the board's github-login", async () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  writeAccounts(dir, { owner: 'token-owner' });
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), port: 1, github: 'o/r', cmd: [process.execPath, '/skill/board/server.mjs', site('orch')] } } });
  const cli = (...args) => boardWith(['--site', 'orch', ...args], env);
  const posts = () => tokens(dir).filter((c) => c.args[0] === 'api').map(({ args, token }) => [args[1], args[3], token]);

  // A comment on a PR whose link a reviewer has stays on GitHub: nothing goes in that link's Slack thread.
  const slackRecord = { 'o/r#7': { links: { Ann: { channel: 'D1', ts: '1.1', reactions: [] } }, replies: [] } };
  write(site('orch', 'data', 'pr-slack.json'), slackRecord);
  const comment = await cli('pr', 'comment', '7', '--body', 'Fixed in abc1234.');
  assert.equal(comment.code, 0, comment.err);
  assert.equal(comment.out, 'posted on PR #7: https://github.com/o/r/issues/7/comments\n');
  assert.deepEqual(read(site('orch', 'data', 'pr-slack.json')), slackRecord);
  assert.equal((await cli('settings', 'set', 'github-login', 'owner')).code, 0);
  assert.equal((await cli('pr', 'reply', '7', '901', '--body', 'Not changed: the owner kept it.')).code, 0);
  const elsewhere = await cli('pr', 'comment', 'o/site#1', '--body', 'Linked from #7.');
  assert.equal(elsewhere.out, 'posted on PR o/site#1: https://github.com/o/site/issues/1/comments\n');
  assert.deepEqual(posts(), [
    ['repos/o/r/issues/7/comments', 'body=🤖 Fixed in abc1234.\n\n<!-- claude-bridge -->', null],
    ['repos/o/r/pulls/7/comments/901/replies', 'body=🤖 Not changed: the owner kept it.\n\n<!-- claude-bridge -->', 'token-owner'],
    ['repos/o/site/issues/1/comments', 'body=🤖 Linked from #7.\n\n<!-- claude-bridge -->', 'token-owner'],
  ]);

  for (const [args, err] of [
    [['pr', 'comment', '7', '--body', '🤖 Fixed.'], 'pr comment adds the 🤖 prefix and the claude-bridge marker itself; pass only your words'],
    [['pr', 'comment', '7', '--body', 'Fixed.\n\n<!-- claude-bridge -->'], 'pr comment adds the 🤖 prefix and the claude-bridge marker itself; pass only your words'],
    [['pr', 'comment', 'x7', '--body', 'Fixed.'], 'pr comment takes a PR number or owner/repo#<n>'],
    [['pr', 'reply', '7', 'abc', '--body', 'Fixed.'], 'pr reply takes the id of the review comment it answers'],
    [['pr', 'comment', '7'], 'pr comment needs --body "<what Claude says>"'],
  ]) assert.deepEqual([(await cli(...args)).code, (await cli(...args)).err.split(' (node board')[0].trim()], [args.length === 3 ? 2 : 1, err]);
  assert.equal(posts().length, 3);
});

test("reviewers set, add and remove keep the board's own reviewers in its board.json", async () => {
  const ann = { name: 'Ann', slack_user: 'U01ANN', dm: 'D01ANN', github: 'ann' };
  const bob = { name: 'Bob', slack_user: 'U02BOB', dm: 'D02BOB', github: 'bob-b' };
  const cfg = () => read(site('orch', 'board.json'));
  write(at('waves', 'old', 'wave.json'), { title: 'Old', items: [{ id: 'O1', title: 'Shipped', lane: 'done', closed_at: '2026-11-01T10:00:00Z', prs: [{ number: 1, merged_at: '2026-11-01T10:00:00Z' }] }] });
  write(path.join(home, 'r.json'), [ann]);
  assert.deepEqual((await board('reviewers', 'set', '--site', 'orch', '--file', path.join(home, 'r.json'))).out.trim().split('\n').slice(1), ['item file w: reviewers copied']);
  assert.deepEqual(cfg(), { title: 'Orch', items: 'waves', reviewers: [ann] });
  write(path.join(home, 'bob.json'), bob);
  assert.equal((await board('reviewers', 'add', '--site', 'orch', '--file', path.join(home, 'bob.json'))).code, 0);
  write(path.join(home, 'ann.json'), [{ ...ann, name: 'ann', github: 'ann-2' }]);
  assert.equal((await board('reviewers', 'add', '--site', 'orch', '--file', path.join(home, 'ann.json'))).code, 0);
  assert.deepEqual(cfg().reviewers, [{ ...ann, name: 'ann', github: 'ann-2' }, bob]);
  assert.equal((await board('reviewers', 'remove', 'Ann', '--site', 'orch')).code, 0);
  assert.deepEqual(cfg().reviewers, [bob]);

  const rejected = [[{ name: 'Cy' }], [{ ...ann, email: 'a@x' }], [{ ...ann, slack_user: 'ann' }], [ann, { ...ann, name: 'ANN' }], ann];
  for (const file of rejected) {
    write(path.join(home, 'bad.json'), file);
    assert.equal((await board('reviewers', 'set', '--site', 'orch', '--file', path.join(home, 'bad.json'))).code, 1, JSON.stringify(file));
  }
  assert.match((await board('reviewers', 'remove', 'Bob', 'Zed', '--site', 'orch')).err, /Zed/);
  assert.equal((await board('reviewers', 'set', '--file', path.join(home, 'r.json'))).code, 1);
  assert.deepEqual(cfg(), { title: 'Orch', items: 'waves', reviewers: [bob] });
  assert.deepEqual([read(at('waves', 'w', 'wave.json')).reviewers, read(at('waves', 'old', 'wave.json')).reviewers], [[bob], undefined]);
});

test("settings prints the board's settings as JSON, off when absent, and settings set turns each on|off setting on and off in board.json, keeping its other keys", async () => {
  const cfg = () => read(site('orch', 'board.json'));
  write(site('orch', 'board.json'), { title: 'Orch', items: 'waves', rules: [{ id: 'r1', text: 'Ask first', by: 'owner', at: 'x' }] });
  assert.deepEqual(await board('settings', '--site', 'orch'), { code: 0, out: '{"auto_merge":false,"auto_build":false,"max_implementers":5,"max_serves":10,"auto_review":false,"idle_notification":false,"skip_draft":false,"prs":true,"tool_use":"normal","max_land_tests":1}\n', err: '' });
  // docs/adr/2026-11-04-1913-a-board-can-skip-the-draft.md
  for (const name of ['auto-merge', 'auto-build', 'auto-review', 'skip-draft', 'idle-notification']) {
    const before = cfg();
    for (const value of ['on', 'off']) {
      assert.deepEqual(await board('settings', 'set', name, value, '--site', 'orch'), { code: 0, out: `${name} ${value}\n`, err: '' });
      assert.deepEqual(cfg(), { ...before, [name.replace('-', '_')]: value === 'on' });
    }
  }

  // docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md
  const cap = await board('settings', 'set', 'max-implementers', '4', '--site', 'orch');
  assert.deepEqual([cap.code, cap.out, cfg().max_implementers], [0, 'max-implementers 4\n', 4]);
  for (const invalid of ['0', '100', '2.5', 'on', '']) {
    assert.match((await board('settings', 'set', 'max-implementers', invalid, '--site', 'orch')).err, /max_implementers must be a whole number from 1 to 99/, invalid);
  }
  assert.equal(cfg().max_implementers, 4);
  assert.equal((await board('settings', 'set', 'max-implementers', '10', '--site', 'orch')).code, 0);
  // docs/adr/2026-11-15-1100-the-planner-limit-is-dropped.md
  assert.notEqual((await board('settings', 'set', 'max-planners', '5', '--site', 'orch')).code, 0, 'the Planner limit is gone');
  assert.equal('max_planners' in cfg(), false);

  const login = await board('settings', 'set', 'github-login', 'owner', '--site', 'orch');
  assert.equal(login.code, 0);
  assert.match(login.out, /^github-login owner$/m);
  assert.equal(cfg().github_login, 'owner');
  assert.equal(JSON.parse((await board('settings', '--site', 'orch')).out).github_login, 'owner');
  assert.match((await board('settings', 'set', 'github-login', '', '--site', 'orch')).out, /^github-login unset$/m);
  assert.ok(!('github_login' in cfg()));
  for (const invalid of ['-owner', 'a_b', 'a'.repeat(40)]) {
    assert.equal((await board('settings', 'set', 'github-login', invalid, '--site', 'orch')).code, 1);
  }

  // docs/adr/2026-11-05-1823-board-settings-picks-which-build-script-a-board-runs.md
  assert.deepEqual(await board('settings', 'set', 'build-target', 'ios', '--site', 'orch'), { code: 0, out: 'build-target ios\n', err: '' });
  assert.equal(cfg().build_target, 'ios');
  assert.equal(JSON.parse((await board('settings', '--site', 'orch')).out).build_target, 'ios');
  assert.match((await board('settings', 'set', 'build-target', '../x', '--site', 'orch')).err, /build_target must name \.kickflip\/build-<target>/);
  assert.deepEqual(await board('settings', 'set', 'build-target', 'default', '--site', 'orch'), { code: 0, out: 'build-target default\n', err: '' });
  assert.ok(!('build_target' in cfg()));

  // docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md
  assert.equal(JSON.parse((await board('settings', '--site', 'orch')).out).scripts, undefined, 'the repo by default');
  assert.deepEqual(await board('settings', 'set', 'scripts', 'kickflip', '--site', 'orch'), { code: 0, out: 'scripts kickflip\n', err: '' });
  assert.equal(cfg().scripts, 'kickflip');
  assert.equal(JSON.parse((await board('settings', '--site', 'orch')).out).scripts, 'kickflip');
  assert.match((await board('settings', 'set', 'scripts', 'cloud', '--site', 'orch')).err, /scripts must be repo or kickflip/);
  assert.deepEqual(await board('settings', 'set', 'scripts', 'repo', '--site', 'orch'), { code: 0, out: 'scripts repo\n', err: '' });
  assert.ok(!('scripts' in cfg()));

  // docs/adr/2026-11-14-1500-a-tool-use-setting-sets-how-readily-the-orchestrator-uses-tools.md
  assert.equal(JSON.parse((await board('settings', '--site', 'orch')).out).tool_use, 'normal');
  assert.deepEqual(await board('settings', 'set', 'tool-use', 'high', '--site', 'orch'), { code: 0, out: 'tool-use high\n', err: '' });
  assert.equal(cfg().tool_use, 'high');
  assert.equal(JSON.parse((await board('settings', '--site', 'orch')).out).tool_use, 'high');
  assert.match((await board('settings', 'set', 'tool-use', 'extra', '--site', 'orch')).err, /tool_use must be normal or high/);
  assert.equal(cfg().tool_use, 'high');
  assert.equal((await board('settings', 'set', 'tool-use', 'normal', '--site', 'orch')).code, 0);

  const bad = [
    [['settings'], 1, /needs --site/],
    [['settings', 'set', 'auto-merge', 'yes', '--site', 'orch'], 1, /takes on or off/],
    [['settings', 'set', 'auto-deploy', 'on', '--site', 'orch'], 1, /no board setting "auto-deploy"; settings are auto-merge/],
    [['settings', 'set', 'auto-merge', '--site', 'orch'], 2, /settings set takes <name> <value>/],
  ];
  for (const [args, code, err] of bad) {
    const r = await board(...args);
    assert.equal(r.code, code, args.join(' '));
    assert.match(r.err, err, args.join(' '));
  }
  assert.equal(cfg().auto_merge, false);
});

test("rules add, edit and remove keep a board's rules in its board.json and the hub's in settings.json, and list prints both", async () => {
  const settings = { quiet: { start: '22:00', end: '08:00', hold: true }, other_key: 'kept' };
  write(at('kickflip', 'settings.json'), settings);
  write(site('orch', 'board.json'), { title: 'Orch', items: 'waves', reviewers: [{ name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' }] });
  assert.deepEqual([(await board('rules', 'list', '--site', 'orch')).out], ['']);
  const added = await board('rules', 'add', '--site', 'orch', '--text', 'Ask before\n  touching main');
  assert.equal(added.code, 0);
  const boardId = /^id (\S+)$/m.exec(added.out)[1];
  const hubId = /^id (\S+)$/m.exec((await board('rules', 'add', '--hub', '--by', 'claude', '--text', 'Screenshots in every PR')).out)[1];
  const cfg = read(site('orch', 'board.json'));
  assert.deepEqual([cfg.title, cfg.reviewers.length, cfg.rules.map((r) => [r.id, r.text, r.by])], ['Orch', 1, [[boardId, 'Ask before touching main', 'owner']]]);
  assert.deepEqual({ ...read(at('kickflip', 'settings.json')), rules: undefined }, { ...settings, rules: undefined });
  const list = await board('rules', 'list', '--site', 'orch');
  assert.equal(list.out, `hub ${hubId} claude Screenshots in every PR\nboard ${boardId} owner Ask before touching main\n`);
  assert.equal((await board('rules', 'list')).out, `hub ${hubId} claude Screenshots in every PR\n`);

  assert.equal((await board('rules', 'edit', boardId, '--site', 'orch', '--text', 'Ask first')).code, 0);
  assert.equal((await board('rules', 'edit', hubId, '--hub', '--text', 'Screenshots always')).code, 0);
  assert.deepEqual(read(at('kickflip', 'settings.json')).rules.map((r) => [r.text, r.by]), [['Screenshots always', 'claude']]);
  assert.match((await board('rules', 'remove', hubId, '--site', 'orch')).err, /it is a hub rule, so pass --hub/);
  assert.match((await board('rules', 'remove', boardId, '--hub', '--site', 'orch')).err, /it is a board rule, so drop --hub/);
  assert.equal((await board('rules', 'remove', boardId, '--site', 'orch')).code, 0);
  assert.equal((await board('rules', 'remove', hubId, '--hub')).code, 0);
  assert.equal((await board('rules', 'list', '--site', 'orch')).out, '');
  assert.deepEqual(read(site('orch', 'board.json')).rules, []);
});

test('rules refuse a board rule without --site, an empty text, an unknown author or id, and stray flags', async () => {
  const bad = [
    [['rules', 'add', '--text', 'x'], 1, /needs --site/],
    [['rules', 'add', '--site', 'orch', '--text', '  '], 1, /non-empty/],
    [['rules', 'add', '--site', 'orch'], 1, /non-empty/],
    [['rules', 'add', '--site', 'orch', '--text', 'x', '--by', 'bob'], 1, /--by takes owner or claude/],
    [['rules', 'edit', 'r9', '--site', 'orch', '--text', 'x'], 1, /no board rule "r9"/],
    [['rules', 'remove', 'r9', '--hub'], 1, /no hub rule "r9"/],
    [['rules', 'remove', '--site', 'orch'], 2, /rules remove takes <id>/],
    [['rules', 'list', '--hub'], 2, /does not take --hub/],
    [['rules', 'edit', 'r9', '--site', 'orch', '--by', 'claude', '--text', 'x'], 2, /does not take --by/],
  ];
  for (const [args, code, err] of bad) {
    const r = await board(...args);
    assert.equal(r.code, code, args.join(' '));
    assert.match(r.err, err, args.join(' '));
  }
  assert.equal(read(site('orch', 'board.json')).rules, undefined);
  assert.equal(fs.existsSync(at('kickflip', 'settings.json')), false);
});

// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
test("review record writes the session's review of a listed incoming PR, keeping the PR's details after it leaves the list", async () => {
  const pr = { number: 437, title: 'One endpoint', author: 'quinn', url: 'https://github.com/o/r/pull/437', head: 'abc', touches: ['w/A1'], asked: true };
  write(site('orch', 'data', 'incoming.json'), { at: 'x', repo: 'o/r', prs: [pr] });
  write(site('orch', 'data', 'reviews.json'), {});
  const held = await board('--site', 'orch', 'review', 'record', '437', '--state', 'needs', '--text', 'Clashes with #47.');
  assert.deepEqual([held.code, held.out], [0, 'review of PR #437 recorded: needs you\n']);
  const { at: heldAt, ...rec } = read(site('orch', 'data', 'reviews.json'))['437'];
  assert.ok(Date.parse(heldAt));
  assert.deepEqual(rec, { ...pr, state: 'needs', text: 'Clashes with #47.' });
  write(site('orch', 'data', 'incoming.json'), { at: 'y', repo: 'o/r', prs: [] });
  write(path.join(home, 'review.md'), 'Posted.\n\n- one point');
  assert.equal((await board('--site', 'orch', 'review', 'record', '437', '--state', 'posted', '--file', path.join(home, 'review.md'))).out, 'review of PR #437 recorded: posted\n');
  assert.deepEqual([read(site('orch', 'data', 'reviews.json'))['437'].text, read(site('orch', 'data', 'reviews.json'))['437'].review_url, read(site('orch', 'data', 'reviews.json'))['437'].head], ['Posted.\n\n- one point', undefined, 'abc']);
  for (const [args, err] of [
    [['438', '--state', 'posted', '--text', 'x'], /not an incoming PR/],
    [['437', '--state', 'approved', '--text', 'x'], /--state posted or --state needs/],
    [['437', '--state', 'posted'], /--text or --file/],
    [['437', '--state', 'posted', '--text', 'x', '--url', 'https://github.com/o/r/pull/437#pullrequestreview-1'], /--url/],
    [['seven', '--state', 'posted', '--text', 'x'], /PR number/],
  ]) assert.match((await board('--site', 'orch', 'review', 'record', ...args)).err, err, args.join(' '));
});

// docs/adr/2026-11-05-0930-review-post-posts-an-incoming-pr-review.md
test("review post posts the session's words as one Comment review on a listed incoming PR at its head, then records it posted with the review's link", async () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  writeAccounts(dir, { owner: 'token-owner' });
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), port: 1, github: 'o/r', cmd: [process.execPath, '/skill/board/server.mjs', site('orch')] } } });
  const cli = (...args) => boardWith(['--site', 'orch', ...args], env);
  const pr = { number: 437, title: 'One endpoint', author: 'quinn', url: 'https://github.com/o/r/pull/437', head: 'abc', touches: ['w/A1'], asked: true };
  write(site('orch', 'data', 'incoming.json'), { at: 'x', repo: 'o/incoming', prs: [pr] });
  write(site('orch', 'data', 'reviews.json'), {});
  write(path.join(home, 'review.md'), 'One point: the retry loops.\n');
  const file = path.join(home, 'review.md');
  const posts = () => tokens(dir).filter((c) => c.args[0] === 'api' && c.args[1].endsWith('/reviews') && c.args.includes('-f')).map(({ args, token }) => [args.slice(1), token]);
  assert.equal((await cli('settings', 'set', 'github-login', 'owner')).code, 0);
  const title = JSON.parse(fs.readFileSync(site('orch', 'board.json'), 'utf8')).title;

  const done = await cli('review', 'post', '437', '--file', file, '--read-at', '2026-11-05T09:00:00Z');
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out, 'posted review on PR #437: https://github.com/o/incoming/pull/437#pullrequestreview-1\n');
  assert.deepEqual(posts(), [[['repos/o/incoming/pulls/437/reviews', '-f', `body=🤖 Claude review from the ${title} board\n\nOne point: the retry loops.\n\n<!-- claude-bridge -->`, '-f', 'event=COMMENT', '-f', 'commit_id=abc'], 'token-owner']]);
  const { at: postedAt, ...rec } = read(site('orch', 'data', 'reviews.json'))['437'];
  assert.ok(Date.parse(postedAt));
  assert.deepEqual(rec, { ...pr, state: 'posted', text: 'One point: the retry loops.', review_url: 'https://github.com/o/incoming/pull/437#pullrequestreview-1' });

  // Another review after --read-at is refused, nothing posted; one before it is not.
  writeReviews(dir, 437, [{ id: 5, user: { login: 'ann' }, submitted_at: '2026-11-05T10:00:00Z', body: '', state: 'COMMENTED' }]);
  const stale = await cli('review', 'post', '437', '--file', file, '--read-at', '2026-11-05T09:00:00Z');
  assert.match(stale.err, /PR #437 got a review after 2026-11-05T09:00:00Z \(ann at 2026-11-05T10:00:00Z\)/);
  assert.equal(posts().length, 1);
  assert.equal((await cli('review', 'post', '437', '--file', file, '--read-at', '2026-11-05T10:30:00Z')).code, 0);
  assert.equal(posts().length, 2);

  for (const [name, words, err] of [
    ['robot', '🤖 Fine.', /adds the 🤖 header and the claude-bridge marker itself/],
    ['header', 'Claude review from me\n\nFine.', /adds the 🤖 header/],
    ['marker', 'Fine.\n<!-- claude-bridge -->', /adds the 🤖 header/],
  ]) {
    write(path.join(home, `${name}.md`), words);
    assert.match((await cli('review', 'post', '437', '--file', path.join(home, `${name}.md`), '--read-at', '2026-11-05T10:30:00Z')).err, err, name);
  }
  assert.match((await cli('review', 'post', '438', '--file', file, '--read-at', '2026-11-05T10:30:00Z')).err, /not an incoming PR/);
  assert.match((await cli('review', 'post', 'seven', '--file', file, '--read-at', '2026-11-05T10:30:00Z')).err, /review post takes the PR number/);
  assert.match((await cli('review', 'post', '437', '--read-at', '2026-11-05T10:30:00Z')).err, /review post needs --file/);
  assert.match((await cli('review', 'post', '437', '--file', file)).err, /review post needs --read-at/);
  assert.match((await cli('review', 'post', '437', '--file', file, '--read-at', 'noon')).err, /--read-at takes the time/);
  assert.equal(posts().length, 2);
});

// docs/adr/2026-11-16-2000-the-server-applies-the-owners-post-or-skip-on-a-held-review.md
test("applyReviewAnswer records a held review posted for Skip, posts its held text for Post, and leaves it held when the post fails", async (t) => {
  const { applyReviewAnswer, heldReview } = await import('./store.mjs');
  const dir = path.join(home, 'fake-gh-answer');
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeGh(dir)}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  writeAccounts(dir, { owner: 'token-owner' });
  const pr = { number: 437, title: 'One endpoint', author: 'quinn', url: 'https://github.com/o/r/pull/437', head: 'abc', touches: ['w/A1'], asked: true };
  const held = { ...pr, state: 'needs', text: 'Clashes with #47.', at: '2026-11-05T09:00:00.000Z' };
  write(site('orch', 'data', 'incoming.json'), { at: 'x', repo: 'o/incoming', prs: [pr] });
  const posts = () => tokens(dir).filter((c) => c.args[0] === 'api' && c.args[1].endsWith('/reviews') && c.args.includes('-f'));
  const rec = () => read(site('orch', 'data', 'reviews.json'))['437'];

  write(site('orch', 'data', 'reviews.json'), { 437: held });
  await applyReviewAnswer(site('orch'), 437, 'skip');
  assert.deepEqual([rec().state, rec().text, rec().review_url, posts().length], ['posted', 'Clashes with #47.', undefined, 0]);
  await assert.rejects(heldReview(site('orch'), 437), /PR #437 has no held review/);
  await assert.rejects(applyReviewAnswer(site('orch'), 437, 'post'), /no held review/);

  write(site('orch', 'data', 'reviews.json'), { 437: held });
  await applyReviewAnswer(site('orch'), 437, 'post');
  assert.deepEqual([rec().state, rec().review_url, posts().length], ['posted', 'https://github.com/o/incoming/pull/437#pullrequestreview-1', 1]);
  assert.match(posts()[0].args.find((a) => a.startsWith('body=')), /Clashes with #47\.\n\n<!-- claude-bridge -->$/);

  write(site('orch', 'data', 'reviews.json'), { 437: held });
  writeReviews(dir, 437, [{ id: 5, user: { login: 'ann' }, submitted_at: '2026-11-05T10:00:00Z', body: '', state: 'COMMENTED' }]);
  await assert.rejects(applyReviewAnswer(site('orch'), 437, 'post'), /got a review after 2026-11-05T09:00:00.000Z/);
  assert.deepEqual([rec().state, posts().length], ['needs', 1]);
});

test('main set publishes an install with the same URL and sha checks as card installs', async () => {
  for (const url of ['https://example.com/main.apk', 'itms-services://?action=download-manifest&url=https://m/main.plist']) {
    assert.equal((await board('--site', 'orch', 'main', 'set', '--install', url, '--install-sha', 'ABCDEF1')).code, 0);
    const { built_at, ...install } = read(site('orch', 'data', 'main.json')).install;
    assert.ok(Date.parse(built_at));
    assert.deepEqual(install, { url, sha: 'abcdef1' });
  }
  assert.equal((await board('--site', 'orch', 'main', 'set', '--install', 'http://m/app.apk')).code, 1);
  assert.equal((await board('--site', 'orch', 'main', 'set', '--install', 'https://m/app.apk', '--install-sha', 'main')).code, 1);
  assert.equal((await board('--site', 'orch', 'main', 'set')).code, 1);
  assert.equal((await board('main', 'set', '--install', 'https://m/app.apk')).code, 1);
});

test('github-login settings lines and API validation support set and clear', async () => {
  const { settingsOf, settingsLines, saveBoardSettings } = await import('./store.mjs');
  assert.deepEqual(settingsLines(settingsOf({ github_login: 'owner' })), ['setting auto-merge off', 'setting auto-build off', 'setting max-implementers 5', 'setting max-serves 10', 'setting auto-review off', 'setting idle-notification off', 'setting skip-draft off', 'setting prs on', 'setting tool-use normal', 'setting github-login owner']);
  assert.deepEqual(settingsLines(settingsOf({ tool_use: 'high' })).slice(-1), ['setting tool-use high']);
  assert.ok(!('github_login' in settingsOf({ github_login: 'bad login' })));
  await saveBoardSettings(site('orch'), { github_login: 'owner' });
  await saveBoardSettings(site('orch'), { github_login: null });
  assert.ok(!('github_login' in read(site('orch', 'board.json'))));
});

test('item set records a UTC gh-since and pr prints the board report through gh', async () => {
  const since = '2026-10-23T11:00:00Z';
  assert.equal((await board('item', 'set', 'w/A1', '--gh-since', since)).code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].gh_since, since);
  for (const invalid of ['tomorrow', '2026-10-23', '2026-10-23T11:00:00+00:00', '2026-99-23T11:00:00Z']) {
    assert.match((await board('item', 'set', 'w/A1', '--gh-since', invalid)).err, /ISO-8601 UTC/);
  }
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].gh_since, since);
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  writePR(dir, 7, prView());
  writeUser(dir, { login: 'owner' });
  writeIssueComments(dir, 7, [{ id: 1, user: { login: 'owner' }, created_at: '2026-10-23T12:00:00Z', body: 'Please fix', html_url: 'https://github.com/o/r/issues/7#issuecomment-1' }]);
  const pr = () => boardWith(['--site', 'orch', 'pr', 'w/A1'], env);
  assert.match((await pr()).err, /has no PR/);
  const w = read(at('waves', 'w', 'wave.json'));
  w.items[0].pr = 7;
  write(at('waves', 'w', 'wave.json'), w);
  assert.match((await pr()).err, /has no repo/);
  w.repo = 'wave/repo';
  write(at('waves', 'w', 'wave.json'), w);
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), github: 'board/repo', cmd: [process.execPath, bin('../server.mjs')] } } });
  assert.equal((await board('--site', 'orch', 'settings', 'set', 'github-login', 'owner')).code, 0);
  const result = await pr();
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out.trim().split('\n').length, 1);
  assert.equal(JSON.parse(result.out).events[0].who, 'user');
  assert.equal(JSON.parse(result.out).pr, 7);
  assert.ok(calls(dir).some((a) => a[0] === 'pr' && a[4] === 'board/repo'));
  assert.ok(calls(dir).some((a) => a[3]?.endsWith(`comments?since=${encodeURIComponent(since)}`)));
  assert.ok(!calls(dir).some((a) => a[1] === 'user'));
  assert.equal((await board('--site', 'orch', 'settings', 'set', 'github-login', '')).code, 0);
  assert.equal((await pr()).code, 0);
  assert.equal(calls(dir).filter((a) => a[1] === 'user').length, 1);
  fs.rmSync(at('kickflip', 'manifest.json'));
  const fallback = await pr();
  assert.equal(fallback.code, 0, fallback.err);
  assert.equal(calls(dir).filter((a) => a[0] === 'pr').at(-1)[4], 'wave/repo');
  writePR(dir, 'o/site#1', prView({ isDraft: true }));
  assert.equal((await board('item', 'set', 'w/A1', '--pr', 'o/site#1')).code, 0);
  const both = await pr();
  assert.equal(both.code, 0, both.err);
  assert.deepEqual(both.out.trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.repo, r.pr, r.isDraft]), [['wave/repo', 7, false], ['o/site', 1, true]]);
});

test("a PR's posted links and the topic fallback drive the same card age, stale In Review and hub Slack link", async () => {
  const sent = String(Math.floor((Date.now() - 8 * 86400000) / 1000)) + '.000100';
  const w = { ...wave(), repo: 'o/r', reviewers: [annReviewer, bobReviewer] };
  w.items[0].pr = 7;
  write(at('waves', 'w', 'wave.json'), w);
  write(at('slack-bridge', 'topics', 'one.json'), { items: { 'w/A1': { review_link_ts: { Ann: sent, Bob: sent } } } });
  const fallback = reviewState();
  assert.equal(fallback.card.review.Ann.state, 'sent');
  assert.equal(fallback.slack.ok, true);
  assert.deepEqual([fallback.card.lane, fallback.card.stale], ['review', true]);
  fs.rmSync(at('slack-bridge'), { recursive: true });
  const link = (channel) => ({ channel, ts: sent, reactions: [] });
  write(site('orch', 'data', 'pr-slack.json'), { 'o/r#7': { head: 'abc', links: { Ann: link('D1'), Bob: { channel: 'D2', posting_at: '2026-11-02T00:00:00Z', reactions: [] } }, replies: [] } });
  const posting = reviewState();
  assert.equal(posting.card.review.Bob.state, 'unsent');
  assert.equal(posting.slack.ok, false);
  write(site('orch', 'data', 'pr-slack.json'), { 'o/r#7': { head: 'abc', links: { Ann: link('D1'), Bob: link('D2') }, replies: [] } });
  const recorded = reviewState();
  assert.deepEqual(recorded.card.review, fallback.card.review);
  assert.equal(recorded.card.inReviewSince, fallback.card.inReviewSince);
  assert.deepEqual([recorded.card.lane, recorded.card.stale], ['review', true]);
  assert.equal(recorded.slack.ok, true);
});

test('slack identity imports config once, protects the saved file and lets the session override it', async () => {
  const config = { self_dm: 'DOLD', owner_slack_user: 'UOLD', slack_domain: 'old', timezone: 'America/Los_Angeles', ignored: 'secret' };
  write(at('slack-bridge', 'state.json'), { config });
  const expected = { self_dm: 'DOLD', owner_slack_user: 'UOLD', slack_domain: 'old', timezone: 'America/Los_Angeles' };
  assert.deepEqual(JSON.parse((await board('slack')).out), expected);
  assert.equal(fs.statSync(at('kickflip', 'slack.json')).mode & 0o777, 0o600);
  write(at('slack-bridge', 'state.json'), { config: { ...config, slack_domain: 'changed' } });
  assert.deepEqual(JSON.parse((await board('slack')).out), expected);
  const updated = await board('slack', 'set', '--self-dm', 'DNEW', '--user', 'UNEW', '--domain', 'new', '--timezone', 'Asia/Tokyo');
  assert.equal(updated.code, 0, updated.err);
  assert.deepEqual(JSON.parse(updated.out), { self_dm: 'DNEW', owner_slack_user: 'UNEW', slack_domain: 'new', timezone: 'Asia/Tokyo' });
  assert.equal((await board('slack', 'set', '--timezone', 'Not/AZone')).code, 1);
  assert.equal((await board('slack', 'set', '--self-dm', 'UWRONG')).code, 1);
});

test('slack signature prints the sign-off line, :robot_face: until Hub › Slack picks another emoji', async () => {
  assert.equal((await board('slack', 'signature')).out, '- :robot_face:\n');
  write(at('kickflip', 'slack.json'), { timezone: 'America/Los_Angeles', sign_off_emoji: 'tada' });
  assert.equal((await board('slack', 'signature')).out, '- :tada:\n');
});

test('review digest lists one item per hub-checked PR awaiting review, dates old links and stays due until every reviewer has the day’s digest', async () => {
  const now = '2026-11-02T17:00:00Z';
  slackToken();
  assert.equal((await board('slack', 'set', '--timezone', 'America/Los_Angeles')).code, 0);
  const ts = (hours) => String((Date.parse(now) - hours * 3600000) / 1000);
  write(site('orch', 'board.json'), { items: 'waves', reviewers: [bobReviewer] });
  const item = (id, pr, extra = {}) => ({ id, title: id, pr, ...extra });
  write(at('waves', 'w', 'wave.json'), { repo: 'o/r', reviewers: [annReviewer], items: [
    item('old', 1),
    item('edge', 2, { review_link_ts: { Ann: ts(48) } }),
    item('recent', 3, { review_sent: { Ann: ts(47) } }),
    item('approved', 4), item('draft', 5), item('closed', 6), item('unknown', 7), item('done', 10, { lane: 'done', closed_at: '2026-11-01T10:00:00Z' }), item('ci', 13), item('liked', 14),
  ] });
  write(site('orch', 'data', 'pr-slack.json'), { 'o/r#1': { head: 'a', links: { Ann: { channel: 'D1', ts: ts(73), reactions: [] } }, replies: [] } });
  write(at('waves', 'empty', 'wave.json'), { reviewers: [{ name: 'Cy', slack_user: 'U3', dm: 'D3' }], items: [] });
  write(at('kickflip', 'github-state.json'), { prs: Object.fromEntries([1, 2, 3, 4, 5, 6, 10, 13, 14].map((pr) => [`o/r#${pr}`, { state: pr === 6 ? 'CLOSED' : 'OPEN', isDraft: pr === 5, reviewDecision: pr === 4 ? 'APPROVED' : 'REVIEW_REQUIRED', reviews: pr === 14 ? { ann: 'APPROVED', 'github-actions[bot]': 'APPROVED' } : {}, ...(pr === 13 ? { failing: ['lint'] } : {}) }])) });
  const digest = digestCommand([], now);
  assert.deepEqual([digest.date, digest.due, digest.reviewers.map((r) => [r.name, r.owed])], ['2026-11-02', true, [['Bob', true], ['Ann', true]]]);
  // Ann approved #14 herself and a bot did too: it leaves Ann's digest only; #4's decision is APPROVED, so it leaves both.
  assert.deepEqual(digest.reviewers[0].items.map((i) => i.key), ['w/old', 'w/edge', 'w/recent', 'w/ci', 'w/liked']);
  const ann = digest.reviewers.find((r) => r.name === 'Ann');
  assert.deepEqual([ann.slack_user, ann.dm, ann.items.map((i) => i.key)], ['U1', 'D1', ['w/old', 'w/edge', 'w/recent', 'w/ci']]);
  assert.deepEqual(ann.items[0], { key: 'w/old', pr: 'o/r#1', title: 'old', url: 'https://github.com/o/r/pull/1', sent_ts: ts(73), days_old: 3, message: { text: '', attachments: [{ color: '#9e9e9e', title: 'old', title_link: 'https://github.com/o/r/pull/1', text: '_(3 days old)_', fallback: 'r#1 old · (3 days old)' }] } });
  for (const item of ann.items.slice(1)) assert.equal(Object.hasOwn(item, 'days_old'), false);
  // Before 09:00 and on a Sunday it is due as the owed links open the day's threads; past 17:00 the day still gets it.
  assert.equal(digestCommand([], '2026-11-02T16:59:00Z').due, true);
  assert.equal(digestCommand([], '2026-11-01T17:00:00Z').due, true);
  assert.equal(digestCommand([], '2026-11-03T01:00:00Z').due, true);
  assert.equal(digestCommand([], '2026-11-03T07:30:00Z').date, '2026-11-02');
  const sent = (reviewer, channel) => ({ date: '2026-11-02', reviewer, channel, ts: ts(0), replies: [{ pr: 'o/r#1', text: 'x', ts: ts(0) }] });
  write(site('orch', 'data', 'review-digests.json'), { digests: [sent('Ann', 'D1')] });
  assert.deepEqual([digestCommand([], now).due, digestCommand([], now).reviewers.map((r) => [r.name, r.owed])], [true, [['Bob', true], ['Ann', false]]]);
  write(site('orch', 'data', 'review-digests.json'), { digests: [sent('Ann', 'D1'), { ...sent('Bob', 'D2'), replies: [{ pr: 'o/r#1', text: 'x' }] }] });
  assert.equal(digestCommand([], now).due, true, "Bob's digest still owes a reply");
  write(site('orch', 'data', 'review-digests.json'), { digests: [sent('Ann', 'D1'), sent('Bob', 'D2')] });
  assert.equal(digestCommand([], now).due, false);
  assert.equal(digestCommand([], '2026-11-03T17:00:00Z').due, true);
  const realClock = await board('review', 'digest', '--site', 'orch');
  assert.equal(realClock.code, 0, realClock.err);
  assert.ok(Array.isArray(JSON.parse(realClock.out).reviewers));
});

test("review due lists each PR's owed links, thread replies and reactions, and the digest, and waits while Slack is not ready", async () => {
  const now = '2026-11-02T17:00:00Z';
  const due = () => {
    const script = `import {main} from ${JSON.stringify(new URL('./bin/board.mjs', import.meta.url).href)};
      process.exitCode = await main(['--site', 'orch', 'review', 'due'], {now: new Date('${now}')});`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  slackToken();
  assert.equal((await board('slack', 'set', '--timezone', 'America/Los_Angeles')).code, 0);
  write(at('waves', 'w', 'wave.json'), { repo: 'o/r', reviewers: [annReviewer, bobReviewer], items: [
    { id: 'A1', title: 'Open', pr: 1 },
    { id: 'A2', title: 'Draft', pr: 2 },
    { id: 'A3', title: 'Merged', prs: [{ number: 3, merged_at: '2026-11-01T10:00:00Z' }], lane: 'done', closed_at: '2026-11-01T10:00:00Z' },
    { id: 'A4', title: 'Done', pr: 4, lane: 'done', closed_at: '2026-11-01T10:00:00Z' },
  ] });
  const link = (channel, ts, reactions = []) => ({ channel, ts, reactions });
  write(site('orch', 'data', 'pr-slack.json'), {
    'o/r#1': { links: { Ann: link('D1', '1.1') }, replies: [{ id: 'comment-1', text: 'comment: fixed', to: { Ann: {} } }] },
    'o/r#3': { head: 'h3', links: { Ann: link('D1', '3.1', ['git_merged']), Bob: link('D2', '3.2') }, replies: [] },
    'o/r#4': { head: 'h4', links: { Bob: link('D2', '4.2') }, replies: [] },
  });
  write(at('kickflip', 'github-state.json'), { prs: { 'o/r#1': { state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', head: 'h1', title: 'Open PR', additions: 1, deletions: 2, files: 3 }, 'o/r#2': { state: 'OPEN', isDraft: true }, 'o/r#3': { state: 'MERGED' } } });
  const owed = due();
  assert.deepEqual(owed.links, [{ pr: 'o/r#1', key: 'w/A1', reviewer: 'Bob', slack_user: 'U2', text: '',
    attachments: [{ color: '#9e9e9e', title: 'Open PR', title_link: 'https://github.com/o/r/pull/1', text: '+1/-2 · 3 files', fallback: 'r#1 Open PR · +1/-2 · 3 files' }] }]);
  // A bump queued before bumps stopped is never owed.
  assert.equal('replies' in owed, false);
  // Ann's link already has the merge's reaction, recorded by an earlier build by its name; Bob's is owed it. With no
  // Slack to ask, the CLI names its state alone.
  assert.deepEqual(owed.reactions, [{ pr: 'o/r#3', reviewer: 'Bob', channel: 'D2', ts: '3.2', kind: 'merged' }]);
  assert.deepEqual(owed.edits, []);
  assert.deepEqual([owed.digest.due, owed.digest.reviewers.map((r) => r.name)], [true, ['Ann', 'Bob']]);
  slackToken({ refused_at: '2026-11-02T00:00:00Z' });
  assert.deepEqual(due(), { waiting: 'Reviewer DMs and digests wait on Slack: Slack refused the token.', links: [], reactions: [], edits: [], headers: [], digest: null });
});

test("review due reacts approved once GitHub's review decision is APPROVED, or on any approval where the branch asks for no review", async () => {
  const due = () => {
    const script = `import {main} from ${JSON.stringify(new URL('./bin/board.mjs', import.meta.url).href)};
      process.exitCode = await main(['--site', 'orch', 'review', 'due'], {now: new Date('2026-11-02T17:00:00Z')});`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  slackToken();
  assert.equal((await board('slack', 'set', '--timezone', 'America/Los_Angeles')).code, 0);
  write(at('waves', 'w', 'wave.json'), { repo: 'o/r', reviewers: [annReviewer], items: [1, 2, 3, 4].map((pr) => ({ id: `A${pr}`, title: `PR ${pr}`, pr })) });
  write(site('orch', 'data', 'pr-slack.json'), Object.fromEntries([1, 2, 3, 4].map((pr) => [`o/r#${pr}`, { head: `h${pr}`, links: { Ann: { channel: 'D1', ts: `${pr}.1`, reactions: [] } }, replies: [] }])));
  const open = { state: 'OPEN', isDraft: false };
  write(at('kickflip', 'github-state.json'), { prs: {
    'o/r#1': { ...open, reviewDecision: 'APPROVED', approved: true },
    // Someone approved, but not a code owner the branch's protection asks for.
    'o/r#2': { ...open, reviewDecision: 'REVIEW_REQUIRED', approved: true },
    'o/r#3': { ...open, reviewDecision: null, approved: true },
    'o/r#4': { ...open, reviewDecision: null, approved: false },
  } });
  assert.deepEqual(due().reactions.map((r) => [r.pr, r.kind]), [['o/r#1', 'approved'], ['o/r#3', 'approved']]);
});

test("review due reacts approved on a reviewer's messages once that reviewer approved or GitHub's decision is APPROVED, never for a bot's or another's approval", async () => {
  const due = () => {
    const script = `import {main} from ${JSON.stringify(new URL('./bin/board.mjs', import.meta.url).href)};
      process.exitCode = await main(['--site', 'orch', 'review', 'due'], {now: new Date('2026-11-02T17:00:00Z')});`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  slackToken();
  assert.equal((await board('slack', 'set', '--timezone', 'America/Los_Angeles')).code, 0);
  write(at('waves', 'w', 'wave.json'), { repo: 'o/r', reviewers: [annReviewer, bobReviewer], items: [1, 2].map((pr) => ({ id: `A${pr}`, title: `PR ${pr}`, pr })) });
  write(site('orch', 'data', 'pr-slack.json'), Object.fromEntries([1, 2].map((pr) => [`o/r#${pr}`, { head: `h${pr}`, links: { Ann: { channel: 'D1', ts: `${pr}.1`, reactions: [] }, Bob: { channel: 'D2', ts: `${pr}.2`, reactions: [] } }, replies: [] }])));
  const open = { state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED' };
  write(at('kickflip', 'github-state.json'), { prs: {
    // Ann approved, and so did a bot: only Ann's message reacts.
    'o/r#1': { ...open, approved: true, reviews: { ann: 'APPROVED', 'github-actions[bot]': 'APPROVED' } },
    // GitHub's gate is met: every reviewer's message reacts.
    'o/r#2': { ...open, reviewDecision: 'APPROVED' },
  } });
  assert.deepEqual(due().reactions.map((r) => [r.pr, r.reviewer, r.kind]), [['o/r#1', 'Ann', 'approved'], ['o/r#2', 'Ann', 'approved'], ['o/r#2', 'Bob', 'approved']]);
});

test('review digest waits without changing the record while Slack is not ready', async () => {
  const now = '2026-11-02T17:00:00Z';
  await board('slack', 'set', '--timezone', 'America/Los_Angeles');
  const file = site('orch', 'data', 'review-digests.json');
  const record = { last_date: '2026-10-30', digests: [] };
  write(file, record);
  const digest = digestCommand([], now);
  assert.equal(digest.due, false);
  assert.equal(digest.waiting, 'Reviewer DMs and digests wait on Slack: No Slack token set.');
  assert.equal(digest.date, '2026-11-02');
  assert.deepEqual(digest.reviewers, []);
  assert.deepEqual(read(file), record);
  slackToken({ refused_at: '2026-11-02T00:00:00Z' });
  assert.match(digestCommand([], now).waiting, /Slack refused the token/);
  slackToken();
  assert.equal(digestCommand([], now).waiting, undefined);
  assert.deepEqual(read(file), record);
});

// docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
test('Pause board saves its end in board.json beside the other settings, takes forever and clears with off', async () => {
  const { setBoardPause, readBoardSettings } = await import('./store.mjs');
  const { readUsageGate } = await import('../shared/usage-gate.mjs');
  const dir = site('audit');
  const before = read(path.join(dir, 'board.json'));
  const from = new Date();
  const end = await setBoardPause(dir, '1h', from);
  assert.equal(end, new Date(from.getTime() + 3600_000).toISOString());
  assert.deepEqual(read(path.join(dir, 'board.json')), { ...before, paused_until: end });
  assert.equal(readUsageGate({ home, dir }).manual, 'board');
  assert.equal('paused_until' in (await readBoardSettings(dir)), false, 'the pause is no board setting the session is told of');
  for (const choice of ['later', '0m']) await assert.rejects(setBoardPause(dir, choice, from), /A pause ends after now/);
  assert.equal(await setBoardPause(dir, 'forever', from), 'forever');
  assert.deepEqual(read(path.join(dir, 'board.json')), { ...before, paused_until: 'forever' });
  assert.equal(readUsageGate({ home, dir }).resets_at, 'forever');
  assert.equal(await setBoardPause(dir, 'off', from), null);
  assert.deepEqual(read(path.join(dir, 'board.json')), before);
});

// docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md
test("script set replaces the board's kickflip-held script from a file or stdin, and script show prints it back", async () => {
  write(site('orch', 'board.json'), { title: 'Orch', items: 'waves' });
  assert.match((await board('script', 'show', 'build', '--site', 'orch')).err, /this board has no build script in kickflip/);
  write(path.join(home, 'build.sh'), '#!/bin/sh\necho port 4000\n');
  const saved = await board('script', 'set', 'build', '--file', path.join(home, 'build.sh'), '--site', 'orch');
  assert.deepEqual(saved, { code: 0, out: `saved ${site('orch', 'scripts', 'build')}\nthis board runs the repo’s .kickflip/ scripts until settings set scripts kickflip\n`, err: '' });
  assert.equal(fs.statSync(site('orch', 'scripts', 'build')).mode & 0o777, 0o700);
  assert.deepEqual(await board('script', 'show', 'build', '--site', 'orch'), { code: 0, out: '#!/bin/sh\necho port 4000\n', err: '' });
  assert.equal((await board('settings', 'set', 'scripts', 'kickflip', '--site', 'orch')).code, 0);
  const piped = run('board.mjs', ['script', 'set', 'release', '--file', '-', '--site', 'orch'], '#!/bin/sh\necho "$1 ok"\n');
  assert.deepEqual(piped, { code: 0, out: `saved ${site('orch', 'scripts', 'release')}\n`, err: '' });
  assert.equal(fs.readFileSync(site('orch', 'scripts', 'release'), 'utf8'), '#!/bin/sh\necho "$1 ok"\n');
  assert.match((await board('script', 'set', 'serve', '--file', path.join(home, 'build.sh'), '--site', 'orch')).err, /no script "serve"/);
  assert.match((await board('script', 'set', 'build', '--site', 'orch')).err, /script set needs --file/);
});
