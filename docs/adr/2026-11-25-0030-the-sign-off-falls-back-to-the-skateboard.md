# The sign-off falls back to the skateboard, not the robot

Owner (T-876): "use skateboard emoji instead of robot as fallback". It changes the default in [a PR's state is reactions again, and the signature is picked](2026-11-18-0434-a-prs-state-is-reactions-again-and-the-signature-is-picked.md).

- **Default is `skateboard`** (🛹): `SIGN_OFF_DEFAULT` in `hub/slack.mjs`, so a message with no pick ends `- :skateboard:`, and Hub › Slack's Signature row resets to it. The skateboard joins `STANDARD_EMOJI`, so GitHub's sign-off line shows 🛹, as does the fallback when the pick is a custom emoji GitHub can't show.
- **The robot still reads as ours.** `robot_face` stays in `SIGNED_OFF_ALWAYS`, so the hub keeps hearing past the posts it signed with it (`isSignedOff`).
