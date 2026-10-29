import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
for (const file of ['ui.js', 'ui-links.js', 'ui-questions.js', 'prototype-switcher.js']) {
  vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
}
const sw = context.PrototypeSwitcher;
const ui = context.BoardUI;
const plain = (v) => JSON.parse(JSON.stringify(v));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const question = {
  id: 'q1', question: 'Which snooze?', state: 'open', answers: [],
  options: [{ id: 'A', label: 'Named chips', recommended: true }, { id: 'B', label: 'One stepper' }],
};
const answered = (...choices) => ({ ...question, state: 'answered', answers: choices.map((choice) => ({ ts: '2026-10-23T10:00:00Z', choice, note: '', reply: null })) });

test('takes cycle in order and wrap at both ends', () => {
  const keys = ['now', 'A', 'B', 'C'];
  assert.equal(sw.takeAt(keys, 'A', 1), 'B');
  assert.equal(sw.takeAt(keys, 'C', 1), 'now');
  assert.equal(sw.takeAt(keys, 'now', -1), 'C');
  assert.equal(sw.takeAt(keys, 'gone', 1), 'A');
});

test('the page opens on the take in ?variant=, else its initial take, else the first', () => {
  assert.equal(sw.startTake(['now', 'A', 'B'], 'B', 'A'), 'B');
  assert.equal(sw.startTake(['now', 'A', 'B'], 'Z', 'A'), 'A');
  assert.equal(sw.startTake(['now', 'A', 'B'], null, undefined), 'now');
});

test('a take is pickable only when it is one of the question options', () => {
  assert.equal(sw.pickState(null, 'A').kind, 'none');
  assert.equal(sw.pickState(question, 'now').kind, 'none');
  assert.deepEqual(plain(sw.pickState(question, 'A')), { kind: 'pick', option: question.options[0] });
});

test('once answered, the picked take reads Picked and every other take offers Change pick', () => {
  assert.equal(sw.pickState(answered('B'), 'B').kind, 'picked');
  assert.equal(sw.pickState(answered('B'), 'A').kind, 'change');
  assert.equal(sw.pickState(answered('A', 'B'), 'B').kind, 'picked');
  assert.equal(sw.pickState(answered('B', null), 'B').kind, 'picked');
});

test("the pill shows the take's name and the pick control for its state", () => {
  const pill = (pick, busy) => sw.pillHtml({ name: 'A. Named <chips>', pick, busy });
  assert.equal(text(pill({ kind: 'none' })), '‹ A. Named &lt;chips&gt; ›');
  assert.doesNotMatch(pill({ kind: 'none' }), /data-ps="pick"/);
  assert.match(pill(sw.pickState(question, 'A')), /<button type="button" class="ps-pick" data-ps="pick">Pick this<\/button>/);
  assert.match(pill(sw.pickState(answered('B'), 'A')), />Change pick<\/button>/);
  assert.match(pill(sw.pickState(answered('A'), 'A')), /<span class="ps-picked">Picked<\/span>/);
  assert.doesNotMatch(pill(sw.pickState(answered('A'), 'A')), /data-ps="pick"/);
  assert.match(pill(sw.pickState(question, 'A'), true), /data-ps="pick" disabled>Sending…/);
});

test("a pick answers with the label questions.html sends for that option", () => {
  for (const o of question.options) assert.equal(sw.answerLabel(o), ui.choiceLabel(question, o.id));
});

test('after a pick the page moves on to the next open question of the same topic, wrapping to the top, else to none', () => {
  const q = (id, topic, state = 'open') => ({ id, topic, state });
  const owner = [q('a', 'item:w/A1'), q('b', 'item:w/A1', 'answered'), q('c', 'item:w/A2'), q('d', 'item:w/A1'), q('e', 'item:w/A1')];
  assert.equal(sw.nextQuestion(owner, 'd').id, 'e');
  assert.equal(sw.nextQuestion(owner, 'e').id, 'a');
  assert.equal(sw.nextQuestion(owner, 'c'), null);
  assert.equal(sw.nextQuestion([q('a', 't'), q('b', 't', 'resolved')], 'a'), null);
});
