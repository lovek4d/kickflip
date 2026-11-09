// Keep awake (docs/adr/2026-11-09-1200-keep-awake-is-a-toggle-that-holds-the-mac-awake-only-on-ac-power.md): while settings.json's
// keep_awake is true, the hub runs `caffeinate -s`, which holds the Mac awake only while it is on AC power and holds nothing
// on battery, and runs it again after a restart. Only macOS has caffeinate.
import { spawn } from 'node:child_process';
import { readSettingsFile, writeSettingsFile } from './push.mjs';

const OS_NAMES = { linux: 'Linux', win32: 'Windows', freebsd: 'FreeBSD' };
// null on macOS, else why Keep awake can't run on this host.
export const awakeUnsupported = (platform = process.platform) => (platform === 'darwin' ? null
  : `macOS only · this host runs ${OS_NAMES[platform] || platform}`);

// Whether Keep awake is on.
export const awakeOn = (file = readSettingsFile()) => file.keep_awake === true;

// Turns Keep awake on or off. Throws {status: 409} off macOS.
export function setKeepAwake(on, { platform = process.platform } = {}) {
  const unsupported = awakeUnsupported(platform);
  if (unsupported) throw Object.assign(new Error(`Keep awake runs caffeinate, ${unsupported}.`), { status: 409 });
  const { keep_awake: _, keep_awake_until: __, ...rest } = readSettingsFile();
  writeSettingsFile(on ? { ...rest, keep_awake: true } : rest);
}

// The hub's one caffeinate. apply() starts or stops it to match the setting; stop() ends it for good as the hub exits.
export function caffeinate({ log = () => {}, platform = process.platform } = {}) {
  let child = null;
  const end = () => {
    if (!child) return;
    log(`keep awake: stopping caffeinate (pid ${child.pid})`);
    child.kill('SIGTERM');
    child = null;
  };
  function apply() {
    const file = readSettingsFile();
    if ('keep_awake_until' in file) {
      // The old timed setting: only forever carries over, as on.
      const { keep_awake_until: old, ...rest } = file;
      writeSettingsFile(old === 'forever' ? { ...rest, keep_awake: true } : rest);
      return apply();
    }
    if (awakeUnsupported(platform) || !awakeOn(file)) { end(); return; }
    if (child) return;
    // -w ends caffeinate with the hub, so a hub that dies without stopping it leaves none behind.
    const c = spawn('caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' });
    c.on('error', (e) => { log(`keep awake: caffeinate failed: ${e.message}`); if (child === c) child = null; });
    c.on('exit', () => { if (child === c) child = null; });
    child = c;
    log(`keep awake: caffeinate -s (pid ${c.pid}) until turned off`);
  }
  return { apply, stop: end };
}
