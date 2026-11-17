import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withFileLock } from './locks.mjs';
import { readSecret, writeSecret } from './secrets.mjs';

const fields = ['self_dm', 'owner_slack_user', 'slack_domain', 'timezone'];
const fileOf = () => path.join(os.homedir(), '.claude', 'kickflip', 'slack.json');
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } };
const identityOf = (value) => Object.fromEntries(fields.map((key) => [key, typeof value?.[key] === 'string' ? value[key] : '']));
function save(value) {
  const file = fileOf();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return value;
}

export function readSlack() {
  const saved = identityOf(read(fileOf()));
  if (fields.some((key) => saved[key])) return saved;
  const bridge = identityOf(read(path.join(os.homedir(), '.claude', 'slack-bridge', 'state.json')).config);
  return fields.some((key) => bridge[key]) ? save(bridge) : saved;
}

export async function setSlack(changes) {
  for (const [key, value] of Object.entries(changes)) {
    if (!fields.includes(key) || typeof value !== 'string') throw new Error(`Unknown Slack setting ${key}`);
    if (key === 'self_dm' && value && !/^D[A-Z0-9]+$/.test(value)) throw new Error('self-dm must be a DM channel id');
    if (key === 'owner_slack_user' && value && !/^U[A-Z0-9]+$/.test(value)) throw new Error('user must be a Slack user id');
    if (key === 'slack_domain' && value && !/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new Error('domain must be a Slack workspace domain');
    if (key === 'timezone' && value) {
      try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { throw new Error('timezone must be an IANA timezone such as Area/City'); }
    }
  }
  return withFileLock(fileOf(), () => save({ ...readSlack(), ...changes }));
}

// now's day in the Slack timezone: its date, and open on a weekday from 09:00 to the day's end, when the digest is due.
export function slackDay(now = new Date()) {
  const parts = slackParts(now);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, open: !['Sat', 'Sun'].includes(parts.weekday) && Number(parts.hour) >= 9 };
}
// now's 24-hour time in the Slack timezone, “HH:MM”.
export function slackClock(now = new Date()) {
  const parts = slackParts(now);
  return `${parts.hour}:${parts.minute}`;
}
function slackParts(now) {
  const timezone = readSlack().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
}

// Slack through the owner's user token (docs/adr/2026-11-05-0141-the-hub-sends-reviewer-slack-messages-with-its-own-token.md):
// the hub sends as the owner, in the owner's DMs with each reviewer. The token lives in secrets.json's `slack`
// {token, team, team_id, user, user_id, saved_at}, plus refused_at once Slack refused it and refusal_pushed_at once
// the owner's phone was told, and unheard_at and unheard_pushed_at the same way for reads it can't make (setHearing);
// only slackStatus's {set, refused, unheard, team, user} leaves this module for a page. Every call goes to KICKFLIP_SLACK_URL when it is set, else
// Slack's Web API, through the fetch passed in.
export class SlackError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

const api = () => process.env.KICKFLIP_SLACK_URL || 'https://slack.com/api';
// Slack reads these methods' arguments from form encoding or the query string and ignores a JSON body; every other
// method takes JSON.
const READS = ['users.list', 'emoji.list', 'search.messages', 'conversations.history', 'conversations.replies'];
const REFUSED = ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'];

// The last line of every message the hub or the orchestrator posts: the kickflip emoji, or 🤖 while the workspace lacks
// it, followed on a message the hub edited by “ · _updated HH:MM_”, the edit's time. A message with attachments, such as
// a PR's link, ends its last attachment with it, under what the bar holds
// (docs/adr/2026-11-14-0451-a-prs-slack-link-is-a-bar-coloured-by-the-builders-risk.md).
const SIGN_OFF = '- :claude_kickflip:';
const SIGN_OFF_FALLBACK = '- :robot_face:';
const SIGNED_OFF = /^- :(claude_kickflip|robot_face):( · _updated \d\d:\d\d_)?$/;
// Whether a message is one of ours, by the last line of its text or, with attachments, of its last attachment's; our
// posts go out as the owner, so the hub hears past them by this.
export const isSignedOff = (text, attachments = []) => SIGNED_OFF.test(String((attachments.length ? attachments.at(-1).text : text) || '').split('\n').at(-1));

// checked(works) follows each answer: false when Slack refused the token, true when it answered ok.
export function slackClient(token, { fetch = globalThis.fetch, checked = () => {} } = {}) {
  async function call(method, body = {}) {
    let out;
    try {
      const form = READS.includes(method);
      const r = await fetch(`${api()}/${method}`, {
        method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
        body: form ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString() : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
      out = await r.json().catch(() => null);
      if (!out) throw new Error(`Slack answered ${r.status}`);
    } catch (e) { throw new SlackError(`Could not reach Slack: ${e.message}`); }
    if (REFUSED.includes(out.error)) { checked(false); throw new SlackError('Slack refused the token.', 400); }
    checked(true);
    if (!out.ok) throw new SlackError(`Slack: ${out.error}`);
    return out;
  }
  // Whether the workspace has :claude_kickflip:, asked once per client; no emoji:read scope or any failure reads as no.
  let signOff;
  // A message's {text, attachments?} with the sign-off line ended on, the last attachment's text taking it when there
  // are attachments; edited: an edit's time, which the line then names.
  const signedOff = async ({ text, attachments }, edited) => {
    signOff ??= call('emoji.list').then((out) => (out.emoji?.claude_kickflip ? SIGN_OFF : SIGN_OFF_FALLBACK), () => SIGN_OFF_FALLBACK);
    const line = `${await signOff}${edited ? ` · _updated ${slackClock(edited)}_` : ''}`;
    const end = (words) => (words ? `${words}\n${line}` : line);
    if (!attachments?.length) return { text: end(text) };
    const last = attachments.at(-1);
    return { text, attachments: [...attachments.slice(0, -1), { ...last, text: end(last.text), mrkdwn_in: ['text'] }] };
  };
  async function members() {
    const out = [];
    let cursor = '';
    do {
      const page = await call('users.list', { limit: 200, ...(cursor ? { cursor } : {}) });
      out.push(...page.members);
      cursor = page.response_metadata?.next_cursor || '';
    } while (cursor);
    return out;
  }
  return {
    async who() {
      const { team, team_id, user, user_id } = await call('auth.test');
      return { team, team_id, user, user_id };
    },
    // The workspace's people who can be messaged: [{id, name}] by name. Needs the users:read scope.
    async people() {
      const out = (await members()).filter((m) => !m.deleted && !m.is_bot && m.id !== 'USLACKBOT').map((m) => ({ id: m.id, name: m.profile?.real_name || m.real_name || m.name }));
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    // The id of the workspace's bot user named kickflip (an @Kickflip a person can pick), or undefined without one.
    // Needs the users:read scope.
    async botId() {
      return (await members()).find((m) => m.is_bot && !m.deleted && [m.name, m.real_name, m.profile?.real_name].some((n) => /^kickflip$/i.test(n || '')))?.id;
    },
    // The owner's DM with a user → its channel id
    openDM: async (user) => (await call('conversations.open', { users: user })).channel.id,
    // Every message ends with the sign-off line: its text's last line, or with attachments, Slack's colour-barred
    // blocks, the last attachment's. → the message ts
    post: async ({ channel, text, thread_ts, attachments }) => (await call('chat.postMessage', { channel, ...await signedOff({ text, attachments }), unfurl_links: false, ...(thread_ts ? { thread_ts } : {}) })).ts,
    // Edits a message this token posted, signed off as a post is and named updated at at's time.
    update: async ({ channel, ts, text, attachments, at = new Date() }) => { await call('chat.update', { channel, ts, ...await signedOff({ text, attachments }, at), unfurl_links: false }); },
    // A reaction already there counts as added.
    async react({ channel, ts, name }) {
      try { await call('reactions.add', { channel, timestamp: ts, name }); } catch (e) { if (e.message !== 'Slack: already_reacted') throw e; }
    },
    // The DM's top-level messages from oldest on, each with latest_reply once it has replies. Needs im:history.
    history: ({ channel, oldest }) => pages('conversations.history', { channel, oldest, inclusive: true }),
    // A thread's opener, then its replies after oldest when given, else all of them. Needs im:history.
    replies: ({ channel, ts, oldest }) => pages('conversations.replies', { channel, ts, ...(oldest ? { oldest } : {}) }),
    // The newest count messages holding query, in every conversation the owner can read, newest first, each with its
    // channel {id, is_im, is_mpim} and permalink. Needs search:read.
    search: async ({ query, count = 100 }) => (await call('search.messages', { query, count, sort: 'timestamp', sort_dir: 'desc' })).messages.matches,
  };
  async function pages(method, body) {
    const out = [];
    let cursor = '';
    do {
      const page = await call(method, { ...body, limit: 200, ...(cursor ? { cursor } : {}) });
      out.push(...page.messages);
      cursor = page.response_metadata?.next_cursor || '';
    } while (cursor);
    return out;
  }
}
// Whether Slack answered a read with missing_scope, as it does for a token without im:history.
export const missingScope = (e) => e.message === 'Slack: missing_scope';

const savedToken = (home) => { const s = readSecret('slack', home); return typeof s?.token === 'string' && s.token ? s : null; };

export function slackStatus(home) {
  const saved = savedToken(home);
  if (!saved) return { set: false };
  return { set: true, ...(saved.refused_at ? { refused: true } : {}), ...(saved.unheard_at ? { unheard: true } : {}), ...(saved.unsearched_at ? { unsearched: true } : {}), ...(saved.team ? { team: saved.team, user: saved.user } : {}) };
}
// The owner's Slack user id, whose messages in a day thread are the owner's, as auth.test named it when the token was saved.
export const slackUserId = () => savedToken()?.user_id;
export const SLACK_NEEDS_TOKEN = 'Slack needs Hub’s Slack token; add it in Hub › Integrations › Slack first.';

// Checks the token with auth.test and saves it, as refused when Slack refuses it. Any other failure saves nothing.
// Only a user token (xoxp-) sends as the owner in the owner's DMs. → slackStatus()
export async function saveSlackToken(token, { fetch } = {}) {
  const t = typeof token === 'string' ? token.trim() : '';
  if (!/^xoxp-[\w-]{10,250}$/.test(t)) throw new SlackError('Paste a Slack user token, which starts with xoxp-.', 400);
  const now = new Date().toISOString();
  let refused = false;
  const who = await slackClient(t, { fetch, checked: (works) => { refused = !works; } }).who().catch((e) => { if (!refused) throw e; return null; });
  writeSecret('slack', who ? { token: t, ...who, saved_at: now } : { token: t, saved_at: now, refused_at: now });
  return slackStatus();
}

export function removeSlackToken() {
  writeSecret('slack', null);
  return slackStatus();
}

// Remembers whether Slack refused the saved token, from the newest answer to a call with it.
function markChecked(token, works) {
  const saved = savedToken();
  if (saved?.token !== token || Boolean(saved.refused_at) === !works) return;
  const { refused_at: _, refusal_pushed_at: __, ...rest } = saved;
  writeSecret('slack', works ? rest : { ...rest, refused_at: new Date().toISOString() });
}

// Whether Slack's refusal of the saved token is yet to be pushed to the owner; markRefusalPushed records the push.
export const refusalUnpushed = () => { const s = savedToken(); return Boolean(s?.refused_at && !s.refusal_pushed_at); };
export function markRefusalPushed() {
  const saved = savedToken();
  if (saved?.refused_at) writeSecret('slack', { ...saved, refusal_pushed_at: new Date().toISOString() });
}

// docs/adr/2026-11-12-0000-reviewers-ask-the-board-in-the-day-thread.md: whether the saved token can read the day
// threads, from the newest read with it; unheard_at once Slack answered missing_scope, and unheard_pushed_at once the
// owner's phone was told.
export function setHearing(works) {
  const saved = savedToken();
  if (!saved || Boolean(saved.unheard_at) === !works) return;
  const { unheard_at: _, unheard_pushed_at: __, ...rest } = saved;
  writeSecret('slack', works ? rest : { ...rest, unheard_at: new Date().toISOString() });
}
// docs/adr/2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md: whether the saved token can
// search for @kickflip DMs, from the newest search with it; unsearched_at once Slack answered missing_scope.
export function setSearching(works) {
  const saved = savedToken();
  if (!saved || Boolean(saved.unsearched_at) === !works) return;
  const { unsearched_at: _, ...rest } = saved;
  writeSecret('slack', works ? rest : { ...rest, unsearched_at: new Date().toISOString() });
}
export const hearingUnpushed = () => { const s = savedToken(); return Boolean(s?.unheard_at && !s.unheard_pushed_at); };
export function markHearingPushed() {
  const saved = savedToken();
  if (saved?.unheard_at) writeSecret('slack', { ...saved, unheard_pushed_at: new Date().toISOString() });
}

// A client over the saved token, or null when none is saved. Its calls keep the token's refused_at up to date.
export function savedSlack({ fetch } = {}) {
  const saved = savedToken();
  return saved ? slackClient(saved.token, { fetch, checked: (works) => markChecked(saved.token, works) }) : null;
}
