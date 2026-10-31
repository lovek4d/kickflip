import fs from 'node:fs';
import path from 'node:path';

export function installScriptError(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return 'Install script must be an absolute path.';
  let stat;
  try { stat = fs.statSync(file); } catch { return 'Install script must be an existing regular file.'; }
  if (!stat.isFile()) return 'Install script must be an existing regular file.';
  if (stat.uid !== process.getuid()) return 'Install script must be owned by the current user.';
  if (stat.mode & 0o022) return 'Install script must not be writable by group or others.';
  return null;
}
