// Rules: the owner's standing instructions to the sessions that own boards
// (docs/adr/0039-rules-live-on-settings-at-hub-and-board-level.md). A rule is {id, text, by, at}; by is "owner", or
// "claude" when Claude codified it on the owner's word. Hub rules are `rules` in ~/.claude/web-ts/settings.json and
// apply to every board; a board's own are `rules` in its board.json. bin/wait-events.mjs prints both after each event.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSettingsFile, writeSettingsFile } from './push.mjs';

export const RULE_BY = ['owner', 'claude'];
export const RULE_MAX = 400;
export const RULES_MAX = 50;

export class RuleError extends Error {
  status = 400;
}
const fail = (msg) => { throw new RuleError(msg); };

// A rule is one line, since the watcher prints each as `rule <scope> <text>`.
export function ruleText(v, name = 'a rule') {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!t) fail(`${name} must be non-empty text`);
  if (t.length > RULE_MAX) fail(`${name} has ${t.length} characters; a rule takes at most ${RULE_MAX}`);
  return t;
}

const isRule = (r) => typeof r?.id === 'string' && typeof r.text === 'string' && r.text.trim() !== '';
// The rules a settings.json or board.json holds; a hand-edited entry without an id or text is skipped.
export const rulesOf = (config) => (Array.isArray(config?.rules) ? config.rules.filter(isRule) : []);

const newId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const ruleId = (v) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : fail(`a rule id is letters, digits, "_" and "-", not "${v}"`));
const room = (list, more = 1) => (list.length + more <= RULES_MAX ? list : fail(`a list takes at most ${RULES_MAX} rules`));

export function addRule(list, { text, by = 'owner' }, now = new Date()) {
  if (!RULE_BY.includes(by)) fail(`--by takes ${RULE_BY.join(' or ')}`);
  const rule = { id: newId(), text: ruleText(text, '--text'), by, at: now.toISOString() };
  return { rules: [...room(list), rule], rule };
}

// An edit keeps the rule's author: "Added by Claude" stays true of a rule the owner reworded.
export function editRule(list, id, text, now = new Date()) {
  const old = list.find((r) => r.id === ruleId(id)) || fail(`no rule "${id}"`);
  const rule = { ...old, text: ruleText(text, '--text'), at: now.toISOString() };
  return { rules: list.map((r) => (r === old ? rule : r)), rule };
}

export function removeRule(list, id) {
  const old = list.find((r) => r.id === ruleId(id)) || fail(`no rule "${id}"`);
  return { rules: list.filter((r) => r !== old), rule: old };
}

// A Settings page's save: `incoming` is the list it shows, [{id?, text}] in order, and `base` the ids it loaded. A
// rule keeps its id, author and time unless its text changed; one without a known id is the owner's new rule. A
// rule added elsewhere since the page loaded (not in base) stays, after the page's.
// → {rules, changes: {added: [text], edited: [{from, to}], removed: [text]}}
export function applyRules(list, incoming, base = [], now = new Date()) {
  if (!Array.isArray(incoming)) fail('rules must be a JSON array');
  if (!Array.isArray(base) || base.some((id) => typeof id !== 'string')) fail('base must be a JSON array of rule ids');
  const known = new Map(list.map((r) => [r.id, r]));
  const changes = { added: [], edited: [], removed: [] };
  const kept = new Set();
  const rules = incoming.map((r, i) => {
    if (!r || typeof r !== 'object' || Object.keys(r).some((k) => k !== 'id' && k !== 'text')) fail(`rules[${i}] takes only id and text`);
    const text = ruleText(r.text, `rules[${i}].text`);
    const old = r.id === undefined ? null : known.get(ruleId(r.id));
    if (!old || kept.has(old.id)) {
      changes.added.push(text);
      return { id: newId() + i.toString(36), text, by: 'owner', at: now.toISOString() };
    }
    kept.add(old.id);
    if (old.text === text) return old;
    changes.edited.push({ from: old.text, to: text });
    return { ...old, text, at: now.toISOString() };
  });
  const loaded = new Set(base);
  for (const r of list) {
    if (kept.has(r.id)) continue;
    if (loaded.has(r.id)) changes.removed.push(r.text);
    else rules.push(r);
  }
  return { rules: room(rules, 0), changes };
}

export const changed = (c) => Boolean(c.added.length || c.edited.length || c.removed.length);

export const readHubRules = () => rulesOf(readSettingsFile());
// Rewrites `rules` alone; every other key of settings.json stays as it is on disk now. readSettingsFile reads a
// broken file as {}, so one that doesn't parse is refused rather than replaced.
export function writeHubRules(rules) {
  const file = path.join(os.homedir(), '.claude', 'web-ts', 'settings.json');
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch {}
  if (raw !== null) { try { JSON.parse(raw); } catch { fail(`${file} is not valid JSON; fix it before changing the hub rules`); } }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeSettingsFile({ ...readSettingsFile(), rules });
}

// The watcher's lines, without its `rule ` lead: `<scope> <text>` for each hub rule, then each board rule. A
// hand-edited rule with line breaks still prints as one line.
const flat = (t) => t.replace(/\s+/g, ' ').trim();
export const ruleLines = (hub, board) => [...hub.map((r) => `hub ${flat(r.text)}`), ...board.map((r) => `board ${flat(r.text)}`)];
