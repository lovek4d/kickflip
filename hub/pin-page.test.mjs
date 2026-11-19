// The sign-in page's PIN boxes (front-door.mjs refusalPage): eight boxes fed by one input, no button, the form sending
// itself at the eighth digit, and a status line whose slot keeps its height in every state
// (docs/adr/2026-11-19-0630-the-pin-page-signs-in-at-the-eighth-digit-and-devices-holds-sign-in-a-device.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { miniDom } from '../board/mini-dom.mjs';
import { refusalPage } from './front-door.mjs';

// The page's body in a mini DOM with its script run, the input's events reaching its listeners. → {doc, input, typed(value), sent}
function mount(html) {
  const document = {};
  const listeners = [];
  const { Element } = miniDom(class {
    addEventListener(type, fn) { listeners.push({ target: this, type, fn }); }
    dispatchEvent(ev) { for (const l of listeners.filter((l) => l.target === this && l.type === ev.type)) l.fn(ev); }
  }, document);
  const body = new Element('body');
  document.body = body;
  body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script>[\s\S]*<\/script>/, '');
  const sent = [];
  body.querySelector('.rf-form').requestSubmit = () => sent.push(body.querySelector('[name=pin]').value);
  document.querySelector = (s) => body.querySelector(s);
  vm.runInContext(/<script>([\s\S]*)<\/script>/.exec(html)[1], vm.createContext({ document }));
  const input = body.querySelector('[name=pin]');
  const typed = (value) => { input.value = value; input.dispatchEvent({ type: 'input' }); };
  return { doc: body, input, typed, sent };
}
const digits = (doc) => doc.querySelectorAll('.rf-box').map((b) => b.textContent).join('');
const status = (doc) => { const s = doc.querySelector('.rf-status'); return [s.textContent, s.getAttribute('class')]; };

test('the PIN page has eight boxes over one focused numeric input, no Sign in button, and the owner\'s hint', () => {
  const html = refusalPage('signed-out', { next: '/orch/' });
  assert.doesNotMatch(html, /<button/, 'no Sign in button');
  assert.equal(html.match(/class="rf-box"/g).length, 8);
  assert.match(html, /<input name="pin" value="" aria-label="PIN" inputmode="numeric" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" autofocus>/);
  assert.match(html, /<p class="rf-sub">Run <code>kickflip link<\/code> on its host, or go to Hub &gt; Devices &gt; Show PIN on a signed in device\.<\/p>/);
  assert.match(html, /<p class="rf-status" role="status" aria-live="polite"><\/p>/, 'the status slot is there, empty, before anything is typed');
  assert.match(html, /\.rf-status \{[^}]*height: 24px;/, 'the slot has a fixed height');
});

test('typing fills the boxes, the eighth digit locks them and sends the form with Signing in…', () => {
  const { doc, typed, sent, input } = mount(refusalPage('signed-out'));
  typed('4829');
  assert.equal(digits(doc), '4829');
  assert.equal(doc.querySelectorAll('.rf-box.cur').length, 1);
  assert.equal(doc.querySelectorAll('.rf-box')[4].classList.contains('cur'), true, 'the next box is the caret');
  assert.deepEqual(sent, []);
  typed('48291');
  typed('4829');
  assert.equal(digits(doc), '4829', 'backspace clears the last box');
  typed('48291706');
  assert.deepEqual(sent, ['48291706']);
  assert.equal(doc.querySelector('.rf-boxes').classList.contains('lock'), true);
  assert.equal(input.readOnly, true, 'locked, yet still sent with the form');
  assert.deepEqual(status(doc), ['Signing in…', 'rf-status info']);
});

test('a paste drops spaces and other non-digits, fills every box and sends at once', () => {
  const { doc, typed, sent } = mount(refusalPage('signed-out'));
  typed('PIN: 4829 1706 ');
  assert.equal(digits(doc), '48291706');
  assert.deepEqual(sent, ['48291706']);
  const long = mount(refusalPage('signed-out'));
  long.typed('482917069');
  assert.deepEqual(long.sent, ['48291706'], 'only the first eight digits');
});

test('a wrong PIN shows red boxes and the tries left in the status slot, cleared by the next digit', () => {
  const html = refusalPage('pin-wrong', { left: 2 });
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /<p class="rf-status bad" role="status" aria-live="polite">Wrong PIN, 2 tries left<\/p>/);
  const { doc, typed } = mount(html);
  assert.equal(doc.querySelector('.rf-boxes').classList.contains('err'), true);
  typed('1');
  assert.equal(doc.querySelector('.rf-boxes').classList.contains('err'), false);
  assert.deepEqual(status(doc), ['', 'rf-status']);
  assert.match(refusalPage('pin-wrong', { left: 1 }), /Wrong PIN, 1 try left/);
});

test('the blocked page takes no PIN', () => {
  const body = /<body>([\s\S]*)<\/body>/.exec(refusalPage('blocked'))[1];
  assert.doesNotMatch(body, /rf-box|rf-status|<form|<script/);
});
