import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGh, writeLimit, writeUser, calls } from './fake-gh.mjs';
import { PRIMARY, budgetOf, gh, ghSync, limitedUntil, limitWords } from './gh.mjs';
import { clock } from '../hub/schedule.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-gh-'));
const priorPath = process.env.PATH;
process.env.PATH = `${fakeGh(home)}:${priorPath}`;
after(() => { process.env.PATH = priorPath; fs.rmSync(home, { recursive: true, force: true }); });
writeUser(home, { login: 'love' });

const inAnHour = () => new Date(Math.floor(Date.now() / 1000 + 3600) * 1000).toISOString();
const spent = () => calls(home).filter((a) => !(a[0] === 'api' && a[1] === 'rate_limit')).length;
let n = 0;
const fresh = () => path.join(home, `gate-${++n}.json`);

test('a gh call spends GraphQL for pr, issue, repo and api graphql, REST core for other api calls, auth status and run, and nothing for a token or rate_limit', () => {
  assert.equal(budgetOf(['api', 'graphql', '-f', 'query=x']), 'graphql');
  assert.equal(budgetOf(['pr', 'merge', '8', '--repo', 'o/r', '--squash']), 'graphql');
  assert.equal(budgetOf(['issue', 'view', '3']), 'graphql');
  assert.equal(budgetOf(['repo', 'view', 'o/r']), 'graphql');
  assert.equal(budgetOf(['api', '--paginate', '--slurp', 'repos/o/r/collaborators']), 'core');
  assert.equal(budgetOf(['api', 'user', '--jq', '.login']), 'core');
  assert.equal(budgetOf(['run', 'list']), 'core');
  assert.equal(budgetOf(['auth', 'status']), 'core');
  assert.equal(budgetOf(['auth', 'token', '-u', 'octo']), null);
  assert.equal(budgetOf(['api', 'rate_limit']), null);
});

test('a call that hits the hourly limit records the spent budget, and later calls on it refuse at once with the reset time', async () => {
  const file = fresh();
  const reset = inAnHour();
  writeLimit(home, { core: reset });
  try {
    const hit = await gh(['api', 'user'], { file });
    assert.equal(hit.status, 1);
    assert.equal(hit.limited, reset);
    assert.equal(hit.stderr, `GitHub rate limited, resets at ${clock(new Date(reset))}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { [PRIMARY]: { core: reset } });
    const before = spent();
    const refused = await gh(['api', 'user'], { file });
    assert.deepEqual(refused, { status: 1, stdout: '', stderr: hit.stderr, limited: reset });
    assert.equal(spent(), before, 'a refused call never runs gh');
    assert.deepEqual(ghSync(['api', 'user'], { file }), refused, 'the synchronous form refuses the same');
    // GraphQL's budget isn't spent, so a GraphQL call still runs.
    const other = await gh(['api', 'graphql', '-f', 'query=query { viewer { login } }'], { file });
    assert.equal(other.limited, undefined);
    assert.equal(spent(), before + 1);
    assert.equal(limitedUntil({ file }), reset);
    assert.equal(limitedUntil({ file, budget: 'graphql' }), null);
  } finally { fs.rmSync(path.join(home, 'limit.json')); }
});

test('the gate holds only the account that ran out', async () => {
  const file = fresh();
  const reset = inAnHour();
  writeLimit(home, { graphql: reset });
  const hit = await gh(['pr', 'merge', '8', '--repo', 'o/r', '--squash'], { file, account: 'octo' });
  fs.rmSync(path.join(home, 'limit.json'));
  assert.equal(hit.stderr, `GitHub rate limited for octo, resets at ${clock(new Date(reset))}`);
  assert.equal(limitedUntil({ file, account: 'octo', budget: 'graphql' }), reset);
  assert.equal(limitedUntil({ file }), null);
  const before = spent();
  assert.equal((await gh(['pr', 'merge', '8', '--repo', 'o/r', '--squash'], { file })).status, 0, "gh's active account still merges");
  assert.equal(spent(), before + 1);
});

test('a reset that has passed lifts the gate', async () => {
  const file = fresh();
  fs.writeFileSync(file, JSON.stringify({ [PRIMARY]: { core: new Date(Date.now() - 1000).toISOString() } }));
  assert.equal(limitedUntil({ file }), null);
  const before = spent();
  assert.equal((await gh(['api', 'user'], { file })).status, 0);
  assert.equal(spent(), before + 1);
});

test("GitHub's secondary limit never holds the gate", async () => {
  const file = fresh();
  writeLimit(home, { secondary: true });
  try {
    const hit = await gh(['api', 'user'], { file });
    assert.equal(hit.status, 1);
    assert.equal(hit.limited, undefined);
    assert.match(hit.stderr, /secondary rate limit/);
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(path.join(home, 'limit.json')); }
});

test("the refusal's words name a later day's reset", () => {
  const now = new Date(2026, 10, 9, 23, 30);
  assert.equal(limitWords(new Date(2026, 10, 10, 0, 10).toISOString(), PRIMARY, now), 'GitHub rate limited, resets at 12:10am tomorrow');
});

test("every kickflip runner of gh goes through the gate: the repo runner as a board's ticket account, the owner step's check, and the doctor's commands", async (t) => {
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = priorHome; });
  const { runRepo } = await import('../hub/repos.mjs');
  const { runCheck, parseCheck } = await import('./owner-check.mjs');
  const { runCommand } = await import('./service.mjs');
  const reset = inAnHour();
  const words = `resets at ${clock(new Date(reset))}`;
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'gh-limit.json'), JSON.stringify({ [PRIMARY]: { core: reset }, octo: { graphql: reset } }));
  const before = spent();
  assert.equal((await runRepo('gh', ['issue', 'close', '3', '--repo', 'o/r'], { account: 'octo' })).stderr, `GitHub rate limited for octo, ${words}`);
  assert.equal((await runRepo('gh', ['api', 'user'])).stderr, `GitHub rate limited, ${words}`);
  await assert.rejects(runCheck(parseCheck('gh o/r actions/permissions enabled=true'), { since: '2026-11-09T00:00:00Z' }), { message: `gh api failed: GitHub rate limited, ${words}` });
  assert.equal(runCommand('gh', ['auth', 'status']).error, `GitHub rate limited, ${words}`);
  assert.equal(spent(), before, 'no refused call ran gh');
  assert.equal((await runRepo('gh', ['issue', 'close', '3', '--repo', 'o/r'])).status, 0, "gh's active account still closes the issue");
});
