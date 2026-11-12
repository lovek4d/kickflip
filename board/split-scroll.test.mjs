// Waiting on you's own page: the Send bar ends it, a pill tap keeps its scroll, and the board's ? shows at every width.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');

test('the Send bar ends its page: no padding runs on below it', () => {
  const page = css.match(/body \.view-questions\.view-questions main \{[^}]*\}/)[0];
  assert.match(page, /padding-bottom: var\(--app-bottom, 0px\)/);
  assert.ok(css.indexOf(page) > css.indexOf('body.has-sidebar > :not(.sidebar) > main {'), 'it comes after the phone rule it overrides');
});

test('a topic pill tap keeps the page scroll, and the move on after a Send still jumps to the top', () => {
  const js = fs.readFileSync(new URL('./public/view-questions.js', import.meta.url), 'utf8');
  const tap = js.match(/const b = ev\.target\.closest[^\n]*\[data-topic\][\s\S]*?\n      \}\n/)[0];
  assert.match(tap, /const y = scrollY;[\s\S]*render\(\); scroll\(y\);/);
  assert.doesNotMatch(tap, /scroll\(0\)/);
  assert.match(js, /scroll\(0\);/);
});

test('no width hides the question mark: it is the way to Waiting on you on a desktop too', () => {
  assert.doesNotMatch(css, /pages-switch \{ display: none; \}/);
});

test('the Send bar stacks above the notes\' attach buttons, with equal padding above and below', () => {
  const bar = css.match(/\.view-questions \.bar \{[^}]*\}/)[0];
  const clip = css.match(/\.dz > \.attach \{[^}]*z-index: (\d+)/);
  assert.match(bar, /padding: 10px 0 max\(10px, env\(safe-area-inset-bottom\)\)/);
  assert.ok(Number(bar.match(/z-index: (\d+)/)?.[1]) > Number(clip[1]));
});

test('on a phone the Send bar keeps 10px under Send, the nav below it already padding the safe area', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 899px)'));
  assert.match(phone, /\.view-questions \.bar \{ padding-bottom: 10px; \}/);
});
