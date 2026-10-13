import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs helper without type declarations
import { findDisallowedRequires } from '../../scripts/check-bundle.mjs';

const root = path.resolve(__dirname, '../..');
const find = findDisallowedRequires as (source: string) => string[];

describe('findDisallowedRequires', () => {
  it('flags node builtins and electron', () => {
    expect(find('var a=require("fs");var b=require(\'path\');const c=require("electron")')).toEqual(['electron', 'fs', 'path']);
  });

  it('allows obsidian and the shared CodeMirror/Lezer modules', () => {
    expect(find('require("obsidian");require("@codemirror/view");require("@lezer/common")')).toEqual([]);
  });

  it('ignores guarded lookups via window.require', () => {
    expect(find('const e=window.require?.("electron");window.require("fs")')).toEqual([]);
  });
});

describe('production bundle', () => {
  it('has no require() of Node/Electron modules, so it loads on mobile', () => {
    execFileSync(process.execPath, ['esbuild.config.mjs', 'production'], { cwd: root, stdio: 'pipe' });
    const bundle = readFileSync(path.join(root, 'main.js'), 'utf8');
    expect(bundle.length).toBeGreaterThan(1000);
    expect(find(bundle)).toEqual([]);
    expect(bundle).not.toMatch(/(?<![.\w$])require\(\s*["']electron["']\s*\)/);
  });

  it('is not marked desktop-only in the manifest', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as { isDesktopOnly: boolean };
    expect(manifest.isDesktopOnly).toBe(false);
  });
});
