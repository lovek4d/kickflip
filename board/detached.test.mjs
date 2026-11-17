// docs/adr/2026-11-16-1915-the-hub-status-opens-the-load-sheet-at-any-load-collapsed.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detachedIn } from './detached.mjs';

const WT = '/Users/me/.claude/kickflip/worktrees/T-9';
const NOW = Date.parse('2026-11-16T12:00:00Z');
const SINCE = NOW - 2 * 3600_000;
// ps -axo pid=,ppid=,uid=,etime=,command=
const PS = `
    1     0     0 10-00:00:00 /sbin/launchd
  500   400   501    50:00 claude -p You are the headless builder for T-9
  510   500   501    10:00 yes
 8652     1   501 01:30:00 yes
 8653     1   501 01:30:00 node ${WT}/board/server.mjs --port 4999
 8654     1   501 01:30:00 sleep 600
 8655     1   501 03:00:00 yes
 8656     1     0 01:00:00 yes
 8657     1   501 01:00:00 yes
 8658     1   501    00:30 /usr/bin/git gc --auto --detach
 9000     1   501    40:00 claude --resume abc -p You are the headless builder for T-9
 9001  9000   501    39:00 zsh
 9002  9001   501    00:01 node board.mjs builder done
`;
// lsof -a -d cwd -Fpn -p <pids>
const CWDS = { 8652: WT, 8653: '/tmp', 8654: `${WT}/board`, 8655: WT, 8657: '/Users/me', 8658: WT, 9000: WT };
const cwds = (pids) => pids.filter((p) => CWDS[p]).map((p) => `p${p}\nfcwd\nn${CWDS[p]}`).join('\n');

test("a build's detached processes are this user's, left to launchd, started since the build began and working in its worktree", () => {
  const asked = [];
  const found = detachedIn(WT, SINCE, { ps: () => PS, cwds: (pids) => { asked.push(pids); return cwds(pids); }, uid: 501, now: NOW, pid: 9002 });
  // 8652 and 8654 work in the worktree, 8653 names it; 510 still has its parent, 8655 began before the build, 8656 is
  // root's, 8657 works elsewhere, 8658 is git's own gc, which ends by itself, and 9000 is the finishing command's own resumed session.
  assert.deepEqual(found, [{ pid: 8652, command: 'yes' }, { pid: 8653, command: `node ${WT}/board/server.mjs --port 4999` }, { pid: 8654, command: 'sleep 600' }]);
  assert.deepEqual(asked, [[8652, 8653, 8654, 8657]], 'lsof reads only the candidates');
});

test('no answer from ps, or no candidate, finds none and asks lsof nothing', () => {
  const cwdsNever = () => assert.fail('lsof was asked');
  assert.deepEqual(detachedIn(WT, SINCE, { ps: () => null, cwds: cwdsNever, uid: 501, now: NOW }), []);
  assert.deepEqual(detachedIn(WT, NOW, { ps: () => PS, cwds: cwdsNever, uid: 501, now: NOW }), []);
});
