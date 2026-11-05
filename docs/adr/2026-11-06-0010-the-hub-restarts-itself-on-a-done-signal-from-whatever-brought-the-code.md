# The hub restarts itself on a done signal from whatever brought the code

Supersedes the Restart tap after a pull in [the hub pulls a new version itself and offers Restart](2026-11-05-2200-the-hub-pulls-a-new-version-itself-and-offers-restart.md), and the rule that only a land or the Restart hub tap restarts the hub in [the hub restarts itself from its stale-code notice](2026-11-03-1638-the-hub-restarts-itself-from-its-stale-code-notice.md). Lands still restart it as they did, and the amber Hub row's Restart hub stays for hand edits and for a restart that failed.

The owner answered "restart as soon as the hub's code changes, npm upgrades included", and asked for a steadier measure than the 2-second check alone: "a done signal from whatever brought the code, with no timer".

- **npm.** When the hub's own `kickflip update --no-restart` exits 0 (`hub/upgrade.mjs` `pulled`), the hub restarts itself through `shared/service.mjs` (`hub/self-restart.mjs` `restartNow`). The sidebar reads Updating until then; the Updated · Restart row now shows only if that restart failed.
- **Clone.** On the existing 2-second reconcile (`check`), the hub restarts when HEAD has moved since it started, no git operation is running (`.git/index.lock`, `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`), and the hub's code files match HEAD (`git diff --quiet HEAD`). The interval is only how often the signal is read; the signal is git being idle with the files whole, so a half-done pull is never loaded. Uncommitted hand edits never restart it.
- **Once per new code.** A restart that fails (a hub run by hand with no service) logs why once and is not tried again for that HEAD or that update.
- No builder wait, for the reason in the 2200 ADR: builders, landers and planners are detached.
- This board's main-pulled restart rule is retired; SKILL.md's `link hub` line says the hub restarts itself and keeps the command for a failed restart.
