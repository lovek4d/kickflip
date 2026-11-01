# Codex share sits in the Usage card

The owner picked take B of `codex-share-place` on hub/INT-199: the Always on / Auto / Off control sits in the Hub page's Usage card, in Codex's block under its bars, so the choice sits beside the usage it spends. Hub settings lose the Codex share row and its modal.

- Under Codex's bars: a divider, a "Codex share" caption, the three segments, the current choice's description and the "Applies to every board…" note. The words come from `hub/views.mjs` `hubView`'s `codex`, and a tap posts the same `value` to `/_hub/settings/codex`, which now answers `/_hub/api/hub`'s JSON and redirects without JavaScript to `/_hub/`.
- While share is Off, the Hub page keeps Codex's block with no bars, a "Not used while off" tag and the control, so Codex can be turned back on there. The sidebar still hides Codex's bar while off, and `/_hub/sidebar.json`'s usage is unchanged.
- While `~/.codex/auth.json` is missing, the block reads Codex, Not logged in, with `codex login` to run, and no control, since sharing does nothing then.
- Old `/_hub/#codex` links open Hub with no modal.
