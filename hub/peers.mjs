// docs/adr/2026-11-18-2200-a-board-asks-a-board-on-another-of-your-hubs-while-its-online.md
// docs/adr/2026-11-18-2250-asks-between-hubs-wait-in-an-outbox-while-the-other-hub-is-offline-or-older.md
// The owner's other hubs, and the one way this hub talks to them. A peer is another machine on the tailnet signed in as
// this host's own Tailscale user, and not a phone (iOS or Android runs no hub); its name is its tailnet machine
// name, the first label of its MagicDNS name, and its hub answers at https://<MagicDNS name>/, where its own
// `kickflip tailnet on` maps tailscale / to it. Nothing here keeps a list: each send reads `tailscale status` again.
// A peer hub's routes for other hubs are /_hub/peer/<what> (hub.mjs); the CLI reaches them through this hub's loopback
// /_hub/peers/<what>, which relays here, and an ask or answer the peer can't take yet waits in this hub's outbox.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { replace } from '../board/files.mjs';
import { tailscaleDaemon, tailscaleArgv, answeredBy } from '../shared/tailscale.mjs';
import { tailnetOn } from '../shared/tailnet.mjs';

const run = promisify(execFile);
const PHONES = new Set(['iOS', 'android']);

const machine = (node) => ({ name: String(node.DNSName || '').split('.')[0].toLowerCase(), host: String(node.DNSName || '').replace(/\.$/, '') });

// status: `tailscale status --json` → {self: {name, host}, peers: [{name, host}], offline: [name]}: the non-phone
// peers whose user is Self's, by name, the online ones in peers and the others' names in offline.
export function peersOf(status) {
  const self = status.Self || {};
  const mine = Object.values(status.Peer || {}).filter((p) => p.UserID === self.UserID && !PHONES.has(p.OS) && p.DNSName)
    .sort((a, b) => machine(a).name.localeCompare(machine(b).name));
  return { self: machine(self), peers: mine.filter((p) => p.Online).map(machine), offline: mine.filter((p) => !p.Online).map((p) => machine(p).name) };
}

// → peersOf this host's tailscale status, or null when tailscale isn't installed, isn't running, or another daemon
// answers for the recorded one.
export async function readPeers() {
  const tailscale = tailscaleDaemon();
  if (!tailscale) return null;
  try {
    const { stdout } = await run(...tailscaleArgv(tailscale, ['status', '--json']), { timeout: 5000 });
    const status = JSON.parse(stdout);
    if (status.BackendState !== 'Running' || answeredBy(tailscale, status)) return null;
    return peersOf(status);
  } catch { return null; }
}

// How a hub reaches its peers: read() lists them (readPeers), url(peer) is where peer's hub answers, and tailnet() is
// whether this hub's tailnet is on, read on each call. A test hands startHub its own.
export const tailnetPeers = { read: readPeers, url: (peer) => `https://${peer.host}`, tailnet: () => tailnetOn() };

const refusal = (status, error) => ({ status, body: { error } });
const TAILNET_OFF = 'asks between hubs ride the tailnet, which is off on this hub; run kickflip tailnet on here and on the other hub';

// Sends one request to peer's /_hub/peer/<what>: GET with no body, else a JSON POST.
// → {status, body}: the peer's answer, or the line that says why it didn't come (502 for no answer, 501 for a hub
// without these routes).
export async function toPeer(peer, what, body, { peers = tailnetPeers, timeout = 10_000 } = {}) {
  let r;
  try {
    r = await fetch(`${peers.url(peer)}/_hub/peer/${what}`, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(timeout),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (e) {
    return refusal(502, `${peer.name} doesn't answer (${e.cause?.code || e.name}): its hub is down, or its tailnet is off (kickflip tailnet on there)`);
  }
  const answer = await r.json().catch(() => null);
  // A hub from before these routes answers an unknown /_hub/ path with a bare 404, and anything that isn't a hub
  // answers without JSON.
  if (!answer) return refusal(501, `${peer.name} answered ${r.status} without asks between hubs: update kickflip there`);
  if (r.status === 403) return refusal(403, `${peer.name}'s hub refused this one: ${answer.error || 'not signed in as its owner'}`);
  return { status: r.status, body: answer };
}

// The refusals a send waits out rather than gives up on, each as the queued line it stands for: 502 is a peer offline
// on the tailnet or not answering, 501 one whose kickflip has no asks between hubs.
const QUEUED = { 502: (name) => `${name} is offline`, 501: (name) => `${name} runs an older kickflip` };

// → {found}: readPeers' answer, or {refused}: why no other hub can be reached, the tailnet off here (409) or
// tailscale not answering (503).
async function reachable(peers) {
  if (!peers.tailnet()) return { refused: refusal(409, TAILNET_OFF) };
  const found = await peers.read();
  return found ? { found } : { refused: refusal(503, "Tailscale doesn't answer on this host, so no other hub can be reached") };
}

// Sends one request to the peer named name among found, body(self) naming this hub ({name, host}). → {status, body}:
// the peer's answer (toPeer), or why it can't be sent: the name being this hub (400), no machine of the owner's by
// that name (404, naming the ones online), or one offline on the tailnet (502).
async function sendTo(found, name, what, body, options) {
  const wanted = String(name || '').toLowerCase();
  if (wanted === found.self.name) return refusal(400, `${name} is this hub; ask a board here by its route alone`);
  if (found.offline.includes(wanted)) return refusal(502, `${wanted} is offline on the tailnet`);
  const peer = found.peers.find((p) => p.name === wanted);
  if (!peer) return refusal(404, `${name} isn't one of your machines on the tailnet; online now: ${found.peers.map((p) => p.name).join(', ') || 'none'}`);
  return toPeer(peer, what, body(found.self), options);
}

// An ask's or answer's from naming this hub: from.hub, and on an ask from.host, where the asking task links.
const stamped = (what, input) => (self) => ({ ...input, from: { ...input.from, hub: self.name, ...(what === 'ask' ? { host: self.host } : {}) } });

// The outbox: this hub's asks and answers to its peers that couldn't go yet, oldest first, each {id, hub, what, body,
// at, queued}, queued the line saying why it waits; an ask the peer refused once it was back has refused, its error,
// in place of queued. Only the hub writes it (sendToPeer, retryOutbox), one write at a time; a board reads it for `asks`
// (../board/asks.mjs listBoardAsks).
export const outboxFile = () => path.join(os.homedir(), '.claude', 'kickflip', 'peer-outbox.json');
export async function readOutbox() {
  try { return JSON.parse(await fs.readFile(outboxFile(), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
let writing = Promise.resolve();
// Runs change(sends) on the outbox and writes the sends it leaves.
function updateOutbox(change) {
  const run = writing.then(async () => {
    const sends = await readOutbox();
    change(sends);
    await replace(outboxFile(), JSON.stringify(sends, null, 2) + '\n', { told: false });
  });
  writing = run.catch(() => {});
  return run;
}

// Relays an ask or answer (input, from without hub) from an agent here to the peer named name. One the peer can't take
// yet (QUEUED) joins the outbox, for the hub's minute job to send (retryOutbox).
// → {status, body}: the peer's answer, 202 {queued} for one queued, or reachable's and sendTo's refusals.
export async function sendToPeer(name, what, input, { peers = tailnetPeers, ...options } = {}) {
  const { found, refused } = await reachable(peers);
  if (refused) return refused;
  const sent = await sendTo(found, name, what, stamped(what, input), { peers, ...options });
  const hub = String(name).toLowerCase();
  const queued = QUEUED[sent.status]?.(hub);
  if (!queued) return sent;
  await updateOutbox((sends) => sends.push({ id: crypto.randomUUID(), hub, what, body: input, at: new Date().toISOString(), queued }));
  return { status: 202, body: { queued } };
}

// One pass over the outbox, oldest first. A send that goes leaves it. One the peer still can't take keeps its place
// with this try's line, and holds back the later ones to that peer until the next pass. An answer the peer refuses is
// logged and dropped; an ask it refuses is logged and stays, marked refused, so the asking board's `asks` says so.
// Nothing goes while the tailnet is off here or tailscale doesn't answer.
export async function retryOutbox({ peers = tailnetPeers, log = () => {}, ...options } = {}) {
  const waiting = (await readOutbox()).filter((s) => !s.refused);
  if (!waiting.length) return;
  const { found } = await reachable(peers);
  if (!found) return;
  const held = new Set();
  for (const s of waiting) {
    if (held.has(s.hub)) continue;
    const sent = await sendTo(found, s.hub, s.what, stamped(s.what, s.body), { peers, ...options });
    const queued = QUEUED[sent.status]?.(s.hub);
    const named = s.what === 'ask' ? `the ask ${s.body.from?.id}` : `the answer to ${s.body.id}`;
    const error = sent.body?.error || `it answered ${sent.status}`;
    if (queued) held.add(s.hub);
    else log(sent.status < 300 ? `peer outbox: sent ${named} to ${s.hub}` : `peer outbox: ${s.hub} refused ${named}: ${error}`);
    await updateOutbox((sends) => {
      const i = sends.findIndex((x) => x.id === s.id);
      if (queued) sends[i] = { ...sends[i], queued };
      else if (sent.status >= 300 && s.what === 'ask') { const { queued: _, ...rest } = sends[i]; sends[i] = { ...rest, refused: error }; }
      else sends.splice(i, 1);
    });
  }
}

// Every peer's boards. → {status, body: {hubs: [{hub, boards: [{route, title}]} | {hub, error}]}}, an offline peer's
// error saying so, or reachable's refusals.
export async function peerBoards({ peers = tailnetPeers, ...options } = {}) {
  const { found, refused } = await reachable(peers);
  if (refused) return refused;
  const hubs = await Promise.all(found.peers.map(async (peer) => {
    const { status, body } = await toPeer(peer, 'boards', undefined, { peers, ...options });
    return status === 200 ? { hub: peer.name, boards: body.boards || [] } : { hub: peer.name, error: body.error || `answered ${status}` };
  }));
  return { status: 200, body: { hubs: [...hubs, ...found.offline.map((name) => ({ hub: name, error: `${name} is offline` }))] } };
}
