import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withFileLock } from './locks.mjs';

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
  return { date: `${parts.year}-${parts.month}-${parts.day}`, morning: !['Sat', 'Sun'].includes(parts.weekday) && Number(parts.hour) >= 9 };
}
