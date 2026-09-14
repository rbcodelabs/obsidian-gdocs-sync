import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = process.env.GEODE_QA_OUTPUT;
if (!directory || !directory.startsWith('/')) throw new Error('Set GEODE_QA_OUTPUT to an explicit disposable build directory');
await mkdir(directory, { recursive: true, mode: 0o700 });
await build({ entryPoints: ['tests/live/qa-entry.ts'], bundle: true, platform: 'node', external: ['obsidian'], format: 'cjs', target: 'es2022', minify: false, sourcemap: false, define: { GEODE_MANAGED_SYNC_QA: 'true' }, outfile: resolve(directory, 'main.js') });
process.stdout.write('Disposable managed-vault QA bundle built; production main.js unchanged.\n');
