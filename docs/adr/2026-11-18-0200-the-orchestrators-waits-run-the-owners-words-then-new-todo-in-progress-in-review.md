# The orchestrator's waits run the owner's words, then New, Todo, In Progress, In Review

- **One order for the waits** (owner, T-497). `domain.mjs orchestratorWaits` lists, after the bumped cards: the owner's words waiting on a reply or an answer (`reply`, `answer`) on any card; New (`intake`); then each lane's waits down Todo, In Progress and In Review. Within each group, oldest first (`since`). The watcher prints the waits file in that order, and its collapsed `still waiting` line groups by kind in it.
- **Why.** The owner waiting in real time comes first; New is unsorted work; a build already running in In Progress or a PR in In Review loses nothing by waiting. Before, a Todo line could print above an In Progress one by board order only.
- **Kept.** A bump still puts a card's waits first (2026-11-06-1700), and `limbo` waits still come last, so cards owing nobody anything stay a batch behind the real work.
- **Dropped.** The first notes' rule "don't start a Todo wait while an In Progress one is open": the order is plain top-down.
