# A launch records its process at spawn

`builder resume` on a handed-back build refused ("no Claude session the board launched") because the hub restarted
between the build's spawn and its session id arriving, up to 15 s later. The first server held the launch claim for the
live process, so the restart's launch got nothing back and recorded neither a session nor a tracking entry.

## Decision

- `launchBuilder` writes `session {id: null, pid, log}` on the agent's record from the spawn (`launchClaimed`'s
  `spawned`), then the id once it arrives. A restart in the gap still leaves the process and its log on the record.
- The session id is read by `sessionIdOf`: the record's id, else the `session_id` of its log's init line. `builder
  resume`, the rerun and pause-resume launches and `recordedSession` all use it.
- A launch whose claim the record's own earlier spawn holds is tracked from the record's pid and log (`trackSpawned`),
  so `reviveHeadless` still sees the build.

## Left out

The lander's launch still writes its session onto the handed-back build's record before its own `builder start`
archives it.
