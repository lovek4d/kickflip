# A PR's Slack link is a bar coloured by the builder's risk

Each PR's link in a reviewer's day thread was one line of text: the reviewer's mention, `repo#n` linking the PR, then "ready for review: <title> (+N/-M, K files)". The owner wanted a reviewer to see at a glance what the PR is, how big it is and how carefully to read it, and picked variation C of the visual (visuals/T-342), "exactly like that".

The link is now the reviewer's mention as the message's text, then one Slack attachment (`board/store.mjs` `prLink`):

- **The bar** is the card's risk: green `#2eb67d` low, orange `#e8912d` medium, red `#e01e5a` high, the order of the colour priority in AGENTS.md. A card with no risk, such as a PR the board didn't build, gets a grey `#9e9e9e` bar.
- **The title** is the PR's title from GitHub (the card's title while GitHub hasn't given one), bold and linking the PR, as an attachment's `title` and `title_link`.
- **The line under it** reads `+<adds>/-<dels> · <n> files · <risk> risk`. The size comes from GitHub's PR data the hub already reads (additions, deletions, changedFiles). The risk word repeats the bar's colour for colour-blind readers and is left out when no risk is stated.
- **The attachment's fallback**, `repo#n <title> · <line>`, is what a notification shows, and what `slack thread` prints under the message so the orchestrator reads which PR it was.

**The sign-off is the bar's last line,** under the title, size and risk, as C drew it: the Slack client ends the last attachment's text with it when a message has attachments, and the message's text otherwise, an edit's " · _updated HH:MM_" with it (`hub/slack.mjs` `signedOff`). `isSignedOff` reads the same place, so the hub still hears past its own links ([every Slack message ends with a sign-off line](2026-11-12-0400-every-slack-message-ends-with-a-sign-off-line.md)). The build first kept it as the text's last line, but Slack draws a message's text above its attachments, which put the sign-off between the mention and the bar; the owner picked inside the bar (question t342-signoff). The digest, which has no attachments, keeps its sign-off in its text.

**Risk is the builder's judgment.** `builder done --risk low|medium|high` keeps it on the card as `risk` before the task finishes or is handed back, and refuses any other word before anything else happens. The builder's brief asks for it, with one line on what it means and why it is asked. The card shows it as a chip in the same colours. Nothing works it out from the diff: a builder knows what its change touches and how well the tests cover it, which size alone doesn't say.

`hub/slack.mjs` `post` and `update` pass `attachments` through, signed off as above; the states (approved, merged, closed) stay reactions on the message.
