import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_LINES, TONES, hubLineOf, BRIEF_LINE_LIMIT, MESSAGE_LIMIT, hubText, detailOf, fit, lineFault } from './hub-lines.mjs';
import { startTitleBrief, startTitleFault } from './commit-message.mjs';

// Every input a kind doesn't bound in its longest is as long as an error, a path or a title can be. unbounded, when
// given, collects the inputs a kind read that its longest leaves unbounded.
const UNBOUNDED = 'x'.repeat(5000);
const longestInputs = (kind, unbounded = new Set()) => new Proxy(kind.longest || {}, { get: (t, k) => (k in t ? t[k] : (unbounded.add(k), UNBOUNDED)), has: () => true });

test('every status line kind fits BRIEF_LINE_LIMIT at its longest inputs, so a long outcome is caught here and never at a write', () => {
  for (const [name, kind] of Object.entries(HUB_LINES)) {
    const unbounded = new Set();
    const words = kind.text(longestInputs(kind, unbounded));
    assert.equal(lineFault(words), null, `${name}: ${words}`);
    assert.ok(words.length > 0, name);
    assert.equal(typeof kind.mark, 'string', name);
    // Worded to fit: a kind whose inputs are all bounded reads whole, and only an unbounded one (an error, a path) is shortened.
    if (!unbounded.size) assert.ok(!words.includes('…'), `${name} cuts its own words: ${words}`);
  }
  assert.equal(BRIEF_LINE_LIMIT, 100);
});

test('lineFault is the one length rule of a status line: words fit their room, BRIEF_LINE_LIMIT unless a lead takes part of it, else it names their length and the room', () => {
  assert.equal(lineFault('x'.repeat(100)), null);
  assert.equal(lineFault('x'.repeat(101)), 'runs to 101 characters, past 100');
  assert.equal(lineFault('x'.repeat(80), 80), null);
  assert.equal(lineFault('x'.repeat(81), 80), 'runs to 81 characters, past 80');
});

test('a build refused for its title reads the reason first and whole at any title, and its detail keeps the title and the retitle', () => {
  const long = 'x'.repeat(5000);
  for (const title of [long, `feat: ${long}`, `ask(board): ${long}?`, 'One']) {
    const inputs = { why: startTitleFault('w/A1', title), brief: startTitleBrief(title) };
    const words = hubText('build-refused', inputs);
    assert.ok(!words.includes('…'), words);
    assert.match(words, /^Couldn't start implementing: its title .+; retitle it$/);
    assert.match(detailOf('build-refused', inputs), /; retitle it with item set w\/A1 --title "<type>\(<scope>\): <summary>" before it goes into In Progress$/);
  }
  const one = { why: startTitleFault('w/A1', 'One'), brief: startTitleBrief('One') };
  assert.equal(hubText('build-refused', one), "Couldn't start implementing: its title isn't <type>(<scope>): <summary>; retitle it");
  assert.equal(detailOf('build-refused', one), one.why);
  // A refusal with no brief reads its reason, shortened only past the room.
  assert.equal(hubText('build-refused', { why: "it's held" }), "Couldn't start implementing: it's held");
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

test('a fault line with an error keeps the whole error as its detail, up to MESSAGE_LIMIT from its end', () => {
  const warning = 'Warning: client version "1.104.5" != tailscaled server version "1.96.2"\n';
  const why = `${warning}Couldn't open try port 8504: access denied`;
  assert.equal(hubText('run-failed', { kind: 'Serve', code: 1, why }), 'Serve failed (exit 1)');
  assert.equal(detailOf('run-failed', { kind: 'Serve', code: 1, why }), why);
  assert.equal(detailOf('run-failed', { kind: 'Serve', code: 1 }), '');
  assert.equal(detailOf('land-failed', { why: 'main moved' }), 'main moved');
  assert.equal(detailOf('host-busy'), '');
  const long = detailOf('push-failed', { base: 'main', error: `${'a'.repeat(3000)}END` });
  assert.equal(long.length, MESSAGE_LIMIT);
  assert.ok(long.startsWith('…') && long.endsWith('END'));
  for (const [name, kind] of Object.entries(HUB_LINES)) if (kind.fault && kind.detail) assert.ok(kind.detail(longestInputs(kind)), name);
});

// docs/adr/2026-11-15-0010-every-thread-status-line-takes-its-colour-from-one-tone-map.md
test('every status line kind has a tone: a fault is red from its fault flag, every other kind names one of the five others, so a new kind fails until it has a colour', () => {
  for (const [name, kind] of Object.entries(HUB_LINES)) {
    if (kind.fault) assert.equal(kind.tone, undefined, `${name} is red from its fault flag`);
    else assert.ok(TONES.includes(kind.tone) && kind.tone !== 'red', `${name} has no tone`);
    assert.equal(hubLineOf({ line: name }).tone, kind.fault ? 'red' : kind.tone, name);
  }
  assert.deepEqual(Object.fromEntries(['merged', 'ci-passed', 'pulled', 'new-question', 'paused', 'merge-blocked', 'host-busy', 'prs-closed', 'build-refused', 'notes-shared'].map((k) => [k, hubLineOf({ line: k }).tone])),
    { merged: 'purple', 'ci-passed': 'green', pulled: 'orange', 'new-question': 'blue', paused: 'grey', 'merge-blocked': 'grey', 'host-busy': 'grey', 'prs-closed': 'grey', 'build-refused': 'red', 'notes-shared': 'red' });
  assert.equal(hubLineOf({ line: 'gone-kind' }).tone, undefined);
});

test('style.css colours every tone a status line can take, merged purple from the shared colour constant', () => {
  const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'style.css'), 'utf8');
  for (const tone of TONES.filter((t) => t !== 'grey')) assert.match(css, new RegExp(`\\.msg\\.request\\.tone-${tone}\\s*\\{[^}]*color:`), tone);
  assert.match(css, /\.msg\.request\.tone-purple\s*\{[^}]*var\(--color-merged\)/);
});
