// The tailnet opt-in (docs/adr/2026-11-18-0300-the-tailnet-is-opt-in-with-kickflip-tailnet.md). The hub listens on
// 127.0.0.1 only; `kickflip tailnet on` maps Tailscale / to it so the phone reaches it over the tailnet, and records
// `tailnet: true` in the hub's settings.json. Unset is off: the hub serves this host only, and nothing runs tailscale
// until the owner turns it on. Every caller reads tailnetOn on each call, since the command changes it underneath.
// ./tailscale.mjs stays the daemon layer: which Tailscale daemon, and how to reach it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { read, update } from './hub-settings.mjs';
import { runCommand } from './service.mjs';
import { tailscaleDaemon, repickDaemon, tailscaleArgv, recordedFault, tailscaleRoot, tailscaleInstallHint } from './tailscale.mjs';

const hubPort = () => Number(process.env.KICKFLIP_HUB_PORT || 4500);

export const tailnetOn = (home = os.homedir()) => read(home).tailnet === true;

export const setTailnet = (on, home = os.homedir()) => update(({ tailnet: _, ...rest }) => (on ? { ...rest, tailnet: true } : rest), home);

// The hub, or a site at route, on this host.
export const localUrl = (route, port = hubPort()) => `http://127.0.0.1:${port}/${route ? route + '/' : ''}`;

// The HTTPS address the phone opens: tailscale / is the hub, so the hub is at https://<host>/ and a site at
// https://<host>/<route>/. Throws the one-line reason when Tailscale isn't installed or running, or the tailnet has no
// HTTPS certificate for this host. tailscale: the daemon (./tailscale.mjs).
export function tailnetUrl(route, { run = runCommand, platform = process.platform, tailscale = tailscaleDaemon({ platform }) } = {}) {
  if (!tailscale) throw new Error(`Tailscale isn't installed on this host; ${tailscaleInstallHint(platform)}`);
  const r = run(...tailscaleArgv(tailscale, ['status', '--json']));
  let status = null;
  try { status = r.status === 0 ? JSON.parse(r.stdout) : null; } catch {}
  const fault = recordedFault(tailscale, r.stdout);
  if (fault) throw new Error(fault);
  if (status?.BackendState !== 'Running') throw new Error("Tailscale isn't running on this host; start it, or run tailscale up");
  const host = status.Self?.DNSName?.replace(/\.$/, '') || '';
  if (!host || !status.CertDomains?.includes(host)) throw new Error("HTTPS isn't on for this tailnet; turn on HTTPS Certificates on the DNS page of the Tailscale admin console");
  return `https://${host}/${route ? route + '/' : ''}`;
}

// The hub's or a site's address: the tailnet's while it's on, else this host's. Off runs no tailscale.
export const hubUrl = (route, { home = os.homedir(), port = hubPort(), ...options } = {}) => (tailnetOn(home) ? tailnetUrl(route, options) : localUrl(route, port));

// Maps tailscale / to the hub on port through the recorded daemon, and unmaps each old per-site mount the manifest
// still names. Throws the recorded-daemon fault, or serve's error.
export function mapHub({ tailscale, port = hubPort(), home = os.homedir(), run = runCommand, env = process.env }) {
  const fault = tailscale.node && recordedFault(tailscale, run(...tailscaleArgv(tailscale, ['status', '--json']), { env }).stdout);
  if (fault) throw new Error(fault);
  const mapped = run(...tailscaleArgv(tailscale, ['serve', '--bg', String(port)]), { env });
  if (mapped.status !== 0) throw new Error(mapped.error || 'tailscale serve failed');
  let config;
  try { config = JSON.parse(run(...tailscaleArgv(tailscale, ['serve', 'status', '--json']), { env }).stdout); } catch { return; }
  let sites = {};
  try { sites = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'kickflip', 'manifest.json'), 'utf8')).sites || {}; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const route of tailscaleRoot(config).paths) {
    if (route !== '/' && Object.hasOwn(sites, route.replace(/^\//, '').replace(/\/$/, ''))) run(...tailscaleArgv(tailscale, ['serve', '--https=443', '--set-path=' + route, 'off']), { env });
  }
}

// Unmaps tailscale / and every try port (../hub/try.mjs) on the recorded daemon. → the words saying what it did, '' with
// no daemon.
export async function unmapHub({ tailscale, run = runCommand, env = process.env }) {
  if (!tailscale) return '';
  const fault = tailscale.node && recordedFault(tailscale, run(...tailscaleArgv(tailscale, ['status', '--json']), { env }).stdout);
  if (fault) return `tailscale / left mapped: ${fault}`;
  run(...tailscaleArgv(tailscale, ['serve', '--https=443', '--set-path=/', 'off']), { env });
  // try.mjs reaches back to install's checks through readiness, so it loads only here.
  const { isTryPort } = await import('../hub/try.mjs');
  let config = null;
  try { config = JSON.parse(run(...tailscaleArgv(tailscale, ['serve', 'status', '--json']), { env }).stdout); } catch {}
  const ports = Object.keys(config?.TCP || {}).filter(isTryPort);
  for (const port of ports) run(...tailscaleArgv(tailscale, ['serve', `--https=${port}`, 'off']), { env });
  return `tailscale /${ports.length ? ` and try port${ports.length > 1 ? 's' : ''} ${ports.join(', ')}` : ''} unmapped`;
}

// kickflip tailnet on: maps / through init's daemon pick, then records on. → the line to print. Throws, leaving it off,
// when there's no Tailscale or the mapping fails.
export async function turnOn({ home = os.homedir(), port = hubPort(), run = runCommand, env = process.env, platform = process.platform, tailscale = repickDaemon({ env, platform, home, port }) } = {}) {
  if (!tailscale) throw new Error(`Tailscale isn't installed on this host; ${tailscaleInstallHint(platform)}`);
  mapHub({ tailscale, port, home, run, env });
  await setTailnet(true, home);
  try { return `tailnet on: the hub is at ${tailnetUrl(undefined, { run, platform, tailscale })}`; } catch (e) { return `tailnet on; ${e.message}`; }
}

// kickflip tailnet off: unmaps / and the try ports, then records off. → the line to print.
export async function turnOff({ home = os.homedir(), port = hubPort(), run = runCommand, env = process.env, platform = process.platform, tailscale = tailscaleDaemon({ env, platform, home, port }) } = {}) {
  const unmapped = await unmapHub({ tailscale, run, env });
  await setTailnet(false, home);
  return `tailnet off${unmapped ? `; ${unmapped}` : ''}. The hub serves this host at ${localUrl(undefined, port)}`;
}

// kickflip tailnet status. → the line to print; throws the reason when it's on with no tailnet address.
export function tailnetStatus({ home = os.homedir(), port = hubPort(), ...options } = {}) {
  if (!tailnetOn(home)) return `off: the hub serves this host only, at ${localUrl(undefined, port)}; kickflip tailnet on adds it to your tailnet`;
  try { return `on: the hub is at ${tailnetUrl(undefined, options)}`; } catch (e) { throw new Error(`on, but ${e.message}`); }
}
