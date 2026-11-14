// Imported first by a test file that runs code reading HOME in its own process, such as the board server's
// startServer: HOME is a scratch folder before any module reads it (some read it as they load), and the folder goes
// as the process exits. Each test file runs in its own process, so the scratch HOME is that file's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempDir } from './temp-dir.mjs';

export const home = fs.realpathSync(tempDir('home-'));
process.env.HOME = home;
