// SKILL.md is what every board's orchestrator answers from, so its ADR links must name decisions that exist, and the
// features it is asked about must be in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');

test('every ADR SKILL.md links is a file in docs/adr', () => {
  const linked = [...new Set([...skill.matchAll(/\]\((docs\/adr\/[^)#]+\.md)/g)].map((m) => m[1]))];
  assert.ok(linked.length > 0);
  assert.deepEqual(linked.filter((p) => !fs.existsSync(path.join(root, p))), []);
});

// docs/adr/2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md
test('SKILL.md says how an @kickflip in a 1:1 Slack DM is filed, and what it needs', () => {
  assert.ok(skill.includes('](docs/adr/2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md)'));
  for (const words of ['search:read', '1:1', 'no backfill', 'group DM']) assert.ok(skill.includes(words), words);
});
