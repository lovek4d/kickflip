import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const cloneRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// npm replaces the package folder on update, so installed packages keep repos outside it.
export const reposDir = (root = cloneRoot()) => fs.existsSync(path.join(root, '.git')) ? path.resolve(root, '.repos') : path.join(os.homedir(), '.claude', 'kickflip', 'repos');
