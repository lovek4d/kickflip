# One colour constants file shared by the hub and every board

Every colour lives in `shared/colors.css`: the base palette (`--bg`, `--panel`, `--line`, `--text`, `--muted`, `--accent`, `--ok`, `--warn`, `--bad` and the rest) in light and dark, and the status colours named by what they mean: `--color-quiet`, `--color-info`, `--color-notice`, `--color-danger` and `--color-success`. The board serves it as `colors.css`, which every board page links before `style.css`, versioned like any other asset ([0028](0028-the-board-opens-on-the-last-visit.md)). The hub serves it as `/_hub/colors.css` and links it before each page's inline CSS. Neither `board/public/style.css` nor `hub/hub.mjs` defines a colour of its own, and `board/ui.test.mjs` fails if either one does, or uses a custom property that nothing defines.

Badges consume these constants, as do status lines, agent lines, the CI and review dots, the lane status rings, and the hub's status colours. Each badge tone in `BoardUI.BADGE_TONES` maps to one status colour, so a badge is a consumer of the colours, not where they come from. Status colours are picked by meaning: working or waiting on attention is notice, done or passing is success, failed or offline is danger, link-like status is info, and inactive is quiet. Links, focus rings, the primary button, panels and borders use the base palette.

The owner asked for this: "Colors shouldn't come from badges, the badges and colors should both consume a common design constants set for colors, shared across the hub" (owner, card INT-77).

Considered:
- tokens named after the badge tones (`--tone-notice`) in `style.css`. That makes the badges the source of the colours.
- a copy of the palette in `style.css` and in the hub's inline CSS. The two copies had already drifted: the hub named the orange `--wait`.
- `@import` of the shared file from `style.css`. The browser fetches it only after `style.css` arrives, and it skips the page's asset versioning.

The starter kit's placeholder page keeps its own small palette. It is a page for each site to replace, not part of the board or hub.
