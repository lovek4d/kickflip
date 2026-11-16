#!/usr/bin/env node
import { readiness } from '../../hub/readiness.mjs';
import { readSlack, setSlack } from '../../hub/slack.mjs';
import { routeRecord } from '../../hub/routes.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as store from '../store.mjs';
import { waitsHistory, waitsHistoryLines } from '../domain.mjs';
import { boardWorktree, builderRepo, joiningLand, landInTurn, mergeHelper, nodeTests, passTests, worktreesDir } from '../worktree.mjs';
import { ownTests } from '../affected.mjs';
import { pidAlive } from '../headless.mjs';
import { fileFindings } from '../arch-review.mjs';
import { finishCard, landHeld } from '../finish.mjs';
import { bump, queueLines, stallCard, stopBuilder, stopLand } from '../stop.mjs';
import { boardAt } from '../../hub/boards.mjs';
import { boardRepo } from '../../hub/board-repo.mjs';
import { checkTakesRender } from '../render-check.mjs';
import { prototypeBase } from '../prototype-base.mjs';
import { detachedIn } from '../detached.mjs';

export const USAGE = `usage: node board.mjs <command> [--site <route>] ...

Writes a kickflip board's data files. --site <route> picks ~/.claude/kickflip/sites/<route>, and its
board.json says where the board's item files live. Without --site, they come from ~/.claude/waves.
Paths resolve under $HOME, so HOME=<dir> points every command at a copy.
A --file argument of - reads stdin.
Every new task is keyed T-<n>, with no ticket until it goes ready (the board makes one, on a board with a
source), item add or item set --new-ticket (the orchestrator, for a Quick task), or --ticket <id> gives it one. A ticket comes
from the board's source, GitHub or Linear, made from the task's title and notes, Linear in the board's team and project
through Hub's Linear key; a linked one must exist there. A board whose source is none has no tickets.
A task moves its ticket one way: a build's start → In Progress, --pr, --pushed or a verified merge-ready build → In
Review, --done → Done (a GitHub issue closes), only for a ticket assigned to the owner or created by kickflip. A ticket that
can't move prints one "ticket <id>: …" line; the task's change still stands.
Linear needs Hub's Linear key: settings set tickets refuses it without one, and once the key is removed the hub
moves every Linear board to no ticket source. If the source can't make a ticket, the command fails and changes nothing.

  reply <eventId> (--text <md> | --file <path>)          data/replies/<eventId>.md, markdown the board draws. A
                                                         reply to an ask answers the task it became, as reply
                                                         <file>/<id> does, and resolves that task's answered
                                                         questions, noting "Acted on: replied". A
                                                         reply to overnight-triage ends that triage
         [--title <t>]                                   retitles the New or discussing task the ask became
         [--questions <json>]                            the questions to ask with the message (thread takes it too),
                                                         in question add's shape: checked first, then the message is
                                                         posted and the questions asked after it, so the thread reads
                                                         message then questions. Refused beside --implement or --close
  reply <file>/<id> (--text <md> | --file <path>)        answers the New or discussing task an ask became: the
         [--title <t>]                                   answer goes in its thread and the task reads
                                                         discussing in Todo, --title as its title. Refuses a
                                                         task sorted another way or that isn't one an ask became.
                                                         reply, item set --phase, --title, --ticket and
                                                         --new-ticket, and item relate-ask refuse an ask (or the
                                                         task it became) the owner edited after its Working-on-it
                                                         mark, or edited and never handed over: they print the new
                                                         text and move the mark to now, so a rerun goes through
         [--close]                                       for a reply that leaves only the owner's Done: marks the
                                                         task waiting to be closed, so its Done goes orange and it
                                                         reads Action needed until the owner taps Done or writes
                                                         in its thread (thread <task> --close does the same)
         [--implement]                                   for a reply that ends at "tap Implement": marks the task
                                                         ready to implement, so its Implement goes orange and it
                                                         reads Action needed until the owner taps Implement or
                                                         writes in its thread. The mark lasts while the task keeps
                                                         its phase and lane. Text asking the owner to tap
                                                         Implement is refused without --implement, and text
                                                         asking them to tap Done without --close
  thread <file>/<id> --text <t> [--link <url>]           one line in the item's thread; ask:<eventId> in place
         [--implement | --close]                         marks the task waiting on the owner's Implement or Done,
                                                         as reply --implement or --close does, for any ticket;
                                                         --implement is refused on a task already staged, ready
                                                         or past Todo. The tap words need their flag, as for reply
         [--script <file>]                               offers the file's shell script on the task for the owner to
                                                         run: a card with the whole script, "Runs on <host> as <user>",
                                                         and Run (held) and Decline; --text says what it does and why
                                                         you couldn't. The task reads Action needed and pushes until
                                                         the owner runs or declines it; a newer offer replaces it. The
                                                         board server runs it in the board's repo folder, 10 minutes
                                                         at most, and a script-result event brings back its exit code
                                                         and output tail
         [--who claude|love|<name>] [--via github|slack] of <file>/<id> writes in that ask's thread
         A Claude thread line, or a reply to an ask or item-message, rewrites the body of the thread's
         queued push (tag ask-<eventId> or item-<file>/<id>) to the message's first line, keeping
         "· and N replies", and prints the new body. It never pushes: the thread's unread mark carries it
  visual add <file>/<id> --file <page.html> --title <t>  a visual agent's page: copied to public/visuals/<id>/<slug>.html
                                                         (a new name each time), linked by a visual line in the
                                                         item's thread; prints the page's link
  reviewer post <file>/<id> --file <findings.json>       a reviewer's findings, a JSON list of {severity:
                                                         high|medium|low, at?: "<file>:<line>", text}: one Reviewer
                                                         message in the task's thread, most severe first
  item brief <file>/<id> --kind grill|prototype|visual|reviewer
         --file <draft.md>                               the orchestrator's brief for the task's next agent of that
                                                         kind: what the discussion settled, what is still open,
                                                         what the questions, takes, page or review should cover
                                                         and the files that matter. Appended to its notes as "Brief
                                                         for <kind> round N"; the board launches the agent from it,
                                                         and from nothing else. A grill or prototype brief moves the
                                                         Todo task to grilling or prototyping
  topic add <id> --title <t> [--summary <s>]             a question topic in data/owner.json
  question add --file <json>                             one question or an array of them:
         {id, topic, question, options: [{id, label, recommended?, detail?, diagram?, practice?}],
          source?, context?, url?, urgent?, round_of?, reask_of?, ask?, suggested?, next_gate?, prototype_gate?}; topic is declared, item:<file>/<id> (an ask's
          questions go on its task's). A question on a done task reopens it.
         A question on an item: topic whose task has a grill or prototype planner running is staged, not published,
         whoever adds it: it shows nowhere until the planner finishes, fails or is stopped, when every staged question
         on the task publishes in the order added, with one owner push. The command says "staged" and why.
         url is http(s), or a site page such as prototype-<topic>.html?q=<id>, stored as given.
         Prototype options keep take order, ids matching take keys; recommended: true tags the recommendation.
         suggested: {option, task, answer, reason?} pre-checks the option the owner already chose on an earlier task, with a blue
         line above its description, Orchestrator choice: <reason>; give a reason, your own words for why. Without one the line
         reads Orchestrator choice: you answered this on <task>: "<answer>"; task is that task's ref, answer their words.
         Waiting on you shows fitting takes in a grid, or a chooser above one full-width take for a single take or if any
         scrolls or fills the screen.
         diagram, with practice: rows of 1-4 boxes [[{text, tone?, to?}]], tone quiet|info|notice|
         danger|success, to the next row's box indexes (default all); practice: ["<line>", …]
         A prototype url's topic must be recorded (prototype add), its option ids a non-empty subset of the
         take keys in take order, without repeats, and every take file written; a hand-written prototype-*.html
         is refused. Each take is then loaded headlessly at 390px and 1280px, and the question is refused,
         naming the take and width, if one throws, logs a console error or draws an empty stage.
         On an item: topic, each other question answered and still waiting on Claude is
         resolved, noting "Followed by <new id>", and printed as "resolved: <old id>". Any other unresolved
         question on the same topic that links the same prototype is resolved, noting "Replaced by <new id>",
         and printed as "replaced: <old id>". round_of names the question on the same topic whose
         prototype-request this answers; the question needs a prototype url, takes the next round
         number, and resolves that one, noting "Followed by prototype round N".
         next_gate: true marks a grill's closing "What next, given these answers?" question (options implement,
         prototype, discuss, in that order, on a task's topic). Once no question on the task is left open the
         board, with no orchestrator step, stages it on implement, moves it to prototyping and starts its
         prototype planner on prototype, and returns it to discussing on discuss. Implement and prototype stay on
         the task as its gates.prototype, no or yes, so a regrill or a split child never asks it again: question
         add refuses a next_gate whose answer the task keeps, and a yes is spent once the task moves to
         prototyping on it. Discuss is spent once the task moves, so the next grill asks again.
         prototype_gate: true marks the older closing "Prototype round first?" question (options yes, no): yes
         acts as prototype and no as implement. A question sets one of the two.
         reask_of names a resolved question on the same topic that the owner asked to ask again
         (reask-request): it resolves that one again, noting "Asked again as <new id>", printed as "resolved: <old id>".
         ask names a builder ask the session deferred on the item (builder defer): the question puts it to the
         owner, and while a task's only open questions are such, it waits on them with no Action needed.
         The board server pushes the new open questions itself, under the task's tag (item-<file>/<id>, or
         ask-<eventId>) or topic-<topic> off the tasks
  question resolve <id> --note <text>                   sets resolved and resolved_at; refuses a question on a
         prototype page until an answer settles its round: a pick, with a note or none, or an answer to
         an "Is this it?" confirm already on the board. A question already resolved, such as one an
         answer with a note and no option resolved, is left as it is
         [--close | --implement]                         for a card's question: in the same write the note goes into
                                                         the card's thread and the card is marked waiting on the
                                                         owner's Done or Implement (as thread --close or --implement
                                                         does), so no state between reads Implement
  question settle <id> --note <text>                    a question a finished grill left for the orchestrator to screen
         (a screen wait), which the board already answers: it is published resolved "Settled by the
         orchestrator: <text>", and the answer goes into the task's notes. Refuses the prototype question,
         which is the owner's. On a ready task waiting on your re-check since its block ended, it answers
         one of the task's questions again the same way, when what landed made its answer stale
  question publish <file>/<id>                          passes the rest of the task's screened questions on to the owner.
         The board server publishes any left unscreened 15 minutes on, with a thread line
  question move <id>,<id>,… --to <file>/<id> [--block <file>/<id>,…]   merges open questions that ask one thing onto
         one task: the first id moves to that task (topic item:<task>), the others resolve "Duplicate of
         <task>'s question <first id>". Each --block task, in order, is blocked by the one before it (the
         first by --to) and related to --to
  prototype add <topic> --title <t> --take <K>:<label>   records a prototype in data/prototypes.json: the board
         [--take <K>:<label> …] [--card <file>/<id>]     serves prototype-<topic>.html from its one template, with
                                                         the title, a back arrow to --card (else the board), the
                                                         take pill and a stage. topic: a-z, 0-9 and "-"; K: one
                                                         capital letter, in take order; a label never starts with
                                                         "A. ", since the pill shows it alone. Prints each take
                                                         file to write,
                                                         public/prototypes/<topic>/<K>.js, which exports
                                                         render(stage, kit) (board/public/prototype-kit.js lists kit).
                                                         --card starts that task: it leaves Todo
         [--served <path> [--state <key>:<label> …]]     a served round: no take files; the template frames <path>
                                                         from the board's base prototype worktree (prototype base),
                                                         passing ?variant=<K>&state=<key>, then each switch by
                                                         message (shared/prototype-frame.js). The viewer bar lists
                                                         the states; key: a-z, 0-9 and "-"
  prototype base                                         makes the board's base prototype worktree, a detached
                                                         checkout of its repo's main, or moves it to main's tip,
                                                         keeping the rounds' pages; prints its path, whether its
                                                         build script is there and the listener a page loads.
                                                         The hub serves it while an open question links a served
                                                         round (docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md)
  prototype list                                         one line per recorded prototype
  prototype rm <topic>                                   drops the record, keeping its take files; refuses while an
                                                         open question links it
  pr <file>/<id>                                         one JSON line per PR on the task, in its order: the PR's
                                                         repo, state, checks and new events, using the board's
                                                         github-login and the task's gh_since
  pr comment <pr> --body <text>                          posts Claude's words on PR <pr> through gh, a number in the
                                                         board's repo or owner/repo#<n> for a task's PR in another,
  pr reply <pr> <comment id> --body <text>               or replies in that review comment's thread, as the board's
                                                         github-login (else gh's account), adding "🤖 " before and a
                                                         blank line and <!-- claude-bridge --> after, the marker pr
                                                         reads as Claude's own. Refuses words that already carry
                                                         either. Prints the post's url
  item set <file>/<id> [--done --text <t> [--force]]    edits the item in its item file; --done closes the task
                                                         (below). A task has no status: it stores its lane, which
                                                         a build's start, a handover, a block and a close move,
                                                         and the board server moves the rest, each with a thread
                                                         line; --status is refused
         [--next <t> | --clear-next]                     an empty --next "" clears it, as --clear-next does
                                                         naming another unfinished task requires it in --blocked-by
         [--pr <n> | --pr <owner/repo#n>]...             adds a PR to the task, a bare number in the board's repo;
                                                         repeatable, and never replaces one. Each PR gets its own
                                                         badge and polling; the least-ready decides the task's lane
         [--pushed <branch>]                             on a board whose repo is a plain git remote (no GitHub):
                                                         the task's branch is pushed there, so it waits In Review
                                                         on the owner's merge. Push it first (git push origin
                                                         <branch>). The hub's repo fetch moves it to Done once the
                                                         branch is merged into the board's branch or gone from the
                                                         remote. Moves it to In Review as --pr does
         [--gh-since <ISO time>]                         records the last handled GitHub event, an ISO-8601 UTC
                                                         time such as 2026-10-23T11:00:00Z, stored as given
         [--from-ask <eventId> --text <t>]               the ask it came from, for an ask from before asks
                                                         arrived as tasks: its New row gives way to this item,
                                                         whose thread opens with the ask and its thread, then --text
                                                         as the item's first line; it leaves a task it was folded into; refuses a task
                                                         from another ask (use item relate-ask), an ask that is
                                                         already a task, naming it (sort that task instead), and
                                                         one with no phase when --phase is missing
         [--phase ready|discussing|grilling|prototyping] a Todo task's phase: what it does next; it reads New
                                                         until set, which sorts a New task an ask became (an
                                                         answered one leaves In Review for Todo). discussing is
                                                         a conversation in its thread, which reply on a New task
                                                         also sets. Like --title, --ticket and --new-ticket, refused
                                                         on an ask edited after you read it, as reply is.
                                                         Refused on a task in another lane, whose phase
                                                         the board sets, and as --state, its old name.
                                                         Staging is the board's: it stages a task on the owner's
                                                         Send, Implement or Reply on a ready task, and refuses
                                                         --phase staging. ready refuses a task not staging or
                                                         ready, bar --from-ask on a Quick build ask, whose filing
                                                         is your judgment; and a task with an open question, and
                                                         a task without --size, a notes file, or the id of each
                                                         answered question in that file, since a builder starts
                                                         from it; it resolves those answered questions.
                                                         grilling or prototyping on a discussing, staging or
                                                         ready task has the board start that round's planner.
                                                         A ready task whose block ended waits on your re-check:
                                                         ready again with --text "<what you re-checked>", which
                                                         goes into its notes, releases it to the pull
         [--blocked | --unblocked | --pick-up-at <time>] blocks or unblocks the task on the owner's words; the board
                                                         server records the owner's own Block and Unblock taps. A
                                                         later --blocked/--unblocked overrides a tap.
                                                         --pick-up-at blocks it until an ISO time such as
                                                         2026-11-04T09:00 (the host's local time without an
                                                         offset; a past time is refused), stored as UTC
                                                         pick_up_at. Within a minute of it the board server
                                                         unblocks the task, adds a thread line, and appends
                                                         card-unblocked {key, until} unless a dep is unfinished.
                                                         --blocked blocks it with no time; --pick-up-at "" unblocks it
         [--ticket <id> | --new-ticket]                links a ticket in the board’s source, or makes one there
                                                         from the title and notes; the key stays
         [--title <t>]                                   renames the task
         [--check "<name> <args>"]                       adds or changes the code check on the task's owner step,
                                                         as builder done --check takes it, clearing a broken mark;
                                                         --check "" removes it. Refused on a task with no owner step
         [--size small|large] [--model opus|sonnet]      what builder pick reads while the hub's Claude model is
                                                         Auto: a small task gets Claude Sonnet, any other Opus, and
                                                         --model wins over --size; "" clears either
         [--blocked-by <id>,<file>/<id>]                 replaces its Blocked by list; --blocked-by "" clears it
         [--blocked-until "<condition>"]                 blocks it until a condition an agent can check, which
                                                         the orchestrator checks on its passes over the tasks;
                                                         --blocked-until "" clears it, which threads and emits
                                                         card-unblocked {key} once nothing else blocks it
         [--block-reason "<reason>"]                     why it is blocked, by its deps or its condition, which
                                                         goes when the block does; --block-reason "" clears it
                                                         A block on a task In Progress sends it back to Todo,
                                                         stopping its board-launched builder (refused for a
                                                         session's own builder); one In Review stays, unlanded
         [--parent <file>/<id>]                          sets its Parent, refusing itself or a task below it;
                                                         --parent "" clears it
         [--related <id>,<file>/<id>]                    replaces the tasks it is Related to, which both tasks
                                                         show; --related "" clears it, on both
         [--relate <id>,<file>/<id>]                     adds tasks to its Related to, keeping the rest
         [--unrelate <id>,<file>/<id>]                   takes tasks off its Related to, on both tasks; neither
                                                         goes with --related
         [--install <url> [--install-sha <sha>]          a device build the owner installs from the task's Install
          [--install-label <text>] | --clear-install]    button, stamped built_at now: itms-services://?action=
                                                         download-manifest&url=https://…/manifest.plist for iOS,
                                                         an https:// .apk URL for Android. --install-sha is the
                                                         head it was built from: the badge reads "Install (stale)"
                                                         once the branch moves past it. Hidden once the task is Done
         [--text <t>]                                    with --done, required on a site: the task's closing line,
                                                         written last in its thread, saying why it closed (merged,
                                                         dropped, superseded)
         [--split-into <id>,<file>/<id>]                 with --done, in place of --text: closes a split task. Each
                                                         open task waiting on it waits on the tasks it
                                                         split into instead, with a line in its thread, and the
                                                         closing line reads "Split into …". Refused when a
                                                         waiting task is one of them, or the task is already Done
         builder start for a build moves the task to In Progress with "Moved to In Progress: a build
         started", resolving its answered questions, noting "Acted on: build started". It refuses while
         the owner has blocked the item or a dep isn't done, and while the newest owner answer to its questions that
         link a prototype-*.html page picks no take, which leaves the task prototyping with Next
         "Prototype again" until the next round's pick; a pick's note is the build's guidance.
         --pr closes ordinary builders and moves the task to In Review; install builders keep running.
         A builder's hand-back of work it couldn't land (builder done with judgment calls) keeps the task
         In Progress, reading "Orchestrator review", until the owning session lands it; it unblocks nothing.
         The board server records the owner's card-done in the item file itself.
         --done moves the task to Done and its ticket to Done: it resolves each of its questions (topic
         item:<file>/<id>) that has an answer, noting "Closed with the task", and prints "resolved: <id>"
         for each. It refuses while one has no answer yet; [--force] closes it and resolves that one too.
         It prints "unblocked: <file>/<id>" and appends card-unblocked {key} once per unblocking,
         including tasks the owner blocked: start each task nothing blocks next. It refuses a task the owner reopened: it
         closes again only on the owner's Done
  item add <file>[/<id>] --title <t>                    a new task, unstarted; never
         [--ticket <id> | --new-ticket]                  hand-edit the item file to add one. Refuses an id the file has.
                                                         A task with no ticket unless --ticket links one or
                                                         --new-ticket makes one from the title and notes
         (--notes <t> | --notes-from <draft.md>)         required on a board, except with --from-ask; the board makes the task's own notes, <id>-notes.md beside
                                                         its item file, read-only: the draft verbatim, or "# <title>"
                                                         then the --notes text. Refuses a draft that is any task's
                                                         notes file, live, done or archived, naming that task
         [--relate <id>,<file>/<id>]                     the tasks it touches, shown as Related to on both. On a
                                                         board a task of your own needs it, bar --from-ask and an
                                                         imported ticket, which are the owner's. Its title and
                                                         notes must link each task they name (T-<n>, GH-<n>,
                                                         #<ticket>, <file>/<id>; not inside "quotes"), by any link
         [--blocked-by <id>,<file>/<id>]                 the tasks it waits on: its Blocked by
         [--blocks <id>,<file>/<id>]                     the tasks that wait on it, each gaining it as Blocked by
         [--pick-up-at <time> | --blocked]               blocks it until then, or until unblocked, as item set's
         [--size small|large] [--model opus|sonnet]      as item set's
         On a board, --parent goes only with --ask: a task filed from another comes in as an ask
  item add <file> --ask <request>                       a task you file comes in as an ask through New, as the
         [--parent <file>/<id> [--split]]                owner's do: an ask event, your plain-text request, filed at
         [--relate <ids>] [--blocked-by <ids>]           once as a New T-<n> task in <file>, born with the links it
         [--blocks <ids>] [--by builder|planner]         carries; it waits in intake for your triage, investigation
                                                         and one reply. Its thread opens with a blue "From the
                                                         orchestrator", or with --by and a --parent "From <ref>'s
                                                         builder". Refuses --title, --notes, --phase and the rest
                                                         triage decides. Prints "<label> added as <key>: an ask in New".
                                                         It names where it came from, --parent or --relate, and
                                                         links each task the request names, as --title's notes do;
                                                         --blocked-by and --blocks only order it
         [--parent <file>/<id>]                          the task it came from: a split, a follow-up, something
                                                         found while building it. Its Parent lists it in Children,
                                                         and the threads read Created ticket and Created from,
                                                         blue. A task from the + or New task has none
         [--split]                                       with --parent, a split of that task: copies its gates, the
                                                         owner's prototype answer, so its grill never asks it again
         [--relate <id>,<file>/<id>]                     the tasks it touches, worth reading together, neither
                                                         causing the other; nothing is inherited
         [--phase discussing|grilling|prototyping|ready] files it at once, as item set's --phase; the session's
                                                         own form, linking it with --relate in the same call.
                                                         ready is for a Quick build ask (--from-ask), with --size
                                                         and --notes or --notes-from, since a builder starts from it
         [--text <t>]                                    with --phase discussing, required: the task's first thread
                                                         line, after Created from, in the same write; it reads the owner's turn
         [--from-ask <eventId> --text <t>]               files the task from that ask in this one command, as
                                                         item set's --from-ask, refusing an ask that is already a
                                                         task: no grill starts before the ask is on
                                                         the task, which takes the ask's place in Todo. Needs --phase
                                                         On a board --phase is required, so no task an agent
                                                         adds reads New
         Without /<id>, a task is keyed T-<n>, the next on the board, and a ticketed task takes its ticket's
         id (GH-<n> for issue #n); pass an id only to import a task. Prints "<label> added as <key>": use the key in later commands
  item notes <file>/<id> --heading <h>                 appends "## <h>" and the draft to the task's notes, making
         (--file <draft.md> | --from <file>/<id>)        its <id>-notes.md when it has none; the only way to write
                                                         notes (--notes-file and --plan are gone). Write the draft
                                                         outside the board's data; one that is any task's notes
                                                         file, live, done or archived, is refused, naming that
                                                         task. --from folds that other task's notes in instead,
                                                         headed "Folded from <ref> "<title>"" without --heading.
                                                         Resolves answered questions still waiting on Claude,
                                                         noting "Recorded in the task's notes", and prints
                                                         "resolved: <id>" for each. A task the section names
                                                         (T-<n>, GH-<n>, #<ticket>, <file>/<id>; not inside
                                                         "quotes") that the task has no link with becomes Related
                                                         to, with a line in both threads; prints "related: <key>"
  item triage <file>/<id> --title <t> --phase <p>        the first move on a new task, from what you know of the
         [--relate <id>,<file>/<id>] [--ticket <id>]     board, reading no code: one call sets the title (Conventional),
         [--parent <key> [--split]] [--blocked-by <ids>] the phase (discussing, grilling, prototyping, or visual,
                                                         which reads discussing for the visual's brief) and the
                                                         links as item set's and item add's, which sorts the New
                                                         task and ends its intake wait. Posts nothing in its
                                                         thread: the owner's message reads thinking until your
                                                         first reply.
                                                         Investigate after: notes, questions, a reply, ready.
                                                         Refuses a task already sorted, and an ask edited after
                                                         you read it, as reply does
         [--fold-into <file>/<id> [--text <t>]]          for a duplicate, in place of the rest: merges the New
                                                         task into that one as item relate-ask does, the ask's
                                                         thread naming it and its thread reading "Triaged:
                                                         folded in <ref> "<title>"; <text>"
  item relate-ask <eventId> <file>/<id> --summary <t>   folds an ask about an existing item into it: the New task
                                                         the ask became goes, its message and thread show in the
                                                         item's thread marked Moved, then the summary line, and the
                                                         owner's banner names the task it merged into. Refuses
                                                         an ask whose task is sorted. Again with another item
                                                         moves it there. Refuses an ask edited after you read it,
                                                         as reply does
         [--title <t>]                                   names the merge in the owner's banner
  ask unfold <eventId>                                   moves a folded ask back out to a task of its own
  ask move <eventId> --to <route>                        sends a New ask to another board in the hub's manifest:
                                                         a New task there with the owner's text, attachments and
                                                         "From /<this board>", which wakes its session; here
                                                         the task the ask became is dropped, leaving a line in the
                                                         ask's thread linking to that task. Refuses an ask whose
                                                         task is no longer New.
                                                         Refuses a route that isn't another board, and an ask
                                                         that isn't New
                                                         Then sends the queued pushes, each on its own, unless
                                                         pushes are held (overnight, snoozed, the weekend or off)
  handoff (<file>/<id> | <eventId>) --to <route>         hands work to another board in the hub's manifest. A New
         [--note <t>] [--done]                           ask, or a task still New from one, moves as ask move
                                                         does. Any other task becomes a New task there: its title
                                                         and a link to its notes here, "From /<this board> ·
                                                         <ref>" linking back, and --note quoted under it, its
                                                         thread opening "Handed from". Here it gets a grey
                                                         "Handed to /<route> · <ref>" line linking that task and
                                                         stays open as a pointer; --done, only for a full
                                                         handoff, closes it as item set --done does. Prints
                                                         "handed to <link>"
  ask <route> <question> [--from <file>/<id>]            asks another board in the hub's manifest a one-line
                                                         question, when this repo doesn't explain why something is
                                                         the way it is and that board owns it. There it shows in
                                                         the New strip and waits on its orchestrator, which
                                                         answers with answer; while none listens it stays queued.
                                                         --from names the task asking: it gets a quiet "Asked
                                                         <route>: <question>" line, then the answer as that
                                                         board's message. Prints "asked /<route>: <id>"; carry on
  asks [--wait] [--timeout <min>]                        prints each question this board asked, then its answer,
                                                         "waiting on /<route>'s orchestrator" or "queued" while
                                                         none listens there. --wait blocks until every one is
                                                         answered, giving up after --timeout minutes (9)
  waits history [--since <date>] [--kind <k>]            audits the waits on the orchestrator events.jsonl records
                                                         (each wait's open and clear): per kind, its count and the
                                                         median and longest wait to pickup and to clear, then each
                                                         wait 15m or more unpicked, worst first, intake (a task
                                                         stuck in New) first. --since keeps the waits from a date
                                                         (local midnight) or ISO time, --kind one kind
  answer <askId> --text <t>                              answers a question another board asked this one (its
                                                         waits line names it), from what this board knows, links
                                                         welcome: it ends the wait and its New strip entry, posts
                                                         the answer on the asking task, and wakes that board
  reviewers set --file <json>                           the board's reviewers in board.json, replacing them:
                                                         [{name, slack_user, dm, github}], as in an item file.
                                                         The settings page lists them; new item files copy them
  reviewers add --file <json>                            one reviewer or an array; replaces the same name
  reviewers remove <name>...                             refuses a name the board doesn't have
  slack                                                 Slack identity as JSON; imports slack-bridge config once
  slack set [--self-dm D..] [--user U..]                 sets hub Slack identity in ~/.claude/kickflip/slack.json
            [--domain x] [--timezone Area/City]
  slack thread <eventId>                                a slack-question event's day thread, read from Slack through
                                                         Hub's token: one message a line, named board, you or the
                                                         reviewer; → marks the event's message. On a message that
                                                         expects no reply, ends the orchestrator's wait on it
  slack answer <eventId> --text <t>                     posts "🤖 " and the answer, at most 250 characters, as a reply
                                                         in that thread, ending the orchestrator's wait on it.
                                                         Refuses an owner's message that names no @kickflip, which
                                                         expects no reply
  slack skip <eventId>                                  ends the orchestrator's wait on a slack-question that needs
                                                         no answer, such as a thanks, posting nothing
  slack say <reviewer> --text <t>                       posts "🤖 " and the words, at most 250 characters, in the
                                                         reviewer's day thread for today, opening it with the
                                                         day's digest when none is open; only on the owner's
                                                         explicit ask
  slack link <pr> --to <reviewer>                       sends the PR's link, the one PR message format (a risk-coloured
                                                         bar: title linking the PR, +N/-M · K files · risk, no @mention),
                                                         in the reviewer's day thread through the hub's Slack; <pr> is
                                                         owner/repo#n, a PR URL or a number in the board's repo, --to
                                                         the reviewer's name or Slack user
  slack task <eventId> <file> --title <t>            a request for work in that thread: a new task in item file
         (--notes <md> | --notes-from <draft.md>)       <file>, filed discussing for the owner's review, never ready;
                                                         the Slack message is its first thread line, by its writer;
                                                         ends the orchestrator's wait on the message
  integrations                                          readiness rows as one JSON line
  review due                                            one JSON line of the Slack sends the hub owes, from local state
                                                         and data/pr-slack.json: {date, links: [{pr, key, reviewer,
                                                         slack_user, text, attachments}], reactions: [{pr, reviewer, reply?,
                                                         channel, ts, emoji}], digest: review digest's answer while
                                                         due, else null}. links: each open, non-draft PR's link to
                                                         each reviewer without one, in the reviewer's thread for
                                                         date; no other message about a PR is owed. reactions:
                                                         git_approved once anyone approved, git_merged on merge, x
                                                         on close, on every posted link and reply. The hub sends
                                                         and records each. While Slack isn't ready: {waiting} and
                                                         nothing owed
  review post <pr> --file <review.md>                   posts the session's words as one Comment review (never an
          --read-at <time>                               approval or a request for changes) on an incoming PR at
                                                         its listed head, as the board's github-login (else gh's
                                                         account), under "🤖 Claude review from the <board title>
                                                         board" and the <!-- claude-bridge --> marker, and records
                                                         it posted with the review's link. Refuses words that carry
                                                         the header or marker, and a PR that got
                                                         another review after that time. The PR must be one the hub
                                                         listed in data/incoming.json or reviewed before
  review record <pr> --state posted|needs               the session's review of an incoming PR that was not posted
         --text <markdown> | --file <path>               through review post, in data/reviews.json: posted for a PR
                                                         it chose to say nothing on, needs while it waits on the
                                                         owner, which puts it in Needs you and pushes. Same PRs as
                                                         review post
  review digest                                         pending reviews as JSON, one item per PR; a reviewer is
                                                         owed the day's digest from 09:00 on a weekday in the Slack
                                                         identity timezone, or any day a link to them is owed with
                                                         no thread open, until data/review-digests.json has it all
  rules list                                             the hub rules, then with --site the board's, one
                                                         "<hub|board> <id> <owner|claude> <text>" line each
  rules add --text <t> [--hub] [--by claude]             a rule in board.json, or with --hub in the hub's
                                                         settings.json for every board; prints its id.
                                                         --by claude when you codify one on the owner's word
  rules edit <id> --text <t> [--hub]                     rewords a rule, keeping who added it
  rules remove <id> [--hub]                              refuses an id the list doesn't have
  settings                                               the board's settings as JSON; flags default off, optional
                                                         settings appear when set: {"auto_merge": false,
                                                         "auto_build": false,
                                                         "max_implementers": 5,
                                                         "max_serves": 10,
                                                         "auto_review": false, "idle_notification": false,
                                                         "skip_draft": false, "prs": true,
                                                         "github_login": "owner"}
  description                                            the board's description as JSON, from the hub's manifest,
                                                         which the router routes requests by: {"description",
                                                         "source": "new-board"|"triage"|"settings"|"", "at",
                                                         "checked", "proposal"}: checked is when a triage last
                                                         judged it, proposal the open proposal's task, else null.
                                                         item add of "chore(board): update /<route>'s description"
                                                         records that task as the proposal and is refused while
                                                         one is open; it ends when its task closes. An overnight
                                                         triage judges it when it is empty or neither set nor
                                                         checked in 7 days
  description checked                                    records that a triage judged the description still right
  description set <text>                                 writes the description an overnight triage proposed, at
                                                         most 240 characters, as from triage. Only on the owner's
                                                         Use this on the proposal's question, or their note's words
  settings set auto-merge on|off                        on: the hub's tick merges an approved PR once CI is green and
                                                         the merge state is CLEAN. off (the default): the task
                                                         shows the owner a Merge button, and the board server merges
                                                         when it is tapped. Board Settings' toggle writes it too
  settings set skip-draft on|off                         on: the hub's poll marks a task's draft PR ready for
                                                         review once its CI passes. off (the default): the draft
                                                         waits in In Review on the owner's review and Ready
  settings set prs on|off                                on (the default): a board on GitHub opens a PR for each
                                                         task. off: no PR; the task lands on main and main is
                                                         pushed, which needs Push main after a land granted.
                                                         A local board never opens PRs. Without auto-merge, a
                                                         task with no PR waits in In Review for the owner's Merge
  build <file>/<id> --site <route>                       asks the hub to run this task's build script; prints
         --asked "<owner's words>"                       started and exits. install is an alias. Only the owner's
                                                         Serve / Build and Auto-build start a task run, so --asked
                                                         must quote the owner's ask, task message or answer note on
                                                         this board that asked for it; the words go in a thread
                                                         line on the task. The hub records data/try/<id>.log and
                                                         writes failures to the thread. Web Visit opens
                                                         https://<host>:<try port>/ at its root
  main set --install <url> [--install-sha <sha>]          publishes main's app install to data/main.json
  settings set github-login <login>                      the GitHub account Claude posts as on this board. Its
                                                         comments carrying <!-- claude-bridge --> are Claude’s own
                                                         and dropped; its other comments are the owner’s. Unset,
                                                         the hub asks gh api user. Pass "" to clear it
  settings set auto-build on|off                         on: each push builds its task. Off by default.
                                                         Main builds after every merge either way
  settings set build-target <target>|default            the script the hub runs for each task and main:
                                                         .kickflip/build-<target>, or .kickflip/build with
                                                         default (unset). Board Settings' Build target picks it
  settings set claude-model hub|opus|auto|sonnet         Board Settings' Builders: the Claude model builds on this
                                                         board take, overriding Hub settings' Builders. hub (the
                                                         default) follows the hub. Only on the owner's word
  settings set max-implementers <1..99>                  Maximum tasks in progress, 5 by default: the tasks
                                                         In Progress the pull fills up to, each counting until it
                                                         lands, whatever it waits on. A tap or a bump waits for a
                                                         slot too.
                                                         Only on the owner's word
  settings set max-land-tests <1..99>                    Land test runs at once on the host, 1 by default: a land
                                                         whose tests are waiting for a turn reads "Waiting to test"
  settings set auto-review on|off                       on: while the board is idle and nothing is pulled, the board
                                                         server sends pr-review {pr, head, repo, title, author, url,
                                                         touches, asked} for one incoming PR at a time that touches
                                                         this board's tasks or asks the owner for review. Off by
                                                         default. Only on the owner's word
  settings set tickets <json>                            the board's ticket source, as Board Settings' Tickets row
                                                         saves it: {"source":"internal","prefix":"OPS"},
                                                         {"source":"github","account":"<gh login>"} or
                                                         {"source":"linear","workspace","team","project"}. A
                                                         GitHub account runs the board's issue calls as that gh
                                                         login; without one they run as gh's active account
  builder start <file>/<id> [--agent <name>] [--kind <claude|codex|prototype|grill|install|…>] [--label <who>]
         [--model <opus|sonnet>]                         the Claude model running the builder, recorded and printed as
                                                         "model: Claude Sonnet" (kind claude takes builder pick's model;
                                                         codex prints "model: Codex"). The thread's agent line reads it: "Claude
                                                         Sonnet builder started"; the label carries no model word. A
                                                         build refuses the model the hub's Claude model rules out.
                                                         A prototype defaults to sonnet and a grill to opus:
                                                         "Claude Sonnet prototype started"
         [--phase <phase> --progress <detail>]           one record per agent on the item; --agent defaults to main.
         [--eta <ISO time>]                              --phase and --progress take what builder progress takes.
                                                         --kind install: a build of the task's install, whose
                                                         Install badge reads Building… meanwhile. --kind claude or
                                                         codex refuses the one builder pick rules out; --kind build
                                                         records the pick's kind and prints "kind: <kind>. <reason>";
                                                         on the open record a Build tap started or --dispatch
                                                         opened, it keeps that record's kind and worktree.
         [--dispatch]                                    --dispatch: the session runs this right before it launches
                                                         an agent of any kind (build, prototype, grill) so the record
                                                         is open at launch and the task reads starting; the agent's
                                                         own builder start takes it up. On a record the Build tap
                                                         opened it changes nothing and prints "already open". The
                                                         record keeps dispatched: tap or session, whoever opened it.
                                                         --agent <other name> refuses while the tap's main record
                                                         is open and not taken up.
                                                         A build's start clears the task's Next.
                                                         A build (--kind build, claude or codex) on a task not done
                                                         and not In Progress moves it to In Progress first,
                                                         refusing what item set's build start refuses;
                                                         Prints "ref: <ref>", the task's label, which commits name in a "Refs: <ref>" trailer.
                                                         Resolves the task's answered questions, noting "Acted on:
                                                         builder started"
         [--worktree [--repo <dir>]]                     --worktree: a git worktree for the builder at
                                                         ~/.claude/kickflip/worktrees/<id> on a new branch <id> from
                                                         the board's branch of its clone (--repo overrides the clone), kept on
                                                         the record and printed as "worktree: <path>". Refuses when
                                                         that path or branch exists, unless it is a leftover
                                                         holding no work, which it remakes. A build's main record
                                                         on a board makes it without --worktree when it keeps none
                                                         (a taken-up or resumed record's, or the worktree the
                                                         task's last record left while it is still there)
  builder progress <file>/<id> --phase <phase>           one status log line: a phase, reading, building, checking or
         (<detail> | --text <d>) [--agent <name>]        landing, and a present-tense detail of at most
                                                         80 characters in plain words, which the owner reads at a
                                                         glance; a longer detail is refused with its length. Hashes,
                                                         test counts and file names go in the hand-back. The thread
                                                         line reads "Building: <detail>", "Codex building: <detail>"
                                                         for another agent, and the task "Building · <detail>"
         [--eta <ISO time> | --clear-eta]                an ETA shows as a line under the task's live status
         A progress line, --progress included, needs --site: it is a status log line in the item's thread, and
         the task's live status shows the newest one from an agent still working. builder progress refuses
         without an open record for that agent, as builder call does
  builder done <file>/<id> [--agent <name>]              marks that agent's record done; the item's thread
         [--next <t>] [--text <what you checked>]        shows when it started and finished. On a
                                                         record with unverified judgment calls it hands the task
                                                         back: its records close marked handed back, with Next "Answer the builder's
                                                         questions" when a call starts "Question:", else "Verify
                                                         the builder's judgment calls"; --next is refused there.
                                                         Else, on a board, the main build's record that keeps a
                                                         worktree finishes the task, as land does, --text its
                                                         closing line: lands it, closes the task and its ticket
                                                         and, with the board's "Push main after a land" on, pushes
                                                         the branch to origin; on a GitHub board it pushes the
                                                         task's branch, opens a draft PR and moves the task to it,
                                                         and on a plain git remote pushes the branch for the
                                                         owner's merge (item set --pushed). A finish that fails
                                                         refuses with the reason and leaves the record open; one
                                                         refused while another agent's record is open names it.
                                                         Any done of a record that keeps a worktree refuses while
                                                         a process it started since the build began runs
                                                         detached there (parent pid 1), naming each to stop.
                                                         A helper's done takes --text, its hand-back, which agent
                                                         wait prints. A grill's or prototype's done takes
                                                         no --text. No done posts a line to the thread.
                                                         --next stops a build without finishing it. Closing the
                                                         last record of a task left In Progress with no Next is
                                                         refused without --next, which sets it
         [--risk low|medium|high]                        the builder's judgment of its change's risk, kept on the
                                                         task: its PR's Slack link takes a green, orange or red bar
                                                         and the word, and its card a chip; none reads grey. Any
                                                         other word is refused before anything else happens
         [--summary <t>]                                 what the build built, in a few plain sentences: what
                                                         changed for the owner and what was left out. The done
                                                         that ends a build (the main record, not a lander's,
                                                         rebase run's, planner's or install's, handing back its
                                                         calls or finishing its worktree; no --next) refuses
                                                         without it; its record keeps it, and the thread shows it
                                                         as the Builder's message above its judgment calls. Any
                                                         other done refuses it
         [--owner-step <t>]                              a step only the owner can do once the code lands: the task
                                                         then waits in In Review with it as its Next, its ticket
                                                         open, until the owner's Done; refused on a task already
                                                         done. land takes it too
         [--check "<name> <args>"]                       with --owner-step: a read-only check on the step's final
                                                         evidence, which the hub's poll runs on each check once the
                                                         code lands, closing the task when it passes: tag
                                                         <owner/repo> <pattern>, npm <package> <version-or-range>,
                                                         run <owner/repo> <workflow> (a successful run since it was
                                                         attached), gh <owner/repo> <api-path> <field>=<value>, or
                                                         url <address> [<status> | <text>]. An unknown check or bad
                                                         arguments are refused. Three runs in a row that can't run
                                                         mark it broken and append owner-check-broken {key, check,
                                                         error}; fix it with item set --check. land takes it too
         [--title "<type>(<scope>): <summary>"]          the draft PR's title on a GitHub board, else the subject
                                                         of the one commit land squashes the branch into, a
                                                         Conventional subject of at most 100 characters (else the
                                                         branch's first commit subject); refused in any other
                                                         shape before anything is pushed or squashed. builder
                                                         verified takes it too
         builder takes --dir <dir> for an item file in <dir>; its records go in <dir>/agents
  builder stop <file>/<id>                               the orchestrator's stop of the task's run the board launched,
                                                         its headless builder, lander or rebase run, with every process
                                                         under it: the record stays open, marked stopped, so the server
                                                         relaunches nothing and the task stays In Progress reading
                                                         "build stopped by orchestrator" ("land …" while it lands),
                                                         waiting on the orchestrator; the same words go in its thread.
                                                         Prints what it stopped, one process a line. Refuses a planner,
                                                         a builder a session started itself, or none running
  item stall <file>/<id> --reason "<why>"                the orchestrator's flag on a stale task it can't restart: the
                                                         task stays in its lane reading red "stalled", an Action needed
                                                         "stalled: <why>" with one push, waiting on nobody else; its
                                                         run stops as builder stop stops it (nothing to stop when it
                                                         is gone), its record stays open and stopped and its worktree
                                                         stays, and it keeps its implementer slot. Its thread reads
                                                         "stalled by orchestrator: <why>". A message on the task
                                                         clears it
  land stop <file>/<id>                                  the orchestrator's stop of the task's land and its suite: one a
                                                         headless builder or lander runs stops that agent as builder
                                                         stop does; the land a held task's Merge tap started stops
                                                         alone, leaving the land queue, and the task's Merge shows
                                                         again, reading "land stopped by orchestrator". Refuses while
                                                         the land fast-forwards main, or a land in a session the board
                                                         didn't launch
  land queue                                             the host's land queue in order: the land running, then each
                                                         waiting, "(bumped)" on one a bump moved
  test [--dir <dir>] [--base <branch>]                   runs only the test files the change in the worktree at --dir
                                                         (else the current folder) adds or edits since its merge base
                                                         with --base (else main): in its commits, uncommitted edits
                                                         and untracked files; the land runs the tests the change
                                                         affects. Says how many it runs, or that there are none, and
                                                         passes; fails naming each failing test and
                                                         saving the TAP output under ~/.claude/kickflip/logs. With
                                                         --site, for the task whose open build keeps that worktree, it
                                                         writes the task's live status: its start and result in the
                                                         status log, its progress every 2 minutes on the live status only
  item bump <file>/<id>                                  the task's bump, as the owner's bump icon sends it (card-bump;
  item unbump <file>/<id>                                card-unbump). A bumped task's land goes ahead in the land queue
                                                         of every land not bumped since, the latest bump first, without
                                                         stopping the one running; a bump of a queued land says so in
                                                         its thread ("land moved first by orchestrator")
  lander <file>/<id>                                     restart a task's land, as after its lander faulted: an open
                                                         record closes as handed back, the server forgets the task's
                                                         lander, and its next pass launches one with its relaunch to
                                                         spend again; refused with no open record and no lander
  builder pick <file>/<id>                               who builds the task, from the hub's Codex share and the pause
                                                         line, and for claude which model, from the hub's Claude model
                                                         and the task's --size and --model: "codex: <reason>" or
                                                         "claude sonnet: <reason>". Pass that kind to builder start
                                                         --kind, and launch that model
  audit [<file>/<id>]                                    the board's audit log of the last 30 days, data/audit.jsonl:
                                                         each call the code made on its own (builder-pick, pull,
                                                         round-planner, launch-held, relaunch,
                                                         lander, triage, pr-review, push, pick-up, auto-merge,
                                                         ready-draft, session-resume, compact) as "<at> <call>
                                                         [<key>]: <result>. <reason>" and the inputs it read; with
                                                         a task, only that task's. The hub's own: kickflip audit
  agent launch <file>/<id> --name <n> --task <t>         any session's helper on an open task, an agent the board server
         [--writes] [--model <opus|sonnet>]              launches headless with the task as its brief, under its own
                                                         name (lowercase, "-", not main, visual-… or reviewer-…), its record
                                                         <id>@<name> requested until then. It launches at once,
                                                         on its task's implementer slot; one with --writes works
                                                         in its own worktree, branch <id>-<name> from the
                                                         task's, so it needs the task's worktree. --model else
                                                         builder pick's Claude model. Its lines carry its name
  agent wait <file>/<id> --name <n> [--agent <me>]       blocks until the helper's builder done, then prints its
         [--timeout <minutes>]                           --text and, for one that writes, its branch. Refuses
                                                         after --timeout (9) minutes, saying whether it runs or waits
                                                         to launch, and once its process is gone without done
  agent merge <file>/<id> --name <n>                     merges a done helper's branch into the task's worktree and
                                                         removes the helper's worktree and branch; on a conflict it
                                                         names the files: resolve, commit and run it again
  builder call <file>/<id> <judgment call>             appends one line to the agent's open builder record: a
         [--agent <name>]                                judgment call as the builder makes it, or a "Question: …"
                                                         for the session; refused with no open record. A builder start
                                                         on a record with unverified calls resumes that build, keeping
                                                         its calls and worktree. The thread shows them, collapsed
  builder calls <file>/<id> [--agent <name>]             prints the record's calls, numbered, then "verified <time>"
                                                         or "not verified yet"
  builder ask <file>/<id> <question> [--agent <name>]    a running builder's one-line question for the board's session,
                                                         which it asks only when blocked (every way forward would likely
                                                         be wasted work), then waits with builder asks --wait: a thread
                                                         line named by its model ("Claude Opus builder"), never unread,
                                                         and a builder-ask {key, ask, agent, text} event. Prints its
                                                         id, ask<n>. Needs --site and an open builder record
  builder answer <file>/<id> <ask> --text <t>            the session's answer to that ask, a thread line named
                                                         Orchestrator that leaves the task quiet
  builder defer <file>/<id> <ask> --text <t>             the session's deferral of an ask it can't answer confidently:
                                                         the same thread line, and a "Question: <ask> (deferred to the
                                                         owner)" call on the asking agent's record. After its review the
                                                         session puts it to the owner as a task question with
                                                         "ask": "<ask>"; builder verified refuses until then
  builder asks <file>/<id> [--wait] [--timeout <min>]    prints each ask, then its answer, its deferral or "waiting on
                                                         the orchestrator"; --wait blocks until none is waiting, and
                                                         after --timeout (9) minutes says so and fails: run it again.
                                                         News for the builder or a pause ends the wait early
  builder resume <file>/<id> --text <t>                  the session's words for the task's builder, In Progress.
                                                         To a running one they are news: its next command (progress,
                                                         call, ask, asks --wait), its tool-call hook or its builder
                                                         done's refusal prints "New on <key> while you build: …", and
                                                         the thread reads "Passed to the builder: <t>". On a handed-back
                                                         build the board server resumes the builder's own Claude
                                                         session with them and every news since its hand-back, the
                                                         card building again; its calls come back on its next
                                                         hand-back. The owner's thread message and item notes reach a
                                                         running builder as news by themselves
  builder verified <file>/<id> [--agent <name>]          the session's mark that it checked the record's calls; land
         [--note <t>] [--title <t>]                      refuses while any record on the task has a call after it.
                                                         On a handed-back build (not done, no builder open, every
                                                         call verified) it finishes the task in the same step, as
                                                         builder done does, --note its closing line (else "Judgment
                                                         calls verified."). While a question on the task is open it
                                                         says so and the task waits; a finish that fails keeps the
                                                         mark, the task handed back, and says why
  land <file>/<id> --text <t> [--repo <dir>]             brings the worktree its builder record keeps (else
         [--dir <dir>]
                                                         ~/.claude/kickflip/worktrees/<id> of --repo) into the board's
                                                         branch (the one its builders branch from, else main), one
                                                         line per step: refuses unless the repo has that branch
                                                         checked out, naming it, or while the worktree has uncommitted
                                                         changes or adds no commit; refuses a new ADR named with a
                                                         number instead of a timestamp; squashes the branch into one
                                                         commit, the first commit's subject (builder done's --title
                                                         in its place) and detail over Refs: <ref> and each
                                                         Co-Authored-By once, refusing a subject off the commit
                                                         standard or a "# Conflicts:" note, or commits that change
                                                         nothing; rebases that commit onto the branch when it
                                                         moved, refusing on a conflict with the rebase undone; refuses
                                                         unless the node --test files the change affects pass, as
                                                         test runs them, naming each failing
                                                         test and saving the TAP output under ~/.claude/kickflip/logs;
                                                         fast-forwards the branch in the repo; removes the worktree
                                                         and its branch. It restarts nothing: the hub restarts
                                                         what runs new code once idle. Without --site it never pushes. One land runs at a time on the host: a
                                                         second refuses, naming the task landing. With --site, --text <what was checked>
                                                         is required, and once it lands the task closes as item set
                                                         --done --text does; it refuses first what that close
                                                         would. With --site it is builder done's finish: the push
                                                         after a land, and on a GitHub or plain-remote board the
                                                         branch push (and draft PR) instead of the fast-forward.
                                                         --owner-step <t>, as builder done takes it, keeps the
                                                         landed task in In Review on that step until the owner's
                                                         Done, or until its --check passes. KICKFLIP_RESTART_CMD='["<cmd>"]' replaces
                                                         the restarts, called with hub or board <route>
  merge <file>/<id> [--after-approval "<why trivial>"]   merges the task's PRs (gh pr merge --squash) in its order and
         [--confirmed "<owner's words>"]                 records it merged, once GitHub reads every open one approved,
                                                         its checks green with none pending and its merge state CLEAN,
                                                         the test the Merge button uses; a merged or closed PR is left
                                                         as it is. Refuses, naming each reason ("pending: 2 checks"),
                                                         commits after the newest approval unless --after-approval
                                                         says why they're trivial (its closing line says so), and a
                                                         task with manual steps unless --confirmed quotes the owner.
                                                         A refusal also goes in the thread while the owner's Merge waits.
                                                         On a task with no PR waiting for the owner's Merge, which
                                                         the board server runs on the tap: rebases onto the base as
                                                         it is now, reruns the tests, fast-forwards, closes the task
                                                         and pushes when Push main is on; a conflict or failing
                                                         tests launch a headless lander that lands it
  arch file <file>/<id>                                  turns the architecture review audit task's answered findings
                                                         into tasks: titled with the picked option's label, its
                                                         detail, practice and the owner's note as notes, each a
                                                         Child of the audit task and after it, its question resolved
                                                         "Filed as <ref>."; a Skip pick resolves its question alone.
                                                         Prints "filed: <ref> from <id>", "skipped: <id>", and
                                                         "waiting: <ids>" while any are unanswered; once none is, it
                                                         closes the audit task as done
  push --kind fault|reminder --title <t>                 runs kickflip push with these flags, adding
       [--body <b>] [--url </route/path>]                "· and N replies" to the body for the replies
       [--tag <tag>] [--now | --urgent]                  written since the site's last push through this
                                                         command (none before its first). A session pushes only a
                                                         fault, what only the owner can fix, or a reminder the
                                                         owner asked for in words ("push me when it's all done"):
                                                         the board server pushes each task's Action needed and the
                                                         hub a session's prompt, so any other --kind is refused. It records the
                                                         push in data/push-state.json only when kickflip push
                                                         succeeds, and exits with kickflip push's code. Without --now
                                                         it queues until the hub's
                                                         next check; --now sends at once unless pushes are held
                                                         (overnight, snoozed or the weekend). --urgent: a
                                                         production fault only; it beats those holds. While
                                                         notifications are off every push is dropped, urgent too
         KICKFLIP_PUSH_CMD='["<cmd>","<arg>"]' replaces \`node ../../bin/kickflip.mjs push\`; the flags follow it`;

class UsageError extends Error {}
const BOOLEAN = new Set(['new-ticket', 'done', 'clear-status', 'clear-next', 'urgent', 'now', 'clear-eta', 'blocked', 'unblocked', 'idle', 'wait', 'hub', 'clear-install', 'force', 'worktree', 'dispatch', 'writes', 'implement', 'close', 'split']);
// → {flags: {<name>: [value, …] | true}, rest}; main keeps a list only for a flag its command repeats.
function parse(argv) {
  const flags = Object.create(null);
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const name = a.slice(2);
    if (BOOLEAN.has(name)) {
      if (Object.hasOwn(flags, name)) throw new UsageError(`--${name} is given twice`);
      flags[name] = true;
    } else if (i + 1 < argv.length) (flags[name] ||= []).push(argv[++i]);
    else throw new UsageError(`--${name} needs a value`);
  }
  return { flags, rest };
}

// docs/adr/2026-11-16-1700-a-filed-task-links-where-it-came-from-and-the-tasks-it-names.md: the link flags the task
// commands took before each was named for its row on the card.
const RENAMED_LINKS = { from: '--parent', 'split-of': '--parent <task> --split', after: '--blocked-by', before: '--blocks', deps: '--blocked-by' };
// A command's flags, each a value, or a list for a flag its allowed list names as ...<name>, which may repeat.
function flagsOf(name, allowed, flags) {
  const repeated = new Set(allowed.filter((a) => a.startsWith('...')).map((a) => a.slice(3)));
  const known = new Set(allowed.map((a) => a.replace(/^\.\.\./, '')));
  const unknown = Object.keys(flags).filter((k) => !known.has(k));
  const renamed = name.startsWith('item ') && unknown.find((k) => RENAMED_LINKS[k]);
  if (renamed) throw new UsageError(`--${renamed} is now ${RENAMED_LINKS[renamed]}, the name of its link on the card`);
  if (unknown.length) throw new UsageError(`${name} does not take ${unknown.map((k) => '--' + k).join(', ')}`);
  return Object.fromEntries(Object.entries(flags).map(([k, v]) => {
    if (v === true || repeated.has(k)) return [k, v];
    if (v.length > 1) throw new UsageError(`--${k} is given twice`);
    return [k, v[0]];
  }));
}

/*
 * Flags whose value is shown to the owner as written. A bare file path there is a slip that posts
 * the path itself (a reply once read "/private/tmp/…/exp-reply.html"), so it is refused: one
 * token that names an existing file, or that looks like a path to a document.
 */
const TEXT_FLAGS = ['text', 'note', 'notes', 'heading', 'summary', 'title', 'body', 'next', 'progress', 'install-label', 'confirmed', 'asked', 'task', 'reason'];
const DOC_PATH = /^(?:\/|~\/|\.{1,2}\/)\S*\.(?:html?|md|json|txt)$/;

function looksLikePath(value) {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  if (DOC_PATH.test(v)) return true;
  try { return fs.statSync(v).isFile(); } catch { return false; }
}

function checkInputs(allowed, opts) {
  for (const name of TEXT_FLAGS) {
    if (typeof opts[name] !== 'string' || !looksLikePath(opts[name])) continue;
    const hint = allowed.includes('file') ? `; for a file use --file ${opts[name].trim()}` : '';
    throw new UsageError(`--${name} takes text, not a file path (${opts[name].trim()})${hint}`);
  }
  if (typeof opts.file === 'string' && opts.file !== '-' && !fs.existsSync(opts.file)) {
    throw new UsageError(`--file ${opts.file}: no such file`);
  }
}

// The commands whose text reaches the owner, and the flags that hold it: they refuse a question's id (store.refuseQuestionIds).
const TO_OWNER = {
  thread: ['text'], reply: ['text'], 'item set': ['text'], 'item add': ['text'], 'item triage': ['text'],
  'builder answer': ['text'], push: ['title', 'body'],
};
const readInput = (file) => fs.readFileSync(file === '-' ? 0 : file, 'utf8');
const renderCheck = () => (process.env.KICKFLIP_RENDER_CHECK === 'off' ? undefined : checkTakesRender);

// docs/adr/2026-11-12-2330-a-reply-posts-its-questions-after-it-in-one-command.md: with --questions <json>, post()
// writes the message and the file's questions are added after it, so the thread reads message then questions. The
// file is checked before the message posts.
async function withQuestions(site, f, post) {
  if (f.questions === undefined) return post();
  if (f.implement || f.close) throw new store.BoardError('--questions asks open questions, so it takes no --implement or --close: the task is not waiting on that');
  const input = readJSONInput(f.questions);
  await store.checkQuestions(site, input, renderCheck());
  const posted = await post();
  const added = await store.addQuestions(site, input, renderCheck());
  return { ...posted, lines: [...(posted?.lines || []), ...(added.lines || [])], asked: [input].flat(), staged: added.staged };
}
function readJSONInput(file) {
  if (!file) throw new UsageError('--file <path> is required');
  try { return JSON.parse(readInput(file)); } catch (e) { throw new store.BoardError(`${file}: ${e.message}`); }
}

// docs/adr/2026-11-09-1100-the-board-owns-a-cards-notes-file.md: the board names a card's notes file, so neither
// item add nor item set takes one.
function refuseNotesFile(f, instead) {
  const flag = ['notes-file', 'plan'].find((name) => f[name] !== undefined);
  if (flag) throw new UsageError(`--${flag} is gone: the board names a task's notes file, <id>-notes.md, and writes it itself; ${instead}`);
}

function noteOf(f) {
  if (f.note !== undefined && f.file !== undefined) throw new UsageError('pass --note or --file, not both');
  return f.file === undefined ? f.note : readInput(f.file);
}

// name: [positional args, allowed flags (...<flag> may repeat, and run gets its values as a list), run(site, args, flags) → message]
async function builderDone(site, key, { 'owner-step': ownerStep, check, text, title, risk, summary, ...f }) {
  if (risk !== undefined && (!site || f.dir)) throw new UsageError('--risk goes on a board task: pass --site, not --dir');
  if (risk !== undefined) await store.setItem(site, key, { risk });
  if (ownerStep !== undefined && (!site || f.dir)) throw new UsageError('--owner-step goes on a board task: pass --site, not --dir');
  if (check !== undefined && ownerStep === undefined) throw new UsageError('--check goes with --owner-step: it is the code check that closes the task once the step is done');
  if (ownerStep !== undefined) await store.setItem(site, key, { ownerStep, check });
  const onBoard = site && !f.dir;
  if (onBoard && (f.agent ?? 'main') === 'main') await store.refuseNews(site, key);
  if (onBoard) await store.refuseDetached(site, key, f, detachedIn);
  if (summary !== undefined && !onBoard) throw new UsageError('--summary goes on a board task: pass --site, not --dir');
  if (onBoard) await store.recordSummary(site, key, summary, f);
  const handed = onBoard && await store.handBackCalls(site, key, f);
  if (handed) return handed;
  if (onBoard && f.next === undefined && await store.finishesCard(site, key, f)) {
    if (text === undefined) throw new store.BoardError(`builder done finishes ${key}: pass --text "<what you checked>", or --next "<what happens next>" to stop without finishing`);
    return finishCard(site, key, { text, ownerStep, title });
  }
  // docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md: a helper hands back its
  // result as its record's closing note, which agent wait prints.
  if (onBoard && await store.isHelper(site, key, f.agent)) {
    if (text === undefined) throw new UsageError(`a helper hands back its result: pass --text "<what you did or found>"`);
    return store.stopBuilder(site, key, { ...f, note: text });
  }
  if (onBoard && await store.isPlanner(site, key, f.agent)) {
    if (text !== undefined) throw new UsageError('a grill\'s or prototype\'s done takes no --text: what it asked is its posted questions and its notes section');
    return store.stopPlanner(site, key, { ...f, requireNext: true });
  }
  if (text !== undefined) throw new UsageError('--text goes on a builder done that finishes the task, the main build with a worktree and no --next, or on a helper\'s');
  return store.stopBuilder(site, key, { ...f, requireNext: true });
}

// The words each flag of item set adds to the line it prints; null for a flag that only shapes another (--text is the
// message of --from-ask or --done, --force goes with --done). Every flag item set takes is named here, so none is
// accepted and left unreported.
export const ITEM_SET_SAYS = {
  done: (f) => f.done && (f['split-into'] ? `done, split into ${f['split-into'].split(',').join(', ')}` : 'done'),
  'split-into': null,
  status: null, 'clear-status': null,
  next: (f) => (f.next.trim() ? 'next line set' : 'next line cleared'),
  'clear-next': () => 'next line cleared',
  pr: (f) => `PR #${f.pr}`,
  pushed: (f) => `pushed ${f.pushed}`,
  'gh-since': (f) => `GitHub read to ${f['gh-since']}`,
  'from-ask': (f) => `from task ${f['from-ask']}`,
  phase: (f) => f.phase,
  state: (f) => `state ${f.state}`,
  blocked: () => 'blocked',
  unblocked: () => 'unblocked',
  'pick-up-at': (f) => (f['pick-up-at'] ? `blocked until ${f['pick-up-at']}` : 'unblocked'),
  'notes-file': null, plan: null,
  'blocked-by': (f) => (f['blocked-by'] ? `blocked by ${f['blocked-by']}` : 'blocked by cleared'),
  'blocked-until': (f) => (f['blocked-until'] ? `blocked until ${f['blocked-until']}` : 'blocked until cleared'),
  'block-reason': (f) => (f['block-reason'] ? 'block reason set' : 'block reason cleared'),
  parent: (f) => (f.parent ? `parent ${f.parent}` : 'parent cleared'),
  related: (f) => (f.related ? `related to ${f.related.split(',').join(', ')}` : 'related cleared'),
  relate: (f) => `related to ${f.relate.split(',').join(', ')} added`,
  unrelate: (f) => `unrelated from ${f.unrelate.split(',').join(', ')}`,
  install: () => 'install published',
  'install-sha': null, 'install-label': null,
  'clear-install': () => 'install cleared',
  title: () => 'renamed',
  size: (f) => `size ${f.size}`,
  model: (f) => `model ${f.model}`,
  force: null,
  ticket: (f) => `ticket ${f.ticket}`,
  'new-ticket': () => 'ticket made',
  text: null,
  check: (f) => (f.check.trim() ? `check ${f.check.trim().split(/\s+/).join(' ')}` : 'check removed'),
  'reply-on': null,
};
export const ITEM_SET_FLAGS = ['done', 'split-into', 'status', 'clear-status', 'next', 'clear-next', '...pr', 'pushed', 'gh-since', 'from-ask', 'phase', 'state', 'blocked', 'unblocked', 'pick-up-at', 'notes-file', 'plan', 'blocked-by', 'blocked-until', 'block-reason', 'parent', 'related', 'relate', 'unrelate', 'install', 'install-sha', 'install-label', 'clear-install', 'title', 'size', 'model', 'force', 'ticket', 'new-ticket', 'text', 'check', 'reply-on'];
const unsaid = ITEM_SET_FLAGS.map((flag) => flag.replace('...', '')).filter((flag) => !(flag in ITEM_SET_SAYS));
if (unsaid.length) throw new Error(`item set takes ${unsaid.map((flag) => `--${flag}`).join(', ')} but ITEM_SET_SAYS does not name it`);
const COMMANDS = {
  pr: [['file/id'], [], async (site, [key]) => ({ lines: (await store.prReport(site, key)).map((r) => JSON.stringify(r)) })],
  'pr comment': [['pr'], ['body'], (site, [pr], f) => {
    if (f.body === undefined) throw new UsageError('pr comment needs --body "<what Claude says>"');
    return store.postPR(site, pr, { body: f.body });
  }],
  'pr reply': [['pr', 'comment-id'], ['body'], (site, [pr, replyTo], f) => {
    if (f.body === undefined) throw new UsageError('pr reply needs --body "<what Claude says>"');
    return store.postPR(site, pr, { replyTo, body: f.body });
  }],
  reply: [['eventId'], ['text', 'file', 'title', 'implement', 'close', 'questions'], async (site, [id], f) => {
    if ((f.text === undefined) === (f.file === undefined)) throw new UsageError('reply takes --text or --file');
    if ((f.implement || f.close) && !id.includes('/')) throw new UsageError('reply --implement and --close mark a task: name it <file>/<id>');
    if (f.implement && f.close) throw new UsageError('reply takes --implement or --close, not both');
    const md = f.text ?? readInput(f.file);
    if (f.file !== undefined) await store.refuseQuestionIds(site, [md]);
    store.refuseUnflaggedTap(md, f);
    await store.refuseUnborn(site, md);
    await store.refuseUnreadEdit(site, id);
    return withQuestions(site, f, () => (id.includes('/') ? store.answerCard(site, id, md, f.title, { waitsOn: f.implement ? 'implement' : f.close ? 'close' : undefined }) : store.writeReply(site, id, md, f.title)));
  }],
  thread: [['file/id'], ['text', 'link', 'who', 'via', 'close', 'implement', 'questions', 'script'], async (site, [key], f) => {
    if ((f.who ?? 'claude') === 'claude' && f.via === undefined) {
      store.refuseUnflaggedTap(f.text, f);
      await store.refuseUnborn(site, f.text);
    }
    return withQuestions(site, f, () => store.appendMessage(site, key, f));
  }],
  'visual add': [['file/id'], ['file', 'title'], (site, [key], f) => store.addVisual(site, key, f)],
  'reviewer post': [['file/id'], ['file'], (site, [key], f) => store.postFindings(site, key, f)],
  'item brief': [['file/id'], ['kind', 'file'], (site, [key], f) => store.writeBrief(site, key, f)],
  'topic add': [['id'], ['title', 'summary'], (site, [id], f) => store.addTopic(site, { id, ...f })],
  'question add': [[], ['file'], async (site, _, f) => {
    const input = readJSONInput(f.file);
    await store.refuseInIntake(site, itemTopics(input));
    return { ...(await store.addQuestions(site, input, renderCheck())), asked: [input].flat() };
  }],
  'question resolve': [['id'], ['note', 'close', 'implement'], (site, [id], f) => {
    if (f.implement && f.close) throw new UsageError('question resolve takes --implement or --close, not both');
    return store.resolveQuestion(site, id, f.note, { waitsOn: f.implement ? 'implement' : f.close ? 'close' : undefined });
  }],
  'question settle': [['id'], ['note'], (site, [id], f) => store.settleQuestion(site, id, f.note)],
  'question publish': [['key'], [], async (site, [key]) => ({ ids: await store.publishScreened(site, key) })],
  'question move': [['ids'], ['to', 'block'], (site, [ids], f) => store.moveQuestions(site, ids.split(',').filter(Boolean), f.to, (f.block || '').split(',').filter(Boolean))],
  'prototype add': [['topic'], ['title', '...take', 'card', 'served', '...state'], (site, [topic], f) => store.addPrototype(site, { topic, title: f.title, card: f.card, takes: f.take, served: f.served, states: f.state })],
  'prototype base': [[], [], (site) => prototypeBase(site)],
  'prototype list': [[], [], (site) => store.listPrototypes(site)],
  'prototype rm': [['topic'], [], (site, [topic]) => store.removePrototype(site, topic)],
  'item set': [['file/id'], ITEM_SET_FLAGS, async (site, [key], f, options) => {
    refuseNotesFile(f, `add to its notes with item notes ${key} --heading "<heading>" --file <draft.md>`);
    await store.refuseUnborn(site, f.text);
    if (f.done && site) await store.checkNotReopened(site, key);
    if (site && [f.phase, f.title, f.ticket, f['new-ticket']].some((v) => v !== undefined)) await store.refuseUnreadEdit(site, key);
    return store.setItem(site, key, { done: f.done, finishAsk: true, splitInto: f['split-into'], status: f.status, clearStatus: f['clear-status'], next: f.next, clearNext: f['clear-next'], pr: f.pr, pushed: f.pushed, ghSince: f['gh-since'], fromAsk: f['from-ask'], phase: f.phase, state: f.state, block: f.blocked, unblock: f.unblocked, pickUpAt: f['pick-up-at'], deps: f['blocked-by'], blockedUntil: f['blocked-until'], blockReason: f['block-reason'], parent: f.parent, related: f.related, relate: f.relate, unrelate: f.unrelate,
      install: f.install, installSha: f['install-sha'], installLabel: f['install-label'], clearInstall: f['clear-install'], title: f.title, size: f.size, model: f.model, force: f.force, ticket: f.ticket, newTicket: f['new-ticket'], text: f.text, check: f.check, replyOn: f['reply-on'] }, options);
  }],
  'item add': [['file[/id]'], ['title', 'notes', 'notes-from', 'blocks', 'blocked-by', 'notes-file', 'plan', 'ticket', 'new-ticket', 'pick-up-at', 'blocked', 'parent', 'split', 'size', 'model', 'phase', 'state', 'relate', 'from-ask', 'text', 'ask', 'by', 'reply-on'], async (site, [key], f, options) => {
    refuseNotesFile(f, 'seed a new task\'s notes with item add --notes-from <draft.md>');
    await store.refuseUnborn(site, f.text);
    // docs/adr/2026-11-16-1100-a-task-the-orchestrator-files-comes-in-as-an-ask-through-new.md
    if (f.ask !== undefined) {
      const decided = ['title', 'notes', 'notes-from', 'phase', 'state', 'size', 'model', 'ticket', 'new-ticket', 'pick-up-at', 'blocked', 'from-ask', 'text'].find((k) => f[k] !== undefined);
      if (decided) throw new UsageError(`--ask files the orchestrator's request as an ask; triage titles, notes and sorts it, so drop --${decided}`);
      return store.askItem(needSite(site, 'item add --ask'), key, { text: f.ask, parent: f.parent, split: f.split, relate: f.relate, deps: f['blocked-by'], before: f.blocks, by: f.by, replyOn: f['reply-on'] }, options);
    }
    if (f.by !== undefined) throw new UsageError('--by names who asked, with --ask');
    if (f.phase === 'discussing' && f.text === undefined && f['from-ask'] === undefined) throw new UsageError('item add --phase discussing needs --text "<first message>": the task opens with it, after Created from, and reads the owner\'s turn');
    if (f.notes !== undefined && f['notes-from'] !== undefined) throw new UsageError('pass --notes or --notes-from, not both');
    return store.addItem(site, key, { title: f.title, notes: f.notes, notesFrom: f['notes-from'], before: f.blocks, deps: f['blocked-by'], ticket: f.ticket, newTicket: f['new-ticket'], pickUpAt: f['pick-up-at'], block: f.blocked, parent: f.parent, split: f.split, size: f.size, model: f.model, phase: f.phase, state: f.state, relate: f.relate, fromAsk: f['from-ask'], text: f.text, intake: true, filed: Boolean(site), replyOn: f['reply-on'] }, options);
  }],
  'item notes': [['file/id'], ['heading', 'file', 'from'], (site, [key], f) => {
    if (f.heading === undefined && f.from === undefined) throw new UsageError('item notes needs --heading "<the section\'s title>"');
    if ((f.file === undefined) === (f.from === undefined)) throw new UsageError('item notes takes --file <draft.md> or --from <file>/<id>');
    return store.addNotes(site, key, f);
  }],
  // docs/adr/2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md
  'item triage': [['file/id'], ['title', 'phase', 'relate', 'parent', 'split', 'blocked-by', 'ticket', 'text', 'fold-into', 'reply-on'], async (site, [key], f, options) => {
    await store.refuseUnreadEdit(needSite(site, 'item triage'), key);
    await store.refuseUnborn(site, f.text);
    return store.triageItem(site, key, { title: f.title, phase: f.phase, relate: f.relate, parent: f.parent, split: f.split, deps: f['blocked-by'], ticket: f.ticket, text: f.text, foldInto: f['fold-into'], replyOn: f['reply-on'] }, options);
  }],
  'item relate-ask': [['eventId', 'file/id'], ['summary'], async (site, [id, key], f) => {
    await store.refuseUnreadEdit(site, id);
    return store.relateAsk(site, id, key, f.summary);
  }],
  'ask unfold': [['eventId'], [], (site, [id]) => store.unfoldAsk(site, id)],
  'ask move': [['eventId'], ['to'], (site, [id], f) => store.moveAsk(site, id, f.to)],
  // docs/adr/2026-11-15-0200-a-board-asks-another-board-and-its-orchestrator-answers.md
  ask: [['route', '...question'], ['from'], (site, [route, ...words], f) => store.askBoard(needSite(site, 'ask'), route, words.join(' '), { from: f.from })],
  asks: [[], ['wait', 'timeout'], (site, _, f) => store.listBoardAsks(needSite(site, 'asks'), f)],
  // docs/adr/2026-11-16-1400-orchestrator-waits-keep-a-history-and-waits-history-audits-it.md
  'waits history': [[], ['since', 'kind'], async (site, _, f) => {
    // A bare date is the host's local midnight.
    const from = f.since === undefined ? null : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(f.since) ? `${f.since}T00:00` : f.since);
    if (Number.isNaN(from)) throw new UsageError(`waits history --since takes a date or an ISO time, not "${f.since}"`);
    const data = path.join(needSite(site, 'waits history'), 'data');
    const log = await store.readLog(path.join(data, 'events.jsonl'));
    const open = (await store.readJSON(path.join(data, 'orchestrator-waits.json'), {})).waits || [];
    return { lines: waitsHistoryLines(waitsHistory(log, { from, kind: f.kind ?? null, open, now: new Date() })) };
  }],
  answer: [['askId'], ['text'], (site, [id], f) => store.answerBoardAsk(needSite(site, 'answer'), id, f.text)],
  handoff: [['file/id|eventId'], ['to', 'note', 'done'], async (site, [ref], f) => {
    if (f.done && site && ref.includes('/')) await store.checkNotReopened(site, ref);
    return store.handoff(site, ref, { to: f.to, note: f.note, done: f.done });
  }],
  slack: [[], [], () => ({ lines: [JSON.stringify(readSlack())] })],
  'slack set': [[], ['self-dm', 'user', 'domain', 'timezone'], async (site, _, f) => {
    const fields = { 'self-dm': 'self_dm', user: 'owner_slack_user', domain: 'slack_domain', timezone: 'timezone' };
    try { return { lines: [JSON.stringify(await setSlack(Object.fromEntries(Object.entries(f).map(([k, v]) => [fields[k], v]))))] }; }
    catch (e) { throw new store.BoardError(e.message); }
  }],
  'slack thread': [['eventId'], [], (site, [id]) => store.slackThread(needSite(site, 'slack thread'), id)],
  'slack answer': [['eventId'], ['text'], (site, [id], f) => store.slackAnswer(needSite(site, 'slack answer'), id, f.text)],
  'slack skip': [['eventId'], [], (site, [id]) => store.slackSkip(needSite(site, 'slack skip'), id)],
  'slack say': [['reviewer'], ['text'], (site, [name], f) => store.slackSay(needSite(site, 'slack say'), name, f.text)],
  'slack link': [['pr'], ['to'], (site, [pr], f) => {
    if (f.to === undefined) throw new UsageError('slack link needs --to <reviewer>');
    return store.slackLink(needSite(site, 'slack link'), pr, f.to);
  }],
  'slack task': [['eventId', 'file'], ['title', 'notes', 'notes-from'], (site, [id, file], f) => {
    if (f.notes !== undefined && f['notes-from'] !== undefined) throw new UsageError('pass --notes or --notes-from, not both');
    return store.slackTask(needSite(site, 'slack task'), id, file, { title: f.title, notes: f.notes, notesFrom: f['notes-from'] });
  }],
  integrations: [[], [], async () => ({ lines: [JSON.stringify(await readiness.rows())] })],
  'review record': [['pr'], ['state', 'text', 'file'], (site, [pr], f) => {
    if ((f.text === undefined) === (f.file === undefined)) throw new UsageError('review record takes --text or --file');
    return store.recordReview(site, pr, { state: f.state, text: f.text ?? readInput(f.file) });
  }],
  'review post': [['pr'], ['file', 'read-at'], (site, [pr], f) => {
    if (f.file === undefined) throw new UsageError('review post needs --file <review.md>');
    if (f['read-at'] === undefined) throw new UsageError('review post needs --read-at <time>, when you read the PR, so a review that landed since is caught');
    return store.postIncomingReview(site, pr, { words: readInput(f.file), readAt: f['read-at'] });
  }],
  'review digest': [[], [], async (site, _, f, options) => ({ lines: [JSON.stringify(await store.reviewDigest(site, options))] })],
  'review due': [[], [], async (site, _, f, options) => ({ lines: [JSON.stringify(await store.reviewDue(site, options))] })],
  'reviewers set': [[], ['file'], (site, _, f) => store.setReviewers(site, readJSONInput(f.file))],
  'reviewers add': [[], ['file'], (site, _, f) => store.addReviewers(site, readJSONInput(f.file))],
  'reviewers remove': [['...name'], [], (site, names) => store.removeReviewers(site, names)],
  'rules list': [[], [], (site) => store.listRules(site)],
  'rules add': [[], ['text', 'hub', 'by'], (site, _, f) => store.addRuleTo(site, f)],
  'rules edit': [['id'], ['text', 'hub'], (site, [id], f) => store.editRuleIn(site, id, f)],
  'rules remove': [['id'], ['hub'], (site, [id], f) => store.removeRuleFrom(site, id, f)],
  settings: [[], [], async (site) => ({ lines: [JSON.stringify(await store.readBoardSettings(site))] })],
  description: [[], [], async (site) => ({ lines: [JSON.stringify(await store.describeBoard(needSite(site, 'description')))] })],
  'description checked': [[], [], async (site) => ({ lines: [JSON.stringify(await store.checkedDescription(needSite(site, 'description checked')))] })],
  'description set': [['text'], [], async (site, [text]) => ({ lines: [JSON.stringify(await store.saveBoardDescription(needSite(site, 'description set'), text, 'triage'))] })],
  build: [['file/id'], ['asked'], async (site, [key], f) => {
    if (!site) throw new store.BoardError('build needs --site <route>');
    store.parseKey(key);
    const line = await store.askedGate(site, key, f.asked);
    try {
      const r = await fetch(`http://127.0.0.1:${process.env.KICKFLIP_HUB_PORT || 4500}/_hub/build`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ route: path.basename(site), key }), signal: AbortSignal.timeout(10_000),
      });
      const out = await r.json();
      if (!r.ok) throw new store.BoardError(out.error || 'The hub refused the build.');
      return { lines: ['started', ...(await store.appendMessage(site, key, { text: line })).lines] };
    } catch (e) {
      if (e instanceof store.BoardError) throw e;
      throw new store.BoardError(`Could not start the build: ${e.message}`);
    }
  }],
  'main set': [[], ['install', 'install-sha'], (site, _, f) => store.setMainInstall(site, { install: f.install, installSha: f['install-sha'] })],
  'settings set': [['name', 'value'], [], (site, [name, value]) => store.setBoardSetting(site, name, value)],
  'builder start': [['file/id'], ['label', 'phase', 'progress', 'dir', 'agent', 'kind', 'model', 'eta', 'worktree', 'repo', 'dispatch'], (site, [key], { worktree, repo, dispatch, ...f }) => {
    if (repo !== undefined && !worktree) throw new UsageError('--repo goes with --worktree');
    const make = (opts) => boardWorktree(site, key.split('/')[1], { repo, ...opts });
    // A build on a board works in its own worktree even when the start doesn't ask for one (store.mjs startBuilder).
    const onBoard = site && f.dir === undefined && boardAt(site);
    return store.startBuilder(site, key, { ...f, dispatch: dispatch ? 'session' : undefined, worktree: worktree ? make : undefined, ownWorktree: onBoard ? make : undefined });
  }],
  'builder progress': [['file/id', '...text?'], ['phase', 'text', 'dir', 'agent', 'eta', 'clear-eta'], (site, [key, ...words], f) => {
    if (words.length && f.text !== undefined) throw new UsageError('builder progress takes its text once: as words or as --text');
    if (!words.length && f.text === undefined) throw new UsageError('builder progress needs its text, as words or as --text');
    return store.builderProgress(site, key, f.text ?? words.join(' '), { ...f, clearEta: f['clear-eta'] });
  }],
  'builder done': [['file/id'], ['dir', 'agent', 'next', 'owner-step', 'check', 'text', 'title', 'risk', 'summary'], (site, [key], f) => builderDone(site, key, f)],
  'builder pick': [['file/id'], [], (site, [key]) => store.pickBuilder(site, key)],
  'agent launch': [['file/id'], ['name', 'task', 'writes', 'model'], (site, [key], f) => store.requestHelper(site, key, f)],
  'agent wait': [['file/id'], ['name', 'agent', 'timeout'], (site, [key], f) => store.waitHelper(site, key, { ...f, alive: pidAlive })],
  'agent merge': [['file/id'], ['name'], async (site, [key], f) => {
    const { record, card: tree } = await store.helperOf(site, key, f.name);
    if (!record.done) throw new store.BoardError(`helper ${f.name} is still open; run agent wait ${key} --name ${f.name} first`);
    if (!record.writes || !record.worktree) throw new store.BoardError(`helper ${f.name} writes no code, so there is nothing to merge`);
    if (!tree) throw new store.BoardError(`${key} has no worktree to merge helper ${f.name} into`);
    return mergeHelper(tree, record.worktree, await store.cardName(site, key));
  }],
  audit: [['...file/id?'], [], (site, [key, ...more]) => {
    if (more.length) throw new UsageError('audit takes one <file/id> at most');
    return store.auditLog(site, key);
  }],
  'builder call': [['file/id', '...text'], ['dir', 'agent'], (site, [key, ...words], f) => store.recordCall(site, key, words.join(' '), f)],
  'builder calls': [['file/id'], ['dir', 'agent'], (site, [key], f) => store.listCalls(site, key, f)],
  'builder ask': [['file/id', '...text'], ['agent'], (site, [key, ...words], f) => store.askOrchestrator(site, key, words.join(' '), f)],
  'builder answer': [['file/id', 'ask'], ['text'], (site, [key, id], f) => store.answerBuilder(site, key, id, f.text)],
  'builder defer': [['file/id', 'ask'], ['text'], (site, [key, id], f) => store.answerBuilder(site, key, id, f.text, { deferred: true })],
  'builder asks': [['file/id'], ['wait', 'timeout'], (site, [key], f) => store.listAsks(site, key, f)],
  'builder resume': [['file/id'], ['text'], (site, [key], f) => store.builderResume(site, key, f.text)],
  'builder verified': [['file/id'], ['dir', 'agent', 'note', 'title'], async (site, [key], f) => {
    await store.verifyCalls(site, key, f);
    const next = site && !f.dir ? await store.verifiedFinish(site, key) : null;
    if (!next) return {};
    if (next.held) return { said: `${await store.cardName(site, key)} didn't land: ${next.held}` };
    if (next.waits.length) return { lines: [`${await store.cardName(site, key)} finishes once the owner answers ${next.waits.join(', ')}`] };
    try { return await finishCard(site, key, { text: f.note ?? 'Judgment calls verified.', title: f.title }); } catch (e) {
      if (!(e instanceof store.BoardError)) throw e;
      throw Object.assign(new store.BoardError(`judgment calls verified, but ${await store.cardName(site, key)} didn't finish: ${e.message}`), { exitCode: e.exitCode });
    }
  }],
  land: [['file/id'], ['repo', 'dir', 'text', 'owner-step', 'check'], async (site, [key], f) => {
    const id = key.split('/')[1];
    if (site && f.text === undefined) throw new UsageError(`land needs --text "<what was checked>", which closes ${key} as done once it lands`);
    if (!site && f.text !== undefined) throw new UsageError('--text closes the task, which needs --site');
    if (!site && f['owner-step'] !== undefined) throw new UsageError('--owner-step keeps a board task open, which needs --site');
    if (f.check !== undefined && f['owner-step'] === undefined) throw new UsageError('--check goes with --owner-step: it is the code check that closes the task once the step is done');
    if (site && f.dir === undefined) return finishCard(site, key, { text: f.text, ownerStep: f['owner-step'], check: f.check, repo: f.repo });
    const ref = site ? await store.cardName(site, key) : undefined;
    const ran = await joiningLand(ref ?? key, async () => {
      if (site) await store.checkClose(site, key, f.text, f['owner-step'], f.check);
      await store.checkCallsVerified(site, key, { dir: f.dir });
      const recorded = await store.recordedWorktree(site, key, { dir: f.dir });
      const { repo, base } = builderRepo(site, { repo: f.repo ?? recorded?.repo });
      const report = site ? await store.testReport(site, key, { phase: 'landing' }) : undefined;
      await landInTurn({ path: recorded?.path ?? path.join(worktreesDir(), id), branch: recorded?.branch ?? id, repo: path.resolve(repo), base, ref }, { report });
      return site ? store.setItem(site, key, { done: true, text: f.text, ownerStep: f['owner-step'], check: f.check }) : { lines: [] };
    });
    return ran.joined ? { lines: [`joined the land already running for ${ref ?? key}`] } : ran;
  }],
  'builder stop': [['file/id'], [], (site, [key], f, { ps, grace }) => stopBuilder(needSite(site, 'builder stop'), key, { ps, grace })],
  'item stall': [['file/id'], ['reason'], (site, [key], f, { ps, grace }) => stallCard(needSite(site, 'item stall'), key, f.reason, { ps, grace })],
  'land stop': [['file/id'], [], (site, [key], f, { ps, grace }) => stopLand(needSite(site, 'land stop'), key, { ps, grace })],
  'land queue': [[], [], () => queueLines()],
  // docs/adr/2026-11-14-0600-builders-run-only-their-own-tests-and-the-land-runs-affected-once.md: a builder runs only
  // its own tests; the land runs the tests the change affects, once, after its rebase.
  test: [[], ['dir', 'base'], async (site, args, f) => {
    const say = (line) => console.log(line);
    const dir = path.resolve(f.dir ?? '.');
    const files = ownTests(dir, f.base ?? 'main');
    if (!files.length) return say('the change adds or edits no test file; the land runs the tests it affects');
    say(`testing the ${files.length} test file${files.length === 1 ? '' : 's'} the change adds or edits; the land runs the tests it affects`);
    const card = site ? await store.cardOfWorktree(site, dir) : null;
    const report = card ? await store.testReport(site, card, { phase: 'building' }) : undefined;
    await passTests(dir, { say, runTests: (at, opts) => nodeTests(at, { ...opts, files }), outcome: 'fix them and run board.mjs test again', report });
  }],
  'item bump': [['file/id'], [], (site, [key]) => bump(needSite(site, 'item bump'), key, true)],
  'item unbump': [['file/id'], [], (site, [key]) => bump(needSite(site, 'item unbump'), key, false)],
  lander: [['file/id'], [], async (site, [key]) => {
    if (!site) throw new UsageError('lander needs --site <route>');
    await store.restartLander(site, key);
    return { lines: [`${await store.cardName(site, key)} is handed back again; the server launches a lander for it within a minute, unless a hold stands`] };
  }],
  merge: [['file/id'], ['after-approval', 'confirmed'], async (site, [key], f) => (site && await store.heldMerge(site, key) ? landHeld(site, key)
    : store.mergeCard(site, key, { afterApproval: f['after-approval'], confirmed: f.confirmed }))],
  'arch file': [['file/id'], [], (site, [key]) => (site ? fileFindings(site, key) : Promise.reject(new store.BoardError('arch file needs --site <route>')))],
  push: [[], ['kind', 'title', 'body', 'url', 'tag', 'urgent', 'now'], (site, _, f) => {
    if (f.kind !== 'fault' && f.kind !== 'reminder') throw new UsageError(`a session pushes only --kind fault or reminder${f.kind === undefined || f.kind === true ? '' : `, not "${f.kind}"`}: the board server pushes Action needed, and news goes on the board`);
    if (f.title === undefined) throw new UsageError('push needs --title');
    return store.sendPush(site, f);
  }],
};

COMMANDS.install = COMMANDS.build;

function needSite(site, name) {
  if (!site) throw new UsageError(`${name} needs --site <route>`);
  return site;
}

const card = (site, key) => store.cardName(site, key);
const plural = (list, word) => `${word}${list.length === 1 ? '' : 's'} ${list.join(', ')}`;
const askedAfter = (asked) => `${plural(asked.map((q) => q.id), 'question')} asked after it`;
const builderOf = (f) => (f.agent === undefined || f.agent === 'main' ? 'builder' : `builder ${f.agent}`);

function itemChanges(f) {
  return Object.entries(ITEM_SET_SAYS).filter(([flag, says]) => says && f[flag] !== undefined && f[flag] !== false).map(([, says]) => says(f)).filter(Boolean).join(', ');
}

/*
 * The one line a command prints before its own lines, naming the card and what it did. A board's session adds no
 * text of its own outside a typed prompt, so these lines are what its terminal shows (bin/wait-events.mjs QUIET).
 * A command left out, such as a read, prints only its own lines.
 * name: (site, args, flags, result) → line
 */
const SAID = {
  reply: async (site, [id], f, { asked }) => (id.includes('/') ? `answered ${await card(site, id)}: it reads discussing, the owner's turn; ${asked ? askedAfter(asked) : 'ask any open point with reply --questions <json>, not in prose'}` : `reply written to ${await store.eventCard(site, id)}${asked ? `; ${askedAfter(asked)}` : ''}`),
  thread: async (site, [key], f, { asked }) => `thread line on ${await card(site, key)}${asked ? `; ${askedAfter(asked)}` : ''}`,
  'topic add': (site, [id]) => `topic ${id} added`,
  'question add': async (site, _, f, { asked, staged }) => {
    const topics = [...new Set(asked.map((q) => q.topic))];
    const on = topics.length !== 1 ? '' : topics[0].startsWith('item:') ? ` on ${await card(site, topics[0].slice(5))}` : ` on topic ${topics[0]}`;
    return `${plural(asked.map((q) => q.id), 'question')} ${staged === asked.length ? 'staged' : 'added'}${on}`;
  },
  'question resolve': (site, [id]) => `question ${id} resolved`,
  'question settle': (site, [id]) => `question ${id} settled`,
  'question publish': async (site, [key], f, { ids }) => `${plural(ids, 'question')} on ${await card(site, key)} passed to the owner`,
  'question move': (site, [ids], f) => `questions ${ids} merged onto ${f.to}`,
  'prototype add': async (site, [topic], f) => `prototype ${topic} recorded${f.card ? ` for ${await card(site, f.card)}` : ''}`,
  'prototype rm': (site, [topic]) => `prototype ${topic} removed`,
  'item set': async (site, [key], f) => `${await card(site, key)}: ${itemChanges(f)}`,
  'item add': async (site, _, f, { key }) => `${await card(site, key)} added as ${key}${f.ask !== undefined ? ': an ask in New; triage it as you do the owner\'s' : ''}`,
  'item notes': async (site, [key], f, { file, heading }) => `${await card(site, key)}: notes section "${heading}" added to ${file}`,
  'item triage': async (site, [key], f) => (f['fold-into'] !== undefined ? `${key} folded into ${await card(site, f['fold-into'])}` : `${await card(site, key)}: triaged ${f.phase}`),
  'item relate-ask': async (site, [id, key]) => `ask ${id} folded into ${await card(site, key)}`,
  'ask unfold': (site, [id]) => `ask ${id} back on a task of its own`,
  'ask move': (site, [id], f) => `task ${id} moved to /${f.to}`,
  ask: (site, [route], f, { id }) => `asked /${route}: ${id}`,
  answer: (site, [id], f, { route }) => `answered /${route}'s question ${id}`,
  'review record': (site, [pr], f) => `review of PR #${pr} recorded: ${f.state === 'needs' ? 'needs you' : 'posted'}`,
  'reviewers set': () => 'reviewers replaced',
  'reviewers add': () => 'reviewers added',
  'reviewers remove': (site, names) => `${plural(names, 'reviewer')} removed`,
  'rules add': (site, _, f) => `${f.hub ? 'hub' : 'board'} rule added`,
  'rules edit': (site, [id], f) => `${f.hub ? 'hub' : 'board'} rule ${id} reworded`,
  'rules remove': (site, [id], f) => `${f.hub ? 'hub' : 'board'} rule ${id} removed`,
  'builder start': async (site, [key], f, result) => `${await card(site, key)}: ${result.alreadyOpen ? 'already open: the Implement tap opened its record; launch the agent, whose own builder start takes it up' : `${builderOf(f)} started`}`,
  'builder progress': async (site, [key]) => `progress line on ${await card(site, key)}`,
  'builder done': async (site, [key], f, result) => `${await card(site, key)}: ${result?.said ?? `${builderOf(f)} done${f['owner-step'] === undefined ? '' : `; owner step "${f['owner-step'].trim()}"`}`}`,
  'builder call': async (site, [key]) => `judgment call recorded on ${await card(site, key)}`,
  'builder ask': async (site, [key], f, { id }) => `${await card(site, key)}: asked the orchestrator, ${id}`,
  'builder resume': async (site, [key], f, { running }) => `${await card(site, key)}: ${running ? 'passed to its running builder, which reads it at its next command' : 'the board resumes its builder in its own session'}`,
  'builder answer': async (site, [key, id]) => `${await card(site, key)}: ${id} answered`,
  'builder defer': async (site, [key, id]) => `${await card(site, key)}: ${id} deferred to the owner`,
  'builder verified': async (site, [key], f, result) => `${await card(site, key)}: judgment calls verified${result?.said ? `; ${result.said}` : ''}`,
  land: async (site, [key], f, result) => (!site ? null : result?.said ? `${await card(site, key)}: ${result.said}`
    : f['owner-step'] === undefined ? `${await card(site, key)}: landed and done`
    : `${await card(site, key)}: landed; waits on the owner step "${f['owner-step'].trim()}"`),
  merge: async (site, [key], f, result) => `${await card(site, key)}: ${result?.said ?? 'merged'}`,
  'arch file': async (site, [key]) => `findings of ${await card(site, key)} filed`,
};

// docs/adr/2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md
// The orchestrator's commands on a card, each naming the cards it acted on: once one succeeds, those cards' working
// marks end (store.mjs markActedOn). A builder's own commands aren't here.
// name: (site, args, flags, result) → [card key]
const onCard = (site, [key]) => [key];
const ACTS = {
  'item set': onCard, 'item notes': onCard, 'item brief': onCard, 'item stall': onCard, 'item bump': onCard, 'item unbump': onCard,
  'item relate-ask': (site, [, key]) => [key],
  'item triage': (site, [key], f) => (f['fold-into'] !== undefined ? [f['fold-into']] : [key]),
  reply: (site, [id]) => (id.includes('/') ? [id] : []),
  thread: (site, [key], f) => ((f.who ?? 'claude') === 'claude' ? [key] : []),
  'question add': (site, _, f, { asked }) => asked.map((q) => String(q.topic || '')).filter((t) => t.startsWith('item:') && !t.startsWith('item:ask:')).map((t) => t.slice(5)),
  'question resolve': (site, [id]) => store.questionCards(site, [id]),
  'question settle': (site, [id]) => store.questionCards(site, [id]),
  'question publish': onCard,
  'builder verified': onCard, 'builder answer': onCard, 'builder defer': onCard,
};

// docs/adr/2026-11-16-0900-a-card-in-new-takes-no-writes-until-it-is-triaged.md
// The cards a command writes to, which must be sorted: a card still in New takes nothing until item triage sorts it.
// A thread line of the owner's (--who love) is the owner's message, which a New card is made of. The Quick pair also
// sorts a New card: item notes, then item set --phase ready --from-ask <id>.
const itemTopics = (questions) => [...new Set([questions].flat().map((q) => String(q.topic || '')).filter((t) => t.startsWith('item:') && !t.startsWith('item:ask:')).map((t) => t.slice(5)))];
const WRITES = {
  'item set': (site, [key], f) => (f.phase === 'ready' && f['from-ask'] !== undefined ? [] : [key]),
  'item brief': onCard,
  reply: (site, [id]) => [id],
  thread: (site, [key], f) => ((f.who ?? 'claude') === 'claude' ? [key] : []),
};

export async function main(argv, options = {}) {
  try {
    const { flags, rest } = parse(argv);
    const name = [3, 2, 1].map((n) => rest.slice(0, n).join(' ')).find((key) => routeRecord(COMMANDS, key));
    const command = routeRecord(COMMANDS, name);
    if (!command) throw new UsageError(rest.length ? `unknown command "${rest.slice(0, 2).join(' ')}"` : 'no command given');
    const [params, allowed, run] = command;
    const args = rest.slice(name.split(' ').length);
    const variadic = params.at(-1)?.startsWith('...');
    const least = params.at(-1)?.endsWith('?') ? params.length - 1 : params.length;
    if (variadic ? args.length < least : args.length !== params.length) throw new UsageError(`${name} takes ${params.map((p) => `<${p.replace(/^\.\.\.|\?$/g, '')}>`).join(' ') || 'no arguments'}`);
    const { site: routes, ...given } = flags;
    if (routes?.length > 1) throw new UsageError('--site is given twice');
    const route = routes?.[0];
    const opts = flagsOf(name, allowed, given);
    checkInputs(allowed, opts);
    const site = route === undefined ? null : await store.siteDir(route);
    if (site && TO_OWNER[name] && (name !== 'thread' || (opts.who ?? 'claude') === 'claude')) await store.refuseQuestionIds(site, TO_OWNER[name].map((flag) => opts[flag]));
    const writes = routeRecord(WRITES, name);
    if (site && writes) await store.refuseInIntake(site, await writes(site, args, opts));
    const result = await run(site, args, opts, options);
    const acts = routeRecord(ACTS, name);
    if (site && acts) await store.markActedOn(site, await acts(site, args, opts, result));
    const said = routeRecord(SAID, name);
    const line = said && await said(site, args, opts, result);
    if (line) console.log(line);
    for (const line of (typeof result === 'object' && result?.lines) || []) console.log(line);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) { console.error(`${e.message} (node board.mjs --help lists the commands)`); return 2; }
    if (e instanceof store.BoardError) { console.error(e.message); return e.exitCode ?? 1; }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') console.log(USAGE);
  else process.exitCode = await main(argv);
}
