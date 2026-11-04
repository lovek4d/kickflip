# A Merge tap waits its turn to land

Only one land runs at a time on the host (a land can restart the hub and every board server). A land that found the lock held used to refuse, naming the card landing, and the owner had to tap Merge again.

- **A land that finds another landing waits.** It takes a place in `~/.claude/kickflip/land.queue` and lands when the land ahead finishes, in the order the lands asked. A lock or place whose process is gone is taken over. This holds for a Merge tap, Auto-merge, `builder done` and `board.mjs land`.
- **The card says so.** A tap that waits writes a status line, "Waiting for #210 to land", and the card reads "Merging · waiting for #210 to land". A status line does not end the card's merging.
- **Refusals that need the owner stay**: a conflict or failing tests after the rebase hand off to a lander, and a repo off its branch is still refused.
