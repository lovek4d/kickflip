# Done and Hold stop the card's headless builder

Amends `2026-11-04-1010-a-dead-headless-builder-is-relaunched-once.md`.

The board server, not the session, stops a card's headless agent when the owner taps Hold or Done (`server.mjs`, after
`recordOwnerTap` succeeds; the CLI's `item set --status done` kills nothing).

- `recordSession` stores the agent's pid beside its session: `session {id, pid, at}`, on builds, landers and planners.
- The server reads the card's open records (`openAgents`) before the tap closes them, then `stopAgents` sends SIGTERM to
  each pid's process group (the agent is detached and leads it, so its children go too) and SIGKILL after 5 s. A pid is
  signalled only while its process started within a minute before `session.at`, since pids get reused.
- A Hold also closes the card's open builder records, or `reviveBuilders` would relaunch the exited process. A record
  with no pid (a session's own `builder start --dispatch`) only closes.
- A Hold stops a landing card and a Todo card's planner too. A Done on a card whose latest status is the landing line
  stops nothing, so the land closes out (owner, gh229-landing).
- The thread says "Stopped its builder." after the owner's line (owner, gh229-line). Unhold stays as it is and
  launches a fresh builder (owner, gh229-resume).
