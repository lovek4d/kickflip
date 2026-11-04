import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const cloneRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Board clones live outside the package, so an npm update or a switch between an npm install and a clone keeps them
// (docs/adr/2026-11-04-0103-board-clones-live-outside-the-package.md).
export const reposDir = (home = os.homedir()) => path.join(home, '.claude', 'kickflip', 'repos');
