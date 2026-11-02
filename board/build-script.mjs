import fs from 'node:fs';
import path from 'node:path';

export function buildScriptError(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return 'Build script must be an absolute path.';
  let stat;
  try { stat = fs.lstatSync(file); } catch { return 'Build script must be an existing regular file.'; }
  if (!stat.isFile()) return 'Build script must be an existing regular file.';
  if (stat.uid !== process.getuid()) return 'Build script must be owned by the current user.';
  if (stat.mode & 0o022) return 'Build script must not be writable by group or others.';
  if (!(stat.mode & 0o100)) return 'Build script must be executable.';
  return null;
}
