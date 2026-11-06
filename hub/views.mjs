// The hub's own views' data (docs/adr/2026-10-29-2005-one-app-for-the-whole-hub.md): what GET /_hub/api/hub and
// /_hub/api/settings answer, with every word the hub page and its settings modals show. hub.mjs reads the state
// these take; integration readiness rows and their words come from readiness.mjs; board/public/view-hub.js and view-hub-settings.js only lay the words out.
// st is a push.mjs queueStatus(now) result throughout, and poll the hub's poll state {running, nextAt, last, present,
// every, low}: last the last github.mjs checkGitHub result, present whether the owner reads present, every the minutes
// between checks now and low whether GitHub's points left slow them (schedule.mjs checkEvery).
import { clock, holdLine, sendWords, snoozeEnd } from './schedule.mjs';
import { CHOICES as DURATIONS, FOREVER, durationEnd, endOf } from './duration.mjs';
import { siteIcon } from './icons.mjs';
import { codexStatus } from '../shared/codex.mjs';

export const capital = (t) => t.charAt(0).toUpperCase() + t.slice(1);
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const timeOfDay = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return clock(d, d); };

// The cadence (docs/adr/2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md) as words.
export const cadenceLine = (poll) => `checks every ${poll.every === 1 ? 'minute' : `${poll.every} min`} while you’re ${poll.present ? 'here' : 'away'}${poll.low ? ', slower while GitHub’s points are low' : ''}`;
export const nowLine = (st, poll, now) => `${cadenceLine(poll)}${st.hold ? `; ${holdLine(st.hold, now)}` : ''}`;
// When pushes go now, for the device row.
const deviceLine = (st, now) => (st.hold ? holdLine(st.hold, now) : 'pushes go out after each check');
export const quietSummary = (s) => `${timeOfDay(s.quiet.start)} – ${timeOfDay(s.quiet.end)}${s.quiet.hold ? ' · pushes held' : ''}`;
// The muted hint under Quiet hours, in the owner's words.
export const QUIET_HINT = "checks every minute while you're here, every 5 when away";
const queuedLine = (st, now) => (st.count ? `${st.count} push${st.count === 1 ? '' : 'es'} queued; next send ${sendWords(st.nextFlushAt, now)}.` : 'No pushes queued.');

export function pollLine({ running = false, nextAt, last = null }, now) {
  if (running) return 'Checking GitHub now';
  const next = `Next check ${clock(nextAt, now)}`;
  if (!last) return next;
  const what = last.failed.length ? 'could not reach GitHub for every PR' : last.watched ? `${plural(last.watched, 'PR')}, ${last.changes.length ? `${last.changes.length} changed` : 'no change'}` : 'no PRs watched';
  return `${next} · last ${clock(new Date(last.at), now)}, ${what}`;
}

// The hub page's Polling status row: how often checks run now, the last and next check, the queue and Send now.
function pollingNow(st, poll, now) {
  return { title: capital(nowLine(st, poll, now)), lines: [pollLine(poll, now), queuedLine(st, now)], count: st.count };
}

// One site's row on the hub page: a word for the site, then each of its board links that isn't passing. links is the
// board's boards.mjs linksOf, or undefined for a site that isn't a board. A broken link reads amber degraded, since the
// site still answers; red is for a site that is down (docs/adr/2026-11-03-0501-the-hub-reads-healthy-degraded-or-a-site-down.md).
export function siteHealth(r, links) {
  const down = { port: 'down · not answering', files: 'down · folder missing' }[r.serves] || 'down · restarting';
  if (r.state !== 'up') return { tone: r.state === 'down' ? 'down' : 'wait', word: r.state === 'down' ? down : r.state, lines: [] };
  if (!links) return { tone: 'ok', word: 'up', lines: [] };
  const off = links.filter((l) => !l.ok);
  const broken = off.filter((l) => l.state === 'broken');
  const events = links.find((l) => l.link === 'events');
  const heard = events?.listen === 'asleep' || events?.listen === 'waking' ? events.listen : events?.ok ? 'listening' : 'not listening';
  const word = broken.length ? `degraded · ${heard}` : off.length ? `up · ${heard} · ${off.length} settling` : `up · ${heard} · every link passes`;
  return { tone: off.length ? 'wait' : 'ok', word, lines: off.map((l) => ({ link: l.link, detail: `${l.state === 'broken' ? '' : 'settling: '}${l.detail}` })) };
}

// builder: the Claude model's word for who builds when Codex doesn't (BUILDER_WORDS).
const CODEX_CHOICES = [
  { value: 'always', label: 'Always on', description: () => 'Codex implements and reviews. Work pauses when it runs out.' },
  { value: 'auto', label: 'Auto', description: (builder) => `Codex implements and reviews, and ${builder} takes over while it's out.` },
  { value: 'off', label: 'Off', description: (builder) => `${builder} implements and reviews.` },
];

// The Usage card's Codex block (docs/adr/2026-11-01-1521-codex-share-follows-whether-codex-is-usable.md). share is the setting in
// effect and status a shared/codex.mjs codexStatus; while Codex isn't usable, tag, description and fix say why and
// what to run, and the choices are disabled. claudeModel names who takes over (docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md).
const codexView = (share, status, claudeModel) => ({
  usable: status.usable,
  tag: status.usable ? null : status.reason,
  share,
  choices: CODEX_CHOICES.map(({ value, label }) => ({ value, label, on: value === share })),
  description: status.usable ? CODEX_CHOICES.find((c) => c.value === share).description(BUILDER_WORDS[claudeModel]) : status.words,
  fix: status.fix,
});

// The Usage card's Claude model control (docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md): model
// is push.mjs readClaudeModel, and the description always says what Auto does. builder is the word for who builds
// when Claude does, which the Codex share and pause line descriptions use: the forced model, or Claude under Auto.
const BUILDER_WORDS = { opus: 'Opus', sonnet: 'Sonnet', auto: 'Claude' };
const CLAUDE_CHOICES = [
  { value: 'opus', label: 'Opus', description: 'Always Opus. Auto would give small cards to Sonnet.' },
  { value: 'auto', label: 'Auto', description: 'Auto: small cards get Sonnet, the rest get Opus.' },
  { value: 'sonnet', label: 'Sonnet', description: 'Always Sonnet. Auto would give large cards to Opus.' },
];
const claudeView = (model) => ({
  model,
  builder: BUILDER_WORDS[model],
  choices: CLAUDE_CHOICES.map(({ value, label }) => ({ value, label, on: value === model })),
  description: CLAUDE_CHOICES.find((c) => c.value === model).description,
});

// sidebar: the /_hub/sidebar.json data, whose hub detail already says when the hub runs older code (home.mjs
// hubHealth), and hub.restart is true while it does, for the Hub row's Restart hub; rows: hub.mjs status() rows, whose restart (restart-board.mjs restartable) gives a board its Restart; links: Map of route to linksOf; code: {running, onDisk}, the hub's code hashes
// (boards.mjs); host: the address the page was loaded from; version: the running hub's package.json version, named in the footer; rules: the hub rules; codexShare: push.mjs readCodexShare(codex); claudeModel: push.mjs readClaudeModel;
// codex: a shared/codex.mjs codexStatus; awake: awake.mjs awakeUntil, which the Health row's Keeping awake shows.
// Boards and Pages stay apart, as in the sidebar (board/public/ui-sidebar.js).
// hold, for the page's banner, is null unless pushes are held or snoozed; its text matches the sidebar moon's tooltip,
// and end is true when End can lift it, which only a snooze allows.
export function hubView({ now, st, poll, sidebar, rows, links = new Map(), code = {}, host = '', version, rules = [], remembered = new Map(), integrations = [], codexShare = 'off', claudeModel = 'auto', codex = codexStatus({ installed: false }), awake = null }) {
  const boards = new Set(sidebar.sites.filter((x) => x.board).map((x) => x.route));
  const current = Boolean(code.running && code.running === code.onDisk);
  const codeLine = current ? ` · runs the code in its files (${code.onDisk})` : '';
  const site = (r) => ({ route: r.route, title: r.title, icon: siteIcon(r.route, r), href: `/${encodeURIComponent(r.route)}/`, ...siteHealth(r, links.get(r.route)), remembered: remembered.get(r.route) || [],
    restart: boards.has(r.route) && r.restart === true });
  const groups = [['Boards', rows.filter((r) => boards.has(r.route))], ['Pages', rows.filter((r) => !boards.has(r.route))]]
    .filter(([, list]) => list.length).map(([label, list]) => ({ label, sites: list.map(site) }));
  return {
    hub: { tone: sidebar.hub.tone, word: sidebar.hub.word, detail: `${sidebar.hub.detail}${codeLine}`, restart: !current },
    awake: awake && untilWords(awake, now, AWAKE_FOREVER),
    groups,
    integrations,
    usage: sidebar.usage,
    pause: sidebar.pause,
    codex: codexView(codexShare, codex, claudeModel),
    claude: claudeView(claudeModel),
    empty: rows.length === 0,
    polling: pollingNow(st, poll, now),
    notifications: { on: st.settings.notifications.on, text: sidebar.notifications.text, device: deviceLine(st, now) },
    hold: st.hold && st.hold.why !== 'off' ? { text: `Notifications ${holdLine(st.hold, now)}`, end: st.hold.why === 'snoozed' } : null,
    rules: rules.length ? plural(rules.length, 'rule') : 'None yet',
    sites: plural(rows.length, 'site'),
    host,
    version,
    total: sidebar.total,
  };
}

export const SNOOZE_REFUSED = 'That snooze ends in the past or more than 30 days on. Pick another time.';
export const AWAKE_REFUSED = 'That keep awake ends in the past or more than 30 days on. Pick another time.';
const SNOOZE_FOREVER = 'until you end it';
const AWAKE_FOREVER = 'until you turn it off';
const PAUSE_FOREVER = 'until you resume';

const untilWords = (end, now, forever) => (end === FOREVER ? forever : `until ${clock(end, now)}`);
// The shared duration picker's chips (duration.mjs), each with when it would end if chosen at `now`.
export const durationChoices = (now, forever) => DURATIONS.map(([value, label]) => ({ value, label, until: untilWords(durationEnd(now, value), now, forever) }));
const snoozedUntil = (n, now) => (n.on ? endOf(n.snoozed_until, now) : null);

// The hub page's hub settings: the on/off, snooze and weekend controls (docs/adr/2026-10-29-1639-notifications-can-be-off-snoozed-or-off-on-weekends.md),
// quiet hours, hub rules and the Linear key, of which only whether it is set, whether Linear refused it and
// its workspace are shown (linear.mjs linearStatus; docs/adr/2026-11-01-1436-kickflip-reaches-linear-with-a-key-on-the-mac.md),
// and Keep awake. Snooze and
// Keep awake share one duration picker (docs/adr/2026-11-02-1402-snooze-and-keep-awake-share-one-duration-picker.md), whose
// choices are null while that setting is on, and Snooze's while notifications are off. awake is
// {until: awake.mjs awakeUntil, unsupported: awake.mjs awakeUnsupported}.
// pausedUntil is Pause hub's end, a Date or FOREVER, or null while it is off
// (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md): its picker is the snooze picker's.
export function settingsView({ now, st, rules = [], linear = { set: false }, slack = { set: false }, awake = { until: null, unsupported: null }, pausedUntil = null }) {
  const s = st.settings;
  const n = s.notifications;
  const until = snoozedUntil(n, now);
  const queued = st.count ? ` The ${st.count} queued push${st.count === 1 ? ' is' : 'es are'} dropped now.` : '';
  const snoozedTitle = until && `Snoozed ${untilWords(until, now, SNOOZE_FOREVER)}`;
  const pausedTitle = pausedUntil && `Paused ${untilWords(pausedUntil, now, PAUSE_FOREVER)}`;
  return {
    pause: { on: pausedUntil ? { title: pausedTitle } : null, summary: pausedUntil === FOREVER ? 'Paused · forever' : pausedTitle || 'Off', choices: pausedUntil ? null : durationChoices(now, PAUSE_FOREVER) },
    snoozed: until ? { title: snoozedTitle, summary: until === FOREVER ? 'Snoozed · forever' : snoozedTitle } : null,
    device: deviceLine(st, now),
    on: {
      on: n.on,
      sub: n.on ? 'On. Turn off to drop every push, urgent ones too.' : 'Off. Every push is dropped, urgent ones too. Needs you and the badge still update.',
      confirm: `Turn off notifications? Every push is dropped until you turn them back on, urgent ones too.${queued} Needs you and the badge still update.`,
    },
    snooze: n.on && !until ? { choices: durationChoices(now, SNOOZE_FOREVER) } : null,
    awake: {
      unsupported: awake.unsupported,
      on: awake.until ? { title: `Keeping awake ${untilWords(awake.until, now, AWAKE_FOREVER)}` } : null,
      choices: awake.unsupported || awake.until ? null : durationChoices(now, AWAKE_FOREVER),
      summary: awake.unsupported || (!awake.until ? 'Off' : awake.until === FOREVER ? 'On · forever' : `On until ${clock(awake.until, now)}`),
    },
    weekends: { on: n.weekends_off, sub: `Pushes wait from Friday ${timeOfDay(s.quiet.start)} until Monday ${timeOfDay(s.quiet.end)}. Urgent ones still go.` },
    quiet: quietView(s, now),
    rules,
    linear: linearWords(linear),
    slack: slackWords(slack),
  };
}

// The Slack app the owner makes once: a manifest with the user scopes the hub's sends need, opened on Slack's new-app
// page, whose User OAuth Token goes in the slot (docs/adr/2026-11-05-0141-the-hub-sends-reviewer-slack-messages-with-its-own-token.md).
const SLACK_MANIFEST = { display_information: { name: 'Kickflip' }, oauth_config: { scopes: { user: ['chat:write', 'im:write', 'reactions:write', 'users:read'] } } };
const SLACK_APPS = { url: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(SLACK_MANIFEST))}`, label: 'a new Slack app' };
function slackWords(slack) {
  const workspace = slack.team ? `${slack.team} workspace` : '';
  const make = `Make ${SLACK_APPS.label}, install it to your workspace, then paste its User OAuth Token (xoxp-…) here.`;
  if (!slack.set) return { set: false, title: 'No token', sub: make, keys: SLACK_APPS, summary: 'No token' };
  if (slack.refused) {
    return { set: true, refused: true, title: workspace || 'Slack token', down: 'doesn’t work', sub: `Slack refused the token. ${make}`,
      keys: SLACK_APPS, summary: workspace ? `Token doesn’t work · ${workspace}` : 'Token doesn’t work' };
  }
  return { set: true, title: workspace, sub: `Token •••••••• · sends as ${slack.user}`, summary: `Token set · ${workspace}` };
}

// sub names keys.label, which board/public/linear-key.js links to keys.url.
const LINEAR_KEYS = { url: 'https://linear.app/settings/account/security', label: 'Linear › Settings › Security & access › Personal API keys' };
function linearWords(linear) {
  const workspace = linear.workspace ? `${linear.workspace} workspace` : '';
  if (!linear.set) return { set: false, title: 'No key', sub: `Make a personal API key in ${LINEAR_KEYS.label}, then paste it here.`, keys: LINEAR_KEYS, summary: 'No key' };
  if (linear.refused) {
    return { set: true, refused: true, title: workspace || 'Linear key', down: 'doesn’t work', sub: `Linear refused the key. Make a new one in ${LINEAR_KEYS.label} and paste it here.`,
      keys: LINEAR_KEYS, summary: workspace ? `Key doesn’t work · ${workspace}` : 'Key doesn’t work' };
  }
  return { set: true, title: workspace, sub: 'Key ••••••••', summary: `Key set · ${workspace}` };
}

// The Quiet hours modal (docs/adr/2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md):
// its start and end, the overnight hold, the cadence hint, and what the snoozes, the weekend and the daily wake read with them.
function quietView(s, now) {
  const q = s.quiet;
  const [start, end] = [timeOfDay(q.start), timeOfDay(q.end)];
  const tonight = snoozeEnd(now, 'tonight', s);
  const reads = [
    ['Snooze tonight', `Until ${clock(tonight, now)}${q.hold ? `, then quiet hours hold pushes until ${clock(snoozeEnd(tonight, 'morning', s), now)}` : ''}.`],
    ['Snooze morning', `Until ${clock(snoozeEnd(now, 'morning', s), now)}.`],
    ['Snooze monday', `Until ${clock(snoozeEnd(now, 'monday', s), now)}.`],
    ['Off on weekends', s.notifications.weekends_off ? `Pushes wait from Friday ${start} until Monday ${end}.` : 'Off.'],
    ['Daily wake', `Every board wakes once at ${end}, when quiet hours end.`],
  ];
  return {
    start: q.start, end: q.end, summary: quietSummary(s), hint: QUIET_HINT,
    hold: { on: q.hold, sub: q.hold ? `Pushes queued after ${start} wait until ${end}. Urgent ones still go.` : 'Off. Pushes go out all night.' },
    reads: reads.map(([title, sub]) => ({ title, sub })),
  };
}

// What Send now answers: push.mjs flushQueue's result, null when nothing was queued.
export function flushView(r) {
  if (!r) return { sent: 0, count: 0, ok: true, message: 'Nothing was queued.' };
  if (!r.ok) return { sent: r.sent, count: r.count, ok: false, message: 'Could not send the queue. It stays queued for the next check.' };
  return { sent: r.sent, count: r.count, ok: true, message: `Sent ${r.count} queued push${r.count === 1 ? '' : 'es'}.` };
}
