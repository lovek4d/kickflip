// When the hub checks git and GitHub, and when pushes wait
// (docs/adr/2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md). The check's cadence
// is fixed in code and follows the owner's presence (presence.mjs): checkEvery and nextCheckAt. Quiet hours, `quiet`
// in settings.json, run from `start` to `end`, wrapping past midnight: with `hold` on, non-urgent pushes queued in
// them wait for their end, the snoozes tonight, morning and monday end at their edges, and their end is the daily wake,
// when the hub wakes each board's session once, whether GitHub changed or not. heldUntil is the gate every push passes.
// notifications is stored beside `quiet` in settings.json, not inside it, and gates pushes only
// (docs/adr/2026-10-29-1639-notifications-can-be-off-snoozed-or-off-on-weekends.md).
import { FOREVER, durationEnd, inRange } from './duration.mjs';

export const DEFAULTS = Object.freeze({
  quiet: Object.freeze({ start: '22:00', end: '08:00', hold: true }),
  notifications: Object.freeze({ on: true, weekends_off: false, snoozed_until: null }),
});

// The alert switches (docs/adr/2026-11-17-1505-alerts-opt-in-to-sounding-the-live-row-as-implement-or-a-merge-joins.md): `alerts` in settings.json, beside `notifications`,
// each kind sounding a board's open live notification again as a task of it joins. Every switch is off unless stored true.
export const ALERTS = Object.freeze({ implement: false, merge: false });
export const alertsOf = (file) => Object.fromEntries(Object.keys(ALERTS).map((kind) => [kind, file?.alerts?.[kind] === true]));

// What heldUntil returns while notifications are off: no time comes when held pushes go, so they are dropped.
export const NEVER = 'never';

// Minutes between checks: while the owner is present, while away, and both while GitHub's points left read below LOW_POINTS.
export const CHECK_MINUTES = Object.freeze({ present: 1, away: 5, lowPresent: 5, lowAway: 15 });
export const LOW_POINTS = 1000;
// The longest a check can take to follow the last one, for link grace periods.
export const SLOWEST_CHECK_MINUTES = CHECK_MINUTES.lowAway;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
// A push queued this soon after quiet hours start still goes, so pushes queued before them go out at the next check.
const HOLD_GRACE_MS = CHECK_MINUTES.away * 60_000;

const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const atOn = (d, hhmm, dayOffset = 0) => { const [h, m] = hhmm.split(':').map(Number); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, h, m); };
const nextAt = (t, hhmm) => { const d = atOn(t, hhmm); return d > t ? d : atOn(t, hhmm, 1); };
const lastAt = (t, hhmm) => { const d = atOn(t, hhmm); return d <= t ? d : atOn(t, hhmm, -1); };
const copy = (s) => ({ quiet: { ...s.quiet }, notifications: { ...s.notifications } });

// The minutes between checks: `remaining` is GitHub's points left at the last check, null when it made no query.
export function checkEvery({ present, remaining = null }) {
  const low = remaining !== null && remaining < LOW_POINTS;
  return present ? (low ? CHECK_MINUTES.lowPresent : CHECK_MINUTES.present) : (low ? CHECK_MINUTES.lowAway : CHECK_MINUTES.away);
}

// When the check after the one started at `last` runs: checkEvery later, or at `backAt`, when the owner came back
// since, so coming back checks at once and the cadence restarts from there.
export function nextCheckAt({ last, present, remaining = null, backAt = null }) {
  if (backAt && backAt > last) return new Date(backAt);
  return new Date(last.getTime() + checkEvery({ present, remaining }) * 60_000);
}

// Returns { notifications } with snoozed_until as an ISO time, FOREVER or null, or { error }. Missing fields get the defaults.
function validateNotifications(input) {
  const on = input?.on ?? DEFAULTS.notifications.on;
  const weekends = input?.weekends_off ?? DEFAULTS.notifications.weekends_off;
  const until = input?.snoozed_until ?? null;
  if (typeof on !== 'boolean') return { error: 'Notifications must be on or off.' };
  if (typeof weekends !== 'boolean') return { error: 'Off on weekends must be on or off.' };
  if (until !== null && until !== FOREVER && (typeof until !== 'string' || Number.isNaN(Date.parse(until)))) return { error: 'Snooze must end at a date and time, or be forever.' };
  return { notifications: { on, weekends_off: weekends, snoozed_until: until === null || until === FOREVER ? until : new Date(until).toISOString() } };
}

// Returns { settings: {quiet, notifications} } or { error }. A missing hold or notifications gets the default.
export function validate(input) {
  const { start, end, hold = DEFAULTS.quiet.hold } = input?.quiet || {};
  const { notifications, error } = validateNotifications(input?.notifications);
  if (error) return { error };
  if (typeof start !== 'string' || !TIME_RE.test(start)) return { error: 'Quiet hours\' start must be HH:MM (24-hour).' };
  if (typeof end !== 'string' || !TIME_RE.test(end)) return { error: 'Quiet hours\' end must be HH:MM (24-hour).' };
  if (start === end) return { error: 'Quiet hours must start and end at different times.' };
  if (typeof hold !== 'boolean') return { error: 'Hold pushes must be on or off.' };
  return { settings: { quiet: { start, end, hold }, notifications } };
}

// The quiet hours that best match the old `polling` windows {windows: [{from}], hold_overnight}: from the last window's
// start to the first's, keeping the hold. null with fewer than two windows, which had no overnight.
export function fromPolling(polling) {
  const froms = (Array.isArray(polling?.windows) ? polling.windows : []).map((w) => w?.from).filter((f) => typeof f === 'string' && TIME_RE.test(f))
    .sort((a, b) => minutes(a) - minutes(b));
  if (froms.length < 2) return null;
  return { start: froms.at(-1), end: froms[0], hold: polling.hold_overnight !== false };
}

// The quiet hours settings in a parsed settings.json: its `quiet`, else its old `polling` migrated, else DEFAULTS,
// with its `notifications`, or the default ones when those are missing or invalid.
export function quietOf(file) {
  const notifications = validateNotifications(file?.notifications).notifications || copy(DEFAULTS).notifications;
  return validate({ quiet: file?.quiet, notifications }).settings
    || validate({ quiet: fromPolling(file?.polling), notifications }).settings
    || { ...copy(DEFAULTS), notifications };
}

// One change from the Quiet hours modal to settings `s`: {start} or {end} as HH:MM, or {hold: 'on' | anything else}.
// → the input for validate.
export function editQuiet(s, change) {
  const q = { ...s.quiet };
  if ('start' in change) q.start = change.start;
  if ('end' in change) q.end = change.end;
  if ('hold' in change) q.hold = change.hold === 'on';
  return { quiet: q, notifications: s.notifications };
}

// Whether `t` falls in quiet hours, from their start up to their end.
export function quietAt(t, s) {
  const p = t.getHours() * 60 + t.getMinutes();
  const [a, b] = [minutes(s.quiet.start), minutes(s.quiet.end)];
  return a < b ? p >= a && p < b : p >= a || p < b;
}

// The middle of the quiet hours `t` falls in, from that middle up to their end, else null: when a board's overnight
// triage goes out (docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md).
export function quietMiddleOf(t, s) {
  if (!quietAt(t, s)) return null;
  const start = lastAt(t, s.quiet.start);
  const length = (minutes(s.quiet.end) - minutes(s.quiet.start) + 1440) % 1440;
  const middle = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes() + length / 2);
  return middle <= t ? middle : null;
}

// The middle of quiet hours as HH:MM, when overnight work starts (overnight.mjs).
export function quietMiddle(s) {
  const start = minutes(s.quiet.start);
  const middle = (start + Math.floor(((minutes(s.quiet.end) - start + 1440) % 1440) / 2)) % 1440;
  return `${String(Math.floor(middle / 60)).padStart(2, '0')}:${String(middle % 60).padStart(2, '0')}`;
}

// Whether a check at `t` holds the queue: the hold is on and `t` falls in quiet hours, past their start's grace.
export function holdsPushes(t, s) {
  return s.quiet.hold && quietAt(t, s) && t - lastAt(t, s.quiet.start) > HOLD_GRACE_MS;
}

// The weekend with notifications.weekends_off: from Friday at quiet hours' start until Monday at their end, with the
// same grace as the overnight hold. Its end, or null.
function weekendEnd(t, s) {
  if (!s.notifications?.weekends_off) return null;
  let start = atOn(t, s.quiet.start, -((t.getDay() - 5 + 7) % 7));
  if (start > t) start = atOn(start, s.quiet.start, -7);
  const end = atOn(start, s.quiet.end, 3);
  return t - start > HOLD_GRACE_MS && t < end ? end : null;
}

// Why pushes are held at `t` and until when: { until: Date, why: 'snoozed' | 'weekend' | 'overnight' }, { until: FOREVER,
// why: 'snoozed' } until the snooze is ended, or { until: NEVER, why: 'off' }, or null when a push may go. One hold
// ending inside another runs on to the later end.
export function hold(t, s) {
  if (s.notifications?.on === false) return { until: NEVER, why: 'off' };
  if (s.notifications?.snoozed_until === FOREVER) return { until: FOREVER, why: 'snoozed' };
  const snooze = s.notifications?.snoozed_until ? new Date(s.notifications.snoozed_until) : null;
  const at = (u) => (snooze > u ? ['snoozed', snooze] : null) || (weekendEnd(u, s) && ['weekend', weekendEnd(u, s)]) || (holdsPushes(u, s) && ['overnight', nextAt(u, s.quiet.end)]);
  const firstHold = at(t);
  if (!firstHold) return null;
  let until = firstHold[1];
  for (let next = at(until), n = 0; next && n < 8; next = at(until), n++) until = next[1];
  return { until, why: firstHold[0] };
}

// The one gate every push passes, urgent ones only while notifications are off: null when a push may go at `t`,
// else when held pushes go, FOREVER while snoozed until ended, or NEVER while notifications are off.
export function heldUntil(t, s) {
  return hold(t, s)?.until ?? null;
}

// When a push queued at `t` goes out: by the next check while away, the slower of the usual cadences, or once its hold
// ends; NEVER while off, FOREVER while snoozed until ended.
export function flushAt(t, s) {
  return heldUntil(t, s) ?? new Date(t.getTime() + CHECK_MINUTES.away * 60_000);
}

// When a snooze chosen at `now` ends: a duration.mjs durationEnd choice; `tonight`, the next start of quiet hours;
// `morning`, their next end; or `monday`, the next Monday at their end. null for any other choice.
export function snoozeEnd(now, choice, s) {
  const c = String(choice);
  let end;
  if (c === 'morning') end = nextAt(now, s.quiet.end);
  else if (c === 'tonight') end = nextAt(now, s.quiet.start);
  else if (c === 'monday') { end = atOn(now, s.quiet.end, (8 - now.getDay()) % 7); if (end <= now) end = atOn(end, s.quiet.end, 7); }
  else return durationEnd(now, c);
  return inRange(now, end) ? end : null;
}

// A hold (see hold) as words: "snoozed until 3:00pm", "held for the weekend until 8:00am Mon Oct 19".
export function holdLine(h, now = new Date()) {
  if (h.why === 'off') return 'notifications are off';
  if (h.until === FOREVER) return 'snoozed until you end it';
  const until = clock(h.until, now);
  return h.why === 'snoozed' ? `snoozed until ${until}` : h.why === 'weekend' ? `held for the weekend until ${until}` : `held overnight until ${until}`;
}

// The host's calendar day of `d`, "2026-10-23".
export function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The daily wake, quiet hours' end, when it is at or before `now` today and its last send, sent[hhmm] as a localDay,
// isn't today. A wake missed on an earlier day is never due again. The review digest opens then too (slack.mjs slackDay).
// poll: morning-wake
export function wakesDue(now, s, sent = {}) {
  const w = s.quiet.end;
  return atOn(now, w) <= now && sent?.[w] !== localDay(now) ? [w] : [];
}

// The board a push's url opens, `/<route>/…`, or null for a url outside any site.
const routeOf = (url) => /^\/([^/?#]+)(?:[/?#]|$)/.exec(url || '')?.[1] ?? null;

// A board's live notification (board/domain.mjs ownerRow), tagged board-<route>.
const isLiveRow = (item) => /^board-/.test(item.tag || '');
// A push to a questions link: one held when its hold ends is left out, since its card on the board keeps it.
const isQuestionLink = (url) => /^\/[^/?#]+\/questions\.html(?:[?#]|$)/.test(url || '');

// The notifications a queue of {id, title, body, url, tag, kind}, oldest first, goes out as, keeping only the newest
// push of each tag: a board with one push sends it unchanged; a board with more sends one summary of what waits on it
// now, from `sites`, the /_hub/needs.json `sites` ({<route>: {count, summary} | null}), and nothing when nothing
// waits. A board missing from `sites`, or null there, gets "N updates" with the first titles. Each comes out as
// {title, body, url, tag, kind, members: the queued ids it stands for}, in queue order of each board's first push kept
// (docs/adr/2026-11-02-1733-queued-pushes-go-as-one-summary-per-board.md). A board's live notification goes as itself,
// even to a questions link, never in its board's summary
// (docs/adr/2026-11-15-1300-a-boards-needs-you-pushes-are-one-live-row.md).
export function notifications(items, sites = {}) {
  const newest = new Map();
  items.forEach((i, k) => { if (i.tag) newest.set(i.tag, k); });
  const groups = new Map();
  items.filter((i, k) => (isLiveRow(i) || !isQuestionLink(i.url)) && (!i.tag || newest.get(i.tag) === k)).forEach((i) => {
    const key = isLiveRow(i) ? Symbol(i.id) : routeOf(i.url) ?? Symbol(i.id);
    groups.set(key, [...(groups.get(key) || []), i]);
  });
  return [...groups].flatMap(([route, group]) => {
    if (group.length === 1) {
      const [i] = group;
      return [{ title: i.title, body: i.body || '', url: i.url || '/', tag: i.tag || undefined, kind: i.kind, members: [i.id] }];
    }
    const needs = sites[route];
    if (needs && !needs.count) return [];
    const where = route === '_hub' ? 'Hub' : route;
    const titles = group.map((i) => i.title);
    const title = needs ? `${needs.count} need${needs.count === 1 ? 's' : ''} you on ${where}` : `${group.length} updates on ${where}`;
    const body = needs ? needs.summary : [...titles.slice(0, 2), ...(titles.length > 2 ? [`and ${titles.length - 2} more`] : [])].join(' · ');
    const kind = group.every((i) => i.kind === 'action') ? 'action' : group.find((i) => i.kind !== 'action').kind;
    return [{ title, body, url: `/${route}/`, tag: `summary:${route}`, kind, members: group.map((i) => i.id) }];
  });
}

// When queued pushes go, a flushAt result, as words: a clock time, or "once the snooze ends" while snoozed until ended.
export const sendWords = (at, now = new Date()) => (at === FOREVER ? 'once the snooze ends' : clock(at, now));

// "6:30pm", or "8:00am tomorrow" when `d` falls on a later day than `now`.
export function clock(d, now = new Date()) {
  const h = d.getHours();
  const t = `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
  const days = Math.round((atOn(d, '00:00') - atOn(now, '00:00')) / 86_400_000);
  return days === 0 ? t : days === 1 ? `${t} tomorrow` : `${t} ${d.toDateString().slice(0, 10)}`;
}
