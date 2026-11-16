import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ document: { addEventListener() {} }, location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout });
for (const file of ['ui-icon-text.js', 'ui.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
const { swipeVerdict } = context.BoardUI;

test('a slow release past 30% of the height dismisses', () => {
  assert.equal(swipeVerdict(301, 1000, 5000), 'dismiss');
});

test('a slow release short of 30% springs back', () => {
  assert.equal(swipeVerdict(299, 1000, 5000), 'back');
});

test('a fast flick dismisses even when short', () => {
  assert.equal(swipeVerdict(80, 1000, 100), 'dismiss');
});

test('a tiny twitch is never a flick', () => {
  assert.equal(swipeVerdict(10, 1000, 5), 'back');
});

test('an upward drag springs back', () => {
  assert.equal(swipeVerdict(-200, 1000, 50), 'back');
});

test('every sheet that is shown as a modal registers the swipe first', () => {
  const dir = new URL('./public/', import.meta.url);
  let sites = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(new URL(file, dir), 'utf8');
    // ui.js's own openSheet is the one showModal call that opens whatever sheet it is handed.
    const shown = [...src.matchAll(/\b(\w+)\.showModal\(\)|\bBoardUI\.openSheet\((\w+)/g)].filter((m) => file !== 'ui.js' || m[2]);
    for (const [, shownSheet, openedSheet] of shown) {
      const sheet = shownSheet ?? openedSheet;
      sites++;
      assert.match(src, new RegExp(`BoardUI\\.swipeToDismiss\\(${sheet}\\)`), `${file}: ${sheet}.showModal() without swipeToDismiss(${sheet})`);
    }
  }
  assert.ok(sites > 0);
});
