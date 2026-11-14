# A builder guard refuses git push and broad kills in builder sessions

The Claude Code Insights report (T-149) found a broad `pkill` that could hit other cards' runs, and a builder that pushed a draft PR despite "never push" (#678).

- **A PreToolUse hook on Bash refuses them.** `hooks-plugin/hooks/builder-guard.mjs`, registered in the plugin's `hooks.json`, denies `git push` (with any `-C`/`-c` options before it), `pkill`, `killall` and a `kill` of a process group (`kill 0`, `kill -- -PGID`, `kill -SIG -PGID`). The reason says what to do instead: commit and finish with `builder done`, or stop one process by its pid.
- **A builder session is one whose cwd is inside `~/.claude/kickflip/worktrees/`.** Every builder and writing helper works in a worktree there, and the orchestrator and interactive sessions don't. Looking a session id up in the builder records would need a scan of every board's records on each Bash call, and the cwd answers the same question.
- **The board's own pushes aren't blocked.** The PR push and the post-land push run inside node, not through the Bash tool.
- **`git add` stays allowed in every form** (owner, `t323-add`): builders commit their work in their own worktrees, so `git add -A` and `git add .` pass.
- **Commands are split, not grepped.** Quoted text stays one word, so `echo "git push"` and `rg pkill` pass.
