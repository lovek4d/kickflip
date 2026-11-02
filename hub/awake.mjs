// Keep awake (docs/adr/0112-snooze-and-keep-awake-share-one-duration-picker.md): while settings.json's keep_awake_until
// is FOREVER or a time still ahead, the hub runs `caffeinate -ims`, stops it at that time or when turned off, and starts
// it again after a restart while time is left. Only macOS has caffeinate.
import { spawn } from 'node:child_process';
import { FOREVER, durationEnd, endOf, storedEnd } from './duration.mjs';
import { readSettingsFile, writeSettingsFile } from './push.mjs';

const OS_NAMES = { linux: 'Linux', win32: 'Windows', freebsd: 'FreeBSD' };
// null on macOS, else why Keep awake can't run on this host.
export const awakeUnsupported = (platform = process.platform) => (platform === 'darwin' ? null
  : `macOS only · this host runs ${OS_NAMES[platform] || platform}`);

// FOREVER or a Date while Keep awake is on at `now`, else null.
export const awakeUntil = (now = new Date(), file = readSettingsFile()) => endOf(file.keep_awake_until, now);

// choice: a duration.mjs durationEnd choice, or 'off'. Throws {status: 409} off macOS and {status: 400} for a choice
// that doesn't end within 30 days; returns the new awakeUntil.
export function setKeepAwake(choice, { now = new Date(), platform = process.platform } = {}) {
  const unsupported = awakeUnsupported(platform);
  if (unsupported) throw Object.assign(new Error(`Keep awake runs caffeinate, ${unsupported}.`), { status: 409 });
  const end = choice === 'off' ? null : durationEnd(now, choice);
  if (end === null && choice !== 'off') throw Object.assign(new Error('Keep awake must end after now and within 30 days: <n>m, <n>h, <n>d, <n>w, forever or a date and time; or off.'), { status: 400 });
  const { keep_awake_until: _, ...rest } = readSettingsFile();
  writeSettingsFile(end ? { ...rest, keep_awake_until: storedEnd(end) } : rest);
  return end;
}

// The hub's one caffeinate. apply() starts or stops it to match the setting and arms a timer for its end; stop() ends
// it for good as the hub exits.
export function caffeinate({ log = () => {}, platform = process.platform } = {}) {
  let child = null;
  let timer = null;
  const end = () => {
    if (!child) return;
    log(`keep awake: stopping caffeinate (pid ${child.pid})`);
    child.kill('SIGTERM');
    child = null;
  };
  function apply(now = new Date()) {
    clearTimeout(timer);
    const file = readSettingsFile();
    const until = awakeUnsupported(platform) ? null : awakeUntil(now, file);
    if (!until) {
      if (file.keep_awake_until && !awakeUnsupported(platform)) {
        const { keep_awake_until: _, ...rest } = file;
        writeSettingsFile(rest);
      }
      end();
      return;
    }
    if (!child) {
      // -w ends caffeinate with the hub, so a hub that dies without stopping it leaves none behind.
      const c = spawn('caffeinate', ['-ims', '-w', String(process.pid)], { stdio: 'ignore' });
      c.on('error', (e) => { log(`keep awake: caffeinate failed: ${e.message}`); if (child === c) child = null; });
      c.on('exit', () => { if (child === c) child = null; });
      child = c;
      log(`keep awake: caffeinate -ims (pid ${c.pid}) until ${until === FOREVER ? 'turned off' : until.toISOString()}`);
    }
    if (until !== FOREVER) timer = setTimeout(() => apply(), Math.min(until - now, 2 ** 31 - 1));
  }
  return { apply, stop: () => { clearTimeout(timer); end(); } };
}
