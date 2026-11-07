import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptMovedAt, transcriptCommandRunning, transcriptChunk, readRunTranscript } from './transcript.mjs';

test("a worktree's transcript movement is the newest .jsonl in its Claude projects folder, and null when there is none", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));
  const worktree = '/Users/x/.claude/kickflip/worktrees/GH-1';
  const folder = path.join(home, '.claude', 'projects', '-Users-x--claude-kickflip-worktrees-GH-1');
  assert.equal(transcriptMovedAt(worktree, home), null);
  fs.mkdirSync(folder, { recursive: true });
  assert.equal(transcriptMovedAt(worktree, home), null);
  for (const [name, time] of [['a.jsonl', 1000], ['b.jsonl', 3000], ['c.txt', 5000]]) {
    fs.writeFileSync(path.join(folder, name), '');
    fs.utimesSync(path.join(folder, name), time, time);
  }
  assert.equal(transcriptMovedAt(worktree, home), 3000000);
});

test("a worktree recorded through a link, as ~/.claude/skills/kickflip stores the clone, is found under its real path's projects folder, where Claude Code writes its transcript", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-')));
  const real = path.join(home, 'dev', 'kickflip');
  fs.mkdirSync(path.join(real, '.claude', 'worktrees', 'GH-3'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(real, path.join(home, '.claude', 'skills', 'kickflip'));
  const folder = path.join(home, '.claude', 'projects', path.join(real, '.claude', 'worktrees', 'GH-3').replace(/[/.]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'a.jsonl'), '');
  fs.utimesSync(path.join(folder, 'a.jsonl'), 2000, 2000);
  assert.equal(transcriptMovedAt(path.join(home, '.claude', 'skills', 'kickflip', '.claude', 'worktrees', 'GH-3'), home), 2000000);
});

test("a transcript whose last message is a tool call with no result yet reads as a command running, and its movement stays the file mtime", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));
  const worktree = '/Users/x/.claude/kickflip/worktrees/GH-2';
  const folder = path.join(home, '.claude', 'projects', '-Users-x--claude-kickflip-worktrees-GH-2');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'a.jsonl');
  const call = { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } };
  const result = { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } };
  const other = { type: 'api-request' };
  const write = (...entries) => { fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n'); fs.utimesSync(file, 1000, 1000); };
  const reading = () => [transcriptCommandRunning(worktree, home), transcriptMovedAt(worktree, home)];
  write(call);
  assert.deepEqual(reading(), [true, 1_000_000]);
  write(call, other);
  assert.deepEqual(reading(), [true, 1_000_000]);
  write(call, result);
  assert.deepEqual(reading(), [false, 1_000_000]);
  write(result, call, other);
  fs.appendFileSync(file, '{"message":');
  fs.utimesSync(file, 1000, 1000);
  assert.deepEqual(reading(), [true, 1_000_000]);
});

const line = (e) => `${JSON.stringify(e)}\n`;
const toolUse = (id, name, input) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, content) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, tool_use_result: { stdout: 'a copy the transcript skips' } });

test("a run's stream log turns into transcript rows: the start, Claude's words, each call one line with its output keyed to it, and the result", () => {
  const log = line({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', cwd: '/wt/A1' })
    + line({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' })
    + line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Reading the notes.' }] } })
    + toolUse('t1', 'Bash', { command: 'npm test', description: 'Run the tests' })
    + toolResult('t1', [{ type: 'text', text: 'ℹ pass 6' }])
    + toolUse('t2', 'Read', { file_path: '/wt/A1/x.js' })
    + toolResult('t2', 'x'.repeat(5000))
    + 'SessionEnd hook [x] failed\n'
    + line({ type: 'result', subtype: 'success', is_error: false, result: 'Built it.' });
  const chunk = transcriptChunk(Buffer.from(log), 0);
  assert.deepEqual(chunk.rows.slice(0, 5), [
    { kind: 'sys', label: 'start', body: 'claude-opus-5-5 in /wt/A1' },
    { kind: 'text', body: 'Reading the notes.' },
    { kind: 'tool', id: 't1', label: 'bash', body: 'npm test' },
    { kind: 'out', for: 't1', body: 'ℹ pass 6' },
    { kind: 'tool', id: 't2', label: 'read', body: '/wt/A1/x.js' },
  ]);
  assert.equal(chunk.rows[5].body, `${'x'.repeat(4000)}…`, 'a long output is cut');
  assert.deepEqual(chunk.rows.slice(6), [{ kind: 'out', body: 'SessionEnd hook [x] failed' }, { kind: 'text end', label: 'done', body: 'Built it.' }]);
  assert.deepEqual([chunk.next, chunk.stream, chunk.finished], [Buffer.byteLength(log), true, true]);
});

test("a transcript chunk reads to the log's last whole line, and the next read starts from there", () => {
  const first = toolUse('t1', 'Bash', { command: 'ls — é' });
  const partial = toolResult('t1', 'a\nb');
  const log = Buffer.from(first + partial);
  const cut = log.subarray(0, Buffer.byteLength(first) + 10);
  const head = transcriptChunk(cut, 0);
  assert.deepEqual([head.rows.length, head.next, head.finished], [1, Buffer.byteLength(first), false]);
  const rest = transcriptChunk(log.subarray(head.next), head.next);
  assert.deepEqual(rest.rows, [{ kind: 'out', for: 't1', body: 'a\nb' }]);
  assert.equal(rest.next, log.length);
  assert.deepEqual(transcriptChunk(Buffer.alloc(0), log.length), { rows: [], next: log.length, stream: false, finished: false });
});

test('a log with no stream lines is its lines, and not a stream', () => {
  const chunk = transcriptChunk(Buffer.from('I built #214.\n{"not":"an event"}\n'), 0);
  assert.deepEqual(chunk.rows, [{ kind: 'out', body: 'I built #214.' }, { kind: 'out', body: '{"not":"an event"}' }]);
  assert.equal(chunk.stream, false);
});

test("readRunTranscript reads a whole log past 256 KiB from a byte offset", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-transcript-'));
  const file = path.join(dir, 'builder-A1-1.log');
  const start = line({ type: 'system', subtype: 'init', model: 'm', cwd: '/wt' });
  fs.writeFileSync(file, start + toolResult('t0', 'y'.repeat(300_000)) + line({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));
  const whole = await readRunTranscript(file, 0);
  assert.deepEqual(whole.rows[0], { kind: 'sys', label: 'start', body: 'm in /wt' });
  assert.equal(whole.size, fs.statSync(file).size);
  assert.equal(whole.next, whole.size);
  const after = await readRunTranscript(file, Buffer.byteLength(start));
  assert.equal(after.rows[0].for, 't0');
});
