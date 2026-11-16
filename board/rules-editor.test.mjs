// docs/adr/2026-11-16-2000-edits-save-when-focus-leaves-them.md: the rules editor (public/rules-editor.js) on a mini DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { miniDom } from './mini-dom.mjs';

function mounted(rules, save) {
  const listeners = [];
  class Target { addEventListener(type, fn) { listeners.push({ target: this, type, fn }); } }
  const document = new Target();
  miniDom(Target, document);
  document.body.innerHTML = '<div id="rules"></div>';
  document.getElementById = (id) => document.body.querySelector(`#${id}`);
  document.head = document.body;
  const win = { document };
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(new URL('./public/rules-editor.js', import.meta.url), 'utf8'), win);
  const root = document.body.querySelector('#rules');
  win.RulesEditor.mount(root, { rules, save });
  // The editor awaits only promises, so a few microtask turns let a save finish.
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const fire = async (target, type, extra = {}) => {
    const ev = { type, target, preventDefault() {}, ...extra };
    for (let n = target; n; n = n.parentNode) for (const l of listeners.filter((x) => x.target === n && x.type === type)) await l.fn(ev);
    await settle();
  };
  return { root, $: (sel) => root.querySelector(sel), fire };
}

test('a rule saves when focus leaves its box, an added rule when focus leaves the add box, a removal at once; Escape, an emptied and an unchanged edit save nothing, and a refusal keeps what was typed', async () => {
  const saved = [];
  let refuse = '';
  let rules = [{ id: 'r1', text: 'Ask first', by: 'owner' }, { id: 'r2', text: 'Screenshots', by: 'claude' }];
  const p = mounted(rules, async (body) => {
    saved.push(JSON.parse(JSON.stringify(body)));
    if (refuse) throw new Error(refuse);
    rules = body.rules.map((r, i) => ({ id: r.id || `n${i}`, text: r.text, by: 'owner' }));
    return { rules, message: 'Saved.' };
  });
  const rule = (id) => p.$(`.rule[data-key="${id}"]`);
  const box = () => p.$('.rule-input');
  const edit = (id) => p.fire(rule(id).querySelector('[data-act="edit"]'), 'click');
  assert.equal(p.$('[data-act="save"]'), null, 'no Save button');
  await edit('r1');
  assert.equal(p.root.querySelector('[data-act="done"], [data-act="cancel"]'), null, 'no Done or Cancel');
  box().value = 'Ask before main';
  await p.fire(box(), 'focusout');
  assert.deepEqual(saved, [{ rules: [{ id: 'r1', text: 'Ask before main' }, { id: 'r2', text: 'Screenshots' }], base: ['r1', 'r2'] }]);
  assert.equal(box(), null);
  assert.match(rule('r1').textContent, /Ask before main/);

  await edit('r1');
  await p.fire(box(), 'focusout');
  await edit('r1');
  box().value = '  ';
  await p.fire(box(), 'focusout');
  await edit('r1');
  box().value = 'Changed';
  await p.fire(box(), 'keydown', { key: 'Escape' });
  assert.equal(saved.length, 1, 'unchanged, emptied and Escaped edits save nothing');
  assert.match(rule('r1').textContent, /Ask before main/);

  await edit('r1');
  box().value = 'Ask twice';
  refuse = 'The host is asleep.';
  await p.fire(box(), 'focusout');
  assert.equal(box().value, 'Ask twice', 'a refused save keeps the box and its text');
  assert.match(p.$('.rule-status').textContent, /host is asleep/);
  refuse = '';
  await p.fire(box(), 'focusout');
  assert.match(rule('r1').textContent, /Ask twice/);

  const add = p.$('.rule-add textarea');
  add.value = 'Run the tests';
  await p.fire(add, 'focusout');
  assert.deepEqual(saved.at(-1).rules.at(-1), { text: 'Run the tests' });
  assert.equal(add.value, '');
  const before = saved.length;
  await p.fire(add, 'focusout');
  assert.equal(saved.length, before, 'an empty add box saves nothing');

  await p.fire(rule('r2').querySelector('[data-act="remove"]'), 'click');
  assert.deepEqual(saved.at(-1).rules.map((r) => r.text), ['Ask twice', 'Run the tests']);
  assert.equal(rule('r2'), null);
});
