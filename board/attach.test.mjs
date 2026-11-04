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
  for (const file of ['ui.js', 'attach.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), win);
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
