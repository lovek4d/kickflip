# Spotlight's Privacy list is the owner's step

On 11/06 the load average reached 87 while builders made and rebased worktrees: corespotlightd and spotlightknowledged were reindexing `~/.claude/kickflip/worktrees`, and the board held new work as "host busy". The owner asked on #377 that `kickflip init` keep Spotlight off kickflip's folders. #402 settled it.

- **Doctor.** On macOS, the setup group has a **Spotlight** item. It runs `mdfind -onlyin ~/.claude 'kMDItemFSName == "manifest.json"'` and reads the folder as indexed when the result lists `~/.claude/kickflip/manifest.json`. Indexed is **yours**, with the one step: "System Settings › Spotlight › Search Privacy (or Spotlight › Privacy): add ~/.claude/kickflip". Otherwise ok. Linux has no item.
- **Init.** `kickflip init` is `doctor --fix`, which reports after its steps, so init shows the same line and step. It changes nothing for Spotlight.
- **Why the probe asks across ~/.claude.** `mdfind -onlyin <a folder deep under ~/.claude>` returned nothing for every folder tried, indexed ones too, so asking that way reads as excluded. A file found by name with `-onlyin ~/.claude` is a real index entry. A manifest the hub has only just written may not be indexed yet, so a first init can read ok before Spotlight has caught up; the next doctor run says.

Found on this Mac (macOS 26.4, no sudo), and why nothing is automatic:
- A `.metadata_never_index` file in a folder is ignored: files beside it were indexed.
- A `*.noindex` folder is not honoured either. A first build moved `repos`, `worktrees` and `try` into `~/.claude/kickflip/checkouts.noindex` with a link at each old path. A probe wrote a uniquely named file into a plain folder, directly into a `.noindex` folder and two levels below it, and all three were in the index within five minutes; eight checkouts extracted under a `.noindex` folder were all listed by `mdfind -onlyin ~/.claude` (1,504 `.mjs` files), as under a plain one. Spotlight CPU (mds, mdworker, corespotlightd, spotlightknowledged) peaked at 61% (mean 14%) for the `.noindex` burst against 196% (mean 23%) for the plain one, over 40 s, with a load near 20 from other builders, so the difference may be noise. The move was dropped, with the real-path fixes only it needed.
- The Privacy list lives in `/System/Volumes/Data/.Spotlight-V100/VolumeConfiguration.plist`, which only root can read or write, and `mdutil -i off` turns off a whole volume and needs sudo.

Kept from the first build because it holds without the move: `board/transcript.mjs` looks up a run's transcript under the worktree's real path, as Claude Code names its projects folder from its real cwd, so a worktree recorded through a link (a clone stored through `~/.claude/skills/kickflip`) still finds it.
