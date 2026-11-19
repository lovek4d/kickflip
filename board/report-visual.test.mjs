import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { home, site, board } from './board-fixture.mjs';

// docs/adr/2026-11-18-2345-a-report-for-the-owner-goes-to-a-visual-never-a-local-path.md
test('a thread line naming a path the owner cannot open is refused, with the visual commands to use', async () => {
  const refused = [
    'report at /private/tmp/claude-501/scratch/report.md',
    'see /tmp/report.md',
    'see (/tmp/report.md).',
    'report in ~/.claude/jobs/abc/report.md',
    'report in /Users/someone/.claude/jobs/abc/report.md',
  ];
  for (const text of refused) {
    const r = await board('thread', 'w/A1', '--text', text, '--site', 'orch');
    assert.equal(r.code, 1, text);
    assert.match(r.err, /names a path the owner can't open/, text);
    assert.match(r.err, /visual add/, text);
    assert.match(r.err, /item brief w\/A1 --kind visual|item brief <task> --kind visual/, text);
  }
  for (const text of ['the /tmp folder is cleared nightly, see visuals/A1/report.html', 'a tmp/ dir and /temporary are fine', 'Summary: 3 findings.']) {
    const r = await board('thread', 'w/A1', '--text', text, '--site', 'orch');
    assert.equal(r.code, 0, `${text}: ${r.err}`);
  }
});

test('visual add renders a Markdown report into a self-contained page', async () => {
  const report = path.join(home, 'report.md');
  fs.writeFileSync(report, '# Findings\n\nTwo **bad** things in `store.mjs`.\n\n| a | b |\n| --- | --- |\n| 1 | <script>x</script> |\n\n- one\n- two\n');
  const r = await board('--site', 'orch', 'visual', 'add', 'w/A1', '--file', report, '--title', 'Audit findings');
  assert.deepEqual({ code: r.code, err: r.err, out: r.out }, { code: 0, err: '', out: 'visuals/A1/audit-findings.html\n' });
  const html = fs.readFileSync(site('orch', 'public', 'visuals', 'A1', 'audit-findings.html'), 'utf8');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<title>Audit findings<\/title>/);
  assert.match(html, /<h1>Findings<\/h1>/);
  assert.match(html, /<strong>bad<\/strong>/);
  assert.match(html, /<code>store\.mjs<\/code>/);
  assert.match(html, /<table>/);
  assert.match(html, /<li>two<\/li>/);
  assert.match(html, /prefers-color-scheme/);
  assert.doesNotMatch(html, /<script>x/);
});

test('visual add refuses an empty Markdown report and any other kind of file', async () => {
  const empty = path.join(home, 'empty.md');
  fs.writeFileSync(empty, '  \n');
  assert.match((await board('--site', 'orch', 'visual', 'add', 'w/A1', '--file', empty, '--title', 'X')).err, /empty/);
  const plain = path.join(home, 'notes.txt');
  fs.writeFileSync(plain, 'hi');
  assert.match((await board('--site', 'orch', 'visual', 'add', 'w/A1', '--file', plain, '--title', 'X')).err, /\.html .*\.md|\.md/);
});
