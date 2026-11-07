# Every agent brief names the card's thread file

Status: accepted (#394)

A builder's brief gave the notes path but not the thread, so a builder could miss an owner message that never reached the notes.

Every brief (builder, lander, rebase run, helper, planner, visual agent) now names the card's exact thread file (`briefFacts`' `thread`, from `threadFile`), as a path only: the agent reads it live. The Related cards list gives each linked card's notes and thread paths.

A thread is short (median about 250 tokens, 90th percentile about 650, largest about 2,800 on this board), so every agent reading its card's whole thread is a light lift.

A builder treats the owner's messages (`who: love`) as instructions, but where one contradicts the notes the notes win and it asks with `builder ask`. It reads the thread again in its checking phase for anything written during the build.

Intake triage already gets the thread inline and the board's card index (#317), so it is unchanged.
