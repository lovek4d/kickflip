// The one duration picker Snooze, Keep awake and a card's Hold share (docs/adr/0112-snooze-and-keep-awake-share-one-duration-picker.md):
// its chips, and when a choice ends. An end is stored as an ISO time, or FOREVER for on until turned off.
export const FOREVER = 'forever';

// The chips as [value, label]; Custom, a date and time up to MAX_MS on, follows them.
export const CHOICES = Object.freeze([['1h', '1h'], ['3h', '3h'], ['6h', '6h'], ['1d', '1d'], [FOREVER, 'Forever']]);
export const MAX_MS = 30 * 86_400_000;

export const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

// When a choice made at `now` ends: FOREVER for `forever`; `<n>m`, `<n>h`, `<n>d` or `<n>w` of elapsed time, a day
// being 24 hours across daylight saving changes; or an ISO date and time, the host's time when it has no offset.
// null for any other choice, or an end not after `now` or more than MAX_MS on.
export function durationEnd(now, choice) {
  const c = String(choice);
  if (c === FOREVER) return FOREVER;
  const m = /^([1-9]\d{0,3})([mhdw])$/.exec(c);
  const end = m ? new Date(now.getTime() + Number(m[1]) * UNIT_MS[m[2]]) : AT_RE.test(c) ? new Date(c) : null;
  return inRange(now, end) ? end : null;
}

export const inRange = (now, end) => Boolean(end) && end > now && end - now <= MAX_MS;

// A stored end as FOREVER or a Date; null when unset, unreadable or not after `now`.
export function endOf(stored, now) {
  if (stored === FOREVER) return FOREVER;
  const end = typeof stored === 'string' ? new Date(stored) : null;
  return end && end > now ? end : null;
}

// A durationEnd result as it is stored.
export const storedEnd = (end) => (end === FOREVER ? FOREVER : end.toISOString());
