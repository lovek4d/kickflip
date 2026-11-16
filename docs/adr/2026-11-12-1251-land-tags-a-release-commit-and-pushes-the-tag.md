# Land tags a release commit and pushes the tag

Amended 2026-11-16 ([a repo's .kickflip/release replaces land's tag release](2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md)): a repo's `.kickflip/release` replaces this step, Push release tags is gone, and with no script the tag stays local.

The owner (T-137, T-138) wants a release to be an ordinary card: "release should be a normal flow if possible … not some middle half baked implementation outside the main flow". Before this, `scripts/release.mjs` ran `npm version`, which made the release commit and a local `v` tag in the builder's worktree. Builders never push, land pushed only main, and the commit carried no `Refs:` trailer, so land refused it. The tag was also cut on the pre-rebase commit, which land replaces when main has moved.

- **A release card's builder runs `node scripts/release.mjs <x.y.z> --ref <ref>`.** It runs `npm version --no-git-tag-version`, then commits `package.json` and `package-lock.json` itself. The message is `releaseMessage`: `chore(release): <x.y.z>`, the subjects since the last `v*` tag, and the card's `Refs:` trailer. It makes no tag.
- **Land knows a release by its subject.** A landed commit whose subject is `chore(release): <version>` (`commit-message.mjs releaseVersion`) is a release, with no card field. prepareLand checks it after the squash and the rebase, before the suite, and refuses when `package.json` at that commit names another version, or when `v<version>` is already on another commit. A tag already on that same commit is kept.
- **The tag is cut under the land lock, after the fast-forward** (`worktree.mjs landPrepared`), on the commit that landed, so it never points at a pre-rebase commit.
- **The tag goes to origin after main** (`finish.mjs pushBase`), only once main reached origin, and only while the board's "Push release tags" switch (`permissions.mjs pushTags`) is on. With the switch off the land says the tag stays local and how to push it. A tag push that fails is a `push-failed` line naming the tag, and the land stands.
- **One seam.** The check, the tag and its push live in `board/release-tag.mjs`, so a repo's own release step (T-244) can replace it.
- **The release commit's subject list stays as built**, even when other cards land before it.
- **PR boards are out of scope:** `sendForReview` never runs land's fast-forward, so nothing tags their releases.

No SKILL.md step is added: a release is filed and built like any card.

Considered:
- a card field marking a release: the subject already says it and is checked against `package.json`, so a field could only disagree with it;
- keeping `npm version`'s tag and moving it after the rebase: two places own one tag.
