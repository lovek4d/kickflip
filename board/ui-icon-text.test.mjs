import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('./public/ui-icon-text.js', import.meta.url), 'utf8'), context);
const { iconText, ICON_SHAPES, ICON_COLOURS } = context.BoardUI;
const css = fs.readFileSync(new URL('./public/sidebar.css', import.meta.url), 'utf8');

// docs/adr/2026-11-14-2250-one-icon-and-text-helper-takes-a-shape-and-a-colour.md
test('iconText draws a shape and a word in one colour, the icon hidden unless it is labelled', () => {
  assert.deepEqual([...ICON_SHAPES], ['dot', 'pulse', 'check', 'x', 'spinner', 'pause', 'arrow', 'clock', 'warn', 'eye', 'flame', 'image', 'retry', 'move', 'chat', 'code', 'flag', 'blocked', 'play', 'link', 'created', 'circle-check', 'reopen', 'reply', 'chevron', 'question', 'search']);
  assert.deepEqual([...ICON_COLOURS], ['red', 'orange', 'blue', 'green', 'purple', 'grey']);
  assert.equal(iconText('dot', 'red', 'not listening'), '<span class="it it-red"><span class="it-i it-dot" aria-hidden="true"></span><span class="it-w">not listening</span></span>');
  assert.match(iconText('check', 'green', 'done'), /^<span class="it it-green"><span class="it-i it-check" aria-hidden="true"><svg [^>]*><path d="M20 6 9 17l-5-5"\/><\/svg><\/span><span class="it-w">done<\/span><\/span>$/);
  assert.equal(iconText('dot', 'orange', '', { label: 'Link <settling>' }), '<span class="it it-orange"><span class="it-i it-dot" role="img" aria-label="Link &lt;settling&gt;"></span></span>');
  assert.match(iconText('dot', 'grey', '<b>'), /<span class="it-w">&lt;b&gt;<\/span>/);
  for (const shape of ICON_SHAPES) for (const colour of ICON_COLOURS) assert.match(iconText(shape, colour, 'w'), new RegExp(`^<span class="it it-${colour}"><span class="it-i it-${shape}"`));
});

test("the colour 'current' takes the line's own colour, for a working dot or thread mark alone", () => {
  assert.equal(iconText('pulse', 'current', ''), '<span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"></span></span>');
  assert.ok(!ICON_COLOURS.includes('current'), "the colour priority's six stay six");
  assert.match(css, /\.it-current \{ --it: currentColor; font-weight: inherit;/);
});

test('iconText refuses a shape or colour outside its enums', () => {
  assert.throws(() => iconText('star', 'red', 'x'), /no shape star/);
  assert.throws(() => iconText('dot', 'amber', 'x'), /no colour amber/);
  assert.throws(() => iconText('dot', undefined, 'x'), /no colour/);
});

test('the gap, the 8px dot and every colour sit on the helper\'s own classes, so no parent has to be flex', () => {
  assert.match(css, /\.it \{[^}]*display: inline-flex;[^}]*gap: 5px;/);
  assert.match(css, /\.it-dot::before, \.it-pulse::before \{[^}]*width: 8px; height: 8px;/);
  for (const colour of ICON_COLOURS) assert.match(css, new RegExp(`\\.it-${colour} \\{ --it: var\\(--color-`));
});
