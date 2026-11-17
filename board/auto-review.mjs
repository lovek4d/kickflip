// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
// The board's Auto Review lane, from what the hub's poll found and what the session recorded. incoming is
// data/incoming.json {at, repo, prs: [{number, title, author, url, head, touches: [card key], asked}]}, the open PRs
// from others that touch this board's cards or ask the owner for review (hub/incoming.mjs). records is
// data/reviews.json {<number>: {number, title, author, url, touches, asked, head, state: posted|needs, text,
// review_url?, at}}, which `board.mjs review record` writes. events is the board's event log: a pr-review {pr, head}
// the server sent reads reviewing until a review is recorded at that head. A review-answer {pr, answer} to a held review
// is applied by the server itself (asks.mjs applyReviewAnswer); one that failed leaves a review-failed {pr, answer,
// error}, which the held review's card shows in red until the review is recorded again.
const DAY = 86400000;
const ORDER = { needs: 0, reviewing: 1, posted: 2 };
const newest = (events, kind, pr) => events.filter((e) => e.kind === kind && e.data?.pr === pr).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1);

// The pr-review event a listed PR p's review is under way for, given its record rec: a pr-review at p's head with no
// review recorded at that head since; or null.
function pendingAsk(p, rec, events) {
  const ask = newest(events, 'pr-review', p.number);
  if (ask && ask.data.head === p.head && !(rec?.head === p.head && String(rec.at) > String(ask.ts))) return ask;
  return null;
}
// docs/adr/2026-11-15-1200-an-event-with-no-task-waits-on-the-orchestrator-until-acted-on.md
// The pr-review events a review is under way for, one per listed PR: each stays until review post or review record
// records that PR again (reviewsOf's reviewing). → [event]
export const pendingReviewAsks = ({ incoming, records = {}, events = [] }) => (incoming?.prs || []).map((p) => pendingAsk(p, records[p.number], events)).filter(Boolean);

// The review-failed event of a listed PR's held review whose Post it or Skip the server could not apply: the newest one
// after the held record, until the review is recorded again. → [event]
export const failedReviewAnswers = ({ incoming, records = {}, events = [] }) => (incoming?.prs || []).map((p) => {
  const rec = records[p.number];
  const failed = rec?.state === 'needs' && newest(events, 'review-failed', p.number);
  return failed && String(failed.ts) > String(rec.at) ? failed : null;
}).filter(Boolean);

// → {on, shown, at, repo, cards, earlier, waiting, due}. cards are the live PRs, needs you then reviewing then posted;
// earlier the posted reviews whose PR left the list or that are over a day old, newest first, each with open saying
// whether its PR is still listed. waiting counts the listed PRs owed a review; due is the one the server sends next,
// asked ones first, or null while one is under way or the setting is off.
export function reviewsOf({ on, incoming, records = {}, events = [], refs = new Map(), now = Date.now() }) {
  const listed = new Map((incoming?.prs || []).map((p) => [p.number, p]));
  const card = (p, rec, state, at) => ({
    number: p.number, title: p.title, author: p.author, url: p.url, asked: Boolean(p.asked),
    touches: (p.touches || []).map((key) => ({ key, ref: refs.get(key) || key })), state, at,
    text: rec?.text || null, reviewUrl: rec?.review_url || null, failure: failures.get(p.number) || null,
  });
  const failures = new Map(failedReviewAnswers({ incoming, records, events }).map((e) => [e.data.pr, e.data.error]));
  const cards = [];
  const owed = [];
  for (const p of listed.values()) {
    const rec = records[p.number];
    const pending = pendingAsk(p, rec, events);
    if (pending) cards.push(card(p, rec, 'reviewing', pending.ts));
    else {
      if (rec) cards.push(card(p, rec, rec.state, rec.at));
      if (!rec || (rec.state === 'posted' && rec.head !== p.head)) owed.push(p);
    }
  }
  const old = (c) => c.state === 'posted' && now - Date.parse(c.at) > DAY;
  const earlier = [
    ...cards.filter(old).map((c) => ({ ...c, open: true })),
    ...Object.values(records).filter((rec) => !listed.has(rec.number)).map((rec) => ({ ...card(rec, rec, rec.state, rec.at), open: false })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const live = cards.filter((c) => !old(c)).sort((a, b) => ORDER[a.state] - ORDER[b.state] || String(b.at).localeCompare(String(a.at)));
  owed.sort((a, b) => Number(Boolean(b.asked)) - Number(Boolean(a.asked)) || a.number - b.number);
  const busy = cards.some((c) => c.state === 'reviewing');
  return { on: Boolean(on), shown: Boolean(on) || live.length > 0, at: incoming?.at || null, repo: incoming?.repo || null,
    cards: live, earlier, waiting: owed.length, due: on && !busy ? owed[0] || null : null };
}

const held = (reviews) => reviews.cards.filter((c) => c.state === 'needs');
// One Needs you line per held review ({kind, text, url} is GET /_claude/needs' contract).
export const reviewNeeds = (reviews) => held(reviews).map((c) => ({
  kind: 'Review', title: `PR #${c.number} ${c.title}`, text: `PR #${c.number} ${c.title} · review held for you`, url: `#review=${c.number}`, review: c.number,
}));
// One push per held review (domain.mjs ownerActions' shape).
export const reviewActions = (reviews) => held(reviews).map((c) => ({
  tag: `review-${c.number}`, kind: 'review', title: `PR #${c.number}: review held for you`, body: String(c.text || c.title).split('\n')[0],
  url: `#review=${c.number}`, questions: [],
}));
