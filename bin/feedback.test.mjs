import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { feedbackUrl, versionsLine } from './feedback.mjs';

const CLI = fileURLToPath(new URL('./kickflip.mjs', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, [CLI, 'feedback', ...args], { encoding: 'utf8' });

test('feedbackUrl fills the form template with type, title and versions, and nothing else', () => {
  const u = new URL(feedbackUrl({ type: 'bug', title: 'a & b', versions: versionsLine('1.2.3') }));
  assert.equal(u.origin + u.pathname, 'https://github.com/lovek4d/kickflip/issues/new');
  assert.deepEqual([...u.searchParams.keys()], ['template', 'title', 'type', 'versions']);
  assert.equal(u.searchParams.get('template'), 'feedback.yml');
  assert.equal(u.searchParams.get('title'), 'a & b');
  assert.equal(u.searchParams.get('type'), 'bug');
  assert.match(u.searchParams.get('versions'), new RegExp(`^kickflip 1\\.2\\.3, node ${process.versions.node}, \\S+ \\S+ \\S+$`));
});

test('feedbackUrl leaves out a type or title not given', () => {
  const u = new URL(feedbackUrl({ versions: 'v' }));
  assert.deepEqual([...u.searchParams.keys()], ['template', 'versions']);
});

test('kickflip feedback --print prints the versions and the URL without opening anything', () => {
  const r = cli('--print', '--type', 'idea', '--title', 'dark mode');
  assert.equal(r.status, 0, r.stderr);
  const url = r.stdout.split('\n').find((l) => l.startsWith('https://'));
  assert.equal(new URL(url).searchParams.get('type'), 'idea');
  assert.equal(new URL(url).searchParams.get('title'), 'dark mode');
  assert.match(r.stdout, /node \d+/);
  assert.doesNotMatch(r.stdout, /Opening/);
});

test('kickflip feedback refuses an unknown type', () => {
  const r = cli('--print', '--type', 'rant');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bug, idea, question/);
});

test('the issue form has the fields the URL fills, and blank issues stay allowed', () => {
  const form = fs.readFileSync(new URL('../.github/ISSUE_TEMPLATE/feedback.yml', import.meta.url), 'utf8');
  for (const id of ['type', 'details', 'versions']) assert.match(form, new RegExp(`id: ${id}\\b`));
  assert.match(form, /labels: \["feedback"\]/);
  assert.match(fs.readFileSync(new URL('../.github/ISSUE_TEMPLATE/config.yml', import.meta.url), 'utf8'), /blank_issues_enabled: true/);
});
