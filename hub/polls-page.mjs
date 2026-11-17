// The hub's Polls page, /_hub/polls: every recurring job in shared/polls.mjs, read-only, under its group's heading
// fastest first, each with its cadence, where it runs and the file:line of its `poll: <id>` comment. Tick and Board
// minute open into their steps; the back-offs, which run only while something is down or busy, are greyed last
// (docs/adr/2026-11-17-0330-every-poll-is-in-one-registry-and-the-hub-runs-on-two-clocks.md). hub.css lays it out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLLS, GROUPS, cadenceOf } from '../shared/polls.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// "hub/hub.mjs:1834", the line of the poll's `poll: <id>` comment in its file as the file reads now.
export function pollLine(poll) {
  const lines = fs.readFileSync(path.join(ROOT, poll.where), 'utf8').split('\n');
  const n = lines.findIndex((line) => new RegExp(`poll: ${poll.id}(?![\\w-])`).test(line));
  if (n < 0) throw new Error(`${poll.where} has no poll: ${poll.id} comment`);
  return `${poll.where}:${n + 1}`;
}

const stepHtml = (s) => `<li><span>${esc(s.name)}${s.what ? ` <i>· ${esc(s.what)}</i>` : ''}</span>${s.cadence ? `<em>${esc(s.cadence)}</em>` : ''}</li>`;

function rowHtml(p, lineOf) {
  const row = `<div class="poll"><div class="poll-main"><b class="poll-name">${esc(p.name)}</b><span class="poll-what">${esc(p.what)}</span>`
    + `<span class="poll-meta"><span class="poll-runs">${esc(p.runs)}</span><code>${esc(lineOf(p))}</code></span></div>`
    + `<span class="poll-cadence">${esc(cadenceOf(p))}</span></div>`;
  if (!p.steps) return row;
  return `<details class="poll-steps"><summary>${row}<span class="poll-more">${p.steps.length} steps</span></summary><ol>${p.steps.map(stepHtml).join('')}</ol></details>`;
}

// lineOf(poll) → its file:line, pollLine by default. → the page's body, from the back link to its last group.
export function pollsPage({ lineOf = pollLine } = {}) {
  const groups = GROUPS.map((g) => {
    const polls = POLLS.filter((p) => p.group === g.id).sort((a, b) => a.every - b.every);
    return `<details class="poll-group${g.muted ? ' muted' : ''}" open><summary><h2>${esc(g.name)}</h2><span class="count">${polls.length}</span><span class="why">${esc(g.why)}</span></summary>`
      + `${polls.map((p) => rowHtml(p, lineOf)).join('')}</details>`;
  });
  return `<a class="back" href="/_hub/">‹ Hub</a><h1>Polls</h1>`
    + '<p class="lede">Every job the hub, its boards, open pages and hooks run again and again, grouped by what it watches, fastest first. Tap a heading to fold it, and Tick or Board minute for its steps.</p>'
    + `<div class="polls">${groups.join('')}</div>`;
}
