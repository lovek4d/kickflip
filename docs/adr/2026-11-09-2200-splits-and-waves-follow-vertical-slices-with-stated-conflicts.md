---
status: accepted
---

# Splits and waves follow vertical slices with stated conflicts

This supersedes the grouping method of [a wave builds in phases](2026-11-04-0238-a-wave-builds-in-phases.md) ("group the cards into phases by the files and areas they touch"), which [a wave's cards wait only on the earlier cards they conflict with](2026-11-09-1321-a-waves-cards-wait-only-on-the-earlier-cards-they-conflict-with.md) already replaced for waiting. This decides how cards are cut, and when one names another.

- **Vertical slices** (owner, #436 gh436-method): "Vertical slices with stated conflicts, in kickflip's own brief and SKILL.md text." Each card is one thin end-to-end behaviour a single builder lands and tests on its own.
- **The first card is the thinnest end-to-end path** (owner, #449 gh449-tracer). A card waits on it only when it builds on it or shares its seam (owner, #449 gh449-first-card-waits), not as a rule.
- **A conflict is the same seam or needing that card's behaviour** (owner, #449 gh449-conflict): the same function, component, CLI command or doc paragraph, or building on what that card adds. Sharing only a file runs side by side and rebases at land.
- **The grill planner takes its slicing from Matt Pocock's `/to-tickets`** (owner, #449 gh449-to-tickets, on the owner's note "rely more on the matt pocock skills"): it reads step 3, "Draft vertical slices", from the installed SKILL.md, because the skill sets `disable-model-invocation` and a headless planner can't invoke it. The brief keeps only the board's parts: the split question (title, scope, files, the earlier proposed cards each waits on, or none) and filing on Split by the orchestrator. The skill's quiz and tracker-publishing steps don't apply; the board's own question and `item add` / `wave create` replace them.
- **Plan waves** triage uses the same rule for the cards it groups.

Considered:
- Keeping the method inline in the brief: a second copy of slicing rules that drifts from the skill.
- Every card waiting on the first tracer card: waits on cards it has nothing to do with, which [#436](2026-11-09-1321-a-waves-cards-wait-only-on-the-earlier-cards-they-conflict-with.md) removed.
