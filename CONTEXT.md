# Web-ts hub and boards

Pages on Love's tailnet that Claude sessions serve, so the owner can follow and steer their work from a phone. The hub lists the sites and sends pushes. A board is a site that shows a session's work as cards.

## Language

### Hub and sites

**Hub**:
The one server on the Mac that answers the tailnet address, lists every site, forwards to each, checks GitHub for the open PRs on boards' cards, and sends pushes.
_Avoid_: portal, gateway

**Sidebar**:
The list of every site beside each board and hub page: Boards, then Pages, the sites that aren't boards, with their status words, lane chips and waiting counts, then the Hub, Notifications, Polling and Settings rows. Boards and Pages stay apart wherever sites are listed. The header's logo toggles it at every width; it carries no count. From 1000px it is a rail, which its own logo collapses out of sight until the header's logo brings it back; narrower, it is a drawer. In the **app shell** it is mounted once, beside every view, Settings and framed pages included, and a site's row swaps the view in place. `/` opens this device's **last board**, which the app shell stores as each board opens, never a page ([0050](docs/adr/0050-a-sidebar-of-every-board-replaces-the-hub-home.md), [0055](docs/adr/0055-one-app-for-the-whole-hub.md)).
_Avoid_: hub home, switcher, nav

**Switch mode**:
The sidebar showing each row's key after s is pressed twice outside a text field: the first nine boards' numbers on their tiles, and every row's letter from its name, underlined. The next key opens that row in place; Escape, a click or 3 seconds with no key ends it. Boards claim letters first, in the order they joined the hub, so a new board never takes another board's letter ([0056](docs/adr/0056-switch-mode-letters-come-from-names-in-join-order.md)).
_Avoid_: shortcuts, hotkeys, jump mode

**App shell**:
The one page a browser's load of `/`, a hub page or any site's page gets, `board/public/app.html`: the sidebar, mounted once, beside one **view** at a time, and the hub's one stream, `/_hub/stream`. Following a link to a view swaps it in place, with no reload, and leaving one with an unsaved edit asks first. Every URL stays a real address. The board server answers a board's four view paths with the shell too, and the hub every load of `/_hub/`, `/_hub/settings` and `/_hub/settings/polling`, so curl and a frame get it; a frame's shell hands its URL to the app around it. While the Mac can't be reached, the hub's service worker opens the last shell the hub served, with its last sidebar, and each view shows its own offline state ([0055](docs/adr/0055-one-app-for-the-whole-hub.md)).
_Avoid_: SPA, wrapper, frame

**View**:
One page's content in the app shell, mounted when its URL opens and unmounted, with every listener, timer and stream it added, when another takes its place. A board is a view, and so are its Settings, Waiting on you and Notes, and the **hub page**, **Hub Settings** and Polling; a board left and opened again paints from its **last visit**, live when its stream sent no change since. Any other page, another site's or a board's prototype, is a **frame view**: the page in a frame under the board header, or under its own when it draws that header, with Open alone ↗ to load it by itself.
_Avoid_: screen, tab, page (a page is its own document)

**Page tree**:
The levels back climbs in the app shell: a board, its Waiting on you, then a prototype page tied to one of its questions by `?q=`. On each, the back arrow, the browser's back and a swipe all go up one level: from a prototype to Waiting on you on its question, from there to the board, with the card still open when the owner left the board from that card's thread. However the owner arrives, by a push, a link or a reload, the levels above are written into history under the page first ([0058](docs/adr/0058-back-follows-the-page-tree.md)).
_Avoid_: nav stack, breadcrumbs

**Hub page**:
The hub's status page, `/_hub/`, which the sidebar's Hub row opens: each site's health with each board's hub links and watcher, polling and notifications ([0050](docs/adr/0050-a-sidebar-of-every-board-replaces-the-hub-home.md)).
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
A board's owning session as the manifest records it in the site's owner: its id, its folder (`repo`, where `claude --resume` finds it) and an optional model. `web-ts start` launches one in the background; `web-ts resume` brings it back under the same id.
_Avoid_: orchestrator process, agent

**Live**:
A session whose `~/.claude/sessions/<pid>.json` record names it and whose process still runs, started when the record says. A live session is never started or resumed again.

**Auto-resume**:
The hub resuming a board session once when its board hasn't been listening for 3 minutes and the session isn't live, then pushing the owner once if the board still isn't listening 5 minutes later.

**Push**:
A phone notification from the hub that opens a page. A push is sent only when something waits on the owner. Answers and questions go at once; merges, drafts on Ready and stale PRs go when their tick ends; each arrives as its own notification ([0030](docs/adr/0030-pushes-go-by-kind-and-each-arrives-on-its-own.md)). Other replies don't push; a push that goes out anyway says how many came since the last one. With notifications off every push is dropped; a snooze and Off on weekends hold pushes until they end, and urgent ones go through those holds ([0032](docs/adr/0032-notifications-can-be-off-snoozed-or-off-on-weekends.md)).
_Avoid_: alert, notification (for the act of sending)

**Polling interval**:
The hub's one schedule, a list of windows with their minutes: on each slot it checks GitHub, wakes a board's owning session with `github-change` when a PR on its cards changed, pushes once for each board that isn't listening, then sends the queued pushes. At each daily wake time it also sends each board one `check-github {reason: "morning"}`, changed or not. With hold pushes overnight on, pushes queued in the last window wait for the first window's start ([0025](docs/adr/0025-the-hub-polls-github-and-sends-pushes-on-one-interval.md)).
_Avoid_: push schedule, send-at-once hours, cron

**Hub Settings**:
The hub pages' gear page, `/_hub/settings`: this device's notifications, push notifications on or off, snooze, off on weekends, a Polling row opening the page that edits the polling interval, hold pushes overnight and daily wakes, and the rules for every board. A board's gear opens that board's own Settings, which holds its auto-merge toggle, its reviewers and its own rules.
_Avoid_: preferences, hub config

**Waiting count**:
The badge on a site's row in the sidebar: how many things the site's `GET /_claude/needs` lists as waiting on the owner. It is unknown, with no badge, when the site doesn't answer. The Home Screen app's badge is the sum over every site.
_Avoid_: unread count, inbox

**Status word**:
The coloured word that leads a site's sub line in the sidebar when something urgent holds, most urgent first: Down, Starting, Working, "N need you" or Building. Lane chips with the site's open-card counts follow it; a calm site shows only the chips ([0037](docs/adr/0037-the-hub-home-shows-status-not-descriptions.md)).
_Avoid_: activity line, subtitle

### Boards

**Board**:
A site built from the board template that shows one or more waves as cards in lanes.
_Avoid_: dashboard, kanban

**Hub links**:
What the hub owes a board, each passing or broken: GitHub polling, events (a watcher runs), daily wakes, pushes (a device is subscribed), reviewer links and hub code (the hub runs the code in its files). The In Review header's GitHub mark opens them as a sheet, red-dotted only while one stays broken past its grace period; until then it is **settling** ([0046](docs/adr/0046-hub-links-turn-red-only-after-a-grace-period.md)). A new board tests them with a **handshake**: a `hello` event the session answers with `board.mjs hello-ack` and a test push, with a Connecting checklist on the board until the session answered and GitHub checks reach it ([0040](docs/adr/0040-one-board-registry-for-every-hub-feature.md)).
_Avoid_: health, status, integrations

**Change signal**:
The board server's note on its `api/stream` that a file the board reads changed; the hub passes it on as `change {route}` on its one stream, and an open board reloads at once. The header's time counts from the last one that brought something new, or the last ↻ tap ([0031](docs/adr/0031-the-board-reloads-on-a-change-signal.md)).
_Avoid_: push (a push is a phone notification), live update

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
_Avoid_: task (a **new task** is the owner's), ticket (a ticket is the Linear issue it may link to)

**Internal item**:
A work item about the sites themselves rather than the product. Its card shows its **ref**, `INT-<n>`, where other cards show Linear chips; a stored id `S<n>` reads `INT-<n>`.
_Avoid_: meta task, chore

**Badge**:
A chip on a card or page that shows a status, such as Action needed, Install, a PR's state or "held". It may link to what it is about: on a closed card, Action needed and Install go straight to the thing to act on (owner, question `badge-tap`). A badge never acts on the board; a **button** does.
_Avoid_: chip (in what the owner reads), tag, label

**Button**:
A control that acts: it sends something to the board, such as Merge, Hold or Grill, or opens a place to act, such as Open questions or Review on GitHub. The open card's buttons sit in two rows: workflow first (a follow-up's Build, Merge, Hold or Resume, Prioritize, then the **action button**), then the links that leave the board (Review on GitHub, Notes, then Install last). The one that clears the card's **Action needed** is orange.
_Avoid_: badge, pill (a pill is only a look)

**Badge tone**:
The color of a badge (a status chip on a card or page), picked from one fixed set by what the badge says, through `BoardUI.badge` in `board/public/ui.js`: quiet (gray), normal (blue), notice (orange), danger (red) or ready (green). Each tone takes its color from a **status color**, so a badge is one consumer of the colors, not their source. No badge has a look of its own, so the same tone looks the same everywhere. Buttons and links styled like chips, such as quick replies, a follow-up's Build and "Notes →", aren't badges; the orange of the button that clears Action needed is the same notice color.
_Avoid_: chip color, badge style, variant

**Status color**:
A color named by what it means, `--color-quiet`, `--color-info`, `--color-notice`, `--color-danger` or `--color-success`, in `shared/colors.css` beside the base palette, in light and dark. That file is the one set of colors for the hub and every board; no page's CSS defines a color of its own ([0033](docs/adr/0033-one-colour-constants-file-shared-by-the-hub-and-every-board.md)). Working or waiting on attention is notice, done or passing is success, failed or offline is danger, link-like status is info, and inactive is quiet.
_Avoid_: tone token, theme color, badge color

**Follow-up**:
A Linear ticket filed while building a wave. It is a Todo card of that wave, with a Follow-up badge, until it is done, and an open one keeps its wave unfinished ([0034](docs/adr/0034-follow-ups-are-todo-cards-of-their-wave.md)).
_Avoid_: backlog item, todo

**Lane**:
Where a card sits (In Review, Stale, In Progress, Todo, Done), set by who acts next ([0045](docs/adr/0045-the-lane-follows-who-acts-next.md)). In Progress means Claude or a builder is working: a running builder, a building, fixing or **checking** item, or a PR whose CI is red or, on a draft, still running. In Review means finished work waits on a person: the reviewers, or the owner's Ready, Merge, manual steps or an ask's Done (see **Action needed**). A card waiting only on those moves there from In Progress; one Claude still works on stays in In Progress. Todo holds work not yet started: the New cards, which wait on Claude ([0047](docs/adr/0047-the-plus-makes-a-new-card.md)), and any card that hasn't started and waits only on its open questions or a prototype pick, with Action needed. Answering them moves it to In Progress as its work starts; a started card that gets a question keeps its lane ([0059](docs/adr/0059-an-unstarted-card-waits-on-its-questions-in-todo.md)).
_Avoid_: column, status (status is the item's own field)

**Checking**:
The item status a builder sets when it hands back finished work. The card sits in In Progress reading "Claude checking" while the owning session verifies it, then the session sets it done. Only done, merged and dropped unblock dependents ([0022](docs/adr/0022-site-cards-build-in-parallel-when-their-files-dont-overlap.md)).
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
_Avoid_: Open items, Action needed (the badge)

**Auto-merge**:
A board setting, `auto_merge` in its `board.json`, off unless set: on, monitor merges a PR once it is approved, CI is green and its merge state is CLEAN; off, the card shows the owner Action needed and a Merge button, which reads "Merging…" until the PR merges or Claude says in the thread why it didn't. The board's Settings page toggles it, and the watcher prints it with every wake as `setting auto-merge on|off`. A setting, not a **rule**, since the board itself acts on it ([0052](docs/adr/0052-auto-merge-is-a-board-setting-off-by-default.md)).
_Avoid_: merge rule, merge policy

**Review on GitHub**:
The open card's link to its PR, on every card with an open PR, first in the second row of buttons. It reads "Review draft on GitHub" on a draft and "Review on GitHub" once ready, with no PR number, and is orange while a green draft's Ready or manual steps wait on the owner.
_Avoid_: Review #<n> on GitHub, PR link

**Install**:
The link on a card whose PR builds a device app, last in its badge row and last in the open card's second row of buttons, that installs the build on the owner's phone: an iOS `itms-services://` manifest link or an Android `.apk`, kept in the item's `install`. It reads "older build" once the PR's head moves past the commit it was built from, and leaves the card in Done ([0051](docs/adr/0051-a-device-app-card-carries-an-install-link.md)).
_Avoid_: download, TestFlight (a different channel), build link

**Notes**:
The owning session's understanding of a work item so far: what was asked, what is settled, what is open. A Markdown file in its wave's folder that the item names in `plan` (`item set --notes-file`), rewritten as the grill settles things, or with no file the item's short `notes` text. The open card's Notes link opens it as a page sized for the phone; the thread keeps the short news ([0053](docs/adr/0053-notes-replace-the-full-plan-and-cards-start-on-their-own.md)).
_Avoid_: full plan, plan, spec

**Held**:
A work card the owner paused with its Hold button. It doesn't start, and a running one gets no new work, until the owner taps Resume ([0023](docs/adr/0023-a-card-can-be-held-and-every-card-button-confirms.md)). Every action-row button asks to confirm first, through `B.confirm` (`dialogs.js`).
_Avoid_: paused, frozen, on hold (as a status name)

**Builder**:
An agent (Opus, Codex, Sonnet…) working on a work item, with one builder record each (`board.mjs builder … --agent <name>`; the first is `main`). The record holds its label, kind, start, ETA and finish, not its progress. Each progress line (`builder progress`, which needs `--site`) goes only to the card's thread, as a **status line** ("Codex: Running the benchmark"; the main agent's has no prefix), shown as one line with no bubble. The card's status line under its title is the thread's newest status line since its earliest running agent started, with its age, and an optional "ETA about 4:30 pm" line under it (owner ask on INT-76). In the thread every status line stays orange, dot included, whether its agent is working or done (owner, card INT-77). `builder done` marks the record done and keeps it. The thread shows each record as **agent lines** among its messages, with no bubble: "Opus builder started" at its start, always orange and with its ETA while the agent runs, and "Opus builder finished" at its finish, the only green one (owner, question `int42-agents-look`, option C; owner ask on INT-63). The session's own thread summary closes the work.
_Avoid_: worker, bot

### Talking with the owner

**New task**:
A free-form request or question the owner sends from the board's + button (or by pressing n twice). Code and events call it an **ask**: an `ask` event whose thread is `ask:<event id>`. It is a **New card** at the top of Todo, with no wave and no Action needed, until Claude sorts it one of three ways ([0047](docs/adr/0047-the-plus-makes-a-new-card.md)): files it under a wave as a work item, whose thread opens with it (`item set --from-ask`); folds it into the card it's about, whose thread then holds the message marked Moved (`item relate-ask`, undone by `ask unfold`); or answers it, which makes it a Done card reading Task, under Done's Answered row, whose thread takes the owner's later replies. An answer that leaves a question open on it keeps it in Todo as a Task with Action needed, never in Done, until the owner answers and Claude replies, or it is closed ([0059](docs/adr/0059-an-unstarted-card-waits-on-its-questions-in-todo.md)). When another board fits it better, the owner can have it **moved there** (`ask move`): it becomes a New card on that board reading "Moved from <this board>", and here a Done card whose thread links to it. Folding is within one board; a move is between boards. An answer that waits on the owner, such as a choice only the owner can settle, keeps it in In Review with Action needed until the owner taps Mark as done or the Done in its thread ([0035](docs/adr/0035-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md)).
_Avoid_: ask (in what the owner reads), message, prompt, Waiting for Claude strip

**Thread**:
The conversation on one work item: Claude's reports, builders' status lines, the owner's messages, mirrored GitHub comments, and answers to the item's questions. On a card not in Done, its reply form has a Done, left of Send, that closes the card ([0035](docs/adr/0035-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md)).
_Avoid_: comments, chat

**Unread message**:
A line in a card's thread written by someone other than the owner, apart from builder status lines, newer than when this browser last opened that thread. The card shows a gray "N unread messages" line under its status until it is opened.
_Avoid_: inbox, new, notification

**Last visit**:
The board and threads this device last showed, kept in its browser storage. The next visit paints it dimmed at first paint, readable at any age, with the controls that send held until the fresh board lands and replaces it in place, flashing a fading orange border round each card or line that changed ([0028](docs/adr/0028-the-board-opens-on-the-last-visit.md)). A board the app shell left fresh and comes back to with no change since paints it live instead ([0055](docs/adr/0055-one-app-for-the-whole-hub.md)). In code it is the snapshot.
_Avoid_: cache, offline copy, stale board

**Answer banner**:
The one line at the top of a board, above Needs you, naming new tasks Claude answered without making work whose answer this browser hasn't seen: "1 answer · <ask>" or "2 answers · <newest> and 1 more". A tap opens the newest one's card; ✕ hides it on this device until a newer answer. The owning session also pushes each such answer ([0016](docs/adr/0016-every-ask-is-a-card.md)).
_Avoid_: notification, toast

**Owner question**:
A multiple-choice question Claude needs the owner to decide, attached to a topic. A builder's judgement call becomes one. One marked **urgent** blocks a build or a merge and shows alone; Claude resolves a question in the step that acts on its answer ([0043](docs/adr/0043-needs-you-gathers-what-waits-and-questions-answer-on-one-page.md)).
_Avoid_: poll, decision card

**Topic**:
The group an owner question belongs to; an item's questions use the topic `item:<wave>/<id>`.
_Avoid_: category, section

**Needs you**:
The box at the top of a board listing what waits on the owner, one line per work item ([0043](docs/adr/0043-needs-you-gathers-what-waits-and-questions-answer-on-one-page.md)).
_Avoid_: inbox, digest (the digest is the **morning push** that opens it)

**Morning push**:
The owner's daily digest: one push each morning that opens the board at Needs you, skipped on a day when nothing waits ([0043](docs/adr/0043-needs-you-gathers-what-waits-and-questions-answer-on-one-page.md)). The reviewers' digests are Slack messages, not pushes.
_Avoid_: Today page, owner digest in Slack

**Event**:
One thing the owner did on a page (an ask, an answer, a button), which wakes the owning session.
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
One option of an owner question shown as what it would be: its take on the question's prototype page, framed, or, with nothing to see, its `diagram` of boxes and arrows and what it means in `practice`. The questions page shows a question's takes as a carousel, each with its pick; a framed take opens full size in the same window ([0048](docs/adr/0048-a-questions-takes-show-inline.md)).
_Avoid_: variant (the switcher's URL parameter, not the word), mockup

## Board page files

The board page's scripts in `board/public/` are plain scripts with no bundler, loaded in the order `app.html`, the app shell, lists them, from `/_hub/app/`. The `ui*.js` files hold pure renderers on the `BoardUI` global, which `ui.test.mjs` tests. `app.js` defines `BoardView`, and each `app-*.js` file after it registers one part of the board view with `BoardView.part((B) => …)`. `BoardView.create(root, site, opts)` gives each board its own `B` (state, `ClaudeSite.site`, store, and a `$` scoped to the view's root), and a part adds listeners, intervals, timers, watches and unmount steps only through `B.on`, `B.every`, `B.later`, `B.watch` and `B.atUnmount`, so `unmount()` leaves none behind; `view.test.mjs` checks that. Nothing waits while the owner types: a repaint patches the lanes and each thread in place, and a box being typed in keeps its text, cursor and focus ([0057](docs/adr/0057-a-repaint-patches-in-place-so-nothing-waits-while-you-type.md)); `view.test.mjs` checks that on a board mounted on `board/mini-dom.mjs`, a small DOM. The board's other views (`view-*.js`) get the same site, `$` and recorders from `BoardView.page(root, site, run)`. The view's state, such as `offline` and `data-board`, sits on its root (`.view-board`), not on `<body>`. A site card names the files it expects to touch from this table ([0022](docs/adr/0022-site-cards-build-in-parallel-when-their-files-dont-overlap.md)).

Refs in text that Claude or the owner wrote are linked by the renderer, never by hand: pass the text through `ui-links.js` (`linkText`, or `linkHtml` for an HTML reply or line) with the item's `linkContext`. A card's ref (`INT-<n>`, or any `ref` on the board) opens its card, a Linear id or PR opens its page, and a bare URL becomes a link. Write refs as plain text in thread lines, replies, questions and plans.

| File | Owns |
| --- | --- |
| `../shared/colors.css` | Every color, served as `colors.css` and linked before `style.css`; the hub serves it as `/_hub/colors.css` |
| `ui.js` | Shared helpers: escaping, times, reply bodies, attachments, icons and message buttons, badges by tone, `setHTML`, which patches a region in place, and `fetchJSON`, through which the side pages read the API and wait out a board restart |
| `ui-links.js` | Linking refs, Linear ids, PRs and URLs in written text; load it right after `ui.js` |
| `ui-cards.js` | A card's lines, in order: title with its ref, or New or Task chip; status with its ETA; unread; Action needed, PR, review and other chips, then Install; Blocked by chips; and a New card's bump, edit and delete icons; and the action row's Merge button |
| `ui-sidebar.js` | `BoardUI.sidebar`, the sidebar's markup from `/_hub/sidebar.json`, headed by `BoardUI.header` itself, with each row's key in **switch mode**; `switchKeys`, which row each key opens; and `othersWaiting`, for the logo's label. Needs `ui-page-header.js` loaded before it: `hub/hub.mjs` renders the app shell's first sidebar with both in a vm context |
| `sidebar.js` | Painting the sidebar from the copy written into the shell, else this device's last copy, then from each copy the hub's stream sends; this device's push subscription for its Turn on row; the logo's toggle, the drawer and its swipes, the rail's collapse, which this device keeps, and the logo's label; **switch mode**'s keys, from the document and a framed page, each row opened through the shell |
| `app.html` | The app shell: the sidebar, the view's slot, and its scripts and CSS from `/_hub/app/`, with a board's loads started in its `<head>`; the hub serves it for a browser's load of `/` or any site's page, and every load of a hub page, with the sidebar and its data written in (`hub/shell.mjs` `pageOf`), and the board server for a board's four view paths without them (`shellHtml`) |
| `router.js` | `AppRouter`: every hub URL as a view and each view as its URL (`ui.test.mjs` tests both), the views the shell mounts in place, framed pages included, and catching taps on links to them and back and forward, with `{idx}` in each history entry and `pushed` on one a push opened; a back arrow goes one step back by them. On the **page tree** each entry also carries `up`, how many of its parents sit under it, which the router writes on every way in, and the arrow goes up a level. It frames the paths `hub/shell.mjs` `pageOf` answers with the shell, which `hub/shell.test.mjs` checks |
| `shell.js` | `AppShell`: the sidebar mounted once, one view at a time, asking before leaving an unsaved edit, `/`'s pick of a board, the hub's one stream and which left boards are unchanged, a framed page's URL and title copied to the top, a push tap from `hub/sw.js` or a framed page's view URL (`AppShell.open`) routed in place, and registering `hub/sw.js`, which opens the shell while the Mac is asleep |
| `view-settings.js` | Board Settings as a view: auto-merge, reviewers and rules |
| `view-questions.js` | Waiting on you as a view: a topic's questions, their takes framed with `?take=`, and one Send |
| `view-notes.js` | One item's notes as a view, from `GET /api/notes`; the server redirects `plan.html` to `notes.html` |
| `view-hub.js` | The **hub page** as a view, from `/_hub/api/hub`, refreshed every 30 seconds while it shows; Send now and this device's Turn on |
| `view-hub-settings.js` | **Hub Settings** as a view, from `/_hub/api/settings`: notifications, the snooze sheet and the rules for every board |
| `view-polling.js` | Polling as a view, from `/_hub/api/polling`: the day bar, whose taps pick a window without asking the hub, each window's edits, the overnight hold, the daily wakes and Send now |
| `ui-hub.js` | `HubUI`, the hub views' pure renderers: rows, tiles, the flash, the Now row and this device's row |
| `hub-kit.js` | `HubKit`, what the hub views share: `live` (load, the header's time and ↻, the 30-second refresh), `forms` (posting a hub form for JSON, and saving a toggle or time on change) and `device` (this device's push subscription) |
| `view-frame.js` | Any other page as a frame view: the frame under the board header with Open alone ↗, hiding that header for a page that draws its own, whose logo then toggles the sidebar; each load's URL and title to the shell, and taps on links to other views sent to it, a prototype's back arrow included, which the shell takes up the **page tree** before the page's own script can |
| `sidebar.css` | The sidebar's rail, its collapse, the drawer and switch mode, scoped to `.sidebar`; linked after `colors.css` |
| `hub.css` | The hub views' CSS and the hub's down page's, every rule under `.hub-view`, the class on a hub view's root and on the down page's `<html>`; the shell links it after `style.css`, whose header the hub views share, and the down page as `/_hub/hub.css` |
| `ui-page-header.js` | `BoardUI.header`, every page's header: the logo (which toggles the sidebar) or back arrow, the title, then the time and ↻ and the gear, or a page's own trail. On a page of its own, the back arrow's own script goes one step back, or to its href after a push; in the app shell `router.js` does that. Needs nothing else: `server.mjs` renders each page's `<!--header {…}-->` with it, such as a prototype's, and `hub/hub.mjs` the shell's first sidebar, whose head is one too (`ui-sidebar.js`), each in a vm context |
| `ui-header.js` | The header's time and when it moves, the GitHub status line and its Hub links mark, the Hub links list, the setup checklist, when a refresh asks for a GitHub check, and which board header controls take taps |
| `ui-threads.js` | Thread messages, with link, status and agent lines, and the reply form's Done |
| `ui-questions.js` | Owner question cards with their takes inline and diagrams, answer history, prototype status and the Waiting on you topic row, for `view-questions.js` |
| `ui-markdown.js` | The Markdown subset `view-notes.js` renders a card's notes with |
| `ui-snapshot.js` | The last visit's stored shape and size cap, which threads preload, which controls wait for the fresh board, and which lines flash |
| `attach.js` | Picking and uploading attachments, each to the site of the board view around its composer |
| `prototype-switcher.js` | A prototype page's ‹ take › pill, its keys and `?variant=`, one take alone with `?take=`, and with `?q=` the pick and note that answer the card's question, then the next open question in its place, or with none left Waiting on you on its own, handed to the app shell when the page is framed in it; `prototype-switcher.test.mjs` tests its logic and a pick through `mount` |
| `app-core.js` | The view's shared helpers: toasts, drafts, seen marks, hiding, and `keepFocus`, which gives the box being typed in its focus and cursor back after a repaint; re-exports `dialogs.js` as `B.confirm` and `notice` |
| `dialogs.js` | `BoardDialogs.confirm` and `notice`, which every board page's dialogs go through; loaded on every page |
| `rules-editor.js` | `RulesEditor`, the rules list on board Settings and hub Settings, with its own CSS; `ui.test.mjs` tests its pure parts |
| `app-threads.js` | Loading a thread, once at a time per card; an open card's thread, its reply box, quick replies and Done |
| `app-cards.js` | Cards, their open detail, and the action rows: a follow-up's Build, Merge, Hold, Prioritize and the **action button** with each one's confirmation, then Review on GitHub, Notes and Install; an ask's detail shows only its action button; the thread's Done confirmation and send |
| `app-lanes.js` | Lanes, the Answered, older and finished-wave folds, the wave bars and filter, and Plan a wave |
| `app-asks.js` | The + sheet and its press-n-twice shortcut, and bump, edit and delete |
| `app-needs.js` | The Needs you box |
| `app-banner.js` | The answer banner, its tap and its ✕ |
| `app-header.js` | The board's header controls and time, refresh, the offline state, the In Review header's GitHub line, the Hub links sheet and the setup checklist |
| `app-snapshot.js` | Reading and saving the last visit, also as the view unmounts, keeping every board's within three at the cap, holding the controls that send while it shows, and the flash when the fresh board lands |
| `app.js` | `BoardView`: each board's `B`, its state and per-board store, mount and unmount, and the view's markup for the app shell; rendering the view from its parts, painting the last visit, live when the shell says nothing changed, loading the board with its open threads (taking over the loads `app.html` starts), preloading active cards' threads, the reload timers, and the change signal from the shell |
