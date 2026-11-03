# The hub offers a newer kickflip from npm

An npm install's hub checks `@lovek4d/kickflip@latest` on the registry as it starts and once an hour (`hub/upgrade.mjs`), and compares it with the version in its own package folder's `package.json`, read on each answer, since `npm i -g` replaces that folder. While the registry's is newer, `/_hub/sidebar.json` carries `upgrade: {state, version}` and the sidebar's New version row reads **Update available · Upgrade** on every page. A clone (its folder has `.git`) never asks npm and never shows it: the owner relies on the release workflow ([0158](0158-a-v-tag-publishes-kickflip-to-npm.md)) to get changes to npm, and a clone updates with `git pull`.

**Upgrade runs `kickflip update` on the host** ([0101](0101-kickflip-ships-as-a-minified-npm-package.md)), which installs from npm and restarts the hub. It runs in its own process group, logging to `~/.claude/kickflip/logs/kickflip-update.log`, so the hub's restart doesn't stop it. The tap doesn't reload the page: once the new hub runs, its code hash differs from the one the app loaded, and the existing New version · Reload follows ([0097](0097-the-app-reloads-for-new-hub-code-only-on-the-owners-tap.md)). Reload takes the row first whenever both apply.

**It waits for builders.** `POST /_hub/upgrade` asks for the update; while any open board has a running builder record (`board/store.mjs` `openBoardBuilders`), the row reads **Update waits for 2 builders**, and the hub's 15-second tick runs the update once none runs. While it runs the row reads Update available · Updating…; if `kickflip update` fails, Update failed with its last line and Upgrade again.

**Anyone who can open the hub may tap it**, as with Restart on a board row; the route takes JSON only, like the hub's other POSTs. The tap waits for the hub's answer and shows what it says, with no optimistic state; a refusal shows as Update failed.

Considered:
- offering `git pull` for a clone too, comparing with origin/main: dropped for now; a clone is a developer's, who pulls by hand;
- reloading the page after the update: the reload row already follows new hub code, so the update is only its precursor;
- running at once regardless of builders: `npm i -g` replaces the files builders' boards are served from, and the restart drops their board servers mid-build.
