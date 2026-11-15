# A pull and its build start are one status line

The pull wrote "Pulled in: an implementer slot was free." and the build start it launched then wrote "Moved to In Progress: a build started": one event, two lines in an append-only thread.

The pull's line is now the move, "Moved to In Progress: slot available" (hub-lines.mjs `pulled`), and a build start whose card's last thread line is that pull writes no move line (store.mjs). A build started any other way (the owner's Build, a resume, a land handed back) still writes its own move line, and every other move keeps its why. Lines already in threads are not rewritten.
