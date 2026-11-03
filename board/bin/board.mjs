#!/usr/bin/env node
import { readiness, reportSlack } from '../../hub/readiness.mjs';
import { readSlack, setSlack } from '../../hub/slack.mjs';
import { routeRecord } from '../../hub/routes.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as store from '../store.mjs';
import { makeWorktree, land, skillRepo, worktreesDir } from '../worktree.mjs';
import { ITEM_STATUSES } from '../domain.mjs';
import { boardAt, readManifest } from '../../hub/boards.mjs';
import { boardRepo } from '../../hub/board-repo.mjs';
import { pushKindError } from '../../hub/push.mjs';
import { migrateOnStart } from '../../bin/install.mjs';

export const USAGE = `usage: node board.mjs <command> [--site <route>] ...

Writes a kickflip board's data files. --site <route> picks ~/.claude/kickflip/sites/<route>, and its
board.json says where the board's waves live. Without --site, waves come from ~/.claude/waves.
Paths resolve under $HOME, so HOME=<dir> points every command at a copy.
A --file argument of - reads stdin.
item add and followup add create a ticket in the board’s source unless --ticket <id> links one.
Internal defaults to INT; GitHub and Linear create an issue from the title and notes, Linear in the board's team and
project through Hub's Linear key. A linked ticket must exist in the source; an Internal one no other card holds.
Asks have no ticket; item set --from-ask creates one when the card has none.
A card moves its ticket one way: --status building or fixing → In Progress, --pr → In Review, --status done or
merged → Done (a GitHub issue closes), only for a ticket assigned to the owner or created by kickflip. A ticket that
can't move prints one "ticket <id>: …" line; the card's change still stands.
A Linear board without Hub's key hands Linear to the session: a linked id is checked on its pattern alone, and a card
needing an issue, or a ticket to move, prints a "ticket" line saying what to do through your Linear MCP, such as
creating the issue and running item set <wave>/<id> --ticket <id> (followup set for a follow-up).

  reply <eventId> (--html <text> | --file <path>)        data/replies/<eventId>.html
  working <eventId>                                      marks an ask or thread message started; the page
                                                         shows "Working on it" until a reply or later thread line
  thread <wave>/<id> --text <t> [--link <url>]           one line in the item's thread; ask:<eventId> in place
         [--who claude|love|<name>] [--via github|slack] of <wave>/<id> writes in that ask's thread
         A Claude thread line, or a reply to an ask or item-message, rewrites the body of the thread's
         queued push (tag ask-<eventId> or item-<wave>/<id>) to the message's first line, keeping
         "· and N replies", and prints the new body. It never pushes: the thread's unread mark carries it
  topic add <id> --title <t> [--summary <s>]             a question topic in data/owner.json
  question add --file <json>                             one question or an array of them:
         {id, topic, question, options: [{id, label, recommended?, detail?, diagram?, practice?}],
          source?, context?, url?, urgent?, round_of?}; topic is declared, item:<wave>/<id>, item:ask:<eventId>
          for a New card not sorted yet, lineup:<slug> for a wave's triage, or wave:<slug> for a wave file's triage on
          a board over ~/.claude/waves.
         url is http(s), or a site page such as prototype-<topic>.html?q=<id>, stored as given.
         Prototype options keep take order, ids matching take keys; recommended: true tags the recommendation.
         Waiting on you shows fitting takes in a grid, or a chooser above one full-width take for a single take or if any
         scrolls or fills the screen.
         diagram, with practice: rows of 1-4 boxes [[{text, tone?, to?}]], tone quiet|info|notice|
         danger|success, to the next row's box indexes (default all); practice: ["<line>", …]
         A prototype url's topic must be recorded (prototype add), its option ids a non-empty subset of the
         take keys in take order, without repeats, and every take file written; a hand-written prototype-*.html
         is refused. A pick with a note waiting on question confirm stays as it is until an answer settles
         its round. On an item: topic, each other question answered and still waiting on Claude is
         resolved, noting "Followed by <new id>", and printed as "resolved: <old id>". Any other unresolved
         question on the same topic that links the same prototype is resolved, noting "Replaced by <new id>",
         and printed as "replaced: <old id>". round_of names the question on the same topic whose
         prototype-request this answers; the question needs a prototype url, takes the next round
         number, and resolves that one, noting "Followed by prototype round N". Answering or resolving
         a question drops its queued push tagged q-<id> on this site.
  question resolve <id> --note <text> [--no-change]      sets resolved and resolved_at; refuses a question on a
         prototype page until an answer settles its round: a pick with no note, or any answer to the
         "Is this it?" confirm that question confirm opens. A pick with a note waits on you: update the
         take, then run question confirm, or pass --no-change when the note needs no change to the take,
         which says so in the note and settles the round. A question already resolved, such as one an
         answer with a note and no option resolved, is left as it is
  question confirm <id> [--url <prototype page>]         opens the one-take "Is this it?" confirm on the take the
         owner picked with a note on prototype question <id>, once you have updated that take: same topic
         and round, on --url's recorded prototype-<topic>.html (else <id>'s), whose take files must exist.
         It resolves <id>, noting "Followed by Is this it?", and replaces an open confirm on the topic
  prototype add <topic> --title <t> --take <K>:<label>   records a prototype in data/prototypes.json: the board
         [--take <K>:<label> …] [--card <wave>/<id>]     serves prototype-<topic>.html from its one template, with
                                                         the title, a back arrow to --card (else the board), the
                                                         take pill and a stage. topic: a-z, 0-9 and "-"; K: one
                                                         capital letter, in take order; a label never starts with
                                                         "A. ", since the pill shows it alone. Prints each take
                                                         file to write,
                                                         public/prototypes/<topic>/<K>.js, which exports
                                                         render(stage, kit) (board/public/prototype-kit.js lists kit)
  prototype list                                         one line per recorded prototype
  prototype rm <topic>                                   drops the record, keeping its take files; refuses while an
                                                         open question links it
  pr <wave>/<id>                                         one JSON line: the card's PR state, checks and new events,
                                                         using the board's repo, github-login and the card's gh_since
  item set <wave>/<id> [--status <s> | --clear-status]   edits the item in its wave file
         [--next <t> | --clear-next] [--pr <n>]          status: ${ITEM_STATUSES.join(', ')}
                                                         an empty --next "" clears it, as --clear-next does
                                                         naming another unfinished card requires it in --deps
         [--gh-since <ISO time>]                         records the last handled GitHub event, an ISO-8601 UTC
                                                         time such as 2026-10-23T11:00:00Z, stored as given
         [--from-ask <eventId>]                          the ask it came from: its New card gives way to this item,
                                                         whose thread opens with the ask and its thread; it leaves
                                                         a card it was folded into
         [--held | --unheld | --pick-up-at <time>]       records the owner's card-hold in the wave file;
                                                         the board already shows it. A later --held/--unheld
                                                         overrides the tap; --unheld also clears a held status.
                                                         --pick-up-at holds it until an ISO time such as
                                                         2026-11-04T09:00 (the Mac's local time without an
                                                         offset; a past time is refused), stored as UTC
                                                         pick_up_at. Within a minute of it the board server
                                                         resumes the card, adds a thread line, and appends
                                                         card-unblocked {key, until} unless a dep is unfinished.
                                                         --held holds it with no time; --pick-up-at "" resumes it
         [--ticket <id>]                                links a ticket in the board’s source
         [--title <t>]                                   renames the card
         [--notes-file <file>]                           the item's notes: a .md file inside its wave's folder,
                                                         named relative to it, holding the session's understanding
                                                         of the task so far. The open card's Notes link opens it,
                                                         or without one the item's short notes text. --plan is an
                                                         alias. Resolves answered questions still waiting on
                                                         Claude, noting "Recorded in the card's notes", and
                                                         prints "resolved: <id>" for each, except a pick with a
                                                         note waiting on question confirm in a round no answer
                                                         has settled
         [--deps <id>,<wave>/<id>]                       replaces its blocked-by list; --deps "" clears it
         [--install <url> [--install-sha <sha>]          a device build the owner installs from the card's Install
          [--install-label <text>] | --clear-install]    button, stamped built_at now: itms-services://?action=
                                                         download-manifest&url=https://…/manifest.plist for iOS,
                                                         an https:// .apk URL for Android. --install-sha is the
                                                         head it was built from: the badge reads "Install (stale)"
                                                         once the branch moves past it. Hidden once the card is Done
         --status building refuses while the item is held or a dep isn't done, merged or dropped,
         and while the newest owner answer to its questions that link a prototype-*.html page has a
         note: post the final version with prototype add and question add first.
         [--confirmed "<owner's words>"] passes when that note itself says go: the words must quote
         it, and they go in a thread line on the card;
         done, merged and dropped print "unblocked: <wave>/<id>" and append card-unblocked {key}
         once per unblocking, including held cards: start each unheld card next.
         building and fixing count as working only while a builder record on the card is open.
         --pr clears building/fixing and closes ordinary builders; install builders keep running.
         checking is a builder's hand-back: In Progress, reading "Orchestrator review",
         until the owning session verifies it and sets done; it unblocks nothing.
         The board already shows the owner's card-done; --status done records it in the wave file.
         Every --status or --clear-status records status_at; a later status change overrides the tap.
         --status done, merged or dropped closes the card: it resolves each of its questions (topic
         item:<wave>/<id>) that has an answer, noting "Closed with the card", and prints "resolved: <id>"
         for each. It refuses while one has no answer yet; [--force] closes it and resolves that one too
  item add <wave>/<id> --title <t> [--notes <t>]          a new card, planned (waiting when it has --deps); never
         [--ticket <id>] [--deps <id>,<wave>/<id>]       hand-edit wave.json to add one. Refuses an id the wave has.
         [--notes-file <file>]                           --plan is an alias of --notes-file
         [--pick-up-at <time>]                           holds it until then, as item set's --pick-up-at
  item relate-ask <eventId> <wave>/<id> --summary <t>   folds an ask about an existing item into it: the ask's
                                                         card goes, its message and thread show in the item's
                                                         thread marked Moved, then the summary line. Again with
                                                         another item moves it there
  ask progress <eventId> [--next <text>]                 keeps an answered ask in In Review, --next as its next
                                                         line, until the owner's ask-done (Mark as done, or the Done
                                                         beside Send in its thread) or ask done is newer. Use it when the answer
                                                         waits on the owner, such as a pick between prototypes
  ask done <eventId>                                     moves the ask to Done, as the owner's Done button does
  ask unfold <eventId>                                   moves a folded ask back out to a card of its own
  ask move <eventId> --to <route>                        sends a New ask to another board in the hub's manifest:
                                                         a New card there with the owner's text, attachments and
                                                         "Moved from <this board>", which wakes its session; here the
                                                         ask goes to Done with a thread line linking to that card.
                                                         A card the ask became is dropped, unless it has started.
                                                         Refuses a route that isn't another board, and an ask
                                                         that isn't New
  hello-ack <eventId>                                    answers the hub's hello: data/handshake.json records that the
                                                         session hears the board, which clears the setup checklist's
                                                         Events step. Refuses an older hello than the newest
  checked [--every <minutes> | --idle]                   data/checked.json: GitHub was just checked, next in
                                                         <minutes> (default 30); run it at the end of each GitHub tick.
                                                         --idle: the board shows no open PR, so never late.
                                                         Then sends the queued pushes, each on its own, unless
                                                         pushes are held (overnight, snoozed, the weekend or off)
  followup add <wave> --id <id> --title <t> [--from <item id>] [--ticket <id>]
  followup done <wave> <id> [--force]                    closes the follow-up's card as item set --status done does
  followup set <wave> <id> --ticket <id>                links the follow-up's ticket in the board's source
  lineup create <slug> --title <t> --goal <t>            a wave, in the owner's words: a named set of cards in
         --cards <wave>/<id>,… (--note <t> | --file <f>)  build order, all from one wave file. Each card is then
                                                         blocked by the one before it (its other deps stay), and
                                                         the note goes to lineup-<slug>.md beside the wave file.
                                                         The board's Waves section shows it with its goal and
                                                         order, its cards carry its chip, and Notes opens the
                                                         goal, the order and the note. Refuses a card already in
                                                         another open wave. Prints the order
  lineup add <slug> <wave>/<id> [--after <wave>/<id>]    puts a card in the wave, last unless --after, and chains
                                                         the order again
  lineup remove <slug> <wave>/<id>                       takes a card out: it loses its links to the wave's cards,
                                                         and the card after it is blocked by the one before
  lineup set <slug> [--title <t>] [--goal <t>]           renames the wave, sets its goal or rewrites its note
         [--note <t> | --file <f>]
  lineup finish <slug>                                   the wave leaves the Waves section; its cards keep their
                                                         links. A wave whose cards are all Done leaves it too
         The Waves section's Triage sends wave-triage {lineup}, or {wave} for a wave file's row; the row reads
         Triaging… until you reply to that event, then "Triage: N open questions" while questions on topic
         lineup:<slug> or wave:<slug> are open or answered
  tickets backfill [--dry-run]                           gives every open card and follow-up without a ticket one: the first
                                                         id in its title (or legacy linear list) from the board's
                                                         source is linked, else a new ticket is made. Done cards are
                                                         left alone. Prints each card's result; --dry-run changes and
                                                         calls nothing
  reviewers set --file <json>                            the board's reviewers in board.json, replacing them:
                                                         [{name, slack_user, dm, github}], as in wave.json.
                                                         The settings page lists them; new waves copy them
  reviewers add --file <json>                            one reviewer or an array; replaces the same name
  reviewers remove <name>...                             refuses a name the board doesn't have
  slack                                                 Slack identity as JSON; imports slack-bridge config once
  slack set [--self-dm D..] [--user U..]                 sets hub Slack identity in ~/.claude/kickflip/slack.json
            [--domain x] [--timezone Area/City]
  review sent <wave>/<id> <reviewer> --ts <ts>           records the PR link's message in the item
              --channel <dm>
  review react <wave>/<id> <reviewer> <emoji>            records a reaction once on that reviewer's link
  integrations                                          readiness rows as one JSON line
  integrations report --slack yes|no                    with --site: reports whether this session has Claude's
                                                         Slack connector, in ~/.claude/kickflip/integrations.json
  review digest                                         pending reviews as JSON; due weekday mornings from 09:00
  review digest sent <reviewer> --ts <ts>               records a digest in data/review-digests.json;
              --channel <dm> --items <key,key>           marks today sent in the Slack identity timezone
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
                                                         "github_login": "owner"}
  settings set auto-merge on|off                         on: the session merges an approved PR once CI is green and
                                                         the merge state is CLEAN. off (the default): the card
                                                         shows the owner a Merge button, and the session merges on its
                                                         card-merge event. Board Settings' toggle writes it too
  build <wave>/<id> --site <route>                       asks the hub to run this card's .kickflip/build; prints
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
  settings set auto-pull on|off                          on: while no builder runs and nothing waits in Orchestrator
                                                         review, the board server sends card-pull {key} for the top
                                                         Todo card nothing blocks, holds or asks about. Off by default.
                                                         Only on the owner's word
  settings set tickets <json>                            the board's ticket source, as Board Settings' Tickets row
                                                         saves it: {"source":"internal","prefix":"OPS"},
                                                         {"source":"github","account":"<gh login>"} or
                                                         {"source":"linear","workspace","team","project"}. A
                                                         GitHub account runs the board's issue calls as that gh
                                                         login; without one they run as gh's active account
  builder start <wave>/<id> [--agent <name>] [--kind <opus|codex|sonnet|install|…>] [--label <who>]
         [--progress <text>] [--eta <ISO time>]          one record per agent on the item; --agent defaults to main.
                                                         --kind install: a build of the card's install, whose
                                                         Install badge reads Building… meanwhile
         [--worktree [--repo <dir>]]                     --worktree: a git worktree for the builder at
                                                         ~/.claude/kickflip/worktrees/<id> on a new branch <id> from
                                                         the board's branch of its clone (--repo overrides the clone), kept on
                                                         the record and printed as "worktree: <path>". Refuses when
                                                         that path or branch exists
  builder progress <wave>/<id> (<text> | --text <t>)     one short present-tense line
         [--agent <name>]
         [--eta <ISO time> | --clear-eta]                an ETA shows as a line under the card's status
         A progress line, --progress included, needs --site: it is a status line in the item's thread, and
         the card's status shows the newest one from an agent still working
  builder done <wave>/<id> [--agent <name>]              marks that agent's record done; the item's thread
                                                         shows when it started and finished; clears building/fixing
                                                         when the card has no open builder records left
         builder takes --dir <dir> for a wave file in <dir>; its records go in <dir>/agents
  land <wave>/<id> [--repo <dir>] [--dir <dir>]          brings the worktree its builder record keeps (else
                                                         ~/.claude/kickflip/worktrees/<id> of --repo) into main, one line
                                                         per step: refuses while it has uncommitted changes or adds no
                                                         commit; rebases onto main when main moved, refusing on a
                                                         conflict with the rebase undone; refuses unless its full
                                                         node --test suite passes, naming each failing test and
                                                         saving the TAP output under ~/.claude/kickflip/logs;
                                                         fast-forwards main in the repo;
                                                         restarts the hub when its code changed, else each board
                                                         server when board/ changed; removes the worktree and its
                                                         branch. Never pushes. KICKFLIP_RESTART_CMD='["<cmd>"]' replaces
                                                         the restarts, called with hub or board <route>
  push --kind action|prompt|fault --title <t>            runs kickflip push with these flags, adding
       [--body <b>] [--url </route/path>]                "· and N replies" to the body for the replies
       [--tag <tag>] [--now | --urgent]                  written since the site's last push through this
                                                         command (none before its first). For an item, tag it
                                                         ask-<eventId> or item-<wave>/<id>; a card whose action
                                                         changes pushes again under its tag. It records the
                                                         push in data/push-state.json only when kickflip push
                                                         succeeds, and exits with kickflip push's code.
                                                         --kind: action when a card's Action needed appears or
                                                         changes, fault for what only the owner can fix. Refused
                                                         without one: news stays on the board.
                                                         Without --now it queues until the tick ends (checked) or
                                                         the hub's next check: drafts on Ready, Merge. --now sends
                                                         at once unless pushes are held (overnight, snoozed or the
                                                         weekend): questions, steps only the owner can run,
                                                         prototypes asked for. --urgent: a production fault only;
                                                         it beats those holds. While notifications are off every
                                                         push is dropped, urgent too
         KICKFLIP_PUSH_CMD='["<cmd>","<arg>"]' replaces \`node ../../bin/kickflip.mjs push\`; the flags follow it`;

class UsageError extends Error {}
const BOOLEAN = new Set(['clear-status', 'clear-next', 'urgent', 'now', 'clear-eta', 'held', 'unheld', 'idle', 'hub', 'clear-install', 'force', 'worktree', 'dry-run', 'no-change']);
const REPEATED = new Set(['take']);
const KICKFLIP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'kickflip.mjs');

function pushCommand() {
  if (!process.env.KICKFLIP_PUSH_CMD) return [process.execPath, KICKFLIP, 'push'];
  try {
    const cmd = JSON.parse(process.env.KICKFLIP_PUSH_CMD);
    if (Array.isArray(cmd) && cmd.length && cmd.every((a) => typeof a === 'string')) return cmd;
  } catch {}
  throw new store.BoardError('KICKFLIP_PUSH_CMD must be a JSON array of strings');
}

async function push(site, f) {
  const refused = pushKindError(f.kind);
  if (refused) throw new UsageError(refused);
  if (f.title === undefined) throw new UsageError('push needs --title');
  const at = new Date();
  const n = await store.repliesSincePush(site, at);
  const body = store.withReplies(f.body, n);
  const flags = { kind: f.kind, title: f.title, body: body || undefined, url: store.pushUrl(f.url), tag: f.tag };
  const [cmd, ...pre] = pushCommand();
  const args = [...pre, ...Object.entries(flags).flatMap(([k, v]) => (v === undefined ? [] : [`--${k}`, v])), ...(f.urgent ? ['--urgent'] : []), ...(f.now ? ['--now'] : [])];
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw Object.assign(new store.BoardError(`kickflip push failed (${r.error?.message || `exit ${r.status ?? r.signal}`}); the push was not recorded`), { exitCode: r.status || 1 });
  return store.recordPush(site, at);
}

function parse(argv) {
  const flags = Object.create(null);
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const name = a.slice(2);
    if (REPEATED.has(name)) {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
      (flags[name] ||= []).push(argv[++i]);
      continue;
    }
    if (Object.hasOwn(flags, name)) throw new UsageError(`--${name} is given twice`);
    if (BOOLEAN.has(name)) flags[name] = true;
    else if (i + 1 < argv.length) flags[name] = argv[++i];
    else throw new UsageError(`--${name} needs a value`);
  }
  return { flags, rest };
}

/*
 * Flags whose value is shown to the owner as written. A bare file path there is a slip that posts
 * the path itself (a reply once read "/private/tmp/…/exp-reply.html"), so it is refused: one
 * token that names an existing file, or that looks like a path to a document.
 */
const TEXT_FLAGS = ['html', 'text', 'note', 'notes', 'summary', 'title', 'body', 'next', 'progress', 'install-label', 'confirmed', 'asked'];
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

// --plan names the notes file in calls written before it was called --notes-file.
function notesFileOf(f) {
  if (f.plan !== undefined && f['notes-file'] !== undefined) throw new UsageError('pass --notes-file or --plan, not both');
  return f['notes-file'] ?? f.plan;
}

function noteOf(f) {
  if (f.note !== undefined && f.file !== undefined) throw new UsageError('pass --note or --file, not both');
  return f.file === undefined ? f.note : readInput(f.file);
}

// name: [positional args, allowed flags, run(site, args, flags) → message]
const COMMANDS = {
  pr: [['wave/id'], [], async (site, [key]) => ({ lines: [JSON.stringify(await store.prReport(site, key))] })],
  reply: [['eventId'], ['html', 'file'], (site, [id], f) => {
    if ((f.html === undefined) === (f.file === undefined)) throw new UsageError('reply takes --html or --file');
    return store.writeReply(site, id, f.html ?? readInput(f.file));
  }],
  thread: [['wave/id'], ['text', 'link', 'who', 'via'], (site, [key], f) => store.appendThread(site, key, f)],
  'topic add': [['id'], ['title', 'summary'], (site, [id], f) => store.addTopic(site, { id, ...f })],
  'question add': [[], ['file'], (site, _, f) => store.addQuestions(site, readJSONInput(f.file))],
  'question resolve': [['id'], ['note', 'no-change'], (site, [id], f) => store.resolveQuestion(site, id, f.note, { noChange: f['no-change'] })],
  'question confirm': [['id'], ['url'], (site, [id], f) => store.confirmQuestion(site, id, f.url)],
  'prototype add': [['topic'], ['title', 'take', 'card'], (site, [topic], f) => store.addPrototype(site, { topic, title: f.title, card: f.card, takes: f.take })],
  'prototype list': [[], [], (site) => store.listPrototypes(site)],
  'prototype rm': [['topic'], [], (site, [topic]) => store.removePrototype(site, topic)],
  'item set': [['wave/id'], ['status', 'clear-status', 'next', 'clear-next', 'pr', 'gh-since', 'from-ask', 'held', 'unheld', 'pick-up-at', 'notes-file', 'plan', 'deps', 'install', 'install-sha', 'install-label', 'clear-install', 'title', 'force', 'ticket', 'confirmed'], (site, [key], f, options) =>
    store.setItem(site, key, { status: f.status, clearStatus: f['clear-status'], next: f.next, clearNext: f['clear-next'], pr: f.pr, ghSince: f['gh-since'], fromAsk: f['from-ask'], held: f.held, unheld: f.unheld, pickUpAt: f['pick-up-at'], notesFile: notesFileOf(f), deps: f.deps,
      install: f.install, installSha: f['install-sha'], installLabel: f['install-label'], clearInstall: f['clear-install'], title: f.title, force: f.force, ticket: f.ticket, confirmed: f.confirmed }, options)],
  'item add': [['wave/id'], ['title', 'notes', 'deps', 'notes-file', 'plan', 'ticket', 'pick-up-at'], (site, [key], f, options) => store.addItem(site, key, { title: f.title, notes: f.notes, deps: f.deps, notesFile: notesFileOf(f), ticket: f.ticket, pickUpAt: f['pick-up-at'] }, options)],
  'item relate-ask': [['eventId', 'wave/id'], ['summary'], (site, [id, key], f) => store.relateAsk(site, id, key, f.summary)],
  'ask progress': [['eventId'], ['next'], (site, [id], f) => store.markAsk(site, id, 'progress', f.next)],
  'ask done': [['eventId'], [], (site, [id]) => store.markAsk(site, id, 'done')],
  'ask unfold': [['eventId'], [], (site, [id]) => store.unfoldAsk(site, id)],
  'ask move': [['eventId'], ['to'], (site, [id], f) => store.moveAsk(site, id, f.to)],
  'followup add': [['wave'], ['id', 'title', 'from', 'ticket'], (site, [wave], f, options) => store.addFollowup(site, wave, f, options)],
  'tickets backfill': [[], ['dry-run'], (site, _, f, options) => store.backfillTickets(site, { dryRun: f['dry-run'] }, options)],
  'followup done': [['wave', 'id'], ['force'], (site, [wave, id], f) => store.finishFollowup(site, wave, id, { force: f.force })],
  'followup set': [['wave', 'id'], ['ticket'], (site, [wave, id], f) => store.setFollowupTicket(site, wave, id, f.ticket)],
  'lineup create': [['slug'], ['title', 'goal', 'cards', 'note', 'file'], (site, [slug], f) => store.createLineup(site, slug, { title: f.title, goal: f.goal, cards: f.cards, note: noteOf(f) })],
  'lineup add': [['slug', 'wave/id'], ['after'], (site, [slug, key], f) => store.changeLineup(site, slug, { add: key, after: f.after })],
  'lineup remove': [['slug', 'wave/id'], [], (site, [slug, key]) => store.changeLineup(site, slug, { remove: key })],
  'lineup set': [['slug'], ['title', 'goal', 'note', 'file'], (site, [slug], f) => store.changeLineup(site, slug, { title: f.title, goal: f.goal, note: noteOf(f) })],
  'lineup finish': [['slug'], [], (site, [slug]) => store.finishLineup(site, slug)],
  slack: [[], [], () => ({ lines: [JSON.stringify(readSlack())] })],
  'slack set': [[], ['self-dm', 'user', 'domain', 'timezone'], async (site, _, f) => {
    const fields = { 'self-dm': 'self_dm', user: 'owner_slack_user', domain: 'slack_domain', timezone: 'timezone' };
    try { return { lines: [JSON.stringify(await setSlack(Object.fromEntries(Object.entries(f).map(([k, v]) => [fields[k], v]))))] }; }
    catch (e) { throw new store.BoardError(e.message); }
  }],
  integrations: [[], [], async () => ({ lines: [JSON.stringify(await readiness.rows())] })],
  'integrations report': [[], ['slack'], async (site, _, f) => {
    if (!['yes', 'no'].includes(f.slack)) throw new UsageError('integrations report takes --slack yes|no');
    if (!site) throw new store.BoardError('integrations report needs --site <route>');
    const route = path.basename(site);
    reportSlack(f.slack === 'yes', { route, title: readManifest().sites?.[route]?.title || (await store.boardConfig(site)).title });
    return { lines: [`Slack connector reported: ${f.slack}.`] };
  }],
  'review sent': [['wave/id', 'reviewer'], ['ts', 'channel'], (site, [key, name], f) => store.reviewSent(site, key, name, f)],
  'review react': [['wave/id', 'reviewer', 'emoji'], [], (site, [key, name, emoji]) => store.reviewReact(site, key, name, emoji)],
  'review digest': [[], [], async (site, _, f, options) => ({ lines: [JSON.stringify(await store.reviewDigest(site, options))] })],
  'review digest sent': [['reviewer'], ['ts', 'channel', 'items'], (site, [name], f, options) => store.reviewDigestSent(site, name, f, options)],
  'reviewers set': [[], ['file'], (site, _, f) => store.setReviewers(site, readJSONInput(f.file))],
  'reviewers add': [[], ['file'], (site, _, f) => store.addReviewers(site, readJSONInput(f.file))],
  'reviewers remove': [['...name'], [], (site, names) => store.removeReviewers(site, names)],
  'rules list': [[], [], (site) => store.listRules(site)],
  'rules add': [[], ['text', 'hub', 'by'], (site, _, f) => store.addRuleTo(site, f)],
  'rules edit': [['id'], ['text', 'hub'], (site, [id], f) => store.editRuleIn(site, id, f)],
  'rules remove': [['id'], ['hub'], (site, [id], f) => store.removeRuleFrom(site, id, f)],
  settings: [[], [], async (site) => ({ lines: [JSON.stringify(await store.readBoardSettings(site))] })],
  build: [['wave/id'], ['asked'], async (site, [key], f) => {
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
      return { lines: ['started', ...(await store.appendThread(site, key, { text: line })).lines] };
    } catch (e) {
      if (e instanceof store.BoardError) throw e;
      throw new store.BoardError(`Could not start the build: ${e.message}`);
    }
  }],
  'main set': [[], ['install', 'install-sha'], (site, _, f) => store.setMainInstall(site, { install: f.install, installSha: f['install-sha'] })],
  'settings set': [['name', 'value'], [], (site, [name, value]) => store.setBoardSetting(site, name, value)],
  'builder start': [['wave/id'], ['label', 'progress', 'dir', 'agent', 'kind', 'eta', 'worktree', 'repo'], (site, [key], { worktree, repo, ...f }) => {
    if (repo !== undefined && !worktree) throw new UsageError('--repo goes with --worktree');
    const manifest = readManifest();
    const board = site ? boardAt(site, manifest) : null;
    const chosen = board ? boardRepo(board.route, manifest) : {};
    const remote = Boolean(chosen.github) && !chosen.hub;
    const source = repo ?? (remote ? chosen.repo || undefined : undefined);
    const base = remote ? chosen.branch || 'main' : 'main';
    return store.startBuilder(site, key, { ...f, worktree: worktree && (() => makeWorktree(key.split('/')[1], { repo: source, base, remote })) });
  }],
  'builder progress': [['wave/id', '...text?'], ['text', 'dir', 'agent', 'eta', 'clear-eta'], (site, [key, ...words], f) => {
    if (words.length && f.text !== undefined) throw new UsageError('builder progress takes its text once: as words or as --text');
    if (!words.length && f.text === undefined) throw new UsageError('builder progress needs its text, as words or as --text');
    return store.builderProgress(site, key, f.text ?? words.join(' '), { ...f, clearEta: f['clear-eta'] });
  }],
  'builder done': [['wave/id'], ['dir', 'agent'], (site, [key], f) => store.stopBuilder(site, key, f)],
  land: [['wave/id'], ['repo', 'dir'], async (site, [key], f) => {
    const id = key.split('/')[1];
    const recorded = await store.recordedWorktree(site, key, { dir: f.dir });
    const repo = path.resolve(f.repo ?? recorded?.repo ?? skillRepo());
    land({ path: recorded?.path ?? path.join(worktreesDir(), id), branch: recorded?.branch ?? id, repo });
    return { lines: [] };
  }],
  working: [['eventId'], [], (site, [id]) => store.setWorking(site, id)],
  'hello-ack': [['eventId'], [], (site, [id]) => store.ackHello(site, id)],
  checked: [[], ['every', 'idle'], (site, _, f) => store.writeChecked(site, f.every, { idle: f.idle })],
  push: [[], ['kind', 'title', 'body', 'url', 'tag', 'urgent', 'now'], (site, _, f) => push(site, f)],
};

COMMANDS.install = COMMANDS.build;

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
    const { site: route, ...opts } = flags;
    const unknown = Object.keys(opts).filter((k) => !allowed.includes(k));
    if (unknown.length) throw new UsageError(`${name} does not take ${unknown.map((k) => '--' + k).join(', ')}`);
    checkInputs(allowed, opts);
    const site = route === undefined ? null : await store.siteDir(route);
    const result = await run(site, args, opts, options);
    const { file, lines = [] } = typeof result === 'object' && result ? result : { file: result };
    // A read, such as rules list, names no file and prints only its lines.
    if (name.startsWith('builder ')) console.log(`${name.slice(8)} ${args[0]}`);
    else if (file !== undefined) console.log(`${name} → ${file}`);
    for (const line of lines) console.log(line);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) { console.error(`${e.message} (node board.mjs --help lists the commands)`); return 2; }
    if (e instanceof store.BoardError) { console.error(e.message); return e.exitCode ?? 1; }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  migrateOnStart();
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') console.log(USAGE);
  else process.exitCode = await main(argv);
}
