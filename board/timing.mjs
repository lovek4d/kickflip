// docs/adr/2026-11-17-0600-report-timing-splits-a-tasks-life-by-who-it-waited-on.md
// board.mjs report timing: who each task waited on, worked out from the thread lines and events the board already
// stores. A task's life, from created to closed_at (or now), is cut at each moment that changes whose turn it is, and
// each piece gets one label: a builder's or planner's run over a hold or block over whose turn it is.
import { ITEM_EVENTS } from './domain.mjs';

// Status lines without a run belong to one span while each comes within this of the last (builders report every 10 minutes).
export const RUN_GAP = 10 * 60000;
// The four waits the summary reports, with idle, the time nobody owed the task a step, making up the rest of its life.
export const WAITS = ['you', 'orchestrator', 'builder', 'held'];
const BUCKET = { you: 'you', orchestrator: 'orchestrator', builder: 'builder', planner: 'builder', held: 'held', blocked: 'held', queued: 'held', idle: 'idle' };
const WAIT_WORDS = { you: 'on you', orchestrator: 'on the orchestrator', builder: 'on a builder or planner', held: 'held or queued', idle: 'idle' };
const LABEL_WORDS = { you: 'on you', orchestrator: 'on the orchestrator', builder: 'builder run', planner: 'planner run', held: 'held', blocked: 'blocked', queued: 'queued', idle: 'idle' };
// The orchestrator's hub lines that put a question to the owner.
const ASKS_OWNER = ['questions-added', 'new-question'];

// A span of ms as whole minutes: "40m", "2h", "26h 5m".
export const spanWords = (ms) => {
  const minutes = Math.floor(ms / 60000);
  const h = Math.floor(minutes / 60);
  return h ? `${h}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
};

// What a thread line or event does to the task's state: {turn} sets whose turn it is ('you', 'orchestrator', 'queued',
// 'idle'), or {endsOrchestrator} ends an orchestrator turn without handing it to the owner; hold and block start (true)
// or end (false) a pause; null changes nothing. Builder status lines are runs, read apart.
function effectOf(m, key, questions) {
  if ('who' in m) {
    const hold = m.command === 'hold' ? { hold: true } : m.command === 'resume' ? { hold: false } : null;
    if (m.who === 'love') return { turn: 'orchestrator', ...hold };
    if (m.who !== 'claude' || m.kind === 'status' || m.kind === 'move') return null;
    if (hold) return hold;
    if (m.kind === 'hub') return ASKS_OWNER.includes(m.line) ? { turn: 'you' } : m.line === 'paused' ? { hold: true } : m.line === 'resumed' ? { hold: false }
      : m.line === 'builder-told' ? { endsOrchestrator: true } : null;
    if (m.command === 'readied') return { turn: 'queued' };
    if (m.command === 'blocked-by') return { block: true };
    if (m.command) return { endsOrchestrator: true };
    return { turn: 'you' };
  }
  const d = m.data || {};
  if (m.kind === 'owner-answer') return questions.has(d.id) ? { turn: 'orchestrator' } : null;
  if (m.kind === 'orchestrator-waits') return (d.added || []).includes(key) || (d.opened || []).some((w) => w.key === key) ? { turn: 'orchestrator' } : null;
  if (d.key !== key) return null;
  if (ITEM_EVENTS.includes(m.kind) || m.kind === 'card-done') return { turn: 'orchestrator' };
  if (m.kind === 'card-hold') return { hold: Boolean(d.hold) };
  if (m.kind === 'card-unblocked') return { block: false };
  return null;
}

// A card's runs from its thread's status lines: [{from, to, planner}] in ms. A line with a run spans from the run's
// start to its last line; lines without one cluster while each comes within RUN_GAP of the last.
function runsOf(lines) {
  const status = lines.filter((m) => m.kind === 'status');
  const byRun = new Map();
  for (const m of status.filter((s) => s.run)) {
    const run = byRun.get(m.run) || { from: Date.parse(m.run), to: Date.parse(m.run), planner: false };
    run.to = Math.max(run.to, Date.parse(m.ts));
    run.planner ||= Boolean(m.planner);
    byRun.set(m.run, run);
  }
  const loose = [];
  for (const t of status.filter((s) => !s.run).map((s) => Date.parse(s.ts)).sort((a, b) => a - b)) {
    const last = loose.at(-1);
    if (last && t - last.to <= RUN_GAP) last.to = t; else loose.push({ from: t, to: t, planner: false });
  }
  return [...byRun.values(), ...loose];
}

// One task's timing. item is its stored item ({id, title, created, lane, closed_at}), lines its thread, events the
// board's event log, questions the ids of the questions asked on it, now the time an open task counts to.
// → {key, ref, title, created, closed, built, spans: [{label, from, to}], totals: {you, orchestrator, builder, held,
// idle} in ms, gaps: [text]}: closed is closed_at for a task in Done, else null; built is whether a builder (not only
// a planner) ran on it; spans merge neighbours of one label and drop the empty.
export function cardTiming({ key, item, lines, events, questions, now }) {
  const start = Date.parse(item.created);
  const closed = item.lane === 'done' && item.closed_at ? item.closed_at : null;
  const end = closed ? Date.parse(closed) : now.getTime();
  const runs = runsOf(lines);
  const moments = [...lines, ...events]
    .map((m) => ({ t: Date.parse(m.ts), effect: effectOf(m, key, questions) }))
    .filter((m) => m.effect && m.t < end)
    .sort((a, b) => a.t - b.t);
  const cuts = [...new Set([start, end, ...moments.map((m) => m.t), ...runs.flatMap((r) => [r.from, r.to])])]
    .filter((t) => t >= start && t <= end).sort((a, b) => a - b);
  let turn = 'idle', held = false, blocked = false, next = 0;
  const spans = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i];
    for (; next < moments.length && moments[next].t <= from; next++) {
      const e = moments[next].effect;
      if (e.turn) turn = e.turn;
      if (e.endsOrchestrator && turn === 'orchestrator') turn = 'idle';
      if (e.hold !== undefined) held = e.hold;
      if (e.block !== undefined) blocked = e.block;
    }
    const run = runs.find((r) => r.from <= from && from < r.to);
    // A run's start ends the wait for it, and the orchestrator's turn that sent it.
    if (run?.from === from && (turn === 'queued' || turn === 'orchestrator')) turn = 'idle';
    const label = run ? (run.planner ? 'planner' : 'builder') : held ? 'held' : blocked ? 'blocked' : turn;
    const last = spans.at(-1);
    if (last?.label === label) last.to = cuts[i + 1]; else spans.push({ label, from, to: cuts[i + 1] });
  }
  const totals = Object.fromEntries([...WAITS, 'idle'].map((w) => [w, 0]));
  for (const s of spans) totals[BUCKET[s.label]] += s.to - s.from;
  return {
    key, ref: item.id, title: item.title, created: item.created, closed, built: runs.some((r) => !r.planner),
    spans: spans.map((s) => ({ label: s.label, from: new Date(s.from).toISOString(), to: new Date(s.to).toISOString() })),
    totals, gaps: lines.length ? [] : ['no thread lines: only its events time it'],
  };
}

const totalsWords = (totals) => [...WAITS, 'idle'].map((w) => `${WAIT_WORDS[w]} ${spanWords(totals[w])}`).join(' · ');
// The lines board.mjs report timing <task> prints: the task and its life, its totals, each span a minute or longer
// (the totals count the shorter ones too), then any gap.
export function cardTimingLines(t) {
  const life = spanWords((t.closed ? Date.parse(t.closed) : Date.parse(t.spans.at(-1)?.to ?? t.created)) - Date.parse(t.created));
  return [
    `${t.ref} ${t.title}: ${t.closed ? `closed ${t.closed}, ${life} after it was filed` : `open, ${life} so far`}`,
    totalsWords(t.totals),
    ...t.spans.filter((s) => Date.parse(s.to) - Date.parse(s.from) >= 60000)
      .map((s) => `${s.from} ${LABEL_WORDS[s.label]} ${spanWords(Date.parse(s.to) - Date.parse(s.from))}`),
    ...t.gaps.map((g) => `gap: ${g}`),
  ];
}

const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// The median and the slowest quarter's edge (the 75th percentile, nearest rank) of a list of ms.
function spread(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return { median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2, quarter: s[Math.ceil(s.length * 0.75) - 1] };
}
// The day summary of cardTiming results: the tasks closed at or after from (ms, null for all), by the host's local
// day they closed, oldest first. → [{day, closed, built: {count, waits}, unbuilt: {count, waits}}], waits holding
// each of WAITS's spread over that group's tasks, or null for an empty group.
export function timingDays(cards, { from = null } = {}) {
  const byDay = new Map();
  for (const c of cards.filter((x) => x.closed && (from === null || Date.parse(x.closed) >= from))) {
    const day = localDay(Date.parse(c.closed));
    byDay.set(day, [...(byDay.get(day) || []), c]);
  }
  const group = (list) => ({ count: list.length, waits: list.length ? Object.fromEntries(WAITS.map((w) => [w, spread(list.map((c) => c.totals[w]))])) : null });
  return [...byDay.keys()].sort().map((day) => {
    const list = byDay.get(day);
    return { day, closed: list.length, built: group(list.filter((c) => c.built)), unbuilt: group(list.filter((c) => !c.built)) };
  });
}
// The lines board.mjs report timing prints for timingDays: each day's count, then a line per group with tasks.
export function timingDaysLines(days) {
  if (!days.length) return ['no tasks closed'];
  const waits = (g) => WAITS.map((w, i) => `${WAIT_WORDS[w]} ${spanWords(g.waits[w].median)}${i ? ', ' : ' median, '}${spanWords(g.waits[w].quarter)}${i ? '' : ' slowest quarter'}`).join(' · ');
  return days.flatMap((d) => [
    `${d.day}: ${d.closed} closed, ${d.built.count} with a builder`,
    ...(d.built.count ? [`  with a builder: ${waits(d.built)}`] : []),
    ...(d.unbuilt.count ? [`  without: ${waits(d.unbuilt)}`] : []),
  ]);
}
