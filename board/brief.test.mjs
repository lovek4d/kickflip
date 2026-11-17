// docs/adr/2026-11-17-2330-an-idle-orchestrator-restarts-fresh-once-its-prompt-cache-lapses.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefLines, memoryFile } from './brief.mjs';

const NOW = new Date('2026-11-17T23:30:00.000Z');
const card = (key, extra) => ({ key, ref: key.split('/')[1], title: `Title of ${key}`, lane: 'todo', kind: 'work', ...extra });

test('the brief names the cards in progress with their builder state, the cards on the owner, the last day of owner messages and memory', () => {
  const cards = [
    card('hub/T-1', { ref: '#11', lane: 'progress', waitsOn: 'builder', builder: { words: 'Building · the tests', alive: true } }),
    card('hub/T-2', { ref: '#12', lane: 'progress', waitsOn: 'checking', orchestrator: { kind: 'calls' } }),
    card('hub/T-3', { ref: '#13', lane: 'progress', waitsOn: 'builder', builder: { words: 'Reading · notes', stale: true } }),
    card('hub/T-4', { waitsOn: 'owner', action: { kind: 'questions', label: 'Answer 2 questions' } }),
    card('hub/T-5', { waitsOn: 'orchestrator' }),
  ];
  const events = [
    { ts: '2026-11-16T22:00:00.000Z', kind: 'item-message', data: { key: 'hub/T-4', text: 'too old' } },
    { ts: '2026-11-17T20:00:00.000Z', kind: 'item-message', data: { key: 'hub/T-4', text: 'make it blue' } },
    { ts: '2026-11-17T21:00:00.000Z', kind: 'ask', id: 'e1', data: { text: 'a new idea' } },
    { ts: '2026-11-17T21:05:00.000Z', kind: 'ask', id: 'e2', data: { text: 'filed by the orchestrator', asked: { by: 'orchestrator' } } },
    { ts: '2026-11-17T21:06:00.000Z', kind: 'ask', id: 'e3', data: { text: 'from another board', from: { route: 'ios' } } },
    { ts: '2026-11-17T22:00:00.000Z', kind: 'owner-answer', data: { id: 't4-shape', question: 'Which shape?', label: 'Round', note: 'smaller' } },
    { ts: '2026-11-17T22:10:00.000Z', kind: 'card-done', data: { key: 'hub/T-9' } },
  ];
  assert.deepEqual(briefLines({ route: 'hub', cards, events, memory: { file: '/m/MEMORY.md', exists: true }, now: NOW }), [
    'Board brief for /hub at 2026-11-17T23:30:00.000Z. The watcher\'s first wake prints the open waits.',
    'In Progress:',
    '  #11 hub/T-1 Title of hub/T-1: Building · the tests',
    '  #12 hub/T-2 Title of hub/T-2: handed back with judgment calls to verify',
    '  #13 hub/T-3 Title of hub/T-3: Reading · notes (stale)',
    'Waiting on the owner:',
    '  T-4 hub/T-4 Title of hub/T-4: Answer 2 questions',
    'Owner messages, last 24 h:',
    '  2026-11-17T20:00:00.000Z hub/T-4: make it blue',
    '  2026-11-17T21:00:00.000Z ask e1: a new idea',
    '  2026-11-17T22:00:00.000Z answer t4-shape: Which shape? → Round (smaller)',
    'Memory: /m/MEMORY.md',
    'Anything you needed and could not find here or on the board is a board gap: file it.',
  ]);
});

test('an empty board says none under each heading, and a missing memory file says so', () => {
  assert.deepEqual(briefLines({ route: 'b', cards: [], events: [], memory: { file: '/m/MEMORY.md', exists: false }, now: NOW }).slice(1, 8), [
    'In Progress:', '  none', 'Waiting on the owner:', '  none', 'Owner messages, last 24 h:', '  none', 'Memory: /m/MEMORY.md (none yet)',
  ]);
});

test("memory sits under Claude Code's project folder for the session's repo, each character but a letter or digit a dash", () => {
  assert.equal(memoryFile('/Users/me/dev/kick.flip', { home: '/h', real: (p) => p }), '/h/.claude/projects/-Users-me-dev-kick-flip/memory/MEMORY.md');
});
