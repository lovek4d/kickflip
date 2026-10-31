# One Codex setting for every board

The owner chooses once on Hub Settings how every board uses Codex, so boards share one default instead of needing a choice on each board. The Codex setting is `codexShare: "auto" | "always" | "off"` in `~/.claude/web-ts/settings.json`, beside polling, notifications and rules; a write preserves every other key, and a missing value means Off. The three-way control saves each choice at once, and `web-ts codex-share [auto|always|off]` reads or sets the same value.

- **Auto:** Codex builds and reviews; while Codex is out of usage, Opus builders take over until it resets.
- **Always on** (`always`): Codex builds and reviews; while Codex is out of usage, that work pauses until a usage-reset check succeeds.
- **Off** (`off`, also when unset): no Codex.

Every Codex run uses `gpt-6.1-sol` at high effort.

Sessions read the setting through the codex-share hook, `~/.claude/hooks/codex-share-auto.sh`, outside this repo. The hub only stores, shows and sets the value. A session's own `/codex-share` overrides it for that session.
