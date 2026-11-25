// On a desktop window the reader sheet is a panel over the right half, the pane, at the width the
// lanes | pane seam gives that half; below 900px it stays the phone sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
const wide = css.slice(css.indexOf('@media (min-width: 900px) {\n  .split'));
const panel = wide.match(/\.sheet\.reader-sheet \{[^}]*\}/)?.[0] ?? '';

test('the reader takes the right pane: below the header, to the right edge, at the pane width', () => {
  assert.match(panel, /inset: 56px 0 0 auto/);
  assert.match(panel, /width: var\(--sheet-w\)/);
  assert.match(wide, /--sheet-w: var\(--pane-w, calc\(\(100vw - var\(--sidebar-w, 0px\)\) \/ 2\)\)/);
  assert.match(panel, /max-width: none/);
  assert.match(panel, /border-radius: 0/);
});

test('the board stays visible beside it and it slides in from the right', () => {
  assert.match(wide, /\.reader-sheet::backdrop \{[^}]*background: transparent/);
  assert.match(wide, /\.sheet\.reader-sheet\[open\] \{ animation: reader-in/);
  assert.match(css, /@keyframes reader-in \{ from \{ transform: translateX\(100%\); \} \}/);
});

test('the phone sheet rules stay outside the desktop media query', () => {
  assert.match(css.slice(0, css.indexOf('@media (min-width: 900px) {\n  .split')), /\.sheet\.reader-sheet, \.sheet\.arch-sheet, \.settings-modal \{\s*--standard-height/);
});

test('one seam, --sheet-w, gives every desktop sheet its width: no other rule sets width or max-width on one', () => {
  const sheetSel = /\.reader-sheet|\.reader-page|#questionsSheet|\.questions-sheet/;
  const rules = [...wide.replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel, body]) => [sel.trim(), body]);
  const setters = rules.filter(([sel, body]) => sheetSel.test(sel) && /(^|[\s;])(max-)?width\s*:/.test(body)).map(([sel]) => sel);
  assert.deepEqual(setters, ['.sheet.reader-sheet'], 'only the reader sheet rule sets a width, from --sheet-w');
});

// Below 900px every standard sheet (the reader family, the architecture review, settings) is one height: the screen
// less the status bar, above the app bar and the keyboard. Replies, New task and the small sheets keep their own.
const phone = css.slice(0, css.indexOf('@media (min-width: 900px) {\n  .split'));
const standard = phone.match(/@media \(max-width: 899px\) \{\s*\.sheet\.reader-sheet, \.sheet\.arch-sheet, \.settings-modal \{[^}]*\}/)?.[0] ?? '';

test('on a phone every standard sheet is full height: one formula, above the app bar, below the status bar', () => {
  const formula = standard.match(/--standard-height: ([^;]*);/)?.[1] ?? '';
  assert.match(formula, /^calc\(100dvh - /);
  assert.match(formula, /max\(0px, calc\(var\(--app-bottom, 0px\) - var\(--kb, 0px\)\)\)/);
  assert.doesNotMatch(formula, /max\(var\(--app-bottom, 0px\), var\(--kb, 0px\)\)/);
  assert.match(formula, /max\(12px, env\(safe-area-inset-top\)\)/);
  assert.match(standard, /\n\s+height: var\(--standard-height\); max-height: var\(--standard-height\);/);
});

// docs/adr/2026-11-22-2330-a-sheets-height-follows-rotation-from-css.md
test('every sheet height comes from 100dvh, which follows rotation and ignores the keyboard; no measured height is read', () => {
  assert.doesNotMatch(css, /--sheet-full|--vh\b/);
  const heights = [...css.matchAll(/(?:--standard-height|--sheet-limit|max-height): ([^;]*dvh[^;]*);/g)].map(([, value]) => value);
  assert.ok(heights.length > 0);
  for (const value of heights) assert.match(value, /100dvh/);
});

test('no other rule gives a standard sheet its own height', () => {
  const rules = [...css.replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel, body]) => [sel.trim(), body]);
  const own = rules.filter(([sel, body]) => /reader-sheet|reader-page|arch-sheet|settings-modal/.test(sel) && /(^|[\s;])(max-)?height\s*:\s*(?!auto|none|fit-content)/.test(body)).map(([sel]) => sel.replace(/\s+/g, ' '));
  assert.deepEqual(own.map((sel) => sel.replace(/^@media[^{]*$/, '').replace(/^.*\) /, '')), ['.sheet.reader-sheet', '.settings-modal, .sheet.arch-sheet']);
  assert.doesNotMatch(css, /\.reader-page \{[^}]*height:/);
});

test('the sheets kept small are not standard', () => {
  for (const kind of ['keyboard-sheet', 'waits-sheet', 'join-sheet', 'links-sheet', 'pause-sheet']) assert.doesNotMatch(standard, new RegExp(kind));
});

test('from 900px the reader is stacked by --layer, and settings and the architecture review leave the pane for a centred modal', () => {
  assert.match(panel, /z-index: calc\(30 \+ var\(--layer, 0\)\)/);
  assert.doesNotMatch(wide, /reader-in[^}]*\.settings-modal|\.sheet\.arch-sheet\[open\], \.settings-modal\[open\] \{ animation: reader-in/);
  const centred = wide.match(/\n\s*\.settings-modal, \.sheet\.arch-sheet \{[^}]*\}/)?.[0] ?? '';
  assert.match(centred, /inset: 0; margin: auto/);
  assert.match(centred, /width: min\(680px, calc\(100% - 48px\)\)/);
  assert.match(centred, /border-radius: 18px/);
  assert.match(wide, /\.settings-modal\[open\], \.sheet\.arch-sheet\[open\][^{]*\{ animation: none/);
});
