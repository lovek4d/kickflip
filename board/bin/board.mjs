#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as store from '../store.mjs';
import { makeWorktree, land, skillRepo, worktreesDir } from '../worktree.mjs';
import { ITEM_STATUSES } from '../domain.mjs';
import { pushKindError } from '../../hub/push.mjs';

export const USAGE = `usage: node board.mjs <command> [--site <route>] ...

Writes a web-ts board's data files. --site <route> picks ~/.claude/web-ts/sites/<route>, and its
board.json says where the board's waves live. Without --site, waves come from ~/.claude/waves.
Paths resolve under $HOME, so HOME=<dir> points every command at a copy.
A --file argument of - reads stdin.

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
          source?, context?, url?, urgent?}; topic is declared, item:<wave>/<id>, or item:ask:<eventId>
          for a New card not sorted yet.
         url is http(s), or a site page such as prototype-<topic>.html?q=<id>, stored as given.
         diagram, with practice: rows of 1-4 boxes [[{text, tone?, to?}]], tone quiet|info|notice|
         danger|success, to the next row's box indexes (default all); practice: ["<line>", …]
  question resolve <id> --note <text>                    sets resolved and resolved_at
  item set <wave>/<id> [--status <s> | --clear-status]   edits the item in its wave file
         [--next <t> | --clear-next] [--pr <n>]          status: ${ITEM_STATUSES.join(', ')}
                                                         an empty --next "" clears it, as --clear-next does
                                                         naming another unfinished card requires it in --deps
         [--from-ask <eventId>]                          the ask it came from: its New card gives way to this item,
                                                         whose thread opens with the ask and its thread; it leaves
                                                         a card it was folded into
         [--held | --unheld]                             --held sets held: true, for the owner's card-hold;
                                                         --unheld clears it and a held status
         [--title <t>]                                   renames the card
         [--notes-file <file>]                           the item's notes: a .md file inside its wave's folder,
                                                         named relative to it, holding the session's understanding
                                                         of the task so far. The open card's Notes link opens it,
                                                         or without one the item's short notes text. --plan is an
                                                         alias
         [--deps <id>,<wave>/<id>]                       replaces its blocked-by list; --deps "" clears it
         [--install <url> [--install-sha <sha>]          a device build the owner installs from the card's Install
          [--install-label <text>] | --clear-install]    button, stamped built_at now: itms-services://?action=
                                                         download-manifest&url=https://…/manifest.plist for iOS,
                                                         an https:// .apk URL for Android. --install-sha is the
                                                         PR head it was built from: the button reads "older build"
                                                         once the PR moves past it. Hidden once the card is Done
         --status building refuses while the item is held or a dep isn't done, merged or dropped;
         done, merged and dropped print "unblocked: <wave>/<id>" and append card-unblocked {key}
         once per unblocking, including held cards: start each unheld card next.
         checking is a builder's hand-back: In Review, reading "Claude
         checking", until the owning session verifies it and sets done; it unblocks nothing.
         Every --status or --clear-status records status_at, which ends the Done button's "Closing…"
         for the owner's card-done; apply a card-done with --status done.
         --status done, merged or dropped closes the card: it resolves each of its questions (topic
         item:<wave>/<id>) that has an answer, noting "Closed with the card", and prints "resolved: <id>"
         for each. It refuses while one has no answer yet; [--force] closes it and resolves that one too
  item add <wave>/<id> --title <t> [--notes <t>]          a new card, planned (waiting when it has --deps); never
         [--deps <id>,<wave>/<id>] [--notes-file <file>] hand-edit wave.json to add one. Refuses an id the wave has.
                                                         --plan is an alias of --notes-file
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
                                                         <minutes> (default 30); run it at the end of each monitor tick.
                                                         --idle: the board shows no open PR, so never late.
                                                         Then sends the queued pushes, each on its own, unless
                                                         pushes are held (overnight, snoozed, the weekend or off)
  followup add <wave> --id <PROD-1> --title <t> [--from <item id>]
  followup done <wave> <id> [--force]                    closes the follow-up's card as item set --status done does
  reviewers set --file <json>                            the board's reviewers in board.json, replacing them:
                                                         [{name, slack_user, dm, github}], as in wave.json.
                                                         The settings page lists them; new waves copy them
  reviewers add --file <json>                            one reviewer or an array; replaces the same name
  reviewers remove <name>...                             refuses a name the board doesn't have
  rules list                                             the hub rules, then with --site the board's, one
                                                         "<hub|board> <id> <owner|claude> <text>" line each
  rules add --text <t> [--hub] [--by claude]             a rule in board.json, or with --hub in the hub's
                                                         settings.json for every board; prints its id.
                                                         --by claude when you codify one on the owner's word
  rules edit <id> --text <t> [--hub]                     rewords a rule, keeping who added it
  rules remove <id> [--hub]                              refuses an id the list doesn't have
  settings                                               the board's settings as JSON, each false when board.json
                                                         leaves it out: {"auto_merge": false}
  settings set auto-merge on|off                         on: monitor merges an approved PR once CI is green and
                                                         the merge state is CLEAN. off (the default): the card
                                                         shows the owner a Merge button, and monitor merges on its
                                                         card-merge event. The Settings page's toggle writes it too
  install <wave>/<id> --site <route>                     asks the hub to run this board's install script; prints
                                                         started and exits while the build runs. Only the owner
                                                         sets the script, on this board's Settings page. The hub
                                                         records its builder, output log and result in the thread
  builder start <wave>/<id> [--agent <name>] [--kind <opus|codex|sonnet|install|…>] [--label <who>]
         [--progress <text>] [--eta <ISO time>]          one record per agent on the item; --agent defaults to main.
                                                         --kind install: a build of the card's install, whose
                                                         Install chip reads Rebuilding… (or Building…) meanwhile
         [--worktree [--repo <dir>]]                     --worktree: a git worktree for the builder at
                                                         ~/.claude/web-ts/worktrees/<id> on a new branch <id> from
                                                         main of --repo (default ~/.claude/skills/join-web-ts), kept on
                                                         the record and printed as "worktree: <path>". Refuses when
                                                         that path or branch exists
  builder progress <wave>/<id> (<text> | --text <t>)     one short present-tense line
         [--agent <name>]
         [--eta <ISO time> | --clear-eta]                an ETA shows as a line under the card's status
         A progress line, --progress included, needs --site: it is a status line in the item's thread, and
         the card's status shows the newest one from an agent still working
  builder done <wave>/<id> [--agent <name>]              marks that agent's record done; the item's thread
                                                         shows when it started and finished
         builder takes --dir <dir> for a wave file in <dir>; its records go in <dir>/agents
  land <wave>/<id> [--repo <dir>] [--dir <dir>]          brings the worktree its builder record keeps (else
                                                         ~/.claude/web-ts/worktrees/<id> of --repo) into main, one line
                                                         per step: refuses while it has uncommitted changes or adds no
                                                         commit; rebases onto main when main moved, refusing on a
                                                         conflict with the rebase undone; refuses unless its full
                                                         node --test suite passes; fast-forwards main in the repo;
                                                         restarts the hub when its code changed, else each board
                                                         server when board/ changed; removes the worktree and its
                                                         branch. Never pushes. WEB_TS_RESTART_CMD='["<cmd>"]' replaces
                                                         the restarts, called with hub or board <route>
  push --kind action|prompt|fault --title <t>            runs web-ts push with these flags, adding
       [--body <b>] [--url </route/path>]                "· and N replies" to the body for the replies
       [--tag <tag>] [--now | --urgent]                  written since the site's last push through this
                                                         command (none before its first). For an item, tag it
                                                         ask-<eventId> or item-<wave>/<id>; a card whose action
                                                         changes pushes again under its tag. It records the
                                                         push in data/push-state.json only when web-ts push
                                                         succeeds, and exits with web-ts push's code.
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
         WEB_TS_PUSH_CMD='["<cmd>","<arg>"]' replaces \`node ../../bin/web-ts.mjs push\`; the flags follow it`;

class UsageError extends Error {}
const BOOLEAN = new Set(['clear-status', 'clear-next', 'urgent', 'now', 'clear-eta', 'held', 'unheld', 'idle', 'hub', 'clear-install', 'force', 'worktree']);
const WEB_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'web-ts.mjs');

function pushCommand() {
  if (!process.env.WEB_TS_PUSH_CMD) return [process.execPath, WEB_TS, 'push'];
  try {
    const cmd = JSON.parse(process.env.WEB_TS_PUSH_CMD);
    if (Array.isArray(cmd) && cmd.length && cmd.every((a) => typeof a === 'string')) return cmd;
  } catch {}
  throw new store.BoardError('WEB_TS_PUSH_CMD must be a JSON array of strings');
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
  if (r.status !== 0) throw Object.assign(new store.BoardError(`web-ts push failed (${r.error?.message || `exit ${r.status ?? r.signal}`}); the push was not recorded`), { exitCode: r.status || 1 });
  return store.recordPush(site, at);
}

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const name = a.slice(2);
    if (name in flags) throw new UsageError(`--${name} is given twice`);
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
const TEXT_FLAGS = ['html', 'text', 'note', 'notes', 'summary', 'title', 'body', 'next', 'progress', 'install-label'];
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

// name: [positional args, allowed flags, run(site, args, flags) → message]
const COMMANDS = {
  reply: [['eventId'], ['html', 'file'], (site, [id], f) => {
    if ((f.html === undefined) === (f.file === undefined)) throw new UsageError('reply takes --html or --file');
    return store.writeReply(site, id, f.html ?? readInput(f.file));
  }],
  thread: [['wave/id'], ['text', 'link', 'who', 'via'], (site, [key], f) => store.appendThread(site, key, f)],
  'topic add': [['id'], ['title', 'summary'], (site, [id], f) => store.addTopic(site, { id, ...f })],
  'question add': [[], ['file'], (site, _, f) => store.addQuestions(site, readJSONInput(f.file))],
  'question resolve': [['id'], ['note'], (site, [id], f) => store.resolveQuestion(site, id, f.note)],
  'item set': [['wave/id'], ['status', 'clear-status', 'next', 'clear-next', 'pr', 'from-ask', 'held', 'unheld', 'notes-file', 'plan', 'deps', 'install', 'install-sha', 'install-label', 'clear-install', 'title', 'force'], (site, [key], f) =>
    store.setItem(site, key, { status: f.status, clearStatus: f['clear-status'], next: f.next, clearNext: f['clear-next'], pr: f.pr, fromAsk: f['from-ask'], held: f.held, unheld: f.unheld, notesFile: notesFileOf(f), deps: f.deps,
      install: f.install, installSha: f['install-sha'], installLabel: f['install-label'], clearInstall: f['clear-install'], title: f.title, force: f.force })],
  'item add': [['wave/id'], ['title', 'notes', 'deps', 'notes-file', 'plan'], (site, [key], f) => store.addItem(site, key, { title: f.title, notes: f.notes, deps: f.deps, notesFile: notesFileOf(f) })],
  'item relate-ask': [['eventId', 'wave/id'], ['summary'], (site, [id, key], f) => store.relateAsk(site, id, key, f.summary)],
  'ask progress': [['eventId'], ['next'], (site, [id], f) => store.markAsk(site, id, 'progress', f.next)],
  'ask done': [['eventId'], [], (site, [id]) => store.markAsk(site, id, 'done')],
  'ask unfold': [['eventId'], [], (site, [id]) => store.unfoldAsk(site, id)],
  'ask move': [['eventId'], ['to'], (site, [id], f) => store.moveAsk(site, id, f.to)],
  'followup add': [['wave'], ['id', 'title', 'from'], (site, [wave], f) => store.addFollowup(site, wave, f)],
  'followup done': [['wave', 'id'], ['force'], (site, [wave, id], f) => store.finishFollowup(site, wave, id, { force: f.force })],
  'reviewers set': [[], ['file'], (site, _, f) => store.setReviewers(site, readJSONInput(f.file))],
  'reviewers add': [[], ['file'], (site, _, f) => store.addReviewers(site, readJSONInput(f.file))],
  'reviewers remove': [['...name'], [], (site, names) => store.removeReviewers(site, names)],
  'rules list': [[], [], (site) => store.listRules(site)],
  'rules add': [[], ['text', 'hub', 'by'], (site, _, f) => store.addRuleTo(site, f)],
  'rules edit': [['id'], ['text', 'hub'], (site, [id], f) => store.editRuleIn(site, id, f)],
  'rules remove': [['id'], ['hub'], (site, [id], f) => store.removeRuleFrom(site, id, f)],
  settings: [[], [], async (site) => ({ lines: [JSON.stringify(await store.readBoardSettings(site))] })],
  install: [['wave/id'], [], async (site, [key]) => {
    if (!site) throw new store.BoardError('install needs --site <route>');
    store.parseKey(key);
    try {
      const r = await fetch(`http://127.0.0.1:${process.env.WEB_TS_HUB_PORT || 4500}/_hub/install`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ route: path.basename(site), key }), signal: AbortSignal.timeout(10_000),
      });
      const out = await r.json();
      if (!r.ok) throw new store.BoardError(out.error || 'The hub refused the install build.');
      return { lines: ['started'] };
    } catch (e) {
      if (e instanceof store.BoardError) throw e;
      throw new store.BoardError(`Could not start the install build: ${e.message}`);
    }
  }],
  'settings set': [['name', 'on|off'], [], (site, [name, value]) => store.setBoardSetting(site, name, value)],
  'builder start': [['wave/id'], ['label', 'progress', 'dir', 'agent', 'kind', 'eta', 'worktree', 'repo'], (site, [key], { worktree, repo, ...f }) => {
    if (repo !== undefined && !worktree) throw new UsageError('--repo goes with --worktree');
    return store.startBuilder(site, key, { ...f, worktree: worktree && (() => makeWorktree(key.split('/')[1], { repo })) });
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

export async function main(argv) {
  try {
    const { flags, rest } = parse(argv);
    const name = COMMANDS[`${rest[0]} ${rest[1]}`] ? `${rest[0]} ${rest[1]}` : rest[0];
    const command = COMMANDS[name];
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
    const result = await run(site, args, opts);
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

if (import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') console.log(USAGE);
  else process.exitCode = await main(argv);
}
