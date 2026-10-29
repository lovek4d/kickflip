# The board is the session's work log, and review stays on GitHub

A board shows the work its session has picked up: wave items, one-off tasks and asks, each with its thread. It is not the Linear queue, which can be much broader: an open ticket shows only once a session takes it on, as a work item or a follow-up of its wave ([0034](0034-follow-ups-are-todo-cards-of-their-wave.md)).

A card's thread is for what never reaches GitHub: judgement calls ([0007](0007-judgement-calls-are-questions-on-their-item.md)), the owner's questions, and the talk that shapes the change or the owner's understanding of it. Review and CI detail stays on GitHub, so the board doesn't show:
- CI checks by name, test runs, diff summaries or the builder's brief;
- a review brief or the PR body on a draft waiting on Ready;
- a PR's diagrams, which the diagram checker keeps readable on GitHub;
- screenshots of a finished site card, which gets a text summary ([0022](0022-site-cards-build-in-parallel-when-their-files-dont-overlap.md));
- a Mark ready button. The owner taps Ready on GitHub, or says ready in the item's thread, and the card links the PR instead.

Two parts of GitHub do reach the board, because they are conversation or wait on an answer:
- **People's comments are mirrored.** The owner's and reviewers' PR comments become lines in the item's thread, each with its GitHub link. Codex findings become one Claude line per round, such as "Codex: 2 findings, fixed in 1ce12d6". The monitor skill writes these lines.
- **Unanswered Codex findings show as a chip.** An open PR with Codex findings Claude hasn't answered (fixed, or not changed and why) shows a "codex N" chip in the notice tone beside CI, until each is answered.

The owner set this scope in the first round, `site-v1`. On g5 they picked option A, wave items plus one-off tasks: "a worklog of things that are actively picked up and part of the session work queue, not necessarily the Linear queue, which can be a lot broader". On g9 they picked only judgement calls: "Any review or CI stuff should stay in GitHub, save this surface for internal conversation or discussion that does not reach GitHub". Later rounds kept to it:
- `site-v2` v2-batch, option B: "the mark ready button here might be vestigial, can just get rid of it in exchange for pr link". This reversed `site-v1` g3, where Mark ready ran `gh pr ready`.
- `site-v3` v3-review-brief, option C, no brief.
- `site-v4` v4-github-mirror, option A, mirror the people and summarize the bots; and v4-codex-chip, option A.
- `site-v9` v9-chart-preview, option C, diagrams stay on GitHub.
- `site-v14` v14-shots, option C, text only.

Considered:
- every open Linear ticket assigned to the owner in Todo, or wave items only (`site-v1` g5 B, C);
- review and Codex findings, CI checks by name, test runs, a diff summary and the Codex brief on the open card (`site-v1` g9);
- a three-line review brief on a waiting draft, or its full PR body (`site-v3` v3-review-brief A, B);
- checkboxes to mark several drafts ready at once (`site-v2` v2-batch A);
- mirroring every GitHub comment, Codex included, or none (`site-v4` v4-github-mirror B, C);
- a PR's rendered diagram in its thread or card (`site-v9` v9-chart-preview A, B);
- a screenshot, or before and after screenshots, for a finished site card (`site-v14` v14-shots A, B).
