# Posts end with the signature and no longer lead with the robot

Owner (T-851): stop leading messages with 🤖 and rely on the signature at the end, the same on GitHub and Slack. It replaces T-89's “🤖 ” prefix wherever one was left.

- **No leading 🤖.** `CLAUDE_PREFIX` is gone. A Slack-filed task's replies, end and waiting lines, the router's answer and `slack answer` / `slack say` post their words as they are; `post` in `hub/slack.mjs` ends them with `- :<emoji>:` ([every Slack message ends with a sign-off line](2026-11-12-0400-every-slack-message-ends-with-a-sign-off-line.md)).
- **GitHub ends with the same line.** `pr comment`, `pr reply` and `review post` end with `githubSignOffLine()`, “- ” and the character of the emoji picked in Hub › Slack, then the hidden `<!-- claude-bridge -->` marker. A pick that isn't among Hub's standard emoji (a Slack custom emoji GitHub can't show) reads as the robot face. The review header is “Claude review from the <board> board”.
- **Refusals.** `pr comment`, `pr reply` and `review post` refuse words whose last line is already GitHub's signature, or that carry the marker.
- **Recognising our own posts is unchanged.** On GitHub that is the marker (`reportOf`); on Slack the sign-off line (`isSignedOff`). Nothing read the 🤖.
