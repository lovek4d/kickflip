import fs from 'node:fs';
import path from 'node:path';
import { PR_VIEW_FIELDS } from '../hub/pr-report.mjs';

const write = (dir, folder, n, value) => {
  const file = path.join(dir, folder, `${n}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
export const writePR = (dir, n, value) => write(dir, 'pr', n, value);
export const writeIssueComments = (dir, n, value) => write(dir, 'issue-comments', n, value);
export const writeReviewComments = (dir, n, value) => write(dir, 'review-comments', n, value);
export const writeReviews = (dir, n, value) => write(dir, 'reviews', n, value);
export const writeUser = (dir, value) => write(dir, '', 'user', value);
export const calls = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; }
};
export function prView({ head = 'abc1234567', failing = [], pending = 0, ...over } = {}) {
  return {
    state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', headRefOid: head,
    statusCheckRollup: [
      ...failing.map((name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'FAILURE' })),
      ...Array.from({ length: pending }, (_, i) => ({ __typename: 'CheckRun', name: `ci-${i}`, status: 'IN_PROGRESS', conclusion: '' })),
    ], ...over,
  };
}
export function fakeGh(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const fail = () => { console.error('no fixture for: ' + args.join(' ')); process.exit(1); };
let file;
let list = false;
if (args.length === 7 && args[0] === 'pr' && args[1] === 'view' && /^\\d+$/.test(args[2]) && args[3] === '--repo' && args[5] === '--json' && args[6] === ${JSON.stringify(PR_VIEW_FIELDS)}) file = path.join(dir, 'pr', args[2] + '.json');
else if (args.length === 2 && args[0] === 'api' && args[1] === 'user') file = path.join(dir, 'user.json');
else if (args.length === 4 && args[0] === 'api' && args[1] === '--paginate' && args[2] === '--slurp') {
  const match = /^repos\\/[^/]+\\/[^/]+\\/(issues|pulls)\\/(\\d+)\\/(comments\\?since=.+|reviews)$/.exec(args[3]);
  if (!match || (match[1] === 'issues' && match[3] === 'reviews')) process.exit(1);
  file = path.join(dir, match[3] === 'reviews' ? 'reviews' : match[1] === 'issues' ? 'issue-comments' : 'review-comments', match[2] + '.json');
  list = true;
} else process.exit(1);
let value;
try { value = fs.readFileSync(file, 'utf8'); } catch { if (!list) fail(); value = '[]'; }
if (list) {
  value = JSON.parse(value);
  if (value.fail) fail();
  const pages = [];
  for (let i = 0; i < value.length; i += 2) pages.push(value.slice(i, i + 2));
  console.log(JSON.stringify(pages));
} else {
  try { if (JSON.parse(value).fail) fail(); } catch {}
  console.log(value);
}
`, { mode: 0o755 });
  return bin;
}
