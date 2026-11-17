import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { miniDom } from './mini-dom.mjs';

// attach.js on a mini DOM with document-level listeners, a fake XMLHttpRequest that records each upload, and fake
// drag and paste events (a dataTransfer or clipboardData with types and files).
function attachPage() {
  const listeners = [];
  class Target {
    addEventListener(type, fn) { listeners.push({ target: this, type, fn }); }
    dispatchEvent(ev) { return fire(this, ev.type, ev); }
  }
  const document = new Target();
  const { Element } = miniDom(Target, document);
  document.querySelectorAll = (sel) => document.body.querySelectorAll(sel);
  // An event bubbles from its target up to the document, as the browser's would.
  function fire(target, type, extra = {}) {
    const ev = { type, target, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, ...extra };
    for (let n = target; n; n = n.parentNode || (n === document.body ? document : null)) {
      for (const l of listeners.filter((x) => x.target === n && x.type === type)) l.fn(ev);
    }
    return ev;
  }
  const uploads = [];
  class XMLHttpRequest {
    constructor() { this.upload = {}; }
    open(method, url) { this.url = url; }
    setRequestHeader() {}
    send(file) { uploads.push({ url: this.url, file, xhr: this }); }
    abort() {}
  }
  const win = {
    document, CSS: { escape: (s) => s }, CustomEvent: class { constructor(type, init) { Object.assign(this, { type, ...init }); } },
    XMLHttpRequest, URL: { createObjectURL: (f) => `blob:${f.name}`, revokeObjectURL() {} }, ClaudeSite: { root: '/board-a' },
  };
  win.window = win;
  vm.createContext(win);
  for (const file of ['ui-icon-text.js', 'ui.js','attach.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), win);
  document.body.innerHTML = `<div data-site="/board-a"><form data-composer="ask">${win.BoardUI.dropZone('<textarea></textarea>')}
    <div class="pending-files" data-files></div><div class="row">${win.BoardUI.attachButton()}</div></form><p class="outside">Not a box</p></div>`;
  const composer = document.body.querySelector('[data-composer]');
  const box = composer.querySelector('textarea');
  const dragging = () => composer.classList.contains('dragging');
  const file = (name, type) => ({ name, type, size: 10 });
  const drag = (types, files = []) => ({ dataTransfer: { types, files } });
  return { win, fire, uploads, composer, box, dragging, file, drag, outside: document.body.querySelector('.outside') };
}

test("a composer's text box sits in a drop zone with a Drop to attach hint", () => {
  const p = attachPage();
  const zone = p.composer.querySelector('.dz');
  assert.ok(zone.querySelector('textarea'));
  assert.equal(zone.querySelector('.dz-hint').textContent, 'Drop to attach');
});

test('dragging files over a composer marks it dragging until the drag leaves it or drops, counting enters on its children', () => {
  const p = attachPage();
  const files = p.drag(['Files']);
  p.fire(p.composer, 'dragenter', files);
  p.fire(p.box, 'dragenter', files);
  assert.equal(p.dragging(), true);
  p.fire(p.composer, 'dragleave', files);
  assert.equal(p.dragging(), true, 'still over the text box inside it');
  assert.equal(p.fire(p.box, 'dragover', files).defaultPrevented, true, 'dragover is taken, so the drop lands here');
  p.fire(p.box, 'dragleave', files);
  assert.equal(p.dragging(), false);
  p.fire(p.box, 'dragenter', files);
  const drop = p.fire(p.box, 'drop', p.drag(['Files'], [p.file('shot.png', 'image/png')]));
  assert.deepEqual([drop.defaultPrevented, p.dragging()], [true, false]);
  p.fire(p.box, 'dragenter', files);
  assert.equal(p.dragging(), true, 'a new drag after a drop counts from zero');
});

test('a dropped file uploads to its site like a picked one and shows its chip under the box', () => {
  const p = attachPage();
  p.fire(p.box, 'dragenter', p.drag(['Files']));
  p.fire(p.box, 'drop', p.drag(['Files'], [p.file('shot.png', 'image/png'), p.file('notes.pdf', 'application/pdf')]));
  assert.deepEqual(p.uploads.map((u) => [u.url, u.file.name]), [['/board-a/api/upload', 'shot.png'], ['/board-a/api/upload', 'notes.pdf']]);
  const chips = p.composer.querySelectorAll('[data-files] .pfile');
  assert.deepEqual(chips.map((c) => c.getAttribute('title')), ['shot.png', 'notes.pdf']);
  assert.ok(chips[0].querySelector('img'), 'an image gets a thumbnail');
  assert.equal(chips[1].querySelector('.pname').textContent, 'notes.pdf', 'any other file gets a file chip with its name');
  assert.equal(p.win.BoardAttach.busy('ask', '/board-a'), true, 'Send waits while the upload runs');
  const up = p.uploads[0].xhr;
  Object.assign(up, { status: 200, responseText: JSON.stringify({ name: 'shot.png', url: 'uploads/1-shot.png' }) });
  up.onload();
  assert.deepEqual(JSON.parse(JSON.stringify(p.win.BoardAttach.files('ask', '/board-a'))), [{ name: 'shot.png', url: 'uploads/1-shot.png' }]);
});

test('pasting an image into a text box attaches it in place of pasting, and a paste with no files pastes as usual', () => {
  const p = attachPage();
  const pasted = p.fire(p.box, 'paste', { clipboardData: { types: ['Files'], files: [p.file('image.png', 'image/png')] } });
  assert.equal(pasted.defaultPrevented, true);
  assert.deepEqual(p.uploads.map((u) => u.file.name), ['image.png']);
  const typed = p.fire(p.box, 'paste', { clipboardData: { types: ['text/plain'], files: [] } });
  assert.equal(typed.defaultPrevented, false);
  assert.equal(p.uploads.length, 1);
});

test('a drag of text, or a paste outside any composer, is left alone, and files dropped outside every composer are dropped without opening', () => {
  const p = attachPage();
  const text = p.drag(['text/plain']);
  p.fire(p.box, 'dragenter', text);
  assert.equal(p.dragging(), false);
  assert.equal(p.fire(p.box, 'dragover', text).defaultPrevented, false);
  assert.equal(p.fire(p.box, 'drop', text).defaultPrevented, false);
  p.fire(p.outside, 'dragenter', p.drag(['Files']));
  assert.equal(p.dragging(), false);
  assert.equal(p.fire(p.outside, 'dragover', p.drag(['Files'])).defaultPrevented, true, 'the browser would open the file');
  assert.equal(p.fire(p.outside, 'drop', p.drag(['Files'], [p.file('x.png', 'image/png')])).defaultPrevented, true);
  assert.equal(p.fire(p.outside, 'paste', { clipboardData: { types: ['Files'], files: [p.file('y.png', 'image/png')] } }).defaultPrevented, false);
  assert.equal(p.uploads.length, 0);
});

test('a failed upload chip retries from the same file on click, and an over-20 MB chip stays remove-only', () => {
  const p = attachPage();
  p.fire(p.box, 'paste', { clipboardData: { types: ['Files'], files: [p.file('a.pdf', 'application/pdf'), { ...p.file('big.zip', 'application/zip'), size: 21 * 1024 * 1024 }] } });
  const up = p.uploads[0].xhr;
  Object.assign(up, { status: 500, responseText: '{}' });
  up.onload();
  const chips = () => p.composer.querySelectorAll('[data-files] .pfile');
  assert.match(chips()[0].querySelector('.perr').textContent, /Upload failed · tap to retry/);
  assert.match(chips()[0].getAttribute('title'), /tap to retry/);
  assert.match(chips()[1].getAttribute('title'), /retry can't succeed/);
  assert.equal(chips()[1].querySelector('.perr').textContent, 'Over 20 MB');
  p.fire(chips()[1], 'click');
  assert.equal(p.uploads.length, 1, 'over 20 MB does not retry');
  p.fire(chips()[0], 'click');
  assert.equal(p.uploads.length, 2);
  assert.equal(p.uploads[1].file.name, 'a.pdf');
  assert.equal(p.win.BoardAttach.busy('ask', '/board-a'), true);
});

test('pressing the attach button leaves the text box focused, and a pick puts the cursor back in it', () => {
  const p = attachPage();
  const input = p.composer.querySelector('input[data-attach]');
  p.box.focus();
  const press = p.fire(input, 'mousedown');
  assert.equal(press.defaultPrevented, true);
  // iOS drops focus for its picker.
  p.win.document.activeElement = null;
  input.files = [];
  p.fire(input, 'change', { target: input });
  assert.equal(p.win.document.activeElement, p.box);
});

test('pressing the attach button with no text box focused leaves focus alone', () => {
  const p = attachPage();
  const input = p.composer.querySelector('input[data-attach]');
  p.win.document.activeElement = null;
  p.fire(input, 'mousedown');
  input.files = [];
  p.fire(input, 'change', { target: input });
  assert.equal(p.win.document.activeElement, null);
});

// On a phone a press that took focus from the box would start closing the keyboard, and the send bar riding on it would
// slide out from under the finger before the click landed.
test("pressing a composer's send button or its Prototype, Grill or Visual leaves the text box focused; another button takes focus", () => {
  const p = attachPage();
  const { sendButton, protoButton, grillButton, visualButton } = p.win.BoardUI;
  p.composer.querySelector('.row').insertAdjacentHTML('beforeend',
    `${protoButton('a')}${grillButton('a')}${visualButton('a')}<button type="button" class="chip">Other</button>${sendButton('Reply', 0)}${sendButton('Done', 1, ' data-confirm="finish"')}`);
  const pressed = (sel) => p.fire(p.composer.querySelector(sel), 'mousedown').defaultPrevented;
  for (const sel of ['button[type=submit][data-nth="0"]', 'button[data-confirm]', '[data-proto]', '[data-grill]', '[data-visual]']) {
    assert.equal(pressed(sel), true, sel);
  }
  assert.equal(pressed('.chip'), false);
});

// docs/adr/2026-11-14-2350-a-new-task-shows-at-once-in-the-new-strip-as-sending.md
test("settled waits for a composer's uploads to finish, true when each one is up and false when one failed, and answers at once with none running", async () => {
  const p = attachPage();
  const { BoardAttach } = p.win;
  assert.equal(await BoardAttach.settled('ask', '/board-a'), true);
  p.fire(p.box, 'paste', { clipboardData: { types: ['Files'], files: [p.file('a.png', 'image/png'), p.file('b.pdf', 'application/pdf')] } });
  const outcome = [];
  BoardAttach.settled('ask', '/board-a').then((ok) => outcome.push(ok));
  const [a, b] = p.uploads.map((u) => u.xhr);
  Object.assign(a, { status: 200, responseText: JSON.stringify({ name: 'a.png', url: 'uploads/1-a.png' }) });
  a.onload();
  await null;
  assert.deepEqual(outcome, [], 'one still runs');
  Object.assign(b, { status: 500, responseText: '{}' });
  b.onload();
  await null;
  assert.deepEqual(outcome, [false]);
});

test("restore puts a sent task's files back in its composer as uploaded chips, ready to send again", () => {
  const p = attachPage();
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  p.win.BoardAttach.restore('ask', [shot], '/board-a');
  assert.deepEqual(JSON.parse(JSON.stringify(p.win.BoardAttach.files('ask', '/board-a'))), [shot]);
  assert.equal(p.win.BoardAttach.busy('ask', '/board-a'), false);
  const chips = p.composer.querySelectorAll('[data-files] .pfile');
  assert.deepEqual(chips.map((c) => [c.getAttribute('title'), c.classList.contains('done')]), [['shot.png', true]]);
});

// docs/adr/2026-11-15-0040-a-new-tasks-media-shows-as-thumbnails-and-sends-atomically.md
// A box's files on board-a, in an array of this realm, so deepEqual compares by value.
const listOf = (p, id) => [...p.win.BoardAttach.list(id, '/board-a')];
test("move carries a composer's files to a send's box with its uploads still running: each lands there, the composer empties, and every change is told to onChange until it unsubscribes", async () => {
  const p = attachPage();
  const { BoardAttach } = p.win;
  const told = [];
  const off = BoardAttach.onChange((id) => told.push(id));
  p.fire(p.box, 'paste', { clipboardData: { types: ['Files'], files: [p.file('a.png', 'image/png'), p.file('b.pdf', 'application/pdf')] } });
  BoardAttach.move('ask', 'send:s1', '/board-a');
  assert.deepEqual([listOf(p, 'ask').length, listOf(p, 'send:s1').map((f) => [f.name, f.status])], [0, [['a.png', 'uploading'], ['b.pdf', 'uploading']]]);
  assert.equal(p.composer.querySelectorAll('[data-files] .pfile').length, 0, 'the composer is empty');
  const outcome = [];
  BoardAttach.settled('send:s1', '/board-a').then((ok) => outcome.push(ok));
  told.length = 0;
  const [a, b] = p.uploads.map((u) => u.xhr);
  Object.assign(a, { status: 200, responseText: JSON.stringify({ name: 'a.png', url: 'uploads/1-a.png' }) });
  a.onload();
  Object.assign(b, { status: 200, responseText: JSON.stringify({ name: 'b.pdf', url: 'uploads/2-b.pdf' }) });
  b.onload();
  await null;
  assert.deepEqual([outcome, told], [[true], ['send:s1', 'send:s1']]);
  assert.deepEqual(JSON.parse(JSON.stringify(BoardAttach.files('send:s1', '/board-a'))).map((f) => f.url), ['uploads/1-a.png', 'uploads/2-b.pdf']);
  off();
  BoardAttach.clear('send:s1', '/board-a');
  assert.deepEqual(told, ['send:s1', 'send:s1']);
});

test("retryFailed re-uploads every failed file but a final one, and an X in a [data-uploads] box removes its file from that box", () => {
  const p = attachPage();
  const { BoardAttach } = p.win;
  p.fire(p.box, 'paste', { clipboardData: { types: ['Files'], files: [p.file('a.png', 'image/png'), p.file('b.pdf', 'application/pdf'), { ...p.file('big.zip', 'application/zip'), size: 21 * 1024 * 1024 }] } });
  BoardAttach.move('ask', 'send:s1', '/board-a');
  for (const u of p.uploads) { Object.assign(u.xhr, { status: 500, responseText: '{}' }); u.xhr.onload(); }
  assert.deepEqual(listOf(p, 'send:s1').map((f) => [f.status, Boolean(f.final)]), [['error', false], ['error', false], ['error', true]]);
  BoardAttach.retryFailed('send:s1', '/board-a');
  assert.deepEqual(p.uploads.slice(2).map((u) => u.file.name), ['a.png', 'b.pdf']);
  const row = p.win.document.body.querySelector('[data-site]');
  row.insertAdjacentHTML('beforeend', `<div data-uploads="send:s1">${p.win.BoardUI.uploadTiles(BoardAttach.list('send:s1', '/board-a'))}</div>`);
  const big = BoardAttach.list('send:s1', '/board-a')[2];
  p.fire(row.querySelector(`[data-uploads] [data-unattach="${big.id}"]`), 'click');
  assert.deepEqual(listOf(p, 'send:s1').map((f) => f.name), ['a.png', 'b.pdf']);
});

test("saved keeps a box's files for a reload: uploaded ones as sent, the rest by name; restore puts the uploaded back up and the rest as Lost in a reload, which no retry can change", () => {
  const p = attachPage();
  const { BoardAttach } = p.win;
  p.fire(p.box, 'paste', { clipboardData: { types: ['Files'], files: [p.file('a.png', 'image/png'), p.file('b.pdf', 'application/pdf')] } });
  const [a] = p.uploads.map((u) => u.xhr);
  Object.assign(a, { status: 200, responseText: JSON.stringify({ name: 'a.png', url: 'uploads/1-a.png', type: 'image/png' }) });
  a.onload();
  const kept = JSON.parse(JSON.stringify(BoardAttach.saved('ask', '/board-a')));
  assert.deepEqual(kept, [{ name: 'a.png', url: 'uploads/1-a.png', type: 'image/png' }, { name: 'b.pdf', type: 'application/pdf', lost: true }]);
  BoardAttach.restore('send:s2', kept, '/board-a');
  assert.deepEqual(listOf(p, 'send:s2').map((f) => [f.name, f.status, f.error || '', Boolean(f.final)]), [['a.png', 'done', '', false], ['b.pdf', 'error', 'Lost in a reload', true]]);
  BoardAttach.retryFailed('send:s2', '/board-a');
  assert.equal(p.uploads.length, 2, 'a lost file has nothing to send again');
});

// The Paste chip: a tap reads the clipboard (a fake navigator.clipboard) and, once it settles, the page has what it gave.
async function tapPaste(p, clipboard) {
  Object.assign(p.win, { navigator: { clipboard }, Event: class { constructor(type, init) { Object.assign(this, { type, ...init }); } },
    File: class { constructor(parts, name, init) { Object.assign(this, { name, type: init.type, size: 10, parts }); } } });
  const notices = [];
  p.composer.addEventListener('attach-notice', (ev) => notices.push(ev.detail.text));
  const tap = p.fire(p.composer.querySelector('[data-paste]'), 'click');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return { tap, notices };
}
const clipItem = (parts) => ({ types: Object.keys(parts), getType: async (t) => parts[t] });
const blobOf = (text) => ({ text: async () => text });

test('a text box carries a Paste chip', () => {
  const p = attachPage();
  assert.equal(p.composer.querySelector('.dz > [data-paste]').textContent, 'Paste');
});

test('tapping Paste puts the clipboard text in at the cursor and tells the box', async () => {
  const p = attachPage();
  p.box.value = 'ab';
  p.box.setSelectionRange?.(1, 1);
  p.box._sel = [1, 1, 'none'];
  p.box.setRangeText = (t, s, e) => { p.box.value = p.box.value.slice(0, s) + t + p.box.value.slice(e); };
  let inputs = 0;
  p.box.addEventListener('input', () => inputs++);
  const { notices } = await tapPaste(p, { read: async () => [clipItem({ 'text/plain': blobOf('XY') })] });
  assert.equal(p.box.value, 'aXYb');
  assert.equal(inputs, 1);
  assert.deepEqual(notices, []);
});

test('tapping Paste on an image attaches it and leaves the box text alone', async () => {
  const p = attachPage();
  const { notices } = await tapPaste(p, { read: async () => [clipItem({ 'image/png': {}, 'text/plain': blobOf('ignored') })] });
  assert.deepEqual(p.uploads.map((u) => u.file.name), ['pasted.png']);
  assert.equal(p.box.value, '');
  assert.deepEqual(notices, []);
});

test('tapping Paste with nothing on the clipboard toasts Clipboard is empty.', async () => {
  const p = attachPage();
  const { notices } = await tapPaste(p, { read: async () => [] });
  assert.deepEqual(notices, ['Clipboard is empty.']);
  assert.equal(p.uploads.length, 0);
});

test('a refused read toasts Clipboard access denied., and a browser without read() falls back to readText', async () => {
  const p = attachPage();
  const denied = await tapPaste(p, { read: async () => { throw new Error('NotAllowedError'); } });
  assert.deepEqual(denied.notices, ['Clipboard access denied.']);
  const q = attachPage();
  q.box.setRangeText = (t) => { q.box.value = t; };
  await tapPaste(q, { readText: async () => 'plain' });
  assert.equal(q.box.value, 'plain');
});
