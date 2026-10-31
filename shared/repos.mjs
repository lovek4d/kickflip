import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const cloneRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const reposDir = (root = cloneRoot()) => path.resolve(root, '.repos');
