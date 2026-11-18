import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { miniDom } from './mini-dom.mjs';
import { prEmojiView } from '../hub/views.mjs';

// Hub › Slack's emoji rows (board/public/slack-emoji.js) over a page with no browser: the rows hub/views.mjs
// prEmojiView words, the popover grid with its search, a pick, Use default and a failed save.
function page({ customs }) {
  const listeners = [];
  class Target {
    addEventListener(type, fn) { listeners.push({ target: this, type, fn }); }
    removeEventListener(type, fn) { listeners.splice(listeners.findIndex((l) => l.target === this && l.type === type && l.fn === fn), 1); }
  }
  const document = new Target();
  const { Element } = miniDom(Target, document);
  const root = new Element('div');
  document.body = root;
  const calls = [];
  let picks = {};
  let refuse = false;
  // popup.js's page: a window and visual viewport to listen on, its edges' 8px margin, and no layout to watch.
  const context = vm.createContext({
    document, URLSearchParams, window: new Target(), visualViewport: Object.assign(new Target(), { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 }),
    getComputedStyle: () => ({ scrollMarginTop: '8px', scrollMarginRight: '8px', scrollMarginBottom: '8px', scrollMarginLeft: '8px' }),
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async (url, opts = {}) => {
      calls.push({ url, body: opts.body?.toString() ?? null });
      if (url === '/_hub/settings/slack-emoji') {
        if (refuse) return { ok: false, json: async () => ({ error: 'Unknown PR state' }) };
        const kind = opts.body.get('state');
        const { [kind]: _, ...rest } = picks;
        picks = opts.body.get('emoji') ? { ...rest, [kind]: opts.body.get('emoji') } : rest;
      }
      const { signature, ...prPicks } = picks;
      return { ok: true, json: async () => JSON.parse(JSON.stringify(prEmojiView({ picks: prPicks, signOff: signature || 'robot_face', customs }))) };
    },
  });
  for (const file of ['ui-hub.js', 'popup.js', 'slack-emoji.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
  // An event reaches the document's listeners (popup.js listens there, capturing), then the root's.
  const fire = (target, type, extra = {}) => Promise.all([document, root].flatMap((at) => listeners.filter((l) => l.target === at && l.type === type))
    .map((l) => l.fn({ target, preventDefault() {}, stopImmediatePropagation() {}, ...extra })));
  return { root, document, calls, fire, mount: (on) => context.SlackEmoji.mount(root, { on }), refuse: (on) => { refuse = on; } };
}
const settle = () => new Promise((r) => setImmediate(r));
const titles = (root) => root.querySelectorAll('.se-row .title').map((t) => t.textContent);
const subs = (root) => root.querySelectorAll('.se-row .sub').map((t) => t.textContent);

test("Hub › Slack's emoji rows load only while the token works, and each opens a popover grid of the workspace's emoji then the standard ones, searched by name", async () => {
  const customs = { git_approved: 'https://emoji.example/a.png', git_merged: 'https://emoji.example/m.png', party_parrot: 'https://emoji.example/p.png' };
  const { root, document, calls, fire, mount } = page({ customs });
  const slot = mount(false);
  await settle();
  assert.deepEqual([calls, root.innerHTML], [[], '']);
  slot.set(true);
  await settle();
  assert.deepEqual(calls.map((c) => c.url), ['/_hub/api/slack-emoji']);
  assert.equal(root.querySelector('h2').textContent, 'Reactions and signature');
  assert.deepEqual(titles(root), ['Approved', 'Merged', 'Closed standard', 'Signature standard']);
  assert.deepEqual(subs(root), [':git_approved: · this workspace’s', ':git_merged: · this workspace’s', ':x: · standard', ':robot_face: · standard']);
  assert.equal(root.querySelector('[data-se-open="signature"]').textContent, '🤖▾');
  assert.equal(root.querySelector('[data-se-open="approved"] img').getAttribute('src'), customs.git_approved);
  assert.match(root.querySelector('.note').textContent, /^One set for every board\./);
  slot.set(true);
  await settle();
  assert.equal(calls.length, 1, 'a second set with the token still working loads nothing again');

  await fire(root.querySelector('[data-se-open="approved"]'), 'click');
  const pop = () => root.querySelector('.se-pop');
  assert.equal(pop().popoverOpen, true, 'the grid is a popup');
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
  assert.equal(document.activeElement, root.querySelector('[data-se-open="approved"]'), 'Escape puts the focus back on the cell');

  // Another row's cell opens its own popover with a fresh search; a click in the rows outside it closes it, leaving the
  // focus where the click put it.
  await fire(root.querySelector('[data-se-open="closed"]'), 'click');
  assert.equal(pop().querySelector('.se-q').value, '');
  assert.equal(pop().querySelector('[aria-pressed="true"]').dataset.sePick, 'x');
  await fire(root.querySelector('.note'), 'click');
  assert.equal(pop(), null);
  assert.equal(document.activeElement, null);
});

test('a pick saves at once and reads changed from its default with Use default, which resets it; a refused save says why', async () => {
  const { root, calls, fire, mount, refuse } = page({ customs: {} });
  mount(true);
  await settle();
  assert.deepEqual(subs(root)[0], ':white_check_mark: · standard, :git_approved: isn’t in this workspace');
  assert.deepEqual(titles(root), ['Approved standard', 'Merged standard', 'Closed standard', 'Signature standard']);
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

  // The signature is picked from the same grid.
  await fire(root.querySelector('[data-se-open="signature"]'), 'click');
  assert.equal(root.querySelector('.se-pop [aria-pressed="true"]').dataset.sePick, 'robot_face');
  await fire(root.querySelector('[data-se-pick="tada"]'), 'click');
  await settle();
  assert.deepEqual(calls.at(-1), { url: '/_hub/settings/slack-emoji', body: 'state=signature&emoji=tada' });
  assert.equal(subs(root)[3], ':tada: · changed from :robot_face: · Use default');

  refuse(true);
  await fire(root.querySelector('[data-se-open="merged"]'), 'click');
  await fire(root.querySelector('[data-se-pick="rocket"]'), 'click');
  await settle();
  assert.equal(root.querySelector('.flash.error').textContent, 'Unknown PR state');
  assert.equal(subs(root)[1], ':large_purple_circle: · standard, :git_merged: isn’t in this workspace');
});
