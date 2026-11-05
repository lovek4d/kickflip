# The fourth bar is review, and the finish step sets landing

The five phase bars keep their names (store.mjs PHASES): reading, building, testing, checking, landing. The brief now says what each means, one line each:

- reading ends at the first test; building covers tests, code, ADR, docs and the commit; testing is the full suite.
- checking is the builder's own review before it hands back. Orchestrator review continues on the same 4th bar (#206 draws it), so a card with no calls passes through it at once.
- landing is set by the finish step itself (finish.mjs, through store.landingLine), so the 5th bar lights while done rebases and lands, for a builder, a lander and a Merge tap alike. A builder never reports it.

Why: builders had no definition of "checking" (used 49 times against testing's 141), and a builder with no calls ran `done` from testing, so the bars stopped at 3 of 5 and the card jumped to Done.
