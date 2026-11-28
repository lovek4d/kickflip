// A quick action on a card's summary (Implement, Done) opens only its confirm modal: the summary click that selects a
// card and follows its notes into the right pane skips every button in the summary, as the More and bell buttons do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8');
const handler = src.slice(src.indexOf("B.on(B.root, 'click', (ev) => {\n    const card = ev.target.closest?.('details.item > summary')"));
const skip = handler.slice(0, handler.indexOf('B.select(')).match(/closest\('([^']*)'\)/g)?.join(' ') ?? '';

test('the card-opening click skips the summary quick actions, so only expanding a card opens the pane', () => {
  assert.match(skip, /button\[data-confirm\]/);
  assert.match(skip, /button\[data-card-menu\]/);
  assert.match(handler.slice(0, 600), /B\.select\(card\.dataset\.key, \{ board: false \}\);\s*B\.followCardNotes/);
});
