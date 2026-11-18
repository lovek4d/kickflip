import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const workflowDir = path.join(root, '.github', 'workflows');
const workflows = fs.readdirSync(workflowDir).filter((file) => file.endsWith('.yml'));

test('every Action a workflow uses is pinned to a full commit SHA', () => {
  for (const file of workflows) {
    const text = fs.readFileSync(path.join(workflowDir, file), 'utf8');
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1]);
    assert.ok(uses.length > 0, `${file} uses an Action`);
    for (const ref of uses) assert.match(ref, /@[0-9a-f]{40}$/, `${file}: ${ref}`);
  }
});

test('test.yml runs on push to main and on pull requests', () => {
  const text = fs.readFileSync(path.join(workflowDir, 'test.yml'), 'utf8');
  assert.match(text, /^\s+push:\s*\n\s+branches:\s*\[main\]/m);
  assert.match(text, /^\s+pull_request:/m);
});

test('SECURITY.md points reporters to GitHub private vulnerability reporting and states the threat model', () => {
  const text = fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8');
  assert.match(text, /private vulnerability reporting/i);
  assert.match(text, /## Threat model/);
});
