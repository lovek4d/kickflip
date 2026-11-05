# A failed hub/boards.test.mjs setup prints the hub's and the board servers' output

Release run 42129754709 (Ubuntu, Node 22) failed all 34 tests in hub/boards.test.mjs with "failed running before hook",
and its cleanup then failed with ENOTEMPTY. node:test prints no message of its own for a failed hook, and the setup
rejected with the hub's bare exit code, so the log did not say what failed.

The same suite passes in a `node:22` Linux container (as root and as a user, with 1 and 2 CPUs, `CI=true`), so the cause
is not reproduced here. The setup now throws with the hub's stdout and stderr and every file in the hub's logs folder
(the board servers' output) appended, and the cleanup removes the temp home with retries, so a server still writing as
the tree goes cannot replace the setup's error with ENOTEMPTY. The next CI failure names its cause.
