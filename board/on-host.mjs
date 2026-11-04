// Whether a board request comes from a browser on the hub's own machine
// (docs/adr/2026-11-03-1544-a-building-card-opens-its-worktree-in-vs-code-on-the-host.md,
// docs/adr/2026-11-04-0236-the-hub-tells-the-hosts-browser-by-its-forwarded-address-then-its-tailnet-node.md).
// tailscale serve proxies every tailnet request from 127.0.0.1 and sets X-Forwarded-For to the client's tailnet
// address, replacing any the client sent, so a browser on the host names one of the host's own addresses; a request
// with no such header reached the hub straight on loopback. When the host's tailnet address isn't on one of its
// interfaces, the request is the host's when tailscale serve's Tailscale-User-Login is the host's user and the
// forwarded address is one of the host node's own (`tailscale status --json` Self).
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const bare = (address) => String(address || '').trim().replace(/^::ffff:/, '');

const interfaceAddresses = () => Object.values(os.networkInterfaces()).flat().map((a) => a.address);

// → {login, addresses} of the host's own tailnet node, or null when tailscale doesn't answer
async function tailnetNode() {
  try {
    const { stdout } = await run('tailscale', ['status', '--json'], { timeout: 5000 });
    const { Self, User } = JSON.parse(stdout);
    return { login: User?.[Self.UserID]?.LoginName, addresses: Self.TailscaleIPs || [] };
  } catch { return null; }
}

// req: {headers, socket: {remoteAddress}}; host: {addresses: () => [address], node: async () => {login, addresses} | null}
// → true on the host
export async function fromHost(req, host = { addresses: interfaceAddresses, node: tailnetNode }) {
  const forwarded = req.headers['x-forwarded-for'];
  const client = bare(forwarded ? String(forwarded).split(',').at(-1) : req.socket.remoteAddress);
  if (host.addresses().includes(client)) return true;
  const login = req.headers['tailscale-user-login'];
  if (!forwarded || !login) return false;
  const node = await host.node();
  return Boolean(node) && node.login === login && node.addresses.includes(client);
}
