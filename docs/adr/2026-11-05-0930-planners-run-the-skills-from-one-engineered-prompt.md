# Planners run the grilling and prototype skills from one engineered prompt

The planner brief (`plannerBrief` in board/headless.mjs; its text stays in code) says to invoke the grilling or prototype skill with the Skill tool, and to follow its own steps when there is no Skill tool (Codex). A grill is one round: its questions go to the board with `question add`, never into the chat, nobody waits, and the planner finishes after the round. All the board's rules are passed in, under a heading saying they are written for the orchestrator and that push, land and restart lines are not the planner's.

A grill with nothing left to ask ends ready (#284), which the brief already says.
