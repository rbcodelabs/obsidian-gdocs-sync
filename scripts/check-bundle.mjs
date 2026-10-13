// Asserts the production bundle can load on a host with no Node and no Electron
// (Geode / Obsidian mobile). The only modules a mobile host provides to a
// plugin are 'obsidian' and the CodeMirror/Lezer packages it shares, so any
// other static require() in main.js (fs, path, electron, ...) would throw at load.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ALLOWED = [/^obsidian$/, /^@codemirror\//, /^@lezer\//];

/** Static require("x") calls. `window.require("x")` (a guarded, lazy lookup) is intentionally not matched. */
export function findDisallowedRequires(source) {
	const found = new Set();
	const re = /(?<![.\w$])require\(\s*(["'`])([^"'`]+)\1\s*\)/g;
	for (const match of source.matchAll(re)) {
		const id = match[2];
		if (!ALLOWED.some(rule => rule.test(id))) found.add(id);
	}
	return [...found].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const file = process.argv[2] ?? 'main.js';
	const bad = findDisallowedRequires(readFileSync(file, 'utf8'));
	if (bad.length > 0) {
		console.error(`${file} requires modules unavailable on mobile: ${bad.join(', ')}`);
		process.exit(1);
	}
	console.log(`${file}: no Node/Electron builtin requires.`);
}
