#!/usr/bin/env node
// kickflip hub: one loopback server that Tailscale sends every request to.
//   /                 the app shell (board/public/app.html), which opens this device's last board, else the board with
//                     the most waiting; a browser's page load of any site's page, such as /<route>/,
//                     /<route>/settings.html or /learn/, gets the shell too (shell.mjs pageOf)
//                     (docs/adr/2026-10-29-2005-one-app-for-the-whole-hub.md)
//   /_hub/app/<file>  the shell's scripts and CSS, read from ../board/public then ../starter/public on each request;
//                     ?v=<version> caches for a year
//   /_hub/stream      the shell's one event stream: `change {route}` for each board's change signal and `sidebar` with
//                     /_hub/sidebar.json's data when it changes (stream.mjs)
//   /_hub/, /_hub/settings, /_hub/settings/polling
//                     the hub page (each path; the last, the old Polling page, opens Quiet hours), a view of the shell;
//                     any GET of them gets the shell
//   /_hub/api/hub, /_hub/api/settings
//                     those views' data and words (views.mjs), including integration readiness rows on /_hub/api/hub
//   /_hub/sidebar.json what the sidebar shows (board/public/ui-sidebar.js): {code, version, total, start,
//                     sites: [{route, title, board, state, count, changedAt, created, icon, sub, ctx}] (sub: home.mjs statusLine's data), hub: {tone, word, detail},
//                     notifications: {state, text}, away}, away true while the owner reads away (presence.mjs ownerTracker), ctx the board's owner session's {percent, at, full} or null, pause the usage gate with machine {busy, banner} (home.mjs sidebarPause) and a held board's sub already reading paused (heldSite); each site's row from its GET /_claude/needs
//                     (home.mjs; docs/adr/2026-10-29-1639-sites-report-what-waits-through-claude-needs.md)
//                     starting lists pending boards, each with its start step and a running clone's percent, and while
//                     starting orchestrator its session's last activity, its pending prompt and whether it stalled (sessions.mjs startHealth)
//                     usage: {claude, codex}, each null when hidden, else {at, five_hour, seven_day}; windows are
//                     null without a reading, else {used_percentage, resets_at, state: live|reset|stale} (usage.mjs).
//                     Reset windows read 0%; stale means older than that window. Codex scans cache for 60 seconds.
//                     /_hub/api/hub carries the same usage field.
//                     Both carry pause: {pause_at, state: normal|paused|going, window, used, resets_at,
//                     codex: {past, window, used, resets_at}} (../shared/usage-gate.mjs).
//                     /_hub/ JSON answers carry X-Hub-Code, the running hub's code hash.
//   /_hub/api/linear GET {set, workspace, url_key, teams: [{key, name}], projects: [{id, name, team}]} through Hub's Linear
//                     key, {set: false} without one, {set: true, refused: true, …} once Linear refused it, or with
//                     error when Linear can't be reached
//   /_hub/linear/projects POST {team, name} creates a Linear project in that team → {id, name, team}
//   /_hub/repos      GET the signed-in owner's and orgs' repos with clone/share metadata
//   /_hub/repo       GET ?github=owner/repo checks a pasted GitHub repo, including one outside the list, or
//                     ?remote=<git link> another host's repo; returns one repo row with listed: false, or 404 when
//                     unreachable (repos.mjs)
//   /_hub/branches   GET ?github=owner/repo or ?remote=<git link> lists branches and the repo default
//   /_hub/board-repo/<route> GET repo and branch; POST {github | remote, branch} prepares the clone and sends
//                     repo-changed (board-repo.mjs); the hub board's GET names kickflip's clone and its POST is refused
//   /_hub/board-model/<route> GET {orchestrators, hub}; POST {model: opus | sonnet | null for Hub default}
//                     → {orchestrators, applies} (board-model.mjs)
//   /_hub/board-model/<route>/restart POST stops a background board's session and starts a fresh one on its model
//                     → {route, session, previous, model}
//   /_hub/new-board  POST {name, github | remote, branch, purpose, tickets, model?} → {route}: a starting reservation, then the board's session starts
//                     without holding the response; DELETE /_hub/new-board/<route> dismisses a start that failed
//                     or timed out, and POST /_hub/new-board/<route>/retry (application/json) starts it again → {route}
//                     (new-board.mjs)
//   /_hub/close-board/<route> GET the board's title, hub flag, open PRs and running builder records
//   /_hub/close-board POST {route, name} stops the session, closes builder records and keeps the site under `closed`
//   /_hub/reopen-board POST {route} restores that entry and resumes its recorded session (close-board.mjs)
//   /_hub/restart-server POST {route} from a board's New server version row: restarts that board's server alone, which
//                     runs older code than its files, as the hub's own restart for new code does → {route}; 404 for no open
//                     board, 409 while its server runs the code in its files
//   /_hub/restart-board POST {route} stops the board's session, restarts its server and, once that answers, resumes
//                     the session → {route, title, session}, or {error} (restart-board.mjs)
//   /_hub/check-update POST from the version in the hub page's footer: runs upgrade.mjs check() now and answers its result
//                     ({state: clone | same | pulling | failed, latest?, error?, commit?})
//   /_hub/restart-hub POST from the hub page's Restart hub: answers {restarting, command} (the hub service's restart
//                     command, for a restart by hand), then runs that restart (board/worktree.mjs restartRunner), which
//                     replaces this process; 409 while one is out
//   /_hub/wake       POST {route} from a board page's tap while the board is asleep: the session check resumes its
//                     session now, as for an event that landed → {route, listen} (boards.mjs listenState)
//   /_hub/machine.json GET what is loading this Mac, for the sheet the Hub row's busy word opens: {load, cores, average,
//                     samples, groups} (machine-load.mjs machineLoad); /_hub/machine/stop POST {pid} (application/json)
//                     ends a process that still looks orphaned and its children → {stopped}, 409 {error} for any other,
//                     503 {error} when ps gave no answer (stopOrphan)
//   /_hub/status.json the manifest's sites and their process state, as JSON
//   /_hub/needs.json  {total, sites: {<route>: {count, working, summary, lanes, building} | null}}: total is the
//                     Home Screen badge; ?fresh=1 skips the cache
//   /<route>/...      forwarded to that site's port with the /<route> prefix
//                     removed (X-Forwarded-Prefix carries it), unless it is a page load the shell takes; a site with a
//                     dir and no port is a plain page whose files the hub serves itself (files.mjs)
//   /sw.js, /manifest.webmanifest, /_hub/icon-*.png
//                     the Home Screen app and its service worker (scope /), which shows pushes and keeps the shell
//                     and its files to open while the host can't be reached; the shell's response carries
//                     X-App-Shell: 1, and a request with X-App-Shell: 1 is a page load (shell.mjs destOf)
//   /_hub/colors.css  ../shared/colors.css, the colours the shell and the down page link; ?v=colorsVersion() caches for a year
//   /_hub/kickflip.png the header's image and every page's tab icon (/favicon.ico redirects to it), and /_hub/hub.css the down page's CSS, read from ../board/public
//   /_hub/push/key    GET the VAPID public key; /_hub/push/subscribe (→ {count, id}), /_hub/push/forget ({id}, from a Remove in Integrations), /_hub/push/unsubscribe ({endpoint}, from a
//                     page whose device lost that subscription) and /_hub/push/test take POSTs from the hub views (push.mjs)
//   The forms below answer the view's JSON when the request accepts application/json, and redirect back with a 303
//   otherwise:
//   /_hub/settings/notifications POST set=on|weekends with value=on (absent for off), or snooze=<push.mjs
//                     setNotifications choice | off> → /_hub/api/settings's JSON, or 400 {error} when refused
//                     (303 to ?refused=snooze). Custom posts a UTC ISO date-time; snoozeEnd refuses an end not
//                     after now or more than 30 days on.
//   /_hub/settings/keep-awake POST keep_awake=on (anything else, or nothing, is off) → /_hub/api/settings's JSON, or
//                     409 {error} off macOS (awake.mjs)
//   /_hub/settings/auto-update POST auto_update=on (anything else, or nothing, is off) → /_hub/api/settings's JSON; stored as autoUpdate: false
//   /_hub/settings/hub-pause POST pause=<usage-gate.mjs pauseEnd choice | off> → Pause hub, then /_hub/api/settings's
//                     JSON, or 400 {error} for an end not after now or more than 30 days on
//                     (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md)
//   /_hub/settings/codex POST value=auto|always|off → /_hub/api/hub's JSON, or 400 {error}, or 409 {error} with the
//                     fix while Codex isn't installed or logged in, checked afresh
//   /_hub/settings/claude-model POST value=opus|auto|sonnet, Builders → /_hub/api/hub's JSON, or 400 {error}
//   /_hub/settings/orchestrator-model POST value=opus|sonnet, Orchestrators (board-model.mjs changeHubOrchestratorModel)
//                     → /_hub/api/hub's JSON, or 400 {error}
//   /_hub/settings/pause-at POST value=50..100 in steps of 5 → /_hub/api/hub's JSON, or 400 {error}; 100 is Off
//   /_hub/settings/keep-going POST value=on|off → /_hub/api/hub's JSON, or 400 {error}; on without a pause → 409 {error}
//   /_hub/settings/linear POST key=<Linear personal API key>, checked with Linear and saved, as refused if Linear
//                     refuses it, or remove=1 → /_hub/api/settings's JSON, whose `linear` names only the workspace,
//                     or 400 {error}, 502 {error} when Linear can't be reached (linear.mjs)
//   /_hub/settings/slack POST token=<Slack user token, xoxp->, checked with Slack's auth.test and saved, as refused if
//                     Slack refuses it, or remove=1 → /_hub/api/settings's JSON, whose `slack` names only the workspace
//                     and user, or 400 {error}, 502 {error} when Slack can't be reached (slack.mjs)
//   /_hub/settings/quiet POST start=HH:MM, end=HH:MM, or set=hold with value=on (absent for off), one schedule.mjs editQuiet change → /_hub/api/settings's
//                     JSON, or 400 {error}
//   /_hub/settings/overnight POST job=<id> with value=on (absent for off) turns an Overnight work job on or off (overnight.mjs
//                     setOvernight) → /_hub/api/settings's JSON, or 400 {error}
//   /_hub/share/<route> GET a board's Sharing for Board settings → {people: [{login, level, name, now, at}], refused:
//                     [{login, name, at}], link}: who the board's board.json share lists, whether each is viewing it now
//                     and when last seen there, who was refused at its paths in the last hour, and the board's tailnet
//                     URL (share.mjs shareTracker)
//   /_hub/presence    POST {} from a shell page's tap, key or scroll, at most once a minute: the owner is present
//                     (presence.mjs ownerTracker); coming back from away runs a check at once → 204
//   /_hub/push/flush  POST sends the queued pushes now → {sent, count, ok, message}
//   /_hub/settings/rules POST {rules: [{id?, text}], base: [id]} saves the hub rules in settings.json (rules.mjs
//                     applyRules) and, when anything changed, sends every board a `rules {scope: "hub", added, edited,
//                     removed}` event (boards.mjs sendToBoards). → {rules, events, failed}; a bad list → 400 {error}
//   /_hub/api/upload  POST the raw file as the body, its name URI-encoded in x-filename → {name, url, path, type, size}: the hub page's New task
//                     box uploads here, to the hub's data/uploads, as a board's api/upload does
//   /_hub/route       POST {text, files?, quick? | request?} (application/json) from that box: queues the task for the router
//                     (from.via hub) and answers 202 {queued} at once; 400 {error} for no text or file, or another request
//   /_hub/poll        POST runs one poll now, or joins the running one, and returns its result as JSON;
//                     {"flush": false} skips sending the queue (`kickflip poll-now`)
//   /_hub/build       POST {route, key, anyway?}, key <file>/<id> or main (retry failed tip), loopback only:
//                     runs <worktree>/.kickflip/build[-<board's build target>] <key> <worktree>
//                     asynchronously; data/try.json and data/try/<id>.log carry its state (try.mjs). A card's new
//                     serve at the board's max_serves → 409 {error, ask: 'cap'}; on a busy host without anyway: true
//                     → 409 {error, ask: 'busy'}
//   /_hub/kill        POST {route, key}, loopback only: a card's Kill, stopping its serve → {status: 'stopped'}, or
//                     409 when none runs (try.mjs kill)
//   /_hub/pull        POST {route}, loopback only: Main's refresh icon on a local board. Fast-forwards the board's
//                     branch from origin now and rebuilds Main when that brought commits → {commits, error?} (try.mjs)
//   /_hub/prompts     POST a PermissionRequest hook's input (permission-hook.mjs) → {id, deadline}: a pending prompt in
//                     prompts.json, answered on its board's strip or the hub page, with a push
//                     (docs/adr/2026-10-30-1516-background-sessions-prompts-come-to-the-phone.md), or {state: 'answered', answer}
//                     with allow when the session has a remembered exact match, with no pending prompt or push
//   /_hub/prompts/<id>/wait?ms=N  GET, the hook's poll, held up to N ms (at most prompts.mjs POLL_MS) →
//                     {state: 'pending'} or {state: 'answered', answer}, which removes the prompt; 404 once it's gone
//   /_hub/prompts/<id>/answer  POST the owner's {choice: allow | always | deny, answers?} from a page → {ok};
//                     404 when gone, 409 when already answered, 400 {error} for a choice that doesn't fit
//   /_hub/prompts/<id> DELETE, the hook giving up at its deadline
//   /_hub/permission-denied  POST a PermissionDenied hook's input (permission-denied-hook.mjs) → {noted}: the board
//                     permission switch whose rule allows the refused command, noted under it while on, or null. A
//                     PermissionRequest for such a command notes it the same way
// Every request and upgrade first passes the owner gate (board/on-host.mjs ownerGate): anyone but the host, a direct
// loopback caller or a device signed in to Tailscale as the host's user gets front-door.mjs's refusal, the same on
// every path (docs/adr/2026-11-04-2156-the-whole-hub-answers-only-the-owner.md). A login a board's board.json share
// lists is that board's shared person instead: they reach the shell, their boards and those boards' reads by GET or HEAD,
// on a board they have Full on its event and upload POSTs, forwarded with X-Kickflip-Shared naming them, the sidebar and
// stream filtered to their boards, and a hub page sends them to `/` (share.mjs;
// docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md,
// docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md).
// Every non-GET/HEAD request passes ../starter/cross-site.mjs before routing or proxying (403 plain text).
// Routes that parse JSON require application/json; settings forms and raw uploads keep their own types.
// /_hub/build, /_hub/kill and /_hub/pull also require loopback and refuse Origin and forwarded headers.
// It also runs every site: it starts each manifest entry's `cmd`, restarts it
// when it exits, restarts it when its entry changes, and stops every one before it exits itself. A site with a port and
// no `cmd` runs its own server: the hub only probes it, and it reads Down while nothing answers
// (docs/adr/2026-11-01-1446-a-page-joins-without-a-session.md). Every minute while the owner is present and every 5
// while away (schedule.mjs nextCheckAt, presence.mjs ownerTracker), and once a minute after it starts, it checks
// GitHub (github.mjs), fetches and pulls each board's repo, checks each auto-review board's incoming PRs (incoming.mjs), pushes once for each board that is deaf (boards.mjs
// checkListening, listenState), then sends the queued pushes unless schedule.mjs heldUntil holds them;
// one poll never overlaps another, and coming back from away runs one at once. At the end of quiet hours it wakes each
// board's session once a day (github.mjs sendWakes) unless Daily wake is off in Overnight work (overnight.mjs)
// (docs/adr/2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md). From their middle it
// runs every board's tests on its main once a night, unless Nightly full suite is off (nightly-suite.mjs). Every feature that serves
// boards takes them from boards.mjs listBoards, the one board registry
// (docs/adr/2026-10-29-1639-one-board-registry-for-every-hub-feature.md). The host's service manager keeps the
// hub itself running (../shared/service.mjs, `kickflip init`).
// After each poll it records when each board's hub links first failed (boards.mjs recordLinkFaults). As it starts it
// records the hash of its own code (boards.mjs recordHubCode), so the hub can tell when the
// files changed under it (docs/adr/2026-10-29-1639-hub-links-turn-red-only-after-a-grace-period.md), and
// runs, before any board starts, each hub migration its manifest's `migrated` list doesn't name (board/migrations.mjs
// runMigrations), such as making a hub board that built on the kickflip clone a local board of its folder.
// Every 15 seconds it counts each board's watched lines, and resumes the recorded session of a board that got an event
// while that session wasn't running, and pushes once when that doesn't bring it back (sessions.mjs checkSessions;
// docs/adr/2026-10-30-1601-a-boards-session-wakes-when-an-event-arrives.md). A tap on an asleep board's page wakes it at once
// through /_hub/wake (docs/adr/2026-11-03-0313-boards-run-in-the-background-and-the-hub-board-in-tmux.md). The same check
// restarts a board's session that runs idle without listening, and reconcile a board server that is up but doesn't
// answer, each logged to auto-restarts.jsonl
// (docs/adr/2026-11-15-0123-the-hub-restarts-a-session-not-listening-and-a-server-not-answering.md).
// Every 15 seconds it drops the pending prompts whose hook has gone (prompts.mjs expired).
// It runs caffeinate -s while Keep awake is on, and starts it again as it starts (awake.mjs).
// On paused → normal it sends every board usage-resumed {window}, keeping usage-gate-state.json across restarts.
// It reads the Mac and keeps machine-state.json, with a load sample a minute for the last hour, which holds every board's new work while the Mac is busy
// (shared/machine-gate.mjs; docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md).
// Each served card and main has its own Tailscale HTTPS port, through a loopback relay (try.mjs) that passes the same
// owner gate, and admits its board's shared people by GET or HEAD; its build script gets HOST=127.0.0.1 to listen on.
// Every 15 seconds try.mjs refreshes card heads, auto-builds cards and rebuilds main; polls fetch non-hub branches and
// record each fetch in repo-fetch.json for the board's repo-fetch link. A poll that records a card merged fetches that
// card's board first and refreshes its Main at once (docs/adr/2026-11-03-1619-a-merge-refreshes-its-boards-main-at-once.md).
// Try worktrees live in ~/.claude/kickflip/try/<route>-main; board data/try.json and data/try/*.log record runs.
// State lives in ~/.claude/kickflip: manifest.json, logs/<route>.log, run/<route>.pid, github-state.json, wake-state.json,
// deaf-state.json, link-faults.json, repo-fetch.json, hub-code.json, resume-state.json, auto-restarts.jsonl, prompts.json, secrets.json,
// and the router's route-queue.json and routed.json: every 15 seconds the router files the requests still queued
// (router.mjs drainRoutes; docs/adr/2026-11-12-2345-a-haiku-router-files-each-incoming-request-on-a-board.md), and
// slack-intake.json, where each poll's @kickflip DM search starts (slack-intake.mjs).
import { sweepStaleTempsUnder } from './stale-tmp.mjs';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { routeRecord } from './routes.mjs';
import { publicKey, addSubscription, removeSubscription, removeSubscriptionById, sendAll, flushQueue, queueStatus, saveSettings, readSettings, migrateSettings, setNotifications, deliver } from './push.mjs';
import { readCodexShare, setCodexShare, readClaudeModel, setClaudeModel, readOrchestratorModel, readAutoUpdate, setAutoUpdate } from '../shared/hub-settings.mjs';
import { ownerTracker } from './presence.mjs';
import { POLL_MS, answerOf, expired, pendingFor, promptRecord, pushOf, readPrompts, updatePrompts, shown, pruneRemembered, rememberRules, rememberedAnswer, rememberedFor } from './prompts.mjs';
import { hold, heldUntil, holdLine, editQuiet, checkEvery, nextCheckAt } from './schedule.mjs';
import { capital, hubView, settingsView, flushView, SNOOZE_REFUSED } from './views.mjs';
import { caffeinate, setKeepAwake, awakeOn, awakeUnsupported } from './awake.mjs';
import { endOf } from './duration.mjs';
import { nodeBin } from '../bin/install.mjs';
import { checkGitHub, sendWakes } from './github.mjs';
import { migrateTriage, overnightJobs, setOvernight } from './overnight.mjs';
import { runNightlySuite } from './nightly-suite.mjs';
import { checkIncoming } from './incoming.mjs';
import { drainRoutes, queueRequest, routedRows } from './router.mjs';
import { listBoards, isListening, isBoardSite, listenState, resumeStateFile, sendToBoards, checkListening, recordHubCode, hubCode, runningHubCode, boardCode, recordLinkFaults, linksOf, hubCodeState, readJSON, migrateCellarNode, servedSites } from './boards.mjs';
import { liveSessions } from './live.mjs';
import { RuleError, applyRules, changed, readHubRules, writeHubRules } from './rules.mjs';
import { siteIcon } from './icons.mjs';
import { readNeeds, sidebarSites, startRoute, hubHealth, holdNeeds, heldSite, sidebarPause } from './home.mjs';
import { checkSessions, compactFullContexts, logStartPrompt, sessionOf, startSignals, startingBoards } from './sessions.mjs';
import { codeRestartHeld, logRestart, restartHeld, restartLines } from './auto-restarts.mjs';
import { checkLoggedOut, loggedOutRoutes } from './logged-out.mjs';
import { repoService, repoLookupRoute } from './repos.mjs';
import { boardRepo, changeBoardRepo } from './board-repo.mjs';
import { boardModel, changeBoardModel, changeHubOrchestratorModel, restartOnModel } from './board-model.mjs';
import { requestBoard, retryBoard, dismissBoard, clonePercent, settleStarts } from './new-board.mjs';
import { boardClosure, closeBoard, closedBoards, reopenBoard } from './close-board.mjs';
import { restartBoard, restartable } from './restart-board.mjs';
import { crossSite, isJSON } from '../starter/cross-site.mjs';
import { BOARD_PUBLIC, appFile, colorsVersion, destOf, fileVersion, pageOf, shellHtml } from './shell.mjs';
import { hubStream } from './stream.mjs';
import { usageReader, checkUsagePause, contextReading } from './usage.mjs';
import { readUsageGate, setPauseAt, setKeepGoing, setHubPause, boardPausedUntil } from '../shared/usage-gate.mjs';
import { checkMachine, readMachine as readMac } from '../shared/machine-gate.mjs';
import { logHostLoad } from './host-load-log.mjs';
import { machineLoad, stopOrphan, boardBuilders, claudeSessions } from './machine-load.mjs';
import { readiness, readCodex } from './readiness.mjs';
import { BuildError, startBuild, killBuild, stopTries, endUnsharedTries, tryTick, initializeTries, fetchTryBranches, pullNow, pullMains } from './try.mjs';
import { serveFiles } from './files.mjs';
import { upgrader } from './upgrade.mjs';
import { restarter } from './self-restart.mjs';
import { fallBackFromLinear, saveUpload } from '../board/store.mjs';
import { runMigrations } from '../board/migrations.mjs';
import { recordRefusal } from '../board/permissions.mjs';
import { hubGate } from '../board/on-host.mjs';
import { pipeUpgrade, refuse, refuseUpgrade } from './front-door.mjs';
import { shareEntries, sharedRoutes, shareReach, routeOfPath, sharedSidebar, shareTracker } from './share.mjs';
import { restartRunner } from '../board/worktree.mjs';
import { hubService } from '../shared/service.mjs';
import { cloneRoot } from '../shared/repos.mjs';
import { POLLS, CLOCKS, dueOn } from '../shared/polls.mjs';
import { pollsPage } from './polls-page.mjs';
import { LinearError, linearStatus, removeLinearKey, saveLinearKey, savedClient } from './linear.mjs';
import { SlackError, slackStatus, removeSlackToken, saveSlackToken } from './slack.mjs';
import { sendReviews } from './review-send.mjs';
import { fileSlackAsks, followSlackAsks, postSlackReplies } from './slack-intake.mjs';
import { createAnswering } from './answering.mjs';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const COLORS = path.join(HUB_DIR, '..', 'shared', 'colors.css');
// The version of the code this process started with; new files on disk run only after a restart.
const VERSION = JSON.parse(fs.readFileSync(path.join(HUB_DIR, '..', 'package.json'), 'utf8')).version;

const stampedLog = (...a) => console.log(new Date().toISOString(), ...a);

// Whether something listens on the port, within PROBE_TIMEOUT.
const PROBE_TIMEOUT = 2000;
// The process listening on 127.0.0.1's port, {pid, command}, as lsof and ps name it; null when neither can.
function portHolder(port) {
  try {
    const pid = Number(execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0]);
    return { pid, command: execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() };
  } catch { return null; }
}

// Whether a process's command line ends in the site's own last argument (its dir), exactly: a server for a folder whose
// path merely contains this one's is another board's.
function runsSite(command, site) {
  return command.endsWith(' ' + site.cmd[site.cmd.length - 1]);
}

function tcpProbe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(PROBE_TIMEOUT, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

// Whether a server on port answers HTTP: any response within PROBE_TIMEOUT. A server whose event loop is stuck still
// accepts connections, which tcpProbe counts as up.
function httpProbe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/_claude/health', timeout: PROBE_TIMEOUT }, (res) => { res.destroy(); resolve(true); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

// Starts the hub on ~/.claude/kickflip of os.homedir(), listening on 127.0.0.1:port (0 picks a free one), and resolves
// once it listens. Options stand in for what it reads of the host:
//   now() → the time in ms the supervisor's restart waits, the poll schedule and the caches read;
//   codeRestarts: false keeps a board server whose code changed running, offering no Restart, and the hub from
//   restarting for new code;
//   probe(port) → whether a site's port answers (reconcile's probes);
//   answers(port) → whether a board server that is up answers HTTP (reconcile's hung check);
//   readMachine() → the Mac's {load, cores, pressure} for the busy gate (shared/machine-gate.mjs);
//   gate: the owner gate every request passes (board/on-host.mjs ownerGate);
//   awake: the Keep awake controller (awake.mjs caffeinate);
//   log(...parts): each line the hub logs, stamped on stdout by default;
//   ticks: false runs neither of its clocks (shared/polls.mjs CLOCKS), so no reconcile, tick, hung check, new-code
//   check, share save or nightly suite of its own, and no poll it wasn't asked for: the caller runs each pass.
// → {port, reconcile(), hung(), tick(), poll(options), settled(), close()}: reconcile, hung, tick and poll run one pass
// and resolve when it is done; settled() resolves once every pass started so far, by a call, a timer or a request, is
// done; close() stops every site and the server, as the hub does on SIGTERM.
export async function startHub({ port: askedPort = 0, now: clock = Date.now, codeRestarts = process.env.KICKFLIP_CODE_RESTARTS !== 'off', log = stampedLog, probe = tcpProbe, answers = httpProbe, readMachine = readMac, gate = hubGate, awake = caffeinate({ log }), ticks = true } = {}) {
  const HOME = path.join(os.homedir(), '.claude', 'kickflip');
  const MANIFEST = path.join(HOME, 'manifest.json');
  const LOGS = path.join(HOME, 'logs');
  const RUN = path.join(HOME, 'run');
  for (const d of [HOME, LOGS, RUN]) fs.mkdirSync(d, { recursive: true });
  // The port the hub listens on, once it does; sites it starts get it as KICKFLIP_HUB_PORT.
  let PORT = askedPort;

  // Every pass in flight (track), for settled().
  const passes = new Set();
  const track = (p) => { passes.add(p); p.finally(() => passes.delete(p)).catch(() => {}); return p; };
  async function settled() { while (passes.size) await Promise.allSettled([...passes]); }

  try { const code = recordHubCode(); log(`hub code ${code.hash} (${code.files.length} files)`); } catch (e) { log('could not record the hub code hash:', e.message); }
  await runMigrations('hub', { log, error: log });
  try { const { routes, loginItem } = await migrateCellarNode(); if (routes.length) log(`manifest: ${routes.map((r) => `/${r}`).join(', ')} spawn node by Homebrew's link`); if (loginItem) log("hub login item file: spawns node by Homebrew's link"); } catch (e) { log('Cellar node migration failed:', e.message); }
  try { const moved = await migrateTriage(); if (moved) log(`boards: auto_triage moved to the hub's Triage overnight switch, ${moved.on ? 'on' : 'off'}`); } catch (e) { log('triage migration failed:', e.message); }
  try { const gone = sweepStaleTempsUnder(HOME); if (gone.length) log(`swept ${gone.length} temp files left by killed writes`); } catch (e) { log('temp file sweep failed:', e.message); }
  const repos = repoService();
  const readUsage = usageReader();
  await awake.apply();

  // ---------- manifest ----------
  let manifest = { version: 1, sites: {} };
  // Read on every call: Linux stamps file mtimes per clock tick, so two writes a few ms apart can share an mtime, and a
  // cache keyed on it keeps the first.
  function loadManifest() {
    try {
      manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
      manifest.sites ||= {};
    } catch (e) {
      if (e.code === 'ENOENT') manifest = { version: 1, sites: {} };
      else log('manifest unreadable, keeping the last good copy:', e.message);
    }
    return manifest;
  }

  // ---------- supervisor ----------
  // route -> { child, key, state, since, exitCode, restarts, nextStart, up, code, newCode, waitedOn, why }: code is a board
  // server's boardCode as it started, newCode the newer code in its files while it runs older code, waitedOn that code
  // and what its restart last waited on, why 'code' from that restart's stop until the new server answers or crashes
  const procs = new Map();
  // Every child spawned and not yet exited, including one whose route has left procs.
  const children = new Set();
  let shuttingDown = false;
  const KILL_AFTER = 5000;
  const keyOf = (s) => JSON.stringify([s.cmd, s.cwd || s.dir, s.port, s.env || {}, s.restart_at || 0]);
  const runs = (s) => Array.isArray(s?.cmd) && s.cmd.length > 0 && Boolean(s.port);
  // How a site is served: 'cmd', a server the hub runs; 'port', one it only forwards to; 'files', its dir served by the hub.
  const servesOf = (s) => (runs(s) ? 'cmd' : s?.port ? 'port' : 'files');
  // What the probes read of each 'port' site (answering.mjs): down only after several misses in a row.
  const answering = createAnswering();

  function pidFile(route) { return path.join(RUN, route + '.pid'); }

  function killStale(route, site) {
    // A hub that died hard leaves its children running and holding their ports.
    // Only stop the recorded pid if it still runs this site's command: pids get reused.
    try {
      const pid = Number(fs.readFileSync(pidFile(route), 'utf8'));
      const cmdline = pid ? execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() : '';
      if (cmdline && runsSite(cmdline, site)) { process.kill(-pid, 'SIGTERM'); log(`stopped stale ${route} (pgid ${pid})`); }
    } catch {}
    try { fs.unlinkSync(pidFile(route)); } catch {}
  }

  // docs/adr/2026-11-14-0730-a-board-server-holds-its-port-before-it-launches-anything.md
  // Whether a site's port is free for the hub to start its server. A process the hub has no child for that runs the
  // site's command (one a hub that died hard left, its pid file gone) is stopped, and the start waits for the port it
  // held, so one start follows rather than a run of starts each losing the port. A port held by anything else is left
  // alone: the site waits a backoff step and says who holds it.
  async function portFree(route, site) {
    if (!(await probe(site.port))) return true;
    const holder = portHolder(site.port);
    if (holder && runsSite(holder.command, site)) {
      log(`stopped stray ${route} on port ${site.port} (pid ${holder.pid})`);
      try { process.kill(holder.pid, 'SIGTERM'); } catch {}
      const deadline = Date.now() + KILL_AFTER;
      while (await probe(site.port)) {
        if (Date.now() >= deadline) { try { process.kill(holder.pid, 'SIGKILL'); } catch {} }
        if (Date.now() >= deadline + KILL_AFTER) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!(await probe(site.port))) return true;
    }
    const p = procs.get(route) || { restarts: 0 };
    Object.assign(p, { child: null, key: keyOf(site), state: 'crashed', exitCode: null, nextStart: clock() + backoff(p.restarts++) });
    procs.set(route, p);
    log(`${route} not started: port ${site.port} is held by ${holder ? `pid ${holder.pid} (${holder.command})` : 'a process the hub can’t name'}`);
    return false;
  }

  function start(route, site) {
    const p = procs.get(route) || { restarts: 0 };
    const out = fs.openSync(path.join(LOGS, route + '.log'), 'a');
    const [cmd, ...args] = site.cmd;
    const env = { ...process.env, KICKFLIP_HUB_PORT: String(PORT), ...(site.env || {}), PORT: String(site.port), PREFIX: '/' + route, KICKFLIP_ROUTE: route };
    fs.writeSync(out, `\n--- ${new Date().toISOString()} hub starting: ${site.cmd.join(' ')} (port ${site.port})\n`);
    p.code = isBoardSite(site) ? boardCode(site) : null;
    p.newCode = null;
    let child;
    try {
      child = spawn(cmd, args, { cwd: site.cwd || site.dir, env, stdio: ['ignore', out, out], detached: true });
    } catch (e) {
      fs.writeSync(out, `hub could not start it: ${e.message}\n`);
      fs.closeSync(out);
      Object.assign(p, { child: null, key: keyOf(site), state: 'crashed', exitCode: null, nextStart: clock() + backoff(p.restarts++) });
      procs.set(route, p);
      return;
    }
    fs.closeSync(out);
    fs.writeFileSync(pidFile(route), String(child.pid));
    Object.assign(p, { child, key: keyOf(site), state: 'starting', since: clock(), exitCode: null, up: false });
    procs.set(route, p);
    log(`started ${route} pid ${child.pid}`);
    if (child.pid) children.add(child);
    const ended = (code, sig) => {
      children.delete(child);
      if (p.child !== child) return;
      try { fs.unlinkSync(pidFile(route)); } catch {}
      const ranLong = clock() - p.since > 60_000;
      if (ranLong) p.restarts = 0;
      Object.assign(p, { child: null, state: p.stopping ? 'stopped' : 'crashed', exitCode: code ?? sig, nextStart: clock() + backoff(p.restarts++), why: p.stopping ? p.why : undefined });
      p.stopping = false;
      log(`${route} exited (${code ?? sig})`);
      // The reconcile rides the 15 s clock; a child's exit has it start the server again once its backoff is over.
      if (ticks && !shuttingDown) setTimeout(reconcileLogged, Math.max(0, p.nextStart - clock())).unref(); // poll: none, one reconcile per exit
    };
    // A child that never spawned, such as one whose cwd is missing, emits no exit.
    child.on('error', (e) => { log(`${route} spawn error: ${e.message}`); if (!child.pid) ended(e.code, null); });
    child.on('exit', ended);
  }

  const backoff = (n) => Math.min(60_000, 1000 * 2 ** Math.min(n, 6));

  function stop(route) {
    const p = procs.get(route);
    if (!p || !p.child) { procs.delete(route); return; }
    p.stopping = true;
    const c = p.child;
    signal(c, 'SIGTERM');
    setTimeout(() => { if (children.has(c)) signal(c, 'SIGKILL'); }, KILL_AFTER).unref();
  }

  const signal = (child, sig) => { try { process.kill(-child.pid, sig); } catch {} };

  let first = true;
  const closingResponses = new Set();
  // Whether the hub page's Restart hub is out (/_hub/restart-hub).
  let hubRestarting = false;
  // Routes whose Restart (restart-board.mjs) is running; the session wake waits them out.
  const restarting = new Set();
  const SERVER_WAIT = 30_000;
  // Whether the route's server, started from its entry as it reads now, answers within SERVER_WAIT. Each check runs a
  // reconcile pass first, so the restart stops, starts and probes the server itself rather than on the hub's timer.
  async function serverAnswers(route) {
    const deadline = Date.now() + SERVER_WAIT;
    for (;;) {
      await reconcileLogged();
      const site = routeRecord(loadManifest().sites, route);
      const p = procs.get(route);
      if (site && p?.child && p.up && p.key === keyOf(site)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  // One reconcile at a time: a call while one runs waits for it, then runs its own, so each call's pass reads the
  // manifest and ports as they are after the call.
  let reconciled = Promise.resolve();
  function reconcile() {
    reconciled = reconciled.then(reconcilePass, reconcilePass);
    return track(reconciled);
  }
  async function reconcilePass() {
    if (shuttingDown) return;
    // A starting New board's site runs too (boards.mjs servedSites), and its join keeps the entry, so the server runs on.
    const sites = servedSites(loadManifest());
    for (const route of [...procs.keys()]) {
      if (closingResponses.has(route)) continue;
      if (!routeRecord(sites, route)) { log(`${route} left the manifest; stopping it`); stop(route); procs.delete(route); }
      else if (!runs(routeRecord(sites, route))) { log(`${route} no longer has a command; stopping it`); stop(route); procs.delete(route); }
    }
    for (const route of answering.routes()) if (servesOf(routeRecord(sites, route)) !== 'port') answering.forget(route);
    // One probe per port site a pass, which answering records and a running server's up reads.
    const probed = new Map(await Promise.all(Object.entries(sites).filter(([, site]) => servesOf(site) === 'port').map(async ([route, site]) => {
      const up = await probe(site.port);
      answering.record(route, up);
      return [route, up];
    })));
    for (const [route, site] of Object.entries(sites)) {
      if (!runs(site)) continue;
      if (first) killStale(route, site);
      const p = procs.get(route);
      if (p && p.child && p.key !== keyOf(site)) {
        log(`${route} entry changed; restarting it`);
        stop(route);
        p.restarts = 0;
        p.nextStart = clock() + 1500;
        continue;
      }
      // docs/adr/2026-11-16-1500-new-code-restarts-on-a-busy-board-once-no-land-is-landing.md
      const onDisk = codeRestarts && p?.child && p.code && !p.stopping && !restarting.has(route) && !closingResponses.has(route) ? boardCode(site) : null;
      if (onDisk) p.newCode = onDisk === p.code ? null : onDisk;
      if (onDisk && p.newCode) {
        const held = codeRestartHeld();
        if (!held) {
          log(`${route} runs older code than its files; restarting it`);
          restartForCode(route);
          continue;
        }
        if (p.waitedOn !== `${onDisk} ${held}`) log(`${route} runs older code than its files; its restart waits, since ${held}`);
        p.waitedOn = `${onDisk} ${held}`;
      }
      if ((!p || (!p.child && clock() >= (p.nextStart || 0))) && await portFree(route, site)) start(route, site);
    }
    first = false;
    for (const [route, p] of procs) {
      const site = routeRecord(sites, route);
      if (!site) continue;
      p.up = p.child ? (probed.has(route) ? probed.get(route) : await probe(site.port)) : false;
      if (p.child && p.up) Object.assign(p, { state: 'up' }, p.stopping ? {} : { why: undefined });
    }
    endUnshared();
  }

  // The hung check, on the 15 s clock, reads each server as the last reconcile probed it, in turn with the reconciles.
  function checkHung() {
    reconciled = reconciled.then(hungPass, hungPass);
    return track(reconciled);
  }
  async function hungPass() {
    if (shuttingDown) return;
    const sites = servedSites(loadManifest());
    await Promise.all([...procs].map(([route, p]) => {
      const site = routeRecord(sites, route);
      return site && isBoardSite(site) && !restarting.has(route) && !closingResponses.has(route) ? watchHung(route, site, p) : null;
    }));
  }

  // docs/adr/2026-11-15-0123-the-hub-restarts-a-session-not-listening-and-a-server-not-answering.md
  // A board server that is up but hasn't answered HTTP (answers) for HUNG_AFTER is restarted, once per outage, unless
  // auto-restarts.mjs restartHeld holds it. p.hung {since, held?, restartedAt?, pushed?} lasts until the server answers again;
  // one that hasn't SERVER_COMEBACK after its restart pushes the owner once. Each restart and whether it brought the
  // server back go to auto-restarts.jsonl.
  const HUNG_AFTER = 60_000;
  const SERVER_COMEBACK = 2 * 60_000;
  const HUNG = 'not answering';
  async function watchHung(route, site, p) {
    const asked = p.child && p.up && !p.stopping;
    const answered = asked && await answers(site.port);
    const restartedAt = p.hung?.restartedAt;
    if (answered) {
      if (restartedAt && !p.hung.pushed) logRestart({ board: route, what: 'server', why: HUNG, outcome: 'back' }, { now: new Date(clock()) });
      p.hung = null;
      return;
    }
    if (restartedAt) {
      if (p.hung.pushed || clock() - restartedAt < SERVER_COMEBACK) return;
      p.hung.pushed = true;
      logRestart({ board: route, what: 'server', why: HUNG, outcome: 'not back' }, { now: new Date(clock()) });
      log(`${route} still doesn't answer after the hub restarted it`);
      const title = site.title || route;
      try {
        await deliver({ title: `${title}'s server didn't come back`, body: `The hub restarted it because it stopped answering, and it still doesn't. See kickflip logs ${route}.`, url: '/_hub/', tag: `server-${route}` }, { kind: 'fault', immediate: true, at: new Date(clock()) });
      } catch (e) { log(`${route}: could not push that its server didn't come back (${e.message})`); }
      return;
    }
    if (!asked) { p.hung = null; return; }
    p.hung ||= { since: clock() };
    if (clock() - p.hung.since < HUNG_AFTER) return;
    const owner = sessionOf(loadManifest(), route);
    const held = await restartHeld({ dir: site.dir, record: owner ? liveSessions()?.get(owner.session) : null });
    if (held) {
      if (p.hung.held !== held) log(`${route} hasn't answered for a minute; its restart waits, since ${held}`);
      p.hung.held = held;
      return;
    }
    log(`${route} hasn't answered for a minute; restarting it`);
    logRestart({ board: route, what: 'server', why: HUNG, outcome: 'restarted' }, { now: new Date(clock()) });
    stop(route);
    Object.assign(p, { restarts: 0, nextStart: clock() + 1500 });
    p.hung.restartedAt = clock();
  }
  // The hub restarts itself for new code once it is whole on disk (self-restart.mjs), and a board server whose code
  // changed (reconcile above), each once no land is landing (auto-restarts.mjs codeRestartHeld), unless codeRestarts is false (KICKFLIP_CODE_RESTARTS=off): a try run's demo hub, which the hub
  // serving it restarts whole when its worktree moves. A crash or a missing server restarts at once as ever; only new
  // code waits (docs/adr/2026-11-16-1500-new-code-restarts-on-a-busy-board-once-no-land-is-landing.md).
  // Stops route's server for its new code; the reconcile starts it again, its page reading restarting · its code changed.
  function restartForCode(route) {
    stop(route);
    Object.assign(procs.get(route), { restarts: 0, nextStart: clock() + 1500, why: 'code' });
  }
  const selfRestart = restarter({ root: cloneRoot(), files: hubCode().files, restart: () => restartRunner('hub'), idle: async () => codeRestartHeld(), log });
  const reconcileLogged = () => reconcile().catch((e) => log('reconcile failed:', e.message));
  const timers = [];

  // ---------- polling ----------
  try { if (await migrateSettings()) log('settings: migrated the polling windows to quiet hours'); } catch (e) { log('settings migration failed:', e.message); }
  // A board on Linear falls back to internal tickets while Hub has no Linear key (store.mjs fallBackFromLinear).
  const linearFallback = async () => { try { for (const line of await fallBackFromLinear()) log(`linear: ${line}`); } catch (e) { log('linear fallback failed:', e.message); } };
  await linearFallback();

  const FIRST_POLL_MS = 60_000;
  const ERROR_LOG_MS = 60 * 60_000;
  // running: the poll in progress; startedAt: when the last one began; last: its result; remaining: GitHub's points left
  // after its query, null when it made none.
  const polls = { running: null, startedAt: 0, firstAt: clock() + FIRST_POLL_MS, last: null, remaining: null, errorLoggedAt: 0, linearErrorLoggedAt: 0, slackErrorLoggedAt: 0, slackIntakeErrorLoggedAt: 0, slackFollowErrorLoggedAt: 0, slackRepliesErrorLoggedAt: 0 };
  const owner = ownerTracker();

  const nextPollAt = () => (polls.startedAt ? nextCheckAt({ last: new Date(polls.startedAt), ...owner.state(), remaining: polls.remaining }) : new Date(polls.firstAt));
  // A change in the owner's presence repaints every page's moon; coming back runs a check at once.
  function presenceChanged({ changed, back }) {
    if (changed) stream.refresh();
    if (back && polls.startedAt && !polls.running) runPoll().catch((e) => log('poll failed:', e.message));
  }

  // The GitHub, Linear and Slack poll, which the tick starts when nextPollAt says (schedule.mjs checkEvery).
  // poll: github-poll
  function runPoll({ flush = true } = {}) {
    if (polls.running) return polls.running;
    const startedAt = new Date();
    polls.startedAt = startedAt.getTime();
    polls.running = track((async () => {
      const settings = readSettings();
      let result;
      // checked.json's minutes are the away cadence's, the longest the next check can take, so a quiet page never reads late.
      try { result = await checkGitHub({ every: checkEvery({ present: false, remaining: polls.remaining }), manifest: loadManifest() }); }
      catch (e) { result = { at: startedAt.toISOString(), watched: 0, failed: [e.message], changes: [], events: [], checked: [], merged: [], linear: { moved: [], failed: [] }, rate: null }; }
      polls.remaining = result.rate?.remaining ?? null;
      // docs/adr/2026-11-03-1619-a-merge-refreshes-its-boards-main-at-once.md
      if (result.merged.length) {
        try { await fetchTryBranches({ manifest: loadManifest(), log, routes: result.merged }); }
        catch (e) { log('merge fetch failed:', e.message); }
        log(`merged on ${result.merged.join(', ')}: fetched and refreshing Main`);
        tryTick({ manifest: loadManifest(), routes: result.merged }).catch((e) => log('merge refresh failed:', e.message));
      }
      try { await fetchTryBranches({ manifest: loadManifest(), log }); }
      catch (e) { log('fetch failed:', e.message); }
      // docs/adr/2026-11-03-1914-a-local-boards-main-pulls-from-origin-on-its-own.md
      try {
        const pulled = await pullMains({ manifest: loadManifest() });
        if (pulled.length) tryTick({ manifest: loadManifest(), routes: pulled }).catch((e) => log('pull refresh failed:', e.message));
      } catch (e) { log('pull failed:', e.message); }
      // docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
      try { result.failed.push(...(await checkIncoming({ manifest: loadManifest() })).failed); }
      catch (e) { result.failed.push(`incoming PRs: ${e.message}`); }
      if (result.failed.length && clock() - polls.errorLoggedAt > ERROR_LOG_MS) {
        polls.errorLoggedAt = clock();
        log(`github check: ${result.failed.length} step${result.failed.length === 1 ? '' : 's'} failed, first: ${result.failed[0]} (logged at most hourly)`);
      }
      if (result.changes.length) log(`github check: ${result.changes.map((c) => `#${c.pr} ${c.changes.join(',')}`).join('; ')} → ${result.events.map((e) => e.route).join(', ') || 'no board'}`);
      for (const { id, state } of result.linear.moved) log(`linear: ${id} → ${state}`);
      if (result.linear.failed.length && clock() - polls.linearErrorLoggedAt > ERROR_LOG_MS) {
        polls.linearErrorLoggedAt = clock();
        log(`linear check: ${result.linear.failed.length} step${result.linear.failed.length === 1 ? '' : 's'} failed, first: ${result.linear.failed[0]} (logged at most hourly)`);
      }
      // docs/adr/2026-11-05-0141-the-hub-sends-reviewer-slack-messages-with-its-own-token.md
      try { result.slack = await sendReviews({ boards: listBoards(loadManifest()) }); }
      catch (e) { result.slack = { sent: [], failed: [e.message] }; }
      for (const line of result.slack.sent) log(`slack: sent ${line}`);
      if (result.slack.failed.length && clock() - polls.slackErrorLoggedAt > ERROR_LOG_MS) {
        polls.slackErrorLoggedAt = clock();
        log(`slack sends: ${result.slack.failed.length} failed, first: ${result.slack.failed[0]} (logged at most hourly)`);
      }
      // docs/adr/2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md: queued here, routed on the tick.
      // poll: slack-poll
      try { result.slackIntake = await fileSlackAsks({ boards: listBoards(loadManifest()) }); }
      catch (e) { result.slackIntake = { filed: [], failed: [e.message] }; }
      for (const line of result.slackIntake.filed) log(`slack: @kickflip from ${line}, queued for the router`);
      if (result.slackIntake.failed.length && clock() - polls.slackIntakeErrorLoggedAt > ERROR_LOG_MS) {
        polls.slackIntakeErrorLoggedAt = clock();
        log(`slack intake: ${result.slackIntake.failed.length} failed, first: ${result.slackIntake.failed[0]} (logged at most hourly)`);
      }
      // docs/adr/2026-11-15-1530-later-replies-in-a-slack-filed-tasks-thread-land-on-the-task.md
      try { result.slackFollow = await followSlackAsks({ boards: listBoards(loadManifest()) }); }
      catch (e) { result.slackFollow = { copied: [], failed: [e.message] }; }
      for (const line of result.slackFollow.copied) log(`slack: copied a reply onto ${line}`);
      if (result.slackFollow.failed.length && clock() - polls.slackFollowErrorLoggedAt > ERROR_LOG_MS) {
        polls.slackFollowErrorLoggedAt = clock();
        log(`slack follow: ${result.slackFollow.failed.length} failed, first: ${result.slackFollow.failed[0]} (logged at most hourly)`);
      }
      // docs/adr/2026-11-16-1700-replies-to-a-slack-message-post-into-its-slack-thread.md
      try { result.slackReplies = await postSlackReplies({ boards: listBoards(loadManifest()) }); }
      catch (e) { result.slackReplies = { posted: [], failed: [e.message] }; }
      for (const line of result.slackReplies.posted) log(`slack: posted ${line}`);
      if (result.slackReplies.failed.length && clock() - polls.slackRepliesErrorLoggedAt > ERROR_LOG_MS) {
        polls.slackRepliesErrorLoggedAt = clock();
        log(`slack replies: ${result.slackReplies.failed.length} failed, first: ${result.slackReplies.failed[0]} (logged at most hourly)`);
      }
      try { result.deaf = await checkListening({ manifest: loadManifest() }); }
      catch (e) { result.deaf = { pushed: [], failed: [e.message] }; }
      if (result.deaf.pushed.length || result.deaf.failed.length) log(`not listening: pushed ${result.deaf.pushed.join(', ') || 'none'}${result.deaf.failed.length ? `; ${result.deaf.failed.join('; ')}` : ''}`);
      try { recordLinkFaults(loadManifest()); } catch (e) { log('could not record link faults:', e.message); }
      result.flushed = null;
      result.held = heldUntil(startedAt, settings) !== null;
      if (flush && !result.held) {
        try {
          const r = await flushQueue();
          if (r) { result.flushed = { count: r.count, sent: r.sent, ok: r.ok }; log(`push queue: sent ${r.sent} of ${r.count} queued`); }
        } catch (e) { log('push queue flush failed:', e.message); }
      }
      polls.last = result;
      return result;
    })().finally(() => { polls.running = null; }));
    return polls.running;
  }

  let waking = null;
  function runWakes() {
    waking ||= sendWakes({ settings: readSettings(), manifest: loadManifest() }).then((r) => {
      if (r.due.length) log(`wake ${r.due.join(', ')}: check-github → ${r.events.map((e) => e.route).join(', ') || 'no board'}${r.failed.length ? `; ${r.failed.join('; ')}` : ''}`);
    }).catch((e) => log('wake failed:', e.message)).finally(() => { waking = null; });
    return track(waking);
  }

  // The nightly full suite (nightly-suite.mjs), every 15 minutes on the 15 s clock, apart from the tick: a run takes
  // minutes per board, and a pass calling tick() never starts one.
  let suiting = null;
  function runSuite() {
    suiting ||= runNightlySuite({ now: new Date(clock()), settings: readSettings(), manifest: loadManifest() }).then((r) => {
      if (r) log(`nightly suite ${r.night}: ${r.runs.map((x) => `${x.route} ${x.ok ? 'ok' : x.error ? `couldn't run (${x.error})` : 'failed, filed a task'}`).join('; ') || 'no board'}`);
    }).catch((e) => log('nightly suite failed:', e.message)).finally(() => { suiting = null; });
    return track(suiting);
  }

  // Routes whose page asked for a wake (/_hub/wake) that no session check has taken up yet.
  const wakeAsks = new Set();
  const sessionCheck = { running: null };
  function runSessionCheck() {
    if (sessionCheck.running || closingResponses.size || restarting.size) return;
    const asked = new Set(wakeAsks);
    wakeAsks.clear();
    sessionCheck.running = checkSessions({ manifest: loadManifest(), asked }).then((r) => {
      if (r.resumed.length || r.restarted.length || r.pushed.length || r.failed.length) log(`sessions: resumed ${r.resumed.join(', ') || 'none'}; restarted ${r.restarted.join(', ') || 'none'}; pushed ${r.pushed.join(', ') || 'none'}${r.failed.length ? `; ${r.failed.join('; ')}` : ''}`);
    }).catch((e) => log('session check failed:', e.message))
      // docs/adr/2026-11-03-1823-a-board-session-compacts-before-its-context-fills.md
      .then(() => compactFullContexts({ manifest: loadManifest() })).then((r) => {
        if (r.compacted.length || r.failed.length) log(`context full: sent /compact to ${r.compacted.join(', ') || 'none'}${r.failed.length ? `; ${r.failed.join('; ')}` : ''}`);
      }).catch((e) => log('context full check failed:', e.message))
      // docs/adr/2026-11-14-1500-a-logged-out-claude-shows-red-and-pushes-once.md
      .then(() => checkLoggedOut({ manifest: loadManifest() })).then((r) => {
        if (r.pushed.length || r.failed.length) log(`logged out: pushed ${r.pushed.join(', ') || 'none'}${r.failed.length ? `; ${r.failed.join('; ')}` : ''}`);
      }).catch((e) => log('logged-out check failed:', e.message)).finally(() => { sessionCheck.running = null; });
    return track(sessionCheck.running);
  }

  await initializeTries(loadManifest());

  // ---------- pending prompts ----------
  const STARTED_AT = clock();
  // id → the resolvers of the hook's poll held open on it.
  const promptWaiters = new Map();
  function promptChanged(route) {
    if (route) { needsCache.delete(route); stream.changed(route); } else stream.refresh();
  }
  async function prunePrompts() {
    const { gone, rulesChanged } = await updatePrompts((store) => {
      const gone = expired(store, { now: clock(), aliveSince: STARTED_AT });
      const rulesChanged = pruneRemembered(store, promptContext());
      for (const r of gone) delete store.prompts[r.id];
      return { gone, rulesChanged };
    });
    for (const r of gone) promptChanged(r.route);
    if (rulesChanged) stream.refresh();
    if (gone.length) log(`prompts: dropped ${gone.map((r) => r.id).join(', ')}, whose hook went away`);
  }

  const promptContext = () => ({ running: liveSessions(), boards: listBoards(loadManifest()) });

  // A session's PermissionDenied or PermissionRequest hook input for a command that one of its board's permission
  // switches allows while on becomes a note under that switch (board/permissions.mjs recordRefusal). A failure to write
  // the note is logged; the prompt goes on. → the switch noted, or null
  async function noteRefusal(input) {
    const board = listBoards(loadManifest()).find((b) => b.owner?.session && b.owner.session === input.session_id);
    if (!board) return null;
    try {
      const noted = await recordRefusal(boardRepo(board.route).repo, board.dir, input);
      if (noted) log(`permissions: /${board.route} was still ${input.hook_event_name === 'PermissionDenied' ? 'refused' : 'asked about'} ${input.tool_input.command}`);
      return noted;
    } catch (e) { log(`permissions: could not note /${board.route}'s refusal: ${e.message}`); return null; }
  }

  // One check runs at a time. A call while one runs waits for it, then for one more check that reads the gate afresh, so a
  // pause-line save always reaches usage-gate-state.json; calls made meanwhile share that one.
  let usageCheck = null;
  let usageRecheck = null;
  async function checkUsageGate() {
    if (usageCheck) return usageRecheck ??= usageCheck.catch(() => {}).then(() => { usageRecheck = null; return checkUsageGate(); });
    usageCheck = (async () => checkUsagePause({ gate: readUsageGate(), resume: async (window) => {
      const out = await sendToBoards(listBoards(loadManifest()), 'usage-resumed', { window });
      for (const failed of out.failed) log(failed);
    } }))().finally(() => { usageCheck = null; });
    return usageCheck;
  }

  // docs/adr/2026-11-12-2345-a-haiku-router-files-each-incoming-request-on-a-board.md: routes the requests that waited
  // out a usage pause or a failed call, one drain at a time.
  let routing = null;
  function runRoutes() {
    routing ||= drainRoutes({ manifest: loadManifest() }).then((r) => {
      for (const e of r.routed) log(`router: ${e.via} request from ${e.by || 'someone'} → /${e.route}: ${e.reason}`);
      for (const why of r.failed) log(`router: could not file a request on ${why}`);
      if (r.routed.length) stream.refresh();
    }).catch((e) => log('router failed:', e.message)).finally(() => { routing = null; });
    return track(routing);
  }

  const loadOwners = () => { const manifest = loadManifest(); return { builders: boardBuilders(manifest), sessions: claudeSessions(manifest) }; };

  // The tick, on the 15 s clock. Its poll runs only on the hub's own clocks (ticks); without them, polls run when asked.
  function tick() {
    return track(Promise.allSettled([
      tryTick({ manifest: loadManifest() }).catch((e) => log('try tick failed:', e.message)),
      runRoutes(),
      checkUsageGate().catch((e) => log('usage gate failed:', e.message)),
      (async () => { try { checkMachine({ reading: readMachine() }); } catch (e) { log('machine check failed:', e.message); } })(),
      machineLoad(loadOwners()).then((data) => logHostLoad(data), (e) => log('host load log failed:', e.message)),
      owner.check().then(presenceChanged, (e) => log('presence check failed:', e.message)).finally(() => {
        if (ticks && !polls.running && clock() >= nextPollAt().getTime()) runPoll().catch((e) => log('poll failed:', e.message));
      }),
      settleStarts({ listening: (board) => isListening(board) && status().some((r) => r.route === board.route && r.state === 'up') }).then((landed) => { if (landed.length) stream.refresh(); }, (e) => log('settling starts failed:', e.message)),
      runWakes(),
      awake.apply(),
      upgrade.tick(),
      prunePrompts().catch((e) => log('prompt expiry failed:', e.message)).finally(runSessionCheck),
    ]));
  }

  // Sites run detached, so the hub must not exit while one it started still runs: close() stops each, kills one that
  // ignores SIGTERM for KILL_AFTER, stops the try runs, waits out the passes in flight, and closes the server.
  let closing = null;
  function close() {
    closing ||= (async () => {
      shuttingDown = true;
      for (const t of timers) clearInterval(t);
      shares.flush();
      awake.stop();
      log('hub stopping; stopping sites');
      for (const p of procs.values()) if (p.child) p.stopping = true;
      const exits = [...children].map((c) => new Promise((resolve) => {
        if (c.exitCode !== null || c.signalCode !== null) { resolve(); return; }
        const kill = setTimeout(() => { log(`pid ${c.pid} ignored SIGTERM; killing it`); signal(c, 'SIGKILL'); }, KILL_AFTER);
        c.once('exit', () => { clearTimeout(kill); resolve(); });
        signal(c, 'SIGTERM');
      }));
      await Promise.allSettled([stopTries(), ...exits]);
      stream.close();
      await settled();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
    })();
    return closing;
  }

  // ---------- status ----------
  const lastChange = new Map(); // route -> { at, checked }
  function newestMtime(dir, budget = { n: 3000 }) {
    let newest = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
      if (budget.n-- <= 0) break;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) newest = Math.max(newest, newestMtime(full, budget));
      else { try { newest = Math.max(newest, fs.statSync(full).mtimeMs); } catch {} }
    }
    return newest;
  }
  function changedAt(route, site) {
    const c = lastChange.get(route);
    if (c && clock() - c.checked < 30_000) return c.at;
    const at = newestMtime(site.dir);
    lastChange.set(route, { at, checked: clock() });
    return at;
  }

  const isFolder = (dir) => { try { return typeof dir === 'string' && fs.statSync(dir).isDirectory(); } catch { return false; } };

  function status() {
    const { sites } = loadManifest();
    return Object.entries(sites).sort(([a], [b]) => a.localeCompare(b)).map(([route, s]) => {
      const p = procs.get(route) || {};
      const serves = servesOf(s);
      const state = serves === 'files' ? (isFolder(s.dir) ? 'up' : 'down')
        : serves === 'port' ? answering.state(route)
          : p.child ? (p.up ? 'up' : 'starting') : (p.state === 'crashed' ? 'down' : (p.state || 'starting'));
      return {
        route, title: s.title || route, description: s.description || '', icon: s.icon || null, color: s.color || null, port: s.port ?? null, serves, state,
        exitCode: p.exitCode ?? null, owner: s.owner || null, restart: restartable(s), newServer: Boolean(p.newCode), changedAt: changedAt(route, s) || null, created: s.created || null,
        log: path.join(LOGS, route + '.log'),
      };
    });
  }

  // ---------- pages ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // route -> {at, needs}: the last good answer, which a failed read shows in its place (home.mjs holdNeeds).
  const goodNeeds = new Map();
  // route -> {at, needs}: needs is a promise of home.mjs readNeeds' answer from the site's GET /_claude/needs,
  // or of null when the site doesn't serve it, errs or takes over NEEDS_TIMEOUT.
  const needsCache = new Map();
  const NEEDS_TTL = 20_000;
  const NEEDS_TIMEOUT = 1500;
  async function fetchNeeds(port) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/_claude/needs`, { signal: AbortSignal.timeout(NEEDS_TIMEOUT) });
      if (!r.ok) return null;
      return readNeeds(await r.json());
    } catch { return null; }
  }
  // fresh: true refetches every site's answer, a Set of routes only those. A site with no owning session is never asked.
  async function waitingCounts(rows, { fresh = false } = {}) {
    const up = rows.filter((r) => r.state === 'up' && r.owner && r.port);
    for (const r of up) {
      const c = needsCache.get(r.route);
      if (fresh === true || fresh?.has?.(r.route) || !c || clock() - c.at >= NEEDS_TTL) needsCache.set(r.route, { at: clock(), needs: fetchNeeds(r.port) });
    }
    const reads = await Promise.all(up.map((r) => needsCache.get(r.route).needs));
    return new Map(up.map((r, i) => {
      const held = holdNeeds(goodNeeds.get(r.route) ?? null, reads[i], needsCache.get(r.route).at, clock());
      if (held.good) goodNeeds.set(r.route, held.good); else goodNeeds.delete(r.route);
      return [r.route, held.needs];
    }));
  }
  // A site whose answer is unknown adds nothing. A board's pending prompts are in its count already, so only the rest
  // add here, the ones the hub page lists.
  const badgeTotal = (waiting) => [...waiting.values()].reduce((n, w) => n + (w?.count || 0), 0) + pendingFor(null).length;

  // ---------- sidebar ----------
  // Each board's listenState (boards.mjs), read on every call since a session's watcher starts and exits underneath, and
  // its linksOf, cached as long as the sites' needs, since every open page asks for the sidebar. A board's links are built
  // again when its listen state differs from the one they were built with, since the events link follows it.
  // → {links: Map of route to linksOf, listens: Map of route to listenState}
  const linksCache = new Map(); // route → {at, listen, links}
  function boardLinks(boards) {
    const links = new Map();
    const listens = new Map();
    const ctx = { running: liveSessions(), wakes: readJSON(resumeStateFile(), {}) };
    const loggedOut = loggedOutRoutes();
    for (const b of boards) {
      try {
        const listen = loggedOut.has(b.route) ? 'logged-out' : listenState(b, ctx);
        listens.set(b.route, listen);
        let c = linksCache.get(b.route);
        if (!c || c.listen !== listen || clock() - c.at >= NEEDS_TTL) {
          c = { at: clock(), listen, links: linksOf(b, { listen }) };
          linksCache.set(b.route, c);
        }
        links.set(b.route, c.links);
      } catch (e) { log(`links of ${b.route} failed:`, e.message); links.set(b.route, []); }
    }
    return { links, listens, running: ctx.running };
  }

  // What /_hub/sidebar.json serves, with each board's links, the hub's code hashes and the status rows behind it for the
  // hub's page.
  async function sidebarState({ fresh = false } = {}) {
    const now = new Date();
    const rows = status();
    const waiting = await waitingCounts(rows, { fresh });
    const manifest = loadManifest();
    const boards = listBoards(manifest);
    const { links, listens, running } = boardLinks(boards);
    const code = hubCodeState();
    const contexts = new Map(boards.map((b) => [b.route, contextReading(b.owner?.session)]).filter(([, reading]) => reading));
    const store = readPrompts();
    const starting = startingBoards(manifest, now.getTime(), clonePercent, (route) => listens.get(route) === 'listening' && rows.some((r) => r.route === route && r.state === 'up'),
      (rec) => startSignals(rec, { running, store }));
    const landing = new Set(starting.map((s) => s.route));
    // A board under Pause board carries its own gate as pause (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md).
    const pausedBoards = new Map(boards.filter((b) => boardPausedUntil(b.dir)).map((b) => [b.route, readUsageGate({ dir: b.dir })]));
    const gate = readUsageGate();
    const sites = sidebarSites(rows, waiting, new Set(boards.map((b) => b.route)), listens, contexts).filter((s) => !landing.has(s.route))
      .map((s) => heldSite(s, gate.state === 'paused', pausedBoards.get(s.route) ?? null));
    const settings = readSettings();
    const held = hold(now, settings);
    const data = {
      code: code.running ?? null,
      newHub: Boolean(code.running) && code.running !== code.onDisk,
      version: VERSION,
      total: badgeTotal(waiting), start: startRoute(sites), sites, hub: hubHealth(sites, links),
      home: fs.realpathSync(os.homedir()),
      starting,
      usage: readUsage({ codexShare: readCodexShare(readCodex()), pauseAt: gate.pause_at }),
      pause: sidebarPause(gate, now.getTime()),
      notifications: !held ? { state: 'on', text: 'On' } : held.why === 'off' ? { state: 'off', text: 'Off' } : { state: 'held', text: capital(holdLine(held, now)) },
      away: !owner.state().present,
    };
    return { data, links, rows, code };
  }

  // ---------- app shell ----------
  // Text a browser accepts gzipped goes gzipped; the shell's scripts are a few hundred kilobytes before it.
  function sendText(req, res, code, headers, body) {
    let out = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const h = { ...headers, vary: [headers.vary, 'accept-encoding'].filter(Boolean).join(', ') };
    if (out.length >= 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { out = zlib.gzipSync(out); h['content-encoding'] = 'gzip'; }
    h['content-length'] = out.length;
    res.writeHead(code, h);
    res.end(req.method === 'HEAD' ? undefined : out);
  }

  // The app shell with the sidebar drawn in (board/public/ui-sidebar.js, run here in a vm context) and its data beside
  // it, so the first paint has both. here is a site's route or a hub page's path without its leading slash. "<" is
  // escaped in the data so no site's title can close its script.
  async function shellPage(here, viewer = null) {
    const data = viewer ? viewer.sidebar((await sidebarState()).data) : (await sidebarState()).data;
    const context = vm.createContext({});
    for (const file of ['ui-progress-bar.js', 'ui-icon-text.js', 'ui-page-header.js', 'ui-sidebar.js']) vm.runInContext(fs.readFileSync(path.join(BOARD_PUBLIC, file), 'utf8'), context);
    return shellHtml({ sidebar: context.BoardUI.sidebar(data, { here }), sidebarData: JSON.stringify(data).replace(/</g, '\\u003c'), touchIcon: iconUrl(180) });
  }

  // A newer kickflip on npm, checked as the hub starts and every 15 wall-clock minutes on the hub's 15-second tick, and pulled
  // once the owner has been away 15 minutes (a version tap pulls at once), without a restart, logging to logs/kickflip-update.log
  // (docs/adr/2026-11-06-0800-the-update-row-shows-only-new-version-and-reload.md,
  // docs/adr/2026-11-12-0110-the-npm-check-rides-the-hubs-tick-every-15-wall-clock-minutes.md,
  // docs/adr/2026-11-12-0300-an-npm-hub-pulls-only-once-the-owner-has-been-away-15-minutes.md).
  const upgrade = upgrader({
    root: cloneRoot(),
    run: runUpdate,
    log,
    pulled: () => selfRestart.restartNow(),
    autoUpdate: readAutoUpdate,
    awayFor: () => { const { awaySince } = owner.state(); return awaySince === null ? 0 : clock() - awaySince; },
  });
  // signal aborts a pull that hangs: the update and npm under it, its own process group, are killed.
  function runUpdate({ signal }) {
    const file = path.join(LOGS, 'kickflip-update.log');
    fs.writeFileSync(file, `${new Date().toISOString()} kickflip update\n`);
    const out = fs.openSync(file, 'a');
    log('kickflip update: pulling the new kickflip');
    return new Promise((resolve) => {
      const child = spawn(nodeBin(), [path.join(cloneRoot(), 'bin', 'kickflip.mjs'), 'update', '--no-restart'], { detached: true, stdio: ['ignore', out, out] });
      fs.closeSync(out);
      child.unref();
      signal.addEventListener('abort', () => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        resolve({ ok: false, error: 'killed after 10 minutes' });
      }, { once: true });
      child.on('error', (e) => resolve({ ok: false, error: e.message }));
      child.on('exit', (code) => {
        const last = fs.readFileSync(file, 'utf8').trim().split('\n').at(-1);
        log(`kickflip update exited ${code}: ${last}`);
        resolve(code === 0 ? { ok: true } : { ok: false, error: last.replace(/^kickflip: /, '') });
      });
    });
  }
  upgrade.tick();

  const stream = hubStream({
    targets: () => Object.entries(servedSites(loadManifest())).filter(([, s]) => isBoardSite(s) && s.port).map(([route, s]) => ({ route, port: s.port })),
    watched: () => listBoards(loadManifest()).map(({ route, dir }) => ({ route, dir })),
    sidebar: async ({ fresh }) => (await sidebarState({ fresh })).data,
    log,
  });

  // iOS caches a Home Screen icon by its URL, so each URL carries the file's mtime: a replaced icon gets a new address.
  function iconUrl(size) {
    let v = '0';
    try { v = Math.floor(fs.statSync(path.join(HUB_DIR, `icon-${size}.png`)).mtimeMs).toString(36); } catch {}
    return `/_hub/icon-${size}.png?v=${v}`;
  }
  const manifestJson = () => JSON.stringify({
    name: 'Claude sites', short_name: 'Claude', start_url: '/', scope: '/', display: 'standalone',
    background_color: '#121514', theme_color: '#121514',
    icons: [{ src: iconUrl(192), sizes: '192x192', type: 'image/png' }, { src: iconUrl(512), sizes: '512x512', type: 'image/png' }],
  });

  async function readBody(req, limit = 16 * 1024) {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > limit) throw Object.assign(new Error('too large'), { status: 413 }); }
    return body;
  }
  async function readJSONBody(req, limit) {
    if (!isJSON(req.headers)) throw Object.assign(new Error('Send the body as application/json.'), { status: 403 });
    const body = await readBody(req, limit);
    return body ? JSON.parse(body) : {};
  }

  // The page the hub answers a site that is down or missing with, which a frame or curl gets too.
  const head = (title, extra = '') => `<!doctype html><html lang="en" class="hub-view"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" type="image/png" href="/_hub/kickflip.png"><link rel="apple-touch-icon" href="${iconUrl(180)}">
<meta name="apple-mobile-web-app-title" content="Claude">${extra}<link rel="stylesheet" href="/_hub/colors.css?v=${colorsVersion()}"><link rel="stylesheet" href="/_hub/hub.css"></head><body><main>`;

  // ---------- hub views ----------
  // The hub page and its settings modals live in the app shell (board/public/view-hub.js, view-hub-settings.js), which
  // take their words from views.mjs through /_hub/api/*. A form POST that asks for JSON gets the view's data back; any
  // other gets a 303 back to the page.
  const wantsJSON = (req) => /\bapplication\/json\b/.test(req.headers.accept || '');

  async function hubData(req) {
    await prunePrompts();
    const now = new Date();
    const { data, links, rows, code } = await sidebarState();
    return {
      ...hubView({
        now, st: queueStatus(now), sidebar: data, rows, links, rules: readHubRules(), integrations: await readiness.rows(),
        code, version: VERSION, update: { latest: upgrade.available(), pull: upgrade.pull(), auto: readAutoUpdate(), clone: upgrade.clone }, host: req.headers['x-forwarded-host'] || req.headers.host || '', codexShare: readCodexShare(readCodex()), claudeModel: readClaudeModel(), orchestratorModel: readOrchestratorModel(), codex: readCodex(), awake: { on: awakeOn(), unsupported: awakeUnsupported() },
        remembered: new Map(listBoards(loadManifest()).map((b) => [b.route, rememberedFor(b.route)])), routed: routedRows({ manifest: loadManifest() }), restarts: restartLines(clock()),
      }),
      prompts: pendingFor(null).map(shown),
      remembered: rememberedFor(null),
    };
  }
  const settingsData = async () => {
    const now = new Date();
    const gate = readUsageGate({ now });
    const pausedUntil = gate.manual === 'hub' ? endOf(gate.resets_at, now) : null;
    return { ...settingsView({ now, st: queueStatus(now), rules: readHubRules(), linear: linearStatus(), slack: slackStatus(), pausedUntil, overnight: overnightJobs() }), closed: closedBoards() };
  };

  const redirect = (res, location) => { res.writeHead(303, { location, 'cache-control': 'no-store' }); res.end(); };

  async function hubRoute(req, res, url, viewer = null) {
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(body); };
    const sendJSON = (code, v) => {
      const hash = runningHubCode();
      return send(code, 'application/json', JSON.stringify(v), hash ? { 'x-hub-code': hash } : {});
    };
    // Answers a New board start or retry at once with {route}, and refreshes the sidebar again when its outcome lands.
    const starting = ({ route, started }) => {
      track(started.then(({ error }) => { if (error) log(`new board /${route} didn't start: ${error}`); stream.refresh(); }));
      stream.refresh();
      return sendJSON(200, { route });
    };
    const json = wantsJSON(req);
    const p = url.pathname;
    const closing = /^\/_hub\/close-board\/([a-z0-9-]+)$/.exec(p);
    if (closing && req.method === 'GET') {
      try { return sendJSON(200, await boardClosure(closing[1])); }
      catch (e) { return sendJSON(e.status || 400, { error: e.message }); }
    }
    if (['/_hub/close-board', '/_hub/reopen-board'].includes(p) && req.method === 'POST') {
      let route;
      try {
        const input = await readJSONBody(req);
        route = input.route;
        if (p === '/_hub/reopen-board') {
          const result = await reopenBoard(route);
          stream.refresh();
          return sendJSON(200, result);
        }
        if (closingResponses.has(route)) return sendJSON(409, { error: 'That board is already closing.' });
        closingResponses.add(route);
        // The hub owns this response; reconciliation waits until it is flushed before stopping the site's server.
        const release = () => closingResponses.delete(route);
        res.once('finish', release);
        res.once('close', release);
        await sessionCheck.running;
        const result = await closeBoard(route, input.name);
        stream.refresh();
        return sendJSON(200, result);
      } catch (e) { return sendJSON(e.status || 400, { error: e.message }); }
    }
    if (p === '/_hub/restart-server' && req.method === 'POST') {
      try {
        const { route } = await readJSONBody(req);
        const site = routeRecord(loadManifest().sites, route);
        if (!site || !isBoardSite(site)) return sendJSON(404, { error: 'That board is not open.' });
        const proc = procs.get(route);
        if (!proc?.newCode || !proc.child || proc.stopping) return sendJSON(409, { error: `${site.title || route}’s server runs the code in its files.` });
        log(`${route} runs older code than its files; restarting it from its Restart`);
        restartForCode(route);
        stream.refresh();
        return sendJSON(200, { route });
      } catch (e) { return sendJSON(e.status || 400, { error: e.message }); }
    }
    if (p === '/_hub/restart-board' && req.method === 'POST') {
      let route;
      try {
        route = (await readJSONBody(req)).route;
        if (restarting.has(route)) return sendJSON(409, { error: 'That board is already restarting.' });
        restarting.add(route);
        await sessionCheck.running;
        const result = await restartBoard(route, { serverUp: serverAnswers, portUp: probe, onStarting: (title) => log(`restart /${route}: ${title}’s session is back, its server is still starting`) });
        log(`restarted /${route}: server answers, session ${result.session} resumed`);
        return sendJSON(200, result);
      } catch (e) {
        if (route) log(`restart /${route} failed: ${e.message}`);
        return sendJSON(e.status || 400, { error: e.message });
      } finally { restarting.delete(route); stream.refresh(); }
    }
    if (p === '/_hub/restart-hub' && req.method === 'POST') {
      try {
        await readJSONBody(req);
        if (hubRestarting) return sendJSON(409, { error: 'The hub is already restarting.' });
        hubRestarting = true;
        // The restart stops this process, so it runs once the answer is flushed.
        track(new Promise((resolve) => res.once('finish', () => {
          log('restarting the hub from the hub page');
          const why = restartRunner('hub');
          if (why) { hubRestarting = false; log(`hub restart failed: ${why}`); }
          resolve();
        })));
        return sendJSON(200, { restarting: true, command: hubService().restartCommand });
      } catch (e) { return sendJSON(e.status || 400, { error: e.message }); }
    }
    // The hub page's version tap: check npm now, like the 15-minute check (hub/upgrade.mjs). A clone answers with its commit.
    if (p === '/_hub/check-update' && req.method === 'POST') {
      try {
        await readJSONBody(req);
        const out = await upgrade.check();
        if (out.state === 'clone') out.commit = execFileSync('git', ['-C', cloneRoot(), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
        return sendJSON(200, out);
      } catch (e) { return sendJSON(e.status || 400, { error: e.message }); }
    }
    if (p === '/_hub/presence' && req.method === 'POST') {
      await readJSONBody(req);
      presenceChanged(owner.beat());
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    if (p === '/_hub/wake' && req.method === 'POST') {
      try {
        const { route } = await readJSONBody(req);
        const board = listBoards(loadManifest()).find((b) => b.route === route);
        if (!board) return sendJSON(404, { error: 'That board is not open.' });
        wakeAsks.add(route);
        await sessionCheck.running;
        runSessionCheck();
        await sessionCheck.running;
        linksCache.clear();
        stream.changed(route);
        return sendJSON(200, { route, listen: listenState(board) });
      } catch (e) { return sendJSON(e.status || 400, { error: e.message }); }
    }
    // The Polls page (polls-page.mjs), a page of its own the hub settings' Polls row links, outside the app shell.
    if (p === '/_hub/polls' && req.method === 'GET') return send(200, 'text/html; charset=utf-8', `${head('Polls')}${pollsPage()}</main></body></html>`);
    if (p === '/_hub/repos' && req.method === 'GET') {
      try { return sendJSON(200, await repos.list(loadManifest(), { fresh: url.searchParams.get('fresh') === '1' })); }
      catch (e) { return sendJSON(e.status || 502, { error: e.message }); }
    }
    if (p === '/_hub/branches' && req.method === 'GET') {
      try { return sendJSON(200, await repos.branches(url.searchParams.get('github') ?? url.searchParams.get('remote'))); }
      catch (e) { return sendJSON(e.status || 502, { error: e.message }); }
    }
    if (p === '/_hub/repo' && req.method === 'GET') return repoLookupRoute(url, { repos, manifest: loadManifest(), sendJSON });
    const repoRoute = /^\/_hub\/board-repo\/([a-z0-9-]+)$/.exec(p);
    if (repoRoute && ['GET', 'POST'].includes(req.method)) {
      try {
        const result = req.method === 'GET' ? boardRepo(repoRoute[1]) : await changeBoardRepo(repoRoute[1], await readJSONBody(req), { repos });
        if (req.method === 'POST') stream.refresh();
        return sendJSON(200, result);
      } catch (e) { return sendJSON(e.status || 400, { error: e.message }); }
    }
    const modelRoute = /^\/_hub\/board-model\/([a-z0-9-]+)(\/restart)?$/.exec(p);
    if (modelRoute && (modelRoute[2] ? req.method === 'POST' : ['GET', 'POST'].includes(req.method))) {
      try {
        const route = modelRoute[1];
        if (req.method === 'GET') return sendJSON(200, boardModel(route));
        const result = modelRoute[2] ? await restartOnModel(route) : await changeBoardModel(route, await readJSONBody(req));
        stream.refresh();
        return sendJSON(200, result);
      } catch (e) { return sendJSON(e.status || 400, { error: e.message }); }
    }
    if (p === '/_hub/new-board' && req.method === 'POST') {
      if (!isJSON(req.headers)) return send(403, 'text/plain; charset=utf-8', 'Send name, github, branch and purpose as application/json.');
      let input;
      try { input = await readJSONBody(req); } catch { return send(400, 'text/plain; charset=utf-8', 'Send name, github, branch and purpose as JSON.'); }
      try { return starting(await requestBoard(input, { repos, changed: () => stream.refresh() })); }
      catch (e) { if (e.status) return send(e.status, 'text/plain; charset=utf-8', e.message); throw e; }
    }
    const retry = /^\/_hub\/new-board\/([a-z0-9-]+)\/retry$/.exec(p);
    if (retry && req.method === 'POST') {
      if (!isJSON(req.headers)) return send(403, 'text/plain; charset=utf-8', 'Send the retry as application/json.');
      try { return starting(await retryBoard(retry[1], { repos, changed: () => stream.refresh() })); }
      catch (e) { if (e.status) return send(e.status, 'text/plain; charset=utf-8', e.message); throw e; }
    }
    const dismiss = /^\/_hub\/new-board\/([a-z0-9-]+)$/.exec(p);
    if (dismiss && req.method === 'DELETE') {
      try {
        const result = await dismissBoard(dismiss[1]);
        stream.refresh();
        return sendJSON(200, result);
      } catch (e) { if (e.status) return send(e.status, 'text/plain; charset=utf-8', e.message); throw e; }
    }
    if ((p === '/_hub/build' || p === '/_hub/pull' || p === '/_hub/kill') && req.method === 'POST') {
      if (shuttingDown) return sendJSON(503, { error: 'The hub is stopping. Try again after it restarts.' });
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
      const host = (req.headers.host || '').replace(/:\d+$/, '');
      if (!local.includes(req.socket.remoteAddress) || !['127.0.0.1', 'localhost', '[::1]'].includes(host)
        || req.headers.origin || Object.keys(req.headers).some((h) => h === 'forwarded' || h.startsWith('x-forwarded-'))) {
        return sendJSON(403, { error: `${p === '/_hub/pull' ? 'Pulls' : p === '/_hub/kill' ? 'Serves' : 'Builds'} can only be ${p === '/_hub/kill' ? 'killed' : 'started'} from the host over loopback.` });
      }
      let input;
      try { input = await readJSONBody(req); } catch (e) { return sendJSON(e.status || 400, { error: p === '/_hub/pull' ? 'Send the board route as JSON.' : 'Send the board route and task key as JSON.' }); }
      try {
        if (p === '/_hub/pull') return sendJSON(200, await pullNow(input, { manifest: loadManifest() }));
        if (p === '/_hub/kill') return sendJSON(200, await killBuild(input, { manifest: loadManifest() }));
        return sendJSON(202, await startBuild(input, { manifest: loadManifest(), log }));
      } catch (e) { if (e instanceof BuildError) return sendJSON(e.status, { error: e.message, ...(e.ask ? { ask: e.ask } : {}) }); throw e; }
    }
    if (p === '/sw.js') return send(200, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(HUB_DIR, 'sw.js')), { 'service-worker-allowed': '/' });
    if (p === '/manifest.webmanifest') return send(200, 'application/manifest+json', manifestJson());
    const icon = /^\/_hub\/icon-(180|192|512)\.png$/.exec(p);
    if (icon) {
      try { return send(200, 'image/png', fs.readFileSync(path.join(HUB_DIR, `icon-${icon[1]}.png`)), { 'cache-control': 'max-age=86400' }); }
      catch { res.writeHead(404).end(); return; }
    }
    if (p === '/_hub/colors.css') {
      const cache = url.searchParams.get('v') === colorsVersion() ? 'public, max-age=31536000, immutable' : 'no-cache';
      try { return send(200, 'text/css; charset=utf-8', fs.readFileSync(COLORS), { 'cache-control': cache }); }
      catch { res.writeHead(404).end(); return; }
    }
    if (p === '/_hub/kickflip.png') {
      try { return send(200, 'image/png', fs.readFileSync(path.join(BOARD_PUBLIC, 'kickflip.png')), { 'cache-control': 'max-age=86400' }); }
      catch { res.writeHead(404).end(); return; }
    }
    if (p === '/_hub/hub.css') return send(200, 'text/css; charset=utf-8', fs.readFileSync(path.join(BOARD_PUBLIC, 'hub.css')));
    // docs/adr/2026-11-13-0026-the-busy-hub-row-opens-whats-loading-the-host.md
    if (p === '/_hub/machine.json' && req.method === 'GET') return sendJSON(200, await machineLoad(loadOwners()));
    if (p === '/_hub/machine/stop' && req.method === 'POST') {
      try { return sendJSON(200, await stopOrphan(Number((await readJSONBody(req)).pid), loadOwners())); }
      catch (e) { return sendJSON(e.status || 400, { error: e.message }); }
    }
    if (p === '/_hub/sidebar.json') {
      const { data } = await sidebarState({ fresh: url.searchParams.get('fresh') === '1' });
      return sendJSON(200, viewer ? viewer.sidebar(data) : data);
    }
    if (p === '/_hub/stream' && req.method === 'GET') {
      if (viewer) {
        const open = { login: viewer.login, routes: viewer.routes, res };
        sharedStreams.add(open);
        req.on('close', () => sharedStreams.delete(open));
        req.on('close', shares.watching(viewer.login));
      }
      stream.handle(req, res, viewer && { routes: viewer.routes, view: viewer.sidebar });
      return;
    }
    const sharing = /^\/_hub\/share\/([a-z0-9-]+)$/.exec(p);
    if (sharing && req.method === 'GET') {
      const site = routeRecord(loadManifest().sites, sharing[1]);
      if (!isBoardSite(site)) return sendJSON(404, { error: 'That board is not open.' });
      const entries = shareEntries(readJSON(path.join(site.dir, 'board.json'), {}));
      const logins = entries.map((e) => e.login);
      const host = (await gate.node())?.dnsName || req.headers['x-forwarded-host'];
      const people = shares.people(sharing[1], logins).map((p, i) => ({ ...p, level: entries[i].level }));
      return sendJSON(200, { people, refused: shares.refusals(sharing[1], logins), link: host ? `https://${host}/${sharing[1]}/` : null });
    }
    if (p.startsWith('/_hub/app/')) {
      const f = appFile(p.slice('/_hub/app/'.length));
      if (!f) { res.writeHead(404).end(); return; }
      const ext = path.extname(f);
      const type = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' }[ext];
      const cache = url.searchParams.get('v') === fileVersion(f) ? 'public, max-age=31536000, immutable' : 'no-cache';
      if (ext === '.png') return send(200, type, fs.readFileSync(f), { 'cache-control': cache });
      return sendText(req, res, 200, { 'content-type': type, 'cache-control': cache }, fs.readFileSync(f));
    }
    if (p === '/_hub/api/hub') return sendJSON(200, await hubData(req));
    if (p === '/_hub/api/settings') return sendJSON(200, await settingsData());
    if (p === '/_hub/push/key') return sendJSON(200, { key: publicKey() });
    if (p === '/_hub/push/subscribe' && req.method === 'POST') {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      return sendJSON(200, addSubscription(await readJSONBody(req), `https://${host}/`, req.headers['user-agent']));
    }
    if (p === '/_hub/push/forget' && req.method === 'POST') return sendJSON(200, { count: removeSubscriptionById((await readJSONBody(req))?.id) });
    if (p === '/_hub/push/unsubscribe' && req.method === 'POST') return sendJSON(200, { count: removeSubscription((await readJSONBody(req))?.endpoint) });
    if (p === '/_hub/push/test' && req.method === 'POST') {
      const results = await sendAll({ title: 'Claude', body: 'Test notification from the hub.', url: '/', tag: 'hub-test' });
      return sendJSON(200, { sent: results.filter((r) => r.status >= 200 && r.status < 300).length, results });
    }
    // set=on|weekends with value=on (absent for off), or snooze=<push.mjs setNotifications choice | off>.
    if (p === '/_hub/settings/notifications' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      const set = f.get('set');
      const change = set === 'on' ? { on: f.get('value') === 'on' } : set === 'weekends' ? { weekends_off: f.get('value') === 'on' } : f.has('snooze') ? { snooze: f.get('snooze') } : null;
      const bad = 'Pass set=on or set=weekends with value=on, or snooze.';
      if (!change) return json ? sendJSON(400, { error: bad }) : send(400, 'text/plain; charset=utf-8', bad);
      let r;
      try { r = await setNotifications(change); } catch (e) {
        if (e.status !== 400) throw e;
        return json ? sendJSON(400, { error: SNOOZE_REFUSED }) : redirect(res, '/_hub/?refused=snooze#notifications');
      }
      if (r.dropped) log(`notifications off: dropped ${r.dropped} queued push${r.dropped === 1 ? '' : 'es'}`);
      return json ? sendJSON(200, await settingsData()) : redirect(res, '/_hub/#notifications');
    }
    if (p === '/_hub/settings/keep-awake' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      try { await setKeepAwake(f.get('keep_awake') === 'on'); } catch (e) {
        if (e.status !== 409) throw e;
        return json ? sendJSON(409, { error: e.message }) : send(409, 'text/plain; charset=utf-8', e.message);
      }
      await awake.apply();
      return json ? sendJSON(200, await settingsData()) : redirect(res, '/_hub/#keep-awake');
    }
    if (p === '/_hub/settings/auto-update' && req.method === 'POST') {
      await setAutoUpdate(new URLSearchParams(await readBody(req)).get('auto_update') === 'on');
      return json ? sendJSON(200, await settingsData()) : redirect(res, '/_hub/');
    }
    if (p === '/_hub/settings/hub-pause' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      try { await setHubPause(f.get('pause')); } catch (e) {
        if (e.status !== 400) throw e;
        return json ? sendJSON(400, { error: e.message }) : send(400, 'text/plain; charset=utf-8', e.message);
      }
      await checkUsageGate();
      return json ? sendJSON(200, await settingsData()) : redirect(res, '/_hub/#pause');
    }
    if (p === '/_hub/settings/codex' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      try { await setCodexShare(f.get('value'), readCodex({ fresh: true })); } catch (e) {
        if (e.status !== 400 && e.status !== 409) throw e;
        return json ? sendJSON(e.status, { error: e.message }) : send(e.status, 'text/plain; charset=utf-8', e.message);
      }
      return json ? sendJSON(200, await hubData(req)) : redirect(res, '/_hub/');
    }
    if (['/_hub/settings/claude-model', '/_hub/settings/orchestrator-model'].includes(p) && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      try { if (p.endsWith('/claude-model')) await setClaudeModel(f.get('value')); else await changeHubOrchestratorModel(f.get('value')); } catch (e) {
        if (e.status !== 400) throw e;
        return json ? sendJSON(400, { error: e.message }) : send(400, 'text/plain; charset=utf-8', e.message);
      }
      return json ? sendJSON(200, await hubData(req)) : redirect(res, '/_hub/');
    }
    if (['/_hub/settings/pause-at', '/_hub/settings/keep-going'].includes(p) && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      try {
        if (p.endsWith('/pause-at')) await setPauseAt(f.get('value')); else await setKeepGoing(f.get('value'));
        await checkUsageGate();
      } catch (e) {
        if (e.status !== 400 && e.status !== 409) throw e;
        return json ? sendJSON(e.status, { error: e.message }) : send(e.status, 'text/plain; charset=utf-8', e.message);
      }
      return json ? sendJSON(200, await hubData(req)) : redirect(res, '/_hub/');
    }
    if (p === '/_hub/settings/linear' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req, 4 * 1024));
      try {
        if (f.has('remove')) { removeLinearKey(); log('linear: key removed'); await linearFallback(); }
        else log(`linear: key ${(await saveLinearKey(f.get('key'))).refused ? 'refused by Linear' : 'saved'}`);
      } catch (e) {
        if (!(e instanceof LinearError)) throw e;
        return json ? sendJSON(e.status, { error: e.message }) : send(e.status, 'text/plain; charset=utf-8', e.message);
      }
      return json ? sendJSON(200, await settingsData()) : redirect(res, '/_hub/#linear');
    }
    if (p === '/_hub/settings/slack' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req, 4 * 1024));
      try {
        if (f.has('remove')) { removeSlackToken(); log('slack: token removed'); }
        else log(`slack: token ${(await saveSlackToken(f.get('token'))).refused ? 'refused by Slack' : 'saved'}`);
      } catch (e) {
        if (!(e instanceof SlackError)) throw e;
        return json ? sendJSON(e.status, { error: e.message }) : send(e.status, 'text/plain; charset=utf-8', e.message);
      }
      return json ? sendJSON(200, await settingsData()) : redirect(res, '/_hub/#slack');
    }
    if (p === '/_hub/api/linear' && req.method === 'GET') {
      const status = linearStatus();
      if (!status.set || status.refused) return sendJSON(200, status);
      const linear = savedClient();
      try {
        const teams = await linear.teams();
        return sendJSON(200, { ...linearStatus(), teams: teams.map(({ key, name }) => ({ key, name })),
          projects: teams.flatMap((t) => t.projects.map((pr) => ({ id: pr.id, name: pr.name, team: t.key }))) });
      } catch (e) { if (!(e instanceof LinearError)) throw e; return sendJSON(200, { ...linearStatus(), error: e.message }); }
    }
    if (p === '/_hub/linear/projects' && req.method === 'POST') {
      const linear = savedClient();
      if (!linear) return sendJSON(400, { error: 'Add a Linear key on Hub first.' });
      let input;
      try { input = await readJSONBody(req, 4 * 1024); } catch (e) { return sendJSON(e.status || 400, { error: 'Send the team and project name as JSON.' }); }
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 80 || typeof input.team !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(input.team)) return sendJSON(400, { error: 'Name the project and its team.' });
      try { return sendJSON(200, await linear.createProject(input.team, name)); }
      catch (e) { if (!(e instanceof LinearError)) throw e; return sendJSON(e.status, { error: e.message }); }
    }
    // One schedule.mjs editQuiet change: start, end or hold.
    if (p === '/_hub/settings/quiet' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      const change = Object.fromEntries(['start', 'end'].filter((k) => f.has(k)).map((k) => [k, f.get(k).trim()]));
      if (f.get('set') === 'hold') change.hold = f.get('value') || 'off';
      try { await saveSettings(editQuiet(readSettings(), change)); } catch (e) {
        if (e.status !== 400) throw e;
        return json ? sendJSON(400, { error: e.message }) : send(400, 'text/plain; charset=utf-8', e.message);
      }
      stream.refresh();
      return json ? sendJSON(200, await settingsData()) : redirect(res, '/_hub/#quiet');
    }
    if (p === '/_hub/settings/overnight' && req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req));
      try { await setOvernight(f.get('job'), f.get('value') === 'on'); } catch (e) {
        if (e.status !== 400) throw e;
        return json ? sendJSON(400, { error: e.message }) : send(400, 'text/plain; charset=utf-8', e.message);
      }
      stream.refresh();
      return json ? sendJSON(200, await settingsData()) : redirect(res, '/_hub/#quiet');
    }
    if (p === '/_hub/settings/rules' && req.method === 'POST') {
      let body, saved;
      try {
        body = await readJSONBody(req, 64 * 1024);
        saved = applyRules(readHubRules(), body.rules, body.base ?? []);
        if (changed(saved.changes)) await writeHubRules(saved.rules);
      } catch (e) {
        if (!(e instanceof RuleError) && !(e instanceof SyntaxError)) throw e;
        return sendJSON(400, { error: e.message });
      }
      if (!changed(saved.changes)) return sendJSON(200, { rules: saved.rules, changed: false, events: [], failed: [] });
      const sent = await sendToBoards(listBoards(loadManifest()), 'rules', { scope: 'hub', ...saved.changes });
      log(`hub rules saved: rules → ${sent.events.map((e) => e.route).join(', ') || 'no board'}${sent.failed.length ? `; ${sent.failed.join('; ')}` : ''}`);
      return sendJSON(200, { rules: saved.rules, changed: true, ...sent });
    }
    if (p === '/_hub/push/flush' && req.method === 'POST') {
      const r = await flushQueue();
      if (r) log(`push queue: ${r.ok ? 'sent' : 'could not send'} ${r.count} queued (from the settings page)`);
      return json ? sendJSON(200, flushView(r)) : redirect(res, '/_hub/');
    }
    // The hub page's New task box: its files upload here, to the hub's own data/uploads, and /_hub/route queues the task for
    // the router like any request, with its intent (quick, or request prototype, grill or visual) and files, under the
    // page outbox's sendId, which queues it once however often it is sent. The router copies the files to the board it
    // picks. Answered at once: the Routed section shows the task waiting, then its card.
    if (p === '/_hub/api/upload' && req.method === 'POST') {
      try { return sendJSON(200, await saveUpload(HOME, req, { name: decodeURIComponent(req.headers['x-filename'] || ''), type: req.headers['content-type'], length: Number(req.headers['content-length']) || 0 })); }
      catch (e) { if (e.status) return sendJSON(e.status, { error: e.message }); throw e; }
    }
    if (p === '/_hub/route' && req.method === 'POST') {
      let input;
      try { input = await readJSONBody(req); } catch (e) { return sendJSON(e.status || 400, { error: e.status ? e.message : 'Send the task as JSON.' }); }
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      const files = (Array.isArray(input.files) ? input.files : []).filter((f) => /^uploads\/\d+-[\w.-]+$/.test(f?.url)).map(({ name, url, type, size }) => ({ name, url, type, size }));
      if (!text && !files.length) return sendJSON(400, { error: 'Send some text or a file.' });
      if (input.request !== undefined && !['prototype', 'grill', 'visual'].includes(input.request)) return sendJSON(400, { error: 'request is prototype, grill or visual.' });
      const fields = input.request ? { request: input.request } : input.quick === true ? { quick: true } : null;
      const sendId = typeof input.sendId === 'string' && /^[\w-]{1,64}$/.test(input.sendId) ? input.sendId : undefined;
      await queueRequest({ text, files, ...(fields ? { fields } : {}), ...(sendId ? { sendId } : {}), from: { via: 'hub', by: 'love' } });
      track(drainRoutes().then((r) => { for (const e of r.routed) log(`router: hub request → /${e.route}: ${e.reason}`); stream.refresh(); }, (e) => log('router:', e.message)));
      stream.refresh();
      return sendJSON(202, { queued: true });
    }
    if (p === '/_hub/poll' && req.method === 'POST') {
      const body = await readJSONBody(req);
      return sendJSON(200, await runPoll({ flush: body.flush !== false }));
    }
    if (p === '/_hub/prompts' && req.method === 'POST') {
      let input;
      try { input = await readJSONBody(req, 8 * 1024 * 1024); } catch (e) { if (e.status) throw e; return sendJSON(400, { error: 'Send the hook input as JSON.' }); }
      if (!input?.tool_name || (input.hook_event_name && input.hook_event_name !== 'PermissionRequest')) return sendJSON(400, { error: 'Send a PermissionRequest hook input.' });
      const { answer, rec } = await updatePrompts((store) => {
        const context = promptContext();
        const board = context.boards.find((b) => b.owner?.session && b.owner.session === input.session_id) || null;
        if (pruneRemembered(store, context)) stream.refresh();
        const answer = rememberedAnswer(store, input);
        if (answer) return { answer };
        const rec = promptRecord(input, { board, live: context.running?.get(input.session_id) });
        store.prompts[rec.id] = rec;
        return { rec };
      });
      if (answer) return sendJSON(200, { state: 'answered', answer });
      promptChanged(rec.route);
      if (!rec.route) logStartPrompt(input);
      await noteRefusal(input);
      log(`prompt ${rec.id}: ${rec.route ? `/${rec.route}` : rec.cwd} ${rec.tool}${rec.action ? ` (${rec.action})` : ''}`);
      track(deliver(pushOf(rec), { kind: 'prompt', immediate: true }).catch((e) => log(`prompt ${rec.id}: push failed: ${e.message}`)));
      return sendJSON(200, { id: rec.id, deadline: rec.deadline });
    }
    if (p === '/_hub/permission-denied' && req.method === 'POST') {
      let input;
      try { input = await readJSONBody(req, 8 * 1024 * 1024); } catch (e) { if (e.status) throw e; return sendJSON(400, { error: 'Send the hook input as JSON.' }); }
      if (input?.hook_event_name !== 'PermissionDenied') return sendJSON(400, { error: 'Send a PermissionDenied hook input.' });
      return sendJSON(200, { noted: await noteRefusal(input) });
    }
    const prompt = /^\/_hub\/prompts\/([\w-]+)(\/wait|\/answer)?$/.exec(p);
    if (prompt) return promptRoute(req, res, { id: prompt[1], op: prompt[2]?.slice(1) || null, url, sendJSON });
    return false;
  }

  async function promptRoute(req, res, { id, op, url, sendJSON }) {
    if (op === 'wait' && req.method === 'GET') {
      const seen = () => updatePrompts((store) => {
        const rec = routeRecord(store.prompts, id);
        if (rec?.answer) delete store.prompts[id];
        else if (rec) rec.seen = new Date().toISOString();
        return rec;
      });
      const take = (rec) => {
        promptChanged(rec.route);
        return sendJSON(200, { state: 'answered', answer: rec.answer });
      };
      const rec = await seen();
      if (!rec) return sendJSON(404, { state: 'gone' });
      if (rec.answer) return take(rec);
      const ms = Math.max(0, Math.min(Number(url.searchParams.get('ms')) || POLL_MS, POLL_MS));
      await new Promise((resolve) => {
        const set = promptWaiters.get(id) || new Set();
        promptWaiters.set(id, set);
        const done = () => { clearTimeout(timer); set.delete(done); if (!set.size && promptWaiters.get(id) === set) promptWaiters.delete(id); resolve(); };
        const timer = setTimeout(done, ms);
        set.add(done);
        res.on('close', done);
      });
      if (res.writableEnded || res.destroyed) return;
      const now = await seen();
      if (!now) return sendJSON(404, { state: 'gone' });
      return now.answer ? take(now) : sendJSON(200, { state: 'pending' });
    }
    if (op === 'answer' && req.method === 'POST') {
      const body = await readJSONBody(req);
      const result = await updatePrompts((store) => {
        const rec = routeRecord(store.prompts, id);
        if (!rec) return { status: 404, error: 'That prompt has expired.' };
        if (rec.answer) return { status: 409, error: 'That prompt was already answered.' };
        const { answer, error } = answerOf(rec, body);
        if (error) return { status: 400, error };
        rec.answer = answer;
        const context = promptContext();
        pruneRemembered(store, context);
        rememberRules(store, rec, context);
        return { rec, answer };
      });
      if (result.error) return sendJSON(result.status, { error: result.error });
      const { rec, answer } = result;
      log(`prompt ${id}: ${answer.choice}`);
      for (const done of [...(promptWaiters.get(id) || [])]) done();
      promptChanged(rec.route);
      return sendJSON(200, { ok: true });
    }
    if (op === null && req.method === 'DELETE') {
      const rec = await updatePrompts((store) => {
        const rec = routeRecord(store.prompts, id);
        delete store.prompts[id];
        return rec;
      });
      if (rec) { promptChanged(rec.route); log(`prompt ${id}: its hook gave up`); }
      return sendJSON(200, { ok: true });
    }
    return false;
  }

  // One row as the down and missing pages list it.
  const row = ({ icon = '', title, sub = '' }) => `<div class="row">${icon}<span class="body"><span class="text"><span class="title">${title}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</span></span></div>`;

  // The board page reads why from the answer's x-kickflip-down (board/public/ui.js downOf).
  function downWhy(route, site) {
    const p = procs.get(route) || {};
    const serves = servesOf(site);
    return serves === 'port' ? 'stopped' : serves === 'files' ? 'missing' : p.why === 'code' ? 'code' : p.child ? 'starting' : 'crashed';
  }

  // A site that doesn't answer: the 502 page, with why in x-kickflip-down.
  function sendDown(res, route, site) {
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-kickflip-down': downWhy(route, site) });
    res.end(downPage(route, site));
  }

  function downPage(route, site) {
    const p = procs.get(route) || {};
    const exit = p.exitCode !== undefined && p.exitCode !== null ? ` (last exit: ${p.exitCode})` : '';
    const said = {
      stopped: `down · nothing answers on port ${site.port}`, missing: 'down · its folder is missing', code: 'restarting · its code changed',
      starting: 'starting · waiting for it to answer', crashed: `down · restarting${exit}`,
    };
    const why = downWhy(route, site);
    const tone = why === 'code' || why === 'starting' ? 'wait' : 'down';
    const serves = servesOf(site);
    const lede = serves === 'cmd' ? 'The hub runs every site and restarts one that stops.' : serves === 'port' ? 'Its session runs this server, so it comes back when that session starts it again.' : 'The hub serves this page from a folder that is no longer there.';
    return `${head(`${site.title || route} is down`, '<meta http-equiv="refresh" content="5">')}
<a class="back" href="/_hub/">‹ Hub</a>
<h1>${esc(site.title || route)} isn't answering</h1>
<p class="lede">${esc(lede)}</p>
<h2 class="label">Site</h2>
<div class="group">${row({ icon: siteIcon(route, site), title: esc(site.title || route), sub: `<span class="st ${tone}">${esc(said[why])}</span>` })}</div>
<p class="note">This page retries every 5 seconds.</p>
</main></body></html>`;
  }

  // ---------- proxy ----------
  // A path starting with // parses as a host, and "//" alone throws and takes the hub down.
  const requestURL = (req) => new URL(req.url.replace(/^\/+/, '/'), 'http://hub');

  // Shared boards (share.mjs): when each shared person was last seen, and who was just refused.
  const shares = shareTracker({ file: path.join(HOME, 'share-seen.json') });
  // A shared person's open /_hub/stream, {login, routes, res}: the one long-lived answer a shared view holds on the hub.
  // A board's share can be removed or change level while it's open, from Board settings or by editing board.json, so
  // on each reconcile, and at once after the owner's POST /<route>/api/share, a stream whose login has lost a board it was
  // opened with, or whose level there changed, is ended (its page's EventSource comes back through access, with the
  // boards and levels as they are now, or refused), as are that login's open responses through the board's try relays
  // (try.mjs).
  const sharedStreams = new Set();
  function endUnshared() {
    const sites = loadManifest().sites;
    for (const open of sharedStreams) {
      const now = sharedRoutes(open.login, sites);
      if ([...open.routes].some(([route, level]) => now.get(route) !== level)) { sharedStreams.delete(open); open.res.destroy(); }
    }
    endUnsharedTries();
  }

  // Every request and upgrade passes the owner gate first (board/on-host.mjs ownerGate, front-door.mjs). A login the gate
  // calls someone else that a board's board.json shares with reaches what share.mjs shareReach allows.
  // → {verdict: 'owner' | 'shared' | 'home' | 'view-only' | 'other' | 'unread', viewer}; viewer, for 'shared', is
  // {login, routes, sidebar(data)}, the person, their boards (route → level) and their view of the sidebar
  async function access(req) {
    const verdict = await gate(req);
    const login = req.headers['tailscale-user-login'];
    if (verdict !== 'other' || !login) return { verdict };
    const name = req.headers['tailscale-user-name'] || null;
    const { pathname } = requestURL(req);
    const routes = sharedRoutes(login, loadManifest().sites);
    const reach = routes.size ? shareReach({ method: req.method, pathname, routes }) : 'other';
    const route = routeOfPath(pathname);
    if (reach === 'other') {
      if (!routes.size || route) shares.refuse(login, name, route);
      return { verdict: 'other' };
    }
    if (reach !== 'pass') return { verdict: reach };
    shares.visit(login, name, route);
    const node = await gate.node();
    return { verdict: 'shared', viewer: { login, routes, sidebar: (data) => sharedSidebar(data, routes, node?.name || node?.login) } };
  }

  const server = http.createServer((req, res) => {
    access(req).then(({ verdict, viewer }) => {
      if (verdict === 'owner' || verdict === 'shared') serve(req, res, viewer);
      else if (verdict === 'home') { res.writeHead(302, { location: '/', 'cache-control': 'no-store' }).end(); req.resume(); }
      else refuse(req, res, verdict);
    });
  });

  // viewer: null for the owner, else access's shared person, whom access lets through only to their boards and the shell.
  function serve(req, res, viewer = null) {
    const url = requestURL(req);
    if (req.method !== 'GET' && req.method !== 'HEAD' && crossSite(req.headers)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('Requests must come from the app’s own pages.');
      return;
    }
    const served = servedSites(loadManifest());
    const sites = new Set(Object.keys(served));
    if (pageOf({ method: req.method, pathname: url.pathname, search: url.search, dest: destOf(req.headers), sites }) === 'shell') {
      const here = url.pathname === '/' ? '' : url.pathname.startsWith('/_hub/') ? url.pathname.slice(1) : decodeURIComponent(url.pathname.split('/')[1]);
      shellPage(here, viewer).then((html) => sendText(req, res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', vary: 'sec-fetch-dest', 'x-app-shell': '1' }, html))
        .catch((e) => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e.message || e)); });
      return;
    }
    if (url.pathname === '/_hub') { res.writeHead(302, { location: '/_hub/' + url.search }).end(); return; }
    if (url.pathname === '/_hub/status.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ hub: { port: PORT, pid: process.pid }, sites: status() }, null, 2)); return; }
    if (url.pathname === '/_hub/needs.json') {
      const rows = status();
      waitingCounts(rows, { fresh: url.searchParams.get('fresh') === '1' }).then((waiting) => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ total: badgeTotal(waiting), sites: Object.fromEntries(rows.map((r) => [r.route, waiting.get(r.route) ?? null])) }));
      }).catch((e) => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e.message || e)); });
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(301, { location: '/_hub/kickflip.png' }).end(); return; }
    if (url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/_hub/')) {
      hubRoute(req, res, url, viewer).then((handled) => { if (handled === false) res.writeHead(404).end(); })
        .catch((e) => { if (!res.headersSent) res.writeHead(e.status || 500, { 'content-type': 'text/plain' }); res.end(String(e.message || e)); });
      return;
    }

    const route = url.pathname.split('/')[1];
    const site = routeRecord(served, route);
    if (!site) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'x-kickflip-down': 'removed' }); res.end(`${head('No Site')}<a class="back" href="/_hub/">‹ Hub</a><h1>No site at /${esc(route)}</h1></main></body></html>`); return; }
    if (url.pathname === '/' + route) { res.writeHead(302, { location: '/' + route + '/' + url.search }).end(); return; }

    const prefix = '/' + route;
    // A shared person's request goes on as the path access checked, so the board can't read it differently.
    const rest = viewer ? url.pathname.slice(prefix.length) + url.search : req.url.slice(prefix.length) || '/';
    // The same URL is the shell for a page load and the page itself for its frame, so neither may answer the other.
    const vary = pageOf({ pathname: url.pathname, dest: 'document', sites }) === 'shell';
    if (servesOf(site) === 'files') {
      if (!isFolder(site.dir)) { sendDown(res, route, site); return; }
      serveFiles(req, res, { dir: site.dir, rest, prefix, headers: vary ? { vary: 'sec-fetch-dest' } : {} })
        .catch((e) => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e.message || e)); });
      return;
    }
    const headers = { ...req.headers, 'x-forwarded-prefix': prefix, 'x-forwarded-host': req.headers['x-forwarded-host'] || req.headers.host, 'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https' };
    // The board names a shared person's write by this login and checks its kind against their level; the owner's
    // request never carries one (docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md).
    delete headers['x-kickflip-shared'];
    if (viewer) headers['x-kickflip-shared'] = viewer.login;
    const up = http.request({ host: '127.0.0.1', port: site.port, method: req.method, path: rest, headers }, (r) => {
      // A board page tells the board's own failure from the hub's being down by this (board/public/ui.js downOf).
      const h = { ...r.headers, 'x-kickflip-hub': '1' };
      if (vary) h.vary = [h.vary, 'sec-fetch-dest'].filter(Boolean).join(', ');
      if (typeof h.location === 'string' && h.location.startsWith('/') && !h.location.startsWith('//') && !h.location.startsWith(prefix + '/') && h.location !== prefix) h.location = prefix + h.location;
      res.writeHead(r.statusCode, h);
      r.pipe(res);
      // pipe() never ends res when the site dies mid-response, so a board's /api/stream would hang open on the page.
      r.on('close', () => { if (!r.complete) res.destroy(); });
    });
    // A page that leaves a long-lived response, such as a board's /api/stream, would otherwise keep the site's end open.
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    if (!viewer && req.method === 'POST' && rest.split('?')[0] === '/api/share') res.on('finish', endUnshared);
    up.on('error', () => {
      if (res.headersSent) { res.destroy(); return; }
      sendDown(res, route, site);
    });
    req.pipe(up);
  }

  // WebSockets and other upgrades: pipe the raw sockets through.
  server.on('upgrade', async (req, socket, head) => {
    // A shared view opens no upgrades.
    const { verdict } = await access(req);
    if (verdict !== 'owner') { refuseUpgrade(socket, verdict === 'shared' ? 'view-only' : verdict === 'home' ? 'other' : verdict); return; }
    const route = requestURL(req).pathname.split('/')[1];
    const site = routeRecord(servedSites(loadManifest()), route);
    if (!site?.port) { socket.destroy(); return; }
    const prefix = `/${route}`;
    pipeUpgrade({ req, socket, head, port: site.port, path: req.url.slice(prefix.length) || '/', replace: ['x-forwarded-prefix'], extra: [`X-Forwarded-Prefix: ${prefix}`] });
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(askedPort, '127.0.0.1', resolve); });
  PORT = server.address().port;
  readiness.listenOn(PORT);
  log(`hub on http://127.0.0.1:${PORT}/ (manifest ${MANIFEST})`);
  reconcileLogged();
  // The hub's clock (shared/polls.mjs CLOCKS): each job runs every so many ticks of its clock, as its registry
  // entry says (docs/adr/2026-11-17-0330-every-poll-is-in-one-registry-and-the-hub-runs-on-two-clocks.md).
  const jobs = {
    reconcile: () => { reconcileLogged(); stream.reconcile(); }, // poll: reconcile
    'sidebar-refresh': () => stream.refresh(), // poll: sidebar-refresh
    tick, // poll: tick
    'hung-check': () => checkHung().catch((e) => log('hung check failed:', e.message)), // poll: hung-check
    'self-restart': () => (codeRestarts ? track(selfRestart.check()).catch((e) => log('self-restart check failed:', e.message)) : null), // poll: self-restart
    'nightly-suite': runSuite, // poll: nightly-suite
    'share-save': () => shares.flush(), // poll: share-save
  };
  for (const p of POLLS) if (p.clock && !jobs[p.id]) throw new Error(`shared/polls.mjs names ${p.id} on the hub's ${p.clock} clock, which runs no such job`);
  if (ticks) {
    for (const [clock, ms] of Object.entries(CLOCKS)) {
      let n = 0;
      timers.push(setInterval(() => { n++; for (const p of dueOn(clock, n)) jobs[p.id](); }, ms)); // poll: none, each job names its own
    }
  }
  return { port: PORT, reconcile, hung: checkHung, tick, poll: runPoll, settled, close };
}

// node hub/hub.mjs: the hub on KICKFLIP_HUB_PORT, else 4500, until SIGTERM or SIGINT.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const hub = await startHub({ port: Number(process.env.KICKFLIP_HUB_PORT || 4500) });
  const stop = () => Promise.race([hub.close(), new Promise((resolve) => setTimeout(resolve, 6000))]).finally(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
