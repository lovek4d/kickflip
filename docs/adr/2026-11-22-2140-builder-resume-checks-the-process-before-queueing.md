# Builder resume checks the builder's process before queueing

Status: accepted, 2026-11-22 (#1161)

## Context

`builder resume` read "running" as "record not done". A headless builder that exited without `builder done` (T-810:
a failed land, then a stop at an edit approval) leaves its record open, so the words queued as news for a session that
was gone and the build never resumed, while `builder stop` on the same card said "isn't running".

## Decision

An open record whose `session.pid` is a number no process answers to resumes as a handed-back build does: the words
are news, the record is marked `rerun`, and the board server's auto pass resumes the builder's own session with them
(see 2026-11-16-0007). The news pointer for the dead session is removed, since no hook will read it. A record with no
session pid, a session's own builder, still counts as running.

## Consequences

- A dead builder restarts with the orchestrator's words instead of waiting on a process that never reads them.
