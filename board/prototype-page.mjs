// A recorded prototype's pages: board/public/prototype.html, the viewer, and board/public/prototype-stage.html, the stage
// its takes draw in, each with the prototype's record filled in. The board server serves both, and render-check.mjs
// loads the stage in headless Chrome before a prototype question publishes.
// docs/adr/2026-11-18-0523-previews-run-in-a-sandboxed-opaque-origin.md: the stage, and every file of the site's own
// public folder (visuals, hand-written pages), carry SANDBOX, so the code an agent wrote runs in an opaque origin.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { takeFile } from './questions.mjs';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
export const PROTOTYPE_TEMPLATE = path.join(pub, 'prototype.html');
export const STAGE_TEMPLATE = path.join(pub, 'prototype-stage.html');
// The header a preview's response carries: scripts run, in an origin of their own that reads nothing of the board's,
// framed or opened alone.
export const SANDBOX = { 'content-security-policy': 'sandbox allow-scripts' };
// A preview's module script (a take's file) is fetched with CORS from that opaque origin, whose Origin is null.
export const SANDBOX_MODULE = { 'access-control-allow-origin': 'null' };
// The stage of topic: /prototype-<topic>.stage.html, next to its viewer /prototype-<topic>.html.
export const stagePath = (topic) => `prototype-${topic}.stage.html`;
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A page names each local script and stylesheet by its version, so a pinned file caches for good and an edit
// reaches the browser through the page, which revalidates on every visit (docs/adr/2026-10-29-1639-the-board-opens-on-the-last-visit.md).
export const versionOf = (st) => `${Math.floor(st.mtimeMs).toString(36)}-${st.size.toString(36)}`;
// Inside <script type="application/json">, so "<" is escaped and the record can't close the element.
const scriptJSON = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

async function pageData(site, proto) {
  const takes = proto.served ? proto.takes : await Promise.all(proto.takes.map(async (t) => {
    const src = `prototypes/${proto.topic}/${t.key}.js`;
    const st = await fs.stat(takeFile(site, proto.topic, t.key)).catch(() => null);
    return { key: t.key, label: t.label, src: st?.isFile() ? `${src}?v=${versionOf(st)}` : null, file: src };
  }));
  return { topic: proto.topic, title: proto.title, takes, ...(proto.served ? { served: proto.served, states: proto.states || null } : {}) };
}

export async function prototypePage(site, proto) {
  const title = `${proto.title} · prototype`;
  const header = { lead: 'back', backHref: proto.card ? `./#selectedCard=${encodeURIComponent(proto.card)}` : './', title, controls: false };
  const fill = { prototypeTitle: esc(title), prototypeHeader: `<!--header ${scriptJSON(header).replace(/>/g, '\\u003e')}-->`, prototypeData: scriptJSON(await pageData(site, proto)) };
  return (await fs.readFile(PROTOTYPE_TEMPLATE, 'utf8')).replace(/\{\{(prototypeTitle|prototypeHeader|prototypeData)\}\}/g, (_, k) => fill[k]);
}

export async function prototypeStage(site, proto) {
  const fill = { prototypeTitle: esc(`${proto.title} · stage`), prototypeData: scriptJSON(await pageData(site, proto)) };
  return (await fs.readFile(STAGE_TEMPLATE, 'utf8')).replace(/\{\{(prototypeTitle|prototypeData)\}\}/g, (_, k) => fill[k]);
}
