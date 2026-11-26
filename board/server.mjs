#!/usr/bin/env node
// Shared board server for kickflip sites: node board/server.mjs <site dir>. The hub
// runs it with PORT and PREFIX (/<route>) set, and strips the prefix before forwarding.
// It writes page events, hidden events, uploads, the owner's card taps and its own passes' files; agent sessions write
// the other files below through bin/board.mjs (store.mjs). Every write goes through files.mjs, as every process's does:
//   reply, thread, topic add, question add|resolve, prototype add|rm, item add|set|relate-ask,
//   builder start|progress|done (bin/agent.mjs is an alias for builder), main set.
// <site dir>/board.json: {title, items, slug, reviewers, rules, auto_merge, auto_build, auto_review, idle_notification, stage_splits, skip_draft, prs, github_login, build_target, scripts}. auto_build asks the hub to
// run each card's build script after each push, and hides the cards' Serve / Build; main always builds after a merge.
// build_target names the script, build-<target>, else build; scripts, kickflip, runs the scripts from the site's scripts/,
// else from the repo's .kickflip/ (build-script.mjs scriptFileOf).
// auto_merge (false when absent) lets the session merge
// an approved, green, clean PR itself; off, the card shows the owner's Merge (settings.mjs settingsOf). rules are the owner's standing instructions to this
// board's session [{id, text, by, at}] (board.mjs rules, hub/rules.mjs). reviewers are the board's own [{name, slack_user, dm,
// github}] (board.mjs reviewers), which the settings page lists and new item files copy. items is "waves" (every
// ~/.claude/waves/*/wave.json, the default) or an item file (data/items.json format) relative to the site dir; slug names a file's items
// (its keys are <slug>/<id>), defaulting to the file's basename. Reviewer links live per PR in
// data/pr-slack.json (slack-store.mjs); review.mjs also reads an item's older review_link_ts. from_ask names the ask event that created the item,
// and next is Claude's next step for it. install {url, label?, built_at, sha?} is a device build the card's Install
// button opens (board.mjs item set --install); public/installs/ holds its files, served without a login like all of
// public/, since iOS's installer fetches the manifest and .ipa with no cookies. A builder working on an item has a record in
// agents/<id>.json (or agents/<id>@<agent>.json for each further agent) beside the item file. An item's parent is the key of the card it was spun out of, which makes it a follow-up, and
// its related the keys of cards it is Related to; an item file's older followups list moves into its items as the server
// starts (migrations.mjs MIGRATIONS 'followups'). Item files are storage only: deps order the cards, and parent and related group
// them (docs/adr/2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping.md). domain.mjs decides lanes and card state from what snapshot.mjs reads, for this server and the CLI alike.
// Every request needs the owner's sign-in cookie (../shared/owner-sign-in.mjs), but a process on this host's AGENT_PATHS,
// whose events may be any kind but the owner's (ownerKind), and a read of a file that isn't a page; without it, the
// sign-in page (401) or 401 {error} (docs/adr/2026-11-18-1200-the-owner-signs-in-with-a-link-that-sets-a-device-cookie.md).
//   GET  /, /settings.html, /questions.html, /notes.html
//                                the app shell, public/app.html, whose views these pages are (../hub/shell.mjs shellHtml;
//                                docs/adr/2026-10-29-2005-one-app-for-the-whole-hub.md). /index.html redirects to /
//   GET  /prototype-<topic>.html a topic recorded in data/prototypes.json is public/prototype.html with its record
//                                filled in (prototypePage); /prototype.html itself is 404
//   GET  /prototype-<topic>.stage.html  a take-file topic's stage, public/prototype-stage.html filled in (prototypeStage),
//                                which its viewer frames. It and every file of the site's own public/ carry the sandbox
//                                header, a script there CORS for that opaque origin, and an HTML page there the
//                                preview-frame.js script (docs/adr/2026-11-18-0523-previews-run-in-a-sandboxed-opaque-origin.md)
//   GET  /...                    the site's public/, then this template's public/, then the
//                                starter's, then ../shared for colors.css (directories serve index.html; in .html, each <!--header {…}-->
//                                becomes public/ui-page-header.js's header({…}), then {{title}} board.json's title).
//                                A page's relative .js and .css links gain ?v=<version>; a file asked for by its
//                                current version caches for a year, anything else revalidates by ETag. Every
//                                text response, the API's included, is gzipped when the request accepts it;
//                                API JSON stays no-store
//   GET  /api/board              the board's title (board.json's, as the page shows it), its reviewers' names, the Block sheet's
//                                holdChoices [{value, label, ms}] (../hub/duration.mjs CHOICES, ms each one's length, null for Forever;
//                                the page words when it ends), and lanes of those items, with
//                                data/pr-slack.json's PR links, with per-item review_link_ts and legacy
//                                ~/.claude/slack-bridge/topics/*.json fallbacks,
//                                data/owner.json and each PR as the hub's GitHub check last read it (github-state.json).
//                                owner.json: {topics: [{id, title, summary}], items: [{id, topic,
//                                question, context, url, options, urgent, asked_at, resolved, resolved_at, round, round_of, confirm_of}]};
//                                the questions sheet marks an open `urgent` question
//                                checks comes from data/checked.json (the hub's poll writes it),
//                                whether the board hears its events (../hub/boards.mjs listenState) and Claude's latest writes.
//                                links: [{link, ok, detail, state, since?}], whether each hub link reaches this
//                                board, state reading broken only past the link's grace period
//                                (../hub/boards.mjs linksOf), null when the manifest has no board here; setup:
//                                {events, github} while the join handshake's checklist shows, else null
//                                arch: the header bulb's {repo, waits, last} (arch-review.mjs archOf), null off the manifest
//                                orchestratorWaits: data/orchestrator-waits.json's waits in its order, each {key, ref,
//                                title, kind, since}, for the header's waiting-on-orchestrator chip (waitsShown)
//                                onHost: whether this request's browser runs on the hub's machine (on-host.mjs fromHost),
//                                beside the board, so it moves no change number;
//                                a work card's worktree is its builder's worktree path while that folder exists, else null.
//                                owner leaves resolved questions out; ownerTopics still lists and counts them (pageBoard).
//                                version is the board's change number and its ETag, and each card, question and topic
//                                carries its last change's number as changed (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md):
//                                a request whose If-None-Match names it answers 304 with no body
//                                (docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md)
//                                ?since=<n>: the answer is a patch of what changed after n, {since, version, generatedAt,
//                                set, unset, lists, threads?, notes?, onHost} (sync.mjs patchSince, public/ui-patch.js),
//                                threads the lines each card's thread gained after n, or the whole thread
//                                (docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md), notes each card's notes
//                                that changed after n, whole, null for none
//                                (docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md); the whole board, with no
//                                threads or notes, when n is older than the oldest removal kept, or no number this board counted. A card's question
//                                topic names its card as card and leaves its title to it
//                                (docs/adr/2026-11-04-0332-the-board-sends-per-card-patches.md)
//                                Done cards come slim (domain.mjs slimDone), the newest 100 and the ones the Done
//                                archive keeps back; doneArchived: how many Done cards data/done-archive.json holds
//   GET  /api/done?before=<sortAt>|<key>&q=<words>
//                                {cards, left}: the next 100 archived Done cards, slim, newest first, older than the
//                                cursor (none: from the newest), and how many older ones are left after them, each
//                                built from its archive entry as it pages in
//                                (docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md,
//                                docs/adr/2026-11-04-1056-archived-done-cards-are-built-as-they-page-in.md)
//   GET  /api/questions?topic=<id>
//                                {questions}: that topic's resolved questions, as /api/board's owner would list them
//   GET  /api/links              {links}: the same list alone
//   GET  /api/working            {working: [{id, kind, card, since}]}: each event marked Working on it with no answer yet,
//                                card its work card's ref or null, and unread: [{key, ref, kind, since}], each owner request
//                                (a reply, a New task's intake) no inbox read has picked up
//                                (hooks-plugin/hooks/watcher-stop.mjs reads both)
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
//                                folder, or with no file its short notes text (questions.mjs readNotes); otherwise 404
//                                {error}. /api/plan is the same, for pages loaded before the rename
//   GET  /api/notes?all=1        {notes: {<key>: markdown}}: the notes the board's sync carries for every card on it that
//                                has them, which a page loads after a whole board, since that carries none
//                                (docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md)
//   GET  /plan.html?…            redirects to notes.html with the same query, since pushes and threads link it
//   POST /_claude/events         {kind, ...data} → one line in data/events.jsonl; wakes Claude. → {id, board}: the
//                                event's id and /api/board's answer as the tap left it, version included, so the page draws the tap from
//                                the one round trip (docs/adr/2026-11-03-0500-every-owner-tap-the-server-can-apply-draws-at-once.md);
//                                with since: <n>, which isn't recorded, that board is a patch since n as ?since= gives;
//                                ?board=0, as the hub posts, answers with no board, so the answer builds nothing after the line is written
//                                ask, item-message and owner-answer may carry files: [upload]
//                                ask may carry request: 'prototype', 'grill', 'visual' or 'reviewer', the New task box's Prototype,
//                                Grill, Visual or Review: its filed card owes that kind's brief, with the task's text and files.
//                                item-message may carry intent: 'reply' or 'build', a Todo card's Reply or Implement.
//                                any kind may carry sendId, the page's id for a reply-box tap: one whose kind and sendId
//                                are recorded answers with the recorded event's id and records nothing. So does an item-message or ask
//                                with no sendId whose text, author and card match one recorded in the last 30 seconds.
//                                Implement with no text or files on a Todo or ready card writes no line of its own
//                                and stages the card for the orchestrator's review, with no event
//                                (runs.mjs implementAsIs). One with text or files on a Todo card stages it
//                                there, its open questions skipped and (questions.mjs stageImplement),
//                                and appends the message. Any other message on a ready Todo card stages it again
//                                (questions.mjs stageReply; docs/adr/2026-11-07-0700-staging-then-ready.md)
//                                An owner-answer with a note and no take resolves its question (questions.mjs
//                                resolveNoteAnswers). One to a card's prototype question that picks no take is
//                                recorded with prototype_again: true: the card reads prototyping with Next "Prototype
//                                again", and the board launches the next round's planner itself (domain.mjs picksNoTake).
//                                owner-answers {answers: [owner-answer data]} is the questions sheet's Send, one answer
//                                to a request, each carrying its sendId (docs/adr/2026-11-16-0500-each-answered-question-shows-at-once-as-sending.md): one owner-answer
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
//                                to grilling or prototyping (questions.mjs planAgain).
//                                visual-request {key, text?, files?, question?, note?, choice?} asks for a visual, of one question too: it owes the orchestrator's
//                                visual brief, the card's phase as it is. Once the orchestrator writes a brief (item
//                                brief), the server launches its agent, a planner while no other agent but a visual
//                                one works on the card, a visual agent beside any other once no other visual runs
//                                there (runs.mjs tick; docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md)
//                                review-request {key, text?, files?} is /review in a task's thread: it owes the orchestrator's
//                                reviewer brief on any open card, and once written the server launches a reviewer beside
//                                any other agent once no other reviewer runs there
//                                (docs/adr/2026-11-16-2300-review-in-a-thread-launches-a-reviewer.md)
//                                reask-request {key?, question} asks the session to ask a resolved question again from the
//                                card's current notes; one naming a question that isn't resolved → 400 {error}. The
//                                question reads reask until question add names it in reask_of (domain.mjs ownerQuestion)
//                                item set appends card-unblocked {key} when a blocked card's last dep finishes,
//                                including owner-blocked cards, a record that wakes no session: the pull takes the card.
//                                reviewers {add?: [{name, slack_user, github}], remove?: [name]} is Board settings' reviewers
//                                Save: the server removes the names and adds the people itself (settings.mjs removeReviewers,
//                                addReviewers, with each DM opened through the hub's Slack token and each login checked on
//                                GitHub), and appends reviewers-removed {remove} and reviewers-added {add: [name]}, records the
//                                session doesn't act on. An unknown name, a Slack or GitHub refusal or a malformed list → 400
//                                {error} and nothing recorded.
//   GET  /api/reviewer-people    {slack: [{id, name}] | null, slackProblem?, github: [login], githubProblem?}: what Board
//                                settings' Reviewers picks from, fetched with the hub's Slack token and gh.
//                                card-bump {key} and card-unbump {key} are a work card's Bump and Unbump, sent with no confirm;
//                                a bump moves the card's queued lands first, an unbump back in ask order (worktree.mjs
//                                moveQueuedLand), and each writes the owner's line, "Moved to the top" or "Unbumped".
//                                card-tag {key, tag, on} is a Tag… pick, which puts the tag on the card or takes it off
//                                in its item file with the owner's Tagged or Untagged line and records no event; one
//                                that changes nothing or names no valid tag → 400 {error} (cards.mjs tagItem).
//                                card-bell {key, on} is a card's Notify me (on) or its lit bell's tap, which sets a
//                                bell as the task's reminder or takes off the reminder it has, with the owner's Bell on
//                                or Bell off line and no event; one that changes nothing → 400 {error} (cards.mjs bellItem).
//                                card-relate {key, other, on} is a pick in the open card's Related to search (on) or a
//                                link's ×, which links the two cards or unlinks them, whichever stores the link, with the
//                                owner's Related to or Unrelated from line in both threads and no event; one that changes
//                                nothing, links the card to itself or names no card on this board → 400 {error}
//                                (cards.mjs relateItem).
//                                tag-archive {key, tag, on} is the picker's Archive (on) or Restore of a tag, written to
//                                data/tags.json with no event; one already so → 400 {error} (cards.mjs archiveTag).
//                                card-hold {key, hold: true, for} is a Block sheet chip or its Custom time
//                                (../hub/duration.mjs durationEnd), stored as {key, hold: true, until} or, for
//                                Forever, {key, hold: true}; a choice that ends in the past or past 30 days → 400 {error}.
//                                card-merge {key} on a card whose verified branch waits for the owner's Merge (no PR)
//                                records the tap on the card (cards.mjs tapMerge), with the owner's line "Merge
//                                requested", and runs `board.mjs merge <key>`
//                                detached, so a land that restarts this server finishes, its output in
//                                ~/.claude/kickflip/logs/merge-<id>-<time>.log, with no event and no session
//                                (docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md). KICKFLIP_MERGE_CMD='["<cmd>", …]'
//                                replaces node and board.mjs, called with --site <route> merge <key>. On a card with a
//                                PR the server merges it (cards.mjs mergeCard) and appends no event; a refusal → 400
//                                {error} and a thread line.
//                                card-build {key} is the owner's Build: the server starts the build itself (runs.mjs
//                                startTappedBuild, board/worktree.mjs boardWorktree) and launches its builder, Claude
//                                or Codex, headless in its worktree (headless.mjs launchBuilder), appending no event; a
//                                refusal leaves its reason in the card's thread, and a launch that fails puts the card
//                                back in Todo with the reason (runs.mjs abandonLaunch).
//                                On a card an unfinished dep blocks, or with every implementer slot taken (domain.mjs
//                                pullOf), the tap bumps the card instead (card-bump, a thread line), leaving it in Todo
//                                for the pull (runs.mjs bumpBlocked; docs/adr/2026-11-05-0802-todo-has-no-queue.md,
//                                docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md).
//                                A
//                                checking card whose calls are all verified and that has no open question gets one
//                                headless lander per verification, tracked in data/landers.json (runs.mjs landable;
//                                docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md,
//                                docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md).
//                                A card whose open PR conflicts gets one headless rebase run per head and base, tracked
//                                in data/rebases.json (domain.mjs rebasesDue, runs.mjs startRebase;
//                                docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md).
//                                card-hold and card-done are written to the item file first, with the owner's thread
//                                line, and a Done unblocks blocked cards (cards.mjs recordOwnerTap); an Unblock relaunches
//                                the run its Block stopped (runs.mjs resume). card-reopen {key} is a Done card's Reopen: it
//                                moves the card back to In Review before its event (cards.mjs recordOwnerTap),
//                                and one on a card not in Done → 400 {error}. card-cancel {key} is a staged or ready Todo card's Cancel: it moves the card back to discussing before its event, its Implement owed again, and one on any other card → 400 {error}. None of them wakes a session, nor do card-unbump,
//                                grill-more, prototype-request or visual-request
//                                (docs/adr/2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md); one whose item
//                                file couldn't be written, or whose card is merged or dropped, → 400 or 500 {error}
//                                and no event (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
//                                ask-withdrawn {id, key?} also hides that event (POST /api/hide) and drops the card it
//                                became, in the one request; one whose card's build has started → 400 {error} and no
//                                event. An ask with a send id is stored under it.
//                                script-run {key, id, sha} and script-decline {key, id} are the owner's Run and Decline
//                                on a card's waiting script offer; one of an offer that isn't
//                                waiting → 400, a Run whose sha isn't the offer's → 409, and nothing recorded. One
//                                recorded writes the owner's line, "Ran the script" or "Declined the script". A Run
//                                starts bin/script-run.mjs detached, which posts script-result
//                                {key, id, exit, output, timedOut, ms, log} when the script ends
//                                (docs/adr/2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md).
//                                An owner-answer stays in the thread, and one that leaves an unstarted
//                                card with nothing open goes to discussing, its Implement ask waiting (questions.mjs settleAnswers).
//                                What waits on the owner (domain.mjs ownerActions) is one live notification per board,
//                                tagged board-<route> (domain.mjs ownerRow), tracked in data/action-pushes.json: its
//                                first push alerts, each change re-pushes it silently, and once nothing waits it drops
//                                its queued push, or closes the one already on the owner's devices (hub/push.mjs withdraw).
//                                Within a minute of an owner block's until or pick_up_at the server unblocks it
//                                (cards.mjs pickUp), at most once per time even across a restart.
//                                Each minute, unless the board is paused, it fires the board's schedules that are due
//                                (schedules.mjs fireSchedules).
//                                The Auto jobs below run on every board change and once at start, and on the minute
//                                check only once a usage pause lifts, while an overnight triage is due or when a hub build slot is due to the board (build-turns.mjs turnDue). The server always starts and launches the build of the top pullable Todo cards, one per
//                                hub build slot the turns give the board (build-turns.mjs), each card In Progress taking
//                                one (domain.mjs pullOf), bumped cards first, whether or not the board is idle, each once,
//                                tracked in data/pulled.json, its record dispatched: 'hub'. The helpers board.mjs agent
//                                launch asked for (runs.mjs tick), the landers and the rebase runs take no slot.
//                                Neither appends an event.
//                                With the hub's Triage overnight on, once a night from the middle of the hub's quiet hours to their
//                                end, an idle board with two or more cards waiting on open questions (domain.mjs
//                                triageOf) gets overnight-triage {date, topic, cards} first, unless nothing changed
//                                since the last triage, tracked in data/triaged.json. A board due a description check
//                                (settings.mjs descriptionDue) gets it too, with description: true, and cards [] when
//                                no two cards wait. Until Claude
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
//                                orchestrator-waits {opened: [{key, ref, title, kind, since}], again}, again naming
//                                each still waiting 15 minutes on from its last wake, or an hour once picked up
//                                (domain.mjs waitsStep), and each wait that clears, or opens picked up, appends
//                                waits-history {opened, cleared}, and the first check of a new day appends long-waits
//                                {day, waits} naming the last day's waits 15 minutes or more unpicked; it never
//                                pushes the owner (checkWaits), checked on every board change and each minute
//                                Each minute it passes the owner a finished grill's questions left 15 minutes unscreened
//                                by the orchestrator (questions.mjs publishUnscreened)
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
//   POST /api/read               {marks: {card key: time}} → data/read.json (cards.mjs markRead), each mark only moving
//                                forward, without waking Claude; every board answer carries each card's mark as its
//                                readAt, and a card new to the board gets one as the server first sees it. A bad body → 400 {error}
//   POST /api/drafts             {id, text, files, choice?} → data/drafts.json (drafts.mjs saveDraft): a composer's draft, ask or
//                                item:<card key>, or a question's unsent pick and note, q:<question id>, at the server's time, without waking Claude → {at}; every board answer
//                                carries them all as drafts, and a reply's goes when its card leaves the board. A bad body → 400 {error}
//   GET  /api/rules              {board, hub}: board.json's rules and the hub's from settings.json (hub/rules.mjs)
//   POST /api/rules              {rules: [{id?, text}], base: [id]} → board.json's rules (settings.mjs saveBoardRules), and
//                                when anything changed a `rules {scope: "board", added, edited, removed}` event, which
//                                wakes Claude. → {rules, id}; a bad list → 400 {error}
//   GET  /api/schedules          {schedules: [{id, text, cadence, due_at, last?, last_ref, fired_at?, skipped?}]}: board.json's
//                                schedules (schedules.mjs), last_ref the ref of the task the last fire filed, or null
//   POST /api/schedules          {id, text?, cadence?} rewords or re-cadences one, or {id, remove: true} removes it, waking
//                                no session → the same answer; an unknown id or a bad cadence → 400 {error}
//   GET  /api/settings           {settings: the board's settings, {auto_merge, auto_build, auto_review, idle_notification, stage_splits, skip_draft, prs, build_target?} (settings.mjs readBoardSettings),
//                                overrides: the Board defaults board.json sets, {key: value} (settings.mjs overridesOf), defaults: Hub settings' Board defaults,
//                                paused_until: Pause board's end (an ISO time or forever) or null, pause_choices: holdChoices}
//   GET  /api/build-targets      {targets}: each executable .kickflip/build-<target> at the board's main tip (build-script.mjs listBuildTargets), or in its site's scripts/ while its scripts are in kickflip
//   GET  /api/scripts            {source: repo | kickflip, repo: [name], scripts: [{name, text}]}: where the board's scripts live, the
//                                executable .kickflip/ scripts at its main tip (build-script.mjs listRepoScripts) and its
//                                site's scripts/ build, each build-<target>, release and test (kickflipScripts, '' for one not written); 404 off the manifest
//   POST /api/scripts            {name, text} → replaces the site's scripts/<name> (writeScript), waking no session. → the same
//                                answer; a bad name or empty text → 400 {error}
//   POST /api/pause              {pause: <usage-gate.mjs pauseEnd choice | off>} → Pause board, board.json's paused_until
//                                (settings.mjs setBoardPause; docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md),
//                                then an Auto check. → {paused_until}; a bad choice → 400 {error}
//   POST /api/settings           {auto_merge?: boolean | null, auto_build?: boolean | null, auto_review?: boolean | null, idle_notification?: boolean | null, stage_splits?: boolean | null (null takes the Board default), skip_draft?: boolean, prs?: boolean, build_target?: target | null} → board.json, keeping its other keys, and when a value other
//                                than a silent Board default (settings.mjs SILENT_DEFAULTS) moved a `settings {<changed setting>: value}` event, which wakes Claude, then, when auto_merge turned on,
//                                `check-github {reason: "auto-merge"}` for one GitHub tick. → {settings, overrides, defaults, id}; a bad body → 400 {error}
//   GET  /api/permissions        {file, permissions: [{id, name, allows, rule, on, refused, unavailable}]}: the board's session
//                                permissions, read from its folder's .claude/settings.local.json (permissions.mjs); unavailable
//                                says why a switch can't be turned on; 404 off the manifest
//   POST /api/permissions        {id, on} → that rule written or removed, and the same answer; 400 {error} for a bad
//                                body or settings file, or a switch turned on while it is unavailable
//   POST /api/try                {key, anyway?}: forwards a card build, main retry or the prototype site's start (key prototypes) to the hub's loopback /_hub/build;
//                                anyway: true starts a card's serve on a busy host
//   POST /api/try/kill           {key}: a card's Kill, forwarded to the hub's loopback /_hub/kill. A card's Serve or Kill
//                                the hub took writes the owner's line, "Serve started" or "Serve killed".
//   POST /api/try/main/pull      {}: Main's refresh icon, forwarded to the hub's loopback /_hub/pull → {commits, error?}
//   GET  /api/log?file=<name>.log {text, truncated, size}: the last 256 KiB of that file in ~/.claude/kickflip/logs, by name
//                                only; log.html and the reader sheet's raw toggle (app-reader.js) show it and re-read it while it grows
//   GET  /api/transcript?file=<name>.log&from=<byte> {rows, next, size, stream, finished}: that log, whole, as transcript
//                                rows from byte `from` to its last whole line (transcript.mjs readRunTranscript); the reader
//                                sheet's View transcript reads it on from `next` while it grows
//   GET  /api/try/prototypes    {state, https, since, lines, step, stepAt, steps, last, error}: the hub's serve of the
//                                board's base prototype worktree, which a served round's viewer frames, since when its
//                                ready run started, and its log's last 40 lines and error once it failed
//                                (docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md);
//                                while it starts or once it failed, its start step since stepAt and each finished step's
//                                ms, and while it starts the log's last line, for the page's landing
//                                (docs/adr/2026-11-14-1446-a-prototype-pages-landing-shows-its-sites-start-steps.md)
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
//   GET  /api/stream             server-sent events: `event: change` shortly after a write the server makes or is told of
//                                under the item files' folder or data/ (changed). Never gzipped
//   POST /_claude/changed        {file}: a store write in another process wrote file, under data/ or the item files'
//                                folder; signals a change (files.mjs wrote). → 204
//   GET  /_claude/health
// Every non-GET/HEAD request passes ../starter/cross-site.mjs before routing (403 plain text).
// Routes that parse JSON require application/json; /api/upload keeps the file's content type.
// Claude's replies to event <id> are data/replies/<id>.md, .html (written before markdown replies) or .json, then <id>~2.md, <id>~3.md … (cards.mjs replyFilesOf).
import { cardNotesOf, liveFiles, loggedOutCards, outsideData as readOutside, readSnapshot, shownEvents as readShownEvents, tryLogTail, withReply as eventWithReply } from './snapshot.mjs';
import { builderRepo, git, moveQueuedLand } from './worktree.mjs';
import * as runs from './runs.mjs';
import { readRunTranscript } from './transcript.mjs';
import { fromHost } from './on-host.mjs';
import { agentCaller, signedIn as ownerSignedIn } from '../shared/owner-sign-in.mjs';
import { refuse } from '../hub/front-door.mjs';
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
import { REQUEST_KINDS, TAP_KINDS, threadNames, tapPlan, SCRIPT_EVENTS, BRIEF_KINDS, BUILD_REFUSED, bumpIn, pauseWork, confirmedDrops, archivedOf, buildBoard, movesOf, withHub,DONE_KEPT, orchestratorWaits, ownerWordEnds, triageWaitOf, eventWaits, boardAskWaits, waitsStep, waitsHistory, PROTOTYPE_WAIT, prototypeWaits, idleStep, idleSummary, ITEM_EVENTS, slimDone, needsAnswer, ownerActions, ownerRow, rowAlerts, pushTag, EVERY_STAGE, bellStep, picksNoTake, pullOf, refOf, strictlyIdle, threadOf, triageOf } from './domain.mjs';
import { alertsOf, localDay, quietAt, quietMiddleOf, quietOf } from '../hub/schedule.mjs';
import { overnightOn } from '../hub/overnight.mjs';
import { startTitleBrief, startTitleFault } from './commit-message.mjs';
import { realFileUnder } from '../hub/files.mjs';
import { hubText } from './hub-lines.mjs';
import { withdraw } from '../hub/push.mjs';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { PROTOTYPE_TEMPLATE, STAGE_TEMPLATE, SANDBOX, SANDBOX_MODULE, esc, prototypePage, prototypeStage, versionOf } from './prototype-page.mjs';
import { launchAgent } from './agents.mjs';
import { BOARD_CLI, pidAlive, stopAgents, stopRuns } from './headless.mjs';
import { BoardError } from './checks.mjs';
import { draftOf, pruneDrafts, readDrafts, saveDraft } from './drafts.mjs';
import { cardName, refsOf, readScriptOffer, readAgents, tapMerge, appendStatus, appendCommand, archiveCards, archiveCount, archiveRank, archiveMatching, archiveReader, readArchive, moveCard, pickUp, endReminder, sendPush, recordOwnerTap, mergeCard, readAskLinks, readMarks, readWorking, readDelivered, readActedOn, readUpload, markRead, saveUpload, setHidden, threadFile as siteThreadFile } from './cards.mjs';
import { restageStaleReady, publishUnscreened, stageImplement, clearOwnerWait, stageReply, planAgain, followUp, addTopic, readPrototypes, takeFile, readNotes, resolveNoteAnswers, resolveSentAnswers, settleAnswers, unrecorded, handedOver } from './questions.mjs';
import { heldReview, applyReviewAnswer, dropAskCard, withdrawRefused, fileAsk, fileAsks, retitleAskCard } from './asks.mjs';
import { SILENT_DEFAULTS, finishHandshake, readBoardRules, readBoardSettings, readBoardDescription, saveBoardDescription, descriptionDue, readHandshake, addReviewers, removeReviewers, saveBoardRules, saveBoardSettings, setBoardPause, settingsOf, overridesOf, readBoardJSON } from './settings.mjs';
import { noteLoggedOut, dropPause, markPaused, requestPause, openAgents, implementAsIs, clearStall } from './runs.mjs';
import { runMigrations } from './migrations.mjs';
import { fireSchedules, readSchedules, setSchedule, removeSchedule } from './schedules.mjs';
import { appendEvents as appendBoardEvents, appendLine, boardConfig, eventId, itemSources, readJSON, readLog, remove, tellOnWrite, wavesDir, writeJSON } from './files.mjs';
import { changed as rulesChanged, readHubRules } from '../hub/rules.mjs';
import { boardAt, startingAt, listenState, sessionBusy, linksOf } from '../hub/boards.mjs';
import { joinOf } from '../hub/sessions.mjs';
import { pendingFor, shown } from '../hub/prompts.mjs';
import { nodeBin } from '../bin/install.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { CHOICES, FOREVER, durationEnd } from '../hub/duration.mjs';
import { VIEW_PAGES, shellHtml } from '../hub/shell.mjs';
import { crossSite, isJSON } from '../starter/cross-site.mjs';
import { readUsageGate, heldFor, tasksInProgressCap, pauseReasonFor, pausedWords, pausesRunning, boardPausedUntil } from '../shared/usage-gate.mjs';
import { readTasksInProgress, readBoardDefaults } from '../shared/hub-settings.mjs';
import { claimBuilds, othersHeld, leaveTurns, turnDue, watchGrants } from './build-turns.mjs';
import { audit, boardAudit } from '../shared/audit.mjs';
import { reviewWaits } from '../shared/skills.mjs';
import { boardRepo, mainRefOf } from '../hub/board-repo.mjs';
import { kickflipScripts, listBuildTargets, listKickflipTargets, listRepoScripts, scriptsOf, writeScript } from './build-script.mjs';
import { diedRuns, logTail, logsDir, readRunnerPid, scriptLogName, scriptSha } from './scripts.mjs';
import { reviewerPeople } from './reviewer-people.mjs';
import { permissionsView, setPermission } from './permissions.mjs';
import { SlackError, SLACK_NEEDS_TOKEN, savedSlack, slackStatus } from '../hub/slack.mjs';
import { collaborators, githubUser } from '../hub/pr-report.mjs';

const template = path.dirname(fileURLToPath(import.meta.url));
// Starts the runner of card key's offered script id on the board at site, detached in cwd, the board's repo folder
// (bin/script-run.mjs), so a restart of the server doesn't stop it; the runner posts its script-result event when it
// ends. The script's body, the bytes the server checked against the approved hash, goes to the runner over stdin, so
// the runner reads no file or thread line a later write could change. → the child process
export function startScriptRunner(site, key, id, cwd, body) {
  const child = spawn(nodeBin(), [path.join(template, 'bin', 'script-run.mjs'), site, key, id, cwd], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.on('error', () => {});
  child.stdin.end(body);
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
// docs/adr/2026-11-18-1200-the-owner-signs-in-with-a-link-that-sets-a-device-cookie.md
// The paths a process on this host gets with no sign-in cookie, as `<method> <path>`: the hub's probes, needs and
// sidebar stream, the watcher's stop hook's working list (hooks-plugin/hooks/watcher-stop.mjs), and the CLI's and the
// hub's writes (files.mjs changed, ../hub/boards.mjs appendEvent).
const AGENT_PATHS = new Set(['GET /_claude/health', 'GET /_claude/needs', 'GET /api/stream', 'GET /api/working', 'POST /_claude/changed', 'POST /_claude/events']);
// A read of a file that may be one of the app's or the site's own, never an API's or an upload; its page, an .html,
// needs the sign-in still (the static branch refuses it).
const fileRead = (method, p) => (method === 'GET' || method === 'HEAD') && !/^\/(api|_claude|uploads)(\/|$)/.test(p);
// The event kinds only the owner's page posts: the owner's taps on a card (domain.mjs TAP_KINDS; a thread message is
// one when it carries Reply's or Implement's intent, while the hub's Slack intake posts a plain one), a script's Run
// or Decline, answers, a held review's Post it or Skip, and the reviewers Save.
const OWNER_KINDS = new Set([SCRIPT_EVENTS.run, SCRIPT_EVENTS.decline, 'owner-answer', 'owner-answers', 'review-answer', 'reviewers']);
const ownerKind = (kind, body) => OWNER_KINDS.has(kind) || (TAP_KINDS.has(kind) && (kind !== 'item-message' || Boolean(body.intent)));

// docs/adr/2026-11-13-2210-the-board-server-starts-in-process-and-tests-await-settled.md
// The board server for the site at site, listening on 127.0.0.1:port (0: a port the OS picks) under prefix (/<route>,
// or '' for none), once its start passes have run. home is the HOME its own reads use; now its clock, read for each
// time it stamps or compares; launch starts each agent the board launches, a builder, lander, planner, visual
// agent or helper, taking agents.mjs launchAgent's arguments and answering as it does (launchAgent itself unless a test
// passes its own); startScript starts an offered script's run, taking startScriptRunner's arguments (itself unless a
// test passes its own). → {server, changed(file), minute(), settled(), close()}:
// - changed(file) signals a write to file (a path, relative to site or absolute), or with no file a change it can't
//   name, as a store write in this process does.
// - minute() runs the minute's checks, which the script runs every 60 s.
// - settled() resolves once every pass a change, a minute or a request started has finished, the passes those
//   started included.
// - close() waits for settled(), then stops listening and drops every connection, the page streams included.
// describeNightly turns on the overnight triage's description check (checkTriage); the script entry below turns it on,
// and a test opts in, so a test's board, whose manifest entry has no description, sends no triage for it at night.
// signedIn(req) → whether a request carries a signed-in device's cookie (../shared/owner-sign-in.mjs signedIn, on home).
export async function startServer({ site, home = os.homedir(), port = 0, prefix = '', now = () => new Date(), launch = launchAgent, startScript = startScriptRunner, describeNightly = false, signedIn = (req) => ownerSignedIn(req, home) } = {}) {
  const here = path.resolve(site);
  // The board's own files come first, so a file an agent wrote in the site's public/ never replaces one of them; the
  // site's files serve every path the board doesn't use.
  const siteRoot = path.join(here, 'public');
  const roots = [path.join(template, 'public'), path.join(template, '..', 'starter', 'public'), path.join(template, '..', 'shared'), siteRoot];
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
  const REPEAT_WINDOW_MS = 30_000;
  const threadFile = (key) => siteThreadFile(here, key);
  // Hidden events leave every list a page reads (snapshot.mjs shownEvents).
  const shownEvents = () => readShownEvents(here);

  async function readBody(req, limit = 64 * 1024) {
    if (!isJSON(req.headers)) throw Object.assign(new Error('Send the body as application/json.'), { status: 403 });
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > limit) throw Object.assign(new Error('too large'), { status: 413 }); }
    return body ? JSON.parse(body) : {};
  }

  // Every page event, and the server's own such as a rules save, is one line here, which wakes the watcher. → its id
  const appendEvent = async (kind, data) => (await appendEvents([[kind, data]]))[0];
  // [[kind, data, id?]] → their ids, every line in one append (files.mjs appendEvents). The append tells changed before it
  // returns, so the data version has stepped and a check that runs next reads the board with these lines and never
  // sends the same event twice.
  // data/replies goes with the first event, for the replies to it.
  async function appendEvents(list) {
    await fs.mkdir(replies, { recursive: true });
    return appendBoardEvents(here, list, now());
  }

  // Owner answers [{id, ...}] → their event ids, appended in one write. An answer to a card's prototype question that
  // picks no take carries prototype_again: true and the card owes the orchestrator's brief for its next prototype
  // rounds, each such answer's question and note one of its asks, a round of its own, whatever its note reads as
  // (docs/adr/2026-11-03-1646-a-prototype-answer-with-no-pick-prototypes-again.md,
  // docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md,
  // docs/adr/2026-11-14-2300-picked-prototypes-draw-in-parallel-and-their-records-merge-by-topic.md). A note with no take resolves its
  // question. The POST answers once the answers are written and their questions resolved; the Send is then acted on in
  // code (afterSend): gates settled, answers in the notes, cards left with nothing open discussing, prototypes planned again
  // (docs/adr/2026-11-16-0300-send-answers-once-the-answers-are-written.md).
  // An answer to a question that already has one recorded is skipped
  // (docs/adr/2026-11-08-0900-send-records-once-and-follow-ups-fail-on-their-own.md).
  // One Send's follow-ups run after another's, so two Sends never settle a card at once. A failure is a fault line on
  // its card (questions.mjs followUp).
  let afterChain = Promise.resolve();
  function afterSend(work) {
    afterChain = afterChain.then(work).catch((err) => console.error('Send follow-up failed:', err.message));
    track(afterChain);
  }
  async function recordAnswers(sent) {
    const answers = await unrecorded(here, sent);
    const asked = new Map(((await readJSON(path.join(data, 'owner.json'), { items: [] })).items || []).map((q) => [q.id, q]));
    if (!answers.length) return [];
    const isAgain = (a) => asked.has(String(a.id)) && picksNoTake(asked.get(String(a.id)), a.choice);
    const ids = await appendEvents(answers.map((a) => ['owner-answer', isAgain(a) ? { ...a, prototype_again: true } : a]));
    await resolveNoteAnswers(here, answers);
    await resolveSentAnswers(here, answers.filter((a) => !isAgain(a)));
    dataVersion++;
    afterSend(async () => {
      // docs/adr/2026-11-06-0130-every-grill-ends-with-a-prototype-question-the-board-acts-on.md, docs/adr/2026-11-07-0700-staging-then-ready.md
      // A failure after the 200 is a fault line on the card it was for, which wakes the orchestrator.
      const keys = [...new Set(answers.map((a) => asked.get(String(a.id))?.topic).filter((t) => t?.startsWith('item:') && !t.startsWith('item:ask:')).map((t) => t.slice(5)))];
      try { await settleAnswers(here, answers); }
      catch (e) { for (const key of keys) await followUp(here, key, 'settling them', () => { throw e; }); }
      for (const a of answers.filter(isAgain)) {
        const key = asked.get(String(a.id)).topic.slice(5);
        await followUp(here, key, 'planning the prototype again', () => planAgain(here, key, 'prototype', { question: String(a.id), ...(a.note ? { note: String(a.note) } : {}) }));
      }
      dataVersion++;
    });
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

  // A re-ask names a question the owner sees resolved; any other is refused with why.
  async function reaskRefused(id) {
    const q = (await sharedBoard()).owner.find((x) => x.id === id);
    return !q ? `${id} is no longer asked here. Reload to see what is.` : q.state !== 'resolved' ? `${id} isn’t resolved, so there is nothing to ask again.` : null;
  }

  // e with its replies oldest first, and reply, the newest (snapshot.mjs withReply).
  const withReply = (e) => eventWithReply(here, e);

  async function listEvents(kind, limit) {
    const working = await readWorking(here);
    let lines = await shownEvents();
    if (kind) lines = lines.filter((e) => e.kind === kind);
    return Promise.all(lines.reverse().slice(0, limit).map(async (e) => {
      const withR = await withReply(e);
      return withR.reply || !routeRecord(working, e.id) ? withR : { ...withR, working: routeRecord(working, e.id) };
    }));
  }

  const config = () => boardConfig(here);

  // What the board reads from outside data/ and the item files' folder, whose writes signal changes (snapshot.mjs).
  const outsideData = () => readOutside(here);
  // The board's snapshot (snapshot.mjs readSnapshot), with this server's HOME for the run logs it reads.
  const snapshot = (outside, archived = []) => readSnapshot(here, outside, { archived, home });

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
  // The build carries cardNotes, each card's notes by key (null for none), which the board's sync carries beside it
  // (docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md).
  async function sharedBoard() {
    const outside = await outsideData();
    // A reply is a new file in data/replies, so the folder's own stamp moves with it: a reply whose change signal never
    // arrived (a lost POST from the writing process) still ends its event's Working mark here.
    const key = JSON.stringify([dataVersion, outside, await fs.stat(replies).then((st) => st.mtimeMs, () => 0)]);
    if (shared?.key !== key) {
      const built = snapshot(outside).then(async (s) => ({ ...buildBoard(s), cardNotes: await cardNotesOf(s.files) }));
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
      const log = await readLog(events);
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

  // The Block sheet's chips by length, so the board's version doesn't change with the clock; the page words when each ends
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
    // A New board the hub serves before its orchestrator joins reads starting (domain.mjs withHub).
    const listen = self ? listenState(self) : startingAt(here) ? 'starting' : 'deaf';
    const built = withHub(await sharedBoard(), { listen, busy: self ? sessionBusy(self) : true, prompts: self ? pendingFor(self.route).map(shown) : [], now: now().getTime() });
    built.items = built.items.map((it) => (it.worktree && !existsSync(it.worktree) ? { ...it, worktree: null } : it));
    const links = self ? linksOf(self, { listen }) : null;
    // The board menu's Join in terminal (hub/sessions.mjs joinOf), in the board so the saved copy holds it.
    const join = self ? joinOf(self) : null;
    return { generatedAt, title, reviewers: (reviewers || []).map((r) => r?.name).filter((n) => typeof n === 'string'), reviewerGithub: Object.fromEntries((reviewers || []).filter((r) => typeof r?.name === 'string').map((r) => [r.name, r.github])), ...built, links, join, setup: await setupOf(links),
      holdChoices: HOLD_CHOICES, orchestratorWaits: await waitsShown(), arch: self ? archOf(await readReviews(here), built.items, built.owner, { repo: repoName(boardRepo(self.route)), waits: reviewWaits() }) : null };
  }
  // docs/adr/2026-11-15-0930-the-board-header-counts-what-waits-on-the-orchestrator.md
  // What waits on the orchestrator as the board header's chip lists it: data/orchestrator-waits.json's waits in its
  // order, each {key, ref, title, kind, since, tone}, leaving out the wake bookkeeping that moves while the wait stays.
  const waitsShown = async () => ((await readJSON(path.join(data, 'orchestrator-waits.json'), null))?.waits || [])
    .map(({ key, ref, title, kind, since, tone }) => ({ key, ref, title, kind, since, tone }));

  // docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md
  // The board a page reads, from /api/board or an events POST's answer: board(), leaving out the resolved questions
  // (GET /api/questions answers a topic's), with its Done cards slim and how many older ones wait in the archive
  // (docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md). A card's question topic leaves its title,
  // summary and askedAt to its card while the card is on the board: the page names the topic from the card
  // (app-questions-sheet.js), so a card's change patches the card alone (docs/adr/2026-11-04-0332-the-board-sends-per-card-patches.md).
  // It holds nothing of the request's, so every page reads the same board at the same change number. → {board, threads,
  // notes}: threads maps each card on it to its thread (docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md), and
  // notes to its notes or null (docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md), which the board's sync carries
  // beside it.
  async function buildPageBoard(req) {
    if (!['GET', 'HEAD'].includes(req.method)) dataVersion++;
    const { threadViews, cardNotes, ...built } = await board();
    const b = { ...built, doneArchived: await archiveCount(here) };
    b.owner = b.owner.filter((q) => q.state !== 'resolved');
    const marks = await readMarks(here);
    b.items = b.items.map((i) => ({ ...(i.lane === 'done' ? slimDone(i) : i), readAt: marks[i.key] || null }));
    b.drafts = await readDrafts(here);
    const shown = new Set(b.items.map((i) => i.key));
    b.ownerTopics = b.ownerTopics.map(({ title, summary, askedAt, ...t }) => (shown.has(t.card) ? t : { ...t, title, summary, ...(askedAt ? { askedAt } : {}) }));
    return { board: b, threads: new Map(b.items.map((i) => [i.key, threadViews[i.key]])), notes: new Map(b.items.map((i) => [i.key, cardNotes[i.key] ?? null])) };
  }

  // docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md: the change numbers (sync.mjs), kept in data/sync.json,
  // and latest, the newest page board stamped with them, with latestThreads and latestNotes, its cards' threads and notes
  // stamped beside it. A board built before latest leaves them all as they are, so a slow build can't undo a newer one. No answer names a
  // number before data/sync.json holds it, so a restart never counts a number twice. data/sync.json's writes send no
  // change signal (quiet).
  const syncFile = path.join(data, 'sync.json');
  let sync = await readSync(syncFile);
  let syncSaved = sync.n;
  let syncWrites = Promise.resolve();
  let latest = null;
  let latestThreads = new Map();
  let latestNotes = new Map();
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
  // → {sync, board, threads, notes}: latest, its threads and notes and the state that stamped them, taken together.
  async function pageBoard(req) {
    const { board: b, threads, notes } = await buildPageBoard(req);
    if (!latest || b.generatedAt >= latest.generatedAt) {
      ({ sync, board: latest } = stamp(sync, b, threads, notes));
      latestThreads = threads;
      latestNotes = notes;
    }
    while (syncSaved < sync.n) await saveSync();
    return { sync, board: latest, threads: latestThreads, notes: latestNotes };
  }

  // → undefined for a POST /_claude/events?board=0, so its answer carries no board key. since is the change number the
  // page holds: the answer is a patch of what changed after it (sync.mjs patchSince), or the whole board when there is
  // none or the board can't answer from it. onHost, whether this request's browser runs on the hub's machine
  // (on-host.mjs fromHost), rides beside the board.
  async function answerBoard(req, since) {
    if (new URL(req.url, 'http://site').searchParams.get('board') === '0') return undefined;
    const onHost = await fromHost(req);
    const { sync: at, board: b, threads, notes } = await pageBoard(req);
    req.boardRead = true;
    const patch = /^\d+$/.test(since) ? patchSince(at, b, Number(since), threads, notes) : null;
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

  // A card's item file entry and builder records, else its archive entry's (cards.mjs readArchive), whose questions its
  // thread reads beside owner.json's.
  async function itemOf(key) {
    const [slug, id] = key.split('/');
    const source = (await itemSources(here)).find((s) => s.slug === slug);
    const itemFile = source ? await readJSON(source.file, null) : null;
    const archived = !itemFile?.items?.some((it) => it.id === id) && (await readArchive(here)).find((a) => a.key === key);
    const item = (Array.isArray(itemFile?.items) && itemFile.items.find((it) => it.id === id)) || archived?.item || null;
    return { item, questions: archived?.questions || [], agents: item && source ? routeRecord(await readAgents(path.join(source.dir, 'agents'), new Set([id])), id) || {} : {} };
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
    const mine = (await shownEvents()).filter((e) => (keys.has(e.data?.key) && ITEM_EVENTS.includes(e.kind)) || (e.kind === 'owner-answer' && asked.has(e.data?.id))      || (e.kind === 'ask' && askIds.includes(e.id)) || e.kind === 'ask-edited');
    const lines = (await Promise.all([...keys].map((k) => readLog(threadFile(k))))).flat();
    const clearedAt = item?.lane === 'done' ? String(item.closed_at || '') : '';
    return threadOf(key, { lines, events: await Promise.all(mine.map((e) => withReply(e))), owner, working: await readWorking(here), delivered: await readDelivered(here), actedAt: routeRecord(await readActedOn(here), key) || '', listening: !boardAt(here) || (listenState(boardAt(here)) === 'listening' && sessionBusy(boardAt(here))), clearedAt, noReply: item?.no_reply || {}, fromAsk: askId,
      links: own ? await askLinksOf(askId) : [], agents, moved, cards: await refsOf(here, threadNames(key, lines, mine)) });
  }


  async function staticFile(rel) {
    for (const root of roots) {
      let file = path.resolve(root, '.' + rel);
      if (file !== root && !file.startsWith(root + path.sep)) return null;
      const st = await fs.stat(file).catch(() => null);
      if (st?.isDirectory()) file = path.join(file, 'index.html');
      if (!(await fs.stat(file).then((x) => x.isFile(), () => false))) continue;
      const real = await realFileUnder(root, file);
      if (real) return real;
    }
    return null;
  }

  // A recorded prototype's page is the template with its record filled in, and a take-file topic's stage the stage
  // template with it: → {proto, stage}. A topic not recorded falls through to the site's own files, so questions on
  // hand-written pages keep opening them.
  async function recordedPrototype(p) {
    const [, topic, stage] = /^\/prototype-([a-z0-9-]+)(\.stage)?\.html$/.exec(p) || [];
    const proto = topic ? (await readPrototypes(here)).find((r) => r.topic === topic) : null;
    return proto && !(stage && proto.served) ? { proto, stage: Boolean(stage) } : null;
  }
  // docs/adr/2026-11-18-0523-previews-run-in-a-sandboxed-opaque-origin.md: an HTML page of the site's own tells the
  // reader sheet framing it its title and its link taps by message, since the sheet can't reach into its opaque origin.
  async function withPreviewFrame(html) {
    const script = `<script>${await fs.readFile(path.join(template, 'public', 'preview-frame.js'), 'utf8')}</script>`;
    const end = html.toLowerCase().lastIndexOf('</body>');
    return end < 0 ? html + script : html.slice(0, end) + script + html.slice(end);
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
  // Only the hub holds a board's stream, over localhost, and hears a dead board by its socket closing, so the stream
  // sends no ping; the hub pings the pages' streams (hub/stream.mjs).
  const broadcast = (text) => { for (const res of streams) res.write(text); };

  // A burst of writes, such as a rename after a temp file, sends one signal; a steady stream of them still sends one
  // every CHANGE_MAX.
  const CHANGE_QUIET = 100;
  const CHANGE_MAX = 500;
  let changeTimer = null;
  let changeFirst = 0;
  let changeSent = null;
  // A write to file, which the server made itself, a store write told it of (files.mjs wrote), or with no file a change
  // it can't name: the data version steps at once, and after 100 ms of quiet (500 ms at most) pages get one change
  // signal and the change passes run. data/sync.json, the server's own record of its change numbers, signals nothing.
  // changed({ read: true }), the minute's signal for a write no one told the server of, leaves the data version, which
  // the minute stepped already.
  function changed(file) {
    const read = file?.read === true;
    if (file !== undefined && !read) file = path.resolve(here, String(file));
    if (file === syncFile) return;
    if (!read) dataVersion++;
    const at = performance.now();
    if (!changeTimer) {
      changeFirst = at;
      track(new Promise((resolve) => { changeSent = resolve; }));
    }
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      changeTimer = null;
      const sent = changeSent;
      // A write made while the server starts signals once the startup passes are done (ready), so no pass reads the
      // board half-migrated.
      ready.then(() => {
        broadcast(`event: change\ndata: ${JSON.stringify({ at: now().toISOString() })}\n\n`);
        for (const pass of [fileNewAsks, settleLanes, checkArchive, markNewCards, dropGoneDrafts, checkActions, checkWaits, checkAuto, checkIdle]) track(pass());
        sent();
      });
    }, Math.max(0, Math.min(CHANGE_QUIET, changeFirst + CHANGE_MAX - at)));
  }
  // The server writes through files.mjs as every process does. A data/ file the board build reads is told (changed); a
  // file only the passes read is written with told false, since the pass that wrote it has acted on it already.

  // Requests that come in while the startup passes run wait for them (ready), so none reads the board half-migrated.
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const server = http.createServer((req, res) => track(ready.then(() => answer(req, res))));
  // docs/adr/2026-11-17-2330-a-pure-tap-plan-decides-what-an-owner-tap-does.md
  // Runs a tap's effects (domain.mjs tapPlan) in order through the board's data modules; a refusal on the way is a BoardError whose
  // status answer() sends. → the tap's event id, or a Build's (runs.mjs start), or null for a tap that records none.
  async function applyTap(effects, kind, body, sendId) {
    const key = String(body.key || '');
    let id = null;
    for (const effect of effects) {
      if (effect.do === 'event') id = (await appendEvents([[kind, body]]))[0];
      else if (effect.do === 'clearStall') await clearStall(here, key);
      else if (effect.do === 'clearOwnerWait') await clearOwnerWait(here, key);
      else if (effect.do === 'stage' && effect.as === 'asIs') stopAgents(await implementAsIs(here, key, sendId));
      else if (effect.do === 'stage' && effect.as === 'implement') stopAgents(await stageImplement(here, key, body));
      else if (effect.do === 'stage' && effect.as === 'reply') await stageReply(here, key);
      else if (effect.do === 'record') await recordTap(key, kind, body, effect);
      else if (effect.do === 'resume') heldIf(await runs.resume(here, key, runIo));
      else if (effect.do === 'merge' && effect.held) {
        await tapMerge(here, key);
        runHeldMerge(key);
      }
      // A refusal is a thread line too (cards.mjs mergeCard).
      else if (effect.do === 'merge') await mergeCard(here, key, { tapped: true });
      else if (effect.do === 'build') {
        const full = !pullOf((await sharedBoard()).items, { cap: boardCap(readUsageGate({ dir: here })), pulled: await sentOf(PULL) }).free;
        // A build's launch wakes no session, so the tap answers with no event id.
        await runs.start(here, key, 'build', { ...runIo, dispatch: 'tap', full });
        id = null;
      }
      else if (effect.do === 'plan') await planAgain(here, key, effect.kind, effect.ask);
      else if (effect.do === 'moveLand') moveQueuedLand(here, key, effect.first ? now().toISOString() : null);
      else if (effect.do === 'line') await appendCommand(here, key, { who: 'love', command: effect.command, sendId });
      else throw new Error(`tapPlan gave an effect applyTap doesn't run: ${effect.do}`);
    }
    dataVersion++;
    return id;
  }
  // The tap written to the card's item file; with stops, the agents the write closed are stopped, read before it closes
  // them (a held build runs on to its stopping point, its record left open). One that couldn't be written, or had
  // nothing to write, refuses with why.
  async function recordTap(key, kind, body, { nothing, stops }) {
    const refuse = (status, words) => { throw Object.assign(new BoardError(words), { status }); };
    let agents = [], written;
    try {
      if (stops) agents = await openAgents(here, key);
      written = await recordOwnerTap(here, kind, body);
    } catch (e) { refuse(e instanceof BoardError ? 400 : 500, `Couldn’t write ${key} to its item file: ${e.message}`); }
    if (!written) refuse(400, nothing);
    if (!agents.length) return;
    const open = await openAgents(here, key);
    agents = agents.filter((a) => !open.some((o) => o.pid === a.pid));
    if (agents.length) {
      stopAgents(agents);
      await appendStatus(here, key, 'builder-stopped');
    }
  }

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
      // docs/adr/2026-11-18-1200-the-owner-signs-in-with-a-link-that-sets-a-device-cookie.md: the board's port is on
      // loopback, where any process reaches it past the hub, so the board checks the sign-in itself. Without the
      // signed-in device's cookie a request gets only AGENT_PATHS from a process on this host (an event of any kind but
      // the owner's, ownerKind), and reads of files that aren't pages: the app's code, and the site's own preview files,
      // which a sandboxed preview loads with no cookie.
      const owner = signedIn(req);
      if (!owner && !(agentCaller(req) && AGENT_PATHS.has(`${req.method} ${p}`)) && !fileRead(req.method, p)) return refuse(req, res, 'signed-out');
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
        const words = String(url.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
        const older = archiveMatching(await readArchive(here), words).filter((a) => !before || archiveRank(a) < before);
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
        const unread = orchestratorWaits(built).filter((w) => REQUEST_KINDS.includes(w.kind) && !w.picked);
        return json(res, 200, { working: built.workingOn.map((w) => ({ id: w.id, kind: w.kind, card: refs.get(w.key) || null, since: w.since })),
          unread: unread.map((w) => ({ key: w.key, ref: w.ref, kind: w.kind, since: w.since })) });
      }
      if (p === '/api/thread') return json(res, 200, await thread(String(url.searchParams.get('key') || '')));
      if (p === '/api/notes' && url.searchParams.has('all')) {
        const { notes } = await pageBoard(req);
        return json(res, 200, { notes: Object.fromEntries([...notes].filter(([, markdown]) => markdown !== null)) });
      }
      if (p === '/api/notes' || p === '/api/plan') {
        const key = String(url.searchParams.get('item') || '');
        try {
          const { itemFile, item, markdown } = await readNotes(here, key);
          return json(res, 200, { key, ref: refOf(itemFile, item, settingsOf(await config()).tickets), title: item.title, markdown });
        } catch (e) { if (e instanceof BoardError) return json(res, 404, { error: e.message }); throw e; }
      }
      // A store write in another process names the file it wrote (files.mjs wrote).
      if (p === '/_claude/changed' && req.method === 'POST') {
        changed(String((await readBody(req)).file));
        res.writeHead(204, { 'cache-control': 'no-store' }).end();
        return;
      }
      if (p === '/_claude/events' && req.method === 'POST') {
        // Room for a Send carrying every ready answer's note.
        const body = await readBody(req, 512 * 1024);
        const kind = String(body.kind || 'message').slice(0, 64);
        delete body.kind;
        if (!owner && ownerKind(kind, body)) return refuse(req, res, 'signed-out');
        // The version of the board the page holds, so the answer's board is a patch from it.
        const since = String(body.since || '');
        delete body.since;
        // docs/adr/2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md,
        // docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md: the page resends a
        // reply-box tap whose answer it never saw, so one already recorded under its sendId answers as recorded.
        const sendId = body.sendId ? String(body.sendId) : null;
        const recorded = sendId && (await readLog(events)).find((e) => e.kind === kind && e.data?.sendId === sendId);
        if (recorded) return json(res, 200, { id: recorded.id, board: await answerBoard(req, since) });
        // docs/adr/2026-11-17-2330-a-pure-tap-plan-decides-what-an-owner-tap-does.md: what a tap does to its card is
        // domain.mjs tapPlan's, drawn from the built card; a refused tap changes nothing.
        const plan = TAP_KINDS.has(kind) ? tapPlan((await sharedBoard()).items.find((i) => i.key === String(body.key || '')), kind, body) : null;
        if (plan?.refuse) return json(res, plan.refuse.status, { error: plan.refuse.words });
        delete body.version;
        if (kind === 'card-hold' && body.hold && body.for !== undefined) {
          const end = durationEnd(now(), body.for);
          if (!end) return json(res, 400, { error: 'That block ends in the past or more than 30 days on. Pick another time.' });
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
          if (kind === SCRIPT_EVENTS.run && scriptSha(read.offer.body) !== read.offer.sha) return json(res, 409, { error: 'This script\'s stored text no longer matches the text that was offered. It is not run.' });
          scriptTaps.add(id);
          try {
            const eventId = await appendEvent(kind, { key, id, ...(kind === SCRIPT_EVENTS.run ? { sha: read.offer.sha } : {}), ...(sendId ? { sendId } : {}) });
            await appendCommand(here, key, { who: 'love', command: kind === SCRIPT_EVENTS.run ? 'script-ran' : 'script-declined', sendId });
            if (kind === SCRIPT_EVENTS.run) runOfferedScript(key, id, cwd, read.offer.body);
            return json(res, 200, { id: eventId, board: await answerBoard(req, since) });
          } finally { scriptTaps.delete(id); }
        }
        // docs/adr/2026-11-13-2045-an-exact-repeat-within-30-seconds-is-skipped.md: a message whose text and card match one
        // recorded in the last 30 seconds answers as recorded, and writes nothing. A message with a sendId is a
        // distinct send of the page's, which its sendId already guards, so it is not compared.
        if (kind === 'item-message' || kind === 'ask') {
          const text = String(body.text || '');
          const repeat = text.trim() && !body.sendId && (await readLog(events)).reverse().find((e) => e.kind === kind && now().getTime() - Date.parse(e.ts) <= REPEAT_WINDOW_MS
            && String(e.data?.text || '') === text && String(e.data?.key || '') === String(body.key || ''));
          if (repeat) return json(res, 200, { id: repeat.id, board: await answerBoard(req, since) });
        }
        if (plan) return json(res, 200, { id: await applyTap(plan, kind, body, sendId), board: await answerBoard(req, since) });
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
        if (kind === 'review-answer') {
          try {
            if (!['post', 'skip'].includes(body.answer)) throw new BoardError(`a review answer is post or skip, not "${body.answer}"`);
            await heldReview(here, Number(body.pr));
          } catch (e) {
            if (e instanceof BoardError) return json(res, 400, { error: e.message });
            throw e;
          }
        }
        // docs/adr/2026-11-18-2330-deleting-a-new-ask-reads-deleting-on-its-own-row.md: a Delete once its task's build has
        // started records nothing, and the page reads not deleted.
        if (kind === 'ask-withdrawn') {
          const refused = await withdrawRefused(here, String(body.id || ''));
          if (refused) return json(res, 400, { error: refused });
        }
        // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: a new task's card is filed
        // before its event is written, so the watcher's line names the card. An ask from the page is stored under its
        // send id, so one id runs from the tap to the card's from_ask, and a Delete names it before the board answers.
        const preset = kind === 'ask' ? (sendId && /^[\w.-]{1,64}$/.test(sendId) ? sendId : eventId(now())) : undefined;
        const filed = preset ? await fileAsk(here, preset, { id: preset, ts: now().toISOString(), kind, data: body }) : null;
        // docs/adr/2026-11-15-0730-each-question-has-the-threads-request-row.md: a new task sent with a request (its
        // Prototype, Grill or Visual) owes that kind's brief on its card, with the task's text and files, as the tap on a card does.
        if (filed && BRIEF_KINDS.includes(body.request)) {
          await planAgain(here, filed, body.request, { ...(body.text ? { text: String(body.text) } : {}), ...(Array.isArray(body.files) && body.files.length ? { files: body.files } : {}) });
        }
        const id = (await appendEvents([[kind, body, preset]]))[0];
        if (kind === 'ask-edited') await retitleAskCard(here, String(body.id || ''));
        // A deleted ask's New card goes with it.
        if (kind === 'ask-withdrawn') await dropAskCard(here, String(body.id || ''));
        if (kind === 'ask-withdrawn') await setHidden(here, String(body.id || ''), true);
        // The owner's Post it or Skip on a held review is applied here, without waking the orchestrator; a failure
        // leaves a review-failed event, a red line on the review's card and a wait.
        if (kind === 'review-answer') {
          try { await applyReviewAnswer(here, Number(body.pr), body.answer); }
          catch (e) { await appendEvent('review-failed', { pr: Number(body.pr), answer: body.answer, error: e.message }); }
        }
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
      // Board Settings' Schedules (schedules.mjs): the list, each last task with its ref; an edit or removal answers
      // with the list again.
      if (p === '/api/schedules') {
        if (req.method === 'POST') {
          const body = await readBody(req);
          try {
            if (body.remove === true) await removeSchedule(here, String(body.id ?? ''));
            else await setSchedule(here, String(body.id ?? ''), { text: body.text, cadence: body.cadence });
          } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
        }
        const list = await Promise.all((await readSchedules(here)).map(async (s) => ({ ...s, last_ref: s.last ? await cardName(here, s.last) : null })));
        return json(res, 200, { schedules: list });
      }
      // Board Settings' Overrides group: what this board sets and what it would take from Hub settings' Board defaults.
      const autoOverrides = async () => ({ overrides: overridesOf(await readBoardJSON(here)), defaults: readBoardDefaults() });
      if (p === '/api/settings' && req.method === 'GET') {
        const settings = await readBoardSettings(here);
        return json(res, 200, { settings, ...(await autoOverrides()), paused_until: boardPausedUntil(here), pause_choices: HOLD_CHOICES });
      }
      // Board Settings' Description: the hub's manifest entry, which the router reads (settings.mjs readBoardDescription).
      if (p === '/api/description' && req.method === 'GET') return json(res, 200, readBoardDescription(here));
      if (p === '/api/description' && req.method === 'POST') {
        const body = await readBody(req);
        try { return json(res, 200, await saveBoardDescription(here, body.description)); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
      }
      // Board Settings' Build target picker (docs/adr/2026-11-05-1823-board-settings-picks-which-build-script-a-board-runs.md).
      if (p === '/api/build-targets' && req.method === 'GET') {
        const self = boardAt(here);
        if (!self) return json(res, 404, { error: 'This board isn’t in the hub’s manifest.' });
        const source = boardRepo(self.route);
        // A board whose scripts are in kickflip offers its site's scripts/build-<target> (build-script.mjs listKickflipTargets).
        return json(res, 200, { targets: self.scripts === 'kickflip' ? listKickflipTargets(here) : await listBuildTargets(source.repo, mainRefOf(source)) });
      }
      // Board Settings' Scripts (docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md): the
      // source, the repo's scripts at main, which show the Repo choice, and kickflip's scripts, each a code box whose
      // Save replaces the file (build-script.mjs writeScript).
      if (p === '/api/scripts' && (req.method === 'GET' || req.method === 'POST')) {
        const self = boardAt(here);
        if (!self) return json(res, 404, { error: 'This board isn’t in the hub’s manifest.' });
        if (req.method === 'POST') {
          const body = await readBody(req);
          try { writeScript(here, body?.name, body?.text); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
        }
        const source = boardRepo(self.route);
        return json(res, 200, { source: scriptsOf(here).scripts, repo: await listRepoScripts(source.repo, mainRefOf(source)), scripts: kickflipScripts(here) });
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
          const out = await response.json();
          // A card's Serve or Kill the hub took leaves the owner's line on the card; main's and the prototypes' have no card.
          if (response.ok && !['main', 'prototypes'].includes(body.key)) await appendCommand(here, body.key, { who: 'love', command: kill ? 'killed' : 'served' });
          return json(res, response.status, out);
        } catch (e) { return json(res, 502, { error: `Could not ${kill ? 'kill the serve' : 'start the build'}: ${e.message}` }); }
      }
      if (p === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req);
        let saved;
        try { saved = await saveBoardSettings(here, body); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
        // A silent Board default, such as idle_notification, which the board server alone acts on (checkIdle), wakes no session.
        const told = saved.changed.filter((k) => !SILENT_DEFAULTS.includes(k));
        // A setting cleared back to its default, such as build_target, reads null.
        const id = told.length ? await appendEvent('settings', Object.fromEntries(told.map((k) => [k, saved.settings[k] ?? null]))) : null;
        // An approved PR merges on the session's GitHub tick once auto-merge is on (docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md).
        if (saved.changed.includes('auto_merge') && saved.settings.auto_merge) await appendEvent('check-github', { reason: 'auto-merge' });
        return json(res, 200, { settings: saved.settings, ...(await autoOverrides()), id });
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
      if (p === '/api/drafts' && req.method === 'POST') {
        let draft;
        try { draft = draftOf(here, await readBody(req)); } catch (e) { if (e.status === 400) return json(res, 400, { error: e.message }); throw e; }
        return json(res, 200, await saveDraft(here, draft));
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
      const recorded = shell ? null : await recordedPrototype(p);
      const file = shell ? null : recorded ? (recorded.stage ? STAGE_TEMPLATE : PROTOTYPE_TEMPLATE)
        : ['/prototype.html', '/prototype-stage.html'].includes(p) ? null : await staticFile(decodeURIComponent(p));
      if (!shell && !file) { res.writeHead(404).end(); return; }
      const ext = shell ? '.html' : path.extname(file).toLowerCase();
      if (!owner && ext === '.html') return refuse(req, res, 'signed-out');
      const st = shell ? null : await fs.stat(file);
      // A preview: a stage, or any file of the site's own public/, which agents write.
      const preview = Boolean(recorded?.stage) || Boolean(file?.startsWith(siteRoot + path.sep));
      let body = shell ? Buffer.from(shellHtml({ touchIcon: await touchIcon() }))
        : recorded ? Buffer.from(await (recorded.stage ? prototypeStage : prototypePage)(here, recorded.proto)) : await fs.readFile(file);
      if (!shell && ext === '.html') body = (await pageHeaders(body.toString('utf8'))).replaceAll('{{title}}', esc((await config()).title)).replaceAll('{{touchIcon}}', await touchIcon());
      if (preview && !recorded && ext === '.html') body = await withPreviewFrame(body);
      if (!shell && ext === '.html') body = Buffer.from(await versionAssets(body, p));
      const etag = ext === '.html' ? `W/"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20)}"` : `W/"${versionOf(st)}"`;
      const pinned = ext !== '.html' && url.searchParams.get('v') === versionOf(st);
      const headers = { 'content-type': routeRecord(types, ext) || 'application/octet-stream', 'cache-control': pinned ? 'public, max-age=31536000, immutable' : 'no-cache', etag,
        ...(preview ? SANDBOX : {}), ...(preview && ['.js', '.mjs'].includes(ext) ? SANDBOX_MODULE : {}) };
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

  // docs/adr/2026-11-21-2300-a-schedule-files-a-quick-build-on-a-cadence.md: each minute the board's schedules that are
  // due fire (schedules.mjs fireSchedules), none while the board is paused (a usage pause, Pause board or Pause hub), so
  // the fires a pause held come as one when it lifts.
  let checkingSchedules = false;
  async function checkSchedules() {
    if (checkingSchedules || readUsageGate({ dir: here }).state === 'paused') return;
    checkingSchedules = true;
    try {
      const { lines } = await fireSchedules(here, (await sharedBoard()).items, now());
      for (const line of lines) logCall({ call: 'schedule', result: line });
    } finally { checkingSchedules = false; }
  }

  // docs/adr/2026-11-02-1727-a-card-can-be-held-until-a-time.md
  let checkingPickUps = false;
  async function checkPickUps() {
    if (checkingPickUps) return;
    checkingPickUps = true;
    try {
      const at = now().getTime();
      const due = (await sharedBoard()).items
        .filter((it) => it.ownerBlock?.until && it.lane !== 'done' && Date.parse(it.ownerBlock.until) <= at);
      // The resumed item file stops a second pick-up; the event log covers a restart between the event and that write.
      const sent = due.length ? await readLog(events) : [];
      for (const { key, ownerBlock: { until } } of due) {
        await pickUp(here, key, until, { announce: !sent.some((e) => e.kind === 'card-unblocked' && e.data?.key === key && e.data?.until === until) });
        heldIf(await runs.resume(here, key, runIo));
        logCall({ call: 'pick-up', key, result: 'resumed', reason: 'Its block ended.', inputs: { until } });
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
  // review. None goes out while usage is paused, nor while the Mac is busy unless its card is bumped (shared/usage-gate.mjs heldFor), each launch checking
  // again (runs.mjs heldNow); the minute check runs the jobs again once the hold lifts, since it lives outside the board's
  // data. Near the line the pull's cap is halved (tasksInProgressCap). A grill or prototype asked for during a hold launches first. A check asked for while one runs runs again after it.
  // The slots this board could fill if every free one fell to it: Hub settings' Maximum tasks in progress, halved near
  // the usage line, less what every other board holds (build-turns.mjs othersHeld).
  const boardCap = (gate) => tasksInProgressCap(gate, readTasksInProgress(home)) - othersHeld({ home, site: here });
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
    // Before the board is read, so a gone planner's line lands now and the card's next brief launches in this pass.
    await runs.closeGone(here, runIo);
    for (const key of Object.keys(await loggedOutCards(await liveFiles(here), home))) await noteLoggedOut(here, key);
    const log = await readLog(events);
    const { items, reviews } = await sharedBoard();
    const hold = await triageHold(log);
    const pulled = await sentOf(PULL);
    const gate = readUsageGate({ dir: here });
    const hubCap = tasksInProgressCap(gate, readTasksInProgress(home));
    const cap = boardCap(gate);
    if (boardPaused && gate.state !== 'paused') await appendEvent('usage-resumed', { window: 'manual' });
    boardPaused = gate.manual === 'board';
    const resumes = await checkPauses(items, gate, cap);
    const { idle, pullable, retitle, waiting, queue, held: holding, helpers } = pullOf(items, { cap, pulled, hold });
    heldByPause = (await runs.tick(here, items, runIo, { resumes, helpers })).held;
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
    await checkTriage(log, items, ready);
    const held = pullable.filter((k) => hold.includes(k));
    if (held.length) logCall({ call: 'pull', result: 'held', reason: 'An overnight triage waits for the session\'s reply and names these tasks, so the pull leaves them until it is answered or quiet hours end.', inputs: { cards: held } });
    const startPull = async (key) => {
      const { started } = await runs.start(here, key, 'build', runIo);
      logCall({ call: 'pull', key, result: runs.startResult(started), reason: 'A hub build slot was free and the turn fell to this board\'s top ready task.', inputs: { cap: hubCap, pullable, waiting } });
    };
    // docs/adr/2026-11-19-0602-one-hub-wide-build-cap-boards-take-turns.md: the board offers its queue to the hub's
    // turns and starts the cards the turns give it. A hold keeps them all from the turns, a busy host only the
    // unbumped ones (docs/adr/2026-11-19-0242-a-bump-goes-first-in-every-queue.md). A card that already has a builder,
    // as a pass an instant earlier left it, is not started again.
    const bump = bumpIn(items);
    const wants = queue.filter((k) => !heldFor(gate, 'claude', Boolean(bump(k)))).map((key) => ({ key, first: bump(key) }));
    const { take } = await claimBuilds({ home, site: here, held: holding, wants, cap: hubCap });
    const unstarted = [];
    for (const key of take) {
      if (await runs.unstarted(here, key)) { unstarted.push(key); continue; }
      logCall({ call: 'pull', key, result: 'skipped', reason: 'It already has a builder.', inputs: {} });
    }
    if (await sendPulls(PULL, waiting, unstarted, startPull)) return;
    // docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md: one review at a time, after any pull.
    const { due, repo } = reviews;
    if (!ready || !due) return;
    logCall({ call: 'pr-review', result: 'asked', reason: `The board is idle and PR #${due.number} touches its work.`, inputs: { repo, pr: due.number, head: due.head, touches: due.touches, asked: Boolean(due.asked) } });
    await appendEvent('pr-review', { pr: due.number, head: due.head, repo, title: due.title, author: due.author, url: due.url, touches: due.touches, asked: Boolean(due.asked) });
  }

  // docs/adr/2026-11-17-2345-a-board-launched-run-lives-in-one-runs-module.md: the server's context for runs.mjs, whose
  // launches go through launch, log to the board's audit log, and drop the cached board when they write a card's files.
  const runIo = { launch, log: logCall, stale: () => { dataVersion++; }, event: (kind, data) => appendEvent(kind, data), home };
  // A pass that found the board's launches held marks the board held, so the minute check brings in the next pass once
  // it lifts.
  const heldIf = (pass) => { if (pass.held) heldByPause = true; };

  // docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
  // One pass of the card pauses (domain.mjs pauseWork) over the built items, with gate the usage gate: each running build
  // a usage pause or Pause board or hub now holds is asked to pause, a pause whose cause cleared before its builder
  // stopped comes off, and a build still running PAUSE_HARD_STOP after it was asked is marked paused and its
  // board-launched process stopped. pausesLive keeps the minute check running the pass while any pause stands.
  // → the keys of the paused builds due to resume, oldest pause first.
  let pausesLive = false;
  async function checkPauses(items, gate, cap) {
    const opts = { cap, usageHeld: (kind) => pausesRunning(gate, kind) };
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
      const agent = (await runs.launchedBuilds(here, key))[0];
      const stopped = agent ? await stopRuns([agent.pid]) : [];
      logCall({ call: 'pause', key, result: 'hard stop', reason: 'Its builder reached no stopping point within 15 minutes of the pause.', inputs: { stopped: stopped.map((p) => p.pid) } });
    }
    if (work.ask.length || work.drop.length || work.stop.length) dataVersion++;
    pausesLive = work.ask.length > 0 || items.some((i) => i.builder?.pause);
    return work.resume;
  }

  // Once a minute: a tapped script run whose runner died (a reboot, a kill) is recorded failed, with the log's tail as its
  // output so far (scripts.mjs diedRuns).
  async function failDeadScriptRuns() {
    for (const { key, id, ms } of diedRuns(await readLog(events), { pidOf: readRunnerPid, alive: pidAlive, now: now().getTime() })) {
      await appendEvent(SCRIPT_EVENTS.result, { key, id, exit: null, died: true, timedOut: false, output: logTail(path.join(logsDir(), scriptLogName(id))), ms, log: scriptLogName(id) });
      dataVersion++;
    }
  }
  // The script offers whose Run or Decline is being recorded, so two taps at once record one.
  const scriptTaps = new Set();
  // Starts card key's offered script id, whose checked text is body, in cwd (startScript), a runner that couldn't start going in the audit log.
  function runOfferedScript(key, id, cwd, body) {
    startScript(here, key, id, cwd, body).on('error', (e) => logCall({ call: 'script-run', key, result: 'failed', reason: e.message, inputs: { id } }));
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
  async function checkTriage(log, items, ready) {
    const file = path.join(data, 'triaged.json');
    const marker = await readJSON(file, {});
    const { waiting, seen } = triageOf(items);
    const save = () => writeJSON(file, { seen }, { told: false });
    const last = log.filter((e) => e.kind === 'overnight-triage').at(-1);
    if (last && !(await withReply(last)).reply) { if (marker.seen !== seen) await save(); return; }
    if (!(await triageOn()) || !ready) return;
    // docs/adr/2026-11-16-2100-overnight-triage-proposes-a-stale-board-description.md: a description due a check sends
    // the triage alone, naming no cards, so it holds no pull.
    const answers = waiting.length >= 2 && seen !== marker.seen;
    const description = describeNightly && await descriptionDue(here, now());
    if (!answers && !description) return;
    const date = await triageNight();
    if (!date || last?.data?.date === date) return;
    const topic = `overnight-triage-${date}`;
    const owner = await readJSON(path.join(data, 'owner.json'), { topics: [] });
    if (!(owner.topics || []).some((t) => t.id === topic)) await addTopic(here, { id: topic, title: `Overnight triage ${date}` });
    const cards = answers ? waiting : [];
    const why = [answers && `${waiting.length} tasks wait on answers`, description && 'the board\'s description is due a check'].filter(Boolean).join(' and ');
    logCall({ call: 'triage', result: 'sent', reason: `Auto triage is on, ${why}, and tonight's triage hadn't gone out.`, inputs: { date, cards } });
    await appendEvent('overnight-triage', { date, topic, cards, ...(description ? { description: true } : {}) });
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

  // The hub's Triage overnight switch (docs/adr/2026-11-16-0100-one-hub-triage-overnight-switch-replaces-the-board-toggle.md),
  // read from settings.json each time, since the owner flips it there.
  async function triageOn() {
    return overnightOn('triage', await readJSON(path.join(home, '.claude', 'kickflip', 'settings.json'), {}));
  }

  // Whether the minute check runs the Auto jobs for an overnight triage: the hub's Triage overnight is on, and tonight's hasn't gone out.
  async function triageDue() {
    if (!(await triageOn())) return false;
    const date = await triageNight();
    return Boolean(date) && (await readLog(events)).filter((e) => e.kind === 'overnight-triage').at(-1)?.data?.date !== date;
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
    if (JSON.stringify(markedOf(await readJSON(file, {}))) !== JSON.stringify(keys)) await writeJSON(file, { keys, at: now().toISOString() }, { told: false });
    return keys.length > 0;
  }

  // A push this server sends on its own (cards.mjs sendPush), logged with why, under the card it is about when key names
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
  // docs/adr/2026-11-15-1300-a-boards-needs-you-pushes-are-one-live-row.md
  // docs/adr/2026-11-17-1505-alerts-opt-in-to-sounding-the-live-row-as-implement-or-a-merge-joins.md
  // data/action-pushes.json {row: {title, body, url} | null, items: {<tag>: kind}}: the board's live notification at the
  // last check (domain.mjs ownerRow) and the kind of each action in it. A row where there was none pushes and alerts; a
  // changed row pushes silently, so only its first push alerts until it closes, unless an action joins it of a kind whose
  // alert switch is on in settings.json (domain.mjs rowAlerts), read each check: that push alerts, held as a first push
  // is. An action of a task with a reminder at the check (pushReminders) neither opens the row alerting nor sounds it as
  // it joins. A file without items takes the row's actions now as already pushed. A row gone drops its queued push, or closes the one already sent (hub/push.mjs
  // withdraw). The first check records the row without pushing it. A file from before the live row, {<tag>: {kind, ids}}
  // with a tag per card, counts as a row open when it held any, and its card tags are withdrawn. A check asked for while
  // one runs runs again after it.
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
  // docs/adr/2026-11-26-2200-a-let-me-know-when-reminder-pushes-once.md
  // Each task's reminder (cards.mjs remindItem) whose event holds at this check, for the built board's items and its
  // actions (domain.mjs ownerActions): done when its lane is Done, needs-you when one of actions is its own. Each is
  // cleared first (cards.mjs endReminder), so it fires once, then pushed as kind reminder, urgent so quiet hours, a
  // snooze and the weekend don't hold it, under reminder-<key>; needs-you reads as its action does and lands where the
  // owner answers. A needs-you reminder on a task that closed ends with no push.
  async function pushReminders(items, actions) {
    await pushBells(items, actions);
    for (const it of items.filter((i) => i.remindWhen && i.remindWhen !== EVERY_STAGE)) {
      const action = actions.find((a) => a.tag === pushTag(it.key));
      const done = it.lane === 'done';
      if (!done && !(it.remindWhen === 'needs-you' && action)) continue;
      const sent = it.remindWhen === 'done' || !done;
      await endReminder(here, it.key, { sent });
      if (!sent) { logCall({ call: 'push', key: it.key, reason: 'Its needs-you reminder ended: the task closed without needing the owner.', inputs: { when: it.remindWhen }, result: 'dropped' }); continue; }
      const push = it.remindWhen === 'done' ? { title: `${it.ref} is done`, body: it.title, url: `#selectedCard=${encodeURIComponent(it.key)}` } : action;
      await sendOwnPush({ kind: 'reminder', title: push.title, body: push.body, url: `/${route}/${push.url}`, tag: `reminder-${it.key}`, urgent: true },
        { key: it.key, reason: it.remindWhen === 'done' ? 'The owner asked to know when it is done, and it is.' : 'The owner asked to know when it needs them, and it does.', inputs: { when: it.remindWhen } });
    }
  }
  // docs/adr/2026-11-26-2300-a-bell-on-a-card-pushes-at-every-stage-of-its-task.md
  // The pushes of the tasks the owner's bell is on (domain.mjs bellStep), diffed against data/bell-stages.json, each
  // belled task's stage at the last check: each pushed as kind reminder, urgent as every reminder is, under
  // reminder-<key>, so a newer stage replaces an older one on the phone. A done task's push is its bell's last: the
  // bell is cleared first (cards.mjs endReminder), with its Reminder sent line.
  async function pushBells(items, actions) {
    const file = path.join(data, 'bell-stages.json');
    const seen = await readJSON(file, {});
    const step = bellStep(items, actions, seen);
    for (const push of step.pushes) {
      if (push.last) await endReminder(here, push.key, { sent: true });
      await sendOwnPush({ kind: 'reminder', title: push.title, body: push.body, url: `/${route}/${push.url}`, tag: `reminder-${push.key}`, urgent: true },
        { key: push.key, reason: "The owner's bell is on this task, and its stage changed.", inputs: { when: EVERY_STAGE, was: seen[push.key] ?? null } });
    }
    if (JSON.stringify(step.seen) !== JSON.stringify(seen)) await writeJSON(file, step.seen, { told: false });
  }
  async function pushActions() {
    const file = path.join(data, 'action-pushes.json');
    const previous = await readJSON(file, null);
    const built = await sharedBoard();
    const actions = ownerActions(built);
    // docs/adr/2026-11-26-2200-a-let-me-know-when-reminder-pushes-once.md: a task with a reminder at this check
    // sounds its reminder, not the live row.
    const reminded = new Set(built.items.filter((it) => it.remindWhen).map((it) => pushTag(it.key)));
    await pushReminders(built.items, actions);
    const sounding = actions.filter((a) => !reminded.has(a.tag));
    const row = ownerRow(actions, { route, title: (await config()).title || route });
    const current = { row: row && { title: row.title, body: row.body, url: row.url }, items: Object.fromEntries(actions.map((a) => [a.tag, a.kind])) };
    const legacy = previous && !('row' in previous) ? Object.keys(previous) : [];
    const wasOpen = Boolean(previous?.row) || legacy.length > 0;
    const tag = `board-${route}`;
    const key = actions.length === 1 && actions[0].tag.startsWith('item-') ? actions[0].tag.slice(5) : undefined;
    if (legacy.length) await withdraw(legacy, route);
    const joined = wasOpen && row
      ? rowAlerts(sounding, previous.items ?? current.items, alertsOf(await readJSON(path.join(home, '.claude', 'kickflip', 'settings.json'), {}))) : [];
    // A count that falls, or words that change, send nothing: only something new joining the row pushes.
    const arrived = wasOpen && row ? actions.filter((a) => !(a.tag in (previous.items ?? current.items))) : [];
    if (previous && row && (!wasOpen || joined.length || arrived.length)) {
      const alert = (!wasOpen && sounding.length > 0) || joined.length > 0;
      const reason = !wasOpen ? `Something waits on the owner, and the board had no notification open${alert ? '' : ": its task's reminder sounds instead"}.`
        : joined.length ? `${joined.map((a) => a.title).join(', ')} joined the board's open notification, and the owner's alert for it is on.`
          : `${arrived.map((a) => a.title).join(', ')} joined the board's open notification, and the owner's alert for it is off.`;
      await sendOwnPush({ kind: 'action', title: row.title, body: row.body, url: `/${route}/${row.url}`, tag, now: alert, silent: !alert },
        { key, reason, inputs: { was: previous.row ?? null, count: actions.length, silent: !alert, ...(joined.length ? { alerts: joined.map((a) => a.tag) } : {}) } });
    }
    if (previous && !row && wasOpen) {
      const { closed } = await withdraw([tag], route);
      if (closed.length) logCall({ call: 'push', reason: 'Nothing waits on the owner, and the board\'s notification already went out.', inputs: { tag }, result: 'closed' });
    }
    if (JSON.stringify(current) !== JSON.stringify(previous)) await writeJSON(file, current, { told: false });
  }

  // docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
  // docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md
  // data/orchestrator-waits.json {waits: [{key, ref, title, kind, since, tone, picked, next, bumped, link?}], againAt, day}: the cards idle on
  // the orchestrator (domain.mjs orchestratorWaits), in the order to work them, then an unanswered triage, the events no task
  // holds (domain.mjs eventWaits) and other boards' questions, which bin/wait-events.mjs prints on every wake. Each
  // check appends at most one orchestrator-waits {opened: [{key, ref, title, kind, since, picked}], again: [{key, ref,
  // kind, since, next}]} event once the file is written: opened holds each wait that joins it not picked up, or waits
  // again with a new kind or since; again each one still waiting past its re-wake time (domain.mjs waitsStep), so
  // reading the event lines alone misses no wait. It appends at most one record-only waits-history {opened, cleared}
  // too: the waits that joined already picked up, and each that left, with when it was picked up and cleared, which
  // board.mjs waits history audits. A wait never pushes the owner: the re-wake is the reminder. Each owner's-last-word wait that ends appends a line to
  // data/limbo-waits.jsonl (domain.mjs ownerWordEnds). Checked on every board change and each minute; a check asked for while one runs runs again after it.
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
    const log = await readLog(events);
    const triage = await unansweredTriage(log);
    const working = await readWorking(here);
    // docs/adr/2026-11-15-0200-a-board-asks-another-board-and-its-orchestrator-answers.md: each question another board
    // asked, after the cards' waits, as a triage is.
    const questions = boardAskWaits(log, working);
    const built = await sharedBoard();
    // docs/adr/2026-11-15-1200-an-event-with-no-task-waits-on-the-orchestrator-until-acted-on.md: each event no task
    // holds, after the triage.
    const unhandled = eventWaits(log, { items: built.items, incoming: await readJSON(path.join(data, 'incoming.json'), null), reviews: await readJSON(path.join(data, 'reviews.json'), {}) });
    const current = [...orchestratorWaits(built), ...(triage ? [triageWaitOf(triage, routeRecord(working, triage.id))] : []), ...unhandled, ...questions];
    const step = waitsStep(previous, current, now(), stored?.againAt ?? null);
    // docs/adr/2026-11-15-1600-a-card-owing-nobody-or-with-the-owners-word-last-waits-on-the-orchestrator.md: each
    // owner's-last-word wait that ended, for the audit of what ended it.
    const ended = ownerWordEnds(previous, current, built, now());
    for (const e of ended) await appendLine(path.join(data, 'limbo-waits.jsonl'), e, { told: false });
    // docs/adr/2026-11-16-1400-orchestrator-waits-keep-a-history-and-waits-history-audits-it.md: the first check of a
    // new local day names to the orchestrator the waits WAIT_AUDIT_AFTER or more unpicked that opened from the stored
    // day up to today, in a record-only long-waits event its next wake prints.
    const today = localDay(now());
    const day = stored?.day ?? today;
    if (day !== today) {
      const start = (d) => new Date(`${d}T00:00`).getTime();
      const { over } = waitsHistory(log, { from: start(day), to: start(today), open: previous, now: now() });
      if (over.length) await appendEvent('long-waits', { day, waits: over.map(({ key, ref, kind, since, unpicked }) => ({ key, ref, kind, since, unpicked })) });
    }
    if (!stored || JSON.stringify(step.waits) !== JSON.stringify(previous) || step.againAt !== (stored.againAt ?? null) || stored.day !== today) {
      await writeJSON(file, { waits: step.waits, againAt: step.againAt, day: today });
    }
    const waking = step.opened.filter((w) => !w.picked);
    if (step.added.length || step.again.length) await appendEvent('orchestrator-waits', { opened: waking, again: step.again });
    const quiet = step.opened.filter((w) => w.picked);
    if (quiet.length || step.cleared.length) await appendEvent('waits-history', { opened: quiet, cleared: step.cleared });
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
    if (!settingsOf(cfg).idle_notification) return remove(file, { told: false });
    const previous = await readJSON(file, {});
    const built = await sharedBoard();
    const idle = strictlyIdle(built, { pulled: await sentOf(PULL) });
    const { state, push } = idleStep(previous, { idle, now: now() });
    if (push) {
      await sendOwnPush({ kind: 'reminder', title: `${cfg.title || route} has gone idle`, body: idleSummary(built.items, previous.last), url: `/${route}/`, tag: 'idle', now: true },
        { reason: 'The board has been strictly idle long enough, with idle notifications on.', inputs: { previous } });
    }
    if (JSON.stringify(state) !== JSON.stringify(previous)) await writeJSON(file, state, { told: false });
  }

  // docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md
  // Each card the build places in a lane other than its stored one moves there (domain.mjs movesOf, cards.mjs moveCard),
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
  // cards.mjs archiveCards), as the server starts and after each board change, each with when it closed and its PRs as last read. A check asked
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
  // T-<n> card (asks.mjs fileAsks): as the server starts, and after a board change that leaves one unfiled.
  async function fileNewAsks({ starting = false } = {}) {
    try {
      if (!starting && !(await sharedBoard()).unfiled.length) return;
      for (const key of await fileAsks(here)) console.log(`filed ask task ${key}`);
    } catch (err) { console.error('Ask filing failed:', err.message); }
  }
  // docs/adr/2026-11-05-0910-read-marks-live-on-the-board.md
  // Each card new to the board is read up to now, and a card gone from it loses its mark (cards.mjs markRead), as the
  // server starts and after each board change.
  async function markNewCards() {
    try { await markRead(here, (await sharedBoard()).items.map((i) => i.key)); } catch (err) { console.error('Read marks failed:', err.message); }
  }
  // docs/adr/2026-11-18-1200-composer-drafts-live-on-the-server.md: a reply's draft goes with its card and a question's with
  // its question once resolved, after each board change.
  async function dropGoneDrafts() {
    try {
      const board = await sharedBoard();
      const cards = new Set(board.items.map((i) => i.key));
      const open = new Set(board.owner.filter((q) => q.state !== 'resolved').map((q) => q.id));
      await pruneDrafts(here, (id) => (id.startsWith('item:') ? cards.has(id.slice('item:'.length)) : !id.startsWith('q:') || open.has(id.slice('q:'.length))));
    } catch (err) { console.error('Drafts failed:', err.message); }
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
  // docs/adr/2026-11-16-0312-a-store-write-tells-its-board-server.md: a write in this process, the server's own and the
  // startup passes' included, calls changed directly; one in another process POSTs /_claude/changed.
  const untell = tellOnWrite(here, changed);
  // docs/adr/2026-11-19-0602-one-hub-wide-build-cap-boards-take-turns.md: another board's pass granting this board a
  // card runs the pull, which takes it.
  const stopGrants = watchGrants({ home, site: here }, () => track(checkAuto()));

  const archived = archiveReader(here);
  // docs/adr/2026-11-17-0601-migrations-run-once-per-ledger-from-one-list.md
  await runMigrations('board', { site: here, archived });
  await runs.revive(here, async () => (await sharedBoard()).items, runIo, { boot: true });
  await fileNewAsks({ starting: true });
  await settleLanes();
  await checkArchive();
  await markNewCards();
  await checkPrototypeWaits();
  await checkPickUps();
  await checkAuto();
  track(checkActions());
  track(checkWaits());
  track(checkIdle());
  started();

  // A write no one told the server of (a git or hand edit, a write outside board.mjs and this server, a lost POST) sends no change signal,
  // so no page reloads and no pass runs on it. Each minute the board is stamped, and a change number that moved since
  // the last stamp signals a change (docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md). It reads no folder.
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
    track(runs.revive(here, async () => buildBoard(await readSnapshot(here, await outsideData(), { items: true })).items, runIo));
    track(failDeadScriptRuns().catch((err) => console.error('Script run check failed:', err.message)));
    // docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md
    track(publishUnscreened(here).then((keys) => { if (keys.length) dataVersion++; }, (err) => console.error('Screen publish failed:', err.message)));
    track(checkPickUps());
    track(checkSchedules().catch((err) => console.error('Schedule check failed:', err.message)));
    track(checkReadyExpiry());
    // A pause standing, or a usage pause or Pause board or hub starting, runs the pause pass (checkPauses).
    const gate = readUsageGate({ dir: here });
    // So does a hub build slot due to this board (build-turns.mjs turnDue), which no change of its own data signals.
    if ((heldByPause && !heldFor(gate, 'claude')) || pausesLive || (!heldByPause && pausesRunning(gate, 'claude'))
      || turnDue({ home, site: here, cap: tasksInProgressCap(gate, readTasksInProgress(home)) })) track(checkAuto());
    else track(triageDue().then((due) => { if (due) return checkAuto(); }, (err) => console.error('Triage check failed:', err.message)));
    track(checkActions());
    track(checkWaits());
    track(checkIdle());
  }
  async function close() {
    untell();
    stopGrants();
    await settled();
    leaveTurns({ home, site: here });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  return { server, changed, minute, settled, close };
}

// Run as a script: the board for the site dir argv[2] (else the working folder) on PORT (4600) under PREFIX, with its
// minute's checks every 60 s. SIGTERM, the hub's stop, exits once the passes and requests it started have
// finished (close()), so a restart for new code lands between writes; the hub's SIGKILL after its grace bounds the wait
// (docs/adr/2026-11-16-1500-new-code-restarts-on-a-busy-board-once-no-land-is-landing.md).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const site = path.resolve(process.argv[2] || process.cwd());
  const prefix = (process.env.PREFIX || '').replace(/\/+$/, '');
  const board = await startServer({ site, port: Number(process.env.PORT || 4600), prefix, describeNightly: true });
  process.once('SIGTERM', () => board.close().then(() => process.exit(0), () => process.exit(1)));
  setInterval(board.minute, 60000).unref(); // poll: board-minute
  console.log(`site on http://127.0.0.1:${board.server.address().port}/ (prefix ${prefix || 'none'})`);
}
