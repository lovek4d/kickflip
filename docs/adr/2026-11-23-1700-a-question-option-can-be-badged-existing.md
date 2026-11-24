# A question option can be badged existing

A question option takes `existing: true`, drawn as a grey "existing" badge beside its label, in the shape of "recommended"; one option can carry both.

Every question about changing behaviour that exists today includes one existing option: the current logic, unchanged, worded as what happens now. That makes keeping things as they are an explicit choice rather than something the owner types. A question about something with no current behaviour has none.

`question` validation refuses a second existing option on one question. Whether a question needs one is judgment, so it is stated in SKILL.md and in each planner brief (STANDALONE in board/headless.mjs) rather than checked.
