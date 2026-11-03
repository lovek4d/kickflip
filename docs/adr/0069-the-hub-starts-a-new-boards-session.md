---
status: superseded in part by ADR-0073, ADR-0110, ADR-0130 and ADR-0143
---

# The hub starts a new board's session itself

Superseded in part by [0143](0143-kickflip-join-adds-the-current-repository-as-a-board.md): the session's first prompt names the board with `--name '<board name>'`, which replaces `--title`.

Superseded in part by [0130](0130-a-failed-start-retries-from-its-sheet.md): a failed start's row reads its name and failed to start, and its error line, Dismiss and Retry are in the sheet the row opens.

[0073](0073-a-new-board-chooses-a-repo-and-branch.md) defines the repo-first sheet and shared clone; the hub still starts the session directly.

Superseded in part by [0110](0110-a-clone-uses-ghs-token-over-https.md): a failed clone shows git's real error line rather than its first line, and the join flags add `--items data/wave.json`.

New board's Start is the confirm. Once the request passes its checks, the hub runs the same start that `web-ts start` runs, with no session in between, so New board needs only the hub server, as [0068](0068-the-hub-session-is-a-dev-time-role.md) requires of every feature. The owner picked this (`hub-start` on hub/INT-169): "The hub starts it as soon as the request passes its checks".

- **What is checked.** `POST /_hub/new-board` (`hub/new-board.mjs`) takes only a name, GitHub `owner/repo`, branch and optional purpose. The name is 1–60 characters and must make a route, lowercase letters, digits and dashes, that no site or Starting row holds. The purpose is at most 240 characters. The repo identity and branch must be valid, and the clone path must stay inside `.repos` without symlink escapes. The route also refuses, with 403, a cross-site request and a body not sent as `application/json` (`starter/cross-site.mjs`), so another site's page can't start a session. A refused request records nothing and starts nothing.
- **Every browser write is guarded.** The hub, board and starter share that guard before every non-GET/HEAD route: a present `Sec-Fetch-Site` must be `same-origin` or `none`, and a present `Origin` must match the request's host (`X-Forwarded-Host`, else `Host`, preserved by the proxy); callers with neither header pass. JSON body routes require `application/json`, while settings forms and raw uploads keep their types. This stops another site's page from changing state even when CORS hides the response; `/_hub/install` keeps its stricter loopback, no-Origin and no-forwarded-headers checks.
- **How it starts.** The hub records the Starting row (`starting[<route>]` in the manifest, with the title, GitHub repo, branch, clone path, phase and request time) and answers `{route}`. It prepares the shared clone, showing Cloning then Starting, and runs `startSession` (`hub/sessions.mjs`) there. The prompt is the board's join flags, `--template board --title … --description …`, each value shell-quoted, as `web-ts start --prompt` passes them. The response doesn't wait for `claude`. The session it starts is recorded on the Starting row as `web-ts start` records one, and the session's join turns the row into the board.
- **A failed start shows at once.** When cloning or starting `claude` fails (not installed, not signed in, a non-zero exit, or no session id comes back), the Starting row keeps the first error line, cut to 200 characters. The row reads Didn't start with that line and Dismiss. A start that runs but never joins still reads Didn't start after 15 minutes.
- **The same session settings.** The session starts with `BG_SETTINGS`, which every hub start and resume passes ([0061](0061-a-boards-session-wakes-when-an-event-arrives.md)): auto mode, worktree isolation off, and the prompt hook that brings its permission prompts and questions to the phone ([0060](0060-background-sessions-prompts-come-to-the-phone.md)).
- **No hub board needed.** No ask goes to the hub board, and New board works with no board flagged `hub: true` and no hub session running.
- **Install builds are unchanged.** [0090](0090-the-hub-runs-a-boards-install-script.md) limits install builds to the owner-set script with fixed arguments. That limit is about install builds and still holds. This start runs `claude` with fixed flags, and the request supplies only the checked repo and branch and the quoted flag values.

Start creates a fresh session in auto mode in the selected repo’s shared clone from any tailnet device. The checks above, and the tailnet's own access, are what stand between a request and that session.

Considered:
- A second confirm tap (`hub-start` B): Start would make a pending row in Needs you showing the folder and auto mode, and a second tap would start the session. It guards against a mistyped folder, at the cost of two taps for every new board.
- Keeping the ask to the hub session and starting directly only while no hub session listens (`hub-start` C): the app keeps the dev-time path [0068](0068-the-hub-session-is-a-dev-time-role.md) says to remove, and the two paths can disagree.
