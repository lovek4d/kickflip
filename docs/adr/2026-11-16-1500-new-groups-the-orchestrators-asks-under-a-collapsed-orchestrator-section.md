# New groups the orchestrator's asks under a collapsed Orchestrator section

The owner's asks, Slack requests and other boards' asks stay in New's main list. An ask the orchestrator filed (its
event's `asked`, [a task the orchestrator files comes in as an ask through New](2026-11-16-1100-a-task-the-orchestrator-files-comes-in-as-an-ask-through-new.md))
sits under an "Orchestrator <count>" sub-head at the bottom of New, collapsed until tapped. New's count is the main
list's, so it matches the rows drawn; with only orchestrator asks waiting, New shows its head and the collapsed
sub-head.

New itself is a lane's `<details>` (`data-lane="new"`), and the sub-head one more (`data-lane="new-orchestrator"`).
Both remember their open state in the lanes' store (app-lanes.js toggle handler; the hub's view has the same handler),
New open by default, Orchestrator closed. Collapsed, New shows its head and count.

Chosen from three drawn takes (sub-head at the bottom, its own strip, one inline row), and the count from two: main
list only.
