// docs/adr/2026-11-16-1000-a-blocked-card-owes-the-owner-nothing.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildBoard, orchestratorWaits } from './domain.mjs';

const at = (minute) => `2026-11-16T10:${String(minute).padStart(2, '0')}:00.000Z`;
const built = (items) => buildBoard({ now: Date.parse(at(59)), owner: {}, events: [], threads: {}, working: {}, prs: {},
  files: [{ slug: 'w', agents: {}, itemFile: { internal: true, items } }] });
const card = (item = {}) => ({ id: 'A1', title: 'One', created: at(0), phase: 'discussing', lane: 'todo', ...item });
const find = (items) => built(items).items.find((i) => i.key === 'w/A1');
const mark = { on: 'implement', at: at(5), phase: 'discussing', lane: 'todo' };
const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');

test('a blocked Todo card owing Implement has no action; unblocked it reads Tap Implement', () => {
  assert.equal(find([card({ waits_on_owner: mark })]).action?.label, 'Tap Implement');
  assert.equal(find([card({ waits_on_owner: mark, blocked_until: '2026-12-01' })]).action, null, 'blocked until');
  assert.equal(find([card({ waits_on_owner: mark, held: true })]).action, null, "the owner's block");
  const blocker = { id: 'B1', title: 'Blocker', created: at(0), lane: 'progress', phase: 'ready' };
  assert.equal(find([card({ waits_on_owner: mark, deps: ['B1'] }), blocker]).action, null, 'unfinished dep');
  assert.equal(find([card({ phase: 'discussing', lane: 'todo', waits_on_owner: { on: 'close', at: at(5) }, held: true })]).action, null, 'a close mark');
});

test('a staged blocked card has no staging wait, and one unblocked has', () => {
  const kinds = (items) => orchestratorWaits(built(items)).map((w) => w.kind);
  assert.deepEqual(kinds([card({ phase: 'staging', staged_at: at(3) })]), ['staging']);
  assert.equal(kinds([card({ phase: 'staging', staged_at: at(3), held: true, pick_up_at: '2026-11-19T00:00:00Z' })]).includes('staging'), false);
});

test('a staging wait that comes back at its card unblocking is unpicked, though picked up before the block', () => {
  const staging = { phase: 'staging', staged_at: at(3) };
  const reply = { ts: at(4), who: 'claude', text: 'Picked up.' };
  const picked = (item, threads) => orchestratorWaits(buildBoard({ now: Date.parse(at(59)), owner: {}, events: [], threads, working: {}, prs: {},
    files: [{ slug: 'w', agents: {}, itemFile: { internal: true, items: [card({ ...staging, ...item })] } }] })).find((w) => w.kind === 'staging').picked;
  assert.equal(picked({}, { 'w/A1': [reply] }), at(4));
  assert.equal(picked({ unblocked_at: at(30) }, { 'w/A1': [reply] }), null, 'the pickup is older than the unblock');
  assert.equal(picked({ unblocked_at: at(2) }, { 'w/A1': [reply] }), at(4), 'a pickup after the unblock stands');
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
