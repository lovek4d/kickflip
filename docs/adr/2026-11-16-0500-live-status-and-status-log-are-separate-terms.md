# Live status and status log are separate terms

"Status line" named two things: the one current line in a card's header, replaced as it changes, and the board's and builders' lines in the thread, appended and never replaced. Reading "its status line" gave no way to tell which was meant.

The header's line is the **live status**. The thread's lines are the **status log**, and one entry is a status log line. CONTEXT.md defines both, with "status line" under _Avoid_, and CONTEXT.md, SKILL.md and the `board.mjs` help use them.

Code names (`appendStatus`, `{kind: 'status'}`, comments) and the titles of earlier ADRs keep "status line": they are not read by the owner, and a rename there would change nothing they see. The Claude Code status line (`bin/statusline.mjs`) and a sidebar row's status line are other things and keep their name.
