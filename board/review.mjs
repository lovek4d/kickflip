import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { routeRecord } from '../hub/routes.mjs';
import { storedPRs } from '../shared/card-prs.mjs';

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

// First source wins per reviewer; a legacy list records sending without a known time.
export function reviewLinks(wave, item, key, topics = {}) {
  const links = Object.create(null);
  const sources = [item?.review_link_ts, item?.review_sent,
    routeRecord(wave?.review_link_ts, storedPRs(item)[0]?.number), routeRecord(wave?.review_link_ts, key),
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

export function reviewersOf(wave, board = []) {
  return [...new Map([...board, ...(wave.reviewers || [])].map((r) => [r.name, r])).values()];
}
