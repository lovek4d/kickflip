# A device app card carries an Install link

A card whose PR builds a device app (iOS, Android) can carry an install: the item's `install` `{url, label?, built_at, sha?}`, set only with `board.mjs item set <key> --install <url> [--install-sha <sha>] [--install-label <text>]` and removed with `--clear-install`.

- **The link is the install.** iOS takes an `itms-services://?action=download-manifest&url=https://…/manifest.plist` link, Android an https `.apk` link; the CLI refuses any other scheme. The build's files sit in the site's `public/installs/<wave>-<id>/`, which the board serves with no login, as it serves all of `public/`, since iOS's installer fetches the manifest and `.ipa` without cookies. `board/server.mjs` gives `.plist`, `.ipa` and `.apk` their types.
- **The card shows an Install chip** right of Action needed, or first when there is none (`installChip` in `board/public/ui-cards.js`): a plain link in the ready tone, opening in place.
- **An older build says so.** `--install-sha` names the PR head the build came from. Once the PR's `headRefOid` has moved past it, the chip reads "Install · older build" in the quiet tone. Without a sha, or before the board has the PR's head, it never reads older.
- **It leaves with the card.** `board/domain.mjs` drops the install from a card in Done; the wave file keeps it.
- **A board whose cards build device apps builds an install** for each card's draft PR and each later push, and sets it with the head sha (SKILL.md).

The owner asked, on the iOS board, for an Install button right of where Action needed goes, as a generic hook for device apps, with the practice added to the skill.

Considered:
- a link in a thread line, which scrolls away and never says it is older than the PR;
- one field per platform (`ipa`, `apk`), when the link alone tells the device what to do.
