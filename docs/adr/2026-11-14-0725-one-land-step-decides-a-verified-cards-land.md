# One land step decides a verified card's land

On the night of 11/13, five verified cards sat In Progress for 2-3 hours. The host was busy, so each lander's `builder start` refused it ("Work is held: the host is busy") and the lander exited. Nothing relaunched it. launchLanders reset a dead lander only when its entry was marked `resumed`, and the `kept[key].verified !== c.verified` filter dropped the card on every later pass. Every watcher wake still printed the card's Next, "A lander relaunches to land the verified build". relaunchLander had written that line, apart from the launcher's own decision. T-265 hit a second gap. Its lander did start, then died with its record open. Its `builder start` had kept no verification on the new record (only unverified calls carried over), so the hand-back that followed left the card unverified and landable never saw it again.

Three places each decided a checked card's land: launchLanders (pids, `resumed`/`fresh` marks, the launch gate), store.mjs relaunchLander, and the waits line's text. Each way a lander can end (refused on a busy host, died, handed back unlanded, resumed but never took the land up) was a special case in one of them. The gaps between them were dead ends.

## Decision

`domain.mjs landStep({verified, entry, alive, held, limited})` gives a verified card's land its one next step:

- **running**: the lander launched for this verification lives.
- **launch**: no lander has gone for this verification, or one exited without landing for the first time. The first launch resumes the card's builder (headless.mjs landByBuilder). A relaunch is a fresh lander.
- **held**: a launch would be held now (shared/usage-gate.mjs `launchHeldWords`: a pause, a busy host, the usage line, or a start near the line). The card stays due and launches once the hold clears.
- **fault**: a relaunched lander exited without landing too. T-119's rule: relaunch once, then fault.

There are no other states, so a verified card can't sit checking with no process and no wait.

- **One decision, three readers.** launchLanders acts on the step. The card's status line prints its words ("Landing held: host busy" in grey, the fault in red). The orchestrator's waits line uses the same step as its Next. A fault is a `stale` wait, so neither line can promise a launch the server won't make.
- **What landers.json keeps.** Each `data/landers.json` entry is now `{verified, pid, log, relaunched, handedBack?, limited?}`, with no `resumed`/`fresh` marks. `relaunched` counts the launches after the first for that verification, and a new verification starts again at 0. A run whose log ends on the usage limit spends no relaunch (hub/usage.mjs runLimit). `limited` is kept once seen, because the limit's reset clears what runLimit reads. On a fault the server posts `exited-twice` (the line names the run) once and marks the entry `handedBack`.
- **A lander keeps the verification it lands.** A `builder start --label Lander` over a verified record copies `verified` onto the new record. A lander that stops partway is then handed back still verified (relaunchLander now only closes the record), and its land step counts on from its entry.
- **The dead-lander check reads the lander's own record.** It acts only on a card whose open record is labelled Lander. A dead entry on a card that some other build has opened since is dropped, not handed back.
- **`board.mjs lander <card>` restarts a land.** It hands back an open lander record and drops the card's entry, so the next pass launches the land as a verification's first, with its relaunch to spend again. It works on a faulted card, which has no open record.
- **A rebase run follows the same rule.** One whose process has gone with its record open takes landStep's step for its conflict. It is relaunched once as a fresh run, and a second exit gives the fault line and `handedBack`. The snapshot's `alive` now reads `data/rebases.json`, so the dead run's card reads stopped with a stale wait at once.
- **landers.json and rebases.json writes step the data version**, because the board's cards read them.

## Consequences

- A card whose verification was lost before this change (T-265: its lander's record replaced the verified one) needs `builder verified` once more by hand. After that its land step is a first launch.
- Cards held by a busy host (T-208, T-260) have a dead pid and no relaunch count. Their step is launch, as a fresh lander, once the host eases.
- `exited-twice` now reads "Its <builder|lander|rebase run> exited twice unfinished; it waits on the orchestrator."
