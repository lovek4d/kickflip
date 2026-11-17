// docs/adr/2026-11-16-0700-a-moments-rule-lives-in-its-waits-next-text.md: what the orchestrator does at a moment lives in
// that moment's wait, the Next its waits line prints, not in SKILL.md: these are the rules SKILL.md handed over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, orchestratorWaits } from './domain.mjs';

const at = (minute) => `2026-11-16T10:${String(minute).padStart(2, '0')}:00.000Z`;
const waits = ({ items, agents = {}, events = [], threads = {}, owner = {}, screening } = {}) => orchestratorWaits(buildBoard({ now: Date.parse(at(59)), owner, events, threads,
  working: {}, screening, files: [{ slug: 'w', agents, itemFile: { internal: true, items } }] }));
const card = (item = {}) => ({ id: 'A1', title: 'feat(board): one', created: at(0), lane: 'todo', ...item });
const wait = (kind, snapshot) => {
  const found = waits(snapshot).filter((w) => w.kind === kind);
  assert.equal(found.length, 1, kind);
  return found[0].next;
};

test("a staged task's wait lists the checks against the whole board, and asks for its size with ready", () => {
  const next = wait('staging', { items: [card({ phase: 'staging', staged_at: at(1) })] });
  assert.match(next, /^Judge the staged task against the whole board, not only its own notes: read its notes and thread;/);
  assert.match(next, /check that no open or merged task already covers it or overlaps its files, that the tasks it depends on or that should land first are linked \(item set --blocked-by\), that a related task's settled answers don't contradict it, that its size and model fit what its notes now ask, and that nothing it asks is left as a question for the owner/);
  assert.match(next, /item set --phase ready --size <small\|large> --text "<what you checked>"/);
});

// docs/adr/2026-11-17-0543-a-quick-ask-is-triaged-into-staging.md
test("an Implement ask's intake wait asks for the same checks a staged task gets before ready, and to check its related cards, not hunt", () => {
  const next = wait('intake', {
    events: [{ id: 'a1', ts: at(1), kind: 'ask', data: { text: 'Fix the header jumping on scroll', quick: true }, reply: null }],
    items: [card({ id: 'T-1', title: 'Fix the header jumping on scroll', from_ask: 'a1' }), card({ id: 'T-2', title: 'feat(board): the header stays pinned on scroll', phase: 'discussing' })],
  });
  assert.match(next, /the owner tapped Implement, so item triage w\/T-1 .* stages it, taking no --phase\. Then judge it as any staged task: item notes, then the checks a staged task gets \(check that no open or merged task already covers it .*\), then item set w\/T-1 --phase ready --text "<what you checked>" at any size/);
  assert.match(next, /Likely related \(check them, don't hunt\): w\/T-2 /);
});

test("a builder's ask names the answer and defer commands with its id, and never the owner", () => {
  const ask = { ts: at(5), who: 'Claude Opus builder', kind: 'builder-ask', ask: 'ask1', agent: 'main', text: 'Which file?' };
  const next = wait('ask', { items: [card({ lane: 'progress' })], agents: { A1: { main: { kind: 'claude', started: at(1) } } }, threads: { 'w/A1': [ask] } });
  assert.match(next, /^Answer the builder's ask: Which file\?: builder answer w\/A1 ask1 --text "<answer>" from the task's notes, thread and the owner's words, or builder defer w\/A1 ask1 --text "<what to carry on with>" when you aren't confident or the owner's opinion is wanted; never ask the owner mid-build$/);
});

test("a hand-back's calls wait says how to check, send back and verify them", () => {
  const handed = { A1: { main: { kind: 'claude', started: at(1), done: at(5), handed_back: at(5), calls: [{ at: at(3), text: 'x' }] } } };
  const next = wait('calls', { items: [card({ lane: 'progress', next: "Verify the builder's judgment calls" })], agents: handed });
  assert.match(next, /^Verify the builder's judgment calls: read each with builder calls w\/A1 against the task's notes, the owner's words and the other tasks;/);
  assert.match(next, /builder resume w\/A1 --text "<what to change>"/);
  assert.match(next, /to the owner as a question on the task/);
  assert.match(next, /then builder verified w\/A1 --note "<what you checked>"; never redo it yourself or with an Agent$/);
});

test("the owner's word last on a card waits to be answered in the thread or acted on", () => {
  const said = { id: 'm5', ts: at(5), kind: 'item-message', data: { key: 'w/A1', text: 'One more thing' }, reply: null };
  const next = wait('reply', { items: [card({ phase: 'discussing', waits_on_owner: { on: 'implement', at: at(2), phase: 'discussing', lane: 'todo' } })], events: [said] });
  assert.equal(next, "Act on the owner's reply: answer it in the thread, or act and let the action's line answer it");
});

test('a card owing nobody names the Implement ask command', () => {
  assert.equal(wait('limbo', { items: [card({ phase: 'discussing' })] }), 'A1 owes nobody anything: ask Implement (reply w/A1 --implement), ask questions, or close it');
});

test('an unblock past Todo says a thread line ends its wait', () => {
  assert.equal(wait('unblocked', { items: [card({ lane: 'review', unblocked_at: at(5) })] }), 'Its block ended: act on what it waited for, or set its Next; a thread line ends the wait');
});

test("a refused build's wait says to fix it and start it, or say why it waits", () => {
  const refused = { 'w/A1': [{ ts: at(5), who: 'claude', kind: 'hub', line: 'build-refused', text: "Couldn't start implementing: no repo" }] };
  assert.equal(wait('refused', { items: [card({ phase: 'ready' })], threads: refused }), "Couldn't start implementing: no repo: fix what refused the build and start it, or say on the task why it waits");
});

test("a grill's screen wait settles only what the board answers, never the prototype question", () => {
  const next = wait('screen', { items: [card({ state: 'grilling' })], screening: { 'w/A1': { since: at(5), ids: ['q1'] } } });
  assert.match(next, /question settle <id> --note for each the task's notes and thread, merged code or another task already answer, never the prototype question, then question publish w\/A1/);
});

test('a prototype brief wait says each prototype, and each owner request, is a round of its own', () => {
  const next = wait('brief', { items: [card({ phase: 'prototyping', briefs: [{ kind: 'prototype', at: at(5), ask: { text: 'Show me' } }] })] });
  assert.match(next, /; name each prototype to draw as its own round, and each owner request the task owes \(a Prototype tap, a no-pick answer\) as a round of its own$/);
});
