// docs/adr/2026-11-17-0300-a-finished-script-run-waits-on-the-orchestrator.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, orchestratorWaits } from './domain.mjs';

const at = (m) => `2026-11-17T10:${String(m).padStart(2, '0')}:00.000Z`;
const waits = ({ events = [], threads = {} }) => orchestratorWaits(buildBoard({ now: Date.parse(at(59)), owner: {}, events, threads, working: {},
  files: [{ slug: 'w', agents: {}, itemFile: { internal: true, items: [{ id: 'A1', title: 'One', lane: 'progress', created: at(0), next: 'Owner Done' }] } }] }))
  .map(({ kind, since }) => [kind, since]).filter(([kind]) => kind === 'script');
const ev = (m, kind) => ({ id: `e${m}`, ts: at(m), kind, data: { key: 'w/A1', id: 's1', exit: 0 } });

test('a script run or decline that ends waits on the orchestrator until it writes on the card', () => {
  assert.deepEqual(waits({ events: [ev(1, 'script-run')] }), [], 'a run under way owes nothing');
  assert.deepEqual(waits({ events: [ev(1, 'script-run'), ev(2, 'script-result')] }), [['script', at(2)]]);
  assert.deepEqual(waits({ events: [ev(2, 'script-decline')] }), [['script', at(2)]]);
  const line = { ts: at(5), who: 'claude', text: 'Saw it.' };
  assert.deepEqual(waits({ events: [ev(2, 'script-result')], threads: { 'w/A1': [line] } }), []);
});
