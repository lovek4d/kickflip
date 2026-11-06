# Answers submitted together are one thread message

Status: accepted (#281). Extends [a button tap is a status line or a message footer](2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md).

One submit of several answers is one message with one "answers submitted" footer. The events stay one owner-answer per question; `threadOf` (board/domain.mjs) folds the ones sharing a `ts` (one `appendEvents` write is one submit) into one message listing each answer's block in submit order. Its state is its most pending answer's, and `answers` keeps each member's state and reply, so a reply to one answer draws under the message quoting that answer.

The earlier hiding of the footer on all but the last answer of a batch (`batchedAt`) is gone.
