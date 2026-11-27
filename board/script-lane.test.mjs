// docs/adr/2026-11-19-0700-a-script-card-leaves-its-task-in-its-lane.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, ACTION_KIND } from './domain.mjs';

const at = (m) => `2026-11-17T10:${String(m).padStart(2, '0')}:00.000Z`;
const offer = { ts: at(5), who: 'claude', text: 'Stops it.', script: { id: 's1', body: 'echo hi', sha: 'x', host: 'h', user: 'u' } };
const cardIn = (lane) => buildBoard({ now: Date.parse(at(59)), owner: {}, events: [], threads: { 'w/A1': [offer] }, working: {},
  files: [{ slug: 'w', agents: {}, itemFile: { internal: true, items: [{ id: 'A1', title: 'One', lane, created: at(0), ...(lane === 'progress' ? { next: 'Soon' } : {}) }] } }] })
  .items.find((i) => i.key === 'w/A1');

test('a waiting script marks its task as Action needed, a Done one too, and leaves it in the lane it was in', () => {
  for (const lane of ['todo', 'progress', 'done']) {
    const card = cardIn(lane);
    assert.equal(card.action.kind, ACTION_KIND.script, lane);
    assert.equal(card.lane, lane, lane);
  }
});
