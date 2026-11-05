# Needs you feeds oldest first

Needs you lists the line that has waited longest first, to match Todo's oldest-on-top order. The deck steps through the same order, since it walks the lines. Pending prompts still lead, each holding a session, and held reviews, which carry no time, follow the rest.

- **Oldest** means `since` on the line (`domain.mjs` `needsOf`): when its oldest open question was asked, else, for a draft waiting on Ready or another Action needed card, when its card began waiting on the owner: its review start, else its last update.
- **A line with no stamp** comes after the stamped ones, in board order.

Before this, topic lines came first, then card lines in board order, newest first.
