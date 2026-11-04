# A clone uses gh's token over https, and a failed start shows git's real error

hub/INT-248 found that no private repo cloned on a Mac whose gh was set to clone over SSH while SSH itself failed: `gh repo clone` follows gh's `git_protocol`, and the anonymous https fallback can't reach a private repo. The Didn't start row then showed git's first line, "Cloning into '…'...", instead of the reason.

- **One https clone.** The hub clones `https://github.com/<owner>/<repo>.git` with `git -c credential.helper= -c 'credential.https://github.com.helper=!gh auth git-credential'` and terminal prompts off (`githubGitArgv` in `hub/repos.mjs`), and fetches the selected branch with the same credential. gh's token is the only credential, whatever gh's `git_protocol` says. A public repo needs no sign-in, so the separate public fallback for the clone is gone. Repo lookup and branches still check a public repo gh can't see with anonymous `git ls-remote`, as in [a pasted GitHub link picks any reachable repo](2026-11-01-1307-a-pasted-github-link-picks-any-reachable-repo.md).
- **The real error line.** A failed clone, fetch or gh command shows git's last line before any blank line and advice, skipping progress lines ("Cloning into …", "remote: Counting objects …", "Receiving objects: …"), with any credentials in a URL removed (`errorLine` in `hub/repos.mjs`). This replaces "the first error line" of [the hub starts a new board's session itself](2026-10-31-0137-the-hub-starts-a-new-boards-session.md) for clones. A `claude --bg` failure still shows claude's first line; with no output it reads "claude exited <code> with no output; check `claude agents`".
- **A new board shows only its own cards.** The join flags add `--items data/wave.json`, and a board join makes a missing items file with no items, so `board.mjs item add` works on the first card.
- **Doctor checks the clone path.** `kickflip doctor` runs `git ls-remote` the same way against the owner's most recent repo from `gh repo list`, or `cli/cli` while gh is signed out or lists none, and reports GitHub clone as yours when it fails.

Considered:
- Telling the owner to run `gh config set git_protocol https`: every host with SSH set up but broken would fail again.
- `gh repo clone -- -c …`: gh still picks the remote URL from `git_protocol`.
