# A thread message's name is the header with the rule, its time a small footer

Status: accepted

Owner, T-438: swap the header and footer styles of a thread message.

- The name (`.msg .who`) takes the type the footer had (12px, muted) with the separator rule under it.
- The footer (`.msg-foot`) takes the name's old small type (11px, muted) and loses its rule above. It extends [2026-11-14-1700](2026-11-14-1700-every-thread-message-has-the-owners-shape-and-its-time-in-a-footer.md).
- Footer statuses (sending…, waiting…, thinking, not sent) keep their own weight and colour; they follow the footer's size.
- Style only: `style.css` serves the board and the phone page, and the markup is unchanged.
