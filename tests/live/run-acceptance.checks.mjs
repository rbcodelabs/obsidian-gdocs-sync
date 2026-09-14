import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAcceptanceArgs, executeStage, assertInsideFixture, stageExitCode, assertAccountProofs, digestTree } from './run-acceptance.mjs';
import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = ['--authorize-disposable-account', '--authorize-remote-writes', '--root', 'qa-test-run', '--fixture', '/tmp/qa-explicit', '--core', '/tmp/core', '--bundle', '/tmp/bundle', '--stage', 'clients'];
test('requires separate account and remote-write authorization', () => {
  assert.throws(() => parseAcceptanceArgs(args.slice(1)), /authorization/);
  assert.throws(() => parseAcceptanceArgs(args.filter(value => value !== '--authorize-remote-writes')), /authorization/);
});
test('requires named synthetic root and explicit absolute locations', () => {
  assert.throws(() => parseAcceptanceArgs(args.map(value => value === 'qa-test-run' ? 'Personal' : value)), /synthetic/);
  assert.throws(() => parseAcceptanceArgs(args.map(value => value === '/tmp/core' ? '.' : value)), /absolute/);
  assert.throws(() => parseAcceptanceArgs([...args, '--unknown']), /Unknown/);
});
test('stage dispatch wires shared pages and hooks only when binding is pinned', async () => {
  const calls = [], pages = [{}, {}, {}], clients = [{}, {}, {}];
  const options = parseAcceptanceArgs([...args, '--resume', '--retry']);
  const result = await executeStage(options, { pages, clients, pluginId: 'qa-plugin' }, {
    acceptance: async input => { assert.equal(input.pages, pages); return { manifestPath: '/tmp/manifest', runStage: async (stage, flags) => { calls.push([stage, flags, typeof input.hooks.interruptedTransfer]); return { status: 'passed' }; } }; },
    readBinding: async () => ({ rootId: 'pinned' }),
    hooks: async input => { assert.equal(input.clients, clients); assert.equal(input.pages, pages); return { interruptedTransfer() {} }; },
  });
  assert.equal(result.status, 'passed'); assert.deepEqual(calls, [['clients', { retry: true }, 'function']]);
});
test('existing symlink cannot redirect plugin copies outside the fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acceptance-cli-'));
  try {
    const fixture = join(directory, 'fixture'), outside = join(directory, 'outside'); await mkdir(fixture); await mkdir(outside); await symlink(outside, join(fixture, 'plugin'));
    await assert.rejects(assertInsideFixture(fixture, join(fixture, 'plugin')), /escaped/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('pending and not-verified are not successful gate exit codes', () => {
  assert.equal(stageExitCode('passed'), 0); assert.notEqual(stageExitCode('pending'), 0); assert.notEqual(stageExitCode('not-verified'), 0); assert.notEqual(stageExitCode('failed'), 0);
});
test('independent sign-ins must prove the same stable account', () => {
  assert.doesNotThrow(() => assertAccountProofs(Array(3).fill('a'.repeat(64))));
  assert.throws(() => assertAccountProofs(['a'.repeat(64), 'b'.repeat(64), 'a'.repeat(64)]), /account/);
});
test('build proof changes when executable bytes change at the same path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acceptance-build-'));
  try {
    await writeFile(join(directory, 'main.js'), 'first'); const first = await digestTree(directory);
    assert.equal(await digestTree(directory), first);
    await writeFile(join(directory, 'main.js'), 'second'); assert.notEqual(await digestTree(directory), first);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
