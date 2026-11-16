// The hub restarts itself once the code it runs is whole on disk
// (docs/adr/2026-11-06-0010-the-hub-restarts-itself-on-a-done-signal-from-whatever-brought-the-code.md). A clone's
// restarter() → {check(), restartNow()}: check() restarts when HEAD has moved since the hub started, no git operation is
// running in the clone, and the hub's code files match HEAD, so a pull or rebase in progress and hand edits never restart
// it. restartNow() is the npm side: the hub's own `kickflip update --no-restart` finished. Either waits while idle() names
// what holds it, saying so once per reason, and each check restarts once nothing does
// (docs/adr/2026-11-16-1500-new-code-restarts-on-a-busy-board-once-no-land-is-landing.md). Each
// restarts once per new code; a restart that fails logs why once and leaves the Hub row's Restart hub.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OPERATION_MARKERS = ['index.lock', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

// → {check(), restartNow()}, each resolving once it has restarted or not. files: the hub's code files from root
// (boards.mjs hubCode); restart() → null | why it failed; idle() → what holds a restart, or null.
export function restarter({ root, files, restart, idle = async () => null, log = () => {}, git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }) }) {
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

  // The new code a restart is due for, {code, why}, or null.
  let installed = null;
  function due() {
    if (installed) return installed;
    if (!clone || gitBusy()) return null;
    const now = head();
    if (now === null || startedAt === null || now === startedAt || !filesMatchHead()) return null;
    return { code: now, why: `HEAD moved to ${now.slice(0, 7)} and the hub's files match it` };
  }

  let waitedFor = null;
  async function check() {
    const next = due();
    if (!next || attempted === next.code) return;
    const held = await idle();
    if (held) {
      if (waitedFor !== held) log(`new hub code waits to restart, since ${held}`);
      waitedFor = held;
      return;
    }
    waitedFor = null;
    attempt(next.code, next.why);
  }

  function restartNow() {
    installed = { code: `npm-${Date.now()}`, why: 'kickflip update finished' };
    return check();
  }

  return { check, restartNow };
}
