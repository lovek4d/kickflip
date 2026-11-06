// docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md
// The owner-step checks, run on each of the hub's checks (github.mjs checkGitHub): every card whose code landed (done
// or merged) and that waits on an owner step with a code check (shared/owner-check.mjs) gets its check run once,
// however many boards show it. A pass closes the card as the owner's Done does (board/store.mjs passOwnerCheck). A run
// that finds nothing yet does nothing. One that can't run counts in state.ownerChecks, and BROKEN_AFTER in a row mark
// the check broken (board/store.mjs breakOwnerCheck), which stops it and wakes the session to fix it.
import { WAVES } from './boards.mjs';
import { parseCheck, runCheck } from '../shared/owner-check.mjs';
import { passOwnerCheck, breakOwnerCheck } from '../board/store.mjs';

export const BROKEN_AFTER = 3;

// boards: boards.mjs listBoards. state: github-state.json, whose ownerChecks keeps each check's can't-run count by
// [wave file, wave, id, check] until it runs or breaks. failed: the check's failure list, for a write that failed.
export async function runOwnerChecks(boards, state, failed) {
  const counts = state.ownerChecks || {};
  const kept = {};
  const ran = new Set();
  for (const board of boards) {
    for (const { slug, wave } of board.waves) {
      for (const item of wave.items) {
        const check = item.owner_check;
        if (!check || check.broken || !item.owner_step || item.lane !== 'done') continue;
        const id = JSON.stringify([board.kind === 'waves' ? WAVES : board.dir, slug, item.id, check.check]);
        if (ran.has(id)) continue;
        ran.add(id);
        const key = `${slug}/${item.id}`;
        let result;
        try { result = await runCheck(parseCheck(check.check), { since: check.since }); } catch (e) {
          const count = (counts[id] || 0) + 1;
          if (count < BROKEN_AFTER) { kept[id] = count; continue; }
          try { await breakOwnerCheck(board.dir, key, check.check, e.message); }
          catch (err) { kept[id] = count; failed.push(`${board.route}: could not mark ${key}'s check broken (${err.message})`); }
          continue;
        }
        if (!result.passed) continue;
        try { await passOwnerCheck(board.dir, key, check.check, result.found); }
        catch (err) { failed.push(`${board.route}: could not close ${key} on its passing check (${err.message})`); }
      }
    }
  }
  state.ownerChecks = kept;
}
