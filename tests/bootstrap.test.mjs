import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dependencyState } from '../scripts/runtime-dependencies.mjs';

test('bootstrap detects changed lockfiles and missing or mismatched runtime packages', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pocketlink-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'node_modules/example'), { recursive: true });
  await mkdir(path.join(root, '.runtime'));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ dependencies: { example: '^1.0.0' } }),
  );
  const lock = { packages: { 'node_modules/example': { version: '1.0.0' } } };
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  assert.equal((await dependencyState(root)).valid, false);
  await writeFile(path.join(root, 'node_modules/example/package.json'), '{"version":"1.0.0"}');
  const state = await dependencyState(root);
  assert.equal(state.valid, true);
  assert.equal(state.ready, false);
  await writeFile(
    path.join(root, '.runtime/dependencies.json'),
    JSON.stringify({ fingerprint: state.fingerprint }),
  );
  assert.equal((await dependencyState(root)).ready, true);
  lock.packages['node_modules/transitive'] = { version: '1.0.0' };
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  assert.equal(
    (await dependencyState(root)).valid,
    false,
    'missing transitive runtime dependencies must be repaired',
  );
  delete lock.packages['node_modules/transitive'];
  lock.packages['node_modules/example'].version = '1.1.0';
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  assert.equal((await dependencyState(root)).ready, false);
  await writeFile(path.join(root, 'node_modules/example/package.json'), '{"version":"1.1.0"}');
  assert.equal(
    (await dependencyState(root)).ready,
    false,
    'a changed lockfile must be installed before recording',
  );
});

test(
  'Windows bootstrap scripts parse; setup skips installed components and reports install attempts',
  { skip: process.platform !== 'win32' },
  () => {
    const result = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'tests/bootstrap-windows.ps1',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.match(result, /PASS/);
  },
);

test(
  'Windows driver management isolates endpoints and handles uninstall safely',
  { skip: process.platform !== 'win32' },
  () => {
    const result = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'tests/cable-management-windows.ps1',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.match(result, /PASS driver naming/);
  },
);
