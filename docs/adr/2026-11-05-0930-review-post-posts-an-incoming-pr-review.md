# `review post` posts an incoming-PR review

`board.mjs review post <pr> --file <review.md> --read-at <time>` posts the session's review of an incoming PR, replacing the session's own `gh pr review` and its `claude-bridge` marker by hand ([each board reviews incoming PRs that touch its work](2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md)).

- The PR is one the hub listed in `data/incoming.json` or reviewed before, checked before anything posts, so a post never lands without its record. The repo is `incoming.json`'s, else the board's.
- It posts through REST `POST repos/<repo>/pulls/<n>/reviews` with `event=COMMENT` and `commit_id` the listed head, as the board's `github_login` (token from gh's store), the path `postToPR` uses. The answer's `html_url` is the review's link, which `gh pr review` doesn't print.
- The body is "🤖 Claude review from the <board title> board", the session's words, and `<!-- claude-bridge -->`. Words already carrying the 🤖 prefix, the header or the marker are refused.
- `--read-at` is required, so the session can't skip the check: it refuses, posting nothing, when another review was submitted after that time.
- It records the review as posted with the session's words (no header) and the link as `review_url`.
- `review record` stays for a held review (`--state needs`) and for a PR the session chose to say nothing on. It drops `--url`, so a review reaches GitHub only through `review post`.

The owner (11/05): header names the board title; refuse when a newer review landed; drop `--url`.
