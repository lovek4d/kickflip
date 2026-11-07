# An unanswered triage holds only its cards until quiet hours end

Amends [triage runs once overnight on cards waiting on your answers](2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md), whose "the pull waits for the session's reply" held every card for as long as the reply was missing.

The owner, on #385 (11/06): "Why did this not immediately go to in progress upon being marked as?" The 5:17 AM triage had no reply, so `runAuto` stopped before the pull all morning. The reply is the orchestrator session's, not the owner's, and the watcher's line read like a notice for the owner.

- **What it holds.** Only the cards the triage names (`pullOf` `hold`), since those wait on open questions and the pull can't take them anyway. Every other ready card is pulled as usual.
- **When it stops.** At the end of quiet hours: a hold applies only while `quietAt` the hub's quiet hours is true.
- **Shown.** In the audit log only (`pull` `held`), not on the board.
- **An orchestrator wait.** Until a reply is recorded, the triage is a wait of kind `triage` in `data/orchestrator-waits.json` (`waits triage <date> <event id> since …: Run the overnight triage and reply`), so the watcher lists it on every wake and re-wakes the session like any other wait. It sends no push to the owner.
- **Watcher line.** "Overnight triage <date> asks Claude to reply: N cards wait on open questions; run the triage, then board.mjs reply <id>".
- A new triage still doesn't go out while the last is unanswered.

The wider audit of waking and waits is #425.
