// docs/adr/2026-11-18-1200-composer-drafts-live-on-the-server.md
// The owner's composer drafts, one set for every device, in a site's data/drafts.json {drafts: {id: {text, files, at}}}:
// a board's for its thread replies (item:<card key>) and New task box (ask), the hub's (its home) for its New task box.
// at is the server's time of the draft's last save, each later than the one it replaced, so a page shows only a draft
// newer than the one it has. An emptied draft stays, empty, with its time; a reply's goes with its card (pruneDrafts).
import path from 'node:path';
import { editJSON, readJSON } from './files.mjs';

export const DRAFT_ID = /^(ask|item:\S{1,200})$/;
export const DRAFT_TEXT_MAX = 100_000;
const UPLOAD_URL = /^uploads\/\d+-[\w.-]+$/;

export const draftsFile = (site) => path.join(site, 'data', 'drafts.json');
export const readDrafts = async (site) => (await readJSON(draftsFile(site), {})).drafts || {};

const refuse = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
// A page's POST body → {id, text, files}: each file one the site's own upload made, its path rebuilt from the site's data
// dir. Anything else throws an Error with status 400.
export function draftOf(site, body) {
  const { id, text, files = [] } = body || {};
  if (typeof id !== 'string' || !DRAFT_ID.test(id)) refuse('id is ask or item:<card key>.');
  if (typeof text !== 'string' || text.length > DRAFT_TEXT_MAX) refuse(`text is a string of at most ${DRAFT_TEXT_MAX} characters.`);
  if (!Array.isArray(files) || !files.every((f) => typeof f?.url === 'string' && UPLOAD_URL.test(f.url))) refuse('files are uploads/<file> from this site.');
  return { id, text, files: files.map(({ name, url, type, size }) => ({ name: String(name ?? ''), url, type: String(type ?? ''), size: Number(size) || 0, path: path.join(site, 'data', url) })) };
}

// Saves {id, text, files} at the server's time, a millisecond past the draft it replaces when the clock hasn't moved.
// told as files.mjs writeJSON's. → {at}
export function saveDraft(site, { id, text, files }, { told = true } = {}) {
  return editJSON(draftsFile(site), (value) => {
    value.drafts ||= {};
    const before = Date.parse(value.drafts[id]?.at || 0);
    const at = new Date(Math.max(Date.now(), before + 1)).toISOString();
    value.drafts[id] = { text, files, at };
    return { at };
  }, { told });
}

// Drops each draft whose id keep refuses, writing only when one goes.
export async function pruneDrafts(site, keep, { told = true } = {}) {
  if (Object.keys(await readDrafts(site)).every(keep)) return;
  await editJSON(draftsFile(site), (value) => {
    value.drafts = Object.fromEntries(Object.entries(value.drafts || {}).filter(([id]) => keep(id)));
  }, { told });
}
