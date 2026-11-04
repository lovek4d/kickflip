#!/usr/bin/env node
// Shared board server for kickflip sites: node board/server.mjs <site dir>. The hub
// runs it with PORT and PREFIX (/<route>) set, and strips the prefix before forwarding.
// It writes page events, hidden events, uploads and the owner's card taps; agent sessions write the other files
// below through bin/board.mjs (store.mjs):
//   reply, thread, topic add, question add|resolve, prototype add|rm, item add|set|relate-ask, ask progress|done,
//   lineup create|add|remove|set|finish,
//   builder start|progress|done (bin/agent.mjs is an alias for builder), main set.
// <site dir>/board.json: {title, items, slug, reviewers, rules, auto_merge, auto_build, auto_pull, max_implementers, auto_triage, auto_review, idle_notification, skip_draft, prs, github_login}. auto_build asks the hub to
// run each card's .kickflip/build after each push, and hides the cards' Serve / Build; main always builds after a merge.
// auto_merge (false when absent) lets the session merge
// an approved, green, clean PR itself; off, the card shows the owner's Merge (store.mjs settingsOf). rules are the owner's standing instructions to this
// board's session [{id, text, by, at}] (board.mjs rules, hub/rules.mjs). reviewers are the board's own [{name, slack_user, dm,
// github}] (board.mjs reviewers), which the settings page lists and new waves copy. items is "waves" (every ~/.claude/waves/*/wave.json,
// the default) or a wave.json-format file relative to the site dir; slug names a file's items
// (its keys are <slug>/<id>), defaulting to the file's basename. An item's review_link_ts maps
// reviewer names to {ts, channel, reactions?}; review.mjs also reads older sent-link records. from_ask names the ask event that created the item,
// and next is Claude's next step for it. install {url, label?, built_at, sha?} is a device build the card's Install
// button opens (board.mjs item set --install); public/installs/ holds its files, served without a login like all of
// public/, since iOS's installer fetches the manifest and .ipa with no cookies. A builder working on an item has a record in
// agents/<id>.json (or agents/<id>@<agent>.json for each further agent) beside the wave file. An item's parent is the key of the card it was spun out of, which makes it a follow-up, and
// its related the keys of cards it is Related to; a wave's older followups list moves into its items as the server
// starts (store.mjs migrateFollowups). A wave's lineups [{slug, title, goal,
// phases: [[id]] (or a chain's items: [id]), finished_at?}] are the owner's waves over its cards (store.mjs createLineup). domain.mjs
// decides lanes and card state from what this server reads.
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
//                                per-item review_link_ts and legacy ~/.claude/slack-bridge/topics/*.json fallbacks,
//                                data/owner.json and GitHub (gh, cached for 45 s).
//                                owner.json: {topics: [{id, title, summary}], items: [{id, topic,
//                                question, context, url, options, urgent, asked_at, resolved, resolved_at, round, round_of, confirm_of}]};
//                                Waiting on you shows an open `urgent` question alone, first
//                                checks comes from data/checked.json (board.mjs checked),
//                                whether the board hears its events (../hub/boards.mjs listenState) and Claude's latest writes;
//                                an ask's In Progress mark from data/ask-progress.json (board.mjs ask).
//                                links: [{link, ok, detail, state, since?}], whether each hub link reaches this
//                                board, state reading broken only past the link's grace period
//                                (../hub/boards.mjs linksOf), null when the manifest has no board here; setup:
//                                {events, github} while the join handshake's checklist shows, else null
//                                arch: the header bulb's {repo, waits, last} (arch-review.mjs archOf), null off the manifest
//                                onHost: whether this request's browser runs on the hub's machine (on-host.mjs fromHost);
//                                a work card's worktree is its builder's worktree path while that folder exists, else null.
//                                owner leaves resolved questions out; ownerTopics still lists and counts them (pageBoard).
//                                version tags everything but generatedAt and is the ETag: a request whose If-None-Match
//                                names it answers 304 with no body (docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md)
//                                ?since=<version>: while the server keeps that version's board, the answer is a patch
//                                from it, {since, version, generatedAt, set, unset, lists} (public/ui-patch.js); else the
//                                whole board. A card's question topic names its card as card and leaves its title to it
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
//   GET  /api/thread?key=w/id    data/threads/<w>__<id>.jsonl ({ts, who, text, link, via}; who is
//                                claude, love or a reviewer's name; via github or slack) plus the page's own
//                                events for that key, its from_ask ask and the asks folded into it (data/ask-links.json),
//                                each with its own thread, and a line for
//                                each builder record's start and finish, oldest first; hidden events are left out. key ask:<event id> is that ask's thread:
//                                the ask, a link line for each work item made from it (from_ask) or related to it
//                                (data/ask-links.json), then data/threads/ask__<event id>.jsonl and item-message
//                                events whose key is ask:<event id>
//   GET  /api/notes?item=w/id    {key, ref, title, markdown}: the item's notes file, only a .md inside its wave's
//                                folder, or with no file its short notes text (store.mjs readNotes); otherwise 404
//                                {error}. /api/plan is the same, for pages loaded before the rename
//   GET  /api/notes?wave=<slug>  {title, markdown}: a lineup's goal, order and note (store.mjs readLineupNotes)
//   GET  /plan.html?…            redirects to notes.html with the same query, since pushes and threads link it
//   POST /_claude/events         {kind, ...data} → one line in data/events.jsonl; wakes Claude. → {id, board}: the
//                                event's id and /api/board's answer as the tap left it, version included, so the page draws the tap from
//                                the one round trip (docs/adr/2026-11-03-0500-every-owner-tap-the-server-can-apply-draws-at-once.md);
//                                with since: <version>, which isn't recorded, that board is a patch from it as ?since= gives
//                                ask, item-message and owner-answer may carry files: [upload]
//                                An owner-answer with a note and no take resolves its question (store.mjs
//                                resolveNoteAnswers). One to a card's prototype question that picks no take is
//                                recorded with prototype_again: true: the card reads prototyping with Next "Prototype
//                                again", and the session draws the next round (domain.mjs picksNoTake).
//                                owner-answers {answers: [owner-answer data]} is Waiting on you's Send: one owner-answer
//                                line per answer, appended in one write with each answer's side effects → {ids, board};
//                                an answer naming no question in owner.json, or none at all, → 400 {error} and nothing
//                                recorded (docs/adr/2026-11-03-1519-send-records-every-ready-answer-in-one-request.md).
//                                prototype-request {key?, text?, files?, question?, note?, choice?} and grill-more {key, text?, files?}
//                                ask for prototypes or a grill of a card, with the owner's text, or prototypes of one
//                                question, which reads requested until a question naming it in round_of resolves it
//                                (domain.mjs ownerQuestion). The server appends prototype-overdue {key, request,
//                                question?, since} once per request still waiting on its prototype after
//                                PROTOTYPE_WAIT with no prototype agent running on the card (domain.mjs prototypeWaits).
//                                Either one on a card launches a headless planner on it (startPlanner) unless an
//                                agent already works on it, so the session acts only on prototype-overdue.
//                                reask-request {key?, question} asks the session to ask a resolved question again from the
//                                card's current notes; one naming a question that isn't resolved → 400 {error}. The
//                                question reads reask until question add names it in reask_of (domain.mjs ownerQuestion)
//                                builder-nudge {key} asks the session to check a builder. The server also appends
//                                builder-stalled {key, silentSince} once per silent spell, tracked in data/builder-stalled.json
//                                item set appends card-unblocked {key} when a waiting card's last dep finishes,
//                                including held cards, so the owning session hears it whoever ran the command.
//                                reviewers {add?: [name], remove?: [name]} is Board settings' reviewers Save: the server
//                                removes the names from board.json and unfinished waves itself (store.mjs removeReviewers)
//                                and appends reviewers-removed {remove}, a record the session doesn't act on; names to add
//                                are appended as reviewers {add} for the session. An unknown name or a list that isn't
//                                one → 400 {error} and nothing recorded.
//                                card-bump {key} and card-unbump {key} are a work card's bump icon, sent with no confirm.
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
//                                On a card an unfinished dep blocks, the tap queues the build instead (queued_at, no
//                                event), and once nothing blocks it and an implementer slot is free the server starts
//                                it the same way, from the top of In Progress's Queued section (checkAuto, store.mjs
//                                startQueuedBuild; docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md,
//                                docs/adr/2026-11-04-0121-in-progress-has-a-queued-section.md).
//                                A
//                                checking card whose calls are all verified and that has no open question gets one
//                                headless lander per verification, tracked in data/landers.json (store.mjs landable;
//                                docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md,
//                                docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md).
//                                lineup-move {lineup, key, by: -1 | 1} is a wave band card's ⋯ Move up or Move down: the
//                                server reorders the lineup's Todo cards (domain.mjs lineupMoved, store.mjs changeLineup)
//                                and answers {id: null, board}, appending no event; a move it can't make → 400 {error}.
//                                card-hold and card-done are written to the wave file first, with the owner's thread
//                                line, and a Done unblocks waiting cards (store.mjs recordOwnerTap); one whose wave
//                                file couldn't be written, or whose card is merged or dropped, → 400 or 500 {error}
//                                and no event (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
//                                ask-withdrawn {id, key?} also hides that event (POST /api/hide), in the one request.
//                                An owner-answer that leaves an unstarted card with nothing stopping it appends
//                                card-unblocked {key} (domain.mjs startedByAnswer).
//                                Each new or changed Action needed, and each topic's new open questions, push the
//                                owner, one tag per card (domain.mjs ownerActions), tracked in data/action-pushes.json;
//                                a gone one drops its queued push.
//                                Within a minute of a held card's until or pick_up_at the server resumes it
//                                (store.mjs pickUp), at most once per time even across a restart.
//                                The Auto jobs below run on every board change and once at start, and on the minute
//                                check only once a usage pause lifts or while an overnight triage is due. With auto_pull on (Auto implement Todo
//                                cards), the server starts and launches the build of the top pullable Todo cards, one per
//                                implementer slot max_implementers leaves free (domain.mjs pullOf), whether or not
//                                the board is idle, each once, tracked in data/pulled.json, its record dispatched:
//                                'hub'; with nothing to pull, an idle board launches a planner on the top plannable
//                                card, a prototype when it is prototyping and a grill otherwise, one at a time,
//                                tracked in data/planned.json. Neither appends an event.
//                                With auto_triage on, once a night from the middle of the hub's quiet hours to their
//                                end, an idle board with two or more cards waiting on open questions (domain.mjs
//                                triageOf) gets overnight-triage {date, topic, cards} first, unless nothing changed
//                                since the last triage, tracked in data/triaged.json; no pull goes out until Claude
//                                replies to it
//                                With auto_review on, an idle board with nothing pulled sends pr-review {pr, head, repo,
//                                title, author, url, touches, asked} for the next incoming PR the hub's poll listed in
//                                data/incoming.json (../hub/incoming.mjs) and no review covers at its head, one at a
//                                time: it reads reviewing until `board.mjs review record` writes data/reviews.json
//                                (auto-review.mjs reviewsOf). review-answer {pr, answer: post|skip} is the owner's tap
//                                on a review held for them
//                                Each card that joins the list of cards idle on the orchestrator (domain.mjs
//                                orchestratorWaits), kept in data/orchestrator-waits.json for the watcher, appends
//                                orchestrator-waits {added: [key]}, and one left 30 minutes not picked up pushes the
//                                owner once (checkWaits), checked on every board change and each minute
//                                With idle_notification on, a board strictly idle for 15 minutes (domain.mjs
//                                strictlyIdle) pushes "<board> has gone idle" once per idle stretch, checked on every
//                                board change and each minute, tracked in data/idle.json (checkIdle)
//   POST /api/upload             the raw file as the body, its name URI-encoded in x-filename and its
//                                type in content-type → data/uploads/<ms>-<safe name>, returning the
//                                upload {name, url, path, type, size}: url is relative to the site
//                                (uploads/<file>) and path is absolute. Over 20 MB → 413
//   GET  /uploads/<file>         a stored upload with its type; nothing else under data/ is served
//   POST /api/arch-review        {} starts an architecture review of the board's repo (arch-review.mjs startReview) and appends
//                                arch-review {key, repo, github, branch, wave, lineup, scope?} → {key, id, existing: false};
//                                while a review is open → {key, ref, existing: true}; a review that must wait → 409 {error}
//   POST /api/hide               {id, hidden} → data/hidden.json; the page clears an event for
//                                every device, without waking Claude
//   GET  /api/rules              {board, hub}: board.json's rules and the hub's from settings.json (hub/rules.mjs)
//   POST /api/rules              {rules: [{id?, text}], base: [id]} → board.json's rules (store.mjs saveBoardRules), and
//                                when anything changed a `rules {scope: "board", added, edited, removed}` event, which
//                                wakes Claude. → {rules, id}; a bad list → 400 {error}
//   GET  /api/settings           the board's settings, {auto_merge, auto_build, auto_pull, max_implementers, auto_triage, auto_review, idle_notification, skip_draft, prs} (store.mjs readBoardSettings)
//   POST /api/settings           {auto_merge?: boolean, auto_build?: boolean, auto_pull?: boolean, max_implementers?: 1..99, auto_triage?: boolean, auto_review?: boolean, idle_notification?: boolean, skip_draft?: boolean, prs?: boolean} → board.json, keeping its other keys, and when a value other
//                                than idle_notification moved a `settings {<changed setting>: value}` event, which wakes Claude, then, when auto_merge turned on,
//                                `check-github {reason: "auto-merge"}` for one GitHub tick. → {settings, id}; a bad body → 400 {error}
//   GET  /api/permissions        {owner, file, permissions: [{id, name, allows, rule, on, refused}]}: the board's session
//                                permissions, read from its folder's .claude/settings.local.json (permissions.mjs); 404 off the manifest
//   POST /api/permissions        {id, on} from the signed-in owner (on-host.mjs fromOwner) → that rule written or removed,
//                                and the same answer; 403 {error} from anyone else, 400 {error} for a bad body or settings file
//   POST /api/try                {key}: forwards a card build or main retry to the hub's loopback /_hub/build
//   POST /api/try/main/pull      {}: Main's refresh icon, forwarded to the hub's loopback /_hub/pull → {commits, error?}
//   GET  /api/log?file=<name>.log {text, truncated, size}: the last 256 KiB of that file in ~/.claude/kickflip/logs, by name
//                                only; the board's reader sheet (app-reader.js) and log.html show it and re-read it while it grows
//   GET  /api/try/main/log      {lines}: last 40 lines of main's log, from at most its last 64 KiB
// data/try.json is the hub's run state; data/main.json holds main's published install link.
//   GET  /_claude/events         events not hidden, newest first, each with Claude's reply if written
//   GET  /_claude/needs          {items: [{kind, text, url}], working, summary, lanes: {review, progress, todo}, building}:
//                                one item per Needs you line, each pending prompt of this board's session among them
//                                (../hub/prompts.mjs), the count of events Claude is working on, a one-line
//                                summary, the open cards in each lane, and whether a builder works on a card
//                                (domain.mjs needsAnswer); the hub badges the site's row and writes its status line with them
//   GET  /api/stream             server-sent events: `event: change` shortly after a file the board reads changes, under
//                                the wave files' folder or data/. Never gzipped
//   GET  /_claude/health
// Every non-GET/HEAD request passes ../starter/cross-site.mjs before routing (403 plain text).
// Routes that parse JSON require application/json; /api/upload keeps the file's content type.
// Claude's reply to event <id> is data/replies/<id>.html, or .json.
import { topicItems } from './review.mjs';
import { boardWorktree } from './worktree.mjs';
import { fromHost, fromOwner } from './on-host.mjs';
import { archOf, readReviews, repoName, startReview } from './arch-review.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { archivedOf, buildBoard, withHub, DONE_KEPT, ORCHESTRATOR_PUSH_AFTER, orchestratorWaits, PROTOTYPE_WAIT, prototypeWaits, idleStep, idleSummary, ITEM_EVENTS, lineupMoved, slimDone, needsAnswer, ownerActions, picksNoTake, pullOf, refOf, startedByAnswer, strictlyIdle, threadOf, triageOf } from './domain.mjs';
import { localDay, quietMiddleOf, quietOf } from '../hub/schedule.mjs';
import { cardPRs, prKeyOf } from '../shared/card-prs.mjs';
import { dropQueued } from '../hub/push.mjs';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, statSync, watch as watchFiles } from 'node:fs';
import { BOARD_CLI, launchBuilder, pidAlive, reviveBuilders } from './headless.mjs';
import { BoardError, heldMerge, opensPRs, tapMerge, addTopic, appendThread, archiveCards, archiveCount, archiveRank, readArchive, boardConfig, changeLineup, abandonLaunch, abandonPlanner, landable, relaunchLander, migrateFollowups, startPlanner, stripDeadFields, pickUp, startQueuedBuild, startTappedBuild, sendPush, recordOwnerTap, mergeCard, readPrototypes, takeFile, finishHandshake, itemSources, readAskLinks, readAskProgress, readBoardRules, readBoardSettings, readHandshake, readHidden, readLineupNotes, readNotes, readWorking, readUpload, removeReviewers, resolveNoteAnswers, saveBoardRules, saveBoardSettings, saveUpload, setHidden, settingsOf, threadFile as siteThreadFile, wavesDir } from './store.mjs';
import { changed as rulesChanged, readHubRules } from '../hub/rules.mjs';
import { boardAt, listenState, linksOf } from '../hub/boards.mjs';
import { pendingFor, shown } from '../hub/prompts.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { CHOICES, FOREVER, durationEnd } from '../hub/duration.mjs';
import { VIEW_PAGES, shellHtml } from '../hub/shell.mjs';
import { crossSite, isJSON } from '../starter/cross-site.mjs';
import { readUsageGate } from '../shared/usage-gate.mjs';
import { reviewWaits } from '../shared/skills.mjs';
import { boardRepo } from '../hub/board-repo.mjs';
import { permissionsView, setPermission } from './permissions.mjs';

const template = path.dirname(fileURLToPath(import.meta.url));
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
const here = path.resolve(process.argv[2] || process.cwd());
const roots = [path.join(here, 'public'), path.join(template, 'public'), path.join(template, '..', 'starter', 'public'), path.join(template, '..', 'shared')];
const data = path.join(here, 'data');
const events = path.join(data, 'events.jsonl');
const replies = path.join(data, 'replies');
const port = Number(process.env.PORT || 4600);
const prefix = (process.env.PREFIX || '').replace(/\/+$/, '');
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
  if (!['GET', 'HEAD'].includes(res.req?.method)) dataVersion++;
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
const versionOf = (st) => `${Math.floor(st.mtimeMs).toString(36)}-${st.size.toString(36)}`;
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

// Every page event, and the server's own such as a rules save, is one line here, which wakes the watcher. → its id
const appendEvent = async (kind, data) => (await appendEvents([[kind, data]]))[0];
// [[kind, data]] → their ids, every line in one append.
async function appendEvents(list) {
  const ts = new Date().toISOString();
  const lines = list.map(([kind, data]) => ({ id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), ts, kind, data }));
  await fs.mkdir(replies, { recursive: true });
  await fs.appendFile(events, lines.map((e) => JSON.stringify(e) + '\n').join(''));
  return lines.map((e) => e.id);
}

// Owner answers [{id, ...}] → their event ids, appended in one write. An answer to a card's prototype question that
// picks no take carries prototype_again: true, which asks the session for the next round
// (docs/adr/2026-11-03-1646-a-prototype-answer-with-no-pick-prototypes-again.md). A note with no take resolves its question, and an
// answer that leaves an unstarted card with nothing stopping it appends card-unblocked for that card once.
async function recordAnswers(answers) {
  const asked = new Map(((await readJSON(path.join(data, 'owner.json'), { items: [] })).items || []).map((q) => [q.id, q]));
  const again = (a) => asked.has(String(a.id)) && picksNoTake(asked.get(String(a.id)), a.choice);
  const ids = await appendEvents(answers.map((a) => ['owner-answer', again(a) ? { ...a, prototype_again: true } : a]));
  await resolveNoteAnswers(here, answers);
  dataVersion++;
  // docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md
  const built = await sharedBoard();
  const started = [...new Set(answers.map((a) => startedByAnswer(built, String(a.id))).filter(Boolean))];
  if (started.length) await appendEvents(started.map((key) => ['card-unblocked', { key }]));
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

async function withReply(e) {
  for (const ext of ['html', 'json']) {
    const f = path.join(replies, `${e.id}.${ext}`);
    try {
      const [text, st] = await Promise.all([fs.readFile(f, 'utf8'), fs.stat(f)]);
      return { ...e, reply: { [ext]: ext === 'json' ? JSON.parse(text) : text, at: st.mtime.toISOString() } };
    } catch {}
  }
  return { ...e, reply: null };
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

// GitHub PR state, refreshed in the background when the board is read and the
// entry is older than 45 s. A PR's first read waits for gh.
const prCache = new Map();
const PR_FIELDS = 'number,title,url,state,isDraft,reviewDecision,mergeStateStatus,mergeable,statusCheckRollup,mergedAt,headRefName,headRefOid,updatedAt,latestReviews';
function ghPR(repo, n) {
  return new Promise((resolve) => {
    execFile('gh', ['pr', 'view', String(n), '--repo', repo, '--json', PR_FIELDS], { timeout: 20000 }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}
// Codex findings are top-level review comments by its bot; one is answered once any reply cites it.
function ghCodexOpen(repo, n) {
  return new Promise((resolve) => {
    execFile('gh', ['api', `repos/${repo}/pulls/${n}/comments?per_page=100`], { timeout: 20000 }, (err, out) => {
      if (err) return resolve(0);
      try {
        const comments = JSON.parse(out);
        const answered = new Set(comments.map((c) => c.in_reply_to_id).filter(Boolean));
        resolve(comments.filter((c) => !c.in_reply_to_id && /codex/i.test(c.user?.login || '') && !answered.has(c.id)).length);
      } catch { resolve(0); }
    });
  });
}
function checksOf(rollup) {
  const list = rollup || [];
  let fail = 0, pending = 0;
  for (const c of list) {
    const concl = (c.conclusion || c.state || '').toUpperCase();
    const status = (c.status || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(concl)) fail++;
    else if ((status && status !== 'COMPLETED') || concl === 'PENDING' || concl === 'EXPECTED') pending++;
  }
  return { total: list.length, fail, pending, state: fail ? 'fail' : pending ? 'pending' : list.length ? 'pass' : 'none' };
}
async function prState(repo, n) {
  const key = `${repo}#${n}`;
  let entry = prCache.get(key);
  if (!entry) { entry = { at: 0, value: null, loading: null }; prCache.set(key, entry); }
  if (Date.now() - entry.at > 45000 && !entry.loading) {
    entry.loading = Promise.all([ghPR(repo, n), ghCodexOpen(repo, n)]).then(([v, codexOpen]) => {
      if (v) {
        const { statusCheckRollup, latestReviews, ...rest } = v;
        const reviews = Object.fromEntries((latestReviews || []).map((r) => [r.author?.login, r.state]));
        const value = { ...rest, checks: checksOf(statusCheckRollup), reviews, codexOpen };
        if (JSON.stringify(value) !== JSON.stringify(entry.value)) dataVersion++;
        entry.value = value;
      }
      entry.at = Date.now();
      entry.loading = null;
    });
  }
  if (!entry.value && entry.loading) await entry.loading;
  return entry.value;
}

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
  return { cfg: await config(), github: self?.github, local: self?.local, remote: self?.remote, branch: self?.branch, topicItems: topicItems() };
}

// The wave files the board reads, each with its builder records.
async function liveWaves() {
  return (await Promise.all((await itemSources(here)).map(async (s) => {
    const wave = await readJSON(s.file, null);
    if (!wave || !Array.isArray(wave.items)) return null;
    return { slug: s.slug, wave, agents: await readAgents(path.join(s.dir, 'agents')) };
  }))).filter(Boolean);
}

// The wave files with archive entries' items (store.mjs readArchive) back among their cards, so an archived card links
// to the live cards it names and that name it, as it did on the board.
async function withArchived(entries) {
  const waves = await liveWaves();
  for (const a of entries) {
    const into = waves.find((w) => w.slug === a.wave);
    if (into) into.wave.items.push(a.item);
    else waves.push({ slug: a.wave, wave: { items: [a.item] }, agents: {} });
  }
  return waves;
}

// A board that opens no PRs has no reviewers on its cards; its list stays in board.json
// (docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md).
async function itemSnapshot({ cfg, github, local, remote, branch }, waves) {
  const fromWaves = cfg.items === 'waves';
  waves ??= await liveWaves();

  const threadLines = Object.create(null);
  await Promise.all(waves.flatMap(({ slug, wave }) => wave.items.map(async (it) => {
    threadLines[`${slug}/${it.id}`] = await readLines(threadFile(`${slug}/${it.id}`));
  })));
  return { github, remote, branch, reviewers: opensPRs({ github, local }, settingsOf(cfg)) ? cfg.reviewers || [] : [], fromWaves, autoMerge: settingsOf(cfg).auto_merge, skipDraft: settingsOf(cfg).skip_draft, autoPull: settingsOf(cfg).auto_pull, autoBuild: settingsOf(cfg).auto_build, tickets: settingsOf(cfg).tickets, waves, threads: threadLines,
    working: await readWorking(here), autoReview: settingsOf(cfg).auto_review, incoming: await readJSON(path.join(data, 'incoming.json'), null),
    reviewRecords: await readJSON(path.join(data, 'reviews.json'), {}) };
}

// Reads every source buildBoard needs: wave files and their builder records,
// PR state from gh, item threads, page events with Claude's replies, owner
// questions and legacy review-link fallbacks; outside is outsideData's. With archive entries, it reads their cards and
// questions beside the wave files' and owner.json's, and their PR states only as the server last read them, asking
// GitHub nothing for them.
async function snapshot(outside, archived = []) {
  const items = await itemSnapshot(outside, archived.length ? await withArchived(archived) : undefined);
  const { waves, threads: threadLines, working } = items;
  const prs = Object.create(null);
  const archivedKeys = new Set(archived.map((a) => a.key));
  await Promise.all(waves.flatMap(({ slug, wave }) => {
    const repo = items.github || wave.repo;
    return wave.items.flatMap((it) => cardPRs(it, repo).map(async (p) => {
      prs[prKeyOf(p)] = archivedKeys.has(`${slug}/${it.id}`) ? prCache.get(prKeyOf(p))?.value ?? null : await prState(p.repo, p.number);
    }));
  }));
  const needsReply = new Set(['ask', 'owner-answer', 'grill-more', 'item-message', 'wave-triage', 'overnight-triage']);
  const pageEvents = await Promise.all((await shownEvents()).map((e) => (needsReply.has(e.kind) || routeRecord(working, e.id) ? withReply(e) : { ...e, reply: null })));
  await Promise.all(pageEvents.filter((e) => e.kind === 'ask').map(async (e) => {
    const lines = await readLines(threadFile(`ask:${e.id}`));
    if (lines.length) threadLines[`ask:${e.id}`] = lines;
  }));

  return {
    ...items, try: await readJSON(path.join(data, 'try.json'), null), main: await readJSON(path.join(data, 'main.json'), null), prs, events: pageEvents, askLinks: await readAskLinks(here), askProgress: await readAskProgress(here),
    checked: await readJSON(path.join(data, 'checked.json'), null), watcher: await readJSON(path.join(data, 'watcher.json'), null), replyAt: await latestReply(),
    owner: ((owner) => ({ ...owner, items: [...(owner.items || []), ...archived.flatMap((a) => a.questions || [])] }))(await readJSON(path.join(data, 'owner.json'), { items: [] })),
    topicItems: outside.topicItems,
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
// The version of the board's data: it steps on each write the watcher sees (changed); in a request that may write as
// it starts, so it reads the files as they are, before each read after its writes (pageBoard, recordAnswers) and as it
// answers (send); each minute, since the board reads the clock; and each time gh brings back a changed PR state.
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

let checkingStalled = false;
async function checkStalled() {
  if (checkingStalled) return;
  checkingStalled = true;
  try {
    const file = path.join(data, 'builder-stalled.json');
    const previous = await readJSON(file, {});
    const current = Object.create(null);
    let sent;
    for (const { key, lane, builder } of (await sharedBoard()).items) {
      if (lane === 'done' || !builder?.stalled) continue;
      current[key] = builder.silentSince;
      if (routeRecord(previous, key) !== builder.silentSince) {
        // The event log covers a restart between appending an event and saving its marker.
        sent ||= await readLines(events);
        if (!sent.some((e) => e.kind === 'builder-stalled' && e.data?.key === key && e.data?.silentSince === builder.silentSince)) {
          await appendEvent('builder-stalled', { key, silentSince: builder.silentSince });
        }
      }
    }
    if (JSON.stringify(current) !== JSON.stringify(previous)) {
      await fs.mkdir(data, { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify(current) + '\n');
      await fs.rename(file + '.tmp', file);
    }
  } catch (err) {
    console.error('Builder check failed:', err.message);
  } finally {
    checkingStalled = false;
  }
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
      if (raised.has(wait.request) || Date.now() - Date.parse(wait.since) < PROTOTYPE_WAIT) continue;
      await appendEvent('prototype-overdue', wait);
    }
  } catch (err) {
    console.error('Prototype check failed:', err.message);
  } finally {
    checkingPrototypes = false;
  }
}

// The setup checklist after a join's handshake (hub/boards.mjs handshake), or null: when the board never had one, or
// once the session acked the newest hello and the GitHub link passed, which marks it done for good. A board on another
// git remote has no GitHub link, so no github step.
async function setupOf(links) {
  const h = await readHandshake(here);
  if (!h?.hello?.id || h.done_at) return null;
  const github = links?.find((l) => l.link === 'github');
  const steps = { events: h.ack?.id === h.hello.id, ...(github || !links ? { github: Boolean(github?.ok) } : {}) };
  if (steps.events && steps.github !== false) { await finishHandshake(here); return null; }
  return steps;
}

// The Hold sheet's chips by length, so the board's version doesn't change with the clock; the page words when each ends
// (ui-cards.js holdPicker).
const HOLD_CHOICES = CHOICES.map(([value, label]) => ({ value, label, ms: value === FOREVER ? null : durationEnd(new Date(0), value) - new Date(0) }));

// generatedAt is when the board began reading, so of two boards the later one holds every change the earlier one does.
async function board() {
  const generatedAt = new Date().toISOString();
  const { title, reviewers } = await config();
  const self = boardAt(here);
  const listen = self ? listenState(self) : 'deaf';
  const built = withHub(await sharedBoard(), { listen, prompts: self ? pendingFor(self.route).map(shown) : [] });
  built.items = built.items.map((it) => (it.worktree && !existsSync(it.worktree) ? { ...it, worktree: null } : it));
  const links = self ? linksOf(self, { listen }) : null;
  return { generatedAt, title, reviewers: (reviewers || []).map((r) => r?.name).filter((n) => typeof n === 'string'), ...built, links, setup: await setupOf(links),
    holdChoices: HOLD_CHOICES, arch: self ? archOf(await readReviews(here), built.items, built.owner, { repo: repoName(boardRepo(self.route)), waits: reviewWaits() }) : null };
}

// docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md
// The board a page reads, from /api/board or an events POST's answer: board() with this request's onHost, leaving out
// the resolved questions (GET /api/questions answers a topic's), with its Done cards slim and how many older ones wait in
// the archive (docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md), and its version, a tag of
// everything in it but generatedAt, which GET /api/board also sends as its ETag. A card's question topic leaves its
// title, summary and askedAt to its card while the card is on the board: the page names the topic from the card
// (view-questions.js), so a card's change patches the card alone (docs/adr/2026-11-04-0332-the-board-sends-per-card-patches.md).
async function pageBoard(req) {
  if (!['GET', 'HEAD'].includes(req.method)) dataVersion++;
  const b = { ...(await board()), onHost: await fromHost(req), doneArchived: await archiveCount(here) };
  b.owner = b.owner.filter((q) => q.state !== 'resolved');
  b.items = b.items.map((i) => (i.lane === 'done' ? slimDone(i) : i));
  const shown = new Set(b.items.map((i) => i.key));
  b.ownerTopics = b.ownerTopics.map(({ title, summary, askedAt, ...t }) => (shown.has(t.card) ? t : { ...t, title, summary, ...(askedAt ? { askedAt } : {}) }));
  const { generatedAt: _, ...content } = b;
  const page = { ...b, version: crypto.createHash('sha1').update(JSON.stringify(content)).digest('base64url').slice(0, 20) };
  kept.delete(page.version);
  kept.set(page.version, page);
  for (const v of [...kept.keys()].slice(0, -BOARDS_KEPT)) kept.delete(v);
  return page;
}

// docs/adr/2026-11-04-0332-the-board-sends-per-card-patches.md: the page boards this server built last, by version, so a page naming the version it holds gets a
// patch from it (ui-patch.js boardPatch); one naming a version no longer kept, or none, gets the whole board.
const BOARDS_KEPT = 8;
const kept = new Map();
const patches = vm.createContext({});
vm.runInContext(await fs.readFile(new URL('./public/ui-patch.js', import.meta.url), 'utf8'), patches);
const { boardPatch } = patches.BoardUI;
async function answerBoard(req, since) {
  const from = since && kept.get(since);
  const b = await pageBoard(req);
  return from ? boardPatch(from, b) : b;
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
    const { key, data } = await startReview(here, self);
    const id = await appendEvent('arch-review', data);
    return { key, id, existing: false };
  });
  reviewing = run.catch(() => {});
  return run;
}

// A card's wave file entry and builder records, else its archive entry's (store.mjs readArchive), whose questions its
// thread reads beside owner.json's.
async function itemOf(key) {
  const [slug, id] = key.split('/');
  const source = (await itemSources(here)).find((s) => s.slug === slug);
  const wave = source ? await readJSON(source.file, null) : null;
  const archived = !wave?.items?.some((it) => it.id === id) && (await readArchive(here)).find((a) => a.key === key);
  const item = (Array.isArray(wave?.items) && wave.items.find((it) => it.id === id)) || archived?.item || null;
  return { item, questions: archived?.questions || [], agents: item && source ? routeRecord(await readAgents(path.join(source.dir, 'agents')), id) || {} : {} };
}

// The work items an ask became (their from_ask) or was related to (data/ask-links.json), as domain.mjs threadOf's links.
async function askLinksOf(askId) {
  const related = routeRecord(await readAskLinks(here), askId);
  const { tickets } = settingsOf(await config());
  const links = [];
  for (const s of await itemSources(here)) {
    const wave = await readJSON(s.file, null);
    for (const it of Array.isArray(wave?.items) ? wave.items : []) {
      const key = `${s.slug}/${it.id}`;
      if (it.from_ask === askId) links.unshift({ key, ref: refOf(wave, it, tickets), became: true });
      else if (key === related) links.push({ key, ref: refOf(wave, it, tickets), became: false });
    }
  }
  return links;
}

async function thread(key) {
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
    || (e.kind === 'ask' && askIds.includes(e.id)) || e.kind === 'ask-edited');
  const lines = (await Promise.all([...keys].map((k) => readLines(threadFile(k))))).flat();
  return threadOf(key, { lines, events: await Promise.all(mine.map(withReply)), owner, working: await readWorking(here), fromAsk: askId,
    links: own ? await askLinksOf(askId) : [], agents, moved });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
const PROTOTYPE_TEMPLATE = path.join(template, 'public', 'prototype.html');
async function recordedPrototype(p) {
  const topic = /^\/prototype-([a-z0-9-]+)\.html$/.exec(p)?.[1];
  return topic ? (await readPrototypes(here)).find((r) => r.topic === topic) || null : null;
}
// Inside <script type="application/json">, so "<" is escaped and the record can't close the element.
const scriptJSON = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
async function prototypePage(proto) {
  const takes = await Promise.all(proto.takes.map(async (t) => {
    const src = `prototypes/${proto.topic}/${t.key}.js`;
    const st = await fs.stat(takeFile(here, proto.topic, t.key)).catch(() => null);
    return { key: t.key, label: t.label, src: st?.isFile() ? `${src}?v=${versionOf(st)}` : null, file: src };
  }));
  const title = `${proto.title} · prototype`;
  const header = { lead: 'back', backHref: proto.card ? `./#item=${encodeURIComponent(proto.card)}` : './', title, controls: false };
  const fill = { prototypeTitle: esc(title), prototypeHeader: `<!--header ${scriptJSON(header).replace(/>/g, '\\u003e')}-->`, prototypeData: scriptJSON({ topic: proto.topic, title: proto.title, takes }) };
  return (await fs.readFile(PROTOTYPE_TEMPLATE, 'utf8')).replace(/\{\{(prototypeTitle|prototypeHeader|prototypeData)\}\}/g, (_, k) => fill[k]);
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
setInterval(() => broadcast(': ping\n\n'), 25000).unref();

// A burst of writes, such as a rename after a temp file, sends one signal; a steady stream of them still sends one
// every CHANGE_MAX.
const CHANGE_QUIET = 100;
const CHANGE_MAX = 500;
let changeTimer = null;
let changeFirst = 0;
function changed() {
  dataVersion++;
  const now = Date.now();
  if (!changeTimer) changeFirst = now;
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    broadcast(`event: change\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    checkArchive();
    checkStalled();
    checkActions();
    checkWaits();
    checkAuto();
    checkIdle();
  }, Math.max(0, Math.min(CHANGE_QUIET, changeFirst + CHANGE_MAX - now)));
}
// Lock folders, installs and build output churn and never hold board files: a path with a segment starting with "." or
// named for build output, or a .tmp file, sends no change, and the per-folder watch never watches such a folder.
const BUILD_OUTPUT = new Set(['node_modules', 'dd', 'DerivedData']);
const ignored = (name) => String(name).endsWith('.tmp') || String(name).split(/[\\/]/).some((s) => s.startsWith('.') || BUILD_OUTPUT.has(s));
const isFolder = (dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } };
// On macOS and Windows one recursive watch covers the tree; on Linux each folder has its own watch, since Node's
// recursive watch there loses a file once a rename replaces it (docs/adr/2026-11-03-1952-the-board-watches-each-folder-only-on-linux.md).
// A root that doesn't exist yet, that goes, or whose watch fails is retried; the first watch after a retry signals,
// since a write may have landed meanwhile.
function watchTree(root) {
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
    try { stop = (process.platform === 'linux' ? watchEachFolder : watchRecursive)(root, retry); } catch { retry(); return; }
    if (retried) changed();
  };
  start();
}
function watchRecursive(root, retry) {
  const w = watchFiles(root, { recursive: true }, (_, name) => {
    if (!name || !ignored(name)) changed();
    if (!isFolder(root)) retry();
  });
  w.on('error', retry);
  return () => w.close();
}
// A folder's watch sees every write to a file in it, including a file a rename replaced; a folder that appears is
// watched and one that goes is dropped.
function watchEachFolder(root, retry) {
  const watches = new Map();
  const unwatch = (folder) => {
    for (const [dir, w] of watches) if (dir === folder || dir.startsWith(folder + path.sep)) { w.close(); watches.delete(dir); }
  };
  const watchFolder = (folder) => {
    if (watches.has(folder)) return;
    const w = watchFiles(folder, (_, name) => {
      if (!name || !ignored(name)) changed();
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
async function watchBoard() {
  const sources = (await config()).items === 'waves' ? [wavesDir()] : (await itemSources(here)).map((s) => s.dir);
  const dirs = [...new Set([data, ...sources].map((d) => path.resolve(d)))];
  for (const dir of dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(o + path.sep)))) watchTree(dir);
}

const server = http.createServer(async (req, res) => {
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

    if (p === '/_claude/health') return json(res, 200, { ok: true });
    if (p === '/api/board') {
      const b = await answerBoard(req, String(url.searchParams.get('since') || ''));
      const etag = `W/"${b.version}"`;
      if (sameTag(req.headers['if-none-match'], etag)) { res.writeHead(304, { etag, 'cache-control': 'no-store', vary: 'accept-encoding' }).end(); return; }
      return json(res, 200, b, { etag });
    }
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
    if (p === '/api/notes' && url.searchParams.has('wave')) {
      try { return json(res, 200, await readLineupNotes(here, String(url.searchParams.get('wave')), settingsOf(await config()).tickets)); }
      catch (e) { if (e instanceof BoardError) return json(res, 404, { error: e.message }); throw e; }
    }
    if (p === '/api/notes' || p === '/api/plan') {
      const key = String(url.searchParams.get('item') || '');
      try {
        const { wave, item, markdown } = await readNotes(here, key);
        return json(res, 200, { key, ref: refOf(wave, item, settingsOf(await config()).tickets), title: item.title, markdown });
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
      if (kind === 'card-hold' && body.hold && body.for !== undefined) {
        const end = durationEnd(new Date(), body.for);
        if (!end) return json(res, 400, { error: 'That hold ends in the past or more than 30 days on. Pick another time.' });
        delete body.for;
        if (end !== FOREVER) body.until = end.toISOString();
      }
      // docs/adr/2026-11-03-0219-a-build-tap-starts-the-build-in-the-board-server.md
      if (kind === 'card-build') {
        const key = String(body.key || '');
        const started = await startTappedBuild(here, key, (opts) => boardWorktree(here, key.split('/')[1], opts));
        return json(res, 200, { id: await handOff(started), board: await answerBoard(req, since) });
      }
      // docs/adr/2026-11-03-1840-waves-are-bands-in-todo.md
      if (kind === 'lineup-move') {
        const slug = String(body.lineup || '');
        const phases = lineupMoved(await sharedBoard(), slug, String(body.key || ''), body.by === -1 ? -1 : body.by === 1 ? 1 : 0);
        if (!phases) return json(res, 400, { error: `That card can't move that way in the wave "${slug}".` });
        try { await changeLineup(here, slug, { phases: phases.map((p) => p.join(',')) }); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
        return json(res, 200, { id: null, board: await answerBoard(req, since) });
      }
      if (kind === 'owner-answer') return json(res, 200, { id: (await recordAnswers([body]))[0], board: await answerBoard(req, since) });
      if (kind === 'owner-answers') {
        const refused = await answersRefused(body.answers);
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
      // A Hold or Done is written to the card's wave file before its event, and one that couldn't be is refused with
      // why, recording nothing (docs/adr/2026-11-03-1850-a-tap-waits-for-the-server-to-record-it.md).
      if (kind === 'card-hold' || kind === 'card-done') {
        const key = String(body.key || '');
        let written;
        try { written = await recordOwnerTap(here, kind, body); }
        catch (e) { return json(res, e instanceof BoardError ? 400 : 500, { error: `Couldn’t write ${key} to its wave file: ${e.message}` }); }
        if (!written) return json(res, 400, { error: `${key} is already merged or dropped, so its wave file stays as it is.` });
      }
      // A remove is written here and recorded as reviewers-removed; an add stays a `reviewers {add}` event, since finding
      // the person's Slack and GitHub ids needs the session (docs/adr/2026-11-04-0119-the-board-server-removes-reviewers-itself.md).
      if (kind === 'reviewers') {
        const names = (v) => (v === undefined ? [] : Array.isArray(v) && v.every((n) => typeof n === 'string' && n.trim()) ? v.map((n) => n.trim()) : null);
        const add = names(body.add), remove = names(body.remove);
        if (!add || !remove || (!add.length && !remove.length)) return json(res, 400, { error: 'Send the names to add or remove, each as a list.' });
        if (remove.length) {
          try { await removeReviewers(here, remove); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
        }
        const ids = await appendEvents([...(remove.length ? [['reviewers-removed', { remove }]] : []), ...(add.length ? [['reviewers', { add }]] : [])]);
        return json(res, 200, { id: ids.at(-1), board: await answerBoard(req, since) });
      }
      if (kind === 'reask-request') {
        const refused = await reaskRefused(String(body.question || ''));
        if (refused) return json(res, 400, { error: refused });
      }
      const id = await appendEvent(kind, body);
      if ((kind === 'grill-more' || kind === 'prototype-request') && body.key) {
        const ask = {
          ...(body.text ? { text: String(body.text) } : {}),
          ...(Array.isArray(body.files) && body.files.length ? { files: body.files } : {}),
          ...(body.question ? { question: String(body.question), note: body.note ? String(body.note) : undefined, choice: body.choice ?? undefined } : {}),
        };
        await launchPlanner(String(body.key), kind === 'grill-more' ? 'grill' : 'prototype', ask);
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
    if (p === '/api/settings' && req.method === 'GET') return json(res, 200, { settings: await readBoardSettings(here) });
    if (p === '/api/permissions') {
      const self = boardAt(here);
      if (!self) return json(res, 404, { error: 'This board isn’t in the hub’s manifest.' });
      const folder = boardRepo(self.route).repo;
      const body = req.method === 'POST' ? await readBody(req) : null;
      const owner = await fromOwner(req);
      if (body && !owner) return json(res, 403, { error: 'Only the signed-in owner can change these.' });
      try {
        if (body) await setPermission(folder, here, body.id, body.on);
        return json(res, 200, await permissionsView(folder, here, owner));
      } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
    }
    if (p === '/api/try/main/log' && req.method === 'GET') {
      let file;
      try {
        file = await fs.open(path.join(here, 'data', 'try', 'main.log'), 'r');
        const { size } = await file.stat();
        const start = Math.max(0, size - 64 * 1024);
        const buffer = Buffer.alloc(size - start);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
        if (start) lines.shift();
        if (lines.at(-1) === '') lines.pop();
        return json(res, 200, { lines: lines.slice(-40) });
      } catch (e) {
        if (e.code === 'ENOENT') return json(res, 200, { lines: [] });
        throw e;
      } finally { await file?.close(); }
    }
    if (p === '/api/log' && req.method === 'GET') {
      const name = url.searchParams.get('file') || '';
      if (!/^[\w.-]+\.log$/.test(name) || name.startsWith('.')) return json(res, 400, { error: 'file takes a log file’s name.' });
      let file;
      try {
        file = await fs.open(path.join(os.homedir(), '.claude', 'kickflip', 'logs', name), 'r');
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
    if (p === '/api/try' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'key') || typeof body.key !== 'string') return json(res, 400, { error: 'Send only the card key.' });
      try {
        const response = await fetch(`http://127.0.0.1:${process.env.KICKFLIP_HUB_PORT || 4500}/_hub/build`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ route: prefix.slice(1) || path.basename(here), key: body.key }), signal: AbortSignal.timeout(10_000),
        });
        return json(res, response.status, await response.json());
      } catch (e) { return json(res, 502, { error: `Could not start the build: ${e.message}` }); }
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      let saved;
      try { saved = await saveBoardSettings(here, body); } catch (e) { if (e instanceof BoardError) return json(res, 400, { error: e.message }); throw e; }
      // The board server alone acts on idle_notification (checkIdle), so it wakes no session.
      const told = saved.changed.filter((k) => k !== 'idle_notification');
      const id = told.length ? await appendEvent('settings', Object.fromEntries(told.map((k) => [k, saved.settings[k]]))) : null;
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
    let body = shell ? Buffer.from(shellHtml({ touchIcon: await touchIcon() })) : proto ? Buffer.from(await prototypePage(proto)) : await fs.readFile(file);
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
      else res.writeHead(err.status || (err.code === 'ENOENT' ? 404 : 400)).end();
    }
  }
});

// docs/adr/2026-11-02-1727-a-card-can-be-held-until-a-time.md
let checkingPickUps = false;
async function checkPickUps() {
  if (checkingPickUps) return;
  checkingPickUps = true;
  try {
    const now = Date.now();
    const due = (await sharedBoard()).items
      .filter((it) => it.heldUntil && it.lane !== 'done' && Date.parse(it.heldUntil) <= now);
    // The resumed wave file stops a second pick-up; the event log covers a restart between the event and that write.
    const sent = due.length ? await readLines(events) : [];
    for (const { key, heldUntil: until } of due) {
      await pickUp(here, key, until, { announce: !sent.some((e) => e.kind === 'card-unblocked' && e.data?.key === key && e.data?.until === until) });
    }
  } catch (err) {
    console.error('Pick-up check failed:', err.message);
  } finally {
    checkingPickUps = false;
  }
}

// docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md
// The Auto jobs, run on every board change and once at start: the queued starts, triage, then the pull, then a plan,
// then a review. The queue's top fills the free implementer slots (domain.mjs pullOf): a tapped card nothing blocks
// any more starts as the owner's Build tap would, launching its builder, whether Auto implement is on or
// not (docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md, docs/adr/2026-11-04-0121-in-progress-has-a-queued-section.md). The pull fills every free implementer slot whatever else runs; triage, the plan and the review wait for an idle
// board. A triage sent or under way holds the pull until its reply, and a card pulled and not yet started holds the
// plan and the review. None goes out while usage is paused; the minute check runs the jobs again once a pause lifts,
// since the pause lives outside the board's data. A check asked for while one runs runs again after it.
let checkingAuto = null;
let autoAgain = false;
let heldByPause = false;
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
  const log = await readLines(events);
  const { items, reviews } = await sharedBoard();
  const { idle, pullable, waiting, starts, pulls, plannable } = pullOf(items, { cap: settings.max_implementers, pulled: await sentOf(PULL) });
  heldByPause = readUsageGate().state === 'paused';
  const ready = idle && !heldByPause;
  for (const key of heldByPause ? [] : starts) {
    await handOff(await startQueuedBuild(here, key, (opts) => boardWorktree(here, key.split('/')[1], opts)));
  }
  // A lander is only ever due on a checking card, so a board without one skips landable's read of the wave files.
  if (!heldByPause && items.some((i) => i.status === 'checking')) await launchLanders();
  if (await checkTriage(settings, log, items, ready)) return;
  const startPull = async (key) => handOff(await startTappedBuild(here, key, (opts) => boardWorktree(here, key.split('/')[1], opts), 'hub'));
  if (await sendPulls(PULL, settings.auto_pull, waiting, heldByPause ? [] : pulls, startPull)) return;
  const unready = pullable.length ? [] : plannable;
  const planned = (await sentOf(PLAN)).filter((k) => unready.includes(k));
  const startPlan = async (key) => launchPlanner(key, items.find((i) => i.key === key)?.state === 'prototyping' ? 'prototype' : 'grill');
  if (await sendPulls(PLAN, settings.auto_pull, planned, ready && !planned.length ? unready.slice(0, 1) : [], startPlan)) return;
  // docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md: one review at a time, after any pull.
  const { due, repo } = reviews;
  if (ready && due) await appendEvent('pr-review', { pr: due.number, head: due.head, repo, title: due.title, author: due.author, url: due.url, touches: due.touches, asked: Boolean(due.asked) });
}

// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
// A build the server started ({key, kind, model, worktree}, startTappedBuild's) launches its builder here, Claude or
// Codex. A launch that fails puts the card back in Todo with the reason (store.mjs abandonLaunch). The start wrote
// the card's files, so the cached board is dropped: one built mid-start would show the card neither pullable nor
// building, and the next pull would fill its slot again. → null, the tap's event id, since no event wakes the session.
async function handOff(started) {
  dataVersion++;
  if (!started || started.queued) return null;
  const entry = { kind: started.kind, model: started.model, relaunched: false };
  try {
    // A pause that began after the pull holds the launch; reviveHeadless launches it once the pause lifts.
    if (readUsageGate().state === 'paused') await trackLaunch(started.key, { ...entry, pid: null });
    else await trackLaunch(started.key, { ...entry, ...(await launchBuilder(here, started)) });
  } catch (e) {
    await abandonLaunch(here, started.key, `the launch failed (${e.message}). Tap Implement to try again.`);
  }
  return null;
}

// A planner, kind grill or prototype, the owner asked for or the idle board's plan picked, opens on the card and
// launches headless in the board's repo (store.mjs startPlanner), unless an agent already works on it. One that can't
// start or launch leaves a thread line and its record closed.
async function launchPlanner(key, kind, ask = {}) {
  try {
    const started = await startPlanner(here, key, kind);
    if (!started) return;
    try { await launchBuilder(here, { ...started, ...ask }); } catch (e) {
      await abandonPlanner(here, key, `Couldn't launch the ${kind} (${e.message}).`);
    }
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    await appendThread(here, key, { text: `Couldn't start the ${kind}: ${e.message}` });
  }
}

// docs/adr/2026-11-04-1010-a-dead-headless-builder-is-relaunched-once.md
// data/headless-builders.json {<key>: {kind, model, pid, relaunched}}: the headless builders launched, for reviveHeadless.
// trackLaunch sets a key's entry, or with null drops it (a lander takes the card over from its builder).
async function trackLaunch(key, entry) {
  const file = path.join(data, 'headless-builders.json');
  const tracked = await readJSON(file, {});
  if (entry) tracked[key] = entry; else delete tracked[key];
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify(tracked) + '\n');
  await fs.rename(file + '.tmp', file);
}
// Once a minute while usage isn't paused: a headless builder whose process exited with its record open launches again
// once, and after that leaves a thread line; its record stays open, so the stall alarm brings in the orchestrator.
let revivingHeadless = false;
async function reviveHeadless() {
  if (revivingHeadless) return;
  revivingHeadless = true;
  try {
    if (readUsageGate().state === 'paused') return;
    const file = path.join(data, 'headless-builders.json');
    const tracked = await readJSON(file, {});
    if (!Object.keys(tracked).length) return;
    const open = new Set(buildBoard(await itemSnapshot(await outsideData())).items.filter((c) => c.lane !== 'done' && c.builder && !c.builder.planner).map((c) => c.key));
    const handBack = async (card) => {
      await appendThread(here, card.key, { text: 'Its builder exited twice with the build unfinished; it reads Stalled once 30 minutes pass without progress.' });
    };
    const launch = async (card) => {
      try { return await launchBuilder(here, card); } catch (e) {
        await appendThread(here, card.key, { text: `Couldn't relaunch the builder headless (${e.message}).` });
        return { pid: null };
      }
    };
    const next = await reviveBuilders(tracked, open, { launch, handBack });
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

// The land a held card's Merge tap starts: `board.mjs merge <key>`, detached so a land that restarts this server
// finishes, writing its outcome to the card's thread itself (finish.mjs landHeld).
function runHeldMerge(key) {
  const logs = path.join(os.homedir(), '.claude', 'kickflip', 'logs');
  mkdirSync(logs, { recursive: true });
  const out = openSync(path.join(logs, `merge-${key.split('/')[1]}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`), 'a');
  const cmd = process.env.KICKFLIP_MERGE_CMD ? JSON.parse(process.env.KICKFLIP_MERGE_CMD) : [process.execPath, BOARD_CLI];
  const child = spawn(cmd[0], [...cmd.slice(1), '--site', route, 'merge', key], { detached: true, stdio: ['ignore', out, out] });
  closeSync(out);
  child.on('error', (e) => appendThread(here, key, { text: `Not merged: the land couldn't start (${e.message}). Tap Merge again.` }).catch(() => {}));
  child.unref();
}

// data/landers.json {<key>: {verified, pid}}: the verification each launched lander was for, so each gets one lander,
// and its process. A card whose verified build waits to land (store.mjs landable) gets a headless lander. A lander whose
// process has gone while its card still reads building stopped partway (the usage pause ends a headless run): its card
// goes back to checking (store.mjs relaunchLander) and gets a fresh lander in this pass.
async function launchLanders() {
  const file = path.join(data, 'landers.json');
  const sent = Object.fromEntries(Object.entries(await readJSON(file, {})).map(([k, v]) => [k, typeof v === 'string' ? { verified: v, pid: null } : v]));
  const pidGone = new Set();
  for (const [key, entry] of Object.entries(sent)) {
    if (!entry.pid || pidAlive(entry.pid)) continue;
    try { await relaunchLander(here, key); pidGone.add(key); } catch (e) { if (!(e instanceof BoardError)) throw e; }
  }
  const kept = Object.fromEntries(Object.entries(sent).filter(([k]) => !pidGone.has(k)));
  const due = (await landable(here)).filter((c) => kept[c.key]?.verified !== c.verified);
  if (!due.length) return;
  for (const c of due) {
    try { kept[c.key] = { verified: c.verified, pid: (await launchBuilder(here, c, { lander: true })).pid }; await trackLaunch(c.key, null); } catch (e) {
      kept[c.key] = { verified: c.verified, pid: null };
      await appendThread(here, c.key, { text: `Couldn't launch the lander headless (${e.message}); land it with board.mjs land ${c.key}.` });
    }
  }
  await fs.writeFile(file + '.tmp', JSON.stringify(kept) + '\n');
  await fs.rename(file + '.tmp', file);
}

// docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md
// The night an overnight triage would go out now: the host day of the middle of the hub's quiet hours, from that
// middle until they end, else null. settings.json is read each time, since the owner edits quiet hours.
async function triageNight() {
  const middle = quietMiddleOf(new Date(), quietOf(await readJSON(path.join(os.homedir(), '.claude', 'kickflip', 'settings.json'), {})));
  return middle && localDay(middle);
}

// data/triaged.json {seen}: what the last triage saw (domain.mjs triageOf), kept current until that triage's reply so
// its own merges and dedupes don't read as a change. The event log says when the last triage went out. → true while a
// triage is under way or was just sent.
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
  if (last && !(await withReply(last)).reply) { if (marker.seen !== seen) await save(); return true; }
  if (!settings.auto_triage || !ready || waiting.length < 2 || seen === marker.seen) return false;
  const date = await triageNight();
  if (!date || last?.data?.date === date) return false;
  const topic = `overnight-triage-${date}`;
  const owner = await readJSON(path.join(data, 'owner.json'), { topics: [] });
  if (!(owner.topics || []).some((t) => t.id === topic)) await addTopic(here, { id: topic, title: `Overnight triage ${date}` });
  await appendEvent('overnight-triage', { date, topic, cards: waiting });
  await save();
  return true;
}

// Whether the minute check runs the Auto jobs for an overnight triage: auto_triage is on, and tonight's hasn't gone out.
async function triageDue() {
  if (!settingsOf(await config()).auto_triage) return false;
  const date = await triageNight();
  return Boolean(date) && (await readLines(events)).filter((e) => e.kind === 'overnight-triage').at(-1)?.data?.date !== date;
}

// docs/adr/2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md
// The pull starts the build of each card domain.mjs pullOf says fills a free slot, tracked in data/pulled.json
// (docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md). With nothing to pull an idle board starts
// a planner on the top plannable card instead, one at a time, tracked in data/planned.json
// (docs/adr/2026-11-03-1631-the-idle-pull-takes-ready-cards-first.md, docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md).
const PULL = { file: 'pulled.json', line: 'Pulled in: an implementer slot was free.' };
const PLAN = { file: 'planned.json', line: 'Asked for a grill or prototype: nothing in Todo was ready to build.' };
// The marker {keys, at}: keys are the cards started that still wait for their agent, at when the marker last changed.
// A marker from before the cap holds one key instead. → the keys started.
const markedOf = (marker) => marker.keys || (marker.key ? [marker.key] : []);
const sentOf = async ({ file }) => markedOf(await readJSON(path.join(data, file), {}));
// With on, writes the thread line and starts each of go, and marks keep and go as started; off, clears the marker. The
// marker is written only when its keys move, since each write is itself a board change. → true while any is marked.
async function sendPulls({ file: name, line }, on, keep, go, start) {
  const file = path.join(data, name);
  const keys = on ? [...keep, ...go] : [];
  for (const key of on ? go : []) {
    await fs.mkdir(path.dirname(threadFile(key)), { recursive: true });
    await fs.appendFile(threadFile(key), JSON.stringify({ ts: new Date().toISOString(), who: 'claude', text: line }) + '\n');
    await start(key);
  }
  if (JSON.stringify(markedOf(await readJSON(file, {}))) !== JSON.stringify(keys)) {
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(file + '.tmp', JSON.stringify({ keys, at: new Date().toISOString() }) + '\n');
    await fs.rename(file + '.tmp', file);
  }
  return keys.length > 0;
}

// docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md
// data/action-pushes.json {<tag>: {kind, ids}}: what waited on the owner at the last check (domain.mjs ownerActions).
// A tag that is new, changes kind or gains an open question pushes; one that is gone drops its queued push. The first
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
      try { await sendPush(here, { kind: 'action', title: a.title, body: fresh[0]?.question || a.body, url: `/${route}/${url}`, tag: a.tag, now: a.now }); }
      catch (e) { if (e instanceof BoardError) console.error(`Push ${a.tag} not sent:`, e.message.split('\n').at(-2) || e.message); else throw e; }
    }
    const gone = Object.keys(previous).filter((tag) => !routeRecord(current, tag));
    if (gone.length) await dropQueued(gone, route);
  }
  if (JSON.stringify(current) !== JSON.stringify(previous)) {
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(file + '.tmp', JSON.stringify(current) + '\n');
    await fs.rename(file + '.tmp', file);
  }
}

// docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
// data/orchestrator-waits.json {waits: [{key, ref, title, kind, since, picked, next, pushed?}]}: the cards idle on the
// orchestrator (domain.mjs orchestratorWaits), lanes top-down, which bin/wait-events.mjs prints on every wake. Each card
// that joins it not picked up, or waits again with a new kind or since, is named in one orchestrator-waits {added: [key]}
// event, appended once the file is written. One waiting ORCHESTRATOR_PUSH_AFTER, not picked up, pushes the owner once,
// and its entry keeps pushed while that wait lasts. Checked on every board change and each minute; a check asked for
// while one runs runs again after it.
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
  const was = (w) => previous.find((p) => p.key === w.key && p.kind === w.kind && p.since === w.since);
  const added = [];
  const waits = [];
  for (const w of orchestratorWaits(await sharedBoard())) {
    let pushed = was(w)?.pushed === true;
    if (!w.picked && !was(w)) added.push(w.key);
    if (!w.picked && !pushed && Date.now() - Date.parse(w.since) >= ORCHESTRATOR_PUSH_AFTER) {
      pushed = true;
      try { await sendPush(here, { kind: 'reminder', title: `${w.ref} waits on the orchestrator`, body: `${w.title}: ${w.next}`, url: `/${route}/#item=${encodeURIComponent(w.key)}`, tag: `wait-${w.key}`, now: true }); }
      catch (e) { if (e instanceof BoardError) console.error(`Wait push for ${w.key} not sent:`, e.message.split('\n').at(-2) || e.message); else throw e; }
    }
    waits.push(pushed ? { ...w, pushed } : w);
  }
  if (!stored || JSON.stringify(waits) !== JSON.stringify(previous)) {
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(file + '.tmp', JSON.stringify({ waits }) + '\n');
    await fs.rename(file + '.tmp', file);
  }
  if (added.length) await appendEvent('orchestrator-waits', { added });
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
  const { state, push } = idleStep(previous, { idle, now: new Date() });
  if (push) {
    try { await sendPush(here, { kind: 'reminder', title: `${cfg.title || route} has gone idle`, body: idleSummary(built.items, previous.last), url: `/${route}/`, tag: 'idle', now: true }); }
    catch (e) { if (e instanceof BoardError) console.error('Idle push not sent:', e.message.split('\n').at(-2) || e.message); else throw e; }
  }
  if (JSON.stringify(state) !== JSON.stringify(previous)) {
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(file + '.tmp', JSON.stringify(state) + '\n');
    await fs.rename(file + '.tmp', file);
  }
}

// docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md
// The Done cards past the newest DONE_KEPT move to the archive with their resolved questions (domain.mjs archivedOf,
// store.mjs archiveCards), as the server starts and after each board change, each with when it closed. A check asked
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
async function archiveDone() {
  if (!archivedOf(await sharedBoard()).length) return;
  const picks = archivedOf(await board());
  const moved = picks.length ? await archiveCards(here, picks.map((c) => ({ key: c.key, closed_at: c.sortAt }))) : [];
  if (moved.length) console.log(`Done archive: ${moved.length} card${moved.length === 1 ? '' : 's'} moved`);
}

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
try { for (const line of await migrateFollowups(here)) console.log(line); } catch (e) { console.error('follow-up migration:', e.message); }
try { await stripDeadFields(here); } catch (e) { console.error('dead-field strip:', e.message); }
await checkArchive();
await watchBoard();
setInterval(() => {
  dataVersion++;
  checkStalled();
  checkPrototypeWaits();
  reviveHeadless();
  checkPickUps();
  if (heldByPause && readUsageGate().state !== 'paused') checkAuto();
  else triageDue().then((due) => { if (due) checkAuto(); }, (err) => console.error('Triage check failed:', err.message));
  checkActions();
  checkWaits();
  checkIdle();
}, 60000).unref();
await checkStalled();
await checkPrototypeWaits();
await checkPickUps();
await checkAuto();
checkActions();
checkWaits();
checkIdle();
server.listen(port, '127.0.0.1', () => console.log(`site on http://127.0.0.1:${port}/ (prefix ${prefix || 'none'})`));
