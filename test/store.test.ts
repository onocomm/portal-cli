import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { after, before, mock, test } from 'node:test';
import { FileStore } from '../src/store.js';
import { CliError } from '../src/types.js';

const originalHome = process.env.ONOCOMM_PORTAL_HOME;
const isWindows = process.platform === 'win32';
const posixOnly = { skip: isWindows ? 'POSIX permissions/ownership or symlink support required' : false };
let sandbox: string;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'portal-store-test-'));
  process.env.ONOCOMM_PORTAL_HOME = sandbox;
});

after(async () => {
  mock.restoreAll();
  if (originalHome === undefined) delete process.env.ONOCOMM_PORTAL_HOME;
  else process.env.ONOCOMM_PORTAL_HOME = originalHome;
  await rm(sandbox, { recursive: true, force: true });
});

async function fixture(profile = 'fixture'): Promise<FileStore> {
  const base = await mkdtemp(join(sandbox, 'case-'));
  process.env.ONOCOMM_PORTAL_HOME = base;
  return new FileStore(profile);
}

function problem(code = 'UNSAFE_STORE', exitCode = 5) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, code);
    assert.equal(error.exitCode, exitCode);
    return true;
  };
}

test('store: ONOCOMM_PORTAL_HOME isolates profiles and saves entries with POSIX permissions where supported', async () => {
  const store = await fixture('separate');
  assert.equal(store.directory, join(process.env.ONOCOMM_PORTAL_HOME!, 'separate'));
  assert.equal(await store.read('session'), undefined);
  for (const name of ['config', 'session', 'otp']) {
    await store.write(name, { fixture: name });
    assert.deepEqual(await store.read(name), { fixture: name });
    if (!isWindows) assert.equal((await lstat(join(store.directory, `${name}.json`))).mode & 0o777, 0o600);
  }
  if (!isWindows) {
    assert.equal((await lstat(dirname(store.directory))).mode & 0o777, 0o700);
    assert.equal((await lstat(store.directory)).mode & 0o777, 0o700);
  }
  const other = new FileStore('other');
  assert.equal(await other.read('session'), undefined);
  await other.write('session', { isolated: true });
  assert.deepEqual(await store.read('session'), { fixture: 'session' });
});

test('store: path traversal, invalid profile names and unsafe root/home destinations are rejected', async () => {
  await fixture();
  for (const profile of ['', '.', '..', '../escape', 'a/b', 'a\\b', '/absolute', 'a b', 'x'.repeat(65), '\u0000', '顧客']) {
    assert.throws(() => new FileStore(profile), problem('INVALID_PROFILE', 3));
  }
  for (const profile of ['production', 'develop_2-test', 'A'.repeat(64)]) assert.doesNotThrow(() => new FileStore(profile));
  assert.throws(() => new FileStore('fixture', parse(sandbox).root), problem());
  assert.throws(() => new FileStore('fixture', homedir()), problem());
  const store = new FileStore();
  for (const name of ['../escape', 'session.json', 'unknown', '/tmp/escape']) {
    await assert.rejects(() => store.read(name), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 5);
      assert.ok(['STORE_ERROR', 'UNSAFE_STORE'].includes(error.code));
      return true;
    });
    await assert.rejects(() => store.write(name, {}), problem('STORE_ERROR'));
    await assert.rejects(() => store.remove(name), problem('STORE_ERROR'));
  }
});

test('store: unsafe base/profile directory permissions are refused without repairing them', posixOnly, async () => {
  for (const location of ['base', 'profile']) {
    const store = await fixture();
    await store.write('session', { original: true });
    const directory = location === 'base' ? dirname(store.directory) : store.directory;
    for (const mode of [0o755, 0o770, 0o707]) {
      await chmod(directory, mode);
      await assert.rejects(() => store.read('session'), problem());
      await assert.rejects(() => store.write('session', { changed: true }), problem());
      await assert.rejects(() => store.withLock(async () => { assert.fail('Unsafe directory must not lock'); }), problem());
      assert.equal((await lstat(directory)).mode & 0o777, mode);
    }
    await chmod(directory, 0o700);
    assert.deepEqual(await store.read('session'), { original: true });
  }
});

test('store: symlinked base/profile directories are refused without touching the target', posixOnly, async () => {
  for (const location of ['base', 'profile']) {
    const parent = await mkdtemp(join(sandbox, 'links-'));
    const target = join(parent, 'target');
    await mkdir(target, { mode: 0o700 });
    const base = join(parent, 'base');
    if (location === 'base') await symlink(target, base, 'dir');
    else { await mkdir(base, { mode: 0o700 }); await symlink(target, join(base, 'fixture'), 'dir'); }
    const store = new FileStore('fixture', base);
    await assert.rejects(() => store.read('session'), problem());
    await assert.rejects(() => store.write('session', { forbidden: true }), problem());
    assert.deepEqual(await readdir(target), []);
  }
});

test('store: session symlinks, including dangling links, are never followed or replaced', posixOnly, async () => {
  for (const dangling of [false, true]) {
    const store = await fixture();
    await store.read('session');
    const target = join(dirname(store.directory), 'target.json');
    if (!dangling) await writeFile(target, '{"original":true}', { mode: 0o600 });
    const destination = join(store.directory, 'session.json');
    await symlink(target, destination);
    await assert.rejects(() => store.read('session'), problem());
    await assert.rejects(() => store.write('session', { changed: true }), problem());
    assert.equal(await readlink(destination), target);
    if (!dangling) assert.equal(await readFile(target, 'utf8'), '{"original":true}');
    else await assert.rejects(() => lstat(target), { code: 'ENOENT' });
  }
});

test('store: unsafe file permissions are refused on read', posixOnly, async () => {
  const store = await fixture();
  await store.write('session', { original: true });
  const file = join(store.directory, 'session.json');
  for (const mode of [0o644, 0o660, 0o606]) {
    await chmod(file, mode);
    await assert.rejects(() => store.read('session'), problem());
    assert.equal((await lstat(file)).mode & 0o777, mode);
  }
});

test('store: unsafe existing file permissions must also be refused on write', posixOnly, async () => {
  const store = await fixture();
  await store.write('session', { original: true });
  const file = join(store.directory, 'session.json');
  await chmod(file, 0o644);
  await assert.rejects(() => store.write('session', { changed: true }), problem());
  assert.equal(await readFile(file, 'utf8'), '{"original":true}');
  assert.equal((await lstat(file)).mode & 0o777, 0o644);
});

test('store: a mismatched effective owner is rejected before reading or changing data', posixOnly, async () => {
  const store = await fixture();
  await store.write('session', { original: true });
  const identityProcess = process as { getuid(): number };
  const uid = identityProcess.getuid();
  const owner = mock.method(identityProcess, 'getuid', () => uid + 1);
  try {
    await assert.rejects(() => store.read('session'), problem());
    await assert.rejects(() => store.write('session', { changed: true }), problem());
    await assert.rejects(() => store.withLock(async () => { assert.fail('Wrong owner must not lock'); }), problem());
  } finally { owner.mock.restore(); }
  assert.deepEqual(await store.read('session'), { original: true });
});

test('store: directories masquerading as files and oversized or corrupt JSON are refused', async () => {
  const store = await fixture();
  await store.read('session');
  await mkdir(join(store.directory, 'session.json'), { mode: 0o700 });
  await assert.rejects(() => store.read('session'), problem());
  await assert.rejects(() => store.write('session', {}), problem());
  const file = join(store.directory, 'otp.json');
  await writeFile(file, 'fixture-secret-not-json', { mode: 0o600 });
  await assert.rejects(() => store.read('otp'), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, 'STORE_ERROR');
    assert.ok(!String(error).includes('fixture-secret-not-json'));
    return true;
  });
  await writeFile(file, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(() => store.read('otp'), problem());
});

test('store: writes atomically replace an inode and leave no temporary files', async () => {
  const store = await fixture();
  await store.write('session', { generation: 1 });
  const file = join(store.directory, 'session.json');
  const old = await lstat(file);
  await store.write('session', { generation: 2, padding: 'x'.repeat(32768) });
  const current = await lstat(file);
  assert.notEqual(current.ino, old.ino);
  if (!isWindows) assert.equal(current.mode & 0o777, 0o600);
  assert.deepEqual(await store.read('session'), { generation: 2, padding: 'x'.repeat(32768) });
  assert.deepEqual(await readdir(store.directory), ['session.json']);
});

test('store: serialization failure preserves the original file and removes temporary files', async () => {
  const store = await fixture();
  await store.write('session', { original: true });
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await assert.rejects(() => store.write('session', circular));
  assert.deepEqual(await store.read('session'), { original: true });
  assert.deepEqual(await readdir(store.directory), ['session.json']);
});

test('store: concurrent atomic writes never expose truncated JSON to readers', async () => {
  const store = await fixture();
  const padding = 'x'.repeat(16384);
  await store.write('session', { generation: 0, padding });
  const writers = Array.from({ length: 12 }, (_, generation) => store.write('session', { generation: generation + 1, padding }));
  const reader = async () => {
    for (let count = 0; count < 30; count++) {
      const value = await store.read<{ generation: number; padding: string }>('session');
      assert.ok(value && Number.isInteger(value.generation));
      assert.equal(value.padding, padding);
    }
  };
  await Promise.all([...writers, reader()]);
  assert.deepEqual(await readdir(store.directory), ['session.json']);
});

test('store: locks exclude a second store instance and are removed on success or failure', async () => {
  const store = await fixture();
  const second = new FileStore(store.profile);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = store.withLock(async () => { enter(); await gate; return 'first-result'; });
  try {
    await entered;
    const lock = join(store.directory, 'lock.json');
    if (!isWindows) assert.equal((await lstat(lock)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), { pid: process.pid });
    await assert.rejects(() => second.withLock(async () => { assert.fail('Second lock must not enter'); }), problem('SESSION_BUSY'));
    assert.ok((await lstat(lock)).isFile());
    assert.equal(await new FileStore('other').withLock(async () => 'independent'), 'independent');
  } finally { release(); await first; }
  assert.equal(await first, 'first-result');
  assert.equal(await second.withLock(async () => 'second-result'), 'second-result');
  const sentinel = new Error('fixture-action-error');
  await assert.rejects(() => store.withLock(async () => { throw sentinel; }), error => error === sentinel);
  assert.equal(await second.withLock(async () => 'recovered'), 'recovered');
  assert.deepEqual(await readdir(store.directory), []);
});

test('store: a preexisting lock symlink is refused without following or deleting it', posixOnly, async () => {
  const store = await fixture();
  await store.read('session');
  const target = join(dirname(store.directory), 'target.json');
  await writeFile(target, 'original', { mode: 0o600 });
  const lock = join(store.directory, 'lock.json');
  await symlink(target, lock);
  await assert.rejects(() => store.withLock(async () => { assert.fail('Symlink lock must not enter'); }), problem('SESSION_BUSY'));
  assert.equal(await readlink(lock), target);
  assert.equal(await readFile(target, 'utf8'), 'original');
});

test('store: removing absent entries is idempotent and does not affect another profile', async () => {
  const store = await fixture();
  const other = new FileStore('other');
  await other.write('session', { keep: true });
  await store.remove('session');
  await store.write('session', { remove: true });
  await store.remove('session');
  await store.remove('session');
  assert.equal(await store.read('session'), undefined);
  assert.deepEqual(await other.read('session'), { keep: true });
});
