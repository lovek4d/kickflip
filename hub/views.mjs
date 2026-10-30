// The hub's own views' data (docs/adr/0055-one-app-for-the-whole-hub.md): what GET /_hub/api/hub, /_hub/api/settings
// and /_hub/api/polling answer, with every word the hub page, Hub Settings and Polling show. hub.mjs reads the state
// these take; board/public/view-hub.js, view-hub-settings.js and view-polling.js only lay the words out.
// st is a push.mjs queueStatus(now) result throughout, and poll the hub's poll state {running, nextAt, last}, last
// being the last github.mjs checkGitHub result.
import { clock, windowAt, holdLine, checksIn, checksADay, holdsOvernight, daySegments, splitPoint, snoozeEnd, localDay } from './schedule.mjs';
import { siteIcon } from './icons.mjs';

export const capital = (t) => t.charAt(0).toUpperCase() + t.slice(1);
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const every = (n) => (n >= 60 && n % 60 === 0 ? `${n / 60} h` : `${n} min`);
const timeOfDay = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return clock(d, d); };
const minuteOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const pct = (m) => `${((m / 1440) * 100).toFixed(3)}%`;

export const nowLine = (st, now) => `checks every ${st.window.every_minutes} min until ${clock(st.window.endsAt, now)}${st.hold ? `; ${holdLine(st.hold, now)}` : ''}`;
export const pollingSummary = (s) => [`${plural(s.windows.length, 'window')}, ${checksADay(s)} checks a day`, holdsOvernight(s) && 'held overnight',
  s.wakes.length ? `wakes ${s.wakes.map(timeOfDay).join(', ')}` : 'no wakes'].filter(Boolean).join(' · ');
const queuedLine = (st, now) => (st.count ? `${st.count} push${st.count === 1 ? '' : 'es'} queued; next send ${clock(st.nextFlushAt, now)}.` : 'No pushes queued.');

export function pollLine({ running = false, nextAt, last = null }, now) {
  if (running) return 'Checking GitHub now';
  const next = `Next check ${clock(nextAt, now)}`;
  if (!last) return next;
  const what = last.failed.length ? 'could not reach GitHub for every PR' : last.watched ? `${plural(last.watched, 'PR')}, ${last.changes.length ? `${last.changes.length} changed` : 'no change'}` : 'no PRs watched';
  return `${next} · last ${clock(new Date(last.at), now)}, ${what}`;
}

// The Now row the hub page and Polling share: what polling does now, the last and next check, the queue and Send now.
function pollingNow(st, poll, now) {
  return { title: capital(nowLine(st, now)), lines: [pollLine(poll, now), queuedLine(st, now)], count: st.count };
}

// One site's row on the hub page: a word for the site, then each of its board links that isn't passing. links is the
// board's boards.mjs linksOf, or undefined for a site that isn't a board.
export function siteHealth(r, links) {
  if (r.state !== 'up') return { tone: r.state === 'down' ? 'down' : 'wait', word: r.state === 'down' ? 'Down · restarting' : capital(r.state), lines: [] };
  if (!links) return { tone: 'ok', word: 'Up', lines: [] };
  const off = links.filter((l) => !l.ok);
  const broken = off.filter((l) => l.state === 'broken');
  const events = links.find((l) => l.link === 'events');
  const heard = events?.listen === 'asleep' ? 'asleep' : events?.ok ? 'listening' : 'not listening';
  const word = broken.length ? `${plural(broken.length, 'link')} broken · ${heard}` : off.length ? `Up · ${heard} · ${off.length} settling` : `Up · ${heard} · every link passes`;
  return { tone: broken.length ? 'down' : off.length ? 'wait' : 'ok', word, lines: off.map((l) => ({ link: l.link, detail: `${l.state === 'broken' ? '' : 'settling: '}${l.detail}` })) };
}

// sidebar: the /_hub/sidebar.json data, whose hub detail already says when the hub runs older code (home.mjs
// hubHealth); rows: hub.mjs status() rows; links: {<route>: linksOf}; code: {running, onDisk}, the hub's code hashes
// (boards.mjs); host: the address the page was loaded from; rules: the hub rules. Boards and Pages stay apart, as in
// the sidebar (board/public/ui-sidebar.js).
export function hubView({ now, st, poll, sidebar, rows, links = {}, code = {}, host = '', rules = [] }) {
  const boards = new Set(sidebar.sites.filter((x) => x.board).map((x) => x.route));
  const codeLine = code.running && code.running === code.onDisk ? ` · runs the code in its files (${code.onDisk})` : '';
  const site = (r) => ({ route: r.route, title: r.title, icon: siteIcon(r.route, r), href: `/${encodeURIComponent(r.route)}/`, ...siteHealth(r, links[r.route]) });
  const groups = [['Boards', rows.filter((r) => boards.has(r.route))], ['Pages', rows.filter((r) => !boards.has(r.route))]]
    .filter(([, list]) => list.length).map(([label, list]) => ({ label, sites: list.map(site) }));
  return {
    hub: { tone: sidebar.hub.tone, word: sidebar.hub.word, detail: `${sidebar.hub.detail}${codeLine}` },
    groups,
    empty: rows.length === 0,
    polling: { ...pollingNow(st, poll, now), summary: pollingSummary(st.settings) },
    notifications: { on: st.settings.notifications.on, text: sidebar.notifications.text, device: nowLine(st, now) },
    rules: rules.length ? plural(rules.length, 'rule') : 'None yet',
    sites: plural(rows.length, 'site'),
    host,
    total: sidebar.total,
  };
}

// Each value is a schedule.mjs snoozeEnd choice.
const SNOOZE_CHOICES = [['1h', '1 hour'], ['3h', '3 hours'], ['tonight', 'Until tonight'], ['morning', 'Until morning'], ['monday', 'Until Monday'], ['1w', '1 week']];
export const SNOOZE_REFUSED = 'That snooze ends in the past or more than 30 days on. Pick another time.';

// The value a datetime-local input takes for `d` on this Mac's clock, "2026-10-23T15:30".
const localInput = (d) => `${localDay(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
function timeLeft(until, now) {
  const m = Math.max(1, Math.round((until - now) / 60_000));
  return m < 60 ? `${m} min left` : m < 1440 ? `${Math.round(m / 60)} h left` : `${plural(Math.round(m / 1440), 'day')} left`;
}
const snoozedUntil = (n, now) => (n.on && n.snoozed_until && new Date(n.snoozed_until) > now ? new Date(n.snoozed_until) : null);

// Hub Settings: the on/off, snooze and weekend controls (docs/adr/0032-notifications-can-be-off-snoozed-or-off-on-weekends.md),
// the polling summary and the hub rules. The snooze sheet is null while notifications are off; Until tonight shows only
// while it ends today, and while snoozed the sheet extends the snooze, so a choice ending no later than now's snooze
// is disabled.
export function settingsView({ now, st, rules = [] }) {
  const s = st.settings;
  const n = s.notifications;
  const [first, last] = [s.windows[0], s.windows.at(-1)];
  const until = snoozedUntil(n, now);
  const queued = st.count ? ` The ${st.count} queued push${st.count === 1 ? ' is' : 'es are'} dropped now.` : '';
  const choices = SNOOZE_CHOICES.map(([value, label]) => ({ value, label, end: snoozeEnd(now, value, s) }))
    .filter((c) => c.end && (c.value !== 'tonight' || localDay(c.end) === localDay(now)))
    .map(({ value, label, end }) => ({ value, label, until: `until ${clock(end, now)}`, disabled: Boolean(until && end <= until) }));
  return {
    snoozed: until ? { title: `Snoozed until ${clock(until, now)}`, sub: `${timeLeft(until, now)} · urgent pushes still go` } : null,
    device: nowLine(st, now),
    on: {
      on: n.on,
      sub: n.on ? 'On. Turn off to drop every push, urgent ones too.' : 'Off. Every push is dropped, urgent ones too. Needs you and the badge still update.',
      confirm: `Turn off notifications? Every push is dropped until you turn them back on, urgent ones too.${queued} Needs you and the badge still update.`,
    },
    snooze: n.on ? { sub: until ? `Until ${clock(until, now)}` : 'Pushes wait, then go. Urgent ones still go.', value: until ? 'On' : 'Off' } : null,
    weekends: { on: n.weekends_off, sub: `Pushes wait from Friday ${timeOfDay(last.from)} until Monday ${timeOfDay(first.from)}. Urgent ones still go.` },
    polling: pollingSummary(s),
    sheet: n.on ? { title: until ? 'Extend snooze' : 'Snooze pushes', choices, min: localInput(until || now), max: localInput(new Date(now.getTime() + 30 * 86_400_000)) } : null,
    rules,
  };
}

const EVERY_CHOICES = [5, 10, 15, 30, 60, 120];
// Darker checks more often: 5 minutes is the full accent, 120 is 30% of it.
const shade = (n) => Math.round(100 - (Math.log(n / 5) / Math.log(24)) * 70);
const windowRange = (s, i) => (s.windows.length === 1 ? 'All day' : `${timeOfDay(s.windows[i].from)} – ${timeOfDay(s.windows[(i + 1) % s.windows.length].from)}`);

// Polling: every window with what its section shows, so picking another stretch of the day needs no request. select,
// from ?w=, names the window to show; the window `now` falls in when it names none.
export function pollingView({ now, st, poll, select = null }) {
  const s = st.settings;
  const found = s.windows.findIndex((w) => w.from === select);
  const sel = found >= 0 ? found : s.windows.findIndex((w) => w.from === windowAt(now, s).from);
  const one = s.windows.length === 1;
  const [first, last] = [s.windows[0], s.windows.at(-1)];
  return {
    select: s.windows[sel].from,
    now: pollingNow(st, poll, now),
    day: {
      segments: daySegments(s).map((g) => {
        const w = s.windows[g.window];
        return {
          w: w.from, left: pct(g.start), width: pct(g.end - g.start), shade: `${shade(w.every_minutes)}%`, held: g.held,
          label: g.end - g.start >= 110 ? every(w.every_minutes).replace(' min', 'm').replace(' h', 'h') : '',
          aria: `${windowRange(s, g.window)}, every ${every(w.every_minutes)}${g.held ? ', pushes held' : ''}`,
        };
      }),
      pins: s.wakes.map((w) => ({ left: pct(minuteOf(w)), title: `Wake ${timeOfDay(w)}` })),
      now: pct(now.getHours() * 60 + now.getMinutes()),
      held: holdsOvernight(s),
      wakes: s.wakes.length > 0,
    },
    windows: s.windows.map((w, i) => ({
      from: w.from, range: windowRange(s, i), ends: one ? '—' : timeOfDay(s.windows[(i + 1) % s.windows.length].from),
      every: [...new Set([...EVERY_CHOICES, w.every_minutes])].sort((a, b) => a - b).map((m) => ({ minutes: m, label: every(m), on: m === w.every_minutes })),
      checks: `${plural(checksIn(s, i), 'check')} in this window`, split: Boolean(splitPoint(s, i)), remove: !one,
    })),
    hold: { on: s.hold_overnight, sub: one ? 'With one window there is no overnight to hold.' : `Pushes queued after ${timeOfDay(last.from)} wait until ${timeOfDay(first.from)}. GitHub checks still run.` },
    wakes: s.wakes.map((t) => ({ value: t, label: timeOfDay(t) })),
  };
}

// What Send now answers: push.mjs flushQueue's result, null when nothing was queued.
export function flushView(r) {
  if (!r) return { sent: 0, count: 0, ok: true, message: 'Nothing was queued.' };
  if (!r.ok) return { sent: r.sent, count: r.count, ok: false, message: 'Could not send the queue. It stays queued for the next check.' };
  return { sent: r.sent, count: r.count, ok: true, message: `Sent ${r.count} queued push${r.count === 1 ? '' : 'es'}.` };
}
