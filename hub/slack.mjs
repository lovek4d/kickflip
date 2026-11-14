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

export function slackDay(now = new Date()) {
  const timezone = readSlack().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  // open: a weekday from 09:00 until 17:00, when a digest may go out
  return { date: `${parts.year}-${parts.month}-${parts.day}`, open: !['Sat', 'Sun'].includes(parts.weekday) && Number(parts.hour) >= 9 && Number(parts.hour) < 17 };
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
const REFUSED = ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'];

// The last line of every message the hub or the orchestrator posts: the kickflip emoji, or 🤖 while the workspace lacks it.
const SIGN_OFF = '- :claude_kickflip:';
const SIGN_OFF_FALLBACK = '- :robot_face:';
// Whether text is one of ours, by its last line; our posts go out as the owner, so the hub hears past them by this.
export const isSignedOff = (text) => [SIGN_OFF, SIGN_OFF_FALLBACK].includes(String(text || '').split('\n').at(-1));

// checked(works) follows each answer: false when Slack refused the token, true when it answered ok.
export function slackClient(token, { fetch = globalThis.fetch, checked = () => {} } = {}) {
  async function call(method, body = {}) {
    let out;
    try {
      const r = await fetch(`${api()}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
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
  const signedOff = (text) => {
    signOff ??= call('emoji.list').then((out) => (out.emoji?.claude_kickflip ? SIGN_OFF : SIGN_OFF_FALLBACK), () => SIGN_OFF_FALLBACK);
    return signOff.then((line) => `${text}\n${line}`);
  };
  return {
    async who() {
      const { team, team_id, user, user_id } = await call('auth.test');
      return { team, team_id, user, user_id };
    },
    // The workspace's people who can be messaged: [{id, name}] by name. Needs the users:read scope.
    async people() {
      const out = [];
      let cursor = '';
      do {
        const page = await call('users.list', { limit: 200, ...(cursor ? { cursor } : {}) });
        for (const m of page.members) if (!m.deleted && !m.is_bot && m.id !== 'USLACKBOT') out.push({ id: m.id, name: m.profile?.real_name || m.real_name || m.name });
        cursor = page.response_metadata?.next_cursor || '';
      } while (cursor);
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    // The owner's DM with a user → its channel id
    openDM: async (user) => (await call('conversations.open', { users: user })).channel.id,
    // Every message ends with the sign-off line. → the message ts
    post: async ({ channel, text, thread_ts }) => (await call('chat.postMessage', { channel, text: await signedOff(text), unfurl_links: false, ...(thread_ts ? { thread_ts } : {}) })).ts,
    // Edits a message this token posted, signed off as a post is.
    update: async ({ channel, ts, text }) => { await call('chat.update', { channel, ts, text: await signedOff(text), unfurl_links: false }); },
    // A reaction already there counts as added.
    async react({ channel, ts, name }) {
      try { await call('reactions.add', { channel, timestamp: ts, name }); } catch (e) { if (e.message !== 'Slack: already_reacted') throw e; }
    },
    // The DM's top-level messages from oldest on, each with latest_reply once it has replies. Needs im:history.
    history: ({ channel, oldest }) => pages('conversations.history', { channel, oldest, inclusive: true }),
    // A thread's opener, then its replies after oldest when given, else all of them. Needs im:history.
    replies: ({ channel, ts, oldest }) => pages('conversations.replies', { channel, ts, ...(oldest ? { oldest } : {}) }),
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
  return { set: true, ...(saved.refused_at ? { refused: true } : {}), ...(saved.unheard_at ? { unheard: true } : {}), ...(saved.team ? { team: saved.team, user: saved.user } : {}) };
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
