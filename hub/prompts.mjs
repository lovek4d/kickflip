// Pending prompts: a permission prompt or an AskUserQuestion from a background board session, which its
// PermissionRequest hook (permission-hook.mjs) hands to the hub and the owner answers in that board's Needs you
// (docs/adr/0060-background-sessions-prompts-come-to-the-phone.md). The hub and ownership commands write
// ~/.claude/web-ts/prompts.json {prompts: {<id>: record}, remembered: {<session>: {route, ownerSince, runtime, rules}}};
// a board server reads its own route's pending prompts from it.
// A record: {id, session, route (null when no board's owner is that session), title (the board's, else the cwd),
// cwd, tool, action, detail, rule, questions, at, deadline, seen, answer: null | {choice, answers?, message?, at}}.
// seen is the hook's last poll; a record whose hook stopped polling, or whose answer it never fetched, expires (expired).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { withFileLock } from './locks.mjs';
import { routeRecord } from './routes.mjs';

const PROMPTS = path.join(os.homedir(), '.claude', 'web-ts', 'prompts.json');
// How long the owner has to answer before the hook denies with a note. BG_SETTINGS's hook timeout must stay above it,
// since Claude Code leaves a timed-out hook's session on a dialog nobody sees.
export const WAIT_MS = 10 * 60_000;
// The hook polls at most this long per request, so a record not polled for GONE_AFTER has lost its hook.
export const POLL_MS = 25_000;
export const GONE_AFTER = 60_000;

export const NO_ANSWER = "No answer from the owner; ask this as an open question on your board's card instead.";
export const UNREACHABLE = "The hub can't be reached, so the owner can't answer this prompt; ask this as an open question on your board's card instead.";
export const DROPPED = "The hub dropped this prompt; ask this as an open question on your board's card instead.";
export const DENIED = 'The owner denied this from the hub.';
export const SKIPPED = "The owner skipped this question; ask it as an open question on your board's card instead.";

const ASK = 'AskUserQuestion';
const FILE_TOOLS = { Edit: 'edit', MultiEdit: 'edit', Write: 'write', Read: 'read', NotebookEdit: 'edit' };
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const fileOf = (input) => input?.file_path || input?.notebook_path || '';
const hostOf = (url) => { try { return new URL(url).host; } catch { return String(url || ''); } };

// "run npm test", "edit hub.mjs": what a push says the board wants to do.
export function actionOf(tool, input = {}) {
  if (tool === 'Bash') return `run ${cut(input.command, 60)}`;
  if (routeRecord(FILE_TOOLS, tool)) return `${routeRecord(FILE_TOOLS, tool)} ${path.basename(fileOf(input)) || 'a file'}`;
  if (tool === 'WebFetch') return `fetch ${hostOf(input.url)}`;
  if (tool === 'WebSearch') return `search the web for "${cut(input.query, 50)}"`;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool || '');
  if (mcp) return `use ${mcp[1]} ${mcp[2]}`;
  return `use ${tool}`;
}

// The full command, path, URL or query the line shows.
function detailOf(tool, input = {}) {
  if (tool === 'Bash') return String(input.command ?? '');
  if (routeRecord(FILE_TOOLS, tool)) return fileOf(input);
  if (tool === 'WebFetch') return String(input.url ?? '');
  if (tool === 'WebSearch') return String(input.query ?? '');
  const json = JSON.stringify(input);
  return json === '{}' ? '' : cut(json, 600);
}

// localSettings would write the board's repo, and setMode would take the session out of auto mode.
export function alwaysRules(input) {
  const suggested = (Array.isArray(input?.permission_suggestions) ? input.permission_suggestions : [])
    .filter((s) => s?.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules) && s.rules.length)
    .map((s) => ({ type: 'addRules', rules: s.rules, behavior: 'allow', destination: 'session' }));
  if (suggested.length) return suggested;
  const tool = input?.tool_name;
  const ti = input?.tool_input || {};
  // Claude Code's path rules read `//path` as absolute from the filesystem root.
  const content = tool === 'Bash' && ti.command ? ti.command
    : routeRecord(FILE_TOOLS, tool) && fileOf(ti).startsWith('/') ? `/${fileOf(ti)}`
      : tool === 'WebFetch' && ti.url ? `domain:${hostOf(ti.url)}` : null;
  return [{ type: 'addRules', rules: [content ? { toolName: tool, ruleContent: content } : { toolName: tool }], behavior: 'allow', destination: 'session' }];
}

const ruleText = (rules) => rules.flatMap((r) => r.rules).map((x) => (x.ruleContent ? `${x.toolName}(${x.ruleContent})` : x.toolName)).join(', ');

const runtimeOf = (live) => Number.isInteger(live?.pid) && live.pid > 0 && typeof live.procStart === 'string' &&
  Number.isFinite(Date.parse(`${live.procStart.trim().replace(/\s+/g, ' ')} UTC`)) ? { pid: live.pid, procStart: live.procStart } : null;
const sameRuntime = (a, b) => Boolean(runtimeOf(a) && runtimeOf(b) && a.pid === b.pid && a.procStart === b.procStart);
const ownerSince = (board) => typeof board?.owner?.since === 'string' && board.owner.since ? board.owner.since : null;
const sameOwner = (entry, board, session) => Boolean(board?.owner?.session === session && entry.ownerSince && entry.ownerSince === ownerSince(board));

export function matchesRule(rule, input) {
  const tool = input?.tool_name;
  if (tool === ASK || !rule || rule.toolName !== tool || typeof tool !== 'string') return false;
  const content = rule.ruleContent;
  if (content === undefined) return true;
  if (typeof content !== 'string' || !content) return false;
  const ti = input.tool_input || {};
  if (tool === 'Bash') return typeof ti.command === 'string' && content === ti.command;
  // Only Claude Code's filesystem-root syntax is unambiguous without interpreting cwd or globs.
  if (routeRecord(FILE_TOOLS, tool)) return content.startsWith('//') && !/[\*?\[\]{}]/.test(content) && content.slice(1) === fileOf(ti);
  if (tool === 'WebFetch') {
    try {
      const url = new URL(ti.url);
      return ['http:', 'https:'].includes(url.protocol) && content === `domain:${url.host}`;
    } catch { return false; }
  }
  return false;
}

// Process identity prevents a resumed conversation with the same session id from inheriting an ended run's rules.
export function pruneRemembered(store, { running, boards }) {
  let changed = false;
  for (const [session, entry] of Object.entries(store.remembered || {})) {
    const board = boards.find((b) => entry.route ? b.route === entry.route : b.owner?.session === session);
    if (!sameRuntime(entry.runtime, runtimeOf(running.get(session))) ||
        (entry.route && !sameOwner(entry, board, session)) || (board && !ownerSince(board))) {
      delete store.remembered[session];
      changed = true;
    } else if (entry.route === null && board) {
      entry.route = board.route;
      entry.ownerSince = ownerSince(board);
      changed = true;
    }
  }
  return changed;
}

export function rememberRules(store, record, context) {
  if (record.answer?.choice !== 'always' || record.tool === ASK || !record.session || !record.permissions) return false;
  if (!sameRuntime(record.runtime, runtimeOf(context.running.get(record.session)))) return false;
  const previous = routeRecord(store.remembered, record.session);
  const route = record.route || previous?.route;
  const board = (route && context.boards.find((b) => b.route === route)) ||
    (!record.route && context.boards.find((b) => b.owner?.session === record.session));
  if ((record.route && !sameOwner(record, board, record.session)) ||
      (board && (board.owner?.session !== record.session || !ownerSince(board)))) return false;
  store.remembered ||= {};
  const keepPrevious = previous && sameRuntime(previous.runtime, record.runtime) &&
    (previous.route ? previous.route === board?.route && sameOwner(previous, board, record.session) : true);
  const rules = keepPrevious ? [...previous.rules] : [];
  for (const rule of record.permissions.flatMap((p) => p.rules)) {
    if (!rules.some((r) => r.toolName === rule.toolName && r.ruleContent === rule.ruleContent)) rules.push(rule);
  }
  Object.defineProperty(store.remembered, record.session, { value: { route: board?.route || null, ownerSince: ownerSince(board), runtime: record.runtime, rules }, enumerable: true, writable: true, configurable: true });
  return true;
}

export function rememberedAnswer(store, input) {
  if (!input.session_id || input.tool_name === ASK || !routeRecord(store.remembered, input.session_id)) return null;
  return routeRecord(store.remembered, input.session_id).rules.some((rule) => matchesRule(rule, input)) ? { choice: 'allow' } : null;
}

export function rememberedFor(route, store = readPrompts()) {
  return Object.entries(store.remembered || {}).filter(([, entry]) => entry.route === route)
    .map(([session, entry]) => ({ session, rules: entry.rules.map((r) => ruleText([{ rules: [r] }])) }));
}

// The JSON the hook prints for the owner's answer {choice: 'allow' | 'always' | 'deny', answers?, message?}.
export function hookOutput(input, answer) {
  const decision = answer?.choice === 'deny' ? { behavior: 'deny', message: answer.message || DENIED }
    : answer?.choice === 'always' && input?.tool_name !== ASK ? { behavior: 'allow', updatedPermissions: alwaysRules(input) }
      : input?.tool_name === ASK ? { behavior: 'allow', updatedInput: { ...input.tool_input, answers: answer?.answers || {} } }
        : { behavior: 'allow' };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

const tilde = (p) => (p && p.startsWith(os.homedir() + '/') ? `~${p.slice(os.homedir().length)}` : p || '');

// The questions of an AskUserQuestion, as the line shows them: [{question, header, multiSelect, options: [{label, description}]}].
function questionsOf(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs.filter((q) => typeof q?.question === 'string').map((q) => ({
    question: q.question, header: typeof q.header === 'string' ? q.header : '', multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).filter((o) => typeof o?.label === 'string').map((o) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })),
  }));
}

// A new record for a PermissionRequest hook's input. board: {route, title, owner} of the board whose owner is the
// session, or null.
export function promptRecord(input, { board, live, now = new Date() }) {
  const tool = String(input.tool_name);
  const asking = tool === ASK;
  const permissions = asking ? null : alwaysRules(input);
  const at = now.toISOString();
  return {
    id: 'p' + crypto.randomBytes(6).toString('hex'), session: String(input.session_id || ''), route: board?.route || null,
    title: board?.title || tilde(input.cwd) || 'A background session', cwd: String(input.cwd || ''), tool,
    action: asking ? null : actionOf(tool, input.tool_input), detail: asking ? '' : detailOf(tool, input.tool_input),
    rule: asking ? null : ruleText(permissions), questions: asking ? questionsOf(input.tool_input) : null,
    permissions, runtime: runtimeOf(live), ownerSince: ownerSince(board),
    at, deadline: new Date(now.getTime() + WAIT_MS).toISOString(), seen: at, answer: null,
  };
}

// The owner's answer from the page's body, checked against the record. → {answer} | {error}
export function answerOf(record, body, now = new Date()) {
  const at = now.toISOString();
  if (record.questions) {
    if (body?.choice === 'deny') return { answer: { choice: 'deny', message: SKIPPED, at } };
    const answers = body?.answers && typeof body.answers === 'object' ? body.answers : {};
    for (const q of record.questions) {
      const picked = String(routeRecord(answers, q.question) ?? '').split(q.multiSelect ? ', ' : '\0').filter(Boolean);
      if (!picked.length) return { error: `Pick an answer to "${q.question}".` };
      if (!picked.every((l) => q.options.some((o) => o.label === l))) return { error: `"${routeRecord(answers, q.question)}" isn't an option of "${q.question}".` };
    }
    return { answer: { choice: 'allow', answers: Object.fromEntries(record.questions.map((q) => [q.question, String(routeRecord(answers, q.question))])), at } };
  }
  if (!['allow', 'always', 'deny'].includes(body?.choice)) return { error: 'Pass choice allow, always or deny.' };
  return { answer: { choice: body.choice, ...(body.choice === 'deny' ? { message: DENIED } : {}), at } };
}

// Records to drop at now: one whose hook hasn't polled for GONE_AFTER, one whose answer its hook never fetched in that
// time, and any past its deadline by that much. aliveSince is when the hub started, since a hook can't poll a hub that
// was down. → [record]
export function expired(store, { now = Date.now(), aliveSince = 0 } = {}) {
  return Object.values(store.prompts || {}).filter((r) => {
    if (now - Date.parse(r.deadline) > GONE_AFTER) return true;
    if (r.answer) return now - Date.parse(r.answer.at) > GONE_AFTER;
    return now - Math.max(Date.parse(r.seen), aliveSince) > GONE_AFTER;
  });
}

export function readPrompts() {
  try {
    const s = JSON.parse(fs.readFileSync(PROMPTS, 'utf8'));
    return { prompts: s?.prompts && typeof s.prompts === 'object' ? s.prompts : {},
      remembered: s?.remembered && typeof s.remembered === 'object' ? s.remembered : {} };
  } catch { return { prompts: {}, remembered: {} }; }
}

export function savePrompts(store) {
  const tmp = `${PROMPTS}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(PROMPTS), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
  fs.renameSync(tmp, PROMPTS);
}

export const withPromptsLock = (fn) => withFileLock(PROMPTS, fn);

export function updatePrompts(fn) {
  return withPromptsLock(() => {
    const store = readPrompts();
    const result = fn(store);
    savePrompts(store);
    return result;
  });
}

export function dropSessionPrompts(store, sessions) {
  const dropped = new Set(sessions.filter(Boolean));
  for (const session of dropped) delete store.remembered[session];
  for (const [id, record] of Object.entries(store.prompts)) {
    if (dropped.has(record.session)) delete store.prompts[id];
  }
}

// What waits on the owner: unanswered records, oldest first, for one route, or with route null for no board's.
export function pendingFor(route, store = readPrompts()) {
  return Object.values(store.prompts).filter((r) => !r.answer && r.route === route).sort((a, b) => a.at.localeCompare(b.at));
}

// The fields a page shows for one record.
export const shown = ({ id, title, cwd, tool, action, detail, rule, questions, at }) => ({ id, title, cwd: tilde(cwd), tool, action, detail, rule, questions, at });

// The push for a new record: "<board> wants to <action>", or for a question "<board> asks: <question>", opening the
// board whose Needs you shows it, or the hub page for no board's.
export function pushOf(r) {
  const q = r.questions?.[0];
  return {
    title: q ? `${r.title} asks: ${cut(q.question, 90)}` : `${r.title} wants to ${r.action}`,
    body: q ? q.options.map((o) => o.label).join(' · ') + (r.questions.length > 1 ? ` (+${r.questions.length - 1} more)` : '') : cut(r.detail, 160) || `Answer in ${r.route ? 'Needs you' : 'the hub page'}.`,
    url: r.route ? `/${r.route}/` : '/_hub/',
    tag: `prompt-${r.id}`,
  };
}
