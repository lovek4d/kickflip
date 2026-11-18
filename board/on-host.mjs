// Whether a board request comes from a browser on the hub's own machine
// (docs/adr/2026-11-03-1544-a-building-card-opens-its-worktree-in-vs-code-on-the-host.md,
// docs/adr/2026-11-04-0236-the-hub-tells-the-hosts-browser-by-its-forwarded-address-then-its-tailnet-node.md).
// tailscale serve proxies every tailnet request from 127.0.0.1 and sets X-Forwarded-For to the client's tailnet
// address, replacing any the client sent, so a browser on the host names one of the host's own addresses; a request
// with no such header reached the hub straight on loopback. When the host's tailnet address isn't on one of its
// interfaces, the request is the host's when tailscale serve's Tailscale-User-Login is the host's user and the
// forwarded address is one of the host node's own (`tailscale status --json` Self).
// ownerGate tells who may reach the hub at all: the host, a direct loopback caller, or any device whose
// Tailscale-User-Login is the host node's user (docs/adr/2026-11-04-0502-only-the-signed-in-owner-changes-permissions-or-restarts.md).
// The hub listens on 127.0.0.1 alone, so only a local process can send that header past tailscale serve, which is why
// the gate isn't the owner's proof: past it, every request needs the owner's sign-in cookie, or is an agent path
// (../shared/owner-sign-in.mjs; docs/adr/2026-11-18-1200-the-owner-signs-in-with-a-link-that-sets-a-device-cookie.md).
// While the tailnet is off (../shared/tailnet.mjs), the host and the owner are a loopback client alone, and tailscale is
// never asked: a tailscale serve mapping left in place still forwards each tailnet device with its own address, which
// isn't loopback.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tailscaleDaemon, tailscaleArgv, answeredBy } from '../shared/tailscale.mjs';
import { tailnetOn } from '../shared/tailnet.mjs';

const run = promisify(execFile);
const bare = (address) => String(address || '').trim().replace(/^::ffff:/, '');
const isLoopback = (address) => address === '::1' || /^127\.\d+\.\d+\.\d+$/.test(address);

const interfaceAddresses = () => Object.values(os.networkInterfaces()).flat().map((a) => a.address);
// The host as the gate reads it on each request: its interfaces' addresses, its tailnet node, and whether the tailnet is on.
const thisHost = { addresses: interfaceAddresses, node: tailnetNode, tailnet: () => tailnetOn() };

// → {login, addresses} of the host's own tailnet node, or null when tailscale isn't installed, doesn't answer, or another
// daemon answers for the recorded one
async function tailnetNode() {
  const tailscale = tailscaleDaemon();
  if (!tailscale) return null;
  try {
    const { stdout } = await run(...tailscaleArgv(tailscale, ['status', '--json']), { timeout: 5000 });
    const status = JSON.parse(stdout);
    if (answeredBy(tailscale, status)) return null;
    const { Self, User } = status;
    const user = User?.[Self.UserID];
    return { login: user?.LoginName, addresses: Self.TailscaleIPs || [] };
  } catch { return null; }
}

const clientOf = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  return bare(forwarded ? String(forwarded).split(',').at(-1) : req.socket.remoteAddress);
};

// req: {headers, socket: {remoteAddress}}; host: {addresses: () => [address], node: async () => {login, addresses} | null,
// tailnet: () => boolean} → true on the host
export async function fromHost(req, host = thisHost) {
  const forwarded = req.headers['x-forwarded-for'];
  const client = clientOf(req);
  if (!host.tailnet()) return isLoopback(client);
  if (host.addresses().includes(client)) return true;
  const login = req.headers['tailscale-user-login'];
  if (!forwarded || !login) return false;
  const node = await host.node();
  return Boolean(node) && node.login === login && node.addresses.includes(client);
}

// The front door to the whole hub and its try ports (docs/adr/2026-11-04-2156-the-whole-hub-answers-only-the-owner.md).
// host: as fromHost; now, retryMs: when tailscale is asked again after it didn't name the host's user
// → async (req) => 'owner' for the host, a direct loopback caller or a device whose Tailscale-User-Login is the host
// node's user; 'other' for any other login or none (a shared-in user, a tagged node, Funnel), which nothing serves
// (docs/adr/2026-11-18-0700-the-hub-has-no-sharing-only-the-owners-tailnet-identity-gets-in.md); 'unread' for a login
// while tailscale hasn't named the host's user yet. The user is read once and kept for the gate's lifetime.
export function ownerGate(host = thisHost, { now = Date.now, retryMs = 5000 } = {}) {
  let owner = null;
  let asking = null;
  let failedAt = -Infinity;
  const ownerNode = () => {
    if (owner || now() - failedAt < retryMs) return owner;
    asking ||= host.node().then((node) => {
      asking = null;
      if (node?.login) owner = node; else failedAt = now();
      return owner;
    });
    return asking;
  };
  return async (req) => {
    if (!host.tailnet()) return isLoopback(clientOf(req)) ? 'owner' : 'other';
    if (host.addresses().includes(clientOf(req))) return 'owner';
    const login = req.headers['tailscale-user-login'];
    if (!login) return 'other';
    const found = await ownerNode();
    return !found ? 'unread' : found.login === login ? 'owner' : 'other';
  };
}

// The hub process's one gate, shared by its own server and its try relays.
export const hubGate = ownerGate();
