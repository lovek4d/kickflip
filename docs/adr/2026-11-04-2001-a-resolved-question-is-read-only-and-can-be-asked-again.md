# A resolved question is read-only and can be asked again

On Waiting on you, a topic's open questions sit on top and its resolved questions fold under a collapsed "resolved (N)" header in plain text, with a disclosure arrow and the questions' ids, no badge styling on the header itself.

Each resolved question is read-only: its options are locked with the last pick checked, it has no note box and no prototype eye, and a new answer can no longer be sent from the page. It reads how it was resolved and "acted on <time>" from `resolved_at`, then the owner's last note once (the pick is the checked option, so the answer isn't repeated below) and Claude's reply when there is one.

Its "resolved" badge is green and is a button. Tapping it asks "Ask this again from today's context?" through the board's confirm dialog; on yes the page sends `reask-request {key?, question}`. The board server refuses one naming a question that isn't resolved. The card's thread shows only the muted request line "re-ask requested", like a Grill or Prototype tap.

The re-ask is under way while the event is newer than the question's `resolved_at` (domain.mjs ownerQuestion `reask`): the badge is disabled and the question reads "re-ask requested". The session, or a planner running on the card, asks the question again from the card's current notes with `question add` and `reask_of: <old id>`. That resolves the old question again, noting "Asked again as <new id>", which moves `resolved_at` past the event and ends the request. The old question stays in the resolved group.

`reask_of` is its own field rather than `round_of`, because `round_of` starts a prototype round: it needs a prototype url and numbers the round, which a re-ask of a plain question has neither of.

`resolved_at` stays in owner.json for this, and because an answer newer than it reopens the question.

Superseded in part by docs/adr/2026-11-15-1300-a-sent-questions-resolved-badge-is-plain.md: the badge is no longer a button.
