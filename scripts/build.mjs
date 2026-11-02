import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { transform } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });
const [{ files }] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
let minified = 0;
for (const { path: file } of files) {
  const source = path.join(root, file);
  const target = path.join(dist, file);
  const { mode } = await fs.stat(source);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (file === 'package.json') {
    const { private: _, scripts, devDependencies, ...pkg } = JSON.parse(await fs.readFile(source, 'utf8'));
    await fs.writeFile(target, JSON.stringify(pkg, null, 2) + '\n');
  } else if (/\.(mjs|js)$/.test(file) && !file.split('/').includes('public') && file !== 'hub/sw.js' && !file.startsWith('hooks-plugin/')) {
    const text = await fs.readFile(source, 'utf8');
    const shebang = text.match(/^#![^\n]*(?:\n|$)/)?.[0] || '';
    // bin/kickflip.mjs reads this leading comment block as its usage text.
    const prefix = file === 'bin/kickflip.mjs' ? text.match(/^#![^\n]*\n(?:\/\/[^\n]*\n)*/)[0] : shebang;
    const { code } = await transform(text.slice(prefix.length), { minify: true, format: 'esm', target: 'node22', loader: 'js', legalComments: 'none', keepNames: true });
    await fs.writeFile(target, prefix + code);
    minified++;
  } else {
    await fs.copyFile(source, target);
  }
  await fs.chmod(target, mode);
}
console.log(`${files.length} files, ${minified} minified: ${dist}`);
