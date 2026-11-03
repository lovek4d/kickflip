// Whether a board request comes from a browser on the hub's own machine (docs/adr/0164-a-building-card-opens-its-worktree-in-vs-code-on-the-host.md).
// tailscale serve proxies every tailnet request from 127.0.0.1 and puts the client's tailnet address last in
// X-Forwarded-For, so a browser on the host names one of the host's own addresses; a request with no such header
// reached the hub straight on loopback.
import os from 'node:os';

const ownAddresses = () => Object.values(os.networkInterfaces()).flat().map((a) => a.address);
const bare = (address) => String(address || '').trim().replace(/^::ffff:/, '');

// req: {headers, socket: {remoteAddress}}. → true on the host
export function fromHost(req, addresses = ownAddresses()) {
  const forwarded = req.headers['x-forwarded-for'];
  const client = forwarded ? String(forwarded).split(',').at(-1) : req.socket.remoteAddress;
  return addresses.includes(bare(client));
}
