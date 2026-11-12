# Only agents pause past the pause line

The owner (hub #534): a new task was held while replies to its thread were not; either intake proceeds while paused with only agents held, or everything pauses. They leaned to pausing only agents, and said "yes go for it".

- Past the pause line, planners, builders and reviewers are held: the board's `launchHeld` and the hook's Agent/Task deny already do it.
- The orchestrator keeps sorting asks, writing notes, readying staged cards, screening questions, replying and landing finished builds. Holding its sort bought nothing: a card filed into grilling only queues its planner until the pause lifts.
- The hook's paused line reads "Builders and agents are held until <time>; keep sorting, readying, screening and answering." It no longer tells the orchestrator to answer only "paused until <time>".
- No separate hard stop: at the real limit Claude doesn't answer, so nothing runs and threads go unread on their own.
