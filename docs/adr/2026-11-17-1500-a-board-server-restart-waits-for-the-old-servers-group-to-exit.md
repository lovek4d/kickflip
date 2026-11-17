# A board server restart waits for the old server's group to exit

T-635 found 29 of 41 board server restarts on 11/17 refused with "port is held": the hub stopped the old server's process group and started the new server as soon as the leader exited, while a member of the group still held the listening port. The refused start waited out a backoff and the board came back about 17 s later.

When a board server's child exits, the hub now waits for its whole process group to be gone and the port to answer nothing (`groupExit`) before a new server starts. A group still there after the 5 s grace gets SIGKILL; after twice the grace the wait ends and the existing port check names whoever still holds the port. The stale server a hub that died hard left (`killStale`, the hub's first reconcile) is waited on the same way.

The start's port check stays: it still stops a stray copy of the server the hub has no record of, and names any other holder.
