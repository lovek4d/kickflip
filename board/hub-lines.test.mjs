import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_LINES, BRIEF_LINE_LIMIT, hubText, fit } from './hub-lines.mjs';

// Every input a kind doesn't bound in its longest is as long as an error, a path or a title can be.
const UNBOUNDED = 'x'.repeat(5000);
const longestInputs = (kind) => new Proxy(kind.longest || {}, { get: (t, k) => (k in t ? t[k] : UNBOUNDED), has: () => true });

test('every status line kind fits BRIEF_LINE_LIMIT at its longest inputs, so a long outcome is caught here and never at a write', () => {
  for (const [name, kind] of Object.entries(HUB_LINES)) {
    const words = kind.text(longestInputs(kind));
    assert.ok(words.length <= BRIEF_LINE_LIMIT, `${name} runs to ${words.length}: ${words}`);
    assert.ok(words.length > 0, name);
    assert.equal(typeof kind.mark, 'string', name);
  }
  assert.equal(BRIEF_LINE_LIMIT, 100);
});

test('every mark a status line kind names has an icon in ui.js MARK_ICONS', () => {
  const ui = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'ui.js'), 'utf8');
  const icons = /const MARK_ICONS = \{([\s\S]*?)\n  \};/.exec(ui)[1];
  for (const mark of new Set(Object.values(HUB_LINES).map((k) => k.mark))) {
    assert.ok(icons.includes(`'${mark}':`) || new RegExp(`\\b${mark}:`).test(icons), `no icon for ${mark}`);
  }
});

test('the host-busy hold reads in the owner\'s words, and fit cuts only the free part with an ellipsis', () => {
  assert.equal(hubText('host-busy'), 'Host is busy, work will resume when the host recovers');
  assert.equal(fit('Unblocked: ', '#12', '.'), 'Unblocked: #12.');
  const cut = fit('Not merged: ', 'y'.repeat(300), '. Tap Merge again.');
  assert.ok(cut.length <= BRIEF_LINE_LIMIT);
  assert.match(cut, /^Not merged: y+… Tap Merge again\.$/);
  assert.equal(fit('Failed: ', `${os.homedir()}/repo is gone`), 'Failed: ~/repo is gone');
  assert.equal(fit('Failed: ', `spawn /var/folders/${'q'.repeat(80)}/no-such-claude ENOENT`), 'Failed: spawn …/no-such-claude ENOENT');
  assert.throws(() => hubText('no-such-kind'), /no status line kind "no-such-kind"/);
});
