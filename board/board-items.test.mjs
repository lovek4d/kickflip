import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { until } from '../shared/test-helpers.mjs';
import { home, at, site, write, read, lines, run, board, wave, question, recordPrototype, addPrototypeQuestion, git, commit, scratchRepo, boardsManifest, addEvents } from './board-fixture.mjs';

test('item add records creation on a card with no status, and refuses a taken id, an unknown dep, or a --summary', () => {
  const before = Date.now();
  const withoutCreated = (item) => {
    const { created, ...rest } = item;
    const ts = Date.parse(created);
    assert.ok(ts >= before && ts <= Date.now());
    assert.equal(created, new Date(ts).toISOString());
    return rest;
  };
  const summed = board('item', 'add', 'w/B2', '--site', 'orch', '--title', 'Two', '--notes', 'Why', '--summary', 'Asked why.');
  assert.equal(summed.code, 2);
  assert.match(summed.err, /item add does not take --summary/);
  assert.equal(board('item', 'add', 'w/B2', '--site', 'orch', '--title', 'Two', '--notes', 'Why').code, 0);
  assert.deepEqual(withoutCreated(read(at('waves', 'w', 'wave.json')).items.at(-1)), { id: 'B2', title: 'Two', notes: 'Why', unfiled: true, ticket: 'INT-1' });
  assert.equal(board('item', 'add', 'w/C3', '--site', 'orch', '--title', 'Three', '--deps', 'A1,B2').code, 0);
  assert.deepEqual(withoutCreated(read(at('waves', 'w', 'wave.json')).items.at(-1)), { id: 'C3', title: 'Three', deps: ['A1', 'B2'], unfiled: true, ticket: 'INT-2' });
  const taken = board('item', 'add', 'w/A1', '--site', 'orch', '--title', 'Again');
  assert.equal(taken.code, 1);
  assert.match(taken.err, /already has an item "A1"/);
  const dep = board('item', 'add', 'w/D4', '--site', 'orch', '--title', 'Four', '--deps', 'Z9');
  assert.equal(dep.code, 1);
  assert.match(dep.err, /no item "Z9"/);
  assert.equal(read(at('waves', 'w', 'wave.json')).items.length, 4);
  assert.equal(board('item', 'add', 'audit/E5', '--site', 'audit', '--title', 'Five').code, 0);
  assert.deepEqual(withoutCreated(read(site('audit', 'data', 'wave.json')).items.at(-1)), { id: 'E5', title: 'Five', unfiled: true, ticket: 'INT-1' });
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].created, undefined);
});

test('on a board whose repo is a plain git remote, item set --pushed records the branch In Review and closes the builder, settings refuse GitHub issues, and a GitHub board refuses --pushed', () => {
  const cmd = [process.execPath, fileURLToPath(new URL('./server.mjs', import.meta.url))];
  write(at('kickflip', 'manifest.json'), { sites: { audit: { dir: site('audit'), cmd, remote: 'git@gitlab.com:acme/audit.git', branch: 'main' }, orch: { dir: site('orch'), cmd, github: 'o/r' } } });
  assert.equal(board('builder', 'start', 'audit/A1', '--site', 'audit').code, 0);
  const r = board('item', 'set', 'audit/A1', '--site', 'audit', '--pushed', 'A1');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^A1: pushed A1\n/);
  const { pushed, ...item } = read(site('audit', 'data', 'wave.json')).items[0];
  assert.deepEqual([item.branch, item.status, typeof Date.parse(pushed.at)], ['A1', undefined, 'number']);
  assert.equal(pushed.branch, 'A1');
  assert.ok(read(site('audit', 'data', 'agents', 'A1.json')).done);
  assert.match(board('item', 'set', 'audit/A1', '--site', 'audit', '--pushed', 'bad..branch').err, /branch you pushed/);
  assert.match(board('item', 'set', 'w/A1', '--site', 'orch', '--pushed', 'A1').err, /plain git remote; on GitHub, open a PR and pass --pr/);
  const tickets = board('--site', 'audit', 'settings', 'set', 'tickets', '{"source":"github"}');
  assert.equal(tickets.code, 1);
  assert.match(tickets.err, /GitHub issues need the board’s repo on GitHub/);
  assert.equal(board('--site', 'orch', 'settings', 'set', 'tickets', '{"source":"github"}').code, 0);
});

test("item set --pr adds each PR, repeatable, in the board's repo or owner/repo#n, and never replaces one", () => {
  const file = at('waves', 'w', 'wave.json');
  write(file, { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 6, status: 'building' }] });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--pr', 'lovek4d/lovek4d.github.io#1').code, 0);
  assert.deepEqual(read(file).items[0].prs, [{ number: 6 }, { repo: 'lovek4d/lovek4d.github.io', number: 1 }]);
  assert.equal('pr' in read(file).items[0], false);
  assert.equal(read(file).items[0].status, undefined);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--pr', '6', '--pr', 'o/r#6', '--pr', 'o/api#9', '--pr', 'lovek4d/lovek4d.github.io#1').code, 0);
  assert.deepEqual(read(file).items[0].prs, [{ number: 6 }, { repo: 'lovek4d/lovek4d.github.io', number: 1 }, { repo: 'o/api', number: 9 }]);
  const before = fs.readFileSync(file, 'utf8');
  for (const bad of ['abc', 'o/r#x', 'https://github.com/o/r/pull/3']) {
    const r = board('item', 'set', 'w/A1', '--site', 'orch', '--pr', '7', '--pr', bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /--pr takes a PR number or owner\/repo#<n>/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('item set edits the item in a waves board and in a file board', () => {
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'building', '--next', 'Run tests', '--pr', '42').code, 0);
  const { status_at: _w, review_since: arrived, ...edited } = read(at('waves', 'w', 'wave.json')).items[0];
  assert.equal(typeof arrived, 'string');
  assert.deepEqual(edited, { id: 'A1', title: 'One', next: 'Run tests', prs: [{ number: 42 }] });
  for (const [key, route, file] of [['w/A1', 'orch', at('waves', 'w', 'wave.json')], ['audit/A1', 'audit', site('audit', 'data', 'wave.json')]]) {
    for (const status of ['building', 'fixing', 'checking', 'held', 'done']) {
      assert.equal(board('item', 'set', key, '--site', route, '--status', status,...(status === 'done' ? ['--text', 'Done.'] : [])).code, 0);
      assert.equal(board('item', 'set', key, '--site', route, '--pr', '7').code, 0);
      assert.equal(read(file).items[0].status, ['building', 'fixing'].includes(status) ? undefined : status);
    }
  }
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--from-ask', 'e9', '--state', 'ready', '--text', 'On it.').code, 1);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--from-ask', 'e1', '--state', 'grilling', '--text', 'On it.').code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].ticket, 'INT-1');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--from-ask', 'e1', '--state', 'grilling', '--text', 'On it.').code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].ticket, 'INT-1');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].from_ask, 'e1');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking', '--next', '').code, 0);
  assert.deepEqual([read(at('waves', 'w', 'wave.json')).items[0].status, 'next' in read(at('waves', 'w', 'wave.json')).items[0]], ['checking', false]);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--clear-next', '--status', 'held').code, 0);
  const { status_at: _a, review_since: _r, ...audit } = read(site('audit', 'data', 'wave.json')).items[0];
  assert.deepEqual(audit, { id: 'A1', title: 'One', status: 'held', prs: [{ number: 7 }] });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'audit', '--status', 'held').code, 1);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--status', 'shipped').code, 1);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--pr', 'abc').code, 1);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit').code, 1);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--clear-status').code, 0);
  assert.equal(read(site('audit', 'data', 'wave.json')).items[0].status, undefined);
});

// docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md
test('item set --state sets ready, grilling or prototyping, with --from-ask too, and refuses any other state and ready while a question is open', () => {
  const state = () => read(at('waves', 'w', 'wave.json')).items[0].state;
  // docs/adr/2026-11-07-0700-staging-then-ready.md: ready comes from staging, which only the board sets.
  const stage = () => { const w = read(at('waves', 'w', 'wave.json')); w.items[0].state = 'staging'; write(at('waves', 'w', 'wave.json'), w); };
  const r = board('item', 'set', 'w/A1', '--site', 'orch', '--from-ask', 'e1', '--text', 'On it.', '--state', 'grilling');
  assert.deepEqual([r.code, state()], [0, 'grilling']);
  assert.match(r.out, /grilling/);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'prototyping').code, 0);
  assert.equal(state(), 'prototyping');
  assert.deepEqual(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'done'), { code: 1, out: '', err: '--state takes ready, grilling or prototyping\n' });
  write(path.join(home, 'card.json'), question('q1', { topic: 'item:w/A1' }));
  assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'card.json')).code, 0);
  stage();
  assert.deepEqual(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready'), { code: 1, out: '', err: 'w/A1 has an open question q1; it is ready once the owner has answered it\n' });
  assert.equal(state(), 'staging');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'grilling').code, 0);
  assert.equal(board('question', 'resolve', 'q1', '--site', 'orch', '--note', 'Settled').code, 0);
  write(at('waves', 'w', 'a1.md'), '# A1\n');
  stage();
  // docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md: a ready card's Next never asks to mark it ready.
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'Mark ready').code, 0);
  const refused = board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready', '--size', 'small', '--notes-file', 'a1.md');
  assert.deepEqual(refused, { code: 1, out: '', err: 'w/A1 would read ready with Next "Mark ready", which asks for the state it is already in; pass --next with what happens next, or --clear-next\n' });
  assert.equal(state(), 'staging');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready', '--size', 'small', '--notes-file', 'a1.md', '--clear-next').code, 0);
  assert.equal(state(), 'ready');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'mark it ready').code, 1);
});

// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
test('ready refuses a card without a size, without a notes file, or whose notes leave out an answered question, and resolves the answered questions its notes carry', () => {
  const state = () => read(at('waves', 'w', 'wave.json')).items[0].state;
  const staged = read(at('waves', 'w', 'wave.json'));
  staged.items[0].state = 'staging';
  write(at('waves', 'w', 'wave.json'), staged);
  assert.deepEqual(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready'), { code: 1, out: '', err: 'w/A1 has no size; a builder starts from it, so pass --size small or large with --state ready\n' });
  assert.deepEqual(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready', '--size', 'small'), { code: 1, out: '', err: 'w/A1 has no notes file; a builder starts from it, so pass --notes-file <file.md> with --state ready\n' });
  assert.equal(state(), 'staging');
  write(path.join(home, 'card.json'), question('q1', { topic: 'item:w/A1' }));
  assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'card.json')).code, 0);
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A' } }) + '\n');
  // The question moved the card to grilling; the owner's Send stages it again.
  write(at('waves', 'w', 'wave.json'), staged);
  write(at('waves', 'w', 'a1.md'), '# A1\n\nKeep it.\n');
  assert.deepEqual(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready', '--size', 'small', '--notes-file', 'a1.md'), { code: 1, out: '', err: "w/A1's notes leave out the answered question q1; record each answer in a1.md, naming its id, before it is ready\n" });
  write(at('waves', 'w', 'a1.md'), '# A1\n\n- q1: keep it.\n');
  // The notes file came in an earlier command, so ready alone resolves the answer the notes carry.
  const wave = read(at('waves', 'w', 'wave.json'));
  Object.assign(wave.items[0], { size: 'small', plan: 'a1.md', state: 'staging' });
  write(at('waves', 'w', 'wave.json'), wave);
  const ready = board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready');
  assert.equal(ready.code, 0);
  assert.match(ready.out, /resolved: q1/);
  assert.equal(state(), 'ready');
  assert.ok(read(site('orch', 'data', 'owner.json')).items.find((q) => q.id === 'q1').resolved);
  // There is no setting to turn the check off.
  assert.equal(board('settings', 'set', 'headless-builders', 'off', '--site', 'orch').code, 1);
});

test('item set --next requires unfinished card ids and refs to be deps, and allows finished cards', () => {
  write(site('audit', 'data', 'wave.json'), { internal: true, items: [
    { id: 'A1', title: 'One', next: 'Old' },
    { id: 'S133', title: 'Blocker', status: 'checking' },
    { id: 'INT-134', title: 'Other blocker', status: 'planned' },
    ...['done', 'merged', 'dropped'].map((status, i) => ({ id: `S${140 + i}`, title: 'Finished', status })),
  ] });
  const items = () => read(site('audit', 'data', 'wave.json')).items;
  for (const name of ['S133', 'INT-133', 'audit/S133', 'audit/INT-133', 'INT-134', 'audit/INT-134']) {
    const r = board('item', 'set', 'audit/A1', '--site', 'audit', '--next', `Wait for (${name}).`, '--title', 'Changed');
    assert.equal(r.code, 1, name);
    assert.match(r.err, /audit\/(S133|INT-134).*--deps/);
    assert.equal(r.err.trim().split('\n').length, 1);
    assert.deepEqual(items()[0], { id: 'A1', title: 'One', next: 'Old' });
  }
  for (const next of ['Follow INT-140, audit/S141 and INT-142.', 'Check INT-1330, other/INT-133 and A1.']) {
    assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--next', next).code, 0);
    assert.equal(items()[0].next, next);
  }
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--next', 'After INT-133', '--deps', 'S133').code, 0);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--next', 'After audit/INT-133').code, 0);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--next', 'After S133', '--deps', '').code, 1);
  assert.deepEqual(items()[0].deps, ['S133']);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'After audit/S133').code, 0);
  write(at('waves', 'x', 'wave.json'), { internal: true, items: [{ id: 'S133', title: 'Blocker' }] });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'After x/INT-133').code, 1);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'After x/INT-133', '--deps', 'x/S133').code, 0);
});

test('item set --notes-file, or its alias --plan, names a notes file inside the wave folder and refuses a --summary, and --title renames the card', () => {
  write(at('waves', 'w', 'A1-notes.md'), '# So far');
  write(at('waves', 'w', 'A1-old.md'), '# Old');
  const item = () => read(at('waves', 'w', 'wave.json')).items[0];
  const summed = board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', 'A1-notes.md', '--summary', 'So far.');
  assert.equal(summed.code, 2);
  assert.match(summed.err, /item set does not take --summary/);
  assert.equal(item().plan, undefined);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', 'A1-notes.md', '--title', 'One, renamed').code, 0);
  assert.deepEqual([item().plan, item().title], ['A1-notes.md', 'One, renamed']);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--plan', 'A1-old.md').code, 0);
  assert.equal(item().plan, 'A1-old.md');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--plan', 'A1-old.md', '--notes-file', 'A1-notes.md').code, 2);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', '../outside.md').code, 1);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--title', ' ').code, 1);
  assert.equal(board('item', 'add', 'w/B2', '--site', 'orch', '--title', 'Two', '--notes-file', 'A1-notes.md').code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items.at(-1).plan, 'A1-notes.md');
});

test("item set notes resolves a prototype pick with a note, whose note is the build's guidance", () => {
  recordPrototype();
  write(at('waves', 'w', 'notes.md'), '# Picked A');
  const file = site('orch', 'data', 'owner.json');
  assert.equal(addPrototypeQuestion('prototype-site.html?q=q1', { topic: 'item:w/A1' }).code, 0);
  addEvents({ id: 'answer-q1', ts: '2026-10-23T10:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A', note: 'Bigger' } });
  const r = board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', 'notes.md');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trim().split('\n').slice(1), ['resolved: q1']);
  assert.equal(read(file).items[0].resolved, "Recorded in the card's notes");
  assert.equal(board('question', 'confirm', 'q1', '--site', 'orch').code, 2);
});

test("item set notes resolves only answered questions, and closing in the same call resolves each question once", () => {
  write(at('waves', 'w', 'notes.md'), '# Settled');
  const file = site('orch', 'data', 'owner.json');
  const on = (id, extra = {}) => question(id, { topic: 'item:w/A1', ...extra });
  const original = [on('answered'), on('open'), on('replied'), on('resolved', { resolved: 'Settled', resolved_at: '2026-10-24T00:00:00Z' }), question('declared'), on('other-card', { topic: 'item:w/ENG-1' })];
  write(file, { topics: [{ id: 'site', title: 'Site' }], items: original });
  addEvents(...['answered', 'replied', 'resolved', 'declared', 'other-card'].map((id) =>
    ({ id: `answer-${id}`, ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id, choice: 'A' } })));
  assert.equal(board('reply', 'answer-replied', '--site', 'orch', '--html', '<p>Acted on it.</p>').code, 0);
  const before = [fs.readFileSync(file, 'utf8'), fs.readFileSync(at('waves', 'w', 'wave.json'), 'utf8')];
  for (const args of [['--title', ' '], ['--status', 'done']]) {
    const refused = board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', 'notes.md', ...args);
    assert.equal(refused.code, 1, refused.err);
    assert.equal(refused.out, '');
    assert.deepEqual([fs.readFileSync(file, 'utf8'), fs.readFileSync(at('waves', 'w', 'wave.json'), 'utf8')], before);
  }
  for (const flag of ['--notes-file', '--plan']) {
    write(file, { topics: [{ id: 'site', title: 'Site' }], items: original });
    const r = board('item', 'set', 'w/A1', '--site', 'orch', flag, 'notes.md');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out.trim().split('\n').slice(1), ['resolved: answered']);
    const items = read(file).items;
    assert.equal(items[0].resolved, "Recorded in the card's notes");
    assert.ok(Date.parse(items[0].resolved_at) <= Date.now());
    assert.deepEqual(items.slice(1), original.slice(1));
  }
  write(file, { topics: [], items: original });
  const done = board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', 'notes.md', '--status', 'done', '--force', '--text', 'Done.');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(done.out.trim().split('\n').slice(1), ['resolved: answered', 'resolved: open', 'resolved: replied']);
  assert.deepEqual(read(file).items.slice(0, 3).map((q) => q.resolved), Array(3).fill('Closed with the card'));
  assert.deepEqual(read(file).items.slice(3), original.slice(3));
});

test('a reply, --status building and builder start each resolve the answered questions they act on, leaving the rest', () => {
  const on = (id, topic) => question(id, { topic });
  const answer = (id) => ({ id: `answer-${id}`, ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id, choice: 'A' } });
  write(site('orch', 'data', 'owner.json'), { topics: [], items: [on('ask-q', 'item:ask:e1'), on('card-q', 'item:w/A1'), on('wave-q', 'wave:w'), on('open-q', 'item:w/A1')] });
  addEvents({ id: 'e2', ts: '2026-10-23T10:30:00Z', kind: 'wave-triage', data: { wave: 'w' } }, answer('ask-q'), answer('card-q'), answer('wave-q'));
  const notes = () => Object.fromEntries(read(site('orch', 'data', 'owner.json')).items.map((q) => [q.id, q.resolved ?? null]));
  assert.match(board('reply', 'e1', '--site', 'orch', '--html', '<p>Done.</p>').out, /^resolved: ask-q$/m);
  assert.match(board('reply', 'e2', '--site', 'orch', '--html', '<p>Lined up.</p>').out, /^resolved: wave-q$/m);
  const building = board('item', 'set', 'w/A1', '--status', 'building', '--site', 'orch');
  assert.equal(building.code, 0, building.err);
  assert.match(building.out, /^resolved: card-q$/m);
  assert.deepEqual(notes(), { 'ask-q': 'Acted on: replied', 'card-q': 'Acted on: build started', 'wave-q': 'Acted on: replied', 'open-q': null });
  addEvents(answer('open-q'));
  assert.match(board('builder', 'start', 'w/A1', '--site', 'orch').out, /^resolved: open-q$/m);
  assert.equal(notes()['open-q'], 'Acted on: builder started');
});

test('item set --install records a device build with when it was built, takes only https or an iOS manifest link, and --clear-install removes it', () => {
  const ios = 'itms-services://?action=download-manifest&url=https://mac.ts.net/orch/installs/w-A1/manifest.plist';
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--install', ios, '--install-sha', 'ABCDEF1234', '--install-label', 'Install beta').code, 0);
  const { built_at, ...install } = read(at('waves', 'w', 'wave.json')).items[0].install;
  assert.deepEqual(install, { url: ios, label: 'Install beta', sha: 'abcdef1234' });
  assert.ok(Math.abs(Date.parse(built_at) - Date.now()) < 60000);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--install', 'https://mac.ts.net/audit/installs/audit-A1/app.apk').code, 0);
  assert.deepEqual(Object.keys(read(site('audit', 'data', 'wave.json')).items[0].install), ['url', 'built_at']);
  for (const [args, err] of [
    [['--install', 'http://mac.ts.net/app.apk'], /^--install takes an https:\/\/ or itms-services:\/\/ URL/],
    [['--install', 'javascript:alert(1)'], /^--install takes /],
    [['--install', 'itms-services://?action=download-manifest&url=http://x/manifest.plist'], /^--install: an itms-services/],
    [['--install', ios, '--install-sha', 'main'], /^--install-sha takes a commit sha/],
    [['--install-sha', 'abcdef1'], /^--install-sha and --install-label go with --install/],
    [['--install', ios, '--clear-install'], /^pass --install or --clear-install, not both/],
  ]) {
    const r = board('item', 'set', 'w/A1', '--site', 'orch', ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err, args.join(' '));
  }
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].install.url, ios);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--clear-install').code, 0);
  assert.equal('install' in read(at('waves', 'w', 'wave.json')).items[0], false);
});

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
test('a follow-up is item add --parent; item set sets or clears a Parent and replaces Related to on both sides', () => {
  const item = (id) => read(site('audit', 'data', 'wave.json')).items.find((i) => i.id === id);
  const added = board('item', 'add', 'audit/ENG-7', '--site', 'audit', '--title', 'Tidy', '--parent', 'A1');
  assert.deepEqual([added.code, added.err], [0, '']);
  assert.deepEqual([item('ENG-7').parent, item('ENG-7').status], ['audit/A1', undefined]);
  for (const [args, err] of [
    [['item', 'add', 'audit/X1', '--title', 'X', '--parent', 'NOPE'], /^wave "audit" has no item "NOPE"/],
    [['item', 'set', 'audit/ENG-7', '--parent', 'ENG-7'], /^--parent: a card can't be its own Parent/],
    [['item', 'set', 'audit/A1', '--parent', 'ENG-7'], /^--parent: audit\/ENG-7 is a child of audit\/A1, so it can't be its Parent/],
    [['item', 'set', 'audit/A1', '--related', 'A1'], /^--related: a card can't be related to itself/],
  ]) {
    const r = board(...args, '--site', 'audit');
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err, args.join(' '));
  }
  assert.equal(item('X1'), undefined);
  const linked = board('item', 'set', 'audit/A1', '--site', 'audit', '--related', 'ENG-7,audit/ENG-1');
  assert.deepEqual([linked.code, linked.out], [0, 'A1: related to ENG-7, audit/ENG-1\n']);
  assert.deepEqual(item('A1').related, ['audit/ENG-7', 'audit/ENG-1']);
  // Clearing ENG-7's Related to takes it off A1 too, since a link shows on both cards.
  assert.equal(board('item', 'set', 'audit/ENG-7', '--site', 'audit', '--related', '').code, 0);
  assert.deepEqual(item('A1').related, ['audit/ENG-1']);
  assert.equal(board('item', 'set', 'audit/ENG-1', '--site', 'audit', '--related', '').code, 0);
  assert.equal('related' in item('A1'), false);
  const cleared = board('item', 'set', 'audit/ENG-7', '--site', 'audit', '--parent', '');
  assert.deepEqual([cleared.code, cleared.out, 'parent' in item('ENG-7')], [0, 'ENG-7: parent cleared\n', false]);
  assert.equal(board('item', 'set', 'audit/ENG-7', '--site', 'audit', '--parent', 'audit/ENG-1').out, 'ENG-7: parent audit/ENG-1\n');
});

// docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md
test('item set --relate adds links and --unrelate removes them on both sides, keeping the rest; neither goes with --related', () => {
  const item = (id) => read(site('audit', 'data', 'wave.json')).items.find((i) => i.id === id);
  for (const id of ['R1', 'R2', 'R3']) assert.equal(board('item', 'add', `audit/${id}`, '--site', 'audit', '--title', id, '--state', 'grilling').code, 0);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--related', 'R1').code, 0);
  const added = board('item', 'set', 'audit/A1', '--site', 'audit', '--relate', 'R2,audit/R1');
  assert.deepEqual([added.code, added.out], [0, 'A1: related to R2, audit/R1 added\n']);
  assert.deepEqual(item('A1').related, ['audit/R1', 'audit/R2']);
  // R3 stores its own link to A1; --unrelate takes it off R3 as well as A1's own list.
  assert.equal(board('item', 'set', 'audit/R3', '--site', 'audit', '--relate', 'A1').code, 0);
  const removed = board('item', 'set', 'audit/A1', '--site', 'audit', '--unrelate', 'R1,R3');
  assert.deepEqual([removed.code, removed.out], [0, 'A1: unrelated from R1, R3\n']);
  assert.deepEqual([item('A1').related, 'related' in item('R3')], [['audit/R2'], false]);
  for (const [args, err] of [
    [['--relate', 'A1'], /^--relate: a card can't be related to itself/],
    [['--relate', 'NOPE'], /^wave "audit" has no item "NOPE"/],
    [['--relate', 'R1', '--related', 'R2'], /^pass --related, or --relate and --unrelate, not both/],
  ]) {
    const r = board('item', 'set', 'audit/A1', '--site', 'audit', ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err, args.join(' '));
  }
  assert.deepEqual(item('A1').related, ['audit/R2']);
});

test("an agent's item add files the card New and wakes the orchestrator with card-added; item add --state files it at once, linked with --relate", () => {
  const item = (id) => read(site('audit', 'data', 'wave.json')).items.find((i) => i.id === id);
  const events = () => fs.readFileSync(site('audit', 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'card-added');
  const before = fs.existsSync(site('audit', 'data', 'events.jsonl')) ? events().length : 0;
  const newCard = board('item', 'add', 'audit/F1', '--site', 'audit', '--title', 'Follow it up', '--parent', 'A1');
  assert.deepEqual([newCard.code, newCard.err], [0, '']);
  assert.deepEqual([item('F1').unfiled, item('F1').state], [true, undefined]);
  assert.deepEqual(events().slice(before).map((e) => e.data), [{ key: 'audit/F1', title: 'Follow it up' }]);
  // The orchestrator's filing turn: links, then the state, which files it.
  const filed = board('item', 'set', 'audit/F1', '--site', 'audit', '--relate', 'A1', '--state', 'grilling');
  assert.equal(filed.code, 0, filed.err);
  assert.deepEqual([item('F1').state, 'unfiled' in item('F1'), item('F1').related], ['grilling', false, ['audit/A1']]);
  const direct = board('item', 'add', 'audit/F2', '--site', 'audit', '--title', 'Filed', '--state', 'prototyping', '--relate', 'A1,F1');
  assert.deepEqual([direct.code, direct.err], [0, '']);
  assert.deepEqual([item('F2').state, 'unfiled' in item('F2'), item('F2').related], ['prototyping', false, ['audit/A1', 'audit/F1']]);
  assert.equal(events().length, before + 1, 'a card filed with its state wakes nobody');
  const bad = board('item', 'add', 'audit/F3', '--site', 'audit', '--title', 'X', '--state', 'done');
  assert.deepEqual([bad.code, /^--state takes ready, grilling or prototyping/.test(bad.err), item('F3')], [1, true, undefined]);
});

test('--parent works when an ancestor of the new Parent no longer exists', () => {
  const file = site('audit', 'data', 'wave.json');
  const data = read(file);
  data.items.push({ id: 'ORPHAN', title: 'Orphan', parent: 'audit/GONE' }, { id: 'KID', title: 'Kid', parent: 'audit/ORPHAN' }, { id: 'NEW', title: 'New' });
  write(file, data);
  const set = board('item', 'set', 'audit/NEW', '--site', 'audit', '--parent', 'audit/KID');
  assert.deepEqual([set.code, set.err, set.out], [0, '', 'NEW: parent audit/KID\n']);
  const cycle = board('item', 'set', 'audit/ORPHAN', '--site', 'audit', '--parent', 'audit/KID');
  assert.match(cycle.err, /^--parent: audit\/KID is a child of audit\/ORPHAN/);
});

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
test("a wave file's follow-ups move into its items once: ids, titles, tickets and notes kept, done ones done, Filed from as the Parent", async (t) => {
  const { migrateFollowups } = await import('./store.mjs');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; });
  const file = site('audit', 'data', 'wave.json');
  write(file, { title: 'W', items: [{ id: 'A1', title: 'One' }], followups: [
    { id: 'open-one', title: 'Open', from: 'A1', filed: '2026-11-03', ticket: '#51', ticket_created: true, notes: 'Why' },
    { id: 'closed-one', title: 'Closed', from: 'A1', filed: '2026-11-02', ticket: '#65', done: true },
    { id: 'no-from', title: 'Orphan', filed: '2026-11-01' },
  ] });
  write(site('audit', 'data', 'threads', 'audit__closed-one.jsonl'), [{ ts: '2026-11-03T10:00:00.000Z', who: 'claude', text: 'Filed.' }, { ts: '2026-11-03T12:00:00.000Z', who: 'claude', text: 'Done.' }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.deepEqual(await migrateFollowups(site('audit')), ['audit: 3 follow-ups moved to cards (1 done)']);
  const after = read(file);
  assert.equal('followups' in after, false);
  assert.deepEqual(after.items, [
    { id: 'A1', title: 'One' },
    { id: 'open-one', title: 'Open', created: '2026-11-03', parent: 'audit/A1', ticket: '#51', ticket_created: true, notes: 'Why' },
    { id: 'closed-one', title: 'Closed', created: '2026-11-02', parent: 'audit/A1', status: 'done', status_at: '2026-11-03T12:00:00.000Z', ticket: '#65' },
    { id: 'no-from', title: 'Orphan', created: '2026-11-01' },
  ]);
  const text = fs.readFileSync(file, 'utf8');
  assert.deepEqual(await migrateFollowups(site('audit')), []);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  // A follow-up whose id a card already has leaves the file as it is and names the clash.
  write(file, { items: [{ id: 'A1', title: 'One' }], followups: [{ id: 'A1', title: 'Clash', filed: '2026-11-01' }] });
  const clash = fs.readFileSync(file, 'utf8');
  await assert.rejects(migrateFollowups(site('audit')), /audit: follow-up A1 has the id of a card; rename one, then restart the board/);
  assert.equal(fs.readFileSync(file, 'utf8'), clash);
});

// docs/adr/2026-11-05-0226-a-grill-with-nothing-left-to-ask-ends-ready.md
test('statuses planned and waiting are gone: the board drops them from every card on load, and item set refuses both', async (t) => {
  const { dropPlannedStatus } = await import('./store.mjs');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; });
  const file = site('audit', 'data', 'wave.json');
  write(file, { title: 'W', items: [{ id: 'A1', title: 'One', status: 'planned', state: 'ready' }, { id: 'A2', title: 'Two', status: 'waiting' }, { id: 'A3', title: 'Three', status: 'done' }, { id: 'A4', title: 'Four' }] });
  assert.deepEqual(await dropPlannedStatus(site('audit')), ['audit: 2 planned or waiting cards now have no status']);
  assert.deepEqual(read(file).items, [{ id: 'A1', title: 'One', state: 'ready' }, { id: 'A2', title: 'Two' }, { id: 'A3', title: 'Three', status: 'done' }, { id: 'A4', title: 'Four' }]);
  assert.deepEqual(await dropPlannedStatus(site('audit')), []);
  const refused = board('item', 'set', 'audit/A2', '--site', 'audit', '--status', 'planned');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /--status planned is gone: an unstarted card has no status/);
  assert.equal(read(file).items[1].status, undefined);
  const waiting = board('item', 'set', 'audit/A2', '--site', 'audit', '--status', 'waiting');
  assert.equal(waiting.code, 1);
  assert.match(waiting.err, /--status waiting is gone: an unstarted card has no status/);
});

test("closing a card resolves its answered questions, refuses while one has no answer, changing nothing, and --force closes it anyway", () => {
  board('item', 'add', 'w/A2', '--title', 'Two', '--site', 'orch');
  const on = (key) => ({ topic: `item:${key}` });
  write(site('orch', 'data', 'owner.json'), { topics: [{ id: 'site', title: 'Site' }], items: [
    question('q1', on('w/A1')),
    question('q2', { ...on('w/A1'), resolved: 'Kept.', resolved_at: '2026-10-23T10:00:00Z' }),
    question('q3', { ...on('w/A1'), resolved: 'Old.', resolved_at: '2026-10-23T12:00:00Z' }),
    question('q4'),
    question('q5', on('w/A2')), question('q6', on('w/A2')), question('q7', on('w/A2')),
    question('q8', on('w/ENG-1')), question('q9', on('w/ENG-1')),
  ] });
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), ['q1', 'q2', 'q3', 'q4', 'q5', 'q8'].map((id) =>
    JSON.stringify({ id: `a-${id}`, ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id, choice: 'A' } }) + '\n').join(''));
  const owner = () => Object.fromEntries(read(site('orch', 'data', 'owner.json')).items.map((q) => [q.id, q]));
  const notes = () => Object.fromEntries(Object.values(owner()).map((q) => [q.id, q.resolved ?? null]));

  const done = board('item', 'set', 'w/A1', '--status', 'done', '--site', 'orch', '--text', 'Done.');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(done.out.split('\n').filter((l) => l.startsWith('resolved')), ['resolved: q1', 'resolved: q2']);
  assert.deepEqual(notes(), { q1: 'Closed with the card', q2: 'Closed with the card', q3: 'Old.', q4: null, q5: null, q6: null, q7: null, q8: null, q9: null });
  assert.ok(owner().q2.resolved_at > '2026-10-23T11:00:00Z');

  const before = [fs.readFileSync(at('waves', 'w', 'wave.json'), 'utf8'), fs.readFileSync(site('orch', 'data', 'owner.json'), 'utf8')];
  const unchanged = () => assert.deepEqual([fs.readFileSync(at('waves', 'w', 'wave.json'), 'utf8'), fs.readFileSync(site('orch', 'data', 'owner.json'), 'utf8')], before);
  for (const [args, err] of [
    [['item', 'set', 'w/A2', '--status', 'dropped'], /^--status dropped: w\/A2 has open questions q6, q7 with no answer yet; pass --force/],
    [['item', 'set', 'w/ENG-1', '--status', 'done'], /^--status done: w\/ENG-1 has an open question q9 with no answer yet; pass --force/],
    [['item', 'set', 'w/A2', '--next', 'Later', '--force'], /^--force goes with --status done, merged, dropped/],
  ]) {
    const r = board(...args, '--site', 'orch');
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err, args.join(' '));
    assert.equal(r.err.trim().split('\n').length, 1, args.join(' '));
    unchanged();
  }

  assert.equal(board('item', 'set', 'w/A2', '--status', 'dropped', '--force', '--site', 'orch', '--text', 'Dropped.').code, 0);
  const forced = board('item', 'set', 'w/ENG-1', '--status', 'done', '--force', '--site', 'orch', '--text', 'Done.');
  assert.equal(forced.code, 0, forced.err);
  assert.deepEqual(forced.out.split('\n').filter((l) => l.startsWith('resolved')), ['resolved: q8', 'resolved: q9']);
  const wave = read(at('waves', 'w', 'wave.json'));
  assert.deepEqual(['A2', 'ENG-1'].map((id) => wave.items.find((i) => i.id === id).status), ['dropped', 'done']);
  assert.deepEqual(['q5', 'q6', 'q7', 'q8', 'q9'].map((id) => notes()[id]), Array(5).fill('Closed with the card'));
});

// docs/adr/2026-11-03-0237-an-in-progress-card-always-has-a-builder-line-or-a-next.md
test('a write that would leave a built card In Progress with nothing building and no Next is refused, naming --next, and writes nothing', () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One' }, { id: 'A2', title: 'Two' }] });
  const items = () => read(at('waves', 'w', 'wave.json')).items;
  const main = at('waves', 'w', 'agents', 'A1.json');
  assert.equal(board('builder', 'start', 'w/A1', '--label', 'Opus builder').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'bench').code, 0);
  assert.equal(board('builder', 'done', 'w/A1', '--agent', 'bench').code, 0);
  const refused = board('builder', 'done', 'w/A1', '--site', 'orch');
  assert.deepEqual([refused.code, refused.err.trim()], [1, 'builder done closes w/A1\'s last open builder, which leaves it In Progress with no Next; pass --next "<what happens next>", or hand it back with item set w/A1 --status checking or land']);
  assert.equal('done' in read(main), false);
  assert.equal(board('builder', 'done', 'w/A1', '--site', 'orch', '--next', 'Land it').code, 0);
  assert.deepEqual([typeof read(main).done, items()[0].next], ['string', 'Land it']);

  for (const args of [['--clear-next'], ['--next', '']]) {
    const r = board('item', 'set', 'w/A1', '--site', 'orch', ...args);
    assert.deepEqual([r.code, r.err.trim()], [1, 'that leaves w/A1 In Progress with nothing building and no Next; pass --next "<what happens next>"'], args.join(' '));
  }
  assert.equal(items()[0].next, 'Land it');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking', '--clear-next').code, 0);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--clear-status').code, 1);
  assert.equal(items()[0].status, 'checking');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--clear-status', '--next', 'Fix the review finding').code, 0);

  // A card only grilled stays in Todo, a checking card reads Orchestrator review, and a held one isn't In Progress.
  assert.equal(board('builder', 'start', 'w/A2', '--kind', 'grill').code, 0);
  assert.equal(board('builder', 'done', 'w/A2', '--site', 'orch').code, 0);
  for (const [flags, status] of [[['--held'], undefined], [['--unheld', '--status', 'checking'], 'checking']]) {
    assert.equal(board('builder', 'start', 'w/A2').code, 0);
    assert.equal(board('item', 'set', 'w/A2', '--site', 'orch', ...flags).code, 0);
    if (status) assert.equal(board('builder', 'start', 'w/A2').code, 0);
    assert.equal(board('builder', 'done', 'w/A2', '--site', 'orch').code, 0, flags.join(' '));
  }
});

test('item set refuses to start a blocked item, and finishing a dep prints, threads and emits each unblocking once', () => {
  write(at('waves', 'd', 'wave.json'), { items: [
    { id: 'A1', title: 'One', status: 'building' },
    { id: 'A2', title: 'Two', deps: ['A1'] },
    { id: 'A3', title: 'Three', deps: ['A1', 'A2'] },
    { id: 'A4', title: 'Four', status: 'done', deps: ['A1'] },
    { id: 'A5', title: 'Five', deps: ['d/A3'] },
  ] });
  const status = () => read(at('waves', 'd', 'wave.json')).items.map((it) => it.status);
  const events = () => lines(site('orch', 'data', 'events.jsonl')).filter((e) => e.kind === 'card-unblocked');
  const blocked = board('item', 'set', 'd/A3', '--status', 'building', '--site', 'orch');
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /d\/A1.*d\/A2|d\/A2.*d\/A1/);
  assert.deepEqual(status(), ['building', undefined, undefined, 'done', undefined]);
  assert.deepEqual(events(), []);
  const done = board('item', 'set', 'd/A1', '--status', 'done', '--site', 'orch', '--text', 'Done.');
  assert.equal(done.code, 0);
  assert.deepEqual(done.out.split('\n').filter((l) => l.startsWith('unblocked')), ['unblocked: d/A2']);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'd__A2.jsonl')).map(({ ts, ...m }) => m), [{ who: 'claude', text: 'Unblocked: A1 is done.' }]);
  assert.equal(fs.existsSync(site('orch', 'data', 'threads', 'd__A3.jsonl')), false);
  assert.deepEqual(events().map((e) => e.data), [{ key: 'd/A2' }]);
  assert.ok(events()[0].id);
  assert.ok(Date.parse(events()[0].ts));
  for (const status of ['done', 'merged', 'dropped']) {
    const repeated = board('item', 'set', 'd/A1', '--status', status, '--site', 'orch', '--text', 'Again.');
    assert.equal(repeated.code, 0);
    assert.doesNotMatch(repeated.out, /unblocked:/);
  }
  assert.equal(events().length, 1);
  assert.equal(lines(site('orch', 'data', 'threads', 'd__A2.jsonl')).length, 1);
  assert.equal(board('item', 'set', 'd/A2', '--status', 'building', '--site', 'orch').code, 0);
  const merged = board('item', 'set', 'd/A2', '--status', 'merged', '--site', 'orch');
  assert.deepEqual(merged.out.split('\n').filter((l) => l.startsWith('unblocked')), ['unblocked: d/A3']);
  assert.deepEqual(events().map((e) => e.data.key), ['d/A2', 'd/A3']);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'd__A2.jsonl')).map((m) => m.text), ['Unblocked: A1 is done.', 'Merged.']);
  const untold = board('item', 'set', 'd/A3', '--status', 'dropped', '--site', 'orch');
  assert.equal(untold.code, 1);
  assert.match(untold.err, /^--status dropped needs --text/);
  assert.equal(read(at('waves', 'd', 'wave.json')).items[2].status, undefined);
  const dropped = board('item', 'set', 'd/A3', '--status', 'dropped', '--site', 'orch', '--text', 'Dropped: A5 covers it.');
  assert.equal(dropped.code, 0);
  assert.match(dropped.out, /unblocked: d\/A5/);
  assert.equal(lines(site('orch', 'data', 'threads', 'd__A3.jsonl')).at(-1).text, 'Dropped: A5 covers it.');
  assert.deepEqual(events().map((e) => e.data.key), ['d/A2', 'd/A3', 'd/A5']);
  write(site('audit', 'data', 'wave.json'), { items: [
    { id: 'A1', status: 'building' }, { id: 'A2', status: 'checking' },
    { id: 'A3', deps: ['A1', 'audit/A2'] },
  ] });
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--status', 'done', '--text', 'Done.').code, 0);
  assert.equal(fs.existsSync(site('audit', 'data', 'events.jsonl')), false);
  assert.equal(board('item', 'set', 'audit/A2', '--site', 'audit', '--status', 'merged').code, 0);
  assert.deepEqual(lines(site('audit', 'data', 'events.jsonl')).map((e) => [e.kind, e.data]), [['card-unblocked', { key: 'audit/A3' }]]);
});

test('item set takes checking as a hand-back that unblocks nothing, and done from checking unblocks as usual', () => {
  write(at('waves', 'd', 'wave.json'), { items: [
    { id: 'A1', title: 'One', status: 'building' },
    { id: 'A2', title: 'Two', deps: ['A1'] },
  ] });
  const unblocked = (r) => r.out.split('\n').filter((l) => l.startsWith('unblocked'));
  const checking = board('item', 'set', 'd/A1', '--status', 'checking', '--site', 'orch');
  assert.equal(checking.code, 0);
  assert.deepEqual(unblocked(checking), []);
  assert.equal(lines(site('orch', 'data', 'events.jsonl')).some((e) => e.kind === 'card-unblocked'), false);
  assert.equal(read(at('waves', 'd', 'wave.json')).items[0].status, 'checking');
  assert.equal(board('item', 'set', 'd/A2', '--status', 'building', '--site', 'orch').code, 1);
  assert.deepEqual(unblocked(board('item', 'set', 'd/A1', '--status', 'done', '--site', 'orch', '--text', 'Done.')), ['unblocked: d/A2']);
});

test('a held item emits its unblocking but never starts until --unheld resumes it', () => {
  write(at('waves', 'd', 'wave.json'), { items: [
    { id: 'A1', title: 'One', status: 'building' },
    { id: 'A2', title: 'Two', deps: ['A1'] },
    { id: 'A3', title: 'Three', status: 'held', deps: ['A1'] },
  ] });
  const items = () => read(at('waves', 'd', 'wave.json')).items;
  assert.equal(board('item', 'set', 'd/A2', '--held', '--site', 'orch').code, 0);
  assert.equal(items()[1].held, true);
  assert.equal(board('item', 'set', 'd/A2', '--held', '--unheld', '--site', 'orch').code, 1);
  const done = board('item', 'set', 'd/A1', '--status', 'done', '--site', 'orch', '--text', 'Done.');
  assert.deepEqual(done.out.split('\n').filter((l) => l.startsWith('unblocked')), ['unblocked: d/A2', 'unblocked: d/A3']);
  assert.deepEqual(lines(site('orch', 'data', 'events.jsonl')).filter((e) => e.kind === 'card-unblocked').map((e) => e.data.key), ['d/A2', 'd/A3']);
  const refused = board('item', 'set', 'd/A2', '--status', 'building', '--site', 'orch');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /d\/A2 is held.*--unheld/);
  assert.equal(items()[1].status, undefined);
  assert.equal(board('item', 'set', 'd/A3', '--status', 'building', '--site', 'orch').code, 1);
  assert.equal(board('item', 'set', 'd/A2', '--unheld', '--site', 'orch').code, 0);
  assert.equal(board('item', 'set', 'd/A3', '--unheld', '--site', 'orch').code, 0);
  assert.deepEqual(items().map((it) => [it.status, Boolean(it.held)]), [['done', false], [undefined, false], [undefined, false]]);
  assert.equal(board('item', 'set', 'd/A2', '--status', 'building', '--site', 'orch').code, 0);
});

test('--pick-up-at holds a card until a time, read as local time without an offset and stored as UTC; a past time is refused, "" and --unheld resume it, and --held drops the time', () => {
  write(at('waves', 'd', 'wave.json'), { items: [{ id: 'A1', title: 'One', status: 'planned' }] });
  const item = (id = 'A1') => read(at('waves', 'd', 'wave.json')).items.find((it) => it.id === id);
  const later = new Date(Date.now() + 2 * 86_400_000);
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T09:00`;
  const nine = new Date(later.getFullYear(), later.getMonth(), later.getDate(), 9, 0).toISOString();
  assert.equal(board('item', 'set', 'd/A1', '--pick-up-at', local, '--site', 'orch').code, 0);
  assert.deepEqual([item().held, item().pick_up_at], [true, nine]);
  const refused = board('item', 'set', 'd/A1', '--status', 'building', '--site', 'orch');
  assert.equal(refused.code, 1);
  assert.match(refused.err, new RegExp(`d/A1 is held until ${nine}.*--unheld`));
  for (const bad of ['2020-01-01T09:00', '2026-11-04', 'Wed 9am']) {
    const r = board('item', 'set', 'd/A1', '--pick-up-at', bad, '--site', 'orch');
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /--pick-up-at/);
  }
  assert.equal(board('item', 'set', 'd/A1', '--pick-up-at', local, '--held', '--site', 'orch').code, 1);
  assert.equal(board('item', 'set', 'd/A1', '--pick-up-at', later.toISOString(), '--site', 'orch').code, 0);
  assert.equal(item().pick_up_at, later.toISOString());
  assert.equal(board('item', 'set', 'd/A1', '--held', '--site', 'orch').code, 0);
  assert.deepEqual([item().held, item().pick_up_at], [true, undefined]);
  assert.equal(board('item', 'set', 'd/A1', '--pick-up-at', local, '--site', 'orch').code, 0);
  assert.equal(board('item', 'set', 'd/A1', '--pick-up-at', '', '--site', 'orch').code, 0);
  assert.deepEqual([item().held, item().pick_up_at], [undefined, undefined]);
  assert.equal(board('item', 'set', 'd/A1', '--pick-up-at', local, '--site', 'orch').code, 0);
  assert.equal(board('item', 'set', 'd/A1', '--unheld', '--site', 'orch').code, 0);
  assert.deepEqual([item().held, item().pick_up_at], [undefined, undefined]);
  assert.equal(board('item', 'add', 'd/A2', '--title', 'Two', '--pick-up-at', local, '--site', 'orch').code, 0);
  assert.deepEqual([item('A2').status, item('A2').held, item('A2').pick_up_at], [undefined, true, nine]);
});

test("item set --status building takes a prototype pick's note as guidance, and refuses while the newest answer to the card's prototypes picks no take", () => {
  const card = (id, url, extra = {}) => question(id, { topic: 'item:w/A1', ...(url ? { url: `${url}?q=${id}` } : {}), ...extra });
  write(site('orch', 'data', 'owner.json'), { topics: [{ id: 'site', title: 'Site' }], items: [
    card('q1', 'prototype-old.html'), card('q2', 'prototype-old.html'), card('q3', ''), card('q4', 'prototype-old.html', { topic: 'site' }),
  ] });
  let n = 0;
  const answer = (id, choice, note) => addEvents({ id: `a${++n}`, ts: `2026-11-01T10:${String(n).padStart(2, '0')}:00Z`, kind: 'owner-answer', data: { id, ...(choice ? { choice } : {}), ...(note === undefined ? {} : { note }) } });
  const start = (...extra) => board('item', 'set', 'w/A1', '--status', 'building', '--site', 'orch', ...extra);
  const status = () => read(at('waves', 'w', 'wave.json')).items[0].status;

  answer('q1', 'A', 'B, but with the moon on the left');
  answer('q3', null, 'Not this one');
  answer('q4', null, 'Nor this');
  assert.equal(start().code, 0);
  assert.equal(status(), 'building');
  assert.equal(fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl')), false);

  assert.equal(board('item', 'set', 'w/A1', '--clear-status', '--site', 'orch').code, 0);
  answer('q2', null, 'Neither: try a darker moon');
  assert.deepEqual(start(), { code: 1, out: '', err: 'w/A1 has no take picked: the owner\'s answer to q2 picks none ("Neither: try a darker moon"), so it prototypes again: draw the next round from that note, or grill when the note asks a question, and build once a take is picked\n' });
  assert.equal(status(), undefined);
  assert.equal(start('--confirmed', 'try a darker moon').code, 2);
  answer('q2', 'B');
  assert.equal(start().code, 0);
  assert.equal(status(), 'building');
});

// docs/adr/2026-11-06-0204-intake-triage-sorts-new-tasks-on-sonnet.md
test("intake handoff hands an intake event to the orchestrator: an intake-handoff event and a status line in its card's thread; any other event is refused", () => {
  const r = board('intake', 'handoff', 'e1', '--site', 'orch', '--text', 'Not sure which card it belongs to');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /handed to the orchestrator/);
  const ev = lines(site('orch', 'data', 'events.jsonl')).at(-1);
  assert.deepEqual([ev.kind, ev.data], ['intake-handoff', { event: 'e1', key: 'ask:e1', text: 'Not sure which card it belongs to' }]);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'ask__e1.jsonl')).map(({ ts, ...m }) => m),
    [{ who: 'claude', kind: 'status', text: 'Intake triage handed this to the orchestrator: Not sure which card it belongs to' }]);
  addEvents({ id: 'm9', ts: '2026-10-23T11:00:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'x' } });
  assert.deepEqual(board('intake', 'handoff', 'm9', '--site', 'orch', '--text', 'x'),
    { code: 1, out: '', err: `event "m9" isn't intake: a new task, the owner's message in an ask's thread, or a card an agent added\n` });
  assert.match(board('intake', 'handoff', 'e1', '--site', 'orch').err, /--text/);
});

test('item relate-ask folds an ask into an item with one summary line, ask unfold and item set --from-ask move it back out', () => {
  const r = board('item', 'relate-ask', 'e1', 'w/A1', '--summary', 'Asked to keep the header spacing', '--site', 'orch');
  assert.equal(r.code, 0);
  assert.deepEqual(read(site('orch', 'data', 'ask-links.json')), { links: { e1: 'w/A1' } });
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map(({ ts, ...m }) => m), [{ who: 'claude', text: 'Asked to keep the header spacing' }]);
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'm1', ts: '2026-10-23T10:00:00Z', kind: 'item-message', data: { key: 'w/A1' } }) + '\n');
  assert.match(board('item', 'relate-ask', 'm1', 'w/A1', '--summary', 'x', '--site', 'orch').err, /no ask "m1"/);
  assert.match(board('item', 'relate-ask', 'e1', 'w/A9', '--summary', 'x', '--site', 'orch').err, /no item "A9"/);
  assert.equal(board('ask', 'unfold', 'e1', '--site', 'orch').code, 0);
  assert.deepEqual(read(site('orch', 'data', 'ask-links.json')), { links: {} });
  assert.match(board('ask', 'unfold', 'e1', '--site', 'orch').err, /ask "e1" is not folded into a card/);
  board('item', 'relate-ask', 'e1', 'w/A1', '--summary', 'Back in', '--site', 'orch');
  const stateless = board('item', 'set', 'w/A1', '--from-ask', 'e1', '--site', 'orch', '--text', 'Building it.');
  assert.deepEqual([stateless.code, stateless.err], [1, '--from-ask files a card, which reads New until it has a state: pass --state grilling or prototyping, or staging for a Quick build ask\n']);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].from_ask, undefined);
  assert.equal(board('item', 'set', 'w/A1', '--from-ask', 'e1', '--state', 'grilling', '--site', 'orch', '--text', 'Building it.').code, 0);
  assert.deepEqual([read(site('orch', 'data', 'ask-links.json')), read(at('waves', 'w', 'wave.json')).items[0].from_ask], [{ links: {} }, 'e1']);
  assert.equal(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1).text, 'Building it.');
  assert.match(board('item', 'set', 'w/A1', '--from-ask', 'e1', '--state', 'ready', '--site', 'orch').err, /^--from-ask needs --text/);
});

test("ask move sends a New ask to another board with the owner's latest text, its attachments and its edits' and where it came from, and leaves it Done here with a line linking there", () => {
  boardsManifest();
  write(site('orch', 'data', 'uploads', '1700-shot.png'), 'png bytes');
  write(site('orch', 'data', 'uploads', '.meta', '1700-shot.png.json'), { name: 'shot.png', type: 'image/png', size: 9, at: '2026-10-23T09:00:00Z' });
  const shot = { name: 'shot.png', url: 'uploads/1700-shot.png', path: site('orch', 'data', 'uploads', '1700-shot.png'), type: 'image/png', size: 9 };
  write(site('orch', 'data', 'uploads', '1701-more.pdf'), 'pdf bytes');
  const more = { name: 'more.pdf', url: 'uploads/1701-more.pdf', path: site('orch', 'data', 'uploads', '1701-more.pdf'), type: 'application/pdf', size: 9 };
  addEvents({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Fix the audit header', files: [shot] } },
    { id: 'e3', ts: '2026-10-23T11:05:00Z', kind: 'ask-edited', data: { id: 'e2', text: 'Fix the audit header spacing', files: [more] } });
  const r = board('ask', 'move', 'e2', '--to', 'audit', '--site', 'orch');
  assert.equal(r.code, 0, r.err);
  const [moved, ...others] = lines(site('audit', 'data', 'events.jsonl'));
  assert.equal(others.length, 0);
  const [file, edited] = moved.data.files;
  assert.deepEqual([edited.name, fs.readFileSync(site('audit', 'data', edited.url), 'utf8')], ['more.pdf', 'pdf bytes']);
  assert.deepEqual([moved.kind, moved.data.text, moved.data.from, file.name, file.type], ['ask', 'Fix the audit header spacing', { route: 'orch', title: 'Orch', id: 'e2' }, 'shot.png', 'image/png']);
  assert.match(file.url, /^uploads\/\d+-shot\.png$/);
  assert.equal(file.path, site('audit', 'data', file.url));
  assert.equal(fs.readFileSync(site('audit', 'data', file.url), 'utf8'), 'png bytes');
  assert.equal(read(site('audit', 'data', 'uploads', '.meta', `${file.url.slice(8)}.json`)).name, 'shot.png');
  const link = `/audit/#item=ask%3A${moved.id}`;
  assert.match(r.out, new RegExp(`moved to ${link.replace(/[/#%]/g, '\\$&')}`));
  const mark = read(site('orch', 'data', 'ask-progress.json')).asks.e2;
  assert.deepEqual([mark.state, mark.moved], ['done', { route: 'audit', title: 'Audit', id: moved.id }]);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'ask__e2.jsonl')).map(({ ts, ...m }) => m), [{ who: 'claude', text: 'Moved to Audit.', link }]);

  assert.match(board('ask', 'move', 'e2', '--to', 'audit', '--site', 'orch').err, /ask "e2" was already moved to \/audit/);
  assert.match(board('ask', 'progress', 'e2', '--site', 'orch').err, /ask "e2" was moved to \/audit/);
  assert.match(board('item', 'set', 'w/A1', '--from-ask', 'e2', '--state', 'ready', '--site', 'orch', '--text', 'On it.').err, /ask "e2" was moved to \/audit/);
  assert.equal(lines(site('audit', 'data', 'events.jsonl')).length, 1);
});

test('ask move refuses a route that is not another board, and an ask that is not New, changing nothing', () => {
  boardsManifest();
  addEvents({ id: 'e4', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Folded' } }, { id: 'e5', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Deleted' } },
    { id: 'e6', ts: '2026-10-23T11:01:00Z', kind: 'ask-withdrawn', data: { id: 'e5' } }, { id: 'e7', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Talked' } },
    { id: 'm1', ts: '2026-10-23T11:00:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'Not an ask' } });
  board('reply', 'e1', '--site', 'orch', '--html', '<p>Answered.</p>');
  board('item', 'relate-ask', 'e4', 'w/A1', '--summary', 'Folded in', '--site', 'orch');
  board('thread', 'ask:e7', '--site', 'orch', '--text', 'Answered in the thread.');
  const refusals = [
    [['e7', '--to', 'nope'], /--to nope: no board at \/nope in the hub's manifest; the boards are orch, audit/],
    [['e7', '--to', 'notes'], /no board at \/notes/],
    [['e7', '--to', 'orch'], /--to orch: that is this board/],
    [['e7'], /ask move needs --to <route>/],
    [['m1', '--to', 'audit'], /no ask "m1"/],
    [['e1', '--to', 'audit'], /ask "e1" is not New: Claude already answered it/],
    [['e7', '--to', 'audit'], /ask "e7" is not New/],
    [['e4', '--to', 'audit'], /ask "e4" is folded into w\/A1; run ask unfold e4 first/],
    [['e5', '--to', 'audit'], /ask "e5" was deleted by the owner/],
  ];
  for (const [args, err] of refusals) {
    const r = board('ask', 'move', ...args, '--site', 'orch');
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err);
    assert.equal(r.err.trim().split('\n').length, 1);
  }
  assert.equal(fs.existsSync(site('audit', 'data', 'events.jsonl')), false);
  assert.equal(fs.existsSync(site('orch', 'data', 'ask-progress.json')), false);
});

test('ask move drops the card an ask became when it has not started, and refuses one that has', () => {
  boardsManifest();
  // A card set to building gets a worktree from the board's repo.
  const manifest = read(at('kickflip', 'manifest.json'));
  manifest.sites.orch.owner = { repo: scratchRepo() };
  write(at('kickflip', 'manifest.json'), manifest);
  addEvents({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Filed first' } }, { id: 'e3', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Started' } });
  board('item', 'set', 'w/A1', '--from-ask', 'e2', '--state', 'grilling', '--site', 'orch', '--text', 'Filed.');
  board('item', 'add', 'w/A2', '--title', 'Two', '--site', 'orch');
  board('item', 'set', 'w/A2', '--from-ask', 'e3', '--state', 'grilling', '--status', 'building', '--site', 'orch', '--text', 'Building it.');
  assert.match(board('ask', 'move', 'e3', '--to', 'audit', '--site', 'orch').err, /ask "e3" became w\/A2, which has started/);
  const r = board('ask', 'move', 'e2', '--to', 'audit', '--site', 'orch');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /dropped: w\/A1/);
  assert.deepEqual(read(at('waves', 'w', 'wave.json')).items.filter((i) => i.id !== 'ENG-1').map((i) => [i.id, i.status]), [['A1', 'dropped'], ['A2', 'building']]);
  assert.deepEqual(lines(site('audit', 'data', 'events.jsonl')).map((e) => e.data.text), ['Filed first']);
  assert.equal(lines(site('orch', 'data', 'threads', 'ask__e2.jsonl'))[0].text, 'Moved to Audit.');
});

test('item set --from-ask on a card that came from another ask refuses and points to relate-ask; the same ask again stays fine', () => {
  addEvents({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'A second ask' } });
  assert.equal(board('item', 'set', 'w/A1', '--from-ask', 'e1', '--state', 'grilling', '--site', 'orch', '--text', 'On it.').code, 0);
  const r = board('item', 'set', 'w/A1', '--from-ask', 'e2', '--state', 'grilling', '--site', 'orch', '--text', 'Also this.');
  assert.equal(r.code, 1);
  assert.match(r.err, /w\/A1 came from ask "e1".*item relate-ask e2 w\/A1 --summary/);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].from_ask, 'e1');
  assert.equal(board('item', 'set', 'w/A1', '--from-ask', 'e1', '--state', 'grilling', '--site', 'orch', '--text', 'Again.').code, 0);
});

test('item set records when the status last changed, and only then', () => {
  board('item', 'set', 'w/A1', '--status', 'building', '--site', 'orch');
  const first = read(at('waves', 'w', 'wave.json')).items[0].status_at;
  assert.ok(Date.parse(first));
  board('item', 'set', 'w/A1', '--next', 'Later', '--site', 'orch');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status_at, first);
  board('item', 'set', 'w/A1', '--status', 'done', '--site', 'orch', '--text', 'Done.');
  assert.ok(read(at('waves', 'w', 'wave.json')).items[0].status_at > first);
});

test('ask progress and ask done mark a known ask, keeping --next only while in progress, and refuse an unknown ask', () => {
  assert.equal(board('ask', 'progress', 'e1', '--next', 'Pick a take', '--site', 'orch').code, 0);
  const marked = read(site('orch', 'data', 'ask-progress.json')).asks.e1;
  assert.deepEqual([marked.state, marked.next, Boolean(Date.parse(marked.at))], ['progress', 'Pick a take', true]);
  assert.equal(board('ask', 'done', 'e1', '--site', 'orch').code, 0);
  const done = read(site('orch', 'data', 'ask-progress.json')).asks.e1;
  assert.deepEqual([done.state, done.next], ['done', undefined]);
  assert.match(board('ask', 'progress', 'e9', '--site', 'orch').err, /no ask "e9"/);
  assert.match(board('ask', 'done', 'e1', '--next', 'x', '--site', 'orch').err, /does not take --next/);
});

// docs/adr/2026-11-04-0238-a-wave-builds-in-phases.md
test('lineup create links each phase\'s cards to every card of the phase before and writes the wave note; add, remove, set and finish keep the phases and set --phase rewrites them; a wave topic takes triage questions, as a wave file\'s does on a board over ~/.claude/waves', () => {
  const file = site('audit', 'data', 'wave.json');
  write(file, { title: 'W', items: [{ id: 'A1', title: 'One' }, { id: 'A2', title: 'Two', deps: ['A9'] }, { id: 'A3', title: 'Three' }, { id: 'A4', title: 'Four' }, { id: 'A5', title: 'Five' }, { id: 'A9', title: 'Elsewhere' }] });
  const b = (...args) => board('--site', 'audit', 'lineup', ...args);
  const deps = () => Object.fromEntries(read(file).items.map((it) => [it.id, it.deps || []]));
  const made = b('create', 'mon', '--title', 'Monitor', '--goal', 'The monitor runs in kickflip.', '--phase', 'audit/A1,audit/A2', '--phase', 'audit/A3', '--note', 'Why: one PR each.');
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /order: A1, A2 → A3/);
  assert.deepEqual(deps(), { A1: [], A2: ['A9'], A3: ['A1', 'A2'], A4: [], A5: [], A9: [] });
  assert.deepEqual(read(file).lineups.map(({ created, ...l }) => l), [{ slug: 'mon', title: 'Monitor', goal: 'The monitor runs in kickflip.', phases: [['A1', 'A2'], ['A3']] }]);
  assert.equal(fs.readFileSync(site('audit', 'data', 'lineup-mon.md'), 'utf8'), 'Why: one PR each.\n');

  assert.match(b('create', 'mon', '--title', 'Again', '--goal', 'G', '--phase', 'audit/A4', '--note', 'N').err, /already has a wave "mon"/);
  assert.match(b('create', 'audit', '--title', 'File', '--goal', 'G', '--phase', 'audit/A4', '--note', 'N').err, /is a wave file/);
  assert.match(b('create', 'two', '--title', 'Two', '--goal', 'G', '--phase', 'audit/A3,audit/A4', '--note', 'N').err, /already in the wave "mon"/);
  assert.match(b('create', 'two', '--title', 'Two', '--goal', 'G', '--phase', 'audit/A4').err, /needs the wave note/);
  assert.match(b('create', 'two', '--title', 'Two', '--goal', 'G', '--note', 'N').err, /--phase takes/);
  assert.match(b('create', 'two', '--title', 'Two', '--goal', 'G', '--phase', 'audit/A4', '--phase', 'audit/A4', '--note', 'N').err, /names a card twice/);

  assert.equal(b('add', 'mon', 'audit/A4', '--after', 'audit/A2').code, 0);
  assert.deepEqual(read(file).lineups[0].phases, [['A1', 'A2'], ['A4'], ['A3']]);
  assert.deepEqual(deps(), { A1: [], A2: ['A9'], A3: ['A4'], A4: ['A1', 'A2'], A5: [], A9: [] });
  assert.equal(b('remove', 'mon', 'audit/A4').code, 0);
  assert.deepEqual(read(file).lineups[0].phases, [['A1', 'A2'], ['A3']]);
  assert.deepEqual(deps(), { A1: [], A2: ['A9'], A3: ['A1', 'A2'], A4: [], A5: [], A9: [] });
  assert.equal(b('remove', 'mon', 'audit/A1').code, 0);
  assert.deepEqual(deps(), { A1: [], A2: ['A9'], A3: ['A2'], A4: [], A5: [], A9: [] });
  assert.equal(b('add', 'mon', 'audit/A4').code, 0);
  assert.equal(b('set', 'mon', '--title', 'Monitor in kickflip', '--note', 'Why: smaller.').code, 0);
  assert.deepEqual(read(file).lineups[0].phases, [['A2'], ['A3'], ['A4']]);
  assert.equal(read(file).lineups[0].title, 'Monitor in kickflip');
  assert.equal(fs.readFileSync(site('audit', 'data', 'lineup-mon.md'), 'utf8'), 'Why: smaller.\n');
  const phased = b('set', 'mon', '--phase', 'audit/A3', '--phase', 'audit/A2,audit/A4');
  assert.equal(phased.code, 0, phased.err);
  assert.match(phased.out, /order: A3 → A2, A4/);
  assert.deepEqual(read(file).lineups[0].phases, [['A3'], ['A2', 'A4']]);
  assert.deepEqual(deps(), { A1: [], A2: ['A9', 'A3'], A3: [], A4: ['A3'], A5: [], A9: [] });
  assert.match(b('set', 'mon', '--phase', 'audit/A3,audit/A2').err, /--phase lists each of the wave's cards once/);
  assert.match(b('set', 'mon', '--phase', 'audit/A3', '--phase', 'audit/A2,audit/A4,audit/A2').err, /--phase lists each of the wave's cards once/);
  assert.match(b('set', 'mon', '--phase', 'audit/A3', '--phase', ',').err, /--phase takes/);

  // A wave made before phases keeps its chain; its first change writes it as one card per phase.
  const legacy = read(file);
  legacy.lineups.push({ slug: 'old', title: 'Old', goal: 'G', items: ['A5', 'A1'], created: '2026-11-01T00:00:00Z' });
  write(file, legacy);
  assert.equal(b('set', 'old', '--goal', 'Still a chain.').code, 0);
  assert.deepEqual(read(file).lineups[1].phases, [['A5'], ['A1']]);
  assert.equal(read(file).lineups[1].items, undefined);
  assert.deepEqual(deps().A1, ['A5']);

  const q = path.join(home, 'q.json');
  write(q, question('t1', { topic: 'lineup:mon' }));
  assert.equal(board('--site', 'audit', 'question', 'add', '--file', q).code, 0);
  write(q, question('t2', { topic: 'lineup:nope' }));
  assert.match(board('--site', 'audit', 'question', 'add', '--file', q).err, /no wave "nope"/);
  write(q, question('t3', { topic: 'wave:audit' }));
  assert.match(board('--site', 'audit', 'question', 'add', '--file', q).err, /board over ~\/\.claude\/waves/);
  write(q, question('t4', { topic: 'wave:w' }));
  assert.equal(board('--site', 'orch', 'question', 'add', '--file', q).code, 0);
  write(q, question('t5', { topic: 'wave:nope' }));
  assert.match(board('--site', 'orch', 'question', 'add', '--file', q).err, /no wave "nope"/);

  assert.equal(b('finish', 'mon').code, 0);
  assert.ok(read(file).lineups[0].finished_at);
  assert.match(b('add', 'mon', 'audit/A2').err, /is finished/);
});

test('a write that takes a card out of Todo clears its hold and pick-up time', () => {
  const nine = new Date(Date.now() + 864e5).toISOString();
  write(at('waves', 'd', 'wave.json'), { items: ['A1', 'A2', 'A3', 'A4', 'A5'].map((id) => ({ id, title: id, held: true, pick_up_at: nine })) });
  const items = () => read(at('waves', 'd', 'wave.json')).items;
  assert.equal(board('item', 'set', 'd/A1', '--status', 'dropped', '--site', 'orch', '--text', 'Dropped.').code, 0);
  assert.equal(board('item', 'set', 'd/A2', '--status', 'checking', '--site', 'orch', '--next', 'Review').code, 0);
  assert.equal(board('item', 'set', 'd/A3', '--pr', '7', '--site', 'orch').code, 0);
  assert.equal(board('item', 'set', 'd/A4', '--status', 'done', '--site', 'orch', '--text', 'Done.').code, 0);
  assert.deepEqual(items().slice(0, 4).map((it) => [it.held, it.pick_up_at]), Array(4).fill([undefined, undefined]));
  assert.deepEqual([items()[4].held, items()[4].pick_up_at], [true, nine]);
});

test("a Next set while the card has an open question clears once its questions are all acted on, and any Next clears once a build starts", () => {
  const item = (id) => read(at('waves', 'w', 'wave.json')).items.find((it) => it.id === id);
  const ownerFile = site('orch', 'data', 'owner.json');
  const ok = (...args) => { const r = board(...args, '--site', 'orch'); assert.equal(r.code, 0, r.err); return r; };
  ok('item', 'set', 'w/ENG-1', '--next', 'Merge when CI is green');
  ok('builder', 'start', 'w/ENG-1', '--kind', 'claude');
  assert.deepEqual([item('ENG-1').next, item('ENG-1').next_on_questions], [undefined, undefined]);

  write(ownerFile, { topics: [], items: [question('pick', { topic: 'item:w/A1' })] });
  ok('builder', 'start', 'w/A1', '--kind', 'claude');
  ok('builder', 'done', 'w/A1', '--next', 'Owner picks a tagline on #1');
  assert.equal(item('A1').next_on_questions, true);
  addEvents({ id: 'answer-pick', ts: new Date().toISOString(), kind: 'owner-answer', data: { id: 'pick', choice: 'A' } });
  assert.equal(item('A1').next, 'Owner picks a tagline on #1');
  ok('question', 'resolve', 'pick', '--note', 'Took A');
  assert.deepEqual([item('A1').next, item('A1').next_on_questions], [undefined, undefined]);

  write(ownerFile, { ...read(ownerFile), items: [...read(ownerFile).items, question('tone', { topic: 'item:w/A1' })] });
  ok('item', 'set', 'w/A1', '--next', 'Owner picks a tone');
  ok('builder', 'start', 'w/A1', '--agent', 'grill', '--kind', 'grill');
  assert.equal(item('A1').next, 'Owner picks a tone');
  ok('builder', 'start', 'w/A1', '--kind', 'claude');
  assert.deepEqual([item('A1').next, item('A1').next_on_questions], [undefined, undefined]);
});

test('item set --status done refuses a done card the owner reopened with a message; it closes on their Done', () => {
  write(at('waves', 'w', 'wave.json'), { title: 'W', items: [{ id: 'A1', title: 'One', status: 'done', status_at: '2026-10-23T10:00:00Z' }] });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'done', '--text', 'Still done.').code, 0);
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'm1', ts: new Date(Date.now() + 1000).toISOString(), kind: 'item-message', data: { key: 'w/A1', text: 'One more thing' } }) + '\n');
  const closed = read(at('waves', 'w', 'wave.json')).items[0].status_at;
  const r = board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'done', '--text', 'Answered.');
  assert.deepEqual([r.code, r.err], [1, "the owner reopened A1 with a message; it closes on the owner's Done\n"]);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status_at, closed);
});

// docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md
test('item set blocks a card until a condition with a reason, refuses its start while it holds, and clearing it threads and emits card-unblocked once', () => {
  write(at('waves', 'd', 'wave.json'), { items: [
    { id: 'A1', title: 'One', status: 'building' },
    { id: 'A2', title: 'Two', state: 'ready' },
    { id: 'A3', title: 'Three', deps: ['A1'] },
  ] });
  const item = (id) => read(at('waves', 'd', 'wave.json')).items.find((i) => i.id === id);
  const events = () => (fs.existsSync(site('orch', 'data', 'events.jsonl')) ? lines(site('orch', 'data', 'events.jsonl')) : []).filter((e) => e.kind === 'card-unblocked');
  const thread = (id) => (fs.existsSync(site('orch', 'data', 'threads', `d__${id}.jsonl`)) ? lines(site('orch', 'data', 'threads', `d__${id}.jsonl`)) : []).map((m) => m.text);

  const lonely = board('item', 'set', 'd/A2', '--site', 'orch', '--block-reason', 'why');
  assert.equal(lonely.code, 1);
  assert.match(lonely.err, /--block-reason goes with a block: --deps or --blocked-until/);
  assert.equal(board('item', 'set', 'd/A2', '--site', 'orch', '--blocked-until', 'the CI run on main is green', '--block-reason', 'the suite is red on main').code, 0);
  assert.deepEqual([item('A2').blocked_until, item('A2').block_reason], ['the CI run on main is green', 'the suite is red on main']);
  const start = board('item', 'set', 'd/A2', '--site', 'orch', '--status', 'building');
  assert.equal(start.code, 1);
  assert.match(start.err, /d\/A2 is blocked until the CI run on main is green; start it once that holds and the block is cleared with --blocked-until ""/);

  // A dep finishing leaves a card its condition still blocks blocked: no unblocking.
  assert.equal(board('item', 'set', 'd/A3', '--site', 'orch', '--blocked-until', 'the API is deployed').code, 0);
  assert.doesNotMatch(board('item', 'set', 'd/A1', '--site', 'orch', '--status', 'done', '--text', 'Done.').out, /unblocked/);
  assert.deepEqual(events(), []);

  const cleared = board('item', 'set', 'd/A2', '--site', 'orch', '--blocked-until', '');
  assert.equal(cleared.code, 0);
  assert.match(cleared.out, /^unblocked: d\/A2$/m);
  assert.deepEqual([item('A2').blocked_until, item('A2').block_reason], [undefined, undefined], 'the reason goes with the block');
  assert.deepEqual(thread('A2'), ['Unblocked: the CI run on main is green.']);
  assert.deepEqual(events().map((e) => e.data), [{ key: 'd/A2' }]);
  assert.equal(board('item', 'set', 'd/A2', '--site', 'orch', '--blocked-until', '').code, 0);
  assert.equal(events().length, 1, 'clearing nothing emits nothing');

  // A reason rides a dep block too, and goes when the deps are cleared.
  assert.equal(board('item', 'set', 'd/A2', '--site', 'orch', '--deps', 'A3', '--block-reason', 'shares the send bar').code, 0);
  assert.deepEqual([item('A2').deps, item('A2').block_reason], [['A3'], 'shares the send bar']);
  assert.equal(board('item', 'set', 'd/A2', '--site', 'orch', '--deps', '').code, 0);
  assert.equal(item('A2').block_reason, undefined);
  assert.equal(events().length, 1, 'clearing deps by hand is no unblocking event, as before');
});
