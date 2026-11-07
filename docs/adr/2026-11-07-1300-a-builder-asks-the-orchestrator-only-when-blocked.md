# A builder asks the orchestrator only when blocked

Supersedes the "at any point" of [a builder asks the orchestrator mid-build](2026-11-04-0247-a-builder-asks-the-orchestrator-mid-build.md); everything else there (the thread line, the event, the quiet card, deferral to the owner) stays.

Builders were already collecting judgment calls for review; most past asks ("my plan is X, OK?") were calls. A builder now decides, records the call and carries on, and asks only when blocked: every way forward would likely be thrown away because the spec contradicts itself or the code, a rule needs the owner's go before code is written, or the answer is a fact only the orchestrator has. Nothing in the CLI checks this; `builder ask` keeps its name and the rule lives in its usage text, the builder brief, SKILL.md and CONTEXT.md.

A blocked builder asks, does any work the answer can't change, and waits with `builder asks <key> --wait`, which blocks until no ask is waiting and fails after `--timeout` minutes (9, under a Bash tool call's 10) so it is run again, as `agent wait` is. After 30 minutes without a reply the builder records the question as a "Question:" call and hands back.

A problem found outside the card is a "Found: …" call, filed by the orchestrator at review, unless it stalls other cards' builds or lands, which is asked at once. The brief's thread line no longer sends a contradiction between the thread and the notes to an ask: the notes win and the builder records the contradiction as a call.
