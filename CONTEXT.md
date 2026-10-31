# Web-ts hub and boards

Pages on Love's tailnet that Claude sessions serve, so the owner can follow and steer their work from a phone. The hub lists the sites and sends pushes. A board is a site that shows a session's work as cards.

## Language

### Hub and sites

**Kickflip clone**:
The Git checkout that supplies the running app's code, in any folder such as `~/dev/kickflip`, linked into Claude Code's skills by install. It is separate from the live state in `~/.claude/web-ts/` ([0071](docs/adr/0071-kickflip-runs-from-a-linked-clone.md)).
_Avoid_: live skill folder

**Board repo**:
A project's shared checkout under the kickflip clone's `.repos/<owner>/<repo>`, chosen from GitHub when making a board. Each board keeps its own branch, and its builders work in separate worktrees based on that branch ([0073](docs/adr/0073-a-new-board-chooses-a-repo-and-branch.md)).
_Avoid_: repo folder (for the repo choice)

**Hub**:
The one server on the Mac that answers the tailnet address, lists every site, forwards to each, checks GitHub for the open PRs on boards' cards, and sends pushes. Changes on the hub, boards and starter sites come from the app's own pages or non-browser clients; another site's page cannot act on them ([0069](docs/adr/0069-the-hub-starts-a-new-boards-session.md)).
_Avoid_: portal, gateway

**Sidebar**:
The list of every site beside each board and hub page: Hub and Settings, then Turn on notifications when needed, then Pages (sites that aren't boards), then Boards with their status words, lane chips and waiting counts. The last row of Boards is **New board**, a + tile opening a sheet that chooses a GitHub repo first, then its branch, Name and optional What it’s for. Start is the confirm: the hub starts the board’s session itself once the request passes its checks; a muted, non-link row reads **Cloning…**, then **Starting…** until its route joins. When claude fails to start, or after 15 minutes without a join, it reads **Didn’t start**, with Dismiss, and with the clone or session error line when there is one ([0069](docs/adr/0069-the-hub-starts-a-new-boards-session.md)). Settings carries notification problems in its sub line and stays selected on Hub Settings and its child pages, including Polling. Boards and Pages stay apart wherever sites are listed. The header's logo toggles it at every width; it carries no count. From 900px it is a rail, which its own logo collapses out of sight until the header's logo brings it back; narrower, it is a drawer. Its header reads Kickflip. Below 900px every page header is a bottom bar, and the drawer header sits at its foot under New board; desktop headers stay at the top ([0070](docs/adr/0070-phone-headers-sit-at-the-bottom.md)). In the **app shell** it is mounted once, beside every view, Settings and framed pages included, and a site's row swaps the view in place. `/` opens this device's **last board**, which the app shell stores as each board opens, never a page ([0050](docs/adr/0050-a-sidebar-of-every-board-replaces-the-hub-home.md), [0055](docs/adr/0055-one-app-for-the-whole-hub.md)).
_Avoid_: hub home, switcher, nav

**Switch mode**:
The sidebar showing each linked row's key after s is pressed twice outside a text field: the first nine boards' numbers on their tiles, and every linked row's letter from its name, underlined. The next key opens that row in place; Escape, a click or 3 seconds with no key ends it. Boards claim letters first, in the order they joined the hub, so a new board never takes another board's letter ([0056](docs/adr/0056-switch-mode-letters-come-from-names-in-join-order.md)).
_Avoid_: shortcuts, hotkeys, jump mode

**App shell**:
The one page a browser's load of `/`, a hub page or any site's page gets, `board/public/app.html`: the sidebar, mounted once, beside one **view** at a time, and the hub's one stream, `/_hub/stream`. Following a link to a view swaps it in place, with no reload, and leaving one with an unsaved edit asks first. Every URL stays a real address. The board server answers a board's four view paths with the shell too, and the hub every load of `/_hub/`, `/_hub/settings` and `/_hub/settings/polling`, so curl and a frame get it; a frame's shell hands its URL to the app around it. While the Mac can't be reached, the hub's service worker opens the last shell the hub served, with its last sidebar, and each view shows its own offline state ([0055](docs/adr/0055-one-app-for-the-whole-hub.md)).
_Avoid_: SPA, wrapper, frame

**View**:
One page's content in the app shell, mounted when its URL opens and unmounted, with every listener, timer and stream it added, when another takes its place. A board is a view, and so are its Settings, Waiting on you and Notes, and the **hub page**, **Hub Settings** and Polling; a board left and opened again paints from its **last visit**, live when its stream sent no change since. Any other page, another site's or a board's prototype, is a **frame view**: the page in a frame beside the board header, or its own when it draws that header, with Open alone ↗ to load it by itself.
_Avoid_: screen, tab, page (a page is its own document)

**Page tree**:
The levels back climbs in the app shell: a board, its Waiting on you, then a separately opened prototype page tied to one of its questions by `?q=`. On each, the back arrow, the browser's back and a swipe all go up one level: from a prototype to Waiting on you on its question, from there to the board, with the card still open when the owner left the board from that card's thread. However the owner arrives, by a push, a link or a reload, the levels above are written into history under the page first ([0058](docs/adr/0058-back-follows-the-page-tree.md)).
_Avoid_: nav stack, breadcrumbs

**Hub page**:
The hub's status page, `/_hub/`, which the sidebar's Hub row opens: the **pending prompts** of sessions that own no board, each site's health with each board's hub links and watcher, each session's remembered Always allow rules read-only under its board, polling and notifications ([0050](docs/adr/0050-a-sidebar-of-every-board-replaces-the-hub-home.md), [0060](docs/adr/0060-background-sessions-prompts-come-to-the-phone.md)).
_Avoid_: dashboard, console, hub home

**Board registry**:
`hub/boards.mjs`, the only hub code that reads a board's `board.json` and wave files. Every hub feature that serves boards (the GitHub check, wakes, rules, the handshake, the not-listening push) takes its boards from it, so a board over the waves and a board over its own file get the same links ([0040](docs/adr/0040-one-board-registry-for-every-hub-feature.md)).
_Avoid_: board list, wave boards and file boards (as separate code paths)

**Site**:
A route on the hub (`/<route>`) served by one owning Claude session.
_Avoid_: app, page (a site has several pages)

**Owner**:
Love, the person the sites serve. The word for the session that serves a site is **owning session**.
_Avoid_: user, admin

**Board session**:
A board's owning session as the manifest records it in the site's owner: its id, its folder (`repo`, where `claude --resume` finds it) and an optional model. `web-ts start` launches one in the background; `web-ts resume` brings it back and records the id it comes back under. A rejoin keeps the label, model and folder it leaves out.
_Avoid_: orchestrator process, agent

**Hub session**:
The dev-time session that builds the app from inside: the owning session of the **hub board**, the one board whose manifest entry has `hub: true` (`web-ts set <route> --hub`), opened in the owner's terminal by `web-ts hub`. Code finds the hub board by that flag, never by its route. The product needs only the hub server, with boards added in the app, and no feature depends on this session ([0068](docs/adr/0068-the-hub-session-is-a-dev-time-role.md)).
_Avoid_: hub server, permanent orchestrator

**Live**:
A session whose `~/.claude/sessions/<pid>.json` record names it and whose process still runs, started when the record says. A live session is never started or resumed again.

**Listening**:
A board is listening while its owner session is live and a watcher runs for it. A watcher outlives its session, so a watcher alone isn't listening. A board that isn't listening is **asleep** or deaf. The board header, the sidebar, the events link and the not-listening push read that state, and the **session wake** uses this test ([0061](docs/adr/0061-a-boards-session-wakes-when-an-event-arrives.md)).

**Asleep**:
A board whose owner session isn't live but that the hub can wake on its next event: a session and folder are recorded, and no **session wake** of this outage has failed or gone unanswered. It reads a muted Asleep in the sidebar, its events link passes, and it gets no not-listening push. A board that is neither listening nor asleep is deaf and reads Not listening in red ([0061](docs/adr/0061-a-boards-session-wakes-when-an-event-arrives.md)).
_Avoid_: idle, stopped, offline

**Session wake**:
The hub resuming a board session as soon as an event lands while that session isn't live, or, as a fallback, once its board hasn't been listening for 3 minutes with an event its session hasn't heard. Once per outage, then one push to the owner if the board still isn't listening 5 minutes later. A session that idles out with nothing waiting stays stopped ([0061](docs/adr/0061-a-boards-session-wakes-when-an-event-arrives.md)).
_Avoid_: auto-resume, respawn, wake (a daily wake is the morning `check-github`)

**Push**:
A notification from the hub, on the phone or a desktop browser, that opens a page. Each push has a kind, and `hub/push.mjs` `deliver()` refuses any other: `action` when a card's **Action needed** appears or changes, `prompt` for a **pending prompt**, `fault` for what only the owner can fix (a board not listening, a session that didn't come back, an urgent production problem) ([0006](docs/adr/0006-pushes-only-when-something-waits-on-the-owner.md)). Answers, merges, Stale and other news never push; the threads' unread marks and the board carry them. Questions, steps and prototypes go at once; drafts on Ready and Merge go when their tick ends; each arrives as its own notification, and one under a card's tag replaces the last and alerts again ([0030](docs/adr/0030-pushes-go-by-kind-and-each-arrives-on-its-own.md)). Replies don't push; a push that goes out anyway says how many came since the last one. With notifications off every push is dropped; a snooze and Off on weekends hold pushes until they end, and urgent ones go through those holds ([0032](docs/adr/0032-notifications-can-be-off-snoozed-or-off-on-weekends.md)). While the owner is **at the Mac**, an action push goes to the Mac only ([0065](docs/adr/0065-pushes-go-to-the-mac-only-while-the-owner-is-at-it.md)).
_Avoid_: alert, notification (for the act of sending)

**At the Mac**:
The owner's presence that keeps pushes off the phone: the Mac's screen is unlocked and a key or the pointer was used in the last 3 minutes, whatever app is in front (`hub/presence.mjs`). Then an action push goes only to the desktop subscriptions, and the phone never gets it later; prompts, faults and urgent pushes still reach the phone, and with no desktop subscription every push does. Otherwise the owner is away and every push goes to every device ([0065](docs/adr/0065-pushes-go-to-the-mac-only-while-the-owner-is-at-it.md)).
_Avoid_: active, online, desktop app active

**Polling interval**:
The hub's one schedule, a list of windows with their minutes: on each slot it checks GitHub, wakes a board's owning session with `github-change` when a PR on its cards changed, pushes once for each board that isn't listening, then sends the queued pushes. At each daily wake time it also sends each board one `check-github {reason: "morning"}`, changed or not. With hold pushes overnight on, pushes queued in the last window wait for the first window's start ([0025](docs/adr/0025-the-hub-polls-github-and-sends-pushes-on-one-interval.md)).
_Avoid_: push schedule, send-at-once hours, cron

**Hub Settings**:
The page opened by the hub pages' gear and the sidebar's Settings row, `/_hub/settings`: first this device's notifications, push notifications on or off, snooze, off on weekends, whether the owner is **at the Mac**, a Polling row opening the page that edits the polling interval, hold pushes overnight and daily wakes, then the **Codex setting** and the rules for every board. A board's gear opens that board's own Settings, which holds its repo and branch, auto-merge toggle, reviewers and its own rules, then Close board with a typed-name confirmation. Hub Settings also lists **closed boards** with Reopen.
_Avoid_: preferences, hub config

**Codex setting**:
The one choice on Hub Settings for every board: Auto has Codex build and review, with Opus builders taking over while Codex is out of usage until it resets; Always on has Codex build and review, with that work paused while Codex is out of usage until a usage-reset check succeeds; Off, also when unset, means no Codex. A session's own `/codex-share` overrides it for that session ([0066](docs/adr/0066-one-codex-setting-for-every-board.md)).
_Avoid_: Codex rule, board Codex toggle

**Waiting count**:
The badge on a site's row in the sidebar: how many things the site's `GET /_claude/needs` lists as waiting on the owner. It is unknown, with no badge, when the site doesn't answer. The Home Screen app's badge is the sum over every site.
_Avoid_: unread count, inbox

**Status word**:
The coloured word that leads a site's sub line in the sidebar when something urgent holds, most urgent first: Down, Not listening (a board that is neither **listening** nor **asleep**), Starting, Working, "N need you", Asleep (muted) or Building. Lane chips with the site's open-card counts follow it; a calm site shows only the chips ([0037](docs/adr/0037-the-hub-home-shows-status-not-descriptions.md)).
_Avoid_: activity line, subtitle

### Boards

**Board**:
A site built from the board template that shows one or more waves as cards in lanes.
_Avoid_: dashboard, kanban

**Closed board**:
A board whose session and server have stopped and whose sidebar row is gone, with its folder, cards, threads and notes kept on this Mac. Hub Settings lists it under Closed boards; Reopen restores it and resumes its recorded session. Open PRs stay on GitHub, and running builder records end with a note ([0072](docs/adr/0072-a-closed-board-keeps-its-folder-and-can-be-reopened.md)).
_Avoid_: deleted board, archived board

**Hub links**:
What the hub owes a board, each passing or broken: GitHub polling, events (the board is **listening**), daily wakes, pushes (a device is subscribed) and reviewer links. The hub link (the hub runs the code in its files) is the hub's own, shown in amber only on the sidebar's Hub row and the hub page's Health card ([0064](docs/adr/0064-every-builder-works-in-a-worktree.md)). The In Review header's GitHub mark opens them as a sheet, red-dotted only while one stays broken past its grace period; until then it is **settling** ([0046](docs/adr/0046-hub-links-turn-red-only-after-a-grace-period.md)). A new board tests them with a **handshake**: a `hello` event the session answers with `board.mjs hello-ack`, with a Connecting checklist on the board until the session answered and GitHub checks reach it ([0040](docs/adr/0040-one-board-registry-for-every-hub-feature.md)).
_Avoid_: health, status, integrations

**Change signal**:
The board server's note on its `api/stream` that a file the board reads changed; the hub passes it on as `change {route}` on its one stream, and an open board reloads at once. The header's time counts from the last one that brought something new, or the last ↻ tap ([0031](docs/adr/0031-the-board-reloads-on-a-change-signal.md)).
_Avoid_: push (a push is a notification from the hub), live update

**Wave**:
A set of work items built and reviewed together, with its reviewers and follow-ups.
_Avoid_: batch, sprint, epic

**Reviewers**:
The people who get a board's PR links once they are ready, and the weekday digest. Each board keeps its own in `board.json`, which its Settings page lists, and a new wave copies them into its own `reviewers`.
_Avoid_: approvers, watchers

**Finished wave**:
A wave with work items that are all merged, done or dropped. Done shows it as one row that opens to its cards, and it leaves the wave filter ([ADR 0012](docs/adr/0012-lists-never-cut-silently.md)).
_Avoid_: closed wave, archived wave

**Work item**:
One unit of work in a wave, usually one PR. Its key is `<wave>/<id>`.
In Todo, including while held, a card with a known creation time shows a muted "N days ago" once it is two full days old, counting whole days since creation.
_Avoid_: task (a **new task** is the owner's), ticket (a ticket is the Linear issue it may link to)

**Internal item**:
A work item about the sites themselves rather than the product. Its card shows its **ref**, `INT-<n>`, where other cards show Linear chips; a stored id `S<n>` reads `INT-<n>`.
_Avoid_: meta task, chore

**Badge**:
A chip on a card or page that shows a status, such as Action needed, Install, a PR's state or "held". It may link to what it is about: on a closed card, Action needed and Install go straight to the thing to act on (owner, question `badge-tap`). A badge never acts on the board; a **button** does.
_Avoid_: chip (in what the owner reads), tag, label

**Button**:
A control that acts: it sends something to the board, such as Merge, Hold or Grill, or opens a place to act, such as Open questions. The open card's workflow row holds a follow-up's Build, Merge, Hold or Resume, then the **action button**, below the details list whose final line holds Notes, Install and Review on GitHub links in that order ([0067](docs/adr/0067-a-cards-external-links-share-the-last-details-line.md)). A card that can be bumped carries its bump as an icon at its top right instead, closed or open, as a New card does; it confirms like a button ([0019](docs/adr/0019-a-card-that-hasnt-started-can-be-bumped.md)). The control that clears the card's **Action needed** is orange.
_Avoid_: badge, pill (a pill is only a look)

**Badge tone**:
The color of a badge (a status chip on a card or page), picked from one fixed set by what the badge says, through `BoardUI.badge` in `board/public/ui.js`: quiet (gray), normal (blue), notice (orange), danger (red) or ready (green). Each tone takes its color from a **status color**, so a badge is one consumer of the colors, not their source. No badge has a look of its own, so the same tone looks the same everywhere. Buttons and links styled like chips, such as quick replies, a follow-up's Build and "Review on GitHub →", aren't badges; the orange of the button that clears Action needed is the same notice color.
_Avoid_: chip color, badge style, variant

**Status color**:
A color named by what it means, `--color-quiet`, `--color-info`, `--color-notice`, `--color-danger` or `--color-success`, in `shared/colors.css` beside the base palette, in light and dark. That file is the one set of colors for the hub and every board; no page's CSS defines a color of its own ([0033](docs/adr/0033-one-colour-constants-file-shared-by-the-hub-and-every-board.md)). Working or waiting on attention is notice, done or passing is success, failed or offline is danger, link-like status is info, and inactive is quiet.
_Avoid_: tone token, theme color, badge color

**Follow-up**:
A Linear ticket filed while building a wave. It is a Todo card of that wave, with a Follow-up badge, until it is done, and an open one keeps its wave unfinished ([0034](docs/adr/0034-follow-ups-are-todo-cards-of-their-wave.md)).
_Avoid_: backlog item, todo

**Lane**:
Where a card sits (In Review, Stale, In Progress, Todo, Done), set by who acts next ([0045](docs/adr/0045-the-lane-follows-who-acts-next.md)). In Progress means Claude or a builder is working: a running builder, a **checking** item, or a PR whose CI is red or, on a draft, still running. Building and fixing count only while a builder record on that card is open; otherwise its PR and other state place it as if that status were absent. In Review means finished work waits on a person: the reviewers, or the owner's Ready, Merge, manual steps or an ask's Done (see **Action needed**). A card waiting only on those moves there from In Progress; one Claude still works on stays in In Progress. Todo holds work not yet started: the New cards, which wait on Claude ([0047](docs/adr/0047-the-plus-makes-a-new-card.md)), and any card that hasn't started and waits only on its open questions or a prototype pick, with Action needed. Answering them moves it to In Progress as its work starts; a started card that gets a question keeps its lane ([0059](docs/adr/0059-an-unstarted-card-waits-on-its-questions-in-todo.md)).
_Avoid_: column, status (status is the item's own field)

**Checking**:
The item status a builder sets when it hands back finished work. The card sits in In Progress reading "Orchestrator review" while the owning session verifies it, then the session sets it done. Only done, merged and dropped unblock dependents ([0022](docs/adr/0022-site-cards-build-in-parallel-when-their-files-dont-overlap.md)).
_Avoid_: verifying, in QA, review (review is the reviewers' part)

**Stale**:
A work item that has waited in review more than seven days since its first review link went out. Its card moves to the Stale lane ([0044](docs/adr/0044-a-pr-in-review-shows-its-age-and-goes-stale-after-seven-days.md)).
_Avoid_: old, overdue

**Next step**:
Claude's next step on a card and what sets it off, such as "Next: merge when CI is green", kept in the item's `next` and cleared once done. A card waiting on its reviewers reads its next step from GitHub instead ([0002](docs/adr/0002-a-card-derives-its-lane-from-github.md)), and one waiting on the owner reads its action.
_Avoid_: plan, notes (**Notes** is the card's write-up), todo

**Waits on**:
Who the card is waiting for: the owning session's check, the owner's Ready, the owner's other action, the builder, the reviewers, the merge, or nobody.
_Avoid_: blocked by, assignee

**Action needed**:
The notice-tone badge on a card waiting on the owner, in any lane: an open question or a prototype pick, a green draft's Ready, an ask's Done, manual steps on an approved PR, or, with **auto-merge** off, an approved PR's Merge. It links to the thing to act on. Reviewer waits and held cards get none ([0045](docs/adr/0045-the-lane-follows-who-acts-next.md)). An unstarted card with open questions carries it in Todo ([0059](docs/adr/0059-an-unstarted-card-waits-on-its-questions-in-todo.md)).
_Avoid_: open items, needs you (Needs you is the box at the top of the board)

**Action button**:
The open card's one workflow button, which `board/domain.mjs` picks as the card's `actionButton`: **Open questions** (`openQuestions`) while it has open questions or a prototype pick, opening the first; **Mark as done** (`markDone`) on an ask waiting only on the owner's Done, sending the same `ask-done` as the thread's Done; otherwise **Grill** (`grill`), which reads "Writing questions…" while a grill waits on Claude. Open questions win over Mark as done. A Done card, and an ask with neither, has none ([0059](docs/adr/0059-an-unstarted-card-waits-on-its-questions-in-todo.md)).
While the card carries **Action needed**, the button that clears it is orange, in the notice color: the card's `resolvedBy` from `board/domain.mjs`, by the action's kind. A question or a pick makes Open questions orange, an ask's Done makes Mark as done and the thread's Done orange, a green draft's Ready or manual steps make Review on GitHub orange, and an approved PR's Merge makes Merge orange. A held card's Open questions, and Grill, stay plain. A follow-up's Build is always orange.
The button names (`BUTTON`: the action buttons, `github` and `merge`) and the action kinds (`ACTION_KIND`) are two frozen enums in `board/public/ui-enums.js`, which the page loads as a script and `board/domain.mjs` runs in a vm context; code compares against their members, never a bare string.
_Avoid_: Open items, Action needed (the badge)

**Auto-merge**:
A board setting, `auto_merge` in its `board.json`, off unless set: on, monitor merges a PR once it is approved, CI is green and its merge state is CLEAN; off, the card shows the owner Action needed and a Merge button, which reads "Merging…" until the PR merges or Claude says in the thread why it didn't. The board's Settings page toggles it, and the watcher prints it with every wake as `setting auto-merge on|off`. A setting, not a **rule**, since the board itself acts on it ([0052](docs/adr/0052-auto-merge-is-a-board-setting-off-by-default.md)).
_Avoid_: merge rule, merge policy

**Review on GitHub**:
The open card's link to its PR, on every card with an open PR, last on the details list's final line after Notes and Install when present. It reads "Review draft on GitHub ↗" on a draft and "Review on GitHub ↗" once ready, with no PR number, and is orange while a green draft's Ready or manual steps wait on the owner ([0067](docs/adr/0067-a-cards-external-links-share-the-last-details-line.md)).
_Avoid_: Review #<n> on GitHub, PR link

**Install**:
The link on a device-app card that installs its build on the owner's phone, last in its badge row and between Notes and Review on GitHub on the open card's final details line. A new push triggers a rebuild: while an install builder works, both read "Rebuilding…" in builder orange and ask before installing the older build, or "Building…", inert, before the first install; without a build running, "older build" means the PR moved past the installed build, and the install leaves the card in Done ([0051](docs/adr/0051-a-device-app-card-carries-an-install-link.md), [0067](docs/adr/0067-a-cards-external-links-share-the-last-details-line.md)).
_Avoid_: download, TestFlight (a different channel), build link

**Install script**:
The script the owner chooses on a board's Settings to build its cards' device installs. The hub runs it from the Mac's GUI session, where signing can use the unlocked login keychain, and reports each build in the card's thread ([0067](docs/adr/0067-the-hub-runs-a-boards-install-script.md)).
_Avoid_: install command, session install runner

**Notes**:
The owning session's understanding of a work item so far: what was asked, what is settled, what is open. A Markdown file in its wave's folder that the item names in `plan` (`item set --notes-file`), rewritten as the grill settles things, or with no file the item's short `notes` text. "Notes ↗" opens them as a page sized for the phone, first on the open card's final details line before Install and Review on GitHub; the board keeps no summary of them and a card with no notes omits the link. The thread keeps the short news ([0053](docs/adr/0053-notes-replace-the-full-plan-and-cards-start-on-their-own.md), [0062](docs/adr/0062-notes-is-a-link-in-the-details-list.md), [0067](docs/adr/0067-a-cards-external-links-share-the-last-details-line.md)).
_Avoid_: full plan, plan, spec

**Held**:
A work card the owner paused with its Hold button. It doesn't start, and a running one gets no new work, until the owner taps Resume ([0023](docs/adr/0023-a-card-can-be-held-and-every-card-button-confirms.md)). Every action-row button asks to confirm first, through `B.confirm` (`dialogs.js`).
_Avoid_: paused, frozen, on hold (as a status name)

**Builder**:
An agent (Opus, Codex, Sonnet…) working on a work item, with one builder record each (`board.mjs builder … --agent <name>`; the first is `main`). The record holds its label, kind, start, ETA and finish, not its progress. Each progress line (`builder progress`, which needs `--site`) goes only to the card's thread, as a **status line** ("Codex: Running the benchmark"; the main agent's has no prefix), shown as one line with no bubble. The card's status line under its title is the thread's newest status line since its earliest running agent started, with its age, behind a pulsing dot as Orchestrator review and Working on it have, and an optional "ETA about 4:30 pm" line under it (owner ask on INT-76). In the thread every status line stays orange, dot included, whether its agent is working or done (owner, card INT-77). `builder done` marks the record done and keeps it; closing the card’s last open builder record clears its building or fixing status. Linking a PR clears either status too. The thread shows each record as **agent lines** among its messages, with no bubble: "Opus builder started" at its start, always orange and with its ETA while the agent runs, and "Opus builder finished" at its finish, the only green one (owner, question `int42-agents-look`, option C; owner ask on INT-63). The session's own thread summary closes the work.
_Avoid_: worker, bot

**Stalled**:
A builder still recorded as running whose last progress, or start before its first progress, was at least 30 minutes ago. Its card carries a red Stalled button until fresh progress or completion; silence calls for a check, without establishing that the process has failed.
_Avoid_: stuck, hung, failed

**Worktree**:
The git worktree a builder works in, never the folder the session, a running app or the hub uses. A board's is `~/.claude/web-ts/worktrees/<card id>` on branch `<card id>` from its chosen repo branch, or the running kickflip clone's main for a board without a GitHub repo, made by `board.mjs builder start --worktree` and kept on the builder record; the owning session checks and commits there, then **lands** it (`board.mjs land`): rebased onto main, tested, fast-forwarded into the live folder's main, the hub or board servers restarted, the worktree and branch removed. A repo card's comes from wave-build ([0064](docs/adr/0064-every-builder-works-in-a-worktree.md)).
_Avoid_: copy, checkout, live folder (for the builder's)

### Talking with the owner

**New task**:
A free-form request or question the owner sends from the board's + button (or by pressing n twice). Code and events call it an **ask**: an `ask` event whose thread is `ask:<event id>`. It is a **New card** at the top of Todo, with no wave and no Action needed, until Claude sorts it one of three ways ([0047](docs/adr/0047-the-plus-makes-a-new-card.md)): files it under a wave as a work item, whose thread opens with it (`item set --from-ask`); folds it into the card it's about, whose thread then holds the message marked Moved (`item relate-ask`, undone by `ask unfold`); or answers it, which makes it a Done card reading Task, under Done's Answered row, whose thread takes the owner's later replies. An answer that leaves a question open on it keeps it in Todo as a Task with Action needed, never in Done, until the owner answers and Claude replies, or it is closed ([0059](docs/adr/0059-an-unstarted-card-waits-on-its-questions-in-todo.md)). When another board fits it better, the owner can have it **moved there** (`ask move`): it becomes a New card on that board reading "Moved from <this board>", and here a Done card whose thread links to it. Folding is within one board; a move is between boards. An answer that waits on the owner, such as a choice only the owner can settle, keeps it in In Review with Action needed until the owner taps Mark as done or the Done in its thread ([0035](docs/adr/0035-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md)).
_Avoid_: ask (in what the owner reads), message, prompt, Waiting for Claude strip

**Thread**:
The conversation on one work item: Claude's reports, builders' status lines, the owner's messages, mirrored GitHub comments, and answers to the item's questions. On a card not in Done, its reply form has a Done, left of Send, that closes the card ([0035](docs/adr/0035-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md)).
An open card shows its thread's newest 3 messages as it opens, or from its oldest **unread message** when more than 3 are unread, unread as of when the card opened. Messages that arrive while it is open add below, hiding none. Messages are the owner's, Claude's (replies included) and other people's; builder, status and ask-link lines show among the messages they sit between and don't count. "Show more · N previous messages" at the top adds the next 3 older messages each tap and goes when nothing older is left. The expansion lasts while the card stays open, through repaints and new messages, and closing the card puts it back to 3. A message being edited, or waiting on Claude, always shows, with every line after it.
_Avoid_: comments, chat

**Unread message**:
A line in a card's thread written by someone other than the owner, apart from builder status lines, newer than when this browser last opened that thread. The card shows an accent "N new" chip first in its chip row, before Action needed, until it is opened.
_Avoid_: inbox, notification. "New" names it only in the chip's "N new"; a New card is an unsorted ask.

**Last visit**:
The board and threads this device last showed, kept in its browser storage. The next visit paints it dimmed at first paint, readable at any age, with the controls that send held until the fresh board lands and replaces it in place, flashing a fading orange border round each card or line that changed ([0028](docs/adr/0028-the-board-opens-on-the-last-visit.md)). A board the app shell left fresh and comes back to with no change since paints it live instead ([0055](docs/adr/0055-one-app-for-the-whole-hub.md)). In code it is the snapshot.
_Avoid_: cache, offline copy, stale board

**Answer banner**:
The one line at the top of a board, above Needs you, naming new tasks Claude answered without making work whose answer this browser hasn't seen: "1 answer · <ask>" or "2 answers · <newest> and 1 more". A tap opens the newest one's card; ✕ hides it on this device until a newer answer. No push goes for an answer ([0006](docs/adr/0006-pushes-only-when-something-waits-on-the-owner.md)).
_Avoid_: notification, toast

**Owner question**:
A multiple-choice question Claude needs the owner to decide, attached to a topic. A builder's judgement call becomes one. One marked **urgent** blocks a build or a merge and shows alone; Claude resolves a question in the step that acts on its answer ([0043](docs/adr/0043-needs-you-gathers-what-waits-and-questions-answer-on-one-page.md)), and closing a card resolves each of its questions that has an answer; one with no answer yet stops the close unless forced.
_Avoid_: poll, decision card

**Topic**:
The group an owner question belongs to; an item's questions use the topic `item:<wave>/<id>`. A Done card's topic with no open question is resolved, so it never waits on Claude.
_Avoid_: category, section

**Needs you**:
The box at the top of a board listing what waits on the owner, one line per work item, led by the board session's **pending prompts** ([0043](docs/adr/0043-needs-you-gathers-what-waits-and-questions-answer-on-one-page.md)).
_Avoid_: inbox, digest

**Pending prompt**:
A permission prompt or `AskUserQuestion` from a background board session, which its hook hands to the hub and holds the session on until the owner answers in the board's Needs you, or the hub page for a session that owns no board: Allow once, Always allow or Deny, or the question's options. Always allow returns the session rule to Claude Code and keeps that same rule in the hub's `prompts.json`, keyed by session id. The hub remembers rules only with a reliable process start time and binds board rules to the current ownership's `owner.since`; ownership commands clear remembered rules and pending prompts for both the old and new sessions, including boardless entries, even while the hub is stopped. A later exact match on its command, absolute path, domain or bare tool name is allowed immediately, with no push or Needs you line; prefixes and globs never widen a match, and `AskUserQuestion` always asks. Rules end when the session stops or its board's owning session changes, and the hub page lists them read-only under the board. With no answer in 10 minutes the call is denied with a note to ask on the card instead ([0060](docs/adr/0060-background-sessions-prompts-come-to-the-phone.md)).
_Avoid_: permission request, approval, dialog

**Event**:
A signal that wakes the owning session: something the owner did on a page (an ask, an answer, a button), or a board change such as `card-unblocked {key}` when a waiting card’s last unfinished dependency finishes ([0020](docs/adr/0020-cards-wait-on-explicit-blocked-by-links.md)).
_Avoid_: action, request

**Rule**:
A standing instruction from the owner to the sessions that own boards, one line of text kept on Settings. Hub rules apply to every board; each board adds its own on top. The watcher prints both with every wake, and a save wakes each session to say what changes. One Claude codified on the owner's word reads "Added by Claude" ([0039](docs/adr/0039-rules-live-on-settings-at-hub-and-board-level.md)).
_Avoid_: preference, setting, policy

**Reply**:
Claude's answer to one event, shown under it on the page.
_Avoid_: response, comment

**Pending message**:
A New card's message, or the owner's message in a thread, that Claude hasn't answered yet: no reply, and in a thread no later Claude line other than a builder status line or agent line. It reads "Working on it" once the session marks it started, and the owner can edit or delete it.
_Avoid_: unread, queued

**Prototype request**:
The owner asking, from a card's thread, for throwaway prototype pages to compare options. Each prototype comes with an open question on its card, and the page's switcher can send the pick; until the owner picks, the card carries Action needed and keeps its lane, Todo while it hasn't started ([0015](docs/adr/0015-prototypes-come-on-request.md), [0059](docs/adr/0059-an-unstarted-card-waits-on-its-questions-in-todo.md)).
_Avoid_: mockup request, preview

**Take**:
One option of an owner question shown as what it would be: a framed prototype, or a diagram of boxes and arrows with what it means in practice. Waiting on you keeps takes in option order with the recommended one tagged: small takes share a grid, while a question with any scrolling or full-screen prototype shows a choice row above one full-width take, followed by the note and Send ([0048](docs/adr/0048-a-questions-takes-show-inline.md)).
_Avoid_: variant (the switcher's URL parameter, not the word), mockup

## Board page files

The board page's scripts in `board/public/` are plain scripts with no bundler, loaded in the order `app.html`, the app shell, lists them, from `/_hub/app/`. The `ui*.js` files hold pure renderers on the `BoardUI` global, which `ui.test.mjs` tests. `app.js` defines `BoardView`, and each `app-*.js` file after it registers one part of the board view with `BoardView.part((B) => …)`. `BoardView.create(root, site, opts)` gives each board its own `B` (state, `ClaudeSite.site`, store, and a `$` scoped to the view's root), and a part adds listeners, intervals, timers, watches and unmount steps only through `B.on`, `B.every`, `B.later`, `B.watch` and `B.atUnmount`, so `unmount()` leaves none behind; `view.test.mjs` checks that. Nothing waits while the owner types: a repaint patches the lanes and each thread in place, and a box being typed in keeps its text, cursor and focus ([0057](docs/adr/0057-a-repaint-patches-in-place-so-nothing-waits-while-you-type.md)). An open card moves to its new place at once and the page follows it: the box being typed in, else the open card's title row, stays where it was on screen ([0063](docs/adr/0063-an-open-card-moves-at-once-and-the-page-follows-it.md)); `view.test.mjs` checks both on a board mounted on `board/mini-dom.mjs`, a small DOM. The board's other views (`view-*.js`) get the same site, `$` and recorders from `BoardView.page(root, site, run)`. The view's state, such as `offline` and `data-board`, sits on its root (`.view-board`), not on `<body>`. A site card names the files it expects to touch from this table ([0022](docs/adr/0022-site-cards-build-in-parallel-when-their-files-dont-overlap.md)).

Refs in text that Claude or the owner wrote are linked by the renderer, never by hand: pass the text through `ui-links.js` (`linkText`, or `linkHtml` for an HTML reply or line) with the item's `linkContext`. A card's ref (`INT-<n>`, or any `ref` on the board) opens its card, a Linear id or PR opens its page, and a bare URL becomes a link. Write refs as plain text in thread lines, replies, questions and plans.

| File | Owns |
| --- | --- |
| `../shared/colors.css` | Every color, served as `colors.css` and linked before `style.css`; the hub serves it as `/_hub/colors.css` |
| `ui.js` | Shared helpers: escaping, times, reply bodies, attachments, icons and message buttons, badges by tone, `setHTML`, which patches a region in place and keeps the focused field's focus when it moves, and `fetchJSON`, through which the side pages read the API and wait out a board restart |
| `ui-links.js` | Linking refs, Linear ids, PRs and URLs in written text; load it right after `ui.js` |
| `ui-enums.js` | `BoardUI.BUTTON` and `BoardUI.ACTION_KIND`, the **action button**'s enums, shared with `board/domain.mjs`, which runs it in a vm context; load it before `ui-threads.js` and `ui-cards.js`. `view.test.mjs` checks that every action kind makes one button orange and every action button draws |
| `ui-cards.js` | A card's lines, in order: title with its ref, or New or Task chip; status with its ETA; a Todo work item's age from two full days; Stalled when the builder is silent, then the unread chip, Action needed, PR, review and other chips, then Install; Blocked by chips; and at its top right a New card's bump, edit and delete icons, or another bumpable card's bump icon; and the action row's Merge button |
| `ui-sidebar.js` | `BoardUI.sidebar`, the sidebar's markup from `/_hub/sidebar.json`, headed by `BoardUI.header` itself, with each row's key in **switch mode**; `switchKeys`, which row each key opens; and `othersWaiting`, for the logo's label. Needs `ui-page-header.js` loaded before it: `hub/hub.mjs` renders the app shell's first sidebar with both in a vm context |
| `sidebar.js` | Painting the sidebar from the copy written into the shell, else this device's last copy, then from each copy the hub's stream sends; this device's push subscription for its Turn on row; the logo's toggle, the drawer and its swipes, the rail's collapse, which this device keeps, and the logo's label; **switch mode**'s keys, from the document and a framed page, each row opened through the shell |
| `app.html` | The app shell: the sidebar, the view's slot, and its scripts and CSS from `/_hub/app/`, with a board's loads started in its `<head>`; the hub serves it for a browser's load of `/` or any site's page, and every load of a hub page, with the sidebar and its data written in (`hub/shell.mjs` `pageOf`), and the board server for a board's four view paths without them (`shellHtml`) |
| `router.js` | `AppRouter`: every hub URL as a view and each view as its URL (`ui.test.mjs` tests both), the views the shell mounts in place, framed pages included, and catching taps on links to them and back and forward, with `{idx}` in each history entry and `pushed` on one a push opened; a back arrow goes one step back by them. On the **page tree** each entry also carries `up`, how many of its parents sit under it, which the router writes on every way in, and the arrow goes up a level. It frames the paths `hub/shell.mjs` `pageOf` answers with the shell, which `hub/shell.test.mjs` checks |
| `shell.js` | `AppShell`: the sidebar mounted once, one view at a time, asking before leaving an unsaved edit, `/`'s pick of a board, the hub's one stream and which left boards are unchanged, a framed page's URL and title copied to the top, a push tap from `hub/sw.js` or a framed page's view URL (`AppShell.open`) routed in place, and registering `hub/sw.js`, which opens the shell while the Mac is asleep |
| `view-settings.js` | Board Settings as a view: auto-merge, install script, reviewers, rules and Close board with its typed-name sheet |
| `view-questions.js` | Waiting on you as a view: a topic's questions, their takes framed with `?take=` in a fitting grid or a chooser above one full-width frame, and one Send, which stays while the topic has a question open and otherwise opens the next topic with one, or goes back to the board |
| `view-notes.js` | One item's notes as a view, from `GET /api/notes`; the server redirects `plan.html` to `notes.html` |
| `view-hub.js` | The **hub page** as a view, from `/_hub/api/hub`, refreshed every 30 seconds while it shows; pending prompts of sessions with no board, Send now and this device's Turn on |
| `view-hub-settings.js` | **Hub Settings** as a view, from `/_hub/api/settings`: notifications, the snooze sheet and the Polling summary row first, then the Codex setting, Closed boards with Reopen and the rules for every board |
| `view-polling.js` | Polling as a view, from `/_hub/api/polling`: the day bar, whose taps pick a window without asking the hub, each window's edits, the overnight hold, the daily wakes and Send now |
| `ui-hub.js` | `HubUI`, the hub views' pure renderers: rows, tiles, the flash, the Now row and this device's row |
| `hub-kit.js` | `HubKit`, what the hub views share: `live` (load, the header's time and ↻, the 30-second refresh), `forms` (posting a hub form for JSON, and saving a toggle or time on change) and `device` (this device's push subscription) |
| `view-frame.js` | Any other page as a frame view: the frame beside the board header with Open alone ↗, hiding that header for a page that draws its own, whose logo then toggles the sidebar; each load's URL and title to the shell, and taps on links to other views sent to it, a prototype's back arrow included, which the shell takes up the **page tree** before the page's own script can |
| `sidebar.css` | The sidebar's rail, its collapse, the drawer and switch mode, plus the shared New board dialog; linked after `colors.css` |
| `hub.css` | The hub views' CSS and the hub's down page's, every rule under `.hub-view`, the class on a hub view's root and on the down page's `<html>`; the shell links it after `style.css`, whose header the hub views share, and the down page as `/_hub/hub.css` |
| `ui-page-header.js` | `BoardUI.header`, every page's header: the logo (which toggles the sidebar), a back arrow where needed (beside a phone-only logo), the title, then the time and ↻ and the gear, or a page's own trail. On a page of its own, the back arrow's own script goes one step back, or to its href after a push; in the app shell `router.js` does that. Needs nothing else: `server.mjs` renders each page's `<!--header {…}-->` with it, such as a prototype's, and `hub/hub.mjs` the shell's first sidebar, whose head is one too (`ui-sidebar.js`), each in a vm context |
| `ui-header.js` | The header's time and when it moves, the GitHub status line and its Hub links mark, the Hub links list, the setup checklist, when a refresh asks for a GitHub check, and which board header controls take taps |
| `ui-threads.js` | Thread messages, with link, status and agent lines, the open card's window over them with its Show more, and the reply form's Done |
| `ui-questions.js` | Owner question cards with their takes inline and diagrams, answer history, prototype status and the Waiting on you topic row; `BoardUI.nextQuestion`, the pure move-on rule shared by Send and a prototype pick, and `sentNotice`, the Sent line the board reads on return |
| `ui-markdown.js` | The Markdown subset `view-notes.js` renders a card's notes with |
| `ui-snapshot.js` | The last visit's stored shape and size cap, which threads preload, which controls wait for the fresh board, and which lines flash |
| `attach.js` | Picking and uploading attachments, each to the site of the board view around its composer |
| `prototype-switcher.js` | A prototype page's ‹ take › pill, its keys and `?variant=`, one take alone with `?take=`, and with `?q=` the pick and note that answer the card's question, then the next open question in its place as a Send moves on, or with none left the board, handed to the app shell when the page is framed in it, with the board’s Sent notice in that top window; uses the shell’s `BoardUI` or loads its question helpers when opened alone; `prototype-switcher.test.mjs` tests its controls and a pick through `mount`, while `ui.test.mjs` owns the move-on rule |
| `app-core.js` | The view's shared helpers: drafts, seen marks, hiding, and `steady`, which runs a repaint keeping the box being typed in, else the open card's title row, still on screen, and its focus and cursor; re-exports `dialogs.js` as `B.confirm` and `notice` |
| `dialogs.js` | `BoardDialogs.confirm` and `notice`, which every board page's dialogs go through, and `fitSheet`, the ask and New board sheets' shared phone keyboard handling; loaded on every page |
| `rules-editor.js` | `RulesEditor`, the rules list on board Settings and hub Settings, with its own CSS; `ui.test.mjs` tests its pure parts |
| `app-threads.js` | Loading a thread, once at a time per card; an open card's thread, its reply box, quick replies and Done |
| `app-cards.js` | Cards, their open detail with the details list ending in Notes ↗ · Install ↗ · Review on GitHub ↗ when present, and the workflow row: a follow-up's Build, Merge, Hold and the **action button** with each one's confirmation; the install link's rebuilding confirmation; the bump icon's confirmation; an ask's detail shows only its action button; the thread's Done confirmation and send |
| `app-lanes.js` | Lanes, the Answered, older and finished-wave folds, the wave bars and filter, and Plan a wave |
| `app-asks.js` | The + sheet and its press-n-twice shortcut, and bump, edit and delete |
| `app-needs.js` | The Needs you box, led by the board session's pending prompts |
| `ui-prompts.js` | A pending prompt's Needs you line: its details, Allow once, Always allow and Deny, or a question's options, Skip and Send |
| `prompts.js` | `PromptAnswers`, answering pending prompts from their lines on a board and the hub page: which taps send at once, Always allow's confirmation, and the picks a Send waits on |
| `app-banner.js` | The answer banner, its tap and its ✕ |
| `app-header.js` | The board's header controls and time, refresh, the offline state, the In Review header's GitHub line, the Hub links sheet and the setup checklist |
| `app-snapshot.js` | Reading and saving the last visit, also as the view unmounts, keeping every board's within three at the cap, holding the controls that send while it shows, and the flash when the fresh board lands |
| `app.js` | `BoardView`: each board's `B`, its state and per-board store, mount and unmount, and the view's markup for the app shell; rendering the view from its parts, painting the last visit, live when the shell says nothing changed, loading the board with its open threads (taking over the loads `app.html` starts), preloading active cards' threads, the reload timers, and the change signal from the shell |
