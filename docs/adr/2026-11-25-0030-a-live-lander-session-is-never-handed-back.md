# A live lander session is never handed back, and one verification runs one land

On 11/24 a calls wait opened while T-726's lander was landing. launchLanders had seen the launched lander's pid in data/landers.json dead while the open Lander record belonged to a builder resumed beside it, and handed the live record back. A second lander then started on the same verification, and the first one's `builder done` closed the new record.

- **A live session is not sent back.** launchLanders' sent-back loop leaves a card whose open records have a live session pid: no hand-back, the launch claim kept. A card whose records have no live session is handed back as before.
- **One verification, one land.** `landable` skips a card whose landing marker is live (worktree.mjs `runningLand`) with the `running` land step, so no second lander launches while a land runs, and the card's line reads "Lander running".
