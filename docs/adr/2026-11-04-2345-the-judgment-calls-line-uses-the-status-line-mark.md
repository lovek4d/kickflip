# The judgment calls line uses the status line mark

The judgment calls line in a thread is a `<details>`, so its native triangle sat outside the 18px mark box the other status lines share (docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md). Its summary now starts with the same `.mark` holding a caret icon, the native marker is hidden, and the caret turns down when open. The opened list's left padding is the mark's width plus its margin, so it starts at the text's edge. No per-line margins; `.mark` is the one alignment rule.
