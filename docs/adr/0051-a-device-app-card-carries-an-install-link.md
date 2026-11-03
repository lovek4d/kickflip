---
status: superseded in part by ADR-0099 and ADR-0124
---

# A device app card carries an Install link

Superseded in part by [0099](0099-a-boards-build-script-serves-or-builds-each-card-and-main.md): the hub owns build triggers and try state; the one badge uses running, failed and stale words without an older-install confirmation, and a try run leaves the card in its lane.

Superseded in part by [0124](0124-only-the-owner-or-auto-build-starts-a-card-run.md): a session no longer builds an install after each push; only the owner's Build and Auto-build start a card run.

A card whose PR builds a device app (iOS, Android) can carry an install: the item's `install` `{url, label?, built_at, sha?}`, set only with `board.mjs item set <key> --install <url> [--install-sha <sha>] [--install-label <text>]` and removed with `--clear-install`.

- **The link is the install.** iOS takes an `itms-services://?action=download-manifest&url=https://…/manifest.plist` link, Android an https `.apk` link; the CLI refuses any other scheme. The build's files sit in the site's `public/installs/<wave>-<id>/`, which the board serves with no login, as it serves all of `public/`, since iOS's installer fetches the manifest and `.ipa` without cookies. `board/server.mjs` gives `.plist`, `.ipa` and `.apk` their types.
- **The card shows an Install chip** right of Action needed, or first when there is none (`installChip` in `board/public/ui-cards.js`): a link in the ready tone, opening in place. The open card's Install button follows the same states below.
- **An older build says so.** `--install-sha` names the PR head the build came from. Once the PR's `headRefOid` has moved past it, the chip reads "Install · older build" in the quiet tone. Without a sha, or before the board has the PR's head, it never reads older.
- **A new push wakes the board session.** The hub's GitHub poll adds `head` to a card's `github-change` changes when its open PR's head moves and the card carries an install. Other cards showing the same PR receive its other changes as usual. The first poll establishes the head; quiet polls and merged or closed PRs emit no `head` change.
- **A running install builder replaces the label.** The session records the first build and each rebuild with `builder start <key> --kind install` through `builder done <key>`. The domain exposes the running builder's `kind`, with `install` taking precedence over other running agents. While it runs, the chip and button read **Rebuilding…** in builder orange (`--color-notice`) when an install exists, or **Building…**, inert, before the first install. Ordinary PR or checking handback leaves install builders running; an explicit `builder done` or finishing the card closes them. With no install builder running, the current or older Install link shows normally.
- **Rebuilding… asks before installing the older build.** A tap opens `BoardDialogs.confirm(message, {ok, cancel})`, a bottom sheet matching the chosen `replace` prototype: "Currently rebuilding with latest changes. Install the existing older build now?", with **Install older build** and **Cancel**. Cancel, Escape, tapping outside and leaving the board view cancel the sheet; accepting opens the existing install in place only while that view remains mounted. Unlabelled confirm callers keep their native dialog ([0023](0023-a-card-can-be-held-and-every-card-button-confirms.md)).
- **The lane follows the builder.** While the install builder runs, the card sits in In Progress, since Claude acts next ([0045](0045-the-lane-follows-who-acts-next.md)). Once the build lands and its builder finishes, the PR and owner waits place it back in In Review.
- **It leaves with the card.** `board/domain.mjs` drops the install from a card in Done; the wave file keeps it.
- **A board whose cards build device apps builds an install** for each card's draft PR and each later push, including a `head` change from the hub, and sets it with the head sha (SKILL.md). Build files remain available at the existing link while its replacement builds.

The owner chose the hub's `head` change and the `replace` take on INT-143: rebuilding uses the existing builder record, and the orange chip itself tells the owner what is happening. The poll already knows the PR head, so the same trigger covers pushes from the owning session, another builder or the owner without a separate webhook.

The owner asked, on the iOS board, for an Install button right of where Action needed goes, as a generic hook for device apps, with the practice added to the skill.

Considered:
- a link in a thread line, which scrolls away and never says it is older than the PR;
- one field per platform (`ipa`, `apk`), when the link alone tells the device what to do.
