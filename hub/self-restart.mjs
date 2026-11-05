// The hub restarts itself once the code it runs is whole on disk
// (docs/adr/2026-11-06-0010-the-hub-restarts-itself-on-a-done-signal-from-whatever-brought-the-code.md). A clone's
// restarter() → {check(), restartNow()}: check() restarts when HEAD has moved since the hub started, no git operation is
// running in the clone, and the hub's code files match HEAD, so a pull or rebase in progress and hand edits never restart
// it. restartNow() is the npm side: the hub's own `kickflip update --no-restart` finished. Each restarts once per new code;
// a restart that fails logs why once and leaves the Hub row's Restart hub.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OPERATION_MARKERS = ['index.lock', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

// → {check(), restartNow()}. files: the hub's code files from root (boards.mjs hubCode); restart() → null | why it failed.
export function restarter({ root, files, restart, log = () => {}, git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }) }) {
  const clone = fs.existsSync(path.join(root, '.git'));
  let unreadable = false;
  // HEAD, or null when git can't say; that is logged once and the hub carries on without restarting itself.
  function head() {
    try { const sha = git('rev-parse', 'HEAD').trim(); unreadable = false; return sha; } catch (e) {
      if (!unreadable) log(`self-restart can't read HEAD: ${e.message.split('\n')[0]}`);
      unreadable = true;
      return null;
    }
  }
  const startedAt = clone ? head() : null;
  let attempted = null;

  function attempt(code, why) {
    if (attempted === code) return;
    attempted = code;
    log(`restarting the hub: ${why}`);
    const failure = restart();
    if (failure) log(`hub restart failed: ${failure}`);
  }

  const gitBusy = () => OPERATION_MARKERS.some((m) => fs.existsSync(path.join(root, '.git', m)));
  const filesMatchHead = () => {
    try { git('diff', '--quiet', 'HEAD', '--', ...files); return true; } catch { return false; }
  };

  function check() {
    if (!clone || gitBusy()) return;
    const now = head();
    if (now === null || startedAt === null || now === startedAt || !filesMatchHead()) return;
    attempt(now, `HEAD moved to ${now.slice(0, 7)} and the hub's files match it`);
  }

  function restartNow() {
    attempt(`npm-${Date.now()}`, 'kickflip update finished');
  }

  return { check, restartNow };
}
