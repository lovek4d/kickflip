// A recorded prototype's page: board/public/prototype.html with the prototype's record filled in. The board server
// serves it, and render-check.mjs loads it in headless Chrome before a prototype question publishes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeFile } from './store.mjs';

export const PROTOTYPE_TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'prototype.html');
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A page names each local script and stylesheet by its version, so a pinned file caches for good and an edit
// reaches the browser through the page, which revalidates on every visit (docs/adr/2026-10-29-1639-the-board-opens-on-the-last-visit.md).
export const versionOf = (st) => `${Math.floor(st.mtimeMs).toString(36)}-${st.size.toString(36)}`;
// Inside <script type="application/json">, so "<" is escaped and the record can't close the element.
const scriptJSON = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export async function prototypePage(site, proto) {
  const takes = proto.served ? proto.takes : await Promise.all(proto.takes.map(async (t) => {
    const src = `prototypes/${proto.topic}/${t.key}.js`;
    const st = await fs.stat(takeFile(site, proto.topic, t.key)).catch(() => null);
    return { key: t.key, label: t.label, src: st?.isFile() ? `${src}?v=${versionOf(st)}` : null, file: src };
  }));
  const title = `${proto.title} · prototype`;
  const header = { lead: 'back', backHref: proto.card ? `./#selectedCard=${encodeURIComponent(proto.card)}` : './', title, controls: false };
  const fill = { prototypeTitle: esc(title), prototypeHeader: `<!--header ${scriptJSON(header).replace(/>/g, '\\u003e')}-->`, prototypeData: scriptJSON({ topic: proto.topic, title: proto.title, takes,
    ...(proto.served ? { served: proto.served, states: proto.states || null } : {}) }) };
  return (await fs.readFile(PROTOTYPE_TEMPLATE, 'utf8')).replace(/\{\{(prototypeTitle|prototypeHeader|prototypeData)\}\}/g, (_, k) => fill[k]);
}
