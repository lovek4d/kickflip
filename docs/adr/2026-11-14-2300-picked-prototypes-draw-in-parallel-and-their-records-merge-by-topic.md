# Picked prototypes draw in parallel, and their records merge by topic

A prototype round used to draw one question: the planner's brief carried one owner request, a second request before the brief was written replaced the first, one Send with no take picked on two prototypes kept only one, and `noTakePicked` read the newest input across the whole card, so a pick on topic B hid topic A's redo (T-130, folding in T-148).

Now:

- **Every request is a round.** A card's owed prototype brief keeps each owner request in `asks` (store.mjs `owe`): every Prototype tap and every answer that picks no take. A grill or visual entry still keeps the newest `ask`. A prototype entry written before `asks` launches with its one `ask` as `asks`.
- **The orchestrator suggests, the owner picks.** The orchestrator suggests the prototypes worth drawing in the discussion and names each pick in its prototype brief as its own round (SKILL.md). No new picking UI.
- **One sub-agent per round, all at once.** The planner (headless.mjs `plannerBrief`) gives every round its own topic before any is drawn, then launches one Agent sub-agent per round in one message, on its own model, a lone round too. Each sub-agent records its topic, writes its takes and posts its question. A served round's base worktree and build script are made by the planner before the fan-out. The planner writes the notes after they all finish.
- **Prototype records merge by topic.** Each `data/prototypes.json` record has `id` = its topic, and a record from before ids reads with one. `prototype add` and `prototype rm` change the file under its lock, from what it holds at that moment, so parallel adds of different topics all survive. A second add of the same topic is a hard error naming it, not a silent replace. The owner picked merging by topic over the planner recording every topic up front (t130-f-record2). An adversarial review found the real risk was the "already recorded" check running outside the lock, not a lost record.
- **noTakePicked per chain.** A card's prototype questions go by chain: a question and the rounds that name it in `round_of`. The card is unpicked while any chain's newest input is a request or a no-pick answer, and it returns the newest such input.

Because writes to `prototypes.json` happen under the lock from the file's current contents, `merge3` never merges that file today. The id is there so that a future merging writer merges per record.
