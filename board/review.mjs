import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { routeRecord } from '../hub/routes.mjs';
import { prKeyOf, storedPRs } from '../shared/card-prs.mjs';

export function topicItems() {
  const dir = path.join(os.homedir(), '.claude', 'slack-bridge', 'topics');
  const items = Object.create(null);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch {}
  for (const file of files) {
    try {
      const topic = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const [key, item] of Object.entries(topic.items || {})) items[key] = { ...items[key], ...item };
    } catch {}
  }
  return items;
}

// Each reviewer's first posted link among a card's PRs, from data/pr-slack.json (board/store.mjs) and the card's
// [{repo, number}]. → {<reviewer>: {ts, channel}}
export function prLinks(record = {}, prs = []) {
  const links = {};
  for (const p of prs) {
    for (const [name, link] of Object.entries(routeRecord(record, prKeyOf(p))?.links || {})) {
      if (link.ts && !(Number(links[name]?.ts) <= Number(link.ts))) links[name] = { ts: link.ts, channel: link.channel };
    }
  }
  return links;
}

// First source wins per reviewer: the card's PR links, then the older per-card records; a legacy list records sending
// without a known time.
export function reviewLinks(itemFile, item, key, topics = {}, fromPRs = {}) {
  const links = Object.create(null);
  const sources = [fromPRs, item?.review_link_ts, item?.review_sent,
    routeRecord(itemFile?.review_link_ts, storedPRs(item)[0]?.number), routeRecord(itemFile?.review_link_ts, key),
    routeRecord(topics, key)?.review_link_ts];
  for (const source of sources) {
    for (const [name, value] of Array.isArray(source) ? source.map((name) => [name, null]) : Object.entries(source || {})) {
      if (Object.hasOwn(links, name)) continue;
      const ts = typeof value === 'string' ? value : value?.ts;
      if (value !== null && (typeof ts !== 'string' || !/^\d+(?:\.\d+)?$/.test(ts))) continue;
      links[name] = { ts: ts || null, ...(typeof value?.channel === 'string' ? { channel: value.channel } : {}) };
    }
  }
  return links;
}

export const reviewTime = (ts) => {
  const ms = ts ? Number(ts) * 1000 : NaN;
  return Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime()) ? new Date(ms).toISOString() : null;
};

export function reviewersOf(itemFile, board = []) {
  return [...new Map([...board, ...(itemFile.reviewers || [])].map((r) => [r.name, r])).values()];
}
