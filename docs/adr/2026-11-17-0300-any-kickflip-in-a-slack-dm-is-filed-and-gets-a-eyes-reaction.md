# Any kickflip in a 1:1 Slack DM is filed, and gets a 👀 when filed

Extends 2026-11-15-0130 (an @kickflip in a Slack DM is filed as a routed ask). The owner (T-581 grill, 11/16) chose to drop the "@": no bot user is needed to be heard, and anyone else on the workspace can authorize the same Slack app for their own hub with their own user token.

- **The match is the word.** `NAMED` in `hub/slack-intake.mjs` is `/\bkickflip\b/i`, so "@kickflip", "kickflip" and "is kickflip down?" in a 1:1 DM file an ask. Same rules as before: 1:1 DMs only, from anyone, one search with the owner's user token. The cost the owner accepted: talk about the product files an ask too. They may reduce it to "@" later.
- **A picked mention.** The workspace's Kickflip app may already have a bot user, which autocompletes as @Kickflip and arrives as `<@ID>` with no word in it. Each poll `slack.botId()` finds it in `users.list` (`is_bot`, name or real name kickflip, `users:read`) and a second search for `<@ID>` is merged in; its messages match as the word does. No bot user means word only. The manifest gains no bot user and Hub settings shows nothing for it.
- **👀 when filed.** After a message is queued, `reactions.add` puts `eyes` on it (both forms). A failed reaction, such as a token without `reactions:write`, is reported in `failed` and never undoes the filing.
- **Replies in a filed thread.** `followSlackAsks` shares the word match, so an owner's reply saying kickflip in a filed thread wakes the orchestrator as an @kickflip did.
