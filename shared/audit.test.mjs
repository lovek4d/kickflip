import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, readAudit, auditLines, boardAudit, hubAudit, AUDIT_DAYS } from './audit.mjs';
import { tempDir } from './temp-dir.mjs';

const DAY = 86400_000;
const now = new Date('2026-11-05T12:00:00Z');
const ago = (days) => new Date(now.getTime() - days * DAY);

function fixture(t) {
  const dir = tempDir('audit-');
  return { dir, file: path.join(dir, 'data', 'audit.jsonl') };
}
const lines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('a board keeps its audit in data/audit.jsonl and the hub in ~/.claude/kickflip/audit.jsonl', () => {
  assert.equal(boardAudit('/sites/b'), '/sites/b/data/audit.jsonl');
  assert.equal(hubAudit('/home/me'), '/home/me/.claude/kickflip/audit.jsonl');
});

test('each call is one line with its time, call, card, result, reason and the inputs it read', (t) => {
  const { file } = fixture(t);
  audit(file, { call: 'builder-pick', key: 'w/A1', result: 'claude opus', reason: "Claude model is Auto and the task isn't small.", inputs: { claudeModel: 'auto', size: null } }, { now });
  audit(file, { call: 'usage-pause', result: 'paused', reason: 'Five-hour usage is at 91%.', inputs: { used: 91 } }, { now });
  assert.deepEqual(lines(file), [
    { at: now.toISOString(), call: 'builder-pick', key: 'w/A1', result: 'claude opus', reason: "Claude model is Auto and the task isn't small.", inputs: { claudeModel: 'auto', size: null } },
    { at: now.toISOString(), call: 'usage-pause', result: 'paused', reason: 'Five-hour usage is at 91%.', inputs: { used: 91 } },
  ]);
});

test(`an append drops the entries older than ${AUDIT_DAYS} days, and a read never shows them`, (t) => {
  const { file } = fixture(t);
  const entry = (call) => ({ call, result: 'r', reason: 'why', inputs: {} });
  audit(file, entry('old'), { now: ago(AUDIT_DAYS + 1) });
  audit(file, entry('recent'), { now: ago(AUDIT_DAYS - 1) });
  assert.deepEqual(readAudit(file, { now }).map((e) => e.call), ['recent']);
  assert.deepEqual(readAudit(file, { now: ago(AUDIT_DAYS - 1) }).map((e) => e.call), ['old', 'recent']);
  audit(file, entry('new'), { now });
  assert.deepEqual(lines(file).map((e) => e.call), ['recent', 'new']);
});

test('a call logged once is skipped while its newest entry for that card says the same', (t) => {
  const { file } = fixture(t);
  const refused = { call: 'auto-merge', key: 'w/A1', result: 'not merged', reason: 'Commits after the approval.', inputs: {} };
  audit(file, refused, { now, once: true });
  audit(file, refused, { now, once: true });
  audit(file, { ...refused, key: 'w/A2' }, { now, once: true });
  audit(file, { ...refused, result: 'merged', reason: 'Approved.' }, { now, once: true });
  audit(file, refused, { now, once: true });
  audit(file, refused, { now });
  assert.deepEqual(lines(file).map((e) => [e.key, e.result]), [['w/A1', 'not merged'], ['w/A2', 'not merged'], ['w/A1', 'merged'], ['w/A1', 'not merged'], ['w/A1', 'not merged']]);
});

test('a read takes one card, skips a line a crash cut short, and a missing log reads empty', (t) => {
  const { file } = fixture(t);
  assert.deepEqual(readAudit(file, { now }), []);
  audit(file, { call: 'pull', key: 'w/A1', result: 'started', reason: 'a', inputs: {} }, { now });
  fs.appendFileSync(file, '{"at":"2026-11-05T12:00:00.000Z","call":"pu');
  fs.appendFileSync(file, '\n');
  audit(file, { call: 'pull', key: 'w/A2', result: 'started', reason: 'b', inputs: {} }, { now });
  assert.deepEqual(readAudit(file, { key: 'w/A2', now }).map((e) => e.reason), ['b']);
  assert.deepEqual(readAudit(file, { now }).map((e) => e.key), ['w/A1', 'w/A2']);
});

test('the CLI lines name each call and its result and reason, then the inputs it read', () => {
  assert.deepEqual(auditLines([
    { at: '2026-11-05T12:00:00.000Z', call: 'builder-pick', key: 'w/A1', result: 'claude sonnet', reason: 'Claude model is Auto and the task is small.', inputs: { size: 'small' } },
    { at: '2026-11-05T12:01:00.000Z', call: 'usage-resume', result: 'resumed', reason: 'Five-hour usage fell under the line.', inputs: {} },
  ]), [
    '2026-11-05T12:00:00.000Z builder-pick w/A1: claude sonnet. Claude model is Auto and the task is small.',
    '  inputs: {"size":"small"}',
    '2026-11-05T12:01:00.000Z usage-resume: resumed. Five-hour usage fell under the line.',
    '  inputs: {}',
  ]);
  assert.deepEqual(auditLines([]), ['No calls in the last 30 days.']);
});
