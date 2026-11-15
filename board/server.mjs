#!/usr/bin/env node
// Shared board server for kickflip sites: node board/server.mjs <site dir>. The hub
// runs it with PORT and PREFIX (/<route>) set, and strips the prefix before forwarding.
// It writes page events, hidden events, uploads and the owner's card taps; agent sessions write the other files
// below through bin/board.mjs (store.mjs):
//   reply, thread, topic add, question add|resolve, prototype add|rm, item add|set|relate-ask,
//   builder start|progress|done (bin/agent.mjs is an alias for builder), main set.
// <site dir>/board.json: {title, items, slug, reviewers, share, rules, auto_merge, auto_build,max_implementers, max_serves, auto_triage, auto_review, idle_notification, skip_draft, prs, github_login, build_target}. auto_build asks the hub to
// run each card's build script after each push, and hides the cards' Serve / Build; main always builds after a merge.
// build_target names the script, .kickflip/build-<target>, else .kickflip/build.
// auto_merge (false when absent) lets the session merge
// an approved, green, clean PR itself; off, the card shows the owner's Merge (store.mjs settingsOf). rules are the owner's standing instructions to this
// board's session [{id, text, by, at}] (board.mjs rules, hub/rules.mjs). reviewers are the board's own [{name, slack_user, dm,
// github}] (board.mjs reviewers), which the settings page lists and new item files copy. items is "waves" (every
// ~/.claude/waves/*/wave.json, the default) or an item file (data/items.json format) relative to the site dir; slug names a file's items
// (its keys are <slug>/<id>), defaulting to the file's basename. Reviewer links live per PR in
// data/pr-slack.json (store.mjs); review.mjs also reads an item's older review_link_ts. from_ask names the ask event that created the item,
// and next is Claude's next step for it. install {url, label?, built_at, sha?} is a device build the card's Install
// button opens (board.mjs item set --install); public/installs/ holds its files, served without a login like all of
// public/, since iOS's installer fetches the manifest and .ipa with no cookies. A builder working on an item has a record in
// agents/<id>.json (or agents/<id>@<agent>.json for each further agent) beside the item file. An item's parent is the key of the card it was spun out of, which makes it a follow-up, and
// its related the keys of cards it is Related to; an item file's older followups list moves into its items as the server
// starts (store.mjs migrateFollowups). Item files are storage only: deps order the cards, and parent and related group
// them (docs/adr/2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping.md). domain.mjs decides lanes and card state from what this server reads.
//   GET  /, /settings.html, /questions.html, /notes.html
//                                the app shell, public/app.html, whose views these pages are (../hub/shell.mjs shellHtml;
//                                docs/adr/2026-10-29-2005-one-app-for-the-whole-hub.md). /index.html redirects to /
//   GET  /prototype-<topic>.html a topic recorded in data/prototypes.json is public/prototype.html with its record
//                                filled in (prototypePage); /prototype.html itself is 404
//   GET  /...                    the site's public/, then this template's public/, then the
//                                starter's, then ../shared for colors.css (directories serve index.html; in .html, each <!--header {…}-->
//                                becomes public/ui-page-header.js's header({…}), then {{title}} board.json's title).
//                                A page's relative .js and .css links gain ?v=<version>; a file asked for by its
//                                current version caches for a year, anything else revalidates by ETag. Every
//                                text response, the API's included, is gzipped when the request accepts it;
//                                API JSON stays no-store
//   GET  /api/board              the board's title (board.json's, as the page shows it), its reviewers' names, the Hold sheet's
//                                holdChoices [{value, label, ms}] (../hub/duration.mjs CHOICES, ms each one's length, null for Forever;
//                                the page words when it ends), and lanes of those items, with
//                                data/pr-slack.json's PR links, with per-item review_link_ts and legacy
//                                ~/.claude/slack-bridge/topics/*.json fallbacks,
//                                data/owner.json and each PR as the hub's GitHub check last read it (github-state.json).
//                                owner.json: {topics: [{id, title, summary}], items: [{id, topic,
//                                question, context, url, options, urgent, asked_at, resolved, resolved_at, round, round_of, confirm_of}]};
//                                Waiting on you shows an open `urgent` question alone, first
//                                checks comes from data/checked.json (the hub's poll writes it),
//                                whether the board hears its events (../hub/boards.mjs listenState) and Claude's latest writes.
//                                links: [{link, ok, detail, state, since?}], whether each hub link reaches this
//                                board, state reading broken only past the link's grace period
//                                (../hub/boards.mjs linksOf), null when the manifest has no board here; setup:
//                                {events, github} while the join handshake's checklist shows, else null
//                                arch: the header bulb's {repo, waits, last} (arch-review.mjs archOf), null off the manifest
//                                onHost: whether this request's browser runs on the hub's machine (on-host.mjs fromHost),
//                                beside the board, so it moves no change number;
//                                a work card's worktree is its builder's worktree path while that folder exists, else null.
//                                owner leaves resolved questions out; ownerTopics still lists and counts them (pageBoard).
//                                version is the board's change number and its ETag, and each card, question and topic
//                                carries its last change's number as changed (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md):
//                                a request whose If-None-Match names it answers 304 with no body
//                                (docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md)
//                                ?since=<n>: the answer is a patch of what changed after n, {since, version, generatedAt,
//                                set, unset, lists, threads?, onHost} (sync.mjs patchSince, public/ui-patch.js), threads
//                                the lines each card's thread gained after n, or the whole thread
//                                (docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md); the whole board, with no
//                                threads, when n is older than the oldest removal kept, or no number this board counted. A card's question
//                                topic names its card as card and leaves its title to it
//                                (docs/adr/2026-11-04-0332-the-board-sends-per-card-patches.md)
//                                Done cards come slim (domain.mjs slimDone), the newest 100 and the ones the Done
//                                archive keeps back; doneArchived: how many Done cards data/done-archive.json holds
//   GET  /api/done?before=<sortAt>|<key>
//                                {cards, left}: the next 100 archived Done cards, slim, newest first, older than the
//                                cursor (none: from the newest), and how many older ones are left after them, each
//                                built from its archive entry as it pages in
//                                (docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md,
//                                docs/adr/2026-11-04-1056-archived-done-cards-are-built-as-they-page-in.md)
//   GET  /api/questions?topic=<id>
//                                {questions}: that topic's resolved questions, as /api/board's owner would list them
//   GET  /api/links              {links}: the same list alone
//   GET  /api/working            {working: [{id, kind, card, since}]}: each event marked Working on it with no answer yet,
//                                card its work card's ref or null (hooks-plugin/hooks/watcher-stop.mjs reads it)
//   GET  /api/thread?key=w/id    the thread the board's sync carries for a card on it (domain.mjs buildBoard threadViews):
//                                data/threads/<w>__<id>.jsonl ({ts, who, text, link, via}; who is
//                                claude, love or a reviewer's name; via github or slack) plus the page's own
//                                events for that key, its from_ask ask and the asks folded into it (data/ask-links.json),
//                                each with its own thread, and a line for
//                                each builder record's start and finish, oldest first; hidden events are left out. key ask:<event id> is that ask's thread:
//                                the ask, a link line for each work item made from it (from_ask) or related to it
//                                (data/ask-links.json), then data/threads/ask__<event id>.jsonl and item-message
//                                events whose key is ask:<event id>
//   GET  /api/notes?item=w/id    {key, ref, title, markdown}: the item's notes file, only a .md inside its item file's
//                                folder, or with no file its short notes text (store.mjs readNotes); otherwise 404
//                                {error}. /api/plan is the same, for pages loaded before the rename
//   GET  /plan.html?…            redirects to notes.html with the same query, since pushes and threads link it
//   POST /_claude/events         {kind, ...data} → one line in data/events.jsonl; wakes Claude. → {id, board}: the
//                                event's id and /api/board's answer as the tap left it, version included, so the page draws the tap from
//                                the one round trip (docs/adr/2026-11-03-0500-every-owner-tap-the-server-can-apply-draws-at-once.md);
//                                with since: <n>, which isn't recorded, that board is a patch since n as ?since= gives;
//                                ?board=0, as the hub posts, answers with no board, so the answer builds nothing after the line is written
//                                ask, item-message and owner-answer may carry files: [upload]
//                                ask may carry request: 'prototype', 'grill' or 'visual', the New task box's eye, fire
//                                or image: its filed card owes that kind's brief, with the task's text and files.
//                                item-message may carry intent: 'reply' or 'build', a Todo card's Reply or Implement.
//                                any kind may carry sendId, the page's id for a reply-box tap: one whose kind and sendId
//                                are recorded answers with the recorded event's id and records nothing. So does an item-message or ask
//                                with no sendId whose text, author and card match one recorded in the last 30 seconds.
//                                Implement with no text or files on a Todo or ready card writes no line of its own
//                                and stages the card for the orchestrator's review, with no event
//                                (store.mjs implementAsIs). One with text or files on a Todo card stages it
//                                there, its open questions skipped and its words in its notes (store.mjs stageImplement),
//                                and appends the message. Any other message on a ready Todo card stages it again with its
//                                words in the notes (store.mjs stageReply; docs/adr/2026-11-07-0700-staging-then-ready.md)
//                                An owner-answer with a note and no take resolves its question (store.mjs
//                                resolveNoteAnswers). One to a card's prototype question that picks no take is
//                                recorded with prototype_again: true: the card reads prototyping with Next "Prototype
//                                again", and the board launches the next round's planner itself (domain.mjs picksNoTake).
//                                owner-answers {answers: [owner-answer data]} is Waiting on you's Send: one owner-answer
//                                line per answer, appended in one write with each answer's side effects → {ids, board};
//                                an answer naming no question in owner.json, or none at all, → 400 {error} and nothing
//                                recorded (docs/adr/2026-11-03-1519-send-records-every-ready-answer-in-one-request.md).
//                                prototype-request {key?, text?, files?, question?, note?, choice?} and grill-more {key, text?, files?, question?, note?, choice?}
//                                ask for prototypes or a grill of a card, with the owner's text, or of one question,
//                                with its note and pick; a question's prototype request reads requested until a
//                                question naming it in round_of resolves it (domain.mjs ownerQuestion), and its grill
//                                leaves it open. The server appends prototype-overdue {key, request,
//                                question?, since} once per request still waiting on its prototype after
//                                PROTOTYPE_WAIT with no prototype agent running on the card (domain.mjs prototypeWaits).
//                                Either one on a Todo card owes the orchestrator's brief for its planner, an
//                                orchestrator wait, and on a discussing, ready or staging card first moves the card
//                                to grilling or prototyping (store.mjs planAgain).
//                                visual-request {key, text?, files?, question?, note?, choice?} asks for a visual, of one question too: it owes the orchestrator's
//                                visual brief, the card's phase as it is. Once the orchestrator writes a brief (item
//                                brief), the server launches its agent, a planner while no other agent but a visual
//                                one works on the card, a visual agent beside any other once no other visual runs
//                                there (launchBriefs; docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md)
//                                reask-request {key?, question} asks the session to ask a resolved question again from the
//                                card's current notes; one naming a question that isn't resolved → 400 {error}. The
//                                question reads reask until question add names it in reask_of (domain.mjs ownerQuestion)
//                                question-reopen {key?, question} is a sent question's Resolved badge: the question opens
//                                again for a new answer and its card's thread reads "Question N was reopened"; one naming
//                                a question with no answer sent → 400 {error}. Record-only: it wakes no session
//                                (docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md)
//                                item set appends card-unblocked {key} when a blocked card's last dep finishes,
//                                including held cards, a record that wakes no session: the pull takes the card.
//                                reviewers {add?: [{name, slack_user, github}], remove?: [name]} is Board settings' reviewers
//                                Save: the server removes the names and adds the people itself (store.mjs removeReviewers,
//                                addReviewers, with each DM opened through the hub's Slack token and each login checked on
//                                GitHub), and appends reviewers-removed {remove} and reviewers-added {add: [name]}, records the
//                                session doesn't act on. An unknown name, a Slack or GitHub refusal or a malformed list → 400
//                                {error} and nothing recorded.
//   GET  /api/reviewer-people    {slack: [{id, name}] | null, slackProblem?, github: [login], githubProblem?}: what Board
//                                settings' Reviewers picks from, fetched with the hub's Slack token and gh.
//                                card-bump {key} and card-unbump {key} are a work card's bump icon, sent with no confirm;
//                                a bump moves the card's queued lands first, an unbump back in ask order (worktree.mjs
//                                moveQueuedLand).
//                                card-hold {key, hold: true, for} is a Hold sheet chip or its Custom time
//                                (../hub/duration.mjs durationEnd), stored as {key, hold: true, until} or, for
//                                Forever, {key, hold: true}; a choice that ends in the past or past 30 days → 400 {error}.
//                                card-merge {key} on a card whose verified branch waits for the owner's Merge (no PR)
//                                records the tap on the card (store.mjs tapMerge) and runs `board.mjs merge <key>`
//                                detached, so a land that restarts this server finishes, its output in
//                                ~/.claude/kickflip/logs/merge-<id>-<time>.log, with no event and no session
//                                (docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md). KICKFLIP_MERGE_CMD='["<cmd>", …]'
//                                replaces node and board.mjs, called with --site <route> merge <key>. On a card with a
//                                PR the server merges it (store.mjs mergeCard) and appends no event; a refusal → 400
//                                {error} and a thread line.
//                                card-build {key} is the owner's Build: the server starts the build itself (store.mjs
//                                startTappedBuild, board/worktree.mjs boardWorktree) and launches its builder, Claude
//                                or Codex, headless in its worktree (headless.mjs launchBuilder), appending no event; a
//                                refusal leaves its reason in the card's thread, and a launch that fails puts the card
//                                back in Todo with the reason (store.mjs abandonLaunch).
//                                On a card an unfinished dep blocks, or with every implementer slot taken (domain.mjs
//                                pullOf), the tap bumps the card instead (card-bump, a thread line), leaving it in Todo
//                                for the pull (store.mjs bumpBlocked; docs/adr/2026-11-05-0802-todo-has-no-queue.md,
//                                docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md).
//                                A
//                                checking card whose calls are all verified and that has no open question gets one
//                                headless lander per verification, tracked in data/landers.json (store.mjs landable;
//                                docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md,
//                                docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md).
//                                A card whose open PR conflicts gets one headless rebase run per head and base, tracked
//                                in data/rebases.json (domain.mjs rebasesDue, store.mjs startRebase;
//                                docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md).
//                                card-hold and card-done are written to the item file first, with the owner's thread
//                                line, and a Done unblocks blocked cards (store.mjs recordOwnerTap); a Resume relaunches
//                                the run its Hold stopped (resumeRun). card-reopen {key} is a Done card's Reopen: it
//                                moves the card back to Todo, discussing, before its event (store.mjs recordOwnerTap),
//                                and one on a card not in Done → 400 {error}. None of them wakes a session, nor do card-unbump,
//                                grill-more, prototype-request or visual-request
//                                (docs/adr/2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md); one whose item
//                                file couldn't be written, or whose card is merged or dropped, → 400 or 500 {error}
//                                and no event (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
//                                ask-withdrawn {id, key?} also hides that event (POST /api/hide), in the one request.
//                                script-run {key, id, sha} and script-decline {key, id} are the owner's Run and Decline
//                                on a card's waiting script offer, never a shared person's; one of an offer that isn't
//                                waiting → 400, a Run whose sha isn't the offer's → 409, and nothing recorded. A Run
//                                starts bin/script-run.mjs detached, which posts script-result
//                                {key, id, exit, output, timedOut, ms, log} when the script ends
//                                (docs/adr/2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md).
//                                An owner-answer goes into its card's notes verbatim, and one that leaves an unstarted
//                                card with nothing open stages it (store.mjs settleAnswers).
//                                Each new or changed Action needed, and each topic's new open questions, push the
//                                owner, one tag per card (domain.mjs ownerActions), tracked in data/action-pushes.json;
//                                a gone one drops its queued push, or closes the one already on the owner's devices
//                                (hub/push.mjs withdraw).
//                                Within a minute of a held card's until or pick_up_at the server resumes it
//                                (store.mjs pickUp), at most once per time even across a restart.
//                                The Auto jobs below run on every board change and once at start, and on the minute
//                                check only once a usage pause lifts or while an overnight triage is due. The server always starts and launches the build of the top pullable Todo cards, one per
//                                implementer slot max_implementers leaves free, each card In Progress taking one
//                                (domain.mjs pullOf), bumped cards first, whether or not the board is idle, each once,
//                                tracked in data/pulled.json, its record dispatched: 'hub'. The helpers board.mjs agent
//                                launch asked for (launchHelpers), the landers and the rebase runs take no slot.
//                                Neither appends an event.
//                                With auto_triage on, once a night from the middle of the hub's quiet hours to their
//                                end, an idle board with two or more cards waiting on open questions (domain.mjs
//                                triageOf) gets overnight-triage {date, topic, cards} first, unless nothing changed
//                                since the last triage, tracked in data/triaged.json; until Claude
//                                replies to it the pull leaves the cards it names, to the end of quiet hours, and it is an
//                                orchestrator wait of kind triage
//                                With auto_review on, an idle board with nothing pulled sends pr-review {pr, head, repo,
//                                title, author, url, touches, asked} for the next incoming PR the hub's poll listed in
//                                data/incoming.json (../hub/incoming.mjs) and no review covers at its head, one at a
//                                time: it reads reviewing until `board.mjs review record` writes data/reviews.json
//                                (auto-review.mjs reviewsOf). review-answer {pr, answer: post|skip} is the owner's tap
//                                on a review held for them
//                                Each card that joins the list of cards idle on the orchestrator (domain.mjs
//                                orchestratorWaits), kept in data/orchestrator-waits.json for the watcher, appends
//                                orchestrator-waits {added: [key], again}, again naming each still waiting 15 minutes
//                                on from its last wake, or an hour once picked up (domain.mjs waitsStep), and one left
//                                30 minutes not picked up pushes the owner once (checkWaits), checked on every board
//                                change and each minute
//                                Each minute it passes the owner a finished grill's questions left 15 minutes unscreened
//                                by the orchestrator (store.mjs publishUnscreened)
//                                With idle_notification on, a board strictly idle for 15 minutes (domain.mjs
//                                strictlyIdle) pushes "<board> has gone idle" once per idle stretch, checked on every
//                                board change and each minute, tracked in data/idle.json (checkIdle)
//   POST /api/upload             the raw file as the body, its name URI-encoded in x-filename and its
//                                type in content-type → data/uploads/<ms>-<safe name>, returning the
//                                upload {name, url, path, type, size}: url is relative to the site
//                                (uploads/<file>) and path is absolute. Over 20 MB → 413
//   GET  /uploads/<file>         a stored upload with its type; nothing else under data/ is served
//   POST /api/arch-review        {} starts an architecture review of the board's repo (arch-review.mjs startReview) and appends
//                                arch-review {key, repo, github, branch, file?, scope?} → {key, id, existing: false};
//                                while a review is open → {key, ref, existing: true}; a review that must wait → 409 {error}
//   POST /api/hide               {id, hidden} → data/hidden.json; the page clears an event for
//                                every device, without waking Claude
//   POST /api/read               {marks: {card key: time}} → data/read.json (store.mjs markRead), each mark only moving
//                                forward, without waking Claude; every board answer carries each card's mark as its
//                                readAt, and a card new to the board gets one as the server first sees it. A bad body → 400 {error}
//   GET  /api/rules              {board, hub}: board.json's rules and the hub's from settings.json (hub/rules.mjs)
//   POST /api/rules              {rules: [{id?, text}], base: [id]} → board.json's rules (store.mjs saveBoardRules), and
//                                when anything changed a `rules {scope: "board", added, edited, removed}` event, which
//                                wakes Claude. → {rules, id}; a bad list → 400 {error}
//   GET  /api/settings           {settings: the board's settings, {auto_merge, auto_build,max_implementers, max_serves, auto_triage, auto_review, idle_notification, skip_draft, prs, build_target?} (store.mjs readBoardSettings),
//                                paused_until: Pause board's end (an ISO time or forever) or null, pause_choices: holdChoices}
//   GET  /api/build-targets      {targets}: each executable .kickflip/build-<target> at the board's main tip (build-script.mjs listBuildTargets)
//   POST /api/pause              {pause: <usage-gate.mjs pauseEnd choice | off>} → Pause board, board.json's paused_until
//                                (store.mjs setBoardPause; docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md),
//                                then an Auto check. → {paused_until}; a bad choice → 400 {error}
//   POST /api/settings           {auto_merge?: boolean, auto_build?: boolean,max_implementers?: 1..99?: 1..99, max_serves?: 1..99, auto_triage?: boolean, auto_review?: boolean, idle_notification?: boolean, skip_draft?: boolean, prs?: boolean, build_target?: target | null} → board.json, keeping its other keys, and when a value other
//                                than idle_notification moved a `settings {<changed setting>: value}` event, which wakes Claude, then, when auto_merge turned on,
//                                `check-github {reason: "auto-merge"}` for one GitHub tick. → {settings, id}; a bad body → 400 {error}
//   POST /api/share              {add: login} | {remove: login} | {login, level: view | full} → board.json's share, the
//                                logins the board is shared with, a bare login View and {login, level: 'full'} Full
//                                (store.mjs saveBoardShare; docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md,
//                                docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md),
//                                waking no session. → {share}; a bad body → 400 {error}. The hub's GET /_hub/share/<route>
//                                answers who they are, when each was last seen and who was just refused.
//   GET  /api/permissions        {file, permissions: [{id, name, allows, rule, on, refused}]}: the board's session
//                                permissions, read from its folder's .claude/settings.local.json (permissions.mjs); 404 off the manifest
//   POST /api/permissions        {id, on} → that rule written or removed, and the same answer; 400 {error} for a bad
//                                body or settings file
//   POST /api/try                {key, anyway?}: forwards a card build, main retry or the prototype site's start (key prototypes) to the hub's loopback /_hub/build;
//                                anyway: true starts a card's serve on a busy host
//   POST /api/try/kill           {key}: a card's Kill, forwarded to the hub's loopback /_hub/kill
//   POST /api/try/main/pull      {}: Main's refresh icon, forwarded to the hub's loopback /_hub/pull → {commits, error?}
//   GET  /api/log?file=<name>.log {text, truncated, size}: the last 256 KiB of that file in ~/.claude/kickflip/logs, by name
//                                only; log.html and the reader sheet's raw toggle (app-reader.js) show it and re-read it while it grows
//   GET  /api/transcript?file=<name>.log&from=<byte> {rows, next, size, stream, finished}: that log, whole, as transcript
//                                rows from byte `from` to its last whole line (transcript.mjs readRunTranscript); the reader
//                                sheet's View transcript reads it on from `next` while it grows
//   GET  /api/try/main/log      {lines}: last 40 lines of main's log, from at most its last 64 KiB
//   GET  /api/try/prototypes    {state, https, since, lines, step, stepAt, steps, last, error}: the hub's serve of the
//                                board's base prototype worktree, which a served round's viewer frames, since when its
//                                ready run started, and its log's last 40 lines and error once it failed
//                                (docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md);
//                                while it starts or once it failed, its start step since stepAt and each finished step's
//                                ms, and while it starts the log's last line, for the page's landing
//                                (docs/adr/2026-11-14-1446-a-prototype-pages-landing-shows-its-sites-start-steps.md)
// The last 40 lines of a hub run's log, data/try/<name>.log, from at most its last 64 KiB; [] with no log.
async function tryLogTail(here, name) {
  let file;
  try {
    file = await fs.open(path.join(here, 'data', 'try', `${name}.log`), 'r');
    const { size } = await file.stat();
    const start = Math.max(0, size - 64 * 1024);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    if (start) lines.shift();
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-40);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  } finally { await file?.close(); }
}

// A log's last non-empty line as a terminal last showed it: the text after its last carriage return, without escape
// codes; null with none.
function lastLogLine(lines) {
  const shown = lines.map((line) => (line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\r').findLast((part) => part.trim()) || '').trim());
  return shown.findLast(Boolean) || null;
}

// data/try.json is the hub's run state; data/main.json holds main's published install link.
//   GET  /_claude/events         events not hidden, newest first, each with Claude's reply if written
//   GET  /_claude/needs          {items: [{kind, text, url}], working, summary, lanes: {review, progress, todo}, building}:
//                                one item per Needs you line, each pending prompt of this board's session among them
//                                (../hub/prompts.mjs), the count of events Claude is working on, a one-line
//                                summary, the open cards in each lane, and whether a builder works on a card
//                                (domain.mjs needsAnswer); the hub badges the site's row and writes its status line with them
//   GET  /api/stream             server-sent events: `event: change` shortly after a file the board reads changes, under
//                                the item files' folder or data/. Never gzipped
//   GET  /_claude/health
// Every non-GET/HEAD request passes ../starter/cross-site.mjs before routing (403 plain text). One the hub forwards with
// X-Kickflip-Shared is a shared person's: only an event or upload of someone the board's share lists as Full is taken,
// and an event only of a kind Full allows, recorded with data.shared_by {login, name}, which the thread names them by; anything
// else → 403 {error} (sharedWriter; docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md).
// Routes that parse JSON require application/json; /api/upload keeps the file's content type.
// Claude's replies to event <id> are data/replies/<id>.md, .html (written before markdown replies) or .json, then <id>~2.md, <id>~3.md … (store.mjs replyFilesOf).
import { topicItems } from './review.mjs';
import { boardWorktree, builderRepo, git, helperWorktree, moveQueuedLand, prWorktree } from './worktree.mjs';
import { transcriptMovedAt, readRunTranscript } from './transcript.mjs';
import { fromHost } from './on-host.mjs';
import { readSync, writeSync, stamp, patchSince } from './sync.mjs';
import { archOf, readReviews, repoName, startReview } from './arch-review.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { SCRIPT_EVENTS, BRIEF_KINDS, BUILD_REFUSED, LANDER, PAUSE_CLEARS, landStep, pauseWork, confirmedDrops, plans, providerOf, archivedOf, buildBoard, movesOf, briefsDue, withHub, DONE_KEPT, ORCHESTRATOR_PUSH_AFTER, orchestratorWaits, triageWaitOf, boardAskWaits, waitsStep, PROTOTYPE_WAIT, prototypeWaits, idleStep, idleSummary, ITEM_EVENTS, QUESTION_REOPEN, slimDone, needsAnswer, ownerActions, picksNoTake, pullOf,rebasesDue, refOf, strictlyIdle, threadOf, triageOf } from './domain.mjs';
import { localDay, quietAt, quietMiddleOf, quietOf } from '../hub/schedule.mjs';
import { startTitleBrief, startTitleFault } from './commit-message.mjs';
import { hubText } from './hub-lines.mjs';
import { cardPRs, prKeyOf } from '../shared/card-prs.mjs';
import { withdraw } from '../hub/push.mjs';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, realpathSync, statSync, watch as watchFiles } from 'node:fs';
import { PROTOTYPE_TEMPLATE, esc, prototypePage, versionOf } from './prototype-page.mjs';
import { launchAgent } from './agents.mjs';
import { agentMayRun, BOARD_CLI, hasBuilder, landByBuilder, launchBuilder, launchedAgents, pidAlive, resumeBrief, resumeBuilder, reviveBuilders, runFailure, stopAgents, stopRuns } from './headless.mjs';
import { HAD_IMPLEMENT, readScriptOffer, restageStaleReady, replyFilesOf, dropAskCard, fileAsk, fileAsks, retitleAskCard, dropPause, markPaused, openRuns, requestPause, resumePaused, BoardError, publishUnscreened, readScreening, startHelper, startVisual, openAgents, isLanding, implementAsIs, stageImplement, clearOwnerWait, stageReply, planAgain, discussNewCards, heldMerge, opensPRs, tapMerge, addTopic, appendStatus, archiveCards, archiveCount, archiveRank, readArchive, boardConfig, abandonLaunch, cutOffBuilds, abandonPlanner, closeGonePlanners, restoreBrief, landable, relaunchLander, REBASE_LABEL, migrateFollowups, migrateGates, migratePhases, migrateStatuses, moveCard, stageImplementAsks, startPlanner, stripDeadFields, pickUp, startRebase, startTappedBuild, sendPush, recordOwnerTap, takeHoldStopped, clearStall, mergeCard, readPrototypes, takeFile, finishHandshake, itemSources, readAskLinks, readBoardRules, readBoardSettings, readHandshake, readHidden, readMarks, readNotes, readWorking, readActedOn, readUpload, addReviewers, removeReviewers, markRead, resolveNoteAnswers, settleAnswers, splitSharedNotes, unrecorded, handedOver, saveBoardRules, saveBoardSettings, saveBoardShare, saveUpload, setBoardPause, setHidden, settingsOf, threadFile as siteThreadFile, wavesDir } from './store.mjs';
import { changed as rulesChanged, readHubRules } from '../hub/rules.mjs';
import { githubStateFile, boardAt, listenState, linksOf } from '../hub/boards.mjs';
import { limitedUntil } from '../shared/gh.mjs';
import { pendingFor, shown } from '../hub/prompts.mjs';
import { nodeBin } from '../bin/install.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { CHOICES, FOREVER, durationEnd } from '../hub/duration.mjs';
import { VIEW_PAGES, shellHtml } from '../hub/shell.mjs';
import { crossSite, isJSON } from '../starter/cross-site.mjs';
import { shareEntries } from '../hub/share.mjs';
import { readUsageGate, launchHeld, launchHeldWords, pauseReasonFor, pausedWords, pausesRunning, boardPausedUntil } from '../shared/usage-gate.mjs';
import { runLimit } from '../hub/usage.mjs';
import { audit, boardAudit } from '../shared/audit.mjs';
import { reviewWaits } from '../shared/skills.mjs';
import { boardRepo, mainRefOf } from '../hub/board-repo.mjs';
import { listBuildTargets } from './build-script.mjs';
import { reviewerPeople } from './reviewer-people.mjs';
import { permissionsView, setPermission } from './permissions.mjs';
import { SlackError, SLACK_NEEDS_TOKEN, savedSlack, slackStatus } from '../hub/slack.mjs';
import { collaborators, githubUser } from '../hub/pr-report.mjs';

const template = path.dirname(fileURLToPath(import.meta.url));
// Starts the runner of card key's offered script id on the board at site, detached in cwd, the board's repo folder
// (bin/script-run.mjs), so a restart of the server doesn't stop it; the runner posts its script-result event when it
// ends. → the child process
export function startScriptRunner(site, key, id, cwd) {
  const child = spawn(nodeBin(), [path.join(template, 'bin', 'script-run.mjs'), site, key, id, cwd], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}
// The hub's Home Screen icon, versioned by mtime the way hub/hub.mjs iconUrl() does, so iOS refetches a replaced icon.
async function touchIcon() {
  const st = await fs.stat(path.join(template, '..', 'hub', 'icon-180.png')).catch(() => null);
  return `/_hub/icon-180.png?v=${st ? Math.floor(st.mtimeMs).toString(36) : '0'}`;
}
// Read on each page so an edit to the renderer is live on the next request, like the other static files.
async function pageHeaders(html) {
  if (!html.includes('<!--header ')) return html;
  const context = vm.createContext({});
  vm.runInContext(await fs.readFile(path.join(template, 'public', 'ui-page-header.js'), 'utf8'), context);
  return html.replace(/<!--header (\{.*?\})-->/g, (_, options) => context.BoardUI.header(JSON.parse(options)));
}
// docs/adr/2026-11-13-2210-the-board-server-starts-in-process-and-tests-await-settled.md
// The board server for the site at site, listening on 127.0.0.1:port (0: a port the OS picks) under prefix (/<route>,
// or '' for none), once its start passes have run. home is the HOME its own reads use; now its clock, read for each
// time it stamps or compares; watch(changed), when given, starts the file watch that reports each write to changed,
// before the start's last passes run; launch starts each agent the board launches, a builder, lander, planner, visual
// agent or helper, taking agents.mjs launchAgent's arguments and answering as it does (launchAgent itself unless a test
// passes its own); startScript starts an offered script's run, taking startScriptRunner's arguments (itself unless a
// test passes its own). → {server, changed(file), minute(), settled(), close()}:
// - changed(file) stands for the watch reporting a write to file (a path, relative to site or absolute), or with no
//   file a change it can't name.
// - minute() runs the minute's checks, which the script runs every 60 s.
// - settled() resolves once every pass a change, a minute or a request started has finished, the passes those
//   started included.
// - close() waits for settled(), then stops listening and drops every connection, the page streams included.
export async function startServer({ site, home = os.homedir(), port = 0, prefix = '', now = () => new Date(), watch, launch = launchAgent, startScript = startScriptRunner } = {}) {
  const here = path.resolve(site);
  const roots = [path.join(here, 'public'), path.join(template, 'public'), path.join(template, '..', 'starter', 'public'), path.join(template, '..', 'shared')];
  const data = path.join(here, 'data');
  // docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md: each call this
  // server makes on its own goes in the board's audit log, {call, key?, result, reason, inputs}.
  const logCall = (entry) => audit(boardAudit(here), entry);
  const events = path.join(data, 'events.jsonl');
  const replies = path.join(data, 'replies');
  // Each pass the server starts and doesn't await where it starts it (settled()).
  const running = new Set();
  function track(work) {
    const done = Promise.resolve(work).then(() => {}, () => {}).finally(() => running.delete(done));
    running.add(done);
    return work;
  }
  async function settled() {
    while (running.size) await Promise.all(running);
  }
  const types = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
    // iOS's over-the-air installer fetches these itself and wants the manifest as XML; Android installs an .apk.
    '.plist': 'text/xml; charset=utf-8', '.ipa': 'application/octet-stream', '.apk': 'application/vnd.android.package-archive',
  };

  // Text goes gzipped to a browser that accepts it (docs/adr/2026-10-29-1639-the-board-opens-on-the-last-visit.md).
  const gzip = promisify(zlib.gzip);
  const COMPRESSIBLE = /^(text\/|application\/json|image\/svg\+xml)/;
  async function send(res, code, headers, body) {
    if (!['GET', 'HEAD'].includes(res.req?.method) && !res.req.boardRead) dataVersion++;
    const h = { ...headers };
    let out = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
    if (COMPRESSIBLE.test(h['content-type'] || '')) {
      h.vary = 'accept-encoding';
      if (out.length >= 1024 && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '')) {
        try { out = await gzip(out); h['content-encoding'] = 'gzip'; } catch {}
      }
    }
    h['content-length'] = out.length;
    res.writeHead(code, h);
    res.end(res.req?.method === 'HEAD' ? undefined : out);
  }
  const json = (res, code, body, headers = {}) => send(res, code, { 'content-type': types['.json'], 'cache-control': 'no-store', ...headers }, JSON.stringify(body));

  // A page names each local script and stylesheet by its version, so a pinned file caches for good and an edit
  // reaches the browser through the page, which revalidates on every visit (docs/adr/2026-10-29-1639-the-board-opens-on-the-last-visit.md).
  const ASSET = /\b(src|href)="([\w.][\w./-]*\.(?:js|css))"/g;
  async function versionAssets(html, p) {
    const dir = p.endsWith('/') ? p : path.posix.dirname(p);
    const refs = [...new Set([...html.matchAll(ASSET)].map((m) => m[2]))];
    const versions = new Map(await Promise.all(refs.map(async (ref) => {
      const file = await staticFile(path.posix.join(dir, ref));
      const st = file ? await fs.stat(file).catch(() => null) : null;
      return [ref, st ? versionOf(st) : null];
    })));
    return html.replace(ASSET, (m, attr, ref) => (versions.get(ref) ? `${attr}="${ref}?v=${versions.get(ref)}"` : m));
  }
  const sameTag = (header, etag) => String(header || '').split(',').map((t) => t.trim().replace(/^W\//, '')).includes(etag.replace(/^W\//, ''));
  const readJSON = async (f, fallback) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fallback; } };
  const REPEAT_WINDOW_MS = 30_000;
  const readLines = async (f) => { try { return (await fs.readFile(f, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const threadFile = (key) => siteThreadFile(here, key);
  // Hidden events leave every list a page reads (docs/adr/2026-10-29-1639-dismissals-hide-on-the-server.md).
  const shownEvents = async () => {
    const hidden = await readHidden(here);
    return (await readLines(events)).filter((e) => !hidden.has(e.id));
  };

  async function readBody(req, limit = 64 * 1024) {
    if (!isJSON(req.headers)) throw Object.assign(new Error('Send the body as application/json.'), { status: 403 });
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > limit) throw Object.assign(new Error('too large'), { status: 413 }); }
    return body ? JSON.parse(body) : {};
  }

  // A shared person's write (docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md). The hub forwards one with
  // X-Kickflip-Shared naming them only to a board they have Full on, and only to events or an upload; the owner's request
  // never carries it. board.json is read again here, so a level changed since the hub's check holds. Full takes answers,
  // thread messages, New task and its asks, and card buttons; Merge, Board settings' reviewers, a PR review's Post and
  // the header's GitHub check stay the owner's, as does any kind not listed.
  const FULL_KINDS = new Set(['owner-answer', 'owner-answers', 'prototype-request', 'reask-request', QUESTION_REOPEN, 'grill-more', 'visual-request', 'item-message',
    'ask', 'ask-edited', 'ask-withdrawn', 'card-build', 'card-hold', 'card-done', 'card-reopen', 'card-bump', 'card-unbump']);
  // The taps that move a card, which carry the card's version (docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md).
  const CARD_TAPS = new Set(['card-build', 'card-hold', 'card-done', 'card-reopen', 'card-merge']);
  const VIEW_ONLY = 'This board is shared with you to look at only.';
  const OWNERS_ONLY = 'Merge and Board settings stay the owner’s.';
  // → null for the owner's request, {refused} for one a shared person can't make, else {by: {login, name}}
  async function sharedWriter(req, p) {
    const login = req.headers['x-kickflip-shared'];
    if (!login) return null;
    const level = shareEntries(await config()).find((e) => e.login === login)?.level;
    if (level !== 'full' || !['/_claude/events', '/api/upload'].includes(p) || req.method !== 'POST') return { refused: VIEW_ONLY };
    return { by: { login, name: req.headers['tailscale-user-name'] || null } };
  }

  // Every page event, and the server's own such as a rules save, is one line here, which wakes the watcher. → its id
  const appendEvent = async (kind, data) => (await appendEvents([[kind, data]]))[0];
  const newEventId = () => 'e' + now().getTime().toString(36) + Math.random().toString(36).slice(2, 7);
  // [[kind, data, id?]] → their ids, every line in one append.
  async function appendEvents(list) {
    const ts = now().toISOString();
    const lines = list.map(([kind, data, id = newEventId()]) => ({ id, ts, kind, data }));
    await fs.mkdir(replies, { recursive: true });
    await fs.appendFile(events, lines.map((e) => JSON.stringify(e) + '\n').join(''));
    // A check that runs again before the watcher reports this write would otherwise read the board without it and send
    // the same event twice. So the watcher's report of this write moves no data version: it signals pages alone.
    dataVersion++;
    ownAppend = statOf(events);
    return lines.map((e) => e.id);
  }

  // Owner answers [{id, ...}] → their event ids, appended in one write. An answer to a card's prototype question that
  // picks no take carries prototype_again: true and the card owes the orchestrator's brief for its next prototype
  // rounds, each such answer's question and note one of its asks, a round of its own, whatever its note reads as
  // (docs/adr/2026-11-03-1646-a-prototype-answer-with-no-pick-prototypes-again.md,
  // docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md,
  // docs/adr/2026-11-14-2300-picked-prototypes-draw-in-parallel-and-their-records-merge-by-topic.md). A note with no take resolves its
  // question, and the Send is acted on in code: gates settled, answers in the notes, cards left with nothing open staged.
  // An answer to a question that already has one recorded, and wasn't reopened since, is skipped
  // (docs/adr/2026-11-08-0900-send-records-once-and-follow-ups-fail-on-their-own.md).
  async function recordAnswers(sent) {
    const answers = await unrecorded(here, sent);
    const asked = new Map(((await readJSON(path.join(data, 'owner.json'), { items: [] })).items || []).map((q) => [q.id, q]));
    if (!answers.length) return [];
    const isAgain = (a) => asked.has(String(a.id)) && picksNoTake(asked.get(String(a.id)), a.choice);
    const ids = await appendEvents(answers.map((a) => ['owner-answer', isAgain(a) ? { ...a, prototype_again: true } : a]));
    await resolveNoteAnswers(here, answers);
    // docs/adr/2026-11-06-0130-every-grill-ends-with-a-prototype-question-the-board-acts-on.md, docs/adr/2026-11-07-0700-staging-then-ready.md
    await settleAnswers(here, answers);
    dataVersion++;
    for (const a of answers.filter(isAgain)) {
      await planAgain(here, asked.get(String(a.id)).topic.slice(5), 'prototype', { question: String(a.id), ...(a.note ? { note: String(a.note) } : {}) });
    }
    return ids;
  }
  // docs/adr/2026-11-03-1519-send-records-every-ready-answer-in-one-request.md
  // Why a batch of owner answers can't be recorded, or null when every one names a question in owner.json.
  async function answersRefused(answers) {
    if (!Array.isArray(answers) || !answers.length) return 'Send at least one answer.';
    const asked = new Set(((await readJSON(path.join(data, 'owner.json'), { items: [] })).items || []).map((q) => q.id));
    const gone = answers.filter((a) => !asked.has(String(a?.id)));
    return gone.length ? `${gone.map((a) => String(a?.id)).join(', ')} ${gone.length === 1 ? 'is' : 'are'} no longer asked here. Reload to see what is, then send again.` : null;
  }

  // A reopen names a question the owner has sent an answer to, or that is resolved; any other is refused with why.
  async function reopenRefused(id) {
    const q = (await sharedBoard()).owner.find((x) => x.id === id);
    return !q ? `${id} is no longer asked here. Reload to see what is.` : ['open', 'requested'].includes(q.state) ? `${id} has no answer sent, so there is nothing to reopen.` : null;
  }

  // A re-ask names a question the owner sees resolved; any other is refused with why.
  async function reaskRefused(id) {
    const q = (await sharedBoard()).owner.find((x) => x.id === id);
    return !q ? `${id} is no longer asked here. Reload to see what is.` : q.state !== 'resolved' ? `${id} isn’t resolved, so there is nothing to ask again.` : null;
  }

  // e with its replies oldest first, and reply, the newest ({md|html|json, at}), or null.
  async function withReply(e) {
    const replied = await Promise.all((await replyFilesOf(replies, e.id)).map(async ({ name, ext }) => {
      const f = path.join(replies, name);
      try {
        const [text, st] = await Promise.all([fs.readFile(f, 'utf8'), fs.stat(f)]);
        return [{ [ext]: ext === 'json' ? JSON.parse(text) : text, at: st.mtime.toISOString() }];
      } catch { return []; }
    }));
    const all = replied.flat();
    return { ...e, reply: all.at(-1) || null, replies: all };
  }

  async function listEvents(kind, limit) {
    const working = await readWorking(here);
    let lines = await shownEvents();
    if (kind) lines = lines.filter((e) => e.kind === kind);
    return Promise.all(lines.reverse().slice(0, limit).map(async (e) => {
      const withR = await withReply(e);
      return withR.reply || !routeRecord(working, e.id) ? withR : { ...withR, working: routeRecord(working, e.id) };
    }));
  }

  // docs/adr/2026-11-09-1556-boards-read-pr-state-from-the-hubs-check.md: a PR's state is the hub's last check of it,
  // its summary in github-state.json (hub/github.mjs summarize), with the fields the board's badges draw; null before
  // the hub has checked it. limited is when GitHub's limit on the check's GraphQL resets while it holds, else null, for the
  // badges to dim (docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md).
  const prViewOf = (s, limited) => (s ? { title: s.title, url: s.url, state: s.state, isDraft: s.isDraft, reviewDecision: s.reviewDecision, mergeStateStatus: s.mergeStateStatus,
    mergeable: s.mergeable, checks: s.checks, mergedAt: s.mergedAt, headRefName: s.headRefName, headRefOid: s.headRefOid, updatedAt: s.updatedAt,
    reviews: s.reviews, limited } : null);

  const config = () => boardConfig(here);

  async function latestReply() {
    const names = await fs.readdir(replies).catch(() => []);
    const times = await Promise.all(names.map((n) => fs.stat(path.join(replies, n)).then((st) => st.mtimeMs, () => 0)));
    const last = Math.max(0, ...times);
    return last ? new Date(last).toISOString() : null;
  }

  // {<item id>: {<agent>: record}} from agents/<id>.json (agent main) and agents/<id>@<agent>.json (store.mjs builderFile).
  async function readAgents(dir) {
    let files = [];
    try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')); } catch {}
    const records = await Promise.all(files.map((f) => readJSON(path.join(dir, f), null)));
    const out = Object.create(null);
    files.forEach((f, i) => {
      if (!records[i]) return;
      const [id, agent = 'main'] = path.basename(f, '.json').split('@');
      (out[id] ||= Object.create(null))[agent] = records[i];
    });
    return out;
  }

  // What the board reads from outside the folders the server watches: board.json, this board's entry in the hub's
  // manifest (its GitHub repo, git remote and branch) and the Slack bridge's topic items.
  async function outsideData() {
    const self = boardAt(here);
    // hostBusy: whether the host holds new work (docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md), which a bumped
    // ready card reads (domain.mjs hostHeld). landHeld {<kind>: words or null}: what holds the server's launches of each
    // kind, which a verified card's land step reads (domain.mjs landStep).
    const gate = readUsageGate({ dir: here });
    return { cfg: await config(), github: self?.github, local: self?.local, hub: self?.hub, remote: self?.remote, branch: self?.branch, topicItems: topicItems(),
      hostBusy: gate.machine.state === 'busy', landHeld: { claude: launchHeldWords(gate, 'claude'), codex: launchHeldWords(gate, 'codex') } };
  }

  // data/landers.json {<key>: {verified, pid, log, relaunched, handedBack?}}, each entry read with whether its process
  // lives (alive) and, once gone, whether its run ended on the usage limit (limited), as landStep reads them. An entry
  // from before landers kept their pid is a verification alone.
  async function readLanders() {
    return Object.fromEntries(Object.entries(await readJSON(path.join(data, 'landers.json'), {})).map(([key, v]) => {
      const entry = typeof v === 'string' ? { verified: v, pid: null } : v;
      const alive = Number.isInteger(entry.pid) && pidAlive(entry.pid);
      return [key, { ...entry, alive, limited: !alive && (Boolean(entry.limited) || (Boolean(entry.log) && Boolean(runLimit(entry.log)))) }];
    }));
  }

  // The item files the board reads, each with its builder records.
  async function liveFiles() {
    return (await Promise.all((await itemSources(here)).map(async (s) => {
      const itemFile = await readJSON(s.file, null);
      if (!itemFile || !Array.isArray(itemFile.items)) return null;
      return { slug: s.slug, itemFile, agents: await readAgents(path.join(s.dir, 'agents')) };
    }))).filter(Boolean);
  }

  // The item files with archive entries' items (store.mjs readArchive) back among their cards, so an archived card links
  // to the live cards it names and that name it, as it did on the board.
  async function withArchived(entries) {
    const files = await liveFiles();
    for (const a of entries) {
      const into = files.find((w) => w.slug === a.file);
      if (into) into.itemFile.items.push(a.item);
      else files.push({ slug: a.file, itemFile: { items: [a.item] }, agents: {} });
    }
    return files;
  }

  // A board that opens no PRs has no reviewers on its cards; its list stays in board.json
  // (docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md).
  async function itemSnapshot({ cfg, github, local, hub, remote, branch }, files) {
    const fromWaves = cfg.items === 'waves';
    files ??= await liveFiles();

    const threadLines = Object.create(null);
    await Promise.all(files.flatMap(({ slug, itemFile }) => itemFile.items.map(async (it) => {
      threadLines[`${slug}/${it.id}`] = await readLines(threadFile(`${slug}/${it.id}`));
    })));
    return { github, remote, branch, reviewers: opensPRs({ github, local, hub }, settingsOf(cfg, { hub })) ? cfg.reviewers || [] : [], fromWaves, autoMerge: settingsOf(cfg).auto_merge, skipDraft: settingsOf(cfg).skip_draft, autoBuild: settingsOf(cfg).auto_build, tickets: settingsOf(cfg).tickets, files, threads: threadLines,
      working: await readWorking(here), actedOn: await readActedOn(here), autoReview: settingsOf(cfg).auto_review, incoming: await readJSON(path.join(data, 'incoming.json'), null),
      reviewRecords: await readJSON(path.join(data, 'reviews.json'), {}) };
  }

  // Reads every source buildBoard needs: item files and their builder records,
  // PR state from the hub's GitHub check (prViewOf), item threads, page events with Claude's replies, owner
  // questions and legacy review-link fallbacks; outside is outsideData's. With archive entries, it reads their cards and
  // questions beside the item files' and owner.json's, and no PR state for them: their badges draw what they kept
  // (store.mjs keptPRs).
  async function snapshot(outside, archived = []) {
    const items = await itemSnapshot(outside, archived.length ? await withArchived(archived) : undefined);
    const { files, threads: threadLines, working } = items;
    const prs = Object.create(null);
    const archivedKeys = new Set(archived.map((a) => a.key));
    const checked = (await readJSON(githubStateFile(), {})).prs || {};
    const limited = limitedUntil({ budget: 'graphql' });
    for (const { slug, itemFile } of files) {
      const repo = items.github || itemFile.repo;
      for (const it of itemFile.items) {
        for (const p of cardPRs(it, repo)) prs[prKeyOf(p)] = archivedKeys.has(`${slug}/${it.id}`) ? null : prViewOf(routeRecord(checked, prKeyOf(p)), limited);
      }
    }
    const needsReply = new Set(['ask', 'owner-answer', 'grill-more', 'visual-request', 'item-message', 'overnight-triage']);
    const pageEvents = await Promise.all((await shownEvents()).map((e) => (needsReply.has(e.kind) || routeRecord(working, e.id) ? withReply(e) : { ...e, reply: null, replies: [] })));
    await Promise.all(pageEvents.filter((e) => e.kind === 'ask').map(async (e) => {
      const lines = await readLines(threadFile(`ask:${e.id}`));
      if (lines.length) threadLines[`ask:${e.id}`] = lines;
    }));

    const moved = Object.create(null);
    for (const { agents } of files) {
      for (const record of Object.values(agents || {}).flatMap((byAgent) => Object.values(byAgent))) {
        const dir = record.worktree?.path;
        const at = dir && !record.done ? transcriptMovedAt(dir) : null;
        if (at !== null) moved[dir] = at;
      }
    }

    // docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md
    // alive {<key>: whether its headless process lives}: a card's tracked builder, else its lander (domain.mjs builderOf).
    // A gone process reads false only once the board has stopped relaunching it (handedBack, reviveHeadless); before that
    // the next minute's pass relaunches it, as launchLanders does a lander, so it reads as untracked. A builder whose launch
    // a usage pause holds (pid null, handOff) reads 'held' until reviveHeadless launches it. A rebase run reads the same
    // way from data/rebases.json (launchRebases).
    const alive = Object.create(null);
    const headless = await readJSON(path.join(data, 'headless-builders.json'), {});
    const landers = await readLanders();
    // landSkips {<key>: skip}: what store.mjs landable skips each verified card for, so its land step reads what
    // launchLanders will do. Only a card with a verified record can wait to land, so with none landable isn't read.
    const verifiedAny = files.some(({ agents }) => Object.values(agents || {}).some((byAgent) => Object.values(byAgent).some((r) => r?.verified)));
    const landSkips = verifiedAny ? Object.fromEntries((await landable(here)).filter((c) => c.skip).map((c) => [c.key, c.skip])) : {};
    const rebases = await readJSON(path.join(data, 'rebases.json'), {});
    for (const [key, entry] of [...Object.entries(landers), ...Object.entries(rebases), ...Object.entries(headless)]) {
      if (entry?.pid === null && routeRecord(headless, key) === entry) alive[key] = 'held';
      if (!Number.isInteger(entry?.pid)) continue;
      if (pidAlive(entry.pid)) alive[key] = true;
      else if (entry.handedBack) alive[key] = false;
      else delete alive[key];
    }

    return {
      ...items, moved, alive, try: await readJSON(path.join(data, 'try.json'), null), main: await readJSON(path.join(data, 'main.json'), null), prs, events: pageEvents, askLinks: await readAskLinks(here),
      checked: await readJSON(path.join(data, 'checked.json'), null), watcher: await readJSON(path.join(data, 'watcher.json'), null), replyAt: await latestReply(),
      owner: ((owner) => ({ ...owner, items: [...(owner.items || []), ...archived.flatMap((a) => a.questions || [])] }))(await readJSON(path.join(data, 'owner.json'), { items: [] })),
      topicItems: outside.topicItems, prSlack: await readJSON(path.join(data, 'pr-slack.json'), {}), hostBusy: outside.hostBusy,
      screening: await readScreening(here), queuedPlanners: await readJSON(path.join(data, 'queued-planners.json'), {}), landers, landHeld: outside.landHeld, landSkips,
    };
  }

  // docs/adr/2026-11-04-1056-archived-done-cards-are-built-as-they-page-in.md
  // A page of archive entries as the slim Done cards the page draws, built with the board's own cards as the board
  // builds them, each in the entries' order with its closing time as sortAt, which the next page's cursor names.
  async function archivedCards(entries) {
    if (!entries.length) return [];
    const built = new Map(buildBoard(await snapshot(await outsideData(), entries)).items.map((i) => [i.key, i]));
    return entries.map((a) => {
      const it = built.get(a.key);
      return slimDone({ ...it, sortAt: a.closed_at, worktree: it.worktree && !existsSync(it.worktree) ? null : it.worktree });
    });
  }

  const route = prefix.slice(1) || path.basename(here);

  // docs/adr/2026-11-04-0349-the-board-is-built-once-per-data-version.md
  // The version of the board's data: it steps on each write the watcher sees (changed), but not its report of the
  // server's own append (appendEvents), which stepped it already; in a request that may write as it starts, so it
  // reads the files as they are, before each read after its writes (pageBoard, recordAnswers) and as it answers (send),
  // unless its answer carries a board built after its writes (answerBoard); each minute, since the board reads the
  // clock; and each time gh brings back a changed PR state. So a tap builds the board once, for its answer, and the
  // change signal its write sends reloads pages from that build
  // (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md).
  // sharedBoard builds the board once per data version and outsideData, read on each call, and every reader of
  // that pair shares the one build, which none of them changes. The hub's side, the session's prompts and whether it
  // listens, is board()'s to add (withHub).
  let dataVersion = 0;
  let shared = null;
  async function sharedBoard() {
    const outside = await outsideData();
    const key = JSON.stringify([dataVersion, outside]);
    if (shared?.key !== key) {
      const built = snapshot(outside).then(buildBoard);
      shared = { key, built };
      built.catch(() => { if (shared?.built === built) shared = null; });
    }
    return shared.built;
  }

  // docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md
  // Raises each prototype request left waiting PROTOTYPE_WAIT with no prototype agent running to the session, once per
  // request: the event log says which went out.
  let checkingPrototypes = false;
  async function checkPrototypeWaits() {
    if (checkingPrototypes) return;
    checkingPrototypes = true;
    try {
      const log = await readLines(events);
      const raised = new Set(log.filter((e) => e.kind === 'prototype-overdue').map((e) => e.data?.request));
      for (const wait of prototypeWaits(await sharedBoard(), log)) {
        if (raised.has(wait.request) || now().getTime() - Date.parse(wait.since) < PROTOTYPE_WAIT) continue;
        await appendEvent('prototype-overdue', wait);
      }
    } catch (err) {
      console.error('Prototype check failed:', err.message);
    } finally {
      checkingPrototypes = false;
    }
  }

  // The setup checklist after a join's handshake (hub/boards.mjs handshake), or null: when the board never had one, or
  // once the session acked the newest ping and the GitHub link passed, which marks it done for good. A board on another
  // git remote has no GitHub link, so no github step.
  async function setupOf(links) {
    const h = await readHandshake(here);
    if (!h?.ping?.id || h.done_at) return null;
    const github = links?.find((l) => l.link === 'github');
    const steps = { events: h.ack?.id === h.ping.id, ...(github || !links ? { github: Boolean(github?.ok) } : {}) };
    if (steps.events && steps.github !== false) { await finishHandshake(here); return null; }
    return steps;
  }

  // The Hold sheet's chips by length, so the board's version doesn't change with the clock; the page words when each ends
  // (ui-cards.js holdPicker).
  const HOLD_CHOICES = CHOICES.map(([value, label]) => ({ value, label, ms: value === FOREVER ? null : durationEnd(new Date(0), value) - new Date(0) }));

  // Board settings' Reviewers lists, from the hub's Slack and the board repo's GitHub (reviewer-people.mjs).
  function boardReviewerPeople() {
    const slack = savedSlack();
    const repo = boardAt(here)?.github;
    return reviewerPeople({
      slackPeople: slack && !slackStatus().refused ? () => slack.people() : null,
      githubPeople: repo ? () => collaborators(repo) : null,
    });
  }

  // Each person to add with their GitHub login as GitHub spells it and the DM the hub's Slack token opens with them.
  async function withDMs(people) {
    const slack = savedSlack();
    if (!slack) throw new BoardError(SLACK_NEEDS_TOKEN);
    return Promise.all(people.map(async (a) => {
      const github = await githubUser(a.github.trim());
      if (!github) throw new BoardError(`GitHub has no user ${a.github.trim()}.`);
      return { name: a.name.trim(), slack_user: a.slack_user.trim(), dm: await slack.openDM(a.slack_user.trim()), github };
    }));
  }

  // generatedAt is when the board began reading, so of two boards the later one holds every change the earlier one does.
  async function board() {
    const generatedAt = now().toISOString();
    const { title, reviewers } = await config();
    const self = boardAt(here);
    const listen = self ? listenState(self) : 'deaf';
    const built = withHub(await sharedBoard(), { listen, prompts: self ? pendingFor(self.route).map(shown) : [] });
    built.items = built.items.map((it) => (it.worktree && !existsSync(it.worktree) ? { ...it, worktree: null } : it));
    const links = self ? linksOf(self, { listen }) : null;
    return { generatedAt, title, reviewers: (reviewers || []).map((r) => r?.name).filter((n) => typeof n === 'string'), reviewerGithub: Object.fromEntries((reviewers || []).filter((r) => typeof r?.name === 'string').map((r) => [r.name, r.github])), ...built, links, setup: await setupOf(links),
      holdChoices: HOLD_CHOICES, arch: self ? archOf(await readReviews(here), built.items, built.owner, { repo: repoName(boardRepo(self.route)), waits: reviewWaits() }) : null };
  }

  // docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md
  // The board a page reads, from /api/board or an events POST's answer: board(), leaving out the resolved questions
  // (GET /api/questions answers a topic's), with its Done cards slim and how many older ones wait in the archive
  // (docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md). A card's question topic leaves its title,
  // summary and askedAt to its card while the card is on the board: the page names the topic from the card
  // (view-questions.js), so a card's change patches the card alone (docs/adr/2026-11-04-0332-the-board-sends-per-card-patches.md).
  // It holds nothing of the request's, so every page reads the same board at the same change number. → {board, threads}:
  // threads maps each card on it to its thread (docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md), which the
  // board's sync carries beside it.
  async function buildPageBoard(req) {
    if (!['GET', 'HEAD'].includes(req.method)) dataVersion++;
    const { threadViews, ...built } = await board();
    const b = { ...built, doneArchived: await archiveCount(here) };
    b.owner = b.owner.filter((q) => q.state !== 'resolved');
    const marks = await readMarks(here);
    b.items = b.items.map((i) => ({ ...(i.lane === 'done' ? slimDone(i) : i), readAt: marks[i.key] || null }));
    const shown = new Set(b.items.map((i) => i.key));
    b.ownerTopics = b.ownerTopics.map(({ title, summary, askedAt, ...t }) => (shown.has(t.card) ? t : { ...t, title, summary, ...(askedAt ? { askedAt } : {}) }));
    return { board: b, threads: new Map(b.items.map((i) => [i.key, threadViews[i.key]])) };
  }

  // docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md: the change numbers (sync.mjs), kept in data/sync.json,
  // and latest, the newest page board stamped with them, with latestThreads, its cards' threads stamped beside it. A
  // board built before latest leaves all three as they are, so a slow build can't undo a newer one. No answer names a
  // number before data/sync.json holds it, so a restart never counts a number twice. data/sync.json's writes send no
  // change signal (quiet).
  const syncFile = path.join(data, 'sync.json');
  let sync = await readSync(syncFile);
  let syncSaved = sync.n;
  let syncWrites = Promise.resolve();
  let latest = null;
  let latestThreads = new Map();
  function saveSync() {
    syncWrites = syncWrites.then(async () => {
      const s = sync;
      if (s.n === syncSaved) return;
      await fs.mkdir(data, { recursive: true });
      await writeSync(syncFile, s);
      syncSaved = s.n;
    });
    return syncWrites;
  }
  // → {sync, board, threads}: latest, its threads and the state that stamped them, taken together.
  async function pageBoard(req) {
    const { board: b, threads } = await buildPageBoard(req);
    if (!latest || b.generatedAt >= latest.generatedAt) {
      ({ sync, board: latest } = stamp(sync, b, threads));
      latestThreads = threads;
    }
    while (syncSaved < sync.n) await saveSync();
    return { sync, board: latest, threads: latestThreads };
  }

  // → undefined for a POST /_claude/events?board=0, so its answer carries no board key. since is the change number the
  // page holds: the answer is a patch of what changed after it (sync.mjs patchSince), or the whole board when there is
  // none or the board can't answer from it. onHost, whether this request's browser runs on the hub's machine
  // (on-host.mjs fromHost), rides beside the board.
  async function answerBoard(req, since) {
    if (new URL(req.url, 'http://site').searchParams.get('board') === '0') return undefined;
    const onHost = await fromHost(req);
    const { sync: at, board: b, threads } = await pageBoard(req);
    req.boardRead = true;
    const patch = /^\d+$/.test(since) ? patchSince(at, b, Number(since), threads) : null;
    return { ...(patch || b), onHost };
  }

  // docs/adr/2026-11-02-1813-the-bulb-runs-an-architecture-review-of-the-boards-repo.md: one review at a time, so a second Run while
  // one is open answers with that one's card. Runs one at a time, so two taps make one review.
  let reviewing = Promise.resolve();
  function runReview() {
    const run = reviewing.then(async () => {
      const self = boardAt(here);
      if (!self) throw Object.assign(new BoardError('This board isn’t in the hub’s manifest.'), { status: 404 });
      const { arch } = await board();
      if (arch.last?.open) return { key: arch.last.key, ref: arch.last.ref, existing: true };
      const { key, data } = await startReview(here, self, { now: now(), home });
      const id = await appendEvent('arch-review', data);
      return { key, id, existing: false };
    });
    reviewing = run.catch(() => {});
    return run;
  }

  // A card's item file entry and builder records, else its archive entry's (store.mjs readArchive), whose questions its
  // thread reads beside owner.json's.
  async function itemOf(key) {
    const [slug, id] = key.split('/');
    const source = (await itemSources(here)).find((s) => s.slug === slug);
    const itemFile = source ? await readJSON(source.file, null) : null;
    const archived = !itemFile?.items?.some((it) => it.id === id) && (await readArchive(here)).find((a) => a.key === key);
    const item = (Array.isArray(itemFile?.items) && itemFile.items.find((it) => it.id === id)) || archived?.item || null;
    return { item, questions: archived?.questions || [], agents: item && source ? routeRecord(await readAgents(path.join(source.dir, 'agents')), id) || {} : {} };
  }

  // The work items an ask became (their from_ask) or was related to (data/ask-links.json), as domain.mjs threadOf's links.
  async function askLinksOf(askId) {
    const related = routeRecord(await readAskLinks(here), askId);
    const { tickets } = settingsOf(await config());
    const links = [];
    for (const s of await itemSources(here)) {
      const itemFile = await readJSON(s.file, null);
      for (const it of Array.isArray(itemFile?.items) ? itemFile.items : []) {
        const key = `${s.slug}/${it.id}`;
        if (it.from_ask === askId) links.unshift({ key, ref: refOf(itemFile, it, tickets), became: true });
        else if (key === related) links.push({ key, ref: refOf(itemFile, it, tickets), became: false });
      }
    }
    return links;
  }

  // A card's thread: a card in an item file has the one the board build made (domain.mjs buildBoard threadViews), the
  // thread the board's sync carries (docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md); an archived card's or an
  // ask's is made here.
  async function thread(key) {
    const built = (await sharedBoard()).threadViews[key];
    if (built) return built;
    const { item, agents, questions } = key.startsWith('ask:') ? { item: null, agents: {}, questions: [] } : await itemOf(key);
    const stored = await readJSON(path.join(data, 'owner.json'), { items: [] });
    const owner = { ...stored, items: [...(stored.items || []), ...questions] };
    const asked = new Set(owner.items.filter((q) => q.topic === `item:${key}`).map((q) => q.id));
    const own = key.startsWith('ask:');
    const askId = own ? key.slice(4) : item?.from_ask || null;
    // A work item's thread holds the asks it came from or that were folded into it, with their threads (domain.mjs threadOf).
    const moved = own ? [] : Object.entries(await readAskLinks(here)).filter(([, k]) => k === key).map(([id]) => id);
    const askIds = [askId, ...moved].filter(Boolean);
    const keys = new Set([key, ...askIds.map((id) => `ask:${id}`)]);
    const mine = (await shownEvents()).filter((e) => (keys.has(e.data?.key) && ITEM_EVENTS.includes(e.kind)) || (e.kind === 'owner-answer' && asked.has(e.data?.id))
      || (e.kind === QUESTION_REOPEN && asked.has(e.data?.question))
      || (e.kind === 'ask' && askIds.includes(e.id)) || e.kind === 'ask-edited');
    const lines = (await Promise.all([...keys].map((k) => readLines(threadFile(k))))).flat();
    const clearedAt = [routeRecord(await readActedOn(here), key), item?.lane === 'done' ? item.closed_at : null].filter(Boolean).map(String).sort().pop() || '';
    return threadOf(key, { lines, events: await Promise.all(mine.map(withReply)), owner, working: await readWorking(here), listening: !boardAt(here) || listenState(boardAt(here)) === 'listening', clearedAt, fromAsk: askId,
      links: own ? await askLinksOf(askId) : [], agents, moved, cards: new Map((await sharedBoard()).items.map((i) => [i.key, { ref: i.ref }])) });
  }


  async function staticFile(rel) {
    for (const root of roots) {
      let file = path.resolve(root, '.' + rel);
      if (file !== root && !file.startsWith(root + path.sep)) return null;
      const st = await fs.stat(file).catch(() => null);
      if (st?.isDirectory()) file = path.join(file, 'index.html');
      if (await fs.stat(file).then((x) => x.isFile(), () => false)) return file;
    }
    return null;
  }

  // A recorded prototype's page is the template with its record filled in; a topic not recorded falls through to the
  // site's own files, so questions on hand-written pages keep opening them.
  async function recordedPrototype(p) {
    const topic = /^\/prototype-([a-z0-9-]+)\.html$/.exec(p)?.[1];
    return topic ? (await readPrototypes(here)).find((r) => r.topic === topic) || null : null;
  }
  async function upload(req, res) {
    try {
      const name = decodeURIComponent(String(req.headers['x-filename'] || ''));
      return json(res, 200, await saveUpload(here, req, { name, type: req.headers['content-type'], length: Number(req.headers['content-length']) || 0 }));
    } catch (e) {
      if (!(e instanceof BoardError) && !(e instanceof URIError)) throw e;
      // Drain, not close: closing mid-body makes the hub's proxy fail with 502 before it reads this 413.
      req.resume();
      return json(res, e.status || 400, { error: e.message });
    }
  }

  // Scriptable types run sandboxed, so an uploaded page or SVG can't act as the site.
  const SCRIPTABLE = /^(text\/html|image\/svg\+xml|application\/(xhtml\+)?xml|text\/xml)$/;
  async function sendUpload(req, res, file) {
    const u = await readUpload(here, file);
    if (!u) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'content-type': u.type.startsWith('text/') ? `${u.type}; charset=utf-8` : u.type,
      'content-length': u.size,
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(u.name)}`,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      ...(SCRIPTABLE.test(u.type) ? { 'content-security-policy': 'sandbox' } : {}),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(u.path).pipe(res);
  }

  // Each page holds one stream and reloads on its signal (docs/adr/2026-10-29-1639-the-board-reloads-on-a-change-signal.md). It is
  // written straight to the socket, never through send(): a gzipped event stream waits in the compressor.
  const streams = new Set();
  function stream(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
  }
  const broadcast = (text) => { for (const res of streams) res.write(text); };
  // Keeps proxies from idling the stream out, and lets a phone notice a dead one.
  const ping = setInterval(() => broadcast(': ping\n\n'), 25000).unref();

  // A burst of writes, such as a rename after a temp file, sends one signal; a steady stream of them still sends one
  // every CHANGE_MAX.
  const CHANGE_QUIET = 100;
  const CHANGE_MAX = 500;
  let changeTimer = null;
  let changeFirst = 0;
  let changeSent = null;
  // The events file's size and time after the server's own last append (appendEvents), which bumped the data version
  // itself, so a tap's answer built after it has read it (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md).
  // The file still reading so when the watcher reports it means no one else wrote it since.
  let ownAppend = null;
  const statOf = (file) => { try { const st = statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return null; } };
  // A write to file: data/sync.json, the server's own record of its change numbers, signals nothing. The events file as
  // the server's own last append left it means every build from now on has read the write already, so the data version
  // stays and the signal's reloads share the last build.
  // changed({ read: true }), the minute's signal for a write the watch dropped, leaves the data version, which the
  // minute stepped already.
  function changed(file) {
    const read = file?.read === true;
    if (file !== undefined && !read) file = path.resolve(here, String(file));
    if (file === syncFile) return;
    if (!read && !(file === events && statOf(events) === ownAppend)) dataVersion++;
    const at = performance.now();
    if (!changeTimer) {
      changeFirst = at;
      track(new Promise((resolve) => { changeSent = resolve; }));
    }
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      changeTimer = null;
      broadcast(`event: change\ndata: ${JSON.stringify({ at: now().toISOString() })}\n\n`);
      for (const pass of [fileNewAsks, settleLanes, checkArchive, markNewCards, checkActions, checkWaits, checkAuto, checkIdle]) track(pass());
      changeSent();
    }, Math.max(0, Math.min(CHANGE_QUIET, changeFirst + CHANGE_MAX - at)));
  }

  // Requests that come in while the startup passes run wait for them (ready), so none reads the board half-migrated.
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const server = http.createServer((req, res) => track(ready.then(() => answer(req, res))));
  async function answer(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') dataVersion++;
      if (req.method !== 'GET' && req.method !== 'HEAD' && crossSite(req.headers)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Requests must come from the app’s own pages.');
        return;
      }
      const url = new URL(req.url, 'http://site');
      let p = url.pathname;
      if (prefix && (p === prefix || p.startsWith(prefix + '/'))) p = p.slice(prefix.length) || '/';
      // A shared person's write: only a Full person's event or upload is taken.
      const shared = req.method !== 'GET' && req.method !== 'HEAD' ? await sharedWriter(req, p) : null;
      if (shared?.refused) return json(res, 403, { error: shared.refused });

      if (p === '/_claude/health') return json(res, 200, { ok: true });
      if (p === '/api/board') {
        const b = await answerBoard(req, String(url.searchParams.get('since') || ''));
        const etag = `W/"${b.version}"`;
        if (sameTag(req.headers['if-none-match'], etag)) { res.writeHead(304, { etag, 'cache-control': 'no-store', vary: 'accept-encoding' }).end(); return; }
        return json(res, 200, b, { etag });
      }
      if (p === '/api/reviewer-people') return json(res, 200, await boardReviewerPeople());
      if (p === '/api/questions') {
        const built = await sharedBoard();
        const ids = new Set(built.ownerTopics.find((t) => t.id === String(url.searchParams.get('topic') ?? ''))?.questions || []);
        return json(res, 200, { questions: built.owner.filter((q) => ids.has(q.id) && q.state === 'resolved') });
      }
      if (p === '/api/done') {
        const before = String(url.searchParams.get('before') || '');
        const older = (await readArchive(here)).filter((a) => !before || archiveRank(a) < before);
        return json(res, 200, { cards: await archivedCards(older.slice(0, DONE_KEPT)), left: Math.max(0, older.length - DONE_KEPT) });
      }
      if (p === '/api/links') return json(res, 200, { links: (await board()).links });
      if (p === '/api/stream' && req.method === 'GET') return stream(req, res);
      if (p === '/_claude/needs') {
        return json(res, 200, needsAnswer(await board()));
      }
      if (p === '/api/working') {
        const built = await sharedBoard();
        const refs = new Map(built.items.filter((i) => i.kind === 'work').map((i) => [i.key, i.ref]));
        return json(res, 200, { working: built.workingOn.map((w) => ({ id: w.id, kind: w.kind, card: refs.get(w.key) || null, since: w.since })) });
      }
      if (p === '/api/thread') return json(res, 200, await thread(String(url.searchParams.get('key') || '')));
      if (p === '/api/notes' || p === '/api/plan') {
        const key = String(url.searchParams.get('item') || '');
        try {
          const { itemFile, item, markdown } = await readNotes(here, key);
          return json(res, 200, { key, ref: refOf(itemFile, item, settingsOf(await config()).tickets), title: item.title, markdown });
        } catch (e) { if (e instanceof BoardError) return json(res, 404, { error: e.message }); throw e; }
      }
      if (p === '/_claude/events' && req.method === 'POST') {
        // Room for a Send carrying every ready answer's note.
        const body = await readBody(req, 512 * 1024);
        const kind = String(body.kind || 'message').slice(0, 64);
        delete body.kind;
        // The version of the board the page holds, so the answer's board is a patch from it.
        const since = String(body.since || '');
        delete body.since;
        if (shared && !FULL_KINDS.has(kind)) return json(res, 403, { error: OWNERS_ONLY });
        // shared_by names a Full person's event, and each answer of their Send, and is never the page's to say.
        for (const d of [body, ...(Array.isArray(body.answers) ? body.answers.filter((a) => a && typeof a === 'object') : [])]) {
          delete d.shared_by;
          if (shared) d.shared_by = shared.by;
        }
        // docs/adr/2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md,
        // docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md: the page resends a
        // reply-box tap whose answer it never saw, so one already recorded under its sendId answers as recorded.
        const sendId = body.sendId ? String(body.sendId) : null;
        const recorded = sendId && (await readLines(events)).find((e) => e.kind === kind && e.data?.sendId === sendId);
        if (recorded) return json(res, 200, { id: recorded.id, board: await answerBoard(req, since) });
        // docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md: a tap that moves a
        // card carries the version of the card the page drew it from (domain.mjs version); one whose card has moved since
        // answers 409 with where the card is, and nothing changes. A bare Implement on a ready card has had its Implement,
        // and the pull starts it, so it answers the same.
        const drawn = body.version === undefined ? undefined : String(body.version);
        delete body.version;
        if (CARD_TAPS.has(kind) || (kind === 'item-message' && body.intent === 'build')) {
          const card = (await sharedBoard()).items.find((i) => i.key === String(body.key || ''));
          const bare = kind === 'item-message' && !String(body.text || '').trim() && !(Array.isArray(body.files) && body.files.length);
          if (card && ((drawn !== undefined && drawn !== card.version) || (bare && card.lane === 'todo' && card.storedPhase === 'ready'))) {
            const had = HAD_IMPLEMENT[card.lane === 'todo' ? card.storedPhase : card.lane];
            return json(res, 409, { error: `${card.ref || card.key} is ${had ? `already ${had}` : `${card.storedPhase || 'new'} now`}, so nothing changed.` });
          }
        }
        if (kind === 'card-hold' && body.hold && body.for !== undefined) {
          const end = durationEnd(now(), body.for);
          if (!end) return json(res, 400, { error: 'That hold ends in the past or more than 30 days on. Pick another time.' });
          delete body.for;
          if (end !== FOREVER) body.until = end.toISOString();
        }
        // docs/adr/2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md: a Run or Decline only of the
        // card's waiting offer, a Run only of the text the page drew (its sha); a Run starts the script once.
        if (kind === SCRIPT_EVENTS.run || kind === SCRIPT_EVENTS.decline) {
          const key = String(body.key || '');
          const id = String(body.id || '');
          let read, cwd;
          try {
            read = await readScriptOffer(here, key, id);
            if (kind === SCRIPT_EVENTS.run) cwd = builderRepo(here).repo;
          } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
          if (read.state !== 'waiting' || scriptTaps.has(id)) return json(res, 400, { error: `That script is ${scriptTaps.has(id) ? 'running' : read.state}, so it takes no ${kind === SCRIPT_EVENTS.run ? 'Run' : 'Decline'}.` });
          if (kind === SCRIPT_EVENTS.run && body.sha !== read.offer.sha) return json(res, 409, { error: 'This script changed since the page drew it. Read it again before you run it.' });
          scriptTaps.add(id);
          try {
            const eventId = await appendEvent(kind, { key, id, ...(kind === SCRIPT_EVENTS.run ? { sha: read.offer.sha } : {}), ...(sendId ? { sendId } : {}) });
            if (kind === SCRIPT_EVENTS.run) runOfferedScript(key, id, cwd);
            return json(res, 200, { id: eventId, board: await answerBoard(req, since) });
          } finally { scriptTaps.delete(id); }
        }
        // docs/adr/2026-11-03-0219-a-build-tap-starts-the-build-in-the-board-server.md
        if (kind === 'card-build') {
          const key = String(body.key || '');
          const full = !pullOf((await sharedBoard()).items, { cap: settingsOf(await config()).max_implementers, pulled: await sentOf(PULL) }).free;
          const started = await startTappedBuild(here, key, (opts) => boardWorktree(here, key.split('/')[1], opts), 'tap', { full });
          return json(res, 200, { id: await handOff(started), board: await answerBoard(req, since) });
        }
        // docs/adr/2026-11-13-2045-an-exact-repeat-within-30-seconds-is-skipped.md: a message whose text, author and card
        // match one recorded in the last 30 seconds answers as recorded, and writes nothing. A message with a sendId is a
        // distinct send of the page's, which its sendId already guards, so it is not compared.
        if (kind === 'item-message' || kind === 'ask') {
          const text = String(body.text || '');
          const repeat = text.trim() && !body.sendId && (await readLines(events)).reverse().find((e) => e.kind === kind && Date.now() - Date.parse(e.ts) <= REPEAT_WINDOW_MS
            && String(e.data?.text || '') === text && String(e.data?.key || '') === String(body.key || '') && JSON.stringify(e.data?.shared_by ?? null) === JSON.stringify(body.shared_by ?? null));
          if (repeat) return json(res, 200, { id: repeat.id, board: await answerBoard(req, since) });
        }
        // docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md, docs/adr/2026-11-07-0700-staging-then-ready.md
        // The message's thread line is written before the lines its tap causes ("Resumed", "Marked as staging").
        let tapEffects;
        if (kind === 'item-message') {
          const key = String(body.key || '');
          const card = (await sharedBoard()).items.find((i) => i.key === key && i.kind === 'work');
          const bare = !String(body.text || '').trim() && !(Array.isArray(body.files) && body.files.length);
          // docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md: a message on a card the
          // orchestrator stalled clears the stall, and reaches the orchestrator as any message does.
          if (card?.stalled) await clearStall(here, key);
          if (card?.ownerWait) await clearOwnerWait(here, key);
          // docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md: a bare Implement stages the
          // card as it is, with no event; one on a ready card was refused above.
          if (bare && (card?.ready || card?.lane === 'todo')) {
            stopAgents(await implementAsIs(here, key, sendId));
            dataVersion++;
            return json(res, 200, { id: null, board: await answerBoard(req, since) });
          }
          if (card?.lane === 'todo' && body.intent === 'build') tapEffects = async () => stopAgents(await stageImplement(here, key, body));
          else if (card?.lane === 'todo' && card.phase === 'ready') tapEffects = () => stageReply(here, key, body);
          dataVersion++;
        }
        if (kind === 'owner-answer') {
          const refused = await handedOver(here, [body]);
          if (refused) return json(res, 400, { error: refused });
          return json(res, 200, { id: (await recordAnswers([body]))[0] ?? null, board: await answerBoard(req, since) });
        }
        if (kind === 'owner-answers') {
          const refused = await answersRefused(body.answers) || (await handedOver(here, body.answers));
          if (refused) return json(res, 400, { error: refused });
          return json(res, 200, { ids: await recordAnswers(body.answers), board: await answerBoard(req, since) });
        }
        // docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md: a held card's Merge lands from here, with no session.
        if (kind === 'card-merge' && await heldMerge(here, String(body.key || '')).catch(() => null)) {
          const key = String(body.key);
          try { await tapMerge(here, key); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
          runHeldMerge(key);
          return json(res, 200, { id: null, board: await answerBoard(req, since) });
        }
        // docs/adr/2026-11-04-2045-the-merge-tap-and-auto-merge-run-in-code.md
        // The Merge tap merges the card here and records no event, so no session wakes; a refusal answers 400 and is a
        // thread line (store.mjs mergeCard).
        if (kind === 'card-merge') {
          try { await mergeCard(here, String(body.key || ''), { tapped: true }); }
          catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
          return json(res, 200, { id: null, board: await answerBoard(req, since) });
        }
        // A Hold or Done is written to the card's item file before its event, and one that couldn't be is refused with
        // why, recording nothing (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
        if (kind === 'card-hold' || kind === 'card-done') {
          const key = String(body.key || '');
          let written, agents;
          try {
            // Read before the tap, which closes the records. A Hold stops the card's planners at once; a Done lets a landing finish.
            agents = kind === 'card-hold' && !body.hold ? [] : await openAgents(here, key);
            if (kind === 'card-done' && await isLanding(here, key)) agents = [];
            written = await recordOwnerTap(here, kind, body);
            if (kind === 'card-done') await clearOwnerWait(here, key);
          }
          catch (e) { return json(res, e instanceof BoardError ? 400 : 500, { error: `Couldn’t write ${key} to its item file: ${e.message}` }); }
          if (!written) return json(res, 400, { error: `${key} is already in Done, so its item file stays as it is.` });
          // A held build runs on to its stopping point, its record left open (docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md).
          const open = await openAgents(here, key);
          agents = agents.filter((a) => !open.some((o) => o.pid === a.pid));
          if (agents.length) {
            stopAgents(agents);
            await appendStatus(here, key, 'builder-stopped');
          }
          if (kind === 'card-hold' && !body.hold) await resumeRun(key);
        }
        // docs/adr/2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md: a Reopen is written to the
        // item file before its event, as a Done is; one on a card not in Done is refused and records nothing.
        if (kind === 'card-reopen') {
          const key = String(body.key || '');
          let moved;
          try { moved = await recordOwnerTap(here, kind, body); }
          catch (e) { return json(res, e instanceof BoardError ? 400 : 500, { error: `Couldn’t write ${key} to its item file: ${e.message}` }); }
          if (!moved) return json(res, 400, { error: `${key} isn’t in Done, so there is nothing to reopen.` });
        }
        // A Save's removes and adds are both written here, and recorded as reviewers-removed and reviewers-added, which the
        // session takes no action on (docs/adr/2026-11-05-2100-the-server-adds-reviewers-from-fetched-lists.md).
        if (kind === 'reviewers') {
          const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : null);
          const add = list(body.add), remove = list(body.remove);
          const text = (v) => typeof v === 'string' && v.trim();
          if (!add || !remove || (!add.length && !remove.length)) return json(res, 400, { error: 'Send the people to add and the names to remove, each as a list.' });
          if (!remove.every(text) || !add.every((a) => text(a?.name) && text(a.slack_user) && text(a.github))) return json(res, 400, { error: 'Each person to add needs a name, a Slack member and a GitHub login.' });
          try {
            if (remove.length) await removeReviewers(here, remove.map((n) => n.trim()));
            if (add.length) await addReviewers(here, await withDMs(add));
          } catch (e) {
            if (e instanceof BoardError || e instanceof SlackError) return json(res, 400, { error: e.message });
            throw e;
          }
          const ids = await appendEvents([...(remove.length ? [['reviewers-removed', { remove }]] : []), ...(add.length ? [['reviewers-added', { add: add.map((a) => a.name) }]] : [])]);
          return json(res, 200, { id: ids.at(-1), board: await answerBoard(req, since) });
        }
        if (kind === 'reask-request') {
          const refused = await reaskRefused(String(body.question || ''));
          if (refused) return json(res, 400, { error: refused });
        }
        if (kind === QUESTION_REOPEN) {
          const refused = await reopenRefused(String(body.question || ''));
          if (refused) return json(res, 400, { error: refused });
        }
        // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: a new task's card is filed
        // before its event is written, so the watcher's line names the card.
        const preset = kind === 'ask' ? newEventId() : undefined;
        const filed = preset ? await fileAsk(here, preset, { id: preset, ts: now().toISOString(), kind, data: body }) : null;
        // docs/adr/2026-11-15-0730-each-question-has-the-threads-request-row.md: a new task sent with a request (its
        // eye, fire or image) owes that kind's brief on its card, with the task's text and files, as the tap on a card does.
        if (filed && BRIEF_KINDS.includes(body.request)) {
          await planAgain(here, filed, body.request, { ...(body.text ? { text: String(body.text) } : {}), ...(Array.isArray(body.files) && body.files.length ? { files: body.files } : {}) });
        }
        const id = (await appendEvents([[kind, body, preset]]))[0];
        await tapEffects?.();
        if (kind === 'ask-edited') await retitleAskCard(here, String(body.id || ''));
        // A deleted ask's New card goes with it.
        if (kind === 'ask-withdrawn') await dropAskCard(here, String(body.id || ''));
        // docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md: a bump moves the card's queued lands.
        if (kind === 'card-bump' || kind === 'card-unbump') moveQueuedLand(here, String(body.key || ''), kind === 'card-bump' ? now().toISOString() : null);
        // docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md: a tap owes the orchestrator's
        // brief; the agent launches from the brief.
        const tapped = { 'grill-more': 'grill', 'prototype-request': 'prototype', 'visual-request': 'visual' }[kind];
        if (tapped && body.key) {
          // docs/adr/2026-11-12-0700-reply-implement-marks-a-card-ready-to-implement.md: the tap ends an Implement or Close mark.
          await clearOwnerWait(here, String(body.key));
          await planAgain(here, String(body.key), tapped, {
            ...(body.text ? { text: String(body.text) } : {}),
            ...(Array.isArray(body.files) && body.files.length ? { files: body.files } : {}),
            ...(body.question ? { question: String(body.question), ...(body.note ? { note: String(body.note) } : {}), ...(body.choice != null ? { choice: body.choice } : {}) } : {}),
          });
        }
        if (kind === 'ask-withdrawn') await setHidden(here, String(body.id || ''), true);
        // docs/adr/2026-11-03-0500-every-owner-tap-the-server-can-apply-draws-at-once.md
        return json(res, 200, { id, board: await answerBoard(req, since) });
      }
      if (p === '/api/rules' && req.method === 'GET') return json(res, 200, { board: await readBoardRules(here), hub: readHubRules() });
      if (p === '/api/rules' && req.method === 'POST') {
        const body = await readBody(req);
        let saved;
        try { saved = await saveBoardRules(here, body.rules, body.base ?? []); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
        const id = rulesChanged(saved.changes) ? await appendEvent('rules', { scope: 'board', ...saved.changes }) : null;
        return json(res, 200, { rules: saved.rules, id });
      }
      if (p === '/api/settings' && req.method === 'GET') return json(res, 200, { settings: await readBoardSettings(here), paused_until: boardPausedUntil(here), pause_choices: HOLD_CHOICES });
      // Board Settings' Build target picker (docs/adr/2026-11-05-1823-board-settings-picks-which-build-script-a-board-runs.md).
      if (p === '/api/build-targets' && req.method === 'GET') {
        const self = boardAt(here);
        if (!self) return json(res, 404, { error: 'This board isn’t in the hub’s manifest.' });
        const source = boardRepo(self.route);
        return json(res, 200, { targets: await listBuildTargets(source.repo, mainRefOf(source)) });
      }
      if (p === '/api/pause' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'pause' || typeof body.pause !== 'string') return json(res, 400, { error: 'Send only {pause: a duration, a date and time, or off}.' });
        let pausedUntil;
        try { pausedUntil = await setBoardPause(here, body.pause); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
        if (pausedUntil) boardPaused = true;
        track(checkAuto());
        return json(res, 200, { paused_until: pausedUntil });
      }
      if (p === '/api/permissions') {
        const self = boardAt(here);
        if (!self) return json(res, 404, { error: 'This board isn’t in the hub’s manifest.' });
        const folder = boardRepo(self.route).repo;
        const body = req.method === 'POST' ? await readBody(req) : null;
        try {
          if (body) await setPermission(folder, here, body.id, body.on);
          return json(res, 200, await permissionsView(folder, here));
        } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
      }
      if (p === '/api/try/main/log' && req.method === 'GET') return json(res, 200, { lines: await tryLogTail(here, 'main') });
      if (p === '/api/try/prototypes' && req.method === 'GET') {
        const run = (await readJSON(path.join(here, 'data', 'try.json'), {}))?.prototypes || {};
        const starting = run.state === 'running' || run.state === 'failed';
        return json(res, 200, { state: run.state || null, https: run.state === 'ready' ? run.https || null : null, since: run.state === 'ready' ? run.since || null : null, lines: run.state === 'failed' ? await tryLogTail(here, 'prototypes') : [],
          step: starting ? run.step || null : null, stepAt: starting ? run.stepAt || null : null, steps: starting ? run.steps || [] : [],
          last: run.state === 'running' ? lastLogLine(await tryLogTail(here, 'prototypes')) : null, error: run.state === 'failed' ? run.error || null : null });
      }
      if (p === '/api/log' && req.method === 'GET') {
        const name = url.searchParams.get('file') || '';
        if (!/^[\w.-]+\.log$/.test(name) || name.startsWith('.')) return json(res, 400, { error: 'file takes a log file’s name.' });
        let file;
        try {
          file = await fs.open(path.join(home, '.claude', 'kickflip', 'logs', name), 'r');
          const { size } = await file.stat();
          const start = Math.max(0, size - 256 * 1024);
          const buffer = Buffer.alloc(size - start);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
          const text = buffer.subarray(0, bytesRead).toString('utf8');
          return json(res, 200, { text: start ? text.slice(text.indexOf('\n') + 1) : text, truncated: start > 0, size });
        } catch (e) {
          if (e.code === 'ENOENT') return json(res, 404, { error: 'No such log.' });
          throw e;
        } finally { await file?.close(); }
      }
      if (p === '/api/transcript' && req.method === 'GET') {
        const name = url.searchParams.get('file') || '';
        if (!/^[\w.-]+\.log$/.test(name) || name.startsWith('.')) return json(res, 400, { error: 'file takes a log file’s name.' });
        if (!/^\d+$/.test(url.searchParams.get('from') || '')) return json(res, 400, { error: 'from takes a byte offset.' });
        try {
          return json(res, 200, await readRunTranscript(path.join(home, '.claude', 'kickflip', 'logs', name), Number(url.searchParams.get('from'))));
        } catch (e) {
          if (e.code === 'ENOENT') return json(res, 404, { error: 'No such log.' });
          throw e;
        }
      }
      if (p === '/api/try/main/pull' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return json(res, 400, { error: 'Send an empty object.' });
        try {
          const response = await fetch(`http://127.0.0.1:${process.env.KICKFLIP_HUB_PORT || 4500}/_hub/pull`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ route: prefix.slice(1) || path.basename(here) }), signal: AbortSignal.timeout(30_000),
          });
          return json(res, response.status, await response.json());
        } catch (e) { return json(res, 502, { error: `Could not pull: ${e.message}` }); }
      }
      if ((p === '/api/try' || p === '/api/try/kill') && req.method === 'POST') {
        const body = await readBody(req);
        const kill = p === '/api/try/kill';
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'key' && (kill || k !== 'anyway')) || typeof body.key !== 'string'
          || (kill && ['main', 'prototypes'].includes(body.key)) || !['undefined', 'boolean'].includes(typeof body.anyway)) return json(res, 400, { error: kill ? 'Send only the task key.' : 'Send only the task key and anyway.' });
        try {
          const response = await fetch(`http://127.0.0.1:${process.env.KICKFLIP_HUB_PORT || 4500}/_hub/${kill ? 'kill' : 'build'}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ route: prefix.slice(1) || path.basename(here), key: body.key, ...(body.anyway ? { anyway: true } : {}) }), signal: AbortSignal.timeout(10_000),
          });
          return json(res, response.status, await response.json());
        } catch (e) { return json(res, 502, { error: `Could not ${kill ? 'kill the serve' : 'start the build'}: ${e.message}` }); }
      }
      if (p === '/api/share' && req.method === 'POST') {
        try { return json(res, 200, await saveBoardShare(here, await readBody(req))); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
      }
      if (p === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req);
        let saved;
        try { saved = await saveBoardSettings(here, body); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
        // The board server alone acts on idle_notification (checkIdle), so it wakes no session.
        const told = saved.changed.filter((k) => k !== 'idle_notification');
        // A setting cleared back to its default, such as build_target, reads null.
        const id = told.length ? await appendEvent('settings', Object.fromEntries(told.map((k) => [k, saved.settings[k] ?? null]))) : null;
        // An approved PR merges on the session's GitHub tick once auto-merge is on (docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md).
        if (saved.changed.includes('auto_merge') && saved.settings.auto_merge) await appendEvent('check-github', { reason: 'auto-merge' });
        return json(res, 200, { settings: saved.settings, id });
      }
      if (p === '/api/arch-review' && req.method === 'POST') {
        await readBody(req);
        try { return json(res, 200, await runReview()); } catch (e) { if (e instanceof BoardError) return json(res, e.status || 400, { error: e.message }); throw e; }
      }
      if (p === '/api/hide' && req.method === 'POST') {
        const body = await readBody(req);
        try { await setHidden(here, String(body.id || ''), body.hidden !== false); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
        return json(res, 200, { ok: true });
      }
      if (p === '/api/read' && req.method === 'POST') {
        const { marks } = await readBody(req);
        const valid = marks && typeof marks === 'object' && !Array.isArray(marks) && Object.values(marks).every((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t)));
        if (!valid) return json(res, 400, { error: 'Send {marks: {card key: ISO time}}.' });
        await markRead(here, (await sharedBoard()).items.map((i) => i.key), marks);
        return json(res, 200, { ok: true });
      }
      if (p === '/_claude/events' && req.method === 'GET') {
        return json(res, 200, await listEvents(url.searchParams.get('kind'), Math.min(500, Number(url.searchParams.get('limit') || 100))));
      }
      if (p === '/api/upload' && req.method === 'POST') return await upload(req, res);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      if (p.startsWith('/uploads/')) return await sendUpload(req, res, decodeURIComponent(p.slice(9)));
      if (p === '/plan.html') { res.writeHead(302, { location: `notes.html${url.search}`, 'cache-control': 'no-store' }).end(); return; }
      if (p === '/index.html') { res.writeHead(302, { location: `./${url.search}`, 'cache-control': 'no-store' }).end(); return; }

      const shell = VIEW_PAGES.has(p.slice(1));
      const proto = shell ? null : await recordedPrototype(p);
      const file = shell ? null : proto ? PROTOTYPE_TEMPLATE : p === '/prototype.html' ? null : await staticFile(decodeURIComponent(p));
      if (!shell && !file) { res.writeHead(404).end(); return; }
      const ext = shell ? '.html' : path.extname(file).toLowerCase();
      const st = shell ? null : await fs.stat(file);
      let body = shell ? Buffer.from(shellHtml({ touchIcon: await touchIcon() })) : proto ? Buffer.from(await prototypePage(here, proto)) : await fs.readFile(file);
      if (!shell && ext === '.html') body = (await pageHeaders(body.toString('utf8'))).replaceAll('{{title}}', esc((await config()).title)).replaceAll('{{touchIcon}}', await touchIcon());
      if (!shell && ext === '.html') body = Buffer.from(await versionAssets(body, p));
      const etag = ext === '.html' ? `W/"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20)}"` : `W/"${versionOf(st)}"`;
      const pinned = ext !== '.html' && url.searchParams.get('v') === versionOf(st);
      const headers = { 'content-type': routeRecord(types, ext) || 'application/octet-stream', 'cache-control': pinned ? 'public, max-age=31536000, immutable' : 'no-cache', etag };
      if (sameTag(req.headers['if-none-match'], etag)) { res.writeHead(304, { etag, 'cache-control': headers['cache-control'], vary: 'accept-encoding' }).end(); return; }
      return await send(res, 200, headers, body);
    } catch (err) {
      if (!res.headersSent) {
        if (err.status === 403) res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(err.message);
        else if (err instanceof BoardError) json(res, err.status || 400, { error: err.message });
        else res.writeHead(err.status || (err.code === 'ENOENT' ? 404 : 400)).end();
      }
    }
  }

  // docs/adr/2026-11-02-1727-a-card-can-be-held-until-a-time.md
  let checkingPickUps = false;
  async function checkPickUps() {
    if (checkingPickUps) return;
    checkingPickUps = true;
    try {
      const at = now().getTime();
      const due = (await sharedBoard()).items
        .filter((it) => it.heldUntil && it.lane !== 'done' && Date.parse(it.heldUntil) <= at);
      // The resumed item file stops a second pick-up; the event log covers a restart between the event and that write.
      const sent = due.length ? await readLines(events) : [];
      for (const { key, heldUntil: until } of due) {
        await pickUp(here, key, until, { announce: !sent.some((e) => e.kind === 'card-unblocked' && e.data?.key === key && e.data?.until === until) });
        await resumeRun(key);
        logCall({ call: 'pick-up', key, result: 'resumed', reason: 'Its hold ended.', inputs: { heldUntil: until } });
      }
    } catch (err) {
      console.error('Pick-up check failed:', err.message);
    } finally {
      checkingPickUps = false;
    }
  }

  // docs/adr/2026-11-14-1700-a-ready-task-unpulled-a-day-re-stages-when-main-has-moved.md
  // Each minute, a ready card unpulled for a day goes back to staging when the base branch has moved since its ready.
  async function checkReadyExpiry() {
    try {
      const { repo, base } = builderRepo(here);
      const main = git(repo, 'rev-parse', base);
      if (main.ok && (await restageStaleReady(here, main.out, now())).length) dataVersion++;
    } catch (err) {
      console.error('Ready expiry check failed:', err.message);
    }
  }

  // docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md
  // The Auto jobs, run on every board change and once at start: the landers, rebase runs and resumes on cards already
  // holding their slot, triage, then the pull, then a review. The pull fills the free implementer
  // slots with Todo's top ready cards, bumped first (domain.mjs pullOf, docs/adr/2026-11-05-0802-todo-has-no-queue.md,
  // docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md).  // The pull fills every free implementer slot whatever else runs; triage and the review wait for an idle
  // board. An unanswered triage holds only the cards it names, until quiet hours end, and a card pulled and not yet started holds the
  // review. None goes out while usage is paused or the Mac is busy, nor, near the line, while the last Claude start hasn't
  // reported its usage (shared/usage-gate.mjs launchHeld), each launch checking again (launchHeldNow), so near the line a
  // pass starts one agent; the minute check runs the jobs again once the hold lifts, since it lives outside the board's
  // data. A grill or prototype asked for during a hold launches first. A check asked for while one runs runs again after it.
  let checkingAuto = null;
  let autoAgain = false;
  let heldByPause = false;
  // Whether the last check found this board's own pause in force: once it lifts with nothing else pausing, the board wakes
  // its session with usage-resumed {window: 'manual'}, as the hub does every board when a hub-wide pause lifts
  // (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md). Setting a pause marks it at once, so a
  // lift that follows before any check ran still wakes the session.
  let boardPaused = false;
  function checkAuto() {
    if (checkingAuto) { autoAgain = true; return checkingAuto; }
    checkingAuto = (async () => {
      do {
        autoAgain = false;
        try { await runAuto(); } catch (err) { console.error('Auto check failed:', err.message); }
      } while (autoAgain);
    })().finally(() => { checkingAuto = null; });
    return checkingAuto;
  }
  async function runAuto() {
    const settings = settingsOf(await config());
    // docs/adr/2026-11-12-1000-a-planner-whose-process-is-gone-closes-at-once.md: before the board is read, so the line
    // lands now and the card's next brief launches in this pass.
    const gone = await closeGonePlanners(here, {
      alive: (record) => agentMayRun({ pid: record.session.pid, at: record.session.at }),
      failure: (record) => runFailure(path.join(home, '.claude', 'kickflip', 'logs', record.session.log ?? '')),
      limited: (record) => (record.session.log ? runLimit(path.join(home, '.claude', 'kickflip', 'logs', record.session.log)) : null),
    });
    for (const c of gone) {
      if (c.limited) await saveQueuedPlanners({ ...(await readJSON(queuedPlanners, {})), [c.key]: { kind: c.kind, kept: c.limited.brief, until: c.limited.until } });
      logCall({ call: 'planner-gone', key: c.key, result: c.limited ? 'queued' : c.failed ? 'failed' : 'closed', reason: c.limited ? `Its ${c.kind} run stopped at the usage limit, which resets at ${c.limited.until}; it relaunches then.` : `Its ${c.kind} planner's process was gone with its record open.`, inputs: c });
    }
    if (gone.length) dataVersion++;
    const log = await readLines(events);
    const { items, reviews } = await sharedBoard();
    const hold = await triageHold(log);
    const pulled = await sentOf(PULL);
    const cap = settings.max_implementers;
    const gate = readUsageGate({ dir: here });
    if (boardPaused && gate.state !== 'paused') await appendEvent('usage-resumed', { window: 'manual' });
    boardPaused = gate.manual === 'board';
    heldByPause = launchHeld(gate, 'claude');
    if (!heldByPause) await launchQueuedPlanners();
    if (!heldByPause) await launchBriefs(items);
    if (!heldByPause) await launchLanders(items, stoppedKeys(items));
    if (!heldByPause) await launchRebases(items, stoppedKeys(items));
    const resumes = await checkPauses(items, gate);
    if (!heldByPause) for (const key of resumes) await resumeBuild(key);
    const { idle, pullable, retitle, waiting, pulls, helpers } = pullOf(items, { cap, pulled, hold });
    const ready = idle && !heldByPause;
    // docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md: the pull refuses a ready card it can't title its PR by,
    // once, as builder start would, and the refusal stays on the Todo card until it is retitled.
    for (const key of retitle) {
      const card = items.find((i) => i.key === key);
      const why = startTitleFault(key, card.title);
      const refusal = { why, brief: startTitleBrief(card.title) };
      if (card.refusal === hubText(BUILD_REFUSED, refusal)) continue;
      await appendStatus(here, key, BUILD_REFUSED, refusal);
      logCall({ call: 'pull', key, result: 'refused', reason: why, inputs: { title: card.title } });
      dataVersion++;
    }
    if (!heldByPause) await launchHelpers(helpers);
    await checkTriage(settings, log, items, ready);
    const held = pullable.filter((k) => hold.includes(k));
    if (held.length) logCall({ call: 'pull', result: 'held', reason: 'An overnight triage waits for the session\'s reply and names these tasks, so the pull leaves them until it is answered or quiet hours end.', inputs: { cards: held } });
    // Near the line the pull starts one card a pass, and none once another launch is waiting on its first reading.
    const pullNow = (gate) => (launchHeld(gate, 'claude') ? [] : gate.near && !gate.near.going ? pulls.slice(0, 1) : pulls);
    const startPull = async (key) => {
      const started = await startTappedBuild(here, key, (opts) => boardWorktree(here, key.split('/')[1], opts), 'hub');
      logCall({ call: 'pull', key, result: startResult(started), reason: 'An implementer slot was free and it was the top ready task in Todo.', inputs: { cap, pullable, waiting } });
      return handOff(started);
    };
    // A card that already has a builder, as a pass an instant earlier left it, is not started again.
    const unstarted = [];
    for (const key of heldByPause ? [] : pullNow(readUsageGate({ dir: here }))) {
      const tracked = (await readJSON(path.join(data, 'headless-builders.json'), {}))[key];
      if (!hasBuilder(await openRuns(here, key)) && !(tracked?.pid && pidAlive(tracked.pid))) { unstarted.push(key); continue; }
      logCall({ call: 'pull', key, result: 'skipped', reason: 'It already has a builder.', inputs: {} });
    }
    if (await sendPulls(PULL, waiting, unstarted, startPull)) return;
    // docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md: one review at a time, after any pull.
    const { due, repo } = reviews;
    if (!ready || !due) return;
    logCall({ call: 'pr-review', result: 'asked', reason: `The board is idle and PR #${due.number} touches its work.`, inputs: { repo, pr: due.number, head: due.head, touches: due.touches, asked: Boolean(due.asked) } });
    await appendEvent('pr-review', { pr: due.number, head: due.head, repo, title: due.title, author: due.author, url: due.url, touches: due.touches, asked: Boolean(due.asked) });
  }

  // Whether a launch of kind the board would make now is held (shared/usage-gate.mjs launchHeld). A hold found partway
  // through a pass marks the board held, so the minute check brings in the next pass once it lifts.
  function launchHeldNow(kind = 'claude') {
    const held = launchHeld(readUsageGate({ dir: here }), kind);
    if (held) heldByPause = true;
    return held;
  }

  // What a start the server made came to, for the audit log: started, bumped behind its blockers, or refused.
  const startResult = (started) => (!started ? 'refused' : started.bumped ? 'bumped' : 'started');

  // docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
  // A build the server started ({key, kind, model, worktree}, startTappedBuild's) launches its builder here, Claude or
  // Codex. A launch that fails puts the card back in Todo with the reason (store.mjs abandonLaunch). The start wrote
  // the card's files, so the cached board is dropped: one built mid-start would show the card neither pullable nor
  // building, and the next pull would fill its slot again. → null, the tap's event id, since no event wakes the session.
  async function handOff(started) {
    dataVersion++;
    if (!started || started.bumped) return null;
    const entry = { kind: started.kind, model: started.model, relaunched: false };
    try {
      // A pause on its kind, a busy host, or a start near the line waiting on its first reading, that began after the pull
      // or the tap, holds the launch; reviveHeadless launches it once the hold lifts. A busy Mac says so on the card
      // (docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md).
      const gate = readUsageGate({ dir: here });
      if (launchHeld(gate, started.kind)) {
        logCall({ call: 'launch-held', key: started.key, result: 'held', reason: pauseReasonFor(gate, started.kind), inputs: { kind: started.kind, model: started.model ?? null, gate } });
        if (gate.machine.state === 'busy') await appendStatus(here, started.key, 'host-busy');
        await trackLaunch(started.key, { ...entry, pid: null });
      } else {
        const { pid, log } = await launchBuilder(here, started, { launch });
        await trackLaunch(started.key, { ...entry, pid, log });
      }
    } catch (e) {
      await abandonLaunch(here, started.key, `the launch failed: ${e.message}`);
    }
    return null;
  }

  // docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
  // Each requested helper domain.mjs pullOf lets launch ({key, name}) opens its record (store.mjs startHelper), one that
  // writes in its own worktree off the card's branch, and launches headless. One that can't start or launch leaves a
  // thread line and its record closed, which its spawner's agent wait reports. Its open record keeps it off the list from
  // then on, so the cached board is dropped, as handOff does.
  async function launchHelpers(helpers) {
    for (const { key, name } of helpers) {
      if (launchHeldNow()) return;
      dataVersion++;
      try {
        const started = await startHelper(here, key, name, (opts) => helperWorktree(key.split('/')[1], name, opts));
        if (!started) continue;
        logCall({ call: 'helper', key, result: 'launching', reason: 'A helper was asked for and pullOf let it launch.', inputs: { name, model: started.model, worktree: started.worktree } });
        try { await launchBuilder(here, started, { launch }); } catch (e) {
          await abandonPlanner(here, key, ['helper-failed', { name, error: e.message }], name);
        }
      } catch (e) {
        if (!(e instanceof BoardError)) throw e;
        await abandonPlanner(here, key, ['helper-failed', { name, error: e.message }], name);
      }
    }
  }

  // docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
  // Each agent due from a written brief (domain.mjs briefsDue) launches: a grill or prototype planner (launchPlanner), or
  // a visual agent headless in the board's repo beside whatever else runs on the card
  // (docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md, store.mjs startVisual), so an agent's
  // finish, which changes its record, brings in the card's next brief. A visual that can't start or launch leaves a thread
  // line and its record, if any, closed. Passes run one at a time, and the starts read the card again, so a brief opens
  // one record however stale items is.
  let briefsPass = Promise.resolve();
  function launchBriefs(items) {
    const pass = briefsPass.then(() => launchBriefed(items));
    briefsPass = pass.catch(() => {});
    return pass;
  }
  async function launchBriefed(items) {
    for (const { key, kind } of briefsDue(items)) {
      if (launchHeldNow()) return;
      dataVersion++;
      if (kind !== 'visual') { await launchPlanner(key, kind); continue; }
      try {
        const started = await startVisual(here, key);
        if (!started) continue;
        try { await launchBuilder(here, started, { launch }); } catch (e) {
          await abandonPlanner(here, key, ['planner-failed', { kind: 'visual agent', error: e.message }], started.agent);
        }
      } catch (e) {
        if (!(e instanceof BoardError)) throw e;
        await appendStatus(here, key, 'planner-failed', { kind: 'visual agent', error: e.message });
      }
    }
  }

  // A planner, kind grill or prototype, opens on the card from its written brief, or from kept, the briefs entry of the
  // run a Hold stopped, and launches headless in the board's repo (store.mjs startPlanner), unless an agent already works
  // on it. One that can't start or launch leaves a thread line and its record closed. One due while the board's launches
  // are held (launchHeld) waits in data/queued-planners.json {<key>: {kind, kept}}, with a thread line saying so, and
  // launches when the hold lifts (launchQueuedPlanners); another replaces it.
  // (docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md)
  const queuedPlanners = path.join(data, 'queued-planners.json');
  async function saveQueuedPlanners(queued) {
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(queuedPlanners + '.tmp', JSON.stringify(queued) + '\n');
    await fs.rename(queuedPlanners + '.tmp', queuedPlanners);
  }
  async function launchPlanner(key, kind, kept = null) {
    const gate = readUsageGate({ dir: here });
    if (launchHeld(gate, 'claude')) {
      heldByPause = true;
      await saveQueuedPlanners({ ...(await readJSON(queuedPlanners, {})), [key]: { kind, ...(kept ? { kept } : {}) } });
      logCall({ call: 'planner-queued', key, result: kind, reason: pauseReasonFor(gate, 'claude'), inputs: { kind, gate } });
      await appendStatus(here, key, gate.machine.state === 'busy' ? 'host-busy' : 'planner-held', { kind });
      return;
    }
    try {
      const started = await startPlanner(here, key, kind, kept);
      if (!started) return;
      try { await launchBuilder(here, started, { launch }); } catch (e) {
        await abandonPlanner(here, key, ['planner-failed', { kind, error: e.message }]);
      }
    } catch (e) {
      if (!(e instanceof BoardError)) throw e;
      await appendStatus(here, key, 'planner-failed', { kind, error: e.message });
    }
  }

  // docs/adr/2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md
  // A resumed card (the owner's Resume, or its pick-up time) gets back the run its hold stopped, with no session: a grill
  // or prototype launches again, and a build starts afresh as the pull starts one. A card whose hold stopped nothing is
  // the pull's. A lander or rebase run is left to the board's own lander and rebase jobs. A start the board refuses is its
  // thread line, and a card left with nothing running is the orchestrator's wait (domain.mjs orchestratorWaitOf).
  async function resumeRun(key) {
    const run = await takeHoldStopped(here, key);
    if (!run) return;
    logCall({ call: 'resume', key, result: run.kind, reason: 'Its hold stopped this run.', inputs: run });
    if (run.kind === 'grill' || run.kind === 'prototype') await launchPlanner(key, run.kind, run.brief);
    else if (run.label === 'Builder') await handOff(await startTappedBuild(here, key, (opts) => boardWorktree(here, key.split('/')[1], opts), 'hub'));
  }

  // docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
  // One pass of the card pauses (domain.mjs pauseWork) over the built items, with gate the usage gate: each running build
  // a usage pause or Pause board or hub now holds is asked to pause, a pause whose cause cleared before its builder
  // stopped comes off, and a build still running PAUSE_HARD_STOP after it was asked is marked paused and its
  // board-launched process stopped. pausesLive keeps the minute check running the pass while any pause stands.
  // → the keys of the paused builds due to resume, oldest pause first.
  let pausesLive = false;
  async function checkPauses(items, gate) {
    const opts = { usageHeld: (kind) => pausesRunning(gate, kind) };
    const work = pauseWork(items, opts);
    // docs/adr/2026-11-10-1400-the-auto-pass-re-reads-a-pause-before-dropping-it.md
    if (work.drop.length) { dataVersion++; work.drop = confirmedDrops(work.drop, (await sharedBoard()).items, opts); }
    for (const key of work.ask) {
      if (await requestPause(here, key, { cause: 'usage', words: pausedWords(gate) })) logCall({ call: 'pause', key, result: 'asked', reason: pauseReasonFor(gate, 'claude'), inputs: { gate } });
    }
    for (const key of work.drop) {
      await dropPause(here, key);
      logCall({ call: 'pause', key, result: 'dropped', reason: 'Its cause cleared before its builder reached a stopping point.', inputs: {} });
    }
    for (const key of work.stop) {
      await markPaused(here, key);
      const agent = launchedAgents((await openRuns(here, key)).filter((r) => !plans(r)))[0];
      const stopped = agent ? await stopRuns([agent.pid]) : [];
      logCall({ call: 'pause', key, result: 'hard stop', reason: 'Its builder reached no stopping point within 15 minutes of the pause.', inputs: { stopped: stopped.map((p) => p.pid) } });
    }
    if (work.ask.length || work.drop.length || work.stop.length) dataVersion++;
    pausesLive = work.ask.length > 0 || items.some((i) => i.builder?.pause);
    return work.resume;
  }

  // A paused build nothing pauses any more resumes: its pause comes off with a "Resumed: …" line (store.mjs
  // resumePaused), and a build the board launched resumes in its own session (headless.mjs resumeBuilder), tracked as a
  // fresh launch. A session's own builder is the orchestrator's to resume: builder-resume wakes it.
  async function resumeBuild(key) {
    // A builder whose hard stop got no answer from ps may still run: the pause stays until its process is gone.
    if (hasBuilder((await openRuns(here, key)).filter((r) => r.pid))) return;
    const resumed = await resumePaused(here, key);
    if (!resumed) return;
    const { pause, record } = resumed;
    const cleared = PAUSE_CLEARS[pause.cause][1];
    dataVersion++;
    const entry = { call: 'resume', key, reason: `Nothing pauses it any more: ${cleared}.`, inputs: { pause } };
    if (!record.session?.pid) {
      logCall({ ...entry, result: 'woke the orchestrator' });
      return appendEvent('builder-resume', { key, cleared });
    }
    const kind = providerOf(record.kind) ?? 'claude';
    try {
      const why = `The board paused this build, and the pause has cleared: ${cleared}.`;
      const { pid, log, resumed } = await resumeBuilder(here, { key, kind, model: record.model, session: { id: record.session.id, log: record.session.log }, brief: (facts) => resumeBrief({ ...facts, cleared }), why, launch });
      await trackLaunch(key, { kind, model: record.model, pid, log, relaunched: false });
      logCall({ ...entry, result: resumed ? 'resumed' : 'fresh builder' });
    } catch (e) {
      logCall({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
      await appendStatus(here, key, 'resume-failed', { error: e.message });
    }
  }

  // The planners launchPlanner queued during a hold, oldest asked first, each once, until a launch is held again.
  async function launchQueuedPlanners() {
    for (const [key, { kind, kept, until }] of Object.entries(await readJSON(queuedPlanners, {}))) {
      if (launchHeldNow()) return;
      if (until && Date.parse(until) > Date.now()) continue;
      const { [key]: _, ...rest } = await readJSON(queuedPlanners, {});
      await saveQueuedPlanners(rest);
      logCall({ call: 'planner-queued', key, result: 'launching', reason: 'The hold it waited on has lifted.', inputs: { kind } });
      if (kind === 'visual') await restoreBrief(here, key, kept);
      else await launchPlanner(key, kind, kept);
      dataVersion++;
    }
  }

  // docs/adr/2026-11-04-1010-a-dead-headless-builder-is-relaunched-once.md
  // data/headless-builders.json {<key>: {kind, model, pid, log, relaunched, until?}}: the headless builders launched, with
  // their run logs, for reviveHeadless.
  // trackLaunch sets a key's entry, or with null drops it (a lander takes the card over from its builder).
  async function trackLaunch(key, entry) {
    const file = path.join(data, 'headless-builders.json');
    const tracked = await readJSON(file, {});
    if (entry) tracked[key] = entry; else delete tracked[key];
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(file + '.tmp', JSON.stringify(tracked) + '\n');
    await fs.rename(file + '.tmp', file);
  }
  // docs/adr/2026-11-05-2130-a-restarted-server-launches-the-build-its-pull-left-without-a-builder.md
  // At startup: a build the previous process started but died before launching (store.mjs cutOffBuilds) that
  // headless-builders.json doesn't list gets its builder now, as the pull would have launched it.
  async function launchCutOffBuilds() {
    try {
      const tracked = await readJSON(path.join(data, 'headless-builders.json'), {});
      for (const started of (await cutOffBuilds(here)).filter((c) => !tracked[c.key])) {
        logCall({ call: 'launch-cut-off', key: started.key, result: 'launching', reason: 'A restart cut off the launch after its build started.', inputs: { kind: started.kind, model: started.model ?? null } });
        await handOff(started);
      }
    } catch (e) { console.error('Cut-off launch check failed:', e.message); }
  }
  // The cards whose run the orchestrator stopped (domain.mjs builderOf), which nothing relaunches.
  const stoppedKeys = (items) => new Set(items.filter((c) => c.builder?.stopped).map((c) => c.key));
  // Once a minute: a headless builder whose usage isn't held and whose process exited with its record open launches again
  // once, and after that leaves a thread line; its record stays open, so its stale wait brings in the orchestrator. One
  // whose run log ends on the usage limit (hub/usage.mjs runLimit) keeps its relaunch: it reads paused, and the pause pass
  // resumes it once the limit resets (docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md,
  // docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md). A paused build is never relaunched.
  let revivingHeadless = false;
  async function reviveHeadless() {
    if (revivingHeadless) return;
    revivingHeadless = true;
    try {
      const file = path.join(data, 'headless-builders.json');
      const tracked = await readJSON(file, {});
      if (!Object.keys(tracked).length) return;
      const { items } = buildBoard(await itemSnapshot(await outsideData()));
      const open = new Set(items.filter((c) => c.lane !== 'done' && c.builder && !c.builder.planner).map((c) => c.key));
      const handBack = async (card) => {
        logCall({ call: 'relaunch', key: card.key, result: 'handed back', reason: 'Its builder exited twice with its record open.', inputs: tracked[card.key] });
        await appendStatus(here, card.key, 'exited-twice');
      };
      const relaunch = async (card) => {
        const was = tracked[card.key];
        const entry = { call: 'relaunch', key: card.key, inputs: was,
          reason: was.pid === null ? 'Its launch was held by a pause, a busy host or a start near the line, which has lifted.' : 'Its builder exited with its record open, for the first time.' };
        try {
          const { pid, log } = await launchBuilder(here, card, { launch });
          logCall({ ...entry, result: was.pid === null ? 'launched' : 'relaunched' });
          return { pid, log };
        } catch (e) {
          logCall({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
          await appendStatus(here, card.key, 'relaunch-failed', { error: e.message });
          return { pid: null };
        }
      };
      // docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md: the run the limit stopped
      // is the same pause, resumed in its own session once the limit resets.
      const atLimit = async (card, until) => {
        logCall({ call: 'relaunch', key: card.key, result: 'paused', reason: `Its run stopped at the usage limit, which resets at ${until}.`, inputs: tracked[card.key] });
        await requestPause(here, card.key, { cause: 'usage', words: 'usage limit', until });
        await markPaused(here, card.key);
        dataVersion++;
      };
      const paused = new Set(items.filter((c) => c.builder?.pause?.paused).map((c) => c.key));
      const next = await reviveBuilders(tracked, open, { launch: relaunch, handBack, held: (kind) => launchHeld(readUsageGate({ dir: here }), kind), stopped: stoppedKeys(items), paused,
        limitedUntil: (entry) => (entry.log ? runLimit(entry.log) : null), atLimit });
      if (JSON.stringify(next) !== JSON.stringify(tracked)) {
        await fs.writeFile(file + '.tmp', JSON.stringify(next) + '\n');
        await fs.rename(file + '.tmp', file);
      }
    } catch (err) {
      console.error('Headless builder check failed:', err.message);
    } finally {
      revivingHeadless = false;
    }
  }

  // The script offers whose Run or Decline is being recorded, so two taps at once record one.
  const scriptTaps = new Set();
  // Starts card key's offered script id in cwd (startScript), a runner that couldn't start going in the audit log.
  function runOfferedScript(key, id, cwd) {
    startScript(here, key, id, cwd).on('error', (e) => logCall({ call: 'script-run', key, result: 'failed', reason: e.message, inputs: { id } }));
  }

  // The land a held card's Merge tap starts: `board.mjs merge <key>`, detached so a land that restarts this server
  // finishes, writing its outcome to the card's thread itself (finish.mjs landHeld).
  function runHeldMerge(key) {
    const logs = path.join(home, '.claude', 'kickflip', 'logs');
    mkdirSync(logs, { recursive: true });
    const out = openSync(path.join(logs, `merge-${key.split('/')[1]}-${now().toISOString().replace(/[:.]/g, '-')}.log`), 'a');
    const cmd = process.env.KICKFLIP_MERGE_CMD ? JSON.parse(process.env.KICKFLIP_MERGE_CMD) : [nodeBin(), BOARD_CLI];
    const child = spawn(cmd[0], [...cmd.slice(1), '--site', route, 'merge', key], { detached: true, stdio: ['ignore', out, out] });
    closeSync(out);
    child.on('error', (e) => appendStatus(here, key, 'land-failed', { why: `the land couldn't start (${e.message})` }).catch(() => {}));
    child.unref();
  }

  // docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md
  // data/landers.json (readLanders): the lander launched for each card's verification, its process and log, and how many
  // times it was relaunched for that verification. Each card whose verified build waits to land (store.mjs landable)
  // takes the one step domain.mjs landStep gives it: running and a skip of landable's (blocked, asking, worktree-gone)
  // leave it, held waits for the hold to clear (the minute check brings in the next pass), launch lands it through its builder (headless.mjs landByBuilder: the first launch resumes
  // the builder, a relaunch is a fresh lander), and fault, the first time, puts the exited-twice line on the card and marks
  // the entry handedBack, so the orchestrator's wait on it is a stale one. A lander whose process has gone while its own
  // record is still open stopped partway: its card is handed back again (store.mjs relaunchLander) and takes its step in
  // this pass. A lander the orchestrator stopped (stopped, the keys whose card reads it) is neither sent back nor
  // relaunched. A dead lander whose card has no lander open and isn't handed back (landed, archived, or built again) has
  // its entry dropped; relaunchLander would restore an archived card from the archive. A lander is only ever due on a
  // handed-back card, so with none handed back (anyChecking false) and none sent back, landable's read of the wave files
  // is skipped. Bumped cards' landers go first; each runs on its card's own slot
  // (docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md).
  async function launchLanders(items, stopped) {
    const anyChecking = items.some((i) => i.waitsOn === 'checking');
    const status = Object.fromEntries(items.map((i) => [i.key, i.waitsOn === 'checking' ? 'checking'
      : i.lane !== 'done' && i.agents?.some((a) => a.started && !a.done && a.label === LANDER) ? 'landing' : null]));
    const file = path.join(data, 'landers.json');
    const sent = await readLanders();
    // A run seen ending on the usage limit keeps that mark, since the limit's reset clears what runLimit reads.
    const kept = Object.fromEntries(Object.entries(sent).map(([key, { alive: _, limited, ...entry }]) => [key, { ...entry, ...(limited ? { limited } : {}) }]));
    const was = JSON.stringify(await readJSON(file, {}));
    const save = async () => {
      if (JSON.stringify(kept) === was) return;
      await fs.writeFile(file + '.tmp', JSON.stringify(kept) + '\n');
      await fs.rename(file + '.tmp', file);
      // The cards' land steps read it.
      dataVersion++;
    };
    let sentBack = false;
    for (const [key, entry] of Object.entries(sent)) {
      if (!entry.pid || entry.alive || stopped.has(key) || status[key] === 'checking') continue;
      if (status[key] !== 'landing') { delete kept[key]; continue; }
      await relaunchLander(here, key);
      sentBack = true;
      logCall({ call: 'lander', key, result: 'handed back again', reason: 'Its lander exited with its record still open.', inputs: kept[key] });
    }
    if (!anyChecking && !sentBack) return save();
    const gate = readUsageGate({ dir: here });
    for (const c of byBump(items, await landable(here))) {
      const step = landStep({ verified: c.verified, entry: sent[c.key], alive: sent[c.key]?.alive, limited: sent[c.key]?.limited, skip: c.skip, held: launchHeldWords(gate, c.kind ?? 'claude') });
      const inputs = { verified: c.verified, before: kept[c.key] ?? null };
      if (step.step === 'held') heldByPause = true;
      if (step.step === 'fault' && !kept[c.key].handedBack) {
        logCall({ call: 'lander', key: c.key, result: 'handed back', reason: 'Its lander was relaunched and exited again without landing.', inputs });
        await appendStatus(here, c.key, 'exited-twice', { run: 'lander' });
        kept[c.key] = { ...kept[c.key], handedBack: true };
      }
      if (step.step !== 'launch') continue;
      const entry = { call: 'lander', key: c.key, reason: step.relaunched ? 'Its lander exited without landing, the first time.' : 'Its build was verified and waits to land.', inputs };
      try {
        const { pid, log, resumed } = await landByBuilder(here, c, { fresh: step.fresh, launch });
        kept[c.key] = { verified: c.verified, pid, log, relaunched: step.relaunched };
        logCall({ ...entry, result: resumed ? 'resumed its builder' : 'launched' });
        await trackLaunch(c.key, null);
      } catch (e) {
        logCall({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
        kept[c.key] = { verified: c.verified, pid: null, relaunched: step.relaunched };
        await appendStatus(here, c.key, 'lander-failed', { error: e.message });
      }
    }
    await save();
  }

  // docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md
  // The due runs [{key}] with the bumped cards' first, the earliest bump first, the rest in their order.
  const bumpOf = (items, key) => items.find((i) => i.key === key)?.bumpedAt || '';
  const byBump = (items, due) => [...due.filter((d) => bumpOf(items, d.key)).sort((a, b) => bumpOf(items, a.key).localeCompare(bumpOf(items, b.key))), ...due.filter((d) => !bumpOf(items, d.key))];

  // docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
  // data/rebases.json {<key>: {conflict, pid}}: the conflict (the PR's head @ the base) each rebase run was started for, so
  // each conflict gets one run, and its process. Each card whose open PR conflicts (domain.mjs rebasesDue) gets a headless
  // rebase run in its worktree, or one made from the PR's branch (store.mjs startRebase). A start or launch that fails
  // leaves a thread line and keeps its conflict, so it isn't retried until the PR's head or base moves. A run takes no
  // implementer slot (docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md).
  // docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md: a run whose process has gone with its
  // record still open takes landStep's step for its conflict, as a lander does for its verification: relaunched once as
  // a fresh run when no hold stands, then, exiting again, the exited-twice line and handedBack, so its card reads stopped
  // (snapshot alive). A run the orchestrator stopped (stopped) is neither.
  async function launchRebases(items, stopped) {
    const file = path.join(data, 'rebases.json');
    const sent = await readJSON(file, {});
    const was = JSON.stringify(sent);
    const { base } = builderRepo(here);
    const gate = readUsageGate({ dir: here });
    for (const [key, run] of Object.entries(sent)) {
      if (!Number.isInteger(run.pid) || run.handedBack || stopped.has(key) || pidAlive(run.pid)) continue;
      const open = items.find((i) => i.key === key)?.agents?.find((a) => a.started && !a.done && a.label === REBASE_LABEL);
      if (!open) continue;
      const limited = Boolean(run.limited) || (Boolean(run.log) && Boolean(runLimit(run.log)));
      // landStep reads a run's conflict where it reads a lander's verification.
      const step = landStep({ verified: run.conflict, entry: { ...run, verified: run.conflict }, limited, held: launchHeldWords(gate, open.kind ?? 'claude') });
      const inputs = { conflict: run.conflict, before: run };
      if (step.step === 'fault') {
        logCall({ call: 'rebase-run', key, result: 'handed back', reason: 'Its rebase run was relaunched and exited again with its record open.', inputs });
        await appendStatus(here, key, 'exited-twice', { run: 'rebase run' });
        sent[key] = { ...run, handedBack: true };
      } else if (step.step === 'held') {
        heldByPause = true;
        if (limited) sent[key] = { ...run, limited };
      } else {
        try {
          const { pid, log } = await landByBuilder(here, { key, kind: open.kind ?? 'claude', model: open.model }, { fresh: step.fresh, launch });
          sent[key] = { conflict: run.conflict, pid, log, relaunched: step.relaunched };
          logCall({ call: 'rebase-run', key, result: 'relaunched', reason: 'Its rebase run exited with its record open, the first time.', inputs });
        } catch (e) {
          logCall({ call: 'rebase-run', key, result: 'failed', reason: `Its rebase run exited with its record open. The launch failed: ${e.message}`, inputs });
          await appendStatus(here, key, 'rebase-launch-failed', { error: e.message });
          sent[key] = { conflict: run.conflict, pid: null, relaunched: step.relaunched };
        }
      }
    }
    const due = byBump(items, rebasesDue(items, Object.fromEntries(Object.entries(sent).map(([k, v]) => [k, v.conflict])), base));
    if (!due.length) {
      if (JSON.stringify(sent) === was) return;
      await fs.writeFile(file + '.tmp', JSON.stringify(sent) + '\n');
      await fs.rename(file + '.tmp', file);
      // A card's alive reads it (snapshot).
      dataVersion++;
      return;
    }
    try {
      for (const d of due) {
        if (launchHeldNow()) break;
        const id = d.key.split('/')[1];
        const entry = { call: 'rebase-run', key: d.key, reason: `Its PR #${d.pr} conflicts with ${base}.`, inputs: { pr: d.pr, conflict: d.conflict, before: sent[d.key] ?? null } };
        sent[d.key] = { conflict: d.conflict, pid: null };
        let started;
        try {
          started = await startRebase(here, d.key, { pr: d.pr, conflict: d.conflict, base }, () => prWorktree(here, id, d.branch));
        } catch (e) {
          if (!(e instanceof BoardError)) throw e;
          logCall({ ...entry, result: 'refused', reason: `${entry.reason} The start refused: ${e.message}` });
          await appendStatus(here, d.key, 'rebase-failed', { pr: d.pr, error: e.message });
          continue;
        } finally { dataVersion++; }
        try {
          const { pid, log } = await landByBuilder(here, started, { launch });
          sent[d.key] = { ...sent[d.key], pid, log };
          logCall({ ...entry, result: 'launched' });
        } catch (e) {
          logCall({ ...entry, result: 'failed', reason: `${entry.reason} The launch failed: ${e.message}` });
          await appendStatus(here, d.key, 'rebase-launch-failed', { error: e.message });
        }
      }
    } finally {
      // Written even when a start throws, so a run already launched in this pass isn't started again.
      await fs.writeFile(file + '.tmp', JSON.stringify(sent) + '\n');
      await fs.rename(file + '.tmp', file);
    }
  }

  // docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md
  // The night an overnight triage would go out now: the host day of the middle of the hub's quiet hours, from that
  // middle until they end, else null. settings.json is read each time, since the owner edits quiet hours.
  async function triageNight() {
    const middle = quietMiddleOf(now(), quietOf(await readJSON(path.join(home, '.claude', 'kickflip', 'settings.json'), {})));
    return middle && localDay(middle);
  }

  // data/triaged.json {seen}: what the last triage saw (domain.mjs triageOf), kept current until that triage's reply so
  // its own merges and dedupes don't read as a change. The event log says when the last triage went out. No new triage
  // goes out while the last has no reply.
  async function checkTriage(settings, log, items, ready) {
    const file = path.join(data, 'triaged.json');
    const marker = await readJSON(file, {});
    const { waiting, seen } = triageOf(items);
    const save = async () => {
      await fs.mkdir(data, { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify({ seen }) + '\n');
      await fs.rename(file + '.tmp', file);
    };
    const last = log.filter((e) => e.kind === 'overnight-triage').at(-1);
    if (last && !(await withReply(last)).reply) { if (marker.seen !== seen) await save(); return; }
    if (!settings.auto_triage || !ready || waiting.length < 2 || seen === marker.seen) return;
    const date = await triageNight();
    if (!date || last?.data?.date === date) return;
    const topic = `overnight-triage-${date}`;
    const owner = await readJSON(path.join(data, 'owner.json'), { topics: [] });
    if (!(owner.topics || []).some((t) => t.id === topic)) await addTopic(here, { id: topic, title: `Overnight triage ${date}` });
    logCall({ call: 'triage', result: 'sent', reason: `Auto triage is on, ${waiting.length} tasks wait on answers, and tonight's triage hadn't gone out.`, inputs: { date, cards: waiting } });
    await appendEvent('overnight-triage', { date, topic, cards: waiting });
    await save();
  }

  // The last overnight-triage event when the session hasn't replied to it, else null.
  async function unansweredTriage(log) {
    const last = log.filter((e) => e.kind === 'overnight-triage').at(-1);
    return last && !(await withReply(last)).reply ? last : null;
  }

  // The cards an unanswered overnight triage holds back from the pull: the ones it names, until quiet hours end.
  async function triageHold(log) {
    const last = await unansweredTriage(log);
    const quiet = quietOf(await readJSON(path.join(home, '.claude', 'kickflip', 'settings.json'), {}));
    return last && quietAt(now(), quiet) ? last.data.cards || [] : [];
  }

  // Whether the minute check runs the Auto jobs for an overnight triage: auto_triage is on, and tonight's hasn't gone out.
  async function triageDue() {
    if (!settingsOf(await config()).auto_triage) return false;
    const date = await triageNight();
    return Boolean(date) && (await readLines(events)).filter((e) => e.kind === 'overnight-triage').at(-1)?.data?.date !== date;
  }

  // docs/adr/2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md
  // The pull starts the build of each card domain.mjs pullOf says fills a free slot, tracked in data/pulled.json
  // (docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md).
  const PULL = { file: 'pulled.json', line: 'pulled' };
  // The marker {keys, at}: keys are the cards started that still wait for their agent, at when the marker last changed.
  // A marker from before the cap holds one key instead. → the keys started.
  const markedOf = (marker) => marker.keys || (marker.key ? [marker.key] : []);
  const sentOf = async ({ file }) => markedOf(await readJSON(path.join(data, file), {}));
  // Writes the thread line and starts each of go, and marks keep and go as started. The
  // marker is written only when its keys move, since each write is itself a board change. → true while any is marked.
  async function sendPulls({ file: name, line }, keep, go, start) {
    const file = path.join(data, name);
    const keys = [...keep, ...go];
    for (const key of go) {
      await appendStatus(here, key, line);
      await start(key);
    }
    if (JSON.stringify(markedOf(await readJSON(file, {}))) !== JSON.stringify(keys)) {
      await fs.mkdir(data, { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify({ keys, at: now().toISOString() }) + '\n');
      await fs.rename(file + '.tmp', file);
    }
    return keys.length > 0;
  }

  // A push this server sends on its own (store.mjs sendPush), logged with why, under the card it is about when key names
  // one, and what it read; one kickflip push refuses is logged as not sent and left at that, so a missing device isn't
  // retried each minute.
  async function sendOwnPush(push, { key, reason, inputs }) {
    const entry = { call: 'push', key, reason, inputs: { tag: push.tag, title: push.title, ...inputs } };
    try {
      await sendPush(here, push);
      logCall({ ...entry, result: 'sent' });
    } catch (e) {
      if (!(e instanceof BoardError)) throw e;
      const why = e.message.split('\n').at(-2) || e.message;
      logCall({ ...entry, result: 'not sent', reason: `${reason} Not sent: ${why}` });
      console.error(`Push ${push.tag} not sent:`, why);
    }
  }

  // docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md
  // data/action-pushes.json {<tag>: {kind, ids}}: what waited on the owner at the last check (domain.mjs ownerActions).
  // A tag that is new, changes kind or gains an open question pushes; one that is gone drops its queued push, or closes
  // the one already sent (docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md). The first
  // check records what already waits without pushing it. A check asked for while one runs runs again after it.
  let checkingActions = null;
  let actionsAgain = false;
  function checkActions() {
    if (checkingActions) { actionsAgain = true; return checkingActions; }
    checkingActions = (async () => {
      do {
        actionsAgain = false;
        try { await pushActions(); } catch (err) { console.error('Action push check failed:', err.message); }
      } while (actionsAgain);
    })().finally(() => { checkingActions = null; });
    return checkingActions;
  }
  async function pushActions() {
    const file = path.join(data, 'action-pushes.json');
    const previous = await readJSON(file, null);
    const actions = ownerActions(await sharedBoard());
    const current = Object.fromEntries(actions.map((a) => [a.tag, { kind: a.kind, ids: a.questions.map((q) => q.id) }]));
    if (previous) {
      for (const a of actions) {
        const was = routeRecord(previous, a.tag);
        const fresh = a.questions.filter((q) => !was?.ids?.includes(q.id));
        if (was?.kind === a.kind && !fresh.length) continue;
        const url = fresh.length ? `questions.html#${encodeURIComponent(fresh[0].id)}` : a.url;
        const reason = !was ? 'Something new waits on the owner.' : was.kind !== a.kind ? `What waits on the owner changed from ${was.kind} to ${a.kind}.` : 'A new question waits on the owner.';
        await sendOwnPush({ kind: 'action', title: a.title, body: fresh[0]?.question || a.body, url: `/${route}/${url}`, tag: a.tag, now: a.now },
          { key: a.tag.startsWith('item-') ? a.tag.slice(5) : undefined, reason, inputs: { was: was ?? null, kind: a.kind, fresh: fresh.map((q) => q.id) } });
      }
      const gone = Object.keys(previous).filter((tag) => !routeRecord(current, tag));
      if (gone.length) {
        const { closed } = await withdraw(gone, route);
        for (const tag of closed) logCall({ call: 'push', key: tag.startsWith('item-') ? tag.slice(5) : undefined, reason: 'It no longer waits on the owner, and its push already went out.', inputs: { tag }, result: 'closed' });
      }
    }
    if (JSON.stringify(current) !== JSON.stringify(previous)) {
      await fs.mkdir(data, { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify(current) + '\n');
      await fs.rename(file + '.tmp', file);
    }
  }

  // docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
  // docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md
  // data/orchestrator-waits.json {waits: [{key, ref, title, kind, since, picked, next, bumped, pushed?}], againAt}: the cards idle on
  // the orchestrator (domain.mjs orchestratorWaits), lanes top-down, which bin/wait-events.mjs prints on every wake. Each
  // check appends at most one orchestrator-waits {added: [key], again: [{key, ref, kind, since, next}]} event once the file
  // is written: added names each card that joins it not picked up, or waits again with a new kind or since; again each
  // one still waiting past its re-wake time (domain.mjs waitsStep), so reading the event lines alone misses no wait. One
  // waiting ORCHESTRATOR_PUSH_AFTER, not picked up, pushes the owner once, and its entry keeps pushed while that wait
  // lasts. Checked on every board change and each minute; a check asked for while one runs runs again after it.
  let checkingWaits = null;
  let waitsAgain = false;
  function checkWaits() {
    if (checkingWaits) { waitsAgain = true; return checkingWaits; }
    checkingWaits = (async () => {
      do {
        waitsAgain = false;
        try { await stepWaits(); } catch (err) { console.error('Orchestrator wait check failed:', err.message); }
      } while (waitsAgain);
    })().finally(() => { checkingWaits = null; });
    return checkingWaits;
  }
  async function stepWaits() {
    const file = path.join(data, 'orchestrator-waits.json');
    const stored = await readJSON(file, null);
    const previous = stored?.waits || [];
    const log = await readLines(events);
    const triage = await unansweredTriage(log);
    const working = await readWorking(here);
    // docs/adr/2026-11-15-0200-a-board-asks-another-board-and-its-orchestrator-answers.md: each question another board
    // asked, after the cards' waits, as a triage is; neither is a card, so neither pushes the owner.
    const questions = boardAskWaits(log, working);
    const current = [...orchestratorWaits(await sharedBoard()), ...(triage ? [triageWaitOf(triage, routeRecord(working, triage.id))] : []), ...questions];
    const notCards = new Set([triage?.id, ...questions.map((q) => q.key)]);
    const step = waitsStep(previous, current, now(), stored?.againAt ?? null);
    const waits = [];
    for (const w of step.waits) {
      if (!notCards.has(w.key) && !w.picked && !w.pushed && now().getTime() - Date.parse(w.since) >= ORCHESTRATOR_PUSH_AFTER) {
        await sendOwnPush({ kind: 'reminder', title: `${w.ref} waits on the orchestrator`, body: `${w.title}: ${w.next}`, url: `/${route}/#selectedCard=${encodeURIComponent(w.key)}`, tag: `wait-${w.key}`, now: true },
          { key: w.key, reason: `It has waited on the orchestrator since ${w.since} and nobody picked it up.`, inputs: { kind: w.kind, since: w.since } });
        waits.push({ ...w, pushed: true });
      } else waits.push(w);
    }
    if (!stored || JSON.stringify(waits) !== JSON.stringify(previous) || step.againAt !== (stored.againAt ?? null)) {
      await fs.mkdir(data, { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify({ waits, againAt: step.againAt }) + '\n');
      await fs.rename(file + '.tmp', file);
    }
    if (step.added.length || step.again.length) await appendEvent('orchestrator-waits', { added: step.added, again: step.again });
  }

  // docs/adr/2026-11-04-0257-an-idle-board-pushes-once-when-it-has-gone-idle.md
  // With idle_notification on, each check steps data/idle.json (domain.mjs idleStep) by whether the board is strictly
  // idle, and once a stretch reaches IDLE_MINUTES it pushes "<board> has gone idle" with what closed since the last idle
  // push (idleSummary). A push that fails still ends the stretch's push, so a missing device isn't retried each minute.
  // Off, the file goes, so turning it on starts a fresh stretch. A check asked for while one runs runs again after it.
  let checkingIdle = null;
  let idleAgain = false;
  function checkIdle() {
    if (checkingIdle) { idleAgain = true; return checkingIdle; }
    checkingIdle = (async () => {
      do {
        idleAgain = false;
        try { await stepIdle(); } catch (err) { console.error('Idle check failed:', err.message); }
      } while (idleAgain);
    })().finally(() => { checkingIdle = null; });
    return checkingIdle;
  }
  async function stepIdle() {
    const file = path.join(data, 'idle.json');
    const cfg = await config();
    if (!settingsOf(cfg).idle_notification) return fs.rm(file, { force: true });
    const previous = await readJSON(file, {});
    const built = await sharedBoard();
    const idle = strictlyIdle(built, { pulled: await sentOf(PULL) });
    const { state, push } = idleStep(previous, { idle, now: now() });
    if (push) {
      await sendOwnPush({ kind: 'reminder', title: `${cfg.title || route} has gone idle`, body: idleSummary(built.items, previous.last), url: `/${route}/`, tag: 'idle', now: true },
        { reason: 'The board has been strictly idle long enough, with idle notifications on.', inputs: { previous } });
    }
    if (JSON.stringify(state) !== JSON.stringify(previous)) {
      await fs.mkdir(data, { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify(state) + '\n');
      await fs.rename(file + '.tmp', file);
    }
  }

  // docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md
  // Each card the build places in a lane other than its stored one moves there (domain.mjs movesOf, store.mjs moveCard),
  // with a thread line saying why, and each whose phase in its lane changed takes it quietly, as the server starts and after each board change. A settle asked for while one runs
  // runs again after it.
  let settling = null;
  let settleAgain = false;
  function settleLanes() {
    if (settling) { settleAgain = true; return settling; }
    settling = (async () => {
      do {
        settleAgain = false;
        try {
          const moves = movesOf(await sharedBoard());
          for (const m of moves) await moveCard(here, m.key, m.to, m.why, m.phase, m.from);
          if (moves.length) dataVersion++;
        } catch (err) { console.error('Lane settle failed:', err.message); }
      } while (settleAgain);
    })().finally(() => { settling = null; });
    return settling;
  }

  // docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md
  // The Done cards past the newest DONE_KEPT move to the archive with their resolved questions (domain.mjs archivedOf,
  // store.mjs archiveCards), as the server starts and after each board change, each with when it closed and its PRs as last read. A check asked
  // for while one runs runs again after it.
  let archiving = null;
  let archiveAgain = false;
  function checkArchive() {
    if (archiving) { archiveAgain = true; return archiving; }
    archiving = (async () => {
      do {
        archiveAgain = false;
        try { await archiveDone(); } catch (err) { console.error('Done archive failed:', err.message); }
      } while (archiveAgain);
    })().finally(() => { archiving = null; });
    return archiving;
  }
  // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md,
  // docs/adr/2026-11-09-2000-old-asks-migrate-into-cards-and-the-ask-only-records-retire.md
  // Each ask with no card, one another board or the hub wrote, or one from before every ask was a card, is filed as its
  // T-<n> card (store.mjs fileAsks): as the server starts, and after a board change that leaves one unfiled.
  async function fileNewAsks({ starting = false } = {}) {
    try {
      if (!starting && !(await sharedBoard()).unfiled.length) return;
      for (const key of await fileAsks(here)) console.log(`filed ask task ${key}`);
    } catch (err) { console.error('Ask filing failed:', err.message); }
  }
  // docs/adr/2026-11-05-0910-read-marks-live-on-the-board.md
  // Each card new to the board is read up to now, and a card gone from it loses its mark (store.mjs markRead), as the
  // server starts and after each board change.
  async function markNewCards() {
    try { await markRead(here, (await sharedBoard()).items.map((i) => i.key)); } catch (err) { console.error('Read marks failed:', err.message); }
  }
  async function archiveDone() {
    if (!archivedOf(await sharedBoard()).length) return;
    const picks = archivedOf(await board());
    const moved = picks.length ? await archiveCards(here, picks.map((c) => ({ key: c.key, closed_at: c.sortAt, prs: c.prs }))) : [];
    if (moved.length) console.log(`Done archive: ${moved.length} card${moved.length === 1 ? '' : 's'} moved`);
  }

  // The server holds its port before any startup side effect: a process that loses the port to another one on the
  // same board rejects here having written and launched nothing
  // (docs/adr/2026-11-14-0730-a-board-server-holds-its-port-before-it-launches-anything.md).
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });

  // docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
  try { for (const line of await migrateFollowups(here)) console.log(line); } catch (e) { console.error('follow-up migration:', e.message); }
  try { for (const line of await migrateStatuses(here)) console.log(line); } catch (e) { console.error('status migration:', e.message); }
  try { for (const line of await migratePhases(here)) console.log(line); } catch (e) { console.error('phase migration:', e.message); }
  try { for (const line of await migrateGates(here)) console.log(line); } catch (e) { console.error('gate backfill:', e.message); }
  try { for (const line of await discussNewCards(here)) console.log(line); } catch (e) { console.error('discussing migration:', e.message); }
  try { for (const line of await stageImplementAsks(here)) console.log(line); } catch (e) { console.error('staging migration:', e.message); }
  try { for (const line of await splitSharedNotes(here)) console.log(line); } catch (e) { console.error('notes split:', e.message); }
  try { await stripDeadFields(here); } catch (e) { console.error('dead-field strip:', e.message); }
  await launchCutOffBuilds();
  await fileNewAsks({ starting: true });
  await settleLanes();
  await checkArchive();
  await markNewCards();
  await watch?.(changed);
  await checkPrototypeWaits();
  await checkPickUps();
  await checkAuto();
  track(checkActions());
  track(checkWaits());
  track(checkIdle());
  started();

  // A write the file watch dropped sends no change signal, so no page reloads and no pass runs on it. Each minute the
  // board is stamped, and a change number that moved since the last stamp signals a change as the watch would
  // (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md). It reads no folder, so lock folders cost nothing.
  async function signalMissedWrites() {
    const stamped = sync.n;
    await pageBoard({ method: 'GET' });
    if (sync.n !== stamped) changed({ read: true });
  }

  // The minute's checks.
  function minute() {
    dataVersion++;
    track(signalMissedWrites());
    track(checkPrototypeWaits());
    track(reviveHeadless());
    // docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md
    track(publishUnscreened(here).then((keys) => { if (keys.length) dataVersion++; }, (err) => console.error('Screen publish failed:', err.message)));
    track(checkPickUps());
    track(checkReadyExpiry());
    // A pause standing, or a usage pause or Pause board or hub starting, runs the pause pass (checkPauses).
    const gate = readUsageGate({ dir: here });
    if ((heldByPause && !launchHeld(gate, 'claude')) || pausesLive || (!heldByPause && pausesRunning(gate, 'claude'))) track(checkAuto());
    else track(triageDue().then((due) => { if (due) return checkAuto(); }, (err) => console.error('Triage check failed:', err.message)));
    track(checkActions());
    track(checkWaits());
    track(checkIdle());
  }
  async function close() {
    clearInterval(ping);
    await settled();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  return { server, changed, minute, settled, close };
}

// Lock folders, installs and build output churn and never hold board files: a path with a segment starting with "." or
// named for build output, or a .tmp file, sends no change, and the per-folder watch never watches such a folder.
const BUILD_OUTPUT = new Set(['node_modules', 'dd', 'DerivedData']);
const ignored = (name) => String(name).endsWith('.tmp') || String(name).split(/[\\/]/).some((s) => s.startsWith('.') || BUILD_OUTPUT.has(s));
// A write the watch reports in root, named name, to changed(file).
const heard = (changed, root, name) => (!name ? changed() : ignored(name) ? undefined : changed(path.join(root, String(name))));
const isFolder = (dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } };
// On macOS and Windows one recursive watch covers the tree; on Linux each folder has its own watch, since Node's
// recursive watch there loses a file once a rename replaces it (docs/adr/2026-11-03-1952-the-board-watches-each-folder-only-on-linux.md).
// A root that doesn't exist yet, that goes, or whose watch fails is retried; the first watch after a retry signals,
// since a write may have landed meanwhile.
function watchTree(root, changed) {
  let stop = () => {};
  let retried = false;
  let retryTimer = null;
  const retry = () => {
    if (retryTimer) return;
    stop();
    retried = true;
    retryTimer = setTimeout(() => { retryTimer = null; start(); }, 2000).unref();
  };
  const start = () => {
    try { stop = (process.platform === 'linux' ? watchEachFolder : watchRecursive)(root, changed, retry); } catch { retry(); return; }
    if (retried) changed();
  };
  start();
}
function watchRecursive(root, changed, retry) {
  const w = watchFiles(root, { recursive: true }, (_, name) => {
    heard(changed, root, name);
    if (!isFolder(root)) retry();
  });
  w.on('error', retry);
  return () => w.close();
}
// A folder's watch sees every write to a file in it, including a file a rename replaced; a folder that appears is
// watched and one that goes is dropped.
function watchEachFolder(root, changed, retry) {
  const watches = new Map();
  const unwatch = (folder) => {
    for (const [dir, w] of watches) if (dir === folder || dir.startsWith(folder + path.sep)) { w.close(); watches.delete(dir); }
  };
  const watchFolder = (folder) => {
    if (watches.has(folder)) return;
    const w = watchFiles(folder, (_, name) => {
      heard(changed, folder, name);
      if (folder === root && !isFolder(root)) return retry();
      if (!name || ignored(name)) return;
      const entry = path.join(folder, String(name));
      if (!isFolder(entry)) unwatch(entry);
      else try { watchFolder(entry); } catch { unwatch(entry); }
    });
    watches.set(folder, w);
    w.on('error', () => (folder === root ? retry() : unwatch(folder)));
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignored(entry.name)) continue;
      try { watchFolder(path.join(folder, entry.name)); } catch { unwatch(path.join(folder, entry.name)); }
    }
  };
  try { watchFolder(root); } catch (error) { unwatch(root); throw error; }
  return () => unwatch(root);
}
// The site's watch, which reports each write to changed: data/ and each item file's folder (every wave's for "waves"),
// a folder inside another watched folder watched only by it.
async function watchBoard(site, changed) {
  const sources = (await boardConfig(site)).items === 'waves' ? [wavesDir()] : (await itemSources(site)).map((s) => s.dir);
  const dirs = [...new Set([path.join(site, 'data'), ...sources].map((d) => path.resolve(d)))];
  for (const dir of dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(o + path.sep)))) watchTree(dir, changed);
}

// Run as a script: the board for the site dir argv[2] (else the working folder) on PORT (4600) under PREFIX, its watch
// on, and its minute's checks every 60 s.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const site = path.resolve(process.argv[2] || process.cwd());
  const prefix = (process.env.PREFIX || '').replace(/\/+$/, '');
  const board = await startServer({ site, port: Number(process.env.PORT || 4600), prefix, watch: (changed) => watchBoard(site, changed) });
  setInterval(board.minute, 60000).unref();
  console.log(`site on http://127.0.0.1:${board.server.address().port}/ (prefix ${prefix || 'none'})`);
}
