// Pending prompts: a permission prompt or an AskUserQuestion from a background board session, which its
// PermissionRequest hook (permission-hook.mjs) hands to the hub and the owner answers in that board's Needs you
// (docs/adr/0060-background-sessions-prompts-come-to-the-phone.md). The hub is the only writer of
// ~/.claude/web-ts/prompts.json {prompts: {<id>: record}}; a board server reads its own route's from it.
// A record: {id, session, route (null when no board's owner is that session), title (the board's, else the cwd),
// cwd, tool, action, detail, rule, questions, at, deadline, seen, answer: null | {choice, answers?, message?, at}}.
// seen is the hook's last poll; a record whose hook stopped polling, or whose answer it never fetched, expires (expired).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

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
  if (FILE_TOOLS[tool]) return `${FILE_TOOLS[tool]} ${path.basename(fileOf(input)) || 'a file'}`;
  if (tool === 'WebFetch') return `fetch ${hostOf(input.url)}`;
  if (tool === 'WebSearch') return `search the web for "${cut(input.query, 50)}"`;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool || '');
  if (mcp) return `use ${mcp[1]} ${mcp[2]}`;
  return `use ${tool}`;
}

// The full command, path, URL or query the line shows.
function detailOf(tool, input = {}) {
  if (tool === 'Bash') return String(input.command ?? '');
  if (FILE_TOOLS[tool]) return fileOf(input);
  if (tool === 'WebFetch') return String(input.url ?? '');
  if (tool === 'WebSearch') return String(input.query ?? '');
  const json = JSON.stringify(input);
  return json === '{}' ? '' : cut(json, 600);
}

// Always allow's rules: the prompt's own addRules suggestions, else one rule for this exact tool and input. Every one
// lasts only for the session (owner, `always-scope`): a suggestion's localSettings would write the board's repo, and
// a setMode suggestion would take the session out of auto mode, so neither passes.
export function alwaysRules(input) {
  const suggested = (Array.isArray(input?.permission_suggestions) ? input.permission_suggestions : [])
    .filter((s) => s?.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules) && s.rules.length)
    .map((s) => ({ type: 'addRules', rules: s.rules, behavior: 'allow', destination: 'session' }));
  if (suggested.length) return suggested;
  const tool = input?.tool_name;
  const ti = input?.tool_input || {};
  // Claude Code's path rules read `//path` as absolute from the filesystem root.
  const content = tool === 'Bash' && ti.command ? ti.command
    : FILE_TOOLS[tool] && fileOf(ti).startsWith('/') ? `/${fileOf(ti)}`
      : tool === 'WebFetch' && ti.url ? `domain:${hostOf(ti.url)}` : null;
  return [{ type: 'addRules', rules: [content ? { toolName: tool, ruleContent: content } : { toolName: tool }], behavior: 'allow', destination: 'session' }];
}

const ruleText = (rules) => rules.flatMap((r) => r.rules).map((x) => (x.ruleContent ? `${x.toolName}(${x.ruleContent})` : x.toolName)).join(', ');

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

// A new record for a PermissionRequest hook's input. board: {route, title} of the board whose owner is the
// session, or null.
export function promptRecord(input, { board, now = new Date() }) {
  const tool = String(input.tool_name);
  const asking = tool === ASK;
  const at = now.toISOString();
  return {
    id: 'p' + crypto.randomBytes(6).toString('hex'), session: String(input.session_id || ''), route: board?.route || null,
    title: board?.title || tilde(input.cwd) || 'A background session', cwd: String(input.cwd || ''), tool,
    action: asking ? null : actionOf(tool, input.tool_input), detail: asking ? '' : detailOf(tool, input.tool_input),
    rule: asking ? null : ruleText(alwaysRules(input)), questions: asking ? questionsOf(input.tool_input) : null,
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
      const picked = String(answers[q.question] ?? '').split(q.multiSelect ? ', ' : '\0').filter(Boolean);
      if (!picked.length) return { error: `Pick an answer to "${q.question}".` };
      if (!picked.every((l) => q.options.some((o) => o.label === l))) return { error: `"${answers[q.question]}" isn't an option of "${q.question}".` };
    }
    return { answer: { choice: 'allow', answers: Object.fromEntries(record.questions.map((q) => [q.question, String(answers[q.question])])), at } };
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
    return { prompts: s?.prompts && typeof s.prompts === 'object' ? s.prompts : {} };
  } catch { return { prompts: {} }; }
}

export function savePrompts(store) {
  const tmp = `${PROMPTS}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(PROMPTS), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
  fs.renameSync(tmp, PROMPTS);
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
