# The robot no longer reads as ours

Owner, on the skateboard fallback: drop the robot in a couple of days, to let the skateboard sign-off stabilize. It has run two days. This supersedes the "robot still reads as ours" line of [the sign-off falls back to the skateboard](2026-11-25-0030-the-sign-off-falls-back-to-the-skateboard.md).

- `robot_face` leaves `SIGNED_OFF_ALWAYS` in `hub/slack.mjs`. `isSignedOff` reads as ours a sign-off with the picked emoji, any emoji picked before it, or `claude_kickflip`.
- A post signed with the robot now reads as the owner's, so the hub no longer hears past it.
