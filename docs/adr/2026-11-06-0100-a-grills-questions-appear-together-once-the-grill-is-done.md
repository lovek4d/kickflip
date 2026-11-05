# A grill's questions appear together, once the grill is done

On #318 the orchestrator posted a question itself when it filed the card, while the board's grill planner was just starting, so one question showed before the grill had asked the rest. The owner: "grilling should land all questions at once, open questions should not appear until grill agent completes".

- **Staging**: `question add` on an `item:<wave>/<id>` topic whose card has an open grill or prototype planner record writes the questions to `data/staged-questions.json` instead of `owner.json`, whoever adds them, the orchestrator included. They are validated when added, so a bad file is still refused at once, and their ids count as taken. Staged questions are in no count, no Open questions, no Needs you. `question add` prints `staged: <id> …` naming the card and planner, and says "staged" rather than "added".
- **Publishing**: when the card's last open planner record closes, the card's staged questions are added in the order they were staged, in one write, so the server's push check sees them together and pushes the owner once.
- **Judgment call: a failed or stopped planner publishes too.** The planner's record closing by any route (`builder done`, the stop hook, a hold, a card handed back, a launch that failed) publishes what is staged, so no question is lost to a planner that never finishes cleanly. The cost is that a half-done grill's questions can appear without the rest.
- **Not staged**: questions on `item:ask:` topics, lineups, waves and declared topics, and questions on a card with no planner running.
