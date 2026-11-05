# Needs you feeds oldest first

Needs you lists the line that has waited longest first, to match Todo's oldest-on-top order. The deck steps through the same order, since it walks the lines. Pending prompts still lead, each holding a session, and held reviews, which carry no time, follow the rest.

- **Oldest** means `since` on the line (`domain.mjs` `needsOf`): when its oldest open question was asked, else, for a draft waiting on Ready or another Action needed card, when its card began waiting on the owner: its review start, else its last update.
- **A line with no stamp** comes after the stamped ones, in board order.
- **Waiting on you's topic pills follow the same order** (`domain.mjs` sorts `ownerTopics` by each topic's Needs you line; topics with no open question keep their order after), so the phone's deck, the desktop pane's lines and the pills on Waiting on you, embedded or on its own page, read alike.
- **From 900px, the pane's orange Needs you leaves out a line that only asks questions** (`app-needs.js`), since Waiting on you under it shows them; prompts, Ready on GitHub, Action needed and held reviews stay, and with none of those the orange section is gone. The test is the stylesheet's split width, `(min-width: 900px)`. A phone keeps its deck at the top. The owner, on #310: "on desktop where the needs you is the right side, don't also show the needs you orange section at the top". Hiding the whole section was set aside: on a desktop it is the only place a board's pending prompts are answered.

Before this, topic lines came first, then card lines in board order, newest first.
