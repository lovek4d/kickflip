# Every Slack message ends with a sign-off line

- **One seam.** `post` in `hub/slack.mjs` appends `\n- :claude_kickflip:` to every message the hub sends: digests and their replies, day-thread openers, PR links, and the orchestrator's `slack answer` and `slack say`. Reactions are not messages and get nothing (owner, t150-scope). GitHub posts keep their own 🤖 prefix.
- **The emoji is checked.** A custom emoji that doesn't exist shows as literal text, so the client asks `emoji.list` once per client (one hub send pass, or one CLI command). When the workspace lacks `claude_kickflip`, the token lacks `emoji:read` (`missing_scope`), or the call fails, the line is `- :robot_face:` (🤖). `emoji:read` joins the app manifest; a token made before this keeps the fallback until the owner updates the Slack app.
- **The sign-off replaces the “🤖 ” answer prefix** (owner, t150-prefix; it replaces T-89's prefix). The hub posts as the owner, so it hears past its own and the orchestrator's posts by their last line, either emoji (`isSignedOff`), not by a prefix.
- **The 250-character limit** on the orchestrator's words counts only the words.
