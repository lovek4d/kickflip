// docs/adr/2026-11-16-1000-a-blocked-card-owes-the-owner-nothing.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildBoard, orchestratorWaits, waitsStep } from './domain.mjs';

const at = (minute) => `2026-11-16T10:${String(minute).padStart(2, '0')}:00.000Z`;
const built = (items) => buildBoard({ now: Date.parse(at(59)), owner: {}, events: [], threads: {}, working: {}, prs: {},
  files: [{ slug: 'w', agents: {}, itemFile: { internal: true, items } }] });
const card = (item = {}) => ({ id: 'A1', title: 'One', created: at(0), phase: 'discussing', lane: 'todo', ...item });
const find = (items) => built(items).items.find((i) => i.key === 'w/A1');
const mark = { on: 'implement', at: at(5), phase: 'discussing', lane: 'todo' };
const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');

test('a blocked Todo card owing Implement or Done keeps its action', () => {
  const blocker = { id: 'B1', title: 'Blocker', created: at(0), lane: 'progress', phase: 'ready' };
  const closeMark = { on: 'close', at: at(5) };
  const cases = [['blocked until', { blocked_until: '2026-12-01' }], ["the owner's block", { held: true }], ['unfinished dep', { deps: ['B1'] }]];
  for (const [name, block] of cases) {
    assert.equal(find([card({ waits_on_owner: mark, ...block }), blocker]).action?.label, 'Tap Implement', name);
    assert.equal(find([card({ waits_on_owner: closeMark, ...block }), blocker]).action?.label, 'Tap Done', `${name}, a close mark`);
    assert.equal(find([card({ ...block }), blocker]).action, null, `${name}, no mark`);
  }
});

test('a staged blocked card keeps its staging wait', () => {
  const kinds = (items) => orchestratorWaits(built(items)).map((w) => w.kind);
  assert.deepEqual(kinds([card({ phase: 'staging', staged_at: at(3) })]), ['staging']);
  assert.deepEqual(kinds([card({ phase: 'staging', staged_at: at(3), held: true, pick_up_at: '2026-11-19T00:00:00Z' })]), ['staging']);
});

// docs/adr/2026-11-17-2028-a-wait-a-block-held-is-owed-from-the-blocks-end.md
const waitsOf = (item, { threads = {}, events = [], working = {} } = {}) => orchestratorWaits(buildBoard({ now: Date.parse(at(59)), owner: {}, events, threads,
  working, prs: {}, files: [{ slug: 'w', agents: {}, itemFile: { internal: true, items: [card(item)] } }] }));
const held = [['staging', { phase: 'staging', staged_at: at(3) }], ['limbo', { phase: 'discussing' }], ['unblocked', { lane: 'review', unblocked_at: at(3) }]];

test('a limbo or past-Todo unblocked wait drops while its card is blocked', () => {
  for (const [kind, item] of held.filter(([kind]) => kind !== 'staging')) {
    assert.equal(waitsOf(item).some((w) => w.kind === kind), true, kind);
    assert.equal(waitsOf({ ...item, blocked_until: 'the API ships' }).some((w) => w.kind === kind), false, `${kind} blocked`);
  }
});

test('a staging or limbo wait picked up, blocked and unblocked comes back unpicked, owed from the unblock, and wakes the orchestrator', () => {
  const pickup = { 'w/A1': [{ ts: at(4), who: 'claude', text: 'Picked up.' }] };
  for (const [kind, item] of held.slice(0, 2)) {
    const before = waitsOf(item, { threads: pickup }).filter((w) => w.kind === kind);
    assert.equal(before[0].picked, at(4), kind);
    const after = waitsOf({ ...item, unblocked_at: at(30) }, { threads: pickup }).filter((w) => w.kind === kind);
    assert.deepEqual([after[0].since, after[0].picked], [at(30), null], kind);
    assert.deepEqual(waitsStep(before, after, new Date(at(31))).added, ['w/A1'], `${kind} wakes`);
    const again = waitsOf({ ...item, unblocked_at: at(30) }, { threads: { 'w/A1': [...pickup['w/A1'], { ts: at(32), who: 'claude', text: 'On it.' }] } });
    assert.equal(again.find((w) => w.kind === kind).picked, at(32), `${kind}: a pickup after the unblock stands`);
    assert.equal(waitsOf({ ...item, unblocked_at: '2026-11-16T09:00:00.000Z' }, { threads: pickup }).find((w) => w.kind === kind).since, item.staged_at || at(0), `${kind}: an unblock before the wait changes nothing`);
  }
});

test("a working mark from before the unblock doesn't pick up the wait a block held", () => {
  const events = [{ id: 'e1', ts: at(4), kind: 'card-unblocked', data: { key: 'w/A1' }, reply: null }];
  const item = { phase: 'staging', staged_at: at(3) };
  assert.equal(waitsOf(item, { events, working: { e1: at(5) } }).find((w) => w.kind === 'staging').picked, at(5));
  assert.equal(waitsOf({ ...item, unblocked_at: at(30) }, { events, working: { e1: at(5) } }).find((w) => w.kind === 'staging').picked, null);
});

test("the owner's block words carry the notice colour", () => {
  assert.match(css, /\.card-owner-block \{ color: var\(--color-notice\); \}/);
});

test('a blocked In Review card has no action, and its Merge button reads disabled with the blocked words',  () => {
  const clean = { state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', checks: { state: 'pass' }, reviews: {} };
  const b = buildBoard({ now: Date.parse(at(59)), owner: {}, events: [], threads: {}, working: {}, branch: 'trunk', prs: { 'o/r#7': clean },
    files: [{ slug: 'w', agents: {}, itemFile: { repo: 'o/r', items: [{ id: 'A1', title: 'One', created: at(0), pr: 7, blocked_until: 'the API ships' }] } }] });
  const c = b.items.find((i) => i.key === 'w/A1');
  assert.deepEqual([c.lane, c.action, c.mergeBlocked], ['review', null, 'Blocked until the API ships']);
  // ui.test.mjs: mergeBlocked draws the disabled Merge button with these words as its tooltip.
});
