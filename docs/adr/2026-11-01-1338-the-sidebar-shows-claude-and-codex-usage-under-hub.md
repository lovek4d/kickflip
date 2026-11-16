---
status: superseded in part by 2026-11-01-1428-codex-share-sits-in-the-usage-card
---

# The sidebar shows Claude and Codex usage under Hub

Superseded in part by [Codex share sits in the Usage card](2026-11-01-1428-codex-share-sits-in-the-usage-card.md): the Hub page's Usage card keeps Codex's block while share is off or Codex is logged out, without bars.

The owner picked take B of `usage-bar` on hub/INT-187, after checking the live prototype's numbers against Claude's /usage and Codex's /status: two thin bars under the sidebar's Hub row, Claude and Codex, each its 5-hour window.

- The Hub row and its bars are one link to the Hub page, with no pop-up or sheet. The page's first card, Usage, shows both windows for each tool, their reset times and when they were read.
- Bars turn amber from 75% and red from 90%; superseded by [new code restarts on a busy board once no land is landing](2026-11-16-1500-new-code-restarts-on-a-busy-board-once-no-land-is-landing.md), where they follow the pause line. The logo still carries no count.
- Claude comes from `~/.claude/web-ts/usage.json`, which the status line writes ([kickflip installs its own status line and hooks](2026-11-01-1322-kickflip-installs-its-own-status-line-and-hooks.md)); Claude is hidden until it exists.
- Codex comes from `~/.codex/sessions`: the last limits in each of the six newest rollouts, keeping the highest for the newest 5-hour reset, within three minutes. It shows only while `~/.codex/auth.json` exists and Codex share isn't off. `hub/usage.mjs` caches the scan for a minute.
- A reading older than its window reads stale: a grey striped bar and "last seen". Otherwise a window whose reset passed reads as reset.
