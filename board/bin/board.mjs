#!/usr/bin/env node
import { readiness } from '../../hub/readiness.mjs';
import { readSlack, setSlack } from '../../hub/slack.mjs';
import { routeRecord } from '../../hub/routes.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as store from '../store.mjs';
import { boardWorktree, builderRepo, joiningLand, landInTurn, mergeHelper, worktreesDir } from '../worktree.mjs';
import { pidAlive } from '../headless.mjs';
import { fileFindings } from '../arch-review.mjs';
import { finishCard, landHeld } from '../finish.mjs';
import { bump, queueLines, stallCard, stopBuilder, stopLand } from '../stop.mjs';
import { boardAt } from '../../hub/boards.mjs';
import { boardRepo } from '../../hub/board-repo.mjs';
import { checkTakesRender } from '../render-check.mjs';
import { prototypeBase } from '../prototype-base.mjs';

export const USAGE = `usage: node board.mjs <command> [--site <route>] ...

Writes a kickflip board's data files. --site <route> picks ~/.claude/kickflip/sites/<route>, and its
board.json says where the board's item files live. Without --site, they come from ~/.claude/waves.
Paths resolve under $HOME, so HOME=<dir> points every command at a copy.
A --file argument of - reads stdin.
Every new card is a task, keyed T-<n>, with no ticket, until it goes ready (the board makes one, on a board with a
source), item add or item set --new-ticket (the orchestrator, for a Quick task), or --ticket <id> gives it one. A ticket comes
from the board's source, GitHub or Linear, made from the card's title and notes, Linear in the board's team and project
through Hub's Linear key; a linked one must exist there. A board whose source is none has no tickets.
A card moves its ticket one way: a build's start → In Progress, --pr, --pushed or a verified merge-ready build → In
Review, --done → Done (a GitHub issue closes), only for a ticket assigned to the owner or created by kickflip. A ticket that
can't move prints one "ticket <id>: …" line; the card's change still stands.
Linear needs Hub's Linear key: settings set tickets refuses it without one, and once the key is removed the hub
moves every Linear board to no ticket source. If the source can't make a ticket, the command fails and changes nothing.

  reply <eventId> (--text <md> | --file <path>)          data/replies/<eventId>.md, markdown the board draws. A
                                                         reply to an ask answers the card it became, as reply
                                                         <file>/<id> does, and resolves that card's answered
                                                         questions; one to wave-triage resolves its wave's,
                                                         noting "Acted on: replied". A
                                                         reply to overnight-triage ends that triage
         [--title <t>]                                   retitles the New or discussing card the ask became
  reply <file>/<id> (--text <md> | --file <path>)        answers the New or discussing card an ask became: the
         [--title <t>]                                   answer goes in its thread and the card reads
                                                         discussing in Todo, --title as its title. Refuses a
                                                         card sorted another way or that isn't one an ask became.
                                                         reply, item set --phase, --title, --ticket and
                                                         --new-ticket, and item relate-ask refuse an ask (or the
                                                         card it became) the owner edited after its Working-on-it
                                                         mark, or edited and never handed over: they print the new
                                                         text and move the mark to now, so a rerun goes through
         [--close]                                       for a reply that leaves only the owner's Done: marks the
                                                         card waiting to be closed, so its Done goes orange and it
                                                         reads Action needed until the owner taps Done or writes
                                                         in its thread (thread <card> --close does the same)
         [--implement]                                   for a reply that ends at "tap Implement": marks the card
                                                         ready to implement, so its Implement goes orange and it
                                                         reads Action needed until the owner taps Implement or
                                                         writes in its thread
  thread <file>/<id> --text <t> [--link <url>]           one line in the item's thread; ask:<eventId> in place
         [--who claude|love|<name>] [--via github|slack] of <file>/<id> writes in that ask's thread
         A Claude thread line, or a reply to an ask or item-message, rewrites the body of the thread's
         queued push (tag ask-<eventId> or item-<file>/<id>) to the message's first line, keeping
         "· and N replies", and prints the new body. It never pushes: the thread's unread mark carries it
  visual add <file>/<id> --file <page.html> --title <t>  a visual agent's page: copied to public/visuals/<id>/<slug>.html
                                                         (a new name each time), linked by a visual line in the
                                                         item's thread; prints the page's link
  item brief <file>/<id> --kind grill|prototype|visual   the orchestrator's brief for the card's next agent of that
         --file <draft.md>                               kind: what the discussion settled, what is still open,
                                                         what the questions, takes or page should cover and the
                                                         files that matter. Appended to its notes as "Brief for
                                                         <kind> round N"; the board launches the agent from it, and
                                                         from nothing else. A grill or prototype brief moves the
                                                         Todo card to grilling or prototyping
  topic add <id> --title <t> [--summary <s>]             a question topic in data/owner.json
  question add --file <json>                             one question or an array of them:
         {id, topic, question, options: [{id, label, recommended?, detail?, diagram?, practice?}],
          source?, context?, url?, urgent?, round_of?, reask_of?, ask?, suggested?, prototype_gate?}; topic is declared, item:<file>/<id> (an ask's
          questions go on its card's), wave:<slug> for a wave's triage, or file:<slug> for an item file's triage on
          a board over ~/.claude/waves. A question on a done card reopens it.
         A question on an item: topic whose card has a grill or prototype planner running is staged, not published,
         whoever adds it: it shows nowhere until the planner finishes, fails or is stopped, when every staged question
         on the card publishes in the order added, with one owner push. The command says "staged" and why.
         url is http(s), or a site page such as prototype-<topic>.html?q=<id>, stored as given.
         Prototype options keep take order, ids matching take keys; recommended: true tags the recommendation.
         suggested: {option, card, answer, reason?} pre-checks the option the owner already chose on an earlier card, with a blue
         line above its description, Orchestrator choice: <reason>; give a reason, your own words for why. Without one the line
         reads Orchestrator choice: you answered this on <card>: "<answer>"; card is that card's ref, answer their words.
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
         prototype_gate: true marks a grill's closing "Prototype round first?" question (options yes, no, on a card's
         topic): the owner's yes moves the card to prototyping and starts its prototype planner, a no stages it
         once no question on it is left open, the board doing both with no orchestrator step. The answer stays
         on the card as its gates.prototype, so a regrill or a split child never asks it again: question add
         refuses a prototype_gate whose answer the card keeps, and a yes is spent once the card
         moves to prototyping on it.
         reask_of names a resolved question on the same topic that the owner asked to ask again
         (reask-request): it resolves that one again, noting "Asked again as <new id>", printed as "resolved: <old id>".
         ask names a builder ask the session deferred on the item (builder defer): the question puts it to the
         owner, and while a card's only open questions are such, it waits on them with no Action needed.
         The board server pushes the new open questions itself, under the card's tag (item-<file>/<id>, or
         ask-<eventId>) or topic-<topic> off the cards
  question resolve <id> --note <text>                   sets resolved and resolved_at; refuses a question on a
         prototype page until an answer settles its round: a pick, with a note or none, or an answer to
         an "Is this it?" confirm already on the board. A question already resolved, such as one an
         answer with a note and no option resolved, is left as it is
  question settle <id> --note <text>                    a question a finished grill left for the orchestrator to screen
         (a screen wait), which the board already answers: it is published resolved "Settled by the
         orchestrator: <text>", and the answer goes into the card's notes. Refuses the prototype question,
         which is the owner's. On a ready card waiting on your re-check since its block ended, it answers
         one of the card's questions again the same way, when what landed made its answer stale
  question publish <file>/<id>                          passes the rest of the card's screened questions on to the owner.
         The board server publishes any left unscreened 15 minutes on, with a thread line
  question move <id>,<id>,… --to <file>/<id> [--block <file>/<id>,…]   merges open questions that ask one thing onto
         one card: the first id moves to that card (topic item:<card>), the others resolve "Duplicate of
         <card>'s question <first id>". Each --block card, in order, is blocked by the one before it (the
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
                                                         --card starts that card: it leaves Todo
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
  pr <file>/<id>                                         one JSON line per PR on the card, in its order: the PR's
                                                         repo, state, checks and new events, using the board's
                                                         github-login and the card's gh_since
  pr comment <pr> --body <text>                          posts Claude's words on PR <pr> through gh, a number in the
                                                         board's repo or owner/repo#<n> for a card's PR in another,
  pr reply <pr> <comment id> --body <text>               or replies in that review comment's thread, as the board's
                                                         github-login (else gh's account), adding "🤖 " before and a
                                                         blank line and <!-- claude-bridge --> after, the marker pr
                                                         reads as Claude's own. Refuses words that already carry
                                                         either. Prints the post's url
  item set <file>/<id> [--done --text <t> [--force]]    edits the item in its item file; --done closes the card
                                                         (below). A card has no status: it stores its lane, which
                                                         a build's start, a handover, a block and a close move,
                                                         and the board server moves the rest, each with a thread
                                                         line; --status is refused
         [--next <t> | --clear-next]                     an empty --next "" clears it, as --clear-next does
                                                         naming another unfinished card requires it in --deps
         [--pr <n> | --pr <owner/repo#n>]...             adds a PR to the card, a bare number in the board's repo;
                                                         repeatable, and never replaces one. Each PR gets its own
                                                         badge and polling; the least-ready decides the card's lane
         [--pushed <branch>]                             on a board whose repo is a plain git remote (no GitHub):
                                                         the card's branch is pushed there, so it waits In Review
                                                         on the owner's merge. Push it first (git push origin
                                                         <branch>). The hub's repo fetch moves it to Done once the
                                                         branch is merged into the board's branch or gone from the
                                                         remote. Moves it to In Review as --pr does
         [--gh-since <ISO time>]                         records the last handled GitHub event, an ISO-8601 UTC
                                                         time such as 2026-10-23T11:00:00Z, stored as given
         [--from-ask <eventId> --text <t>]               the ask it came from, for an ask from before asks
                                                         arrived as cards: its New row gives way to this item,
                                                         whose thread opens with the ask and its thread, then --text
                                                         as the item's first line; it leaves a card it was folded into; refuses a card
                                                         from another ask (use item relate-ask), an ask that is
                                                         already a card, naming it (sort that card instead), and
                                                         one with no phase when --phase is missing
         [--phase ready|discussing|grilling|prototyping] a Todo card's phase: what it does next; it reads New
                                                         until set, which sorts a New card an ask became (an
                                                         answered one leaves In Review for Todo). discussing is
                                                         a conversation in its thread, which reply on a New card
                                                         also sets. Like --title, --ticket and --new-ticket, refused
                                                         on an ask edited after you read it, as reply is.
                                                         Refused on a card in another lane, whose phase
                                                         the board sets, and as --state, its old name.
                                                         Staging is the board's: it stages a card on the owner's
                                                         Send, Implement or Reply on a ready card, and refuses
                                                         --phase staging. ready refuses a card not staging or
                                                         ready, bar --from-ask on a Quick build ask, whose filing
                                                         is your judgment; and a card with an open question, and
                                                         a card without --size, a notes file, or the id of each
                                                         answered question in that file, since a builder starts
                                                         from it; it resolves those answered questions.
                                                         grilling or prototyping on a discussing, staging or
                                                         ready card has the board start that round's planner.
                                                         A ready card whose block ended waits on your re-check:
                                                         ready again with --text "<what you re-checked>", which
                                                         goes into its notes, releases it to the pull
         [--held | --unheld | --pick-up-at <time>]       holds or resumes the card on the owner's words; the board
                                                         server records the owner's own Hold and Resume taps. A later
                                                         --held/--unheld overrides a tap.
                                                         --pick-up-at holds it until an ISO time such as
                                                         2026-11-04T09:00 (the host's local time without an
                                                         offset; a past time is refused), stored as UTC
                                                         pick_up_at. Within a minute of it the board server
                                                         resumes the card, adds a thread line, and appends
                                                         card-unblocked {key, until} unless a dep is unfinished.
                                                         --held holds it with no time; --pick-up-at "" resumes it
         [--ticket <id> | --new-ticket]                links a ticket in the board’s source, or makes one there
                                                         from the title and notes; the key stays
         [--title <t>]                                   renames the card
         [--check "<name> <args>"]                       adds or changes the code check on the card's owner step,
                                                         as builder done --check takes it, clearing a broken mark;
                                                         --check "" removes it. Refused on a card with no owner step
         [--size small|large] [--model opus|sonnet]      what builder pick reads while the hub's Claude model is
                                                         Auto: a small card gets Claude Sonnet, any other Opus, and
                                                         --model wins over --size; "" clears either
         [--deps <id>,<file>/<id>,wave:<slug>]           replaces its blocked-by list; --deps "" clears it.
                                                         wave:<slug> waits on every card in the wave at the
                                                         time, as it grows, until each is Done; refused for a
                                                         card in that wave
         [--blocked-until "<condition>"]                 blocks it until a condition an agent can check, which
                                                         the orchestrator checks on its passes over the cards;
                                                         --blocked-until "" clears it, which threads and emits
                                                         card-unblocked {key} once nothing else blocks it
         [--block-reason "<reason>"]                     why it is blocked, by its deps or its condition, which
                                                         goes when the block does; --block-reason "" clears it
                                                         A block on a card In Progress sends it back to Todo,
                                                         stopping its board-launched builder (refused for a
                                                         session's own builder); one In Review stays, unlanded
         [--parent <file>/<id>]                          sets its Parent, refusing itself or a card below it;
                                                         --parent "" clears it
         [--related <id>,<file>/<id>]                    replaces the cards it is Related to, which both cards
                                                         show; --related "" clears it, on both
         [--relate <id>,<file>/<id>]                     adds cards to its Related to, keeping the rest
         [--unrelate <id>,<file>/<id>]                   takes cards off its Related to, on both cards; neither
                                                         goes with --related
         [--install <url> [--install-sha <sha>]          a device build the owner installs from the card's Install
          [--install-label <text>] | --clear-install]    button, stamped built_at now: itms-services://?action=
                                                         download-manifest&url=https://…/manifest.plist for iOS,
                                                         an https:// .apk URL for Android. --install-sha is the
                                                         head it was built from: the badge reads "Install (stale)"
                                                         once the branch moves past it. Hidden once the card is Done
         [--text <t>]                                    with --done, required on a site: the card's closing line,
                                                         written last in its thread, saying why it closed (merged,
                                                         dropped, superseded)
         [--split-into wave:<slug> | <id>,<file>/<id>]   with --done, in place of --text: closes a split card. Each
                                                         open card waiting on it waits on the wave or cards it
                                                         split into instead, with a line in its thread, and the
                                                         closing line reads "Split into …". Refused when a
                                                         waiting card is one of them, or the card is already Done
         builder start for a build moves the card to In Progress with "Moved to In Progress: a build
         started", resolving its answered questions, noting "Acted on: build started". It refuses while
         the item is held or a dep isn't done, and while the newest owner answer to its questions that
         link a prototype-*.html page picks no take, which leaves the card prototyping with Next
         "Prototype again" until the next round's pick; a pick's note is the build's guidance.
         --pr closes ordinary builders and moves the card to In Review; install builders keep running.
         A builder's hand-back of work it couldn't land (builder done with judgment calls) keeps the card
         In Progress, reading "Orchestrator review", until the owning session lands it; it unblocks nothing.
         The board server records the owner's card-done in the item file itself.
         --done moves the card to Done and its ticket to Done: it resolves each of its questions (topic
         item:<file>/<id>) that has an answer, noting "Closed with the card", and prints "resolved: <id>"
         for each. It refuses while one has no answer yet; [--force] closes it and resolves that one too.
         It prints "unblocked: <file>/<id>" and appends card-unblocked {key} once per unblocking,
         including held cards: start each unheld card next. It refuses a card the owner reopened: it
         closes again only on the owner's Done
  item add <file>[/<id>] --title <t>                    a new card, unstarted; never
         [--ticket <id> | --new-ticket]                  hand-edit the item file to add one. Refuses an id the file has.
         [--deps <id>,<file>/<id>,wave:<slug>]           A task with no ticket unless --ticket links one or
                                                         --new-ticket makes one from the title and notes
         [--notes <t> | --notes-from <draft.md>]         the board makes the card's own notes, <id>-notes.md beside
                                                         its item file, read-only: the draft verbatim, or "# <title>"
                                                         then the --notes text. Refuses a draft that is any card's
                                                         notes file, live, done or archived, naming that card
         [--pick-up-at <time> | --held]                  holds it until then, or until resumed, as item set's
         [--size small|large] [--model opus|sonnet]      as item set's
         [--parent <file>/<id>]                          the card it was spun out of, such as one filed from
                                                         another card's thread, grill or answer: it reads as a
                                                         follow-up, and its Parent lists it in Children. A card
                                                         from the + or New task has none
         [--split-of <file>/<id>]                        a card split from that one: sets it as the Parent, as
                                                         --parent does, and copies its gates, the owner's prototype
                                                         answer, so its grill never asks it again.
                                                         Refuses --parent beside it
         [--phase discussing|grilling|prototyping|ready] files it at once, as item set's --phase; the session's
         [--relate <id>,<file>/<id>]                     own form, linking it with --relate in the same call.
                                                         ready is for a Quick build ask (--from-ask), with --size
                                                         and --notes or --notes-from, since a builder starts from it
         [--from-ask <eventId> --text <t>]               files the card from that ask in this one command, as
                                                         item set's --from-ask, refusing an ask that is already a
                                                         card: no grill starts before the ask is on
                                                         the card, which takes the ask's place in Todo. Needs --phase
                                                         On a board --phase is required, so no card an agent
                                                         adds reads New
         Without /<id>, a task is keyed T-<n>, the next on the board, and a ticketed card takes its ticket's
         id (GH-<n> for issue #n); pass an id only to import a card. Prints "<label> added as <key>": use the key in later commands
  item notes <file>/<id> --heading <h>                 appends "## <h>" and the draft to the card's notes, making
         (--file <draft.md> | --from <file>/<id>)        its <id>-notes.md when it has none; the only way to write
                                                         notes (--notes-file and --plan are gone). Write the draft
                                                         outside the board's data; one that is any card's notes
                                                         file, live, done or archived, is refused, naming that
                                                         card. --from folds that other card's notes in instead,
                                                         headed "Folded from <ref> "<title>"" without --heading.
                                                         Resolves answered questions still waiting on Claude,
                                                         noting "Recorded in the card's notes", and prints
                                                         "resolved: <id>" for each
  item relate-ask <eventId> <file>/<id> --summary <t>   folds an ask about an existing item into it: the New card
                                                         the ask became goes, its message and thread show in the
                                                         item's thread marked Moved, then the summary line, and the
                                                         owner's banner names the card it merged into. Refuses
                                                         an ask whose card is sorted. Again with another item
                                                         moves it there. Refuses an ask edited after you read it,
                                                         as reply does
         [--title <t>]                                   names the merge in the owner's banner
  ask unfold <eventId>                                   moves a folded ask back out to a card of its own
  ask move <eventId> --to <route>                        sends a New ask to another board in the hub's manifest:
                                                         a New card there with the owner's text, attachments and
                                                         "Moved from <this board>", which wakes its session; here
                                                         the card the ask became is dropped, leaving a line in the
                                                         ask's thread linking to that card. Refuses an ask whose
                                                         card is no longer New.
                                                         Refuses a route that isn't another board, and an ask
                                                         that isn't New
                                                         Then sends the queued pushes, each on its own, unless
                                                         pushes are held (overnight, snoozed, the weekend or off)
  wave create <slug> --title <t> --goal <t>            a wave, in the owner's words: a named set of cards from
         --card <file>/<id>[:<file>/<id>,…] [--card …]   one item file, one --card per card in build order, each
         (--note <t> | --file <f>)                       naming after a colon the earlier cards it would conflict
                                                         with (as item set --deps takes them). Each card is then
                                                         blocked by those cards alone (its links outside the wave
                                                         stay), so cards that don't conflict build side by side,
                                                         and the note goes to wave-<slug>.md beside the item file.
                                                         Todo shows it as a band of its cards in order, each with
                                                         the board's blocked-by line, its goal on its name, and
                                                         Notes opens the goal, the order and the note. Refuses a
                                                         card already in another open wave, and a conflict that
                                                         isn't an earlier card of the wave. Prints the order by
                                                         card label, each card with "(after …)" its conflicts
  wave add <slug> <file>/<id> [--after <file>/<id>,…]  puts a card in the wave, last, blocked by the earlier
                                                         cards --after names; refused for a card whose --deps
                                                         names the wave
  wave remove <slug> <file>/<id>                       takes a card out, keeping its own links; refused
                                                         while an open wave card waits on it, naming each and
                                                         the wave set … --after to run
  wave set <slug> [<file>/<id> --after <file>/<id>,…]  rewrites only that card's links to the wave's cards to
         [--title <t>] [--goal <t>]                      --after's earlier cards ("" clears them), renames the
         [--note <t> | --file <f>]                       wave, sets its goal or rewrites its note
  wave finish <slug>                                   the wave's band leaves Todo; its cards keep their
                                                         links. Refused, naming them, while a card in it is
                                                         open. A wave whose cards are all Done leaves it too
         A band's Triage sends wave-triage {wave}, or {file} for an item file's band; it reads
         Triaging… until you reply to that event, then "Triage: N open questions" while questions on topic
         wave:<slug> or file:<slug> are open or answered
  reviewers set --file <json>                            the board's reviewers in board.json, replacing them:
                                                         [{name, slack_user, dm, github}], as in an item file.
                                                         The settings page lists them; new item files copy them
  reviewers add --file <json>                            one reviewer or an array; replaces the same name
  reviewers remove <name>...                             refuses a name the board doesn't have
  slack                                                 Slack identity as JSON; imports slack-bridge config once
  slack set [--self-dm D..] [--user U..]                 sets hub Slack identity in ~/.claude/kickflip/slack.json
            [--domain x] [--timezone Area/City]
  slack thread <eventId>                                a slack-question event's day thread, read from Slack through
                                                         Hub's token: one message a line, named board, you or the
                                                         reviewer; → marks the event's message
  slack answer <eventId> --text <t>                     posts "🤖 " and the answer, at most 250 characters, as a reply
                                                         in that thread. Refuses an owner's message that names no
                                                         @kickflip, which expects no reply
  slack say <reviewer> --text <t>                       posts "🤖 " and the words, at most 250 characters, in the
                                                         reviewer's day thread for today, opening it with the
                                                         "<board> reviews" header when none is open; only on the
                                                         owner's explicit ask
  slack task <eventId> <file> --title <t>               a request for work in that thread: a new card in item file
         (--notes <md> | --notes-from <draft.md>)       <file>, filed discussing for the owner's review, never ready;
                                                         the Slack message is its first thread line, by its writer
  integrations                                          readiness rows as one JSON line
  review due                                            one JSON line of the Slack sends the hub owes, from local state
                                                         and data/pr-slack.json: {date, links: [{pr, key, reviewer,
                                                         slack_user, text}], reactions: [{pr, reviewer, reply?,
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
                                                         owed the day's digest weekdays 09:00-17:00 in the Slack
                                                         identity timezone until data/review-digests.json has it all
  rules list                                             the hub rules, then with --site the board's, one
                                                         "<hub|board> <id> <owner|claude> <text>" line each
  rules add --text <t> [--hub] [--by claude]             a rule in board.json, or with --hub in the hub's
                                                         settings.json for every board; prints its id.
                                                         --by claude when you codify one on the owner's word
  rules edit <id> --text <t> [--hub]                     rewords a rule, keeping who added it
  rules remove <id> [--hub]                              refuses an id the list doesn't have
  settings                                               the board's settings as JSON; flags default off, optional
                                                         settings appear when set: {"auto_merge": false,
                                                         "auto_build": false, "auto_pull": false,
                                                         "max_implementers": 10, "max_planners": 3,
                                                         "max_serves": 10, "auto_triage": false,
                                                         "auto_review": false, "idle_notification": false,
                                                         "skip_draft": false, "prs": true,
                                                         "github_login": "owner"}
  settings set auto-merge on|off                         on: the hub's tick merges an approved PR once CI is green and
                                                         the merge state is CLEAN. off (the default): the card
                                                         shows the owner a Merge button, and the board server merges
                                                         when it is tapped. Board Settings' toggle writes it too
  settings set skip-draft on|off                         on: the hub's poll marks a card's draft PR ready for
                                                         review once its CI passes. off (the default): the draft
                                                         waits in In Review on the owner's review and Ready
  settings set prs on|off                                on (the default): a board on GitHub opens a PR for each
                                                         card. off: no PR; the card lands on main and main is
                                                         pushed, which needs Push main after a land granted.
                                                         A local board never opens PRs. Without auto-merge, a
                                                         card with no PR waits in In Review for the owner's Merge
  build <file>/<id> --site <route>                       asks the hub to run this card's build script; prints
         --asked "<owner's words>"                       started and exits. install is an alias. Only the owner's
                                                         Serve / Build and Auto-build start a card run, so --asked
                                                         must quote the owner's ask, card message or answer note on
                                                         this board that asked for it; the words go in a thread
                                                         line on the card. The hub records data/try/<id>.log and
                                                         writes failures to the thread. Web Visit opens
                                                         https://<host>:<try port>/ at its root
  main set --install <url> [--install-sha <sha>]          publishes main's app install to data/main.json
  settings set github-login <login>                      the GitHub account Claude posts as on this board. Its
                                                         comments carrying <!-- claude-bridge --> are Claude’s own
                                                         and dropped; its other comments are the owner’s. Unset,
                                                         the hub asks gh api user. Pass "" to clear it
  settings set auto-build on|off                         on: each push builds its card. Off by default.
                                                         Main builds after every merge either way
  settings set build-target <target>|default            the script the hub runs for each card and main:
                                                         .kickflip/build-<target>, or .kickflip/build with
                                                         default (unset). Board Settings' Build target picks it
  settings set auto-pull on|off                          Auto implement Todo cards. on: on every board change the
                                                         board server starts and launches the build of the top
                                                         ready Todo cards nothing blocks, holds or asks about, one
                                                         per free implementer slot (see max-implementers), each
                                                         once, and launches a grill on each card that arrives in
                                                         Todo, up to max-planners at a time (an arrival: not ready,
                                                         staging or held, with no planner record and no questions
                                                         yet). Off by default.
                                                         Only on the owner's word
  settings set max-implementers <1..99>                  Maximum parallel implementers, 10 by default: the cards
                                                         building or waiting in Orchestrator review the pull fills
                                                         up to. Planners and cards waiting on the owner don't count.
                                                         It limits the pull only: an Implement the owner asks for
                                                         starts past it.
                                                         Only on the owner's word
  settings set max-planners <1..99>                      Maximum parallel planners, 3 by default: the grills and
                                                         prototypes running at once; arrivals past it wait in board
                                                         order. Only on the owner's word
  settings set auto-review on|off                        on: while the board is idle and nothing is pulled, the board
                                                         server sends pr-review {pr, head, repo, title, author, url,
                                                         touches, asked} for one incoming PR at a time that touches
                                                         this board's cards or asks the owner for review. Off by
                                                         default. Only on the owner's word
  settings set auto-triage on|off                       on: once a night, from the middle of the hub's quiet hours
                                                         to their end, when two or more cards wait on open
                                                         questions, nothing builds and something changed since the
                                                         last triage, the board server declares topic
                                                         overnight-triage-<date> ("Overnight triage <date>") and
                                                         sends overnight-triage {date, topic, cards}; the pull
                                                         waits until you reply to it. Off by default. Only on the
                                                         owner's word
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
                                                         --kind install: a build of the card's install, whose
                                                         Install badge reads Building… meanwhile. --kind claude or
                                                         codex refuses the one builder pick rules out; --kind build
                                                         records the pick's kind and prints "kind: <kind>. <reason>";
                                                         on the open record a Build tap started or --dispatch
                                                         opened, it keeps that record's kind and worktree.
         [--dispatch]                                    --dispatch: the session runs this right before it launches
                                                         an agent of any kind (build, prototype, grill) so the record
                                                         is open at launch and the card reads starting; the agent's
                                                         own builder start takes it up. On a record the Build tap
                                                         opened it changes nothing and prints "already open". The
                                                         record keeps dispatched: tap or session, whoever opened it.
                                                         --agent <other name> refuses while the tap's main record
                                                         is open and not taken up.
                                                         A build's start clears the card's Next.
                                                         A build (--kind build, claude or codex) on a card not done
                                                         and not In Progress moves it to In Progress first,
                                                         refusing what item set's build start refuses;
                                                         Prints "ref: <ref>", the card's label, which commits name in a "Refs: <ref>" trailer.
                                                         Resolves the card's answered questions, noting "Acted on:
                                                         builder started"
         [--worktree [--repo <dir>]]                     --worktree: a git worktree for the builder at
                                                         ~/.claude/kickflip/worktrees/<id> on a new branch <id> from
                                                         the board's branch of its clone (--repo overrides the clone), kept on
                                                         the record and printed as "worktree: <path>". Refuses when
                                                         that path or branch exists, unless it is a leftover
                                                         holding no work, which it remakes. A build's main record
                                                         on a board makes it without --worktree when it keeps none
                                                         (a taken-up or resumed record's, or the worktree the
                                                         card's last record left while it is still there)
  builder progress <file>/<id> --phase <phase>           one status line: a phase, reading, building, testing,
         (<detail> | --text <d>) [--agent <name>]        checking or landing, and a present-tense detail of at most
                                                         80 characters in plain words, which the owner reads at a
                                                         glance; a longer detail is refused with its length. Hashes,
                                                         test counts and file names go in the hand-back. The thread
                                                         line reads "Testing: <detail>", "Codex testing: <detail>"
                                                         for another agent, and the card "Testing · <detail>"
         [--eta <ISO time> | --clear-eta]                an ETA shows as a line under the card's status
         A progress line, --progress included, needs --site: it is a status line in the item's thread, and
         the card's status shows the newest one from an agent still working. builder progress refuses
         without an open record for that agent, as builder call does
  builder done <file>/<id> [--agent <name>]              marks that agent's record done; the item's thread
         [--next <t>] [--text <what you checked>]        shows when it started and finished. On a
                                                         record with unverified judgment calls it hands the card
                                                         back: its records close marked handed back, with Next "Answer the builder's
                                                         questions" when a call starts "Question:", else "Verify
                                                         the builder's judgment calls"; --next is refused there.
                                                         Else, on a board, the main build's record that keeps a
                                                         worktree finishes the card, as land does, --text its
                                                         closing line: lands it, closes the card and its ticket
                                                         and, with the board's "Push main after a land" on, pushes
                                                         the branch to origin; on a GitHub board it pushes the
                                                         card's branch, opens a draft PR and moves the card to it,
                                                         and on a plain git remote pushes the branch for the
                                                         owner's merge (item set --pushed). A finish that fails
                                                         refuses with the reason and leaves the record open; one
                                                         refused while another agent's record is open names it.
                                                         A helper's done takes --text, its hand-back, which agent
                                                         wait prints. A grill's or prototype's done takes
                                                         --text, what it asked, as the run's closing thread line.
                                                         --next stops a build without finishing it. Closing the
                                                         last record of a card left In Progress with no Next is
                                                         refused without --next, which sets it
         [--owner-step <t>]                              a step only the owner can do once the code lands: the card
                                                         then waits in In Review with it as its Next, its ticket
                                                         open, until the owner's Done; refused on a card already
                                                         done. land takes it too
         [--check "<name> <args>"]                       with --owner-step: a read-only check on the step's final
                                                         evidence, which the hub's poll runs on each check once the
                                                         code lands, closing the card when it passes: tag
                                                         <owner/repo> <pattern>, npm <package> <version-or-range>,
                                                         run <owner/repo> <workflow> (a successful run since it was
                                                         attached), gh <owner/repo> <api-path> <field>=<value>, or
                                                         url <address> [<status> | <text>]. An unknown check or bad
                                                         arguments are refused. Three runs in a row that can't run
                                                         mark it broken and append owner-check-broken {key, check,
                                                         error}; fix it with item set --check. land takes it too
         [--title "<type>(<scope>): <summary>"]          the draft PR's title on a GitHub board, else the subject
                                                         of the one commit land squashes the branch into, a
                                                         Conventional subject of at most 72 characters (else the
                                                         branch's first commit subject); refused in any other
                                                         shape before anything is pushed or squashed. builder
                                                         verified takes it too
         builder takes --dir <dir> for an item file in <dir>; its records go in <dir>/agents
  builder stop <file>/<id>                               the orchestrator's stop of the card's run the board launched,
                                                         its headless builder, lander or rebase run, with every process
                                                         under it: the record stays open, marked stopped, so the server
                                                         relaunches nothing and the card stays In Progress reading
                                                         "build stopped by orchestrator" ("land …" while it lands),
                                                         waiting on the orchestrator; the same words go in its thread.
                                                         Prints what it stopped, one process a line. Refuses a planner,
                                                         a builder a session started itself, or none running
  item stall <file>/<id> --reason "<why>"                the orchestrator's flag on a stale card it can't restart: the
                                                         card stays in its lane reading red "stalled", an Action needed
                                                         "stalled: <why>" with one push, waiting on nobody else; its
                                                         run stops as builder stop stops it (nothing to stop when it
                                                         is gone), its record stays open and stopped and its worktree
                                                         stays, and it frees its implementer slot. Its thread reads
                                                         "stalled by orchestrator: <why>". A message on the card
                                                         clears it
  land stop <file>/<id>                                  the orchestrator's stop of the card's land and its suite: one a
                                                         headless builder or lander runs stops that agent as builder
                                                         stop does; the land a held card's Merge tap started stops
                                                         alone, leaving the land queue, and the card's Merge shows
                                                         again, reading "land stopped by orchestrator". Refuses while
                                                         the land fast-forwards main, or a land in a session the board
                                                         didn't launch
  land queue                                             the host's land queue in order: the land running, then each
                                                         waiting, "(bumped)" on one a bump moved
  item bump <file>/<id>                                  the card's bump, as the owner's bump icon sends it (card-bump;
  item unbump <file>/<id>                                card-unbump). A bumped card's land goes ahead in the land queue
                                                         of every land not bumped since, the latest bump first, without
                                                         stopping the one running; a bump of a queued land says so in
                                                         its thread ("land moved first by orchestrator")
  lander <file>/<id>                                     relaunch the headless lander of a card it stopped on (a usage
                                                         pause ends one): its open record closes as handed back and
                                                         the server launches a fresh lander; refused unless a
                                                         builder record on the card is open
  builder pick <file>/<id>                               who builds the card, from the hub's Codex share and the pause
                                                         line, and for claude which model, from the hub's Claude model
                                                         and the card's --size and --model: "codex: <reason>" or
                                                         "claude sonnet: <reason>". Pass that kind to builder start
                                                         --kind, and launch that model
  audit [<file>/<id>]                                    the board's audit log of the last 30 days, data/audit.jsonl:
                                                         each call the code made on its own (builder-pick, pull,
                                                         round-planner, launch-held, arrival-planner, relaunch,
                                                         lander, triage, pr-review, push, pick-up, auto-merge,
                                                         ready-draft, session-resume, compact) as "<at> <call>
                                                         [<key>]: <result>. <reason>" and the inputs it read; with
                                                         a card, only that card's. The hub's own: kickflip audit
  agent launch <file>/<id> --name <n> --task <t>         any session's helper on an open card, an agent the board server
         [--writes] [--model <opus|sonnet>]              launches headless with the task as its brief, under its own
                                                         name (lowercase, "-", not main or visual-…), its record
                                                         <id>@<name> requested until then. A read-only helper launches
                                                         at once and takes no implementer slot; one with --writes
                                                         takes one, waits while Maximum parallel implementers is
                                                         reached, ahead of the pull and the topmost card's first,
                                                         and works in its own worktree, branch <id>-<name> from the
                                                         card's, so it needs the card's worktree. --model else
                                                         builder pick's Claude model. Its lines carry its name
  agent wait <file>/<id> --name <n> [--agent <me>]       blocks until the helper's builder done, then prints its
         [--timeout <minutes>]                           --text and, for one that writes, its branch. Meanwhile
                                                         --agent's record (main by default) takes no slot. Refuses
                                                         after --timeout (9) minutes, saying whether it runs or waits
                                                         for a slot, and once its process is gone without done
  agent merge <file>/<id> --name <n>                     merges a done helper's branch into the card's worktree and
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
                                                         Orchestrator that leaves the card quiet
  builder defer <file>/<id> <ask> --text <t>             the session's deferral of an ask it can't answer confidently:
                                                         the same thread line, and a "Question: <ask> (deferred to the
                                                         owner)" call on the asking agent's record. After its review the
                                                         session puts it to the owner as a card question with
                                                         "ask": "<ask>"; builder verified refuses until then
  builder asks <file>/<id> [--wait] [--timeout <min>]    prints each ask, then its answer, its deferral or "waiting on
                                                         the orchestrator"; --wait blocks until none is waiting, and
                                                         after --timeout (9) minutes says so and fails: run it again
  builder verified <file>/<id> [--agent <name>]          the session's mark that it checked the record's calls; land
         [--note <t>] [--title <t>]                      refuses while any record on the card has a call after it.
                                                         On a handed-back build (not done, no builder open, every
                                                         call verified) it finishes the card in the same step, as
                                                         builder done does, --note its closing line (else "Judgment
                                                         calls verified."). While a question on the card is open it
                                                         says so and the card waits; a finish that fails keeps the
                                                         mark, the card handed back, and says why
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
                                                         unless its full node --test suite passes, naming each failing
                                                         test and saving the TAP output under ~/.claude/kickflip/logs;
                                                         fast-forwards the branch in the repo;
                                                         restarts the hub when its code changed, else each board
                                                         server when board/ changed; removes the worktree and its
                                                         branch. Without --site it never pushes. One land runs at a time on the host: a
                                                         second refuses, naming the card landing. With --site, --text <what was checked>
                                                         is required, and once it lands the card closes as item set
                                                         --done --text does; it refuses first what that close
                                                         would. With --site it is builder done's finish: the push
                                                         after a land, and on a GitHub or plain-remote board the
                                                         branch push (and draft PR) instead of the fast-forward.
                                                         --owner-step <t>, as builder done takes it, keeps the
                                                         landed card in In Review on that step until the owner's
                                                         Done, or until its --check passes. KICKFLIP_RESTART_CMD='["<cmd>"]' replaces
                                                         the restarts, called with hub or board <route>
  merge <file>/<id> [--after-approval "<why trivial>"]   merges the card's PRs (gh pr merge --squash) in its order and
         [--confirmed "<owner's words>"]                 records it merged, once GitHub reads every open one approved,
                                                         its checks green with none pending and its merge state CLEAN,
                                                         the test the Merge button uses; a merged or closed PR is left
                                                         as it is. Refuses, naming each reason ("pending: 2 checks"),
                                                         commits after the newest approval unless --after-approval
                                                         says why they're trivial (its closing line says so), and a
                                                         card with manual steps unless --confirmed quotes the owner.
                                                         A refusal also goes in the thread while the owner's Merge waits.
                                                         On a card with no PR waiting for the owner's Merge, which
                                                         the board server runs on the tap: rebases onto the base as
                                                         it is now, reruns the tests, fast-forwards, closes the card
                                                         and pushes when Push main is on; a conflict or failing
                                                         tests launch a headless lander that lands it
  arch file <file>/<id>                                  turns the architecture review audit card's answered findings
                                                         into cards in the review's wave: titled with the picked
                                                         option's label, its detail, practice and the owner's note as
                                                         notes, each after the audit card, its question resolved
                                                         "Filed as <ref>."; a Skip pick resolves its question alone.
                                                         Prints "filed: <ref> from <id>", "skipped: <id>", and
                                                         "waiting: <ids>" while any are unanswered; once none is, it
                                                         closes the audit card as done
  push --kind fault|reminder --title <t>                 runs kickflip push with these flags, adding
       [--body <b>] [--url </route/path>]                "· and N replies" to the body for the replies
       [--tag <tag>] [--now | --urgent]                  written since the site's last push through this
                                                         command (none before its first). A session pushes only a
                                                         fault, what only the owner can fix, or a reminder the
                                                         owner asked for in words ("push me when it's all done"):
                                                         the board server pushes each card's Action needed and the
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
const BOOLEAN = new Set(['new-ticket', 'done', 'clear-status', 'clear-next', 'urgent', 'now', 'clear-eta', 'held', 'unheld', 'idle', 'wait', 'hub', 'clear-install', 'force', 'worktree', 'dispatch', 'writes', 'implement', 'close']);
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

// A command's flags, each a value, or a list for a flag its allowed list names as ...<name>, which may repeat.
function flagsOf(name, allowed, flags) {
  const repeated = new Set(allowed.filter((a) => a.startsWith('...')).map((a) => a.slice(3)));
  const known = new Set(allowed.map((a) => a.replace(/^\.\.\./, '')));
  const unknown = Object.keys(flags).filter((k) => !known.has(k));
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

const readInput = (file) => fs.readFileSync(file === '-' ? 0 : file, 'utf8');
function readJSONInput(file) {
  if (!file) throw new UsageError('--file <path> is required');
  try { return JSON.parse(readInput(file)); } catch (e) { throw new store.BoardError(`${file}: ${e.message}`); }
}

// docs/adr/2026-11-09-1100-the-board-owns-a-cards-notes-file.md: the board names a card's notes file, so neither
// item add nor item set takes one.
function refuseNotesFile(f, instead) {
  const flag = ['notes-file', 'plan'].find((name) => f[name] !== undefined);
  if (flag) throw new UsageError(`--${flag} is gone: the board names a card's notes file, <id>-notes.md, and writes it itself; ${instead}`);
}

function noteOf(f) {
  if (f.note !== undefined && f.file !== undefined) throw new UsageError('pass --note or --file, not both');
  return f.file === undefined ? f.note : readInput(f.file);
}

// name: [positional args, allowed flags (...<flag> may repeat, and run gets its values as a list), run(site, args, flags) → message]
async function builderDone(site, key, { 'owner-step': ownerStep, check, text, title, ...f }) {
  if (ownerStep !== undefined && (!site || f.dir)) throw new UsageError('--owner-step goes on a board card: pass --site, not --dir');
  if (check !== undefined && ownerStep === undefined) throw new UsageError('--check goes with --owner-step: it is the code check that closes the card once the step is done');
  if (ownerStep !== undefined) await store.setItem(site, key, { ownerStep, check });
  const onBoard = site && !f.dir;
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
  if (onBoard && text !== undefined && await store.isPlanner(site, key, f.agent)) return store.stopPlanner(site, key, { ...f, note: text, requireNext: true });
  if (text !== undefined) throw new UsageError('--text goes on a builder done that finishes the card, the main build with a worktree and no --next, or on a helper\'s or a planner\'s');
  return store.stopBuilder(site, key, { ...f, requireNext: true });
}

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
  reply: [['eventId'], ['text', 'file', 'title', 'implement', 'close'], async (site, [id], f) => {
    if ((f.text === undefined) === (f.file === undefined)) throw new UsageError('reply takes --text or --file');
    if ((f.implement || f.close) && !id.includes('/')) throw new UsageError('reply --implement and --close mark a card: name it <file>/<id>');
    if (f.implement && f.close) throw new UsageError('reply takes --implement or --close, not both');
    const md = f.text ?? readInput(f.file);
    await store.refuseUnreadEdit(site, id);
    return id.includes('/') ? store.answerCard(site, id, md, f.title, { waitsOn: f.implement ? 'implement' : f.close ? 'close' : undefined }) : store.writeReply(site, id, md, f.title);
  }],
  thread: [['file/id'], ['text', 'link', 'who', 'via', 'close'], (site, [key], f) => store.appendMessage(site, key, f)],
  'visual add': [['file/id'], ['file', 'title'], (site, [key], f) => store.addVisual(site, key, f)],
  'item brief': [['file/id'], ['kind', 'file'], (site, [key], f) => store.writeBrief(site, key, f)],
  'topic add': [['id'], ['title', 'summary'], (site, [id], f) => store.addTopic(site, { id, ...f })],
  'question add': [[], ['file'], async (site, _, f) => {
    const input = readJSONInput(f.file);
    return { ...(await store.addQuestions(site, input, process.env.KICKFLIP_RENDER_CHECK === 'off' ? undefined : checkTakesRender)), asked: [input].flat() };
  }],
  'question resolve': [['id'], ['note'], (site, [id], f) => store.resolveQuestion(site, id, f.note)],
  'question settle': [['id'], ['note'], (site, [id], f) => store.settleQuestion(site, id, f.note)],
  'question publish': [['key'], [], async (site, [key]) => ({ ids: await store.publishScreened(site, key) })],
  'question move': [['ids'], ['to', 'block'], (site, [ids], f) => store.moveQuestions(site, ids.split(',').filter(Boolean), f.to, (f.block || '').split(',').filter(Boolean))],
  'prototype add': [['topic'], ['title', '...take', 'card', 'served', '...state'], (site, [topic], f) => store.addPrototype(site, { topic, title: f.title, card: f.card, takes: f.take, served: f.served, states: f.state })],
  'prototype base': [[], [], (site) => prototypeBase(site)],
  'prototype list': [[], [], (site) => store.listPrototypes(site)],
  'prototype rm': [['topic'], [], (site, [topic]) => store.removePrototype(site, topic)],
  'item set': [['file/id'], ['done', 'split-into', 'status', 'clear-status', 'next', 'clear-next', '...pr', 'pushed', 'gh-since', 'from-ask', 'phase', 'state', 'held', 'unheld', 'pick-up-at', 'notes-file', 'plan', 'deps', 'blocked-until', 'block-reason', 'parent', 'related', 'relate', 'unrelate', 'install', 'install-sha', 'install-label', 'clear-install', 'title', 'size', 'model', 'force', 'ticket', 'new-ticket', 'text', 'check'], async (site, [key], f, options) => {
    refuseNotesFile(f, `add to its notes with item notes ${key} --heading "<heading>" --file <draft.md>`);
    if (f.done && site) await store.checkNotReopened(site, key);
    if (site && [f.phase, f.title, f.ticket, f['new-ticket']].some((v) => v !== undefined)) await store.refuseUnreadEdit(site, key);
    return store.setItem(site, key, { done: f.done, finishAsk: true, splitInto: f['split-into'], status: f.status, clearStatus: f['clear-status'], next: f.next, clearNext: f['clear-next'], pr: f.pr, pushed: f.pushed, ghSince: f['gh-since'], fromAsk: f['from-ask'], phase: f.phase, state: f.state, held: f.held, unheld: f.unheld, pickUpAt: f['pick-up-at'], deps: f.deps, blockedUntil: f['blocked-until'], blockReason: f['block-reason'], parent: f.parent, related: f.related, relate: f.relate, unrelate: f.unrelate,
      install: f.install, installSha: f['install-sha'], installLabel: f['install-label'], clearInstall: f['clear-install'], title: f.title, size: f.size, model: f.model, force: f.force, ticket: f.ticket, newTicket: f['new-ticket'], text: f.text, check: f.check }, options);
  }],
  'item add': [['file[/id]'], ['title', 'notes', 'notes-from', 'deps', 'notes-file', 'plan', 'ticket', 'new-ticket', 'pick-up-at', 'held', 'parent', 'split-of', 'size', 'model', 'phase', 'state', 'relate', 'from-ask', 'text'], (site, [key], f, options) => {
    refuseNotesFile(f, 'seed a new card\'s notes with item add --notes-from <draft.md>');
    if (f.notes !== undefined && f['notes-from'] !== undefined) throw new UsageError('pass --notes or --notes-from, not both');
    return store.addItem(site, key, { title: f.title, notes: f.notes, notesFrom: f['notes-from'], deps: f.deps, ticket: f.ticket, newTicket: f['new-ticket'], pickUpAt: f['pick-up-at'], held: f.held, parent: f.parent, splitOf: f['split-of'], size: f.size, model: f.model, phase: f.phase, state: f.state, relate: f.relate, fromAsk: f['from-ask'], text: f.text, intake: true }, options);
  }],
  'item notes': [['file/id'], ['heading', 'file', 'from'], (site, [key], f) => {
    if (f.heading === undefined && f.from === undefined) throw new UsageError('item notes needs --heading "<the section\'s title>"');
    if ((f.file === undefined) === (f.from === undefined)) throw new UsageError('item notes takes --file <draft.md> or --from <file>/<id>');
    return store.addNotes(site, key, f);
  }],
  'item relate-ask': [['eventId', 'file/id'], ['summary', 'title'], async (site, [id, key], f) => {
    await store.refuseUnreadEdit(site, id);
    return store.relateAsk(site, id, key, f.summary, f.title);
  }],
  'ask unfold': [['eventId'], [], (site, [id]) => store.unfoldAsk(site, id)],
  'ask move': [['eventId'], ['to'], (site, [id], f) => store.moveAsk(site, id, f.to)],
  'wave create': [['slug'], ['title', 'goal', '...card', 'note', 'file'], (site, [slug], f) => store.createWave(site, slug, { title: f.title, goal: f.goal, cards: f.card, note: noteOf(f) })],
  'wave add': [['slug', 'file/id'], ['after'], (site, [slug, key], f) => store.changeWave(site, slug, { add: key, after: f.after })],
  'wave remove': [['slug', 'file/id'], [], (site, [slug, key]) => store.changeWave(site, slug, { remove: key })],
  'wave set': [['slug', '...file/id?'], ['after', 'title', 'goal', 'note', 'file'], (site, [slug, ...keys], f) => {
    if (keys.length > 1) throw new UsageError('wave set takes <slug> [<file/id>]');
    return store.changeWave(site, slug, { card: keys[0], after: f.after, title: f.title, goal: f.goal, note: noteOf(f) });
  }],
  'wave finish': [['slug'], [], (site, [slug]) => store.finishWave(site, slug)],
  slack: [[], [], () => ({ lines: [JSON.stringify(readSlack())] })],
  'slack set': [[], ['self-dm', 'user', 'domain', 'timezone'], async (site, _, f) => {
    const fields = { 'self-dm': 'self_dm', user: 'owner_slack_user', domain: 'slack_domain', timezone: 'timezone' };
    try { return { lines: [JSON.stringify(await setSlack(Object.fromEntries(Object.entries(f).map(([k, v]) => [fields[k], v]))))] }; }
    catch (e) { throw new store.BoardError(e.message); }
  }],
  'slack thread': [['eventId'], [], (site, [id]) => store.slackThread(needSite(site, 'slack thread'), id)],
  'slack answer': [['eventId'], ['text'], (site, [id], f) => store.slackAnswer(needSite(site, 'slack answer'), id, f.text)],
  'slack say': [['reviewer'], ['text'], (site, [name], f) => store.slackSay(needSite(site, 'slack say'), name, f.text)],
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
  'builder done': [['file/id'], ['dir', 'agent', 'next', 'owner-step', 'check', 'text', 'title'], (site, [key], f) => builderDone(site, key, f)],
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
    if (!site && f.text !== undefined) throw new UsageError('--text closes the card, which needs --site');
    if (!site && f['owner-step'] !== undefined) throw new UsageError('--owner-step keeps a board card open, which needs --site');
    if (f.check !== undefined && f['owner-step'] === undefined) throw new UsageError('--check goes with --owner-step: it is the code check that closes the card once the step is done');
    if (site && f.dir === undefined) return finishCard(site, key, { text: f.text, ownerStep: f['owner-step'], check: f.check, repo: f.repo });
    const ref = site ? await store.cardName(site, key) : undefined;
    const ran = await joiningLand(ref ?? key, async () => {
      if (site) await store.checkClose(site, key, f.text, f['owner-step'], f.check);
      await store.checkCallsVerified(site, key, { dir: f.dir });
      const recorded = await store.recordedWorktree(site, key, { dir: f.dir });
      const { repo, base } = builderRepo(site, { repo: f.repo ?? recorded?.repo });
      await landInTurn({ path: recorded?.path ?? path.join(worktreesDir(), id), branch: recorded?.branch ?? id, repo: path.resolve(repo), base, ref });
      return site ? store.setItem(site, key, { done: true, text: f.text, ownerStep: f['owner-step'], check: f.check }) : { lines: [] };
    });
    return ran.joined ? { lines: [`joined the land already running for ${ref ?? key}`] } : ran;
  }],
  'builder stop': [['file/id'], [], (site, [key]) => stopBuilder(needSite(site, 'builder stop'), key)],
  'item stall': [['file/id'], ['reason'], (site, [key], f) => stallCard(needSite(site, 'item stall'), key, f.reason)],
  'land stop': [['file/id'], [], (site, [key]) => stopLand(needSite(site, 'land stop'), key)],
  'land queue': [[], [], () => queueLines()],
  'item bump': [['file/id'], [], (site, [key]) => bump(needSite(site, 'item bump'), key, true)],
  'item unbump': [['file/id'], [], (site, [key]) => bump(needSite(site, 'item unbump'), key, false)],
  lander: [['file/id'], [], async (site, [key]) => {
    if (!site) throw new UsageError('lander needs --site <route>');
    await store.relaunchLander(site, key);
    return { lines: [`${await store.cardName(site, key)} is handed back again; the server launches a lander for it within a minute`] };
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
const builderOf = (f) => (f.agent === undefined || f.agent === 'main' ? 'builder' : `builder ${f.agent}`);

function itemChanges(f) {
  const pickUp = f['pick-up-at'];
  return [
    f.done && (f['split-into'] ? `done, split into ${f['split-into'].split(',').join(', ')}` : 'done'),
    f.next !== undefined && (f.next.trim() ? 'next line set' : 'next line cleared'), f['clear-next'] && 'next line cleared',
    f.pr !== undefined && `PR #${f.pr}`, f.pushed !== undefined && `pushed ${f.pushed}`, f['gh-since'] && `GitHub read to ${f['gh-since']}`, f['from-ask'] && `from task ${f['from-ask']}`, f.phase,
    f.held && 'held', f.unheld && 'resumed', pickUp !== undefined && (pickUp ? `held until ${pickUp}` : 'resumed'),
    f.deps !== undefined && (f.deps ? `blocked by ${f.deps}` : 'deps cleared'),
    f.parent !== undefined && (f.parent ? `parent ${f.parent}` : 'parent cleared'), f.related !== undefined && (f.related ? `related to ${f.related.split(',').join(', ')}` : 'related cleared'),
    f.relate !== undefined && `related to ${f.relate.split(',').join(', ')} added`, f.unrelate !== undefined && `unrelated from ${f.unrelate.split(',').join(', ')}`,
    f.install !== undefined && 'install published', f['clear-install'] && 'install cleared',
    f.title !== undefined && 'renamed', f.ticket !== undefined && `ticket ${f.ticket}`, f['new-ticket'] && 'ticket made',
    f.check !== undefined && (f.check.trim() ? `check ${f.check.trim().split(/\s+/).join(' ')}` : 'check removed'),
  ].filter(Boolean).join(', ');
}

/*
 * The one line a command prints before its own lines, naming the card and what it did. A board's session adds no
 * text of its own outside a typed prompt, so these lines are what its terminal shows (bin/wait-events.mjs QUIET).
 * A command left out, such as a read, prints only its own lines.
 * name: (site, args, flags, result) → line
 */
const SAID = {
  reply: async (site, [id]) => (id.includes('/') ? `answered ${await card(site, id)}: it reads discussing, the owner's turn; ask any open point with question add, not in prose` : `reply written to ${await store.eventCard(site, id)}`),
  thread: async (site, [key]) => `thread line on ${await card(site, key)}`,
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
  'item add': async (site, _, f, { key }) => `${await card(site, key)} added as ${key}`,
  'item notes': async (site, [key], f, { file, heading }) => `${await card(site, key)}: notes section "${heading}" added to ${file}`,
  'item relate-ask': async (site, [id, key]) => `task ${id} folded into ${await card(site, key)}`,
  'ask unfold': (site, [id]) => `task ${id} back on a card of its own`,
  'ask move': (site, [id], f) => `task ${id} moved to /${f.to}`,
  'wave create': (site, [slug]) => `wave ${slug} created`,
  'wave add': async (site, [slug, key]) => `${await card(site, key)} added to wave ${slug}`,
  'wave remove': async (site, [slug, key]) => `${await card(site, key)} taken out of wave ${slug}`,
  'wave set': (site, [slug]) => `wave ${slug} updated`,
  'wave finish': (site, [slug]) => `wave ${slug} finished`,
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
  'builder answer': async (site, [key, id]) => `${await card(site, key)}: ${id} answered`,
  'builder defer': async (site, [key, id]) => `${await card(site, key)}: ${id} deferred to the owner`,
  'builder verified': async (site, [key], f, result) => `${await card(site, key)}: judgment calls verified${result?.said ? `; ${result.said}` : ''}`,
  land: async (site, [key], f, result) => (!site ? null : result?.said ? `${await card(site, key)}: ${result.said}`
    : f['owner-step'] === undefined ? `${await card(site, key)}: landed and done`
    : `${await card(site, key)}: landed; waits on the owner step "${f['owner-step'].trim()}"`),
  merge: async (site, [key], f, result) => `${await card(site, key)}: ${result?.said ?? 'merged'}`,
  'arch file': async (site, [key]) => `findings of ${await card(site, key)} filed`,
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
    const result = await run(site, args, opts, options);
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
