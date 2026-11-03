// The polling interval: when the hub checks GitHub and then sends the queued pushes
// (docs/adr/0025-the-hub-polls-github-and-sends-pushes-on-one-interval.md). Pure functions of
// the host's clock and the `polling` settings (shape in DEFAULTS); push.mjs and hub.mjs apply them.
// Each window runs from its `from` until the next window's, wrapping past midnight. Its slots fall
// every `every_minutes` counted from its `from`, and the next window's `from` is always a slot.
// hold_overnight holds non-urgent pushes through the last window, the one before the first window's
// start, and sends them at that start; checks still run on the last window's interval. heldUntil is the gate.
// wakes are the times of day the hub wakes each board's session once, whether GitHub changed or not.
// notifications is stored beside `polling` in settings.json, not inside it, and gates pushes only
// (docs/adr/0032-notifications-can-be-off-snoozed-or-off-on-weekends.md).
import { FOREVER, durationEnd, inRange } from './duration.mjs';

export const DEFAULTS = Object.freeze({
  windows: Object.freeze([
    Object.freeze({ from: '08:00', every_minutes: 15 }),
    Object.freeze({ from: '18:00', every_minutes: 30 }),
    Object.freeze({ from: '22:00', every_minutes: 60 }),
  ]),
  hold_overnight: true,
  wakes: Object.freeze(['08:00', '09:00']),
  notifications: Object.freeze({ on: true, weekends_off: false, snoozed_until: null }),
});

// What heldUntil returns while notifications are off: no time comes when held pushes go, so they are dropped.
export const NEVER = 'never';

const MAX_WINDOWS = 8;
const MAX_WAKES = 8;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
// A poll this soon after the last window starts still sends the queue, so pushes queued before it go out.
const HOLD_GRACE_MS = 2 * 60_000;

const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const minuteOfDay = (d) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60_000;
const atOn = (d, hhmm, dayOffset = 0) => { const [h, m] = hhmm.split(':').map(Number); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, h, m); };
const nextAt = (t, hhmm) => { const d = atOn(t, hhmm); return d > t ? d : atOn(t, hhmm, 1); };
const lastAt = (t, hhmm) => { const d = atOn(t, hhmm); return d <= t ? d : atOn(t, hhmm, -1); };
const copy = (s) => ({ windows: s.windows.map((w) => ({ from: w.from, every_minutes: w.every_minutes })), hold_overnight: s.hold_overnight, wakes: [...s.wakes], notifications: { ...s.notifications } });

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

// Returns { settings } with windows sorted by start, every_minutes as numbers and wakes sorted, or { error }.
// A missing wakes or notifications gets the default ones.
export function validate(input) {
  const windows = input?.windows;
  const hold = input?.hold_overnight ?? DEFAULTS.hold_overnight;
  const wakes = input?.wakes ?? DEFAULTS.wakes;
  const { notifications, error } = validateNotifications(input?.notifications);
  if (error) return { error };
  if (typeof hold !== 'boolean') return { error: 'Hold pushes overnight must be on or off.' };
  if (!Array.isArray(wakes)) return { error: 'Wake times must be a list of HH:MM times.' };
  if (wakes.length > MAX_WAKES) return { error: `Use at most ${MAX_WAKES} wake times.` };
  for (const [i, w] of wakes.entries()) {
    if (typeof w !== 'string' || !TIME_RE.test(w)) return { error: `Wake ${i + 1} must be HH:MM (24-hour).` };
    if (wakes.indexOf(w) !== i) return { error: `Two wakes are at ${w}; keep one.` };
  }
  if (!Array.isArray(windows) || !windows.length) return { error: 'Add at least one window.' };
  if (windows.length > MAX_WINDOWS) return { error: `Use at most ${MAX_WINDOWS} windows.` };
  const out = [];
  for (const [i, w] of windows.entries()) {
    if (typeof w?.from !== 'string' || !TIME_RE.test(w.from)) return { error: `Window ${i + 1}'s start must be HH:MM (24-hour).` };
    const every = Number(w.every_minutes);
    if (w.every_minutes === '' || w.every_minutes == null || !Number.isInteger(every) || every < 5 || every > 120) return { error: `Window ${i + 1}'s interval must be a whole number of minutes from 5 to 120.` };
    if (out.some((o) => o.from === w.from)) return { error: `Two windows start at ${w.from}; give each its own start.` };
    out.push({ from: w.from, every_minutes: every });
  }
  return { settings: { windows: out.sort((a, b) => minutes(a.from) - minutes(b.from)), hold_overnight: hold, wakes: [...wakes].sort((a, b) => minutes(a) - minutes(b)), notifications } };
}

// The windows that best match the old `push` block {immediate: {start, end}, bundle: {until, every_minutes}}:
// the send-at-once hours poll at the default daytime interval, the bundle hours keep their interval, and
// the hold hours poll hourly and still hold pushes. null when the block isn't that shape.
export function fromPush(push) {
  const start = push?.immediate?.start, end = push?.immediate?.end, until = push?.bundle?.until;
  if (![start, end, until].every((v) => typeof v === 'string' && TIME_RE.test(v))) return null;
  const bundleEvery = Number(push.bundle.every_minutes);
  const windows = [{ from: start, every_minutes: DEFAULTS.windows[0].every_minutes }];
  if (end !== start && until !== end) windows.push({ from: end, every_minutes: Number.isInteger(bundleEvery) ? bundleEvery : DEFAULTS.windows[1].every_minutes });
  const holdFrom = until === end ? end : until;
  if (holdFrom !== start && !windows.some((w) => w.from === holdFrom)) windows.push({ from: holdFrom, every_minutes: DEFAULTS.windows[2].every_minutes });
  return validate({ windows, hold_overnight: until !== start }).settings || null;
}

// The polling settings in a parsed settings.json: its `polling`, else its old `push` block migrated, else DEFAULTS,
// with its `notifications`, or the default ones when those are missing or invalid.
export function pollingOf(file) {
  const notifications = validateNotifications(file?.notifications).notifications || copy(DEFAULTS).notifications;
  const withThem = (s) => s && { ...s, notifications };
  return validate({ ...file?.polling, notifications }).settings || withThem(fromPush(file?.push)) || withThem(copy(DEFAULTS));
}

// The window `now` falls in: { from, every_minutes, startedAt: Date, endsAt: Date }.
export function windowAt(now, s) {
  const ws = s.windows;
  const p = minuteOfDay(now);
  let i = ws.length - 1;
  for (let k = 0; k < ws.length; k++) if (minutes(ws[k].from) <= p) i = k;
  const w = ws[i];
  const next = ws[(i + 1) % ws.length];
  return { from: w.from, every_minutes: w.every_minutes, startedAt: lastAt(now, w.from), endsAt: nextAt(now, next.from) };
}

// How many minutes window `i` runs: from its start to the next window's, 1440 with one window.
export function windowSpan(s, i) {
  const ws = s.windows;
  if (ws.length === 1) return 1440;
  const d = minutes(ws[(i + 1) % ws.length].from) - minutes(ws[i].from);
  return d > 0 ? d : d + 1440;
}

// How many slots window `i` has each day, its start included.
export const checksIn = (s, i) => Math.ceil(windowSpan(s, i) / s.windows[i].every_minutes);
export const checksADay = (s) => s.windows.reduce((n, _, i) => n + checksIn(s, i), 0);

// Whether hold_overnight holds pushes through the last window: it needs a last window apart from the first.
export const holdsOvernight = (s) => s.hold_overnight && s.windows.length > 1;

// The day as stretches of minutes from midnight, [{window, start, end, held}] with `window` an index into s.windows:
// one stretch per window, or two for the window that runs past midnight. `held` marks the window holdsOvernight holds.
export function daySegments(s) {
  const last = s.windows.length - 1;
  return s.windows.flatMap((w, i) => {
    const start = minutes(w.from), end = start + windowSpan(s, i), held = holdsOvernight(s) && i === last;
    if (s.windows.length === 1) return [{ window: i, start: 0, end: 1440, held }];
    return end <= 1440 ? [{ window: i, start, end, held }] : [{ window: i, start, end: 1440, held }, { window: i, start: 0, end: end - 1440, held }];
  });
}

// Where splitting window `i` in two starts the new window: halfway through it, rounded to 15 minutes on the clock,
// as HH:MM. null when that point isn't inside the window or the windows are at their maximum.
export function splitPoint(s, i) {
  if (s.windows.length >= MAX_WINDOWS) return null;
  const start = minutes(s.windows[i].from), span = windowSpan(s, i);
  const at = Math.round((start + span / 2) / 15) * 15;
  if (at <= start || at >= start + span) return null;
  const m = at % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// One change from the Polling modal to settings `s`: { input } to save, with `select` the window start to show next,
// or { error }. op is `from` (value HH:MM), `every` (value minutes), `split` or `remove` on the window starting at
// `w`; `hold` (value 'on' or not); or `wake-add` / `wake-remove` (value HH:MM). validate checks the input.
export function editPolling(s, { op, w, value }) {
  const windows = s.windows.map((x) => ({ from: x.from, every_minutes: x.every_minutes }));
  const input = { windows, hold_overnight: s.hold_overnight, wakes: [...s.wakes] };
  const i = windows.findIndex((x) => x.from === w);
  if (['from', 'every', 'split', 'remove'].includes(op) && i < 0) return { error: 'That window has changed. Pick it again on the bar.' };
  const select = i < 0 ? s.windows[0].from : w;
  switch (op) {
    case 'from': windows[i].from = value; return { input, select: value };
    case 'every': windows[i].every_minutes = value; return { input, select };
    case 'split': {
      const at = splitPoint(s, i);
      if (!at) return { error: windows.length >= MAX_WINDOWS ? `Use at most ${MAX_WINDOWS} windows.` : 'This window is too short to split.' };
      windows.push({ from: at, every_minutes: windows[i].every_minutes });
      return { input, select: at };
    }
    case 'remove': {
      if (windows.length < 2) return { error: 'Keep at least one window.' };
      const before = windows[(i - 1 + windows.length) % windows.length].from;
      windows.splice(i, 1);
      return { input, select: before };
    }
    case 'hold': input.hold_overnight = value === 'on'; return { input, select };
    case 'wake-add': input.wakes.push(value); return { input, select };
    case 'wake-remove': input.wakes = input.wakes.filter((x) => x !== value); return { input, select };
    default: return { error: 'That change is not one the Polling modal makes.' };
  }
}

// Whether a poll at `t` holds the queue: holdsOvernight applies and `t` falls in the last window, past its start.
export function holdsPushes(t, s) {
  if (!holdsOvernight(s)) return false;
  const w = windowAt(t, s);
  return w.from === s.windows.at(-1).from && t - w.startedAt > HOLD_GRACE_MS;
}

// The weekend with notifications.weekends_off: from Friday at the last window's start until Monday at the first
// window's start, the same edges as the overnight hold, with the same grace after it starts. Its end, or null.
function weekendEnd(t, s) {
  if (!s.notifications?.weekends_off) return null;
  const [first, last] = [s.windows[0].from, s.windows.at(-1).from];
  let start = atOn(t, last, -((t.getDay() - 5 + 7) % 7));
  if (start > t) start = atOn(start, last, -7);
  const end = atOn(start, first, 3);
  return t - start > HOLD_GRACE_MS && t < end ? end : null;
}

// Why pushes are held at `t` and until when: { until: Date, why: 'snoozed' | 'weekend' | 'overnight' }, { until: FOREVER,
// why: 'snoozed' } until the snooze is ended, or { until: NEVER, why: 'off' }, or null when a push may go. One hold
// ending inside another runs on to the later end.
export function hold(t, s) {
  if (s.notifications?.on === false) return { until: NEVER, why: 'off' };
  if (s.notifications?.snoozed_until === FOREVER) return { until: FOREVER, why: 'snoozed' };
  const snooze = s.notifications?.snoozed_until ? new Date(s.notifications.snoozed_until) : null;
  const at = (u) => (snooze > u ? ['snoozed', snooze] : null) || (weekendEnd(u, s) && ['weekend', weekendEnd(u, s)]) || (holdsPushes(u, s) && ['overnight', windowAt(u, s).endsAt]);
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

// When a push queued at `t` goes out: the next slot, or the first slot once a hold on that slot ends; NEVER while off,
// FOREVER while snoozed until ended.
export function flushAt(t, s) {
  let slot = nextSlot(t, s);
  for (let n = 0; n < 8; n++) {
    const until = heldUntil(slot, s);
    if (until === NEVER || until === FOREVER) return until;
    if (!until) return slot;
    slot = nextSlot(new Date(until.getTime() - 1), s);
  }
  return slot;
}

// When a snooze chosen at `now` ends: a duration.mjs durationEnd choice; `tonight`, the next start of the evening
// window (the second-to-last, or the second of two); `morning`, the next start of the first window; or `monday`, the
// next Monday at the first window's start. null for any other choice, or `tonight` with one window.
export function snoozeEnd(now, choice, s) {
  const c = String(choice);
  const [first, n] = [s.windows[0].from, s.windows.length];
  let end;
  if (c === 'morning') end = nextAt(now, first);
  else if (c === 'tonight') end = n > 1 ? nextAt(now, s.windows[Math.max(1, n - 2)].from) : null;
  else if (c === 'monday') { end = atOn(now, first, (8 - now.getDay()) % 7); if (end <= now) end = atOn(end, first, 7); }
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

// The first polling slot strictly after `t`.
export function nextSlot(t, s) {
  const w = windowAt(t, s);
  const every = w.every_minutes * 60_000;
  const slot = new Date(w.startedAt.getTime() + (Math.floor((t - w.startedAt) / every) + 1) * every);
  return slot < w.endsAt ? slot : w.endsAt;
}

// The host's calendar day of `d`, "2026-10-23".
export function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The wake times at or before `now` today whose last send, sent[hhmm] as a localDay, isn't today. A wake missed
// on an earlier day is never due again.
export function wakesDue(now, s, sent = {}) {
  const today = localDay(now);
  return s.wakes.filter((w) => atOn(now, w) <= now && sent?.[w] !== today);
}

// The board a push's url opens, `/<route>/…`, or null for a url outside any site.
const routeOf = (url) => /^\/([^/?#]+)(?:[/?#]|$)/.exec(url || '')?.[1] ?? null;

// The notifications a queue of {id, title, body, url, tag, kind}, oldest first, goes out as, keeping only the newest
// push of each tag: a board with one push sends it unchanged; a board with more sends one summary of what waits on it
// now, from `sites`, the /_hub/needs.json `sites` ({<route>: {count, summary} | null}), and nothing when nothing
// waits. A board missing from `sites`, or null there, gets "N updates" with the first titles. Each comes out as
// {title, body, url, tag, kind, members: the queued ids it stands for}, in queue order of each board's first push kept
// (docs/adr/0120-queued-pushes-go-as-one-summary-per-board.md).
export function notifications(items, sites = {}) {
  const newest = new Map();
  items.forEach((i, k) => { if (i.tag) newest.set(i.tag, k); });
  const groups = new Map();
  items.filter((i, k) => !i.tag || newest.get(i.tag) === k).forEach((i) => {
    const key = routeOf(i.url) ?? Symbol(i.id);
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
