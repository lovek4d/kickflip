# A Linear board pulls in open issues of its project

Owner, 11/27: Pull in issues ([a board pulls in open GitHub issues no task names](2026-11-27-2345-a-board-pulls-in-open-github-issues-no-task-names.md)) also reads Linear. The setting, its values, the Hub default and its override, the discussing filing, the woken orchestrator and the backlog ask are all the same; only the source differs.

- A board whose ticket source is Linear and whose tasks live in one item file pulls from its Tickets section's team and project (`hub/issue-pull.mjs linearProject`). `openIssues` in `hub/linear.mjs` lists the project's open issues, those not completed or canceled, newest 100, with whether more exist.
- The hub's GitHub poll runs the pull, one Linear query per pulling board. A board with the pull off asks Linear nothing. Hub with no working Linear key pulls nothing and says nothing; Linear failing a read is a poll failure line.
- An issue is named when a task's ticket or legacy Linear link is its identifier. The task files as `<slug>/<identifier>` (`ENG-12`), ticket linked, so the ticket layer already treats it as the task's ticket. Assigned only keeps issues assigned to the Linear key's owner. Pulling assigns nothing and moves nothing.
- Each pulled task gets the thread line "Pulled in from Linear issue ENG-12." and an `issue-pulled` event with `source: linear`, which wakes the orchestrator as a GitHub pull does.
- `issueBacklog` counts a Linear board's backlog the same way, so turning the pull on asks all, or only new ones.
