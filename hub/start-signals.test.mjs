import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';

const home = fs.realpathSync(tempDir('start-signals-'));
process.env.HOME = home;
const { startingBoards, startSignals, logStartPrompt, BG_SETTINGS, STALL_AFTER, STARTING_WAIT } = await import('./sessions.mjs');
const { sessionActivity } = await import('./session-activity.mjs');
const { savePrompts } = await import('./prompts.mjs');
const { readAudit, hubAudit } = await import('../shared/audit.mjs');

const repo = path.join(home, '.claude', 'kickflip', 'repos', 'owner', 'my_project');
fs.mkdirSync(repo, { recursive: true });
const NOW = Date.parse('2026-11-16T22:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const transcriptOf = (session) => path.join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`);
const line = (type, content) => JSON.stringify({ type, message: { role: type, content } });
const tool = (name, input) => line('assistant', [{ type: 'tool_use', id: 't1', name, input }]);
function transcript(session, lines, at = NOW) {
  const file = transcriptOf(session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, at / 1000, at / 1000);
}

test("a session's last activity is its transcript's last step, worded, at the transcript's last write", () => {
  assert.equal(sessionActivity(repo, 's-none'), null, 'no transcript, no activity');
  const said = (lines) => { transcript('s1', lines, NOW - 5000); return sessionActivity(repo, 's1'); };
  assert.deepEqual(said([line('user', 'go')]), { at: NOW - 5000, text: 'reading its prompt' });
  assert.equal(said([line('user', 'go'), tool('Skill', { skill: 'kickflip', args: 'board x' })]).text, 'loading the kickflip skill');
  assert.equal(said([tool('Bash', { command: "node ~/dev/kickflip/bin/kickflip.mjs join shop --description 'x'" })]).text, 'joining the hub');
  assert.equal(said([tool('Bash', { command: 'kickflip doctor' })]).text, 'running kickflip doctor');
  assert.equal(said([tool('Read', { file_path: '/a/b/guide.md' })]).text, 'reading guide.md');
  assert.equal(said([line('assistant', [{ type: 'thinking', thinking: 'hm' }])]).text, 'thinking');
  assert.equal(said([line('assistant', [{ type: 'text', text: 'Joined.' }]), line('user', [{ type: 'tool_result', content: 'ok' }]), '{not json']).text, 'writing',
    'a tool result and a torn last line leave the last step standing');
  fs.rmSync(transcriptOf('s1'));
  transcript('s-moved', [tool('Bash', { command: 'kickflip doctor' })]);
  const elsewhere = path.join(home, '.claude', 'projects', '-somewhere-else');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.renameSync(transcriptOf('s-moved'), path.join(elsewhere, 's-moved.jsonl'));
  assert.equal(sessionActivity(repo, 's-moved').text, 'running kickflip doctor', 'a transcript under another folder name is still found by its session');
});

const starting = (rec) => ({ starting: { shop: { title: 'Shop', repo, branch: 'main', tickets: null, phase: 'starting', asked_at: iso(NOW - 6 * 60_000), phase_at: iso(NOW - 6 * 60_000), session: 's-shop', since: iso(NOW - 5 * 60_000), ...rec } } });
const row = (signals, rec = {}, now = NOW) => startingBoards(starting(rec), now, undefined, undefined, () => signals)[0];
const prompt = { id: 'p1', session: 's-shop', route: null, title: '~/x', cwd: repo, tool: 'Bash', action: 'run kickflip doctor --fix', detail: 'kickflip doctor --fix', rule: 'Bash(kickflip doctor --fix)', questions: null, at: iso(NOW - 1000), answer: null };

test("a starting session that died fails its row at once, with why; one ps can't see keeps starting", () => {
  const dead = row({ running: new Map(), activity: { at: NOW - 60_000, text: 'running kickflip doctor' } });
  assert.deepEqual([dead.failed, dead.ended, dead.error], [true, true, 'Its session ended before it joined the hub; its last step was running kickflip doctor.']);
  assert.equal(row({ running: new Map() }).error, 'Its session ended before it joined the hub.');
  assert.equal(row({ running: null }).failed, false, 'ps gave no answer, so nothing is known to have died');
  assert.equal(row({ running: new Map() }, { session: undefined }).failed, false, 'no session recorded yet');
  assert.equal(row({ running: new Map() }, { error: 'claude --bg failed' }).error, 'claude --bg failed', 'a recorded error stands');
});

test('a live starting session shows its last activity, reads stalled after three quiet minutes, and never while a prompt waits on the owner', () => {
  const running = new Map([['s-shop', { pid: 9 }]]);
  const busy = row({ running, activity: { at: NOW - 60_000, text: 'loading the kickflip skill' } });
  assert.deepEqual([busy.failed, busy.activity, busy.stalled, busy.prompt], [false, 'loading the kickflip skill', undefined, undefined]);
  const quiet = row({ running, activity: { at: NOW - STALL_AFTER, text: 'running kickflip doctor' } });
  assert.deepEqual([quiet.failed, quiet.stalled, quiet.quietSince], [false, true, iso(NOW - STALL_AFTER)]);
  const asking = row({ running, activity: { at: NOW - STALL_AFTER, text: 'running kickflip doctor' }, prompt });
  assert.equal(asking.stalled, undefined);
  assert.deepEqual(asking.prompt, { id: 'p1', board: null, title: '~/x', cwd: '~/.claude/kickflip/repos/owner/my_project', tool: 'Bash', action: 'run kickflip doctor --fix', detail: 'kickflip doctor --fix', rule: 'Bash(kickflip doctor --fix)', questions: null, at: prompt.at });
  assert.equal(row({ running, activity: null }).stalled, undefined, 'with no transcript found only the 15-minute limit applies');
  assert.deepEqual([row({ running, activity: null, prompt }).prompt?.id, row({ running, activity: null, prompt }).activity], ['p1', undefined], 'a prompt shows with no transcript found');
  assert.equal(row({ running, activity: { at: NOW - STALL_AFTER - 1, text: 'x' } }, { since: iso(NOW - 60_000) }).stalled, undefined, 'quiet counts from the start at the earliest');
  assert.equal(row({ running, activity: { at: NOW - STALL_AFTER, text: 'x' } }, {}, NOW - 6 * 60_000 + STARTING_WAIT).failed, true, 'the 15-minute limit stays the backstop');
  const landing = row({ running: new Map() }, { joined_at: iso(NOW) });
  assert.deepEqual([landing.step, landing.failed, landing.activity], ['landing', false, undefined], 'a joined start is past its session');
});

test("a start's signals are its session's liveness, its transcript's last step and its oldest pending prompt", () => {
  transcript('s-shop', [tool('Bash', { command: 'kickflip doctor' })], NOW - 1000);
  savePrompts({ prompts: { p2: { ...prompt, id: 'p2', at: iso(NOW) }, p1: prompt, p3: { ...prompt, id: 'p3', session: 'other' }, p4: { ...prompt, id: 'p4', at: iso(NOW - 9000), answer: { choice: 'allow' } } }, remembered: {} });
  const running = new Map();
  const s = startSignals(starting().starting.shop, { running });
  assert.deepEqual([s.running, s.activity, s.prompt.id], [running, { at: NOW - 1000, text: 'running kickflip doctor' }, 'p1']);
  assert.deepEqual(startSignals({ ...starting().starting.shop, joined_at: iso(NOW) }, { running }), {}, 'a joined start reads nothing');
});

test("each prompt a starting session raises goes in the hub's audit log with its tool and input, and a board's own prompt doesn't", () => {
  const manifest = { ...starting(), sites: { shop2: { owner: { session: 's-board' } } } };
  const input = { session_id: 's-shop', tool_name: 'Bash', tool_input: { command: 'kickflip doctor --fix' } };
  assert.equal(logStartPrompt(input, { manifest, now: new Date(NOW) }), 'shop');
  assert.equal(logStartPrompt({ ...input, session_id: 's-board' }, { manifest }), null);
  const [entry, ...more] = readAudit(hubAudit(), { now: new Date(NOW) });
  assert.deepEqual(more, []);
  assert.deepEqual([entry.call, entry.result, entry.reason, entry.inputs], ['start-prompt', 'asked', "/shop's starting session asked to run kickflip doctor --fix.",
    { route: 'shop', session: 's-shop', tool: 'Bash', input: { command: 'kickflip doctor --fix' } }]);
});

test('a started session may run kickflip doctor without a prompt, but not its --fix', () => {
  assert.deepEqual(JSON.parse(BG_SETTINGS).permissions, { allow: ['Bash(kickflip doctor)'], deny: ['Workflow'] });
});
