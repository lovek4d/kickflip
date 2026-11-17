import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { miniDom } from './mini-dom.mjs';
import { prEmojiView } from '../hub/views.mjs';

// Hub › Slack's emoji rows (board/public/slack-emoji.js) over a page with no browser: the rows hub/views.mjs
// prEmojiView words, the popover grid with its search, a pick, Use default and a failed save.
function page({ customs }) {
  const document = {};
  const listeners = [];
  const { Element } = miniDom(class {
    addEventListener(type, fn) { listeners.push({ target: this, type, fn }); }
    removeEventListener(type, fn) { listeners.splice(listeners.findIndex((l) => l.target === this && l.type === type && l.fn === fn), 1); }
  }, document);
  const root = new Element('div');
  document.body = root;
  const calls = [];
  let picks = {};
  let refuse = false;
  const context = vm.createContext({
    document, URLSearchParams,
    fetch: async (url, opts = {}) => {
      calls.push({ url, body: opts.body?.toString() ?? null });
      if (url === '/_hub/settings/slack-emoji') {
        if (refuse) return { ok: false, json: async () => ({ error: 'Unknown PR state' }) };
        const kind = opts.body.get('state');
        const { [kind]: _, ...rest } = picks;
        picks = opts.body.get('emoji') ? { ...rest, [kind]: opts.body.get('emoji') } : rest;
      }
      return { ok: true, json: async () => JSON.parse(JSON.stringify(prEmojiView({ picks, customs }))) };
    },
  });
  for (const file of ['ui-hub.js', 'slack-emoji.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
  const fire = (target, type, extra = {}) => Promise.all(listeners.filter((l) => l.target === root && l.type === type).map((l) => l.fn({ target, preventDefault() {}, stopPropagation() {}, ...extra })));
  return { root, calls, fire, mount: (on) => context.SlackEmoji.mount(root, { on }), refuse: (on) => { refuse = on; } };
}
const settle = () => new Promise((r) => setImmediate(r));
const titles = (root) => root.querySelectorAll('.se-row .title').map((t) => t.textContent);
const subs = (root) => root.querySelectorAll('.se-row .sub').map((t) => t.textContent);

test("Hub › Slack's emoji rows load only while the token works, and each opens a popover grid of the workspace's emoji then the standard ones, searched by name", async () => {
  const customs = { git_approved: 'https://emoji.example/a.png', git_merged: 'https://emoji.example/m.png', party_parrot: 'https://emoji.example/p.png' };
  const { root, calls, fire, mount } = page({ customs });
  const slot = mount(false);
  await settle();
  assert.deepEqual([calls, root.innerHTML], [[], '']);
  slot.set(true);
  await settle();
  assert.deepEqual(calls.map((c) => c.url), ['/_hub/api/slack-emoji']);
  assert.equal(root.querySelector('h2').textContent, "Emoji in the PR's state line");
  assert.deepEqual(titles(root), ['Approved', 'Merged', 'Closed standard']);
  assert.deepEqual(subs(root), [':git_approved: · this workspace’s', ':git_merged: · this workspace’s', ':x: · standard']);
  assert.equal(root.querySelector('[data-se-open="approved"] img').getAttribute('src'), customs.git_approved);
  assert.match(root.querySelector('.note').textContent, /^One set for every board\./);
  slot.set(true);
  await settle();
  assert.equal(calls.length, 1, 'a second set with the token still working loads nothing again');

  await fire(root.querySelector('[data-se-open="approved"]'), 'click');
  const pop = () => root.querySelector('.se-pop');
  assert.ok(pop());
  assert.equal(root.querySelector('[data-se-open="approved"]').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(pop().querySelectorAll('.se-sec').map((s) => s.textContent), ['This workspace', 'Standard', ':git_approved: now']);
  assert.deepEqual(pop().querySelectorAll('.se-grid')[0].querySelectorAll('[data-se-pick]').map((b) => b.dataset.sePick), ['git_approved', 'git_merged', 'party_parrot']);
  assert.equal(pop().querySelector('[aria-pressed="true"]').dataset.sePick, 'git_approved');
  const search = pop().querySelector('.se-q');
  search.value = 'parrot';
  await fire(search, 'input');
  assert.equal(pop().querySelector('.se-q'), search, 'typing keeps the search box, and its focus');
  assert.deepEqual(pop().querySelectorAll('[data-se-pick]').map((b) => b.dataset.sePick), ['party_parrot']);
  assert.deepEqual(pop().querySelectorAll('.se-sec').map((s) => s.textContent), ['This workspace', ':git_approved: now']);
  search.value = 'zzz';
  await fire(search, 'input');
  assert.match(pop().textContent, /No emoji match “zzz”/);
  await fire(search, 'keydown', { key: 'Escape' });
  assert.equal(pop(), null);

  // Another row's cell opens its own popover with a fresh search; a click in the rows outside it closes it.
  await fire(root.querySelector('[data-se-open="closed"]'), 'click');
  assert.equal(pop().querySelector('.se-q').value, '');
  assert.equal(pop().querySelector('[aria-pressed="true"]').dataset.sePick, 'x');
  await fire(root.querySelector('.note'), 'click');
  assert.equal(pop(), null);
});

test('a pick saves at once and reads changed from its default with Use default, which resets it; a refused save says why', async () => {
  const { root, calls, fire, mount, refuse } = page({ customs: {} });
  mount(true);
  await settle();
  assert.deepEqual(subs(root)[0], ':white_check_mark: · standard, :git_approved: isn’t in this workspace');
  assert.deepEqual(titles(root), ['Approved standard', 'Merged standard', 'Closed standard']);
  await fire(root.querySelector('[data-se-open="approved"]'), 'click');
  assert.deepEqual(root.querySelector('.se-pop').querySelectorAll('.se-sec').map((s) => s.textContent), ['Standard', ':white_check_mark: now']);
  await fire(root.querySelector('[data-se-pick="tada"]'), 'click');
  await settle();
  assert.deepEqual(calls.at(-1), { url: '/_hub/settings/slack-emoji', body: 'state=approved&emoji=tada' });
  assert.equal(root.querySelector('.se-pop'), null);
  assert.equal(subs(root)[0], ':tada: · changed from :white_check_mark: · Use default');
  assert.equal(titles(root)[0], 'Approved');
  assert.equal(root.querySelector('[data-se-open="approved"]').textContent, '🎉▾');
  await fire(root.querySelector('[data-se-default="approved"]'), 'click');
  await settle();
  assert.deepEqual(calls.at(-1), { url: '/_hub/settings/slack-emoji', body: 'state=approved&emoji=' });
  assert.equal(subs(root)[0], ':white_check_mark: · standard, :git_approved: isn’t in this workspace');

  refuse(true);
  await fire(root.querySelector('[data-se-open="merged"]'), 'click');
  await fire(root.querySelector('[data-se-pick="rocket"]'), 'click');
  await settle();
  assert.equal(root.querySelector('.flash.error').textContent, 'Unknown PR state');
  assert.equal(subs(root)[1], ':large_purple_circle: · standard, :git_merged: isn’t in this workspace');
});
