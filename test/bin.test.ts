import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const binary = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
test('compiled bin starts without relying on argv realpath comparison', () => {
  const result = spawnSync(process.execPath, [binary, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), '0.1.0'); assert.equal(result.stderr, '');
});
test('npm-style symlink starts the CLI', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'portal-bin-test-'));
  try {
    const link = join(root, 'onocomm-portal');
    await symlink(binary, link);
    const result = spawnSync(process.execPath, [link, '--json', 'schema', 'domain.get'], { encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).data.name, 'domain.get');
  } finally { await rm(root, { recursive: true, force: true }); }
});
