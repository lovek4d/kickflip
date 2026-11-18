// docs/adr/2026-11-18-2200-a-board-asks-a-board-on-another-of-your-hubs-while-its-online.md
// The owner's other hubs, and the one way this hub talks to them. A peer is another machine on the tailnet signed in as
// this host's own Tailscale user, online, and not a phone (iOS or Android runs no hub); its name is its tailnet machine
// name, the first label of its MagicDNS name, and its hub answers at https://<MagicDNS name>/, where its own
// `kickflip tailnet on` maps tailscale / to it. Nothing here keeps a list: each send reads `tailscale status` again.
// A peer hub's routes for other hubs are /_hub/peer/<what> (hub.mjs); the CLI reaches them through this hub's loopback
// /_hub/peers/<what>, which relays here.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tailscaleDaemon, tailscaleArgv, answeredBy } from '../shared/tailscale.mjs';
import { tailnetOn } from '../shared/tailnet.mjs';

const run = promisify(execFile);
const PHONES = new Set(['iOS', 'android']);

const machine = (node) => ({ name: String(node.DNSName || '').split('.')[0].toLowerCase(), host: String(node.DNSName || '').replace(/\.$/, '') });

// status: `tailscale status --json` → {self: {name, host}, peers: [{name, host}]}: the online, non-phone peers whose
// user is Self's, by name.
export function peersOf(status) {
  const self = status.Self || {};
  const peers = Object.values(status.Peer || {})
    .filter((p) => p.UserID === self.UserID && p.Online && !PHONES.has(p.OS) && p.DNSName)
    .map(machine).sort((a, b) => a.name.localeCompare(b.name));
  return { self: machine(self), peers };
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

// Relays one request to the peer named name: body, or body(self) for one that names this hub ({name, host}).
// → {status, body}: the peer's answer, or why it can't be sent: the tailnet
// off here (409), tailscale not answering (503), or no such peer online (404, naming the ones that are).
export async function sendToPeer(name, what, body, { peers = tailnetPeers, ...options } = {}) {
  if (!peers.tailnet()) return refusal(409, TAILNET_OFF);
  const found = await peers.read();
  if (!found) return refusal(503, "Tailscale doesn't answer on this host, so no other hub can be reached");
  const wanted = String(name || '').toLowerCase();
  if (wanted === found.self.name) return refusal(400, `${name} is this hub; ask a board here by its route alone`);
  const peer = found.peers.find((p) => p.name === wanted);
  if (!peer) return refusal(404, `${name} isn't one of your machines online on the tailnet; online now: ${found.peers.map((p) => p.name).join(', ') || 'none'}`);
  return toPeer(peer, what, typeof body === 'function' ? body(found.self) : body, { peers, ...options });
}

// Every peer's boards. → {status, body: {hubs: [{hub, boards: [{route, title}]} | {hub, error}]}}, or sendToPeer's
// refusals for the tailnet and tailscale.
export async function peerBoards({ peers = tailnetPeers, ...options } = {}) {
  if (!peers.tailnet()) return refusal(409, TAILNET_OFF);
  const found = await peers.read();
  if (!found) return refusal(503, "Tailscale doesn't answer on this host, so no other hub can be reached");
  const hubs = await Promise.all(found.peers.map(async (peer) => {
    const { status, body } = await toPeer(peer, 'boards', undefined, { peers, ...options });
    return status === 200 ? { hub: peer.name, boards: body.boards || [] } : { hub: peer.name, error: body.error || `answered ${status}` };
  }));
  return { status: 200, body: { hubs } };
}
