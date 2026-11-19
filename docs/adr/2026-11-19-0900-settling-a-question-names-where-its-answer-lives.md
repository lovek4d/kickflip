# Settling a question names where its answer lives; screening passes on with publish

The screen wait told the orchestrator to `question settle <id> --note` for each question the task's notes already answer, then `question publish`. The orchestrator read settle as a screening sign-off and settled two grills' questions (T-764, T-758) with "screened: self-contained", so the owner never saw them.

`question settle` now requires `--answered-by <T-N|commit|notes heading>` beside `--note` and refuses without it; the resolved text and the notes line read "answered in <where>". The screen wait leads with `question publish <card>` passing the questions to the owner, which is all screening is, and offers settle only for a question whose answer already lives in a task, a commit or a notes section.
