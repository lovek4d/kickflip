// docs/adr/2026-11-18-0200-a-release-card-waits-in-in-review-until-its-release-is-published.md
// The release watch, run on each of the hub's checks (github.mjs checkGitHub): every landed card holding a release not
// yet published (board/cards.mjs keeps it from the land) gets its tag's runs read on its board's GitHub repo, once
// however many boards show it. A run still going is publishing, and none yet is publishing too, or untagged on a card whose land left the tag to the owner (Run release script off) until a run shows. A failed run is the card's failure, with
// the run's link and its first failing test (firstFailingTest). Every run passed, and the version on npm when the
// release names a package, is published, which asks the owner for Done. board/cards.mjs markRelease writes each change.
// A gh or npm that can't run leaves the card as it is and says so in failed.
import { wavesDir } from './boards.mjs';
import { execArgv, runCheck } from '../shared/owner-check.mjs';
import { markRelease } from '../board/cards.mjs';

const RUN_FIELDS = 'databaseId,workflowName,status,conclusion,url,createdAt';
const PASSED = ['success', 'skipped', 'neutral'];

// A failed run's --log-failed text → "<test> (<file>:<line>)", its first `not ok` line under node --test's TAP report
// with the location that follows it, the file read from the checkout; null when no test failed.
export function firstFailingTest(log) {
  const lines = String(log).split('\n').map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+ /, ''));
  const at = lines.findIndex((l) => /^\s*not ok \d+ - /.test(l));
  if (at < 0) return null;
  const name = lines[at].replace(/^\s*not ok \d+ - /, '').trim();
  const block = lines.slice(at + 1, at + 12);
  const end = block.findIndex((l) => /^\s*\.\.\.$/.test(l));
  const location = (end < 0 ? block : block.slice(0, end)).map((l) => /^\s*location: '(.+):(\d+):\d+'$/.exec(l)).find(Boolean);
  const file = location?.[1].replace(/^.*?\/work\/[^/]+\/[^/]+\//, '');
  return location ? `${name} (${file}:${location[2]})` : name;
}

// The newest run of each workflow the tag started → {state, url, failure?, run} from them.
async function readRuns(repo, release, exec) {
  const runs = JSON.parse(await exec('gh', ['run', 'list', '--repo', repo, '--branch', release.tag, '--event', 'push', '--limit', '20', '--json', RUN_FIELDS]) || '[]');
  const newest = new Map();
  for (const r of runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) newest.set(r.workflowName, r);
  const latest = [...newest.values()];
  if (!latest.length || latest.some((r) => r.status !== 'completed')) return { state: 'publishing', url: latest.find((r) => r.status !== 'completed')?.url };
  const failed = latest.find((r) => !PASSED.includes(r.conclusion));
  if (failed) return { state: 'failed', url: failed.url, run: failed };
  return { state: 'passed', url: latest.at(-1).url };
}

// boards: boards.mjs listBoards. failed: the check's failure list. exec: execArgv, or a test's stand-in.
export async function runReleaseWatch(boards, failed, { exec = execArgv } = {}) {
  const read = new Set();
  for (const board of boards) {
    for (const { slug, itemFile } of board.files) {
      const repo = board.github || itemFile.repo;
      for (const item of itemFile.items) {
        const release = item.release;
        if (!release || release.state === 'published' || item.lane !== 'done' || !repo) continue;
        const id = JSON.stringify([board.kind === 'waves' ? wavesDir() : board.dir, slug, item.id, release.version]);
        if (read.has(id)) continue;
        read.add(id);
        const key = `${slug}/${item.id}`;
        let found;
        try {
          const runs = await readRuns(repo, release, exec);
          if (runs.state === 'failed') {
            // The log is read once per failed run: a card already showing this run's failure keeps it.
            const failure = release.state === 'failed' && release.url === runs.url ? release.failure ?? null
              : firstFailingTest(await exec('gh', ['run', 'view', String(runs.run.databaseId), '--repo', repo, '--log-failed']));
            found = { state: 'failed', url: runs.url, failure };
          } else if (runs.state === 'publishing') found = { state: release.state === 'untagged' && !runs.url ? 'untagged' : 'publishing', url: runs.url ?? release.url };
          else if (!release.pkg) found = { state: 'published', url: runs.url, words: 'its release run passed' };
          else {
            const npm = await runCheck({ name: 'npm', args: [release.pkg, release.version] }, { exec });
            found = npm.passed ? { state: 'published', url: runs.url, words: `its release run passed and ${release.pkg}@${release.version} is on npm` }
              : { state: 'publishing', url: runs.url };
          }
        } catch (e) {
          failed.push(`${board.route}: could not read ${key}'s release ${release.version}: ${e.message}`);
          continue;
        }
        try { await markRelease(board.dir, key, release.version, found); }
        catch (err) { failed.push(`${board.route}: could not mark ${key}'s release ${release.version} ${found.state} (${err.message})`); }
      }
    }
  }
}
