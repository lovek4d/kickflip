# A Reply message has no footer status

A thread message sent with Reply is the default message, so its footer
carries only its time and pick-up state. Only Implement, which changes
what happens next, keeps its icon and word.

`INTENT_LABELS` in `board/domain.mjs` names only `build`. The status is
computed when the thread is read, so earlier Reply messages stop showing
"Reply" too.

Supersedes the Reply half of
2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md.
