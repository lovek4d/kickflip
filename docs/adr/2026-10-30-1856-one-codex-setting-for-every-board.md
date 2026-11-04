---
status: superseded in part by 2026-11-01-1428-codex-share-sits-in-the-usage-card, 2026-11-01-1521-codex-share-follows-whether-codex-is-usable, 2026-11-01-1322-kickflip-installs-its-own-status-line-and-hooks and 2026-11-01-2355-the-hubs-codex-share-is-the-only-codex-setting
---

# One Codex setting for every board

Superseded in part by [Codex share sits in the Usage card](2026-11-01-1428-codex-share-sits-in-the-usage-card.md): the control sits in the Hub page's Usage card, not a Codex share row.

Superseded in part by [Codex share follows whether Codex is usable](2026-11-01-1521-codex-share-follows-whether-codex-is-usable.md): a missing value means Auto while Codex is usable, and the setting reads Off while Codex isn't installed or logged in.

Superseded in part by [kickflip installs its own status line and hooks](2026-11-01-1322-kickflip-installs-its-own-status-line-and-hooks.md): sessions read the setting through the kickflip-hooks plugin's `hooks-plugin/hooks/codex-share-auto.mjs`, in this repo.

Superseded in part by [the hub's Codex share is the only Codex setting](2026-11-01-2355-the-hubs-codex-share-is-the-only-codex-setting.md): no session's own `/codex-share` overrides the hub's setting.

The owner chooses once in the hub page’s Codex share row how every board uses Codex, so boards share one default instead of needing a choice on each board. The Codex setting is `codexShare: "auto" | "always" | "off"` in `~/.claude/web-ts/settings.json`, beside polling, notifications and rules; a write preserves every other key, and a missing value means Off. The three-way control saves each choice at once, and `web-ts codex-share [auto|always|off]` reads or sets the same value.

- **Auto:** Codex builds and reviews; while Codex is out of usage, Opus builders take over until it resets.
- **Always on** (`always`): Codex builds and reviews; while Codex is out of usage, that work pauses until a usage-reset check succeeds.
- **Off** (`off`, also when unset): no Codex.

Every Codex run uses `gpt-6.1-sol` at high effort.

Sessions read the setting through the codex-share hook, `~/.claude/hooks/codex-share-auto.sh`, outside this repo. The hub only stores, shows and sets the value. A session's own `/codex-share` overrides it for that session.
