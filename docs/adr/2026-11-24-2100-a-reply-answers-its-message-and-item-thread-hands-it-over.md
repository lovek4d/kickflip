# A reply answers its message whatever its handed stamp, and item thread hands the owner's words over

A reply wait stayed open after the orchestrator answered, because an answer counted only when later than the message's
handed stamp, which only `inbox read` set. A reply or thread line written before that stamp never counted, and a board
"Related to" line closed the wait by accident.

- A reply on the message's own event answers it whatever its handed stamp (as `pendingState`'s `replied` already did).
- `item thread` stamps the owner's words it prints as delivered, so a thread line written after reading them there counts.
- A command line (Related to, Marked as …) never answers the owner.
- `item thread` prints replies, and the wait log reads a reply's body from its extension key.
