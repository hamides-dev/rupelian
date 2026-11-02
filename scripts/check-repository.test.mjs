import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'rupelian-git-test-'));
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git(['init', '-q']);
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('./check-repository.mjs', import.meta.url), join(root, 'scripts/check-repository.mjs'));
    const check = () => spawnSync(process.execPath, [join(root, 'scripts/check-repository.mjs')], { encoding: 'utf8', windowsHide: true });
    run({ root, git, check });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('repository guard inspects the staged snapshot, not unstaged edits', () => fixture(({ root, git, check }) => {
  const file = join(root, 'source.js');
  writeFileSync(file, 'export const value = 1;\n');
  git(['add', 'source.js']);
  writeFileSync(file, `const token = '${'ghp_' + 'a'.repeat(36)}';\n`);
  assert.equal(check().status, 0);
}));

test('repository guard rejects staged credentials without printing their values', () => fixture(({ root, git, check }) => {
  const value = 'ghp_' + 'b'.repeat(36);
  writeFileSync(join(root, 'source.js'), `const token = '${value}';\n`);
  git(['add', 'source.js']);
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Possible credential/);
  assert.ok(!result.stderr.includes(value));
}));

test('repository guard rejects runtime binaries and user data', () => fixture(({ root, git, check }) => {
  for (const name of ['runtime.dll', '.env', 'credentials.json', 'library.sqlite3']) writeFileSync(join(root, name), 'fixture');
  git(['add', 'runtime.dll', '.env', 'credentials.json', 'library.sqlite3']);
  const result = check();
  assert.notEqual(result.status, 0);
  for (const name of ['runtime.dll', '.env', 'credentials.json', 'library.sqlite3']) assert.ok(result.stderr.includes(name));
}));

test('repository guard rejects unexpectedly large source blobs', () => fixture(({ root, git, check }) => {
  writeFileSync(join(root, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 65));
  git(['add', 'large.txt']);
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /5 MiB/);
}));
