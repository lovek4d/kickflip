import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { home, at, site, write, read, run, board, question, takePath, recordPrototype, addPrototypeQuestion, addConfirm, prototypeRefusal, record, addEvents } from './board-fixture.mjs';

test('question add appends valid questions and rejects the whole file otherwise', () => {
  const drawn = (more = {}) => ({ id: 'A', label: 'Keep', diagram: [[{ text: 'Hub' }, { text: 'Board', tone: 'info', to: [0] }], [{ text: 'Owner', tone: 'success' }]], practice: ['One place to change.'], ...more });
  recordPrototype();
  write(path.join(home, 'q.json'), [question('q1', { url: 'prototype-site.html?q=q1' }), question('q2', { topic: 'item:w/A1', urgent: true, url: 'https://linear.app/x/issue/INT-1', options: [drawn(), { id: 'B', label: 'Drop' }] }), question('q4', { topic: 'item:ask:e1', suggested: { option: 'B', card: '#186', answer: 'Drop it.' } })]);
  assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')).code, 0);
  assert.deepEqual(read(site('orch', 'data', 'owner.json')).items.map((q) => [q.id, q.url]), [['q1', 'prototype-site.html?q=q1'], ['q2', 'https://linear.app/x/issue/INT-1'], ['q4', undefined]]);
  assert.deepEqual(read(site('orch', 'data', 'owner.json')).items[1].options[0], drawn());
  assert.deepEqual(read(site('orch', 'data', 'owner.json')).items[2].suggested, { option: 'B', card: '#186', answer: 'Drop it.' });

  const rejected = [
    [question('q1')],
    [question('q3', { topic: 'nowhere' })],
    [question('q3', { topic: 'item:w/Z9' })],
    [question('q3', { topic: 'item:ask:e9' })],
    [question('q3', { options: [] })],
    [question('q3', { options: [{ id: 'A', label: 'Keep', recommend: true }] })],
    [question('q3', { options: [{ id: 'A', label: 'X', recommended: true }, { id: 'B', label: 'Y', recommended: true }] })],
    [question('q3'), question('q3')],
    [question('q3', { suggested: { option: 'C', card: '#186', answer: 'Keep.' } })],
    [question('q3', { suggested: { option: 'A', answer: 'Keep.' } })],
    [question('q3', { suggested: { option: 'A', card: '#186' } })],
    [question('q3', { suggested: { option: 'A', card: '#186', answer: 'Keep.', why: 'x' } })],
    [question('q3', { suggested: { option: 'A', card: '#186', answer: 'Keep.', reason: '' } })],
    [question('q3', { url: '/orch/prototype-site.html' })],
    [question('q3', { url: 'notes.html' })],
    [question('q3', { options: [drawn({ practice: undefined })] })],
    [question('q3', { options: [drawn({ diagram: undefined })] })],
    [question('q3', { options: [drawn({ diagram: [] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }, { text: 'E' }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: ' ' }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A', tone: 'red' }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A', to: [1] }], [{ text: 'B' }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A', to: [0] }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A', shape: 'round' }]] })] })],
    [question('q3', { options: [drawn({ practice: [] })] })],
  ];
  for (const file of rejected) {
    write(path.join(home, 'bad.json'), file);
    assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'bad.json')).code, 1, JSON.stringify(file));
  }
  assert.deepEqual(read(site('orch', 'data', 'owner.json')).items.map((q) => q.id), ['q1', 'q2', 'q4']);

  const onCard = (id) => {
    write(path.join(home, 'card.json'), question(id, { topic: 'item:w/A1' }));
    return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'card.json'));
  };
  const merged = read(at('waves', 'w', 'wave.json'));
  Object.assign(merged.items[0], { lane: 'done', lane_at: '2026-10-23T10:00:00Z', closed_at: '2026-10-23T10:00:00Z', prs: [{ number: 5, merged_at: '2026-10-23T10:00:00Z' }] });
  write(at('waves', 'w', 'wave.json'), merged);
  assert.equal(onCard('q-merged').code, 0);
  assert.equal(board('item', 'set', 'w/ENG-1', '--site', 'orch', '--done', '--force', '--text', 'Done.').code, 0);
  write(path.join(home, 'card.json'), question('q-done', { topic: 'item:w/ENG-1' }));
  assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'card.json')).code, 0);
  const added = read(site('orch', 'data', 'owner.json')).items;
  assert.deepEqual(added.map((q) => q.id), ['q1', 'q2', 'q4', 'q-merged', 'q-done']);
  assert.ok(added.every((q) => !Number.isNaN(Date.parse(q.asked_at))));
});

test('prototype add records a topic and prints the take files to write; list shows it and rm drops it, keeping the files', () => {
  const r = board('prototype', 'add', 'hub-moon', '--site', 'orch', '--title', 'Hub moon', '--card', 'w/A1', '--take', 'A:Moon with hover text', '--take', 'B:Moon with tap bubble');
  assert.deepEqual(r, { code: 0, err: '', out: ['prototype hub-moon recorded for A1', 'page prototype-hub-moon.html', `take A ${takePath('hub-moon', 'A')}`, `take B ${takePath('hub-moon', 'B')}`, ''].join('\n') });
  const [record] = read(site('orch', 'data', 'prototypes.json')).prototypes;
  assert.deepEqual({ ...record, at: undefined }, { topic: 'hub-moon', title: 'Hub moon', card: 'w/A1', takes: [{ key: 'A', label: 'Moon with hover text' }, { key: 'B', label: 'Moon with tap bubble' }], at: undefined });
  assert.equal(board('prototype', 'list', '--site', 'orch').out, 'hub-moon · Hub moon · A: Moon with hover text, B: Moon with tap bubble · w/A1\n');
  write(takePath('hub-moon', 'A'), 'export function render() {}');
  assert.equal(board('prototype', 'rm', 'hub-moon', '--site', 'orch').code, 0);
  assert.equal(board('prototype', 'list', '--site', 'orch').out, 'no prototypes recorded\n');
  assert.ok(fs.existsSync(takePath('hub-moon', 'A')));
});

test('prototype add refuses a bad topic, key or label, no takes, a repeated key, an unknown card, a recorded topic and a hand-written page', () => {
  recordPrototype('taken');
  write(site('orch', 'public', 'prototype-old.html'), '<p>Hand-written</p>');
  const before = read(site('orch', 'data', 'prototypes.json'));
  const refusals = [
    [['Bad_Topic', '--take', 'A:Keep'], 'a prototype topic uses only a-z, 0-9 and "-", not "Bad_Topic"'],
    [['t', '--take', 'a:Keep'], '--take takes KEY:"Label" with KEY one capital letter, not "a:Keep"'],
    [['t', '--take', 'AB:Keep'], '--take takes KEY:"Label" with KEY one capital letter, not "AB:Keep"'],
    [['t', '--take', 'A:A. Keep'], '--take A\'s label starts with "A. "; the take pill shows the label alone, so drop the letter'],
    [['t', '--take', 'A: '], '--take A\'s label must be non-empty text'],
    [['t'], 'prototype add needs a --take KEY:"Label" for each take'],
    [['t', '--take', 'A:Keep', '--take', 'A:Drop'], '--take A is given twice'],
    [['t', '--take', 'A:Keep', '--card', 'w/Z9'], 'item file "w" has no item "Z9"'],
    [['taken', '--take', 'A:Keep'], 'prototype taken is already recorded; run prototype rm taken first, or pick another topic'],
    [['old', '--take', 'A:Keep'], 'public/prototype-old.html is a hand-written page that questions may link; pick another topic'],
  ];
  for (const [args, line] of refusals) {
    assert.deepEqual(board('prototype', 'add', ...args, '--site', 'orch', '--title', 'T'), { code: 1, out: '', err: line + '\n' }, line);
  }
  assert.deepEqual(read(site('orch', 'data', 'prototypes.json')), before);
});

test('prototype rm refuses while an open question links the prototype', () => {
  recordPrototype();
  assert.equal(addPrototypeQuestion().code, 0);
  assert.deepEqual(board('prototype', 'rm', 'site', '--site', 'orch'), { code: 1, out: '', err: 'prototype site backs open question q1; resolve it first\n' });
  addConfirm('q1', true);
  for (const id of ['q1', 'q1-confirm']) assert.equal(board('question', 'resolve', id, '--site', 'orch', '--note', 'Picked A.').code, 0);
  assert.equal(board('prototype', 'rm', 'site', '--site', 'orch').code, 0);
});

test("question resolve refuses a prototype question until a pick settles its round, a pick with a note included, and leaves one a note resolved as it is", () => {
  recordPrototype();
  assert.equal(addPrototypeQuestion().code, 0);
  const file = site('orch', 'data', 'owner.json');
  const fresh = read(file);
  const resolve = (id, ...more) => board('question', 'resolve', id, '--site', 'orch', '--note', 'Picked A.', ...more);
  assert.deepEqual(resolve('q1'), { code: 1, out: '', err: 'q1 is in prototype round 1, which no pick has settled yet; a pick settles it\n' });
  assert.equal(resolve('q1', '--no-change').code, 2);
  addEvents({ id: 'answer-q1-noted', ts: '2026-10-23T10:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A', note: 'Bigger' } });
  assert.equal(resolve('q1').code, 0);
  assert.equal(read(file).items[0].resolved, 'Picked A.');
  addEvents({ id: 'answer-q1-note', ts: '2026-10-23T10:40:00Z', kind: 'owner-answer', data: { id: 'q1', choice: null, note: 'Make it blue' } });
  const noted = { ...fresh, items: [{ ...fresh.items[0], resolved: 'Answered with a note', resolved_at: '2026-10-23T10:40:01Z' }] };
  write(file, noted);
  assert.equal(resolve('q1').code, 0);
  assert.deepEqual(read(file), noted);
});

// docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md
test('question resolve refuses a question the owner asked a prototype of; the round naming it in round_of resolves it', () => {
  recordPrototype();
  const add = (q) => { write(path.join(home, 'q.json'), q); return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')); };
  assert.equal(add(question('asked', { topic: 'item:w/A1' })).code, 0);
  addEvents({ id: 'r-asked', ts: '2026-10-23T10:00:00Z', kind: 'prototype-request', data: { key: 'w/A1', question: 'asked', note: '' } });
  assert.deepEqual(board('question', 'resolve', 'asked', '--site', 'orch', '--note', 'Answered in the thread.'),
    { code: 1, out: '', err: 'asked waits on the prototype the owner asked for; question add with round_of asked resolves it\n' });
  assert.equal(add(question('r1', { topic: 'item:w/A1', url: 'prototype-site.html?q=r1', round_of: 'asked' })).code, 0);
  assert.equal(read(site('orch', 'data', 'owner.json')).items[0].resolved, 'Followed by prototype round 1');
});

test('question add with round_of starts the next prototype round on the question it answers, resolving that one as followed by the round', () => {
  recordPrototype();
  recordPrototype('next');
  const add = (q) => { write(path.join(home, 'q.json'), q); return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')); };
  const on = (id, extra = {}) => question(id, { topic: 'item:w/A1', ...extra });
  assert.equal(add(on('plain')).code, 0);
  const file = site('orch', 'data', 'owner.json');
  for (const [q, err] of [
    [on('r1', { url: 'prototype-site.html?q=r1', round_of: 'nope' }), 'question r1.round_of names no question "nope" in owner.json'],
    [on('r1', { url: 'prototype-site.html?q=r1', round_of: 'plain', topic: 'site' }), 'question r1.round_of names plain on topic item:w/A1; a round stays on its question\'s topic, site'],
    [on('r1', { round_of: 'plain' }), 'question r1.round_of needs a url on a recorded prototype, prototype-<topic>.html?q=r1'],
  ]) assert.deepEqual(add(q), { code: 1, out: '', err: err + '\n' });
  assert.deepEqual(read(file).items.map((q) => q.id), ['plain']);

  const first = add(on('r1', { url: 'prototype-site.html?q=r1', round_of: 'plain' }));
  assert.deepEqual(first.out.split('\n').slice(1), ['resolved: plain', '']);
  addConfirm('r1', false);
  const second = add(on('r2', { url: 'prototype-next.html?q=r2', round_of: 'r1-confirm' }));
  assert.deepEqual(second.out.split('\n').slice(1), ['resolved: r1-confirm', '']);
  const items = read(file).items;
  assert.deepEqual(items.map((q) => [q.id, q.round ?? null, q.resolved ?? null]), [
    ['plain', null, 'Followed by prototype round 1'], ['r1', 1, null], ['r1-confirm', 1, 'Followed by prototype round 2'], ['r2', 2, null]]);
});

test('question add with reask_of asks a resolved question again on its topic, resolving the old one again as asked again', () => {
  const add = (q) => { write(path.join(home, 'q.json'), q); return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')); };
  const on = (id, extra = {}) => question(id, { topic: 'item:w/A1', ...extra });
  assert.equal(add([on('old'), on('live')]).code, 0);
  const file = site('orch', 'data', 'owner.json');
  for (const [q, err] of [
    [on('new', { reask_of: 'nope' }), 'question new.reask_of names no question "nope" in owner.json'],
    [on('new', { reask_of: 'old', topic: 'site' }), 'question new.reask_of names old on topic item:w/A1; a re-ask stays on its question\'s topic, site'],
    [on('new', { reask_of: 'live' }), 'question new.reask_of names live, which is not resolved; only a resolved question is asked again'],
  ]) assert.deepEqual(add(q), { code: 1, out: '', err: err + '\n' });
  write(file, { ...read(file), items: read(file).items.map((q) => (q.id === 'old' ? { ...q, resolved: 'Picked A', resolved_at: '2026-10-23T10:00:00Z' } : q)) });
  const out = add(on('new', { reask_of: 'old' }));
  assert.equal(out.code, 0, out.err);
  assert.deepEqual(out.out.split('\n').slice(1), ['resolved: old', '']);
  const items = read(file).items;
  assert.deepEqual(items.map((q) => [q.id, q.resolved ?? null, q.reask_of ?? null]), [['old', 'Asked again as new', null], ['live', null, null], ['new', null, 'old']]);
  assert.ok(items[0].resolved_at > '2026-10-23T10:00:00Z');
});

test('question add follows a pick with a note as it follows any answered question on the card', () => {
  recordPrototype();
  const file = site('orch', 'data', 'owner.json');
  const add = (id) => addPrototypeQuestion(`prototype-site.html?q=${id}`, { id, topic: 'item:w/A1' });
  assert.equal(add('q1').code, 0);
  addEvents({ id: 'answer-q1', ts: '2026-10-23T10:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A', note: 'Bigger' } });
  const second = add('q2');
  assert.equal(second.code, 0, second.err);
  assert.deepEqual(second.out.trim().split('\n').slice(1), ['resolved: q1']);
  assert.deepEqual(read(file).items.map((q) => q.resolved ?? null), ['Followed by q2', null]);
});

test('question add refuses a prototype url naming a hand-written or unrecorded page, relative or absolute, or missing its ?q=, and takes an absolute url to a recorded one', () => {
  const unrecorded = 'question q1.url names prototype-site.html, which is not a recorded prototype; record it with board.mjs prototype add site --title "…" --take A:"…", then write its take files';
  const page = site('orch', 'public', 'prototype-site.html');
  write(page, '<script src="prototype-switcher.js"></script><script>PrototypeSwitcher.mount({takes: {A: "Keep", B: "Drop"}, render(take) {}});</script>');
  prototypeRefusal(addPrototypeQuestion(), unrecorded);
  fs.rmSync(page);
  prototypeRefusal(addPrototypeQuestion('https://example.com/orch/prototype-site.html?q=q1'), unrecorded);
  recordPrototype();
  for (const url of ['prototype-site.html#q=q1', 'prototype-site.html?q=other#q=q1']) {
    prototypeRefusal(addPrototypeQuestion(url), 'question q1.url must be prototype-site.html?q=q1 so the pill can pick');
  }
  const result = addPrototypeQuestion('https://example.com/orch/prototype-site.html?q=q1');
  assert.equal(result.code, 0, result.err);
});

test('question add refuses options that are not the recorded takes in order, and a take with no file yet', () => {
  recordPrototype('site', ['A:Keep', 'B:Drop'], false);
  const swapped = [{ id: 'B', label: 'Drop' }, { id: 'A', label: 'Keep', recommended: true }];
  prototypeRefusal(addPrototypeQuestion(undefined, { options: swapped }), 'question q1.options ids B, A must be a non-empty subset of prototype-site.html\'s takes, in take order: A, B');
  prototypeRefusal(addPrototypeQuestion(undefined, { options: [{ id: 'C', label: 'Other' }] }), 'question q1.options ids C must be a non-empty subset of prototype-site.html\'s takes, in take order: A, B');
  prototypeRefusal(addPrototypeQuestion(undefined, { options: [{ id: 'A', label: 'Keep' }, { id: 'A', label: 'Again' }] }), 'question q1 has two options with id "A"');
  prototypeRefusal(addPrototypeQuestion(undefined, { options: [] }), 'question q1.options must be a non-empty array');
  write(takePath('site', 'A'), 'export function render() {}');
  prototypeRefusal(addPrototypeQuestion(undefined, { options: [{ id: 'A', label: 'Keep' }] }), `question q1.url take B has no file yet; write ${takePath('site', 'B')}`);
  write(takePath('site', 'B'), 'export function render() {}');
  const url = 'prototype-site.html?variant=B&q=q1#top';
  const result = addPrototypeQuestion(url);
  assert.equal(result.code, 0, result.err);
  assert.equal(read(site('orch', 'data', 'owner.json')).items[0].url, url);
});

test('a prototype question accepts a non-empty subset of takes in their recorded order', () => {
  recordPrototype('site', ['A:Keep', 'B:Drop', 'C:Change', 'D:Wait']);
  for (const [n, ids] of [['one', ['A']], ['last', ['D']], ['some', ['B', 'D']]]) {
    write(path.join(home, 'q.json'), question(n, { url: `prototype-site.html?q=${n}`, options: ids.map((id) => ({ id, label: `Take ${id}` })) }));
    const r = board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json'));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(read(site('orch', 'data', 'owner.json')).items.at(-1).options.map((o) => o.id), ids);
  }
});

test('a question re-asked on the same topic with the same prototype resolves the unresolved one it replaces', () => {
  recordPrototype();
  recordPrototype('other');
  const add = (q) => { write(path.join(home, 'q.json'), q); return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')); };
  const on = (id, topic, page) => question(id, { topic, url: `prototype-${page}.html?q=${id}` });
  write(site('orch', 'data', 'owner.json'), { topics: [{ id: 'site', title: 'Site' }], items: [{ ...on('done', 'item:w/A1', 'site'), resolved: 'Picked A.', resolved_at: '2026-10-23T00:00:00Z' }] });
  for (const q of [on('moon', 'item:w/A1', 'site'), on('elsewhere', 'site', 'site'), on('different', 'item:w/A1', 'other')]) assert.deepEqual(add(q).out.split('\n').slice(1), ['']);
  const r = add(on('moon-2', 'item:w/A1', 'site'));
  assert.deepEqual(r, { code: 0, err: '', out: 'question moon-2 added on A1\nreplaced: moon\n' });
  const owner = read(site('orch', 'data', 'owner.json')).items;
  assert.deepEqual(owner.map((q) => [q.id, q.resolved ?? null]), [['done', 'Picked A.'], ['moon', 'Replaced by moon-2'], ['elsewhere', null], ['different', null], ['moon-2', null]]);
  assert.ok(!Number.isNaN(Date.parse(owner[1].resolved_at)));
});

test('question add leaves non-prototype urls unchanged', () => {
  const url = 'https://example.com/design.html?next=prototype-site.html#q=other';
  const result = addPrototypeQuestion(url);
  assert.equal(result.code, 0, result.err);
  assert.equal(read(site('orch', 'data', 'owner.json')).items[0].url, url);
});

test('question add saves none of a batch when a prototype question is invalid', () => {
  write(path.join(home, 'q.json'), [question('first'), question('q1', { url: 'prototype-site.html' })]);
  prototypeRefusal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')), 'question q1.url must be prototype-site.html?q=q1 so the pill can pick');
});

test('question add on a card follows answered questions with the first new question, preserving other states and topics', () => {
  recordPrototype();
  const on = (id, extra = {}) => question(id, { topic: 'item:w/A1', ...extra });
  const prototype = (id, extra = {}) => on(id, { url: `prototype-site.html?q=${id}`, ...extra });
  const file = site('orch', 'data', 'owner.json');
  write(file, { topics: [{ id: 'site', title: 'Site' }], items: [
    on('answered'), prototype('answered-prototype'), prototype('open-prototype'), on('open'),
    prototype('replied'), prototype('resolved', { resolved: 'Already settled', resolved_at: '2026-10-24T00:00:00Z' }),
    on('other-card', { topic: 'item:w/ENG-1' }), prototype('declared', { topic: 'site' }),
    on('ask', { topic: 'item:ask:e1' }),
    on('reopened', { resolved: 'Earlier answer', resolved_at: '2026-10-22T00:00:00Z' }),
  ] });
  addEvents(...['answered', 'answered-prototype', 'replied', 'resolved', 'other-card', 'declared', 'ask', 'reopened'].map((id) =>
    ({ id: `answer-${id}`, ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id, choice: 'A' } })));
  assert.equal(board('reply', 'answer-replied', '--site', 'orch', '--html', '<p>Acted on it.</p>').code, 0);
  const before = fs.readFileSync(file, 'utf8');
  const add = (qs) => run('board.mjs', ['question', 'add', '--site', 'orch', '--file', '-'], JSON.stringify(qs));
  const refused = add([prototype('first'), question('invalid', { options: [] })]);
  assert.equal(refused.code, 1);
  assert.equal(refused.out, '');
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  const r = add([prototype('first'), on('second')]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trim().split('\n').slice(1), [
    'replaced: open-prototype', 'replaced: replied', 'resolved: answered', 'resolved: answered-prototype', 'resolved: reopened',
  ]);
  const items = read(file).items;
  for (const id of ['answered', 'answered-prototype', 'reopened']) {
    const q = items.find((q) => q.id === id);
    assert.equal(q.resolved, 'Followed by first');
    assert.ok(Date.parse(q.resolved_at) <= Date.now());
  }
  for (const id of ['open-prototype', 'replied']) assert.equal(items.find((q) => q.id === id).resolved, 'Replaced by first');
  const original = JSON.parse(before).items;
  for (const id of ['open', 'resolved', 'other-card', 'declared', 'ask']) {
    assert.deepEqual(items.find((q) => q.id === id), original.find((q) => q.id === id));
  }
  const declared = add(on('declared-next', { topic: 'site' }));
  assert.equal(declared.code, 0, declared.err);
  assert.deepEqual(declared.out.trim().split('\n').slice(1), []);
  assert.deepEqual(read(file).items.find((q) => q.id === 'declared'), original.find((q) => q.id === 'declared'));
  const ask = add(on('ask-next', { topic: 'item:ask:e1' }));
  assert.equal(ask.code, 0, ask.err);
  assert.deepEqual(ask.out.trim().split('\n').slice(1), ['resolved: ask']);
  assert.equal(read(file).items.find((q) => q.id === 'ask').resolved, 'Followed by ask-next');
});

test('a new topic takes questions, and resolving one records when', () => {
  assert.equal(board('topic', 'add', 'plan', '--site', 'orch', '--title', 'Plan', '--summary', 'The next wave.').code, 0);
  write(path.join(home, 'q.json'), question('q1', { topic: 'plan' }));
  assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')).code, 0);
  assert.equal(board('question', 'resolve', 'q1', '--site', 'orch', '--note', 'Kept it.').code, 0);
  const owner = read(site('orch', 'data', 'owner.json'));
  assert.deepEqual(owner.topics.at(-1), { id: 'plan', title: 'Plan', summary: 'The next wave.' });
  assert.equal(owner.items[0].resolved, 'Kept it.');
  assert.ok(Date.parse(owner.items[0].resolved_at) <= Date.now());
  assert.equal(board('question', 'resolve', 'q9', '--site', 'orch', '--note', 'x').code, 1);
});

test('resolving a question leaves a missing or empty push queue alone', () => {
  const queue = at('kickflip', 'push', 'queue.json');
  write(site('orch', 'data', 'owner.json'), { items: [question('q1')] });
  assert.equal(board('question', 'resolve', 'q1', '--site', 'orch', '--note', 'Settled').code, 0);
  assert.equal(fs.existsSync(queue), false);
  const empty = '{"items":[]}\n';
  write(queue, empty);
  assert.equal(board('question', 'resolve', 'q1', '--site', 'orch', '--note', 'Still settled').code, 0);
  assert.equal(fs.readFileSync(queue, 'utf8'), empty);
});

test('question move puts a merged question on one card, resolves the duplicates there, and blocks and relates the other cards in order', () => {
  const ok = (...args) => assert.equal(board(...args, '--site', 'orch').code, 0);
  const move = (...args) => board('question', 'move', ...args, '--site', 'orch');
  ok('item', 'add', 'w/B2', '--phase', 'grilling', '--title', 'Two');
  ok('item', 'add', 'w/C3', '--phase', 'grilling', '--title', 'Three');
  const file = site('orch', 'data', 'owner.json');
  write(file, { topics: [], items: ['A1', 'B2', 'C3'].map((c, i) => question(`q${i + 1}`, { topic: `item:w/${c}` })) });
  assert.equal(move('q9', '--to', 'w/A1').err, 'no question "q9" in owner.json\n');
  assert.equal(move('q1', '--to', 'w/Z9').code, 1);
  assert.equal(move('q1', '--to', 'w/A1', '--block', 'w/A1').err, 'question move names a card twice\n');
  addEvents({ id: 'answer-q3', ts: '2026-10-23T10:00:00Z', kind: 'owner-answer', data: { id: 'q3', choice: 'A' } });
  assert.equal(move('q2,q3', '--to', 'w/A1').err, 'q3 is answered; question move takes open questions\n');
  assert.deepEqual(read(file).items.map((q) => q.topic), ['item:w/A1', 'item:w/B2', 'item:w/C3']);

  const moved = move('q2,q1', '--to', 'w/A1', '--block', 'w/B2,w/C3');
  assert.equal(moved.code, 0, moved.err);
  const [q1, q2] = read(file).items;
  assert.equal(q2.topic, 'item:w/A1');
  assert.equal(q1.resolved, "Duplicate of A1's question q2");
  const items = read(at('waves', 'w', 'wave.json')).items;
  const card = (id) => items.find((it) => it.id === id);
  assert.deepEqual([card('B2').deps, card('C3').deps], [['w/A1'], ['w/B2']]);
  assert.deepEqual([card('B2').related, card('C3').related], [['w/A1'], ['w/A1']]);
});

// docs/adr/2026-11-06-0100-a-grills-questions-appear-together-once-the-grill-is-done.md
test("question add on a card with a planner running stages its questions; the planner's done publishes them together", () => {
  const owner = site('orch', 'data', 'owner.json');
  const add = (...ids) => { write(path.join(home, 'q.json'), ids.map((id) => question(id, { topic: 'item:w/A1' }))); return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')); };
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'grill').code, 0);
  const staged = add('q1', 'q2');
  assert.equal(staged.code, 0, staged.err);
  assert.match(staged.out, /staged/);
  assert.match(staged.out, /grill/);
  assert.deepEqual(read(owner).items, []);
  assert.equal(add('q1').code, 1);
  assert.equal(add('q3').code, 0);
  assert.equal(board('--site', 'orch', 'builder', 'done', 'w/A1', '--next', 'x').code, 0);
  // docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md: a grill's wait on the orchestrator first.
  assert.deepEqual(read(owner).items, []);
  assert.equal(board('question', 'publish', 'w/A1', '--site', 'orch').code, 0);
  assert.deepEqual(read(owner).items.map((q) => q.id), ['q1', 'q2', 'q3']);
  assert.equal(new Set(read(owner).items.map((q) => q.asked_at)).size, 1);
  assert.match(add('q4').out, /added/);
  assert.deepEqual(read(owner).items.map((q) => q.id), ['q1', 'q2', 'q3', 'q4']);
});

test("a planner that is stopped or abandoned publishes the questions staged on its card", () => {
  const owner = site('orch', 'data', 'owner.json');
  write(path.join(home, 'q.json'), question('q1', { topic: 'item:w/A1' }));
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'prototype').code, 0);
  assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')).code, 0);
  assert.deepEqual(read(owner).items, []);
  // Closing the card abandons its planner.
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--done', '--text', 'Dropped: no longer wanted.').code, 0);
  assert.deepEqual(read(owner).items.map((q) => q.id), ['q1']);
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1.json')).done, 'string');
});
