import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';
import { CognitoIdentityClient } from '@aws-sdk/client-cognito-identity';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { main, type CliIO } from '../src/index.js';
import { configHash, productionConfig } from '../src/config.js';
import { FileStore } from '../src/store.js';
import type { Session } from '../src/types.js';

const envKeys = ['ONOCOMM_PORTAL_HOME', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED'] as const;
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let sandbox: string;
let networkCalls = 0;
const secrets = ['fixture-cli-id-token', 'fixture-cli-access-token', 'fixture-cli-refresh-token', 'fixture-cli-otp-secret'];

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'portal-cli-test-'));
  process.env.ONOCOMM_PORTAL_HOME = sandbox;
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(sandbox, 'no-credentials');
  process.env.AWS_CONFIG_FILE = join(sandbox, 'no-config');
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  const forbidden = async (): Promise<never> => { networkCalls++; throw new Error('Network is forbidden in CLI tests'); };
  mock.method(globalThis, 'fetch', forbidden);
  mock.method(CognitoIdentityClient.prototype, 'send', forbidden);
  mock.method(CognitoIdentityProviderClient.prototype, 'send', forbidden);
});

after(async () => {
  mock.restoreAll();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  await rm(sandbox, { recursive: true, force: true });
  assert.equal(networkCalls, 0, 'No CLI test may attempt AWS, OTP or other network activity');
});

async function isolate(): Promise<FileStore> {
  process.env.ONOCOMM_PORTAL_HOME = await mkdtemp(join(sandbox, 'case-'));
  return new FileStore();
}

async function invoke(argv: string[], chunks: (string | Buffer)[] = []) {
  let stdout = '';
  let stderr = '';
  let consumed = false;
  const io: CliIO = {
    stdout: value => { stdout += value; }, stderr: value => { stderr += value; }, isTTY: false,
    stdin: (async function* () { consumed = true; for (const chunk of chunks) yield chunk; })(),
  };
  const code = await main(argv, io);
  for (const secret of secrets) {
    assert.ok(!stdout.includes(secret), 'stdout must not contain tokens or OTP material');
    assert.ok(!stderr.includes(secret), 'stderr must not contain tokens or OTP material');
  }
  return { code, stdout, stderr, consumed };
}

function success(result: Awaited<ReturnType<typeof invoke>>) {
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1, 'Machine output must be a single JSON document');
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.ok(Object.hasOwn(value, 'data'));
  assert.ok(Object.hasOwn(value, 'meta'));
  return value;
}

function failure(result: Awaited<ReturnType<typeof invoke>>, exitCode: number, code?: string) {
  assert.equal(result.code, exitCode);
  assert.equal(result.stdout, '', 'Errors must not contaminate stdout');
  assert.equal(result.stderr.trim().split('\n').length, 1);
  const value = JSON.parse(result.stderr);
  assert.equal(value.ok, false);
  assert.equal(typeof value.error.code, 'string');
  assert.equal(typeof value.error.message, 'string');
  if (code) assert.equal(value.error.code, code);
  return value;
}

async function cachedSession(store: FileStore, expiresAt = Date.now() + 3600000): Promise<void> {
  await store.write('session', {
    version: 1, configHash: configHash(productionConfig), tokens: {
      idToken: secrets[0]!, accessToken: secrets[1]!, refreshToken: secrets[2]!,
      expiresAt, sub: 'fixture-sub', username: 'fixture-user', clientId: productionConfig.userPoolClientId,
    },
  } satisfies Session);
  await store.write('otp', { challenge: { session: secrets[3] } });
}

test('CLI: schema, operation schema, help and version require no authentication or store access', async () => {
  const store = await isolate();
  // An unsafe base ensures discovery cannot silently depend on saved credentials.
  await chmod(process.env.ONOCOMM_PORTAL_HOME!, 0o755);
  try {
    const schema = success(await invoke(['schema']));
    assert.equal(schema.data.schemaVersion, 1);
    assert.equal(schema.data.readOnly, true);
    assert.ok(schema.data.operations.some((operation: { name: string }) => operation.name === 'domain.get'));
    const operation = success(await invoke(['--profile', 'unconfigured', 'schema', 'domain.get']));
    assert.equal(operation.data.name, 'domain.get');
    assert.match(operation.data.query, /^query /);
    for (const argv of [[], ['--help'], ['run', '--help'], ['auth', '--help'], ['domain', 'get', '--help']]) {
      const result = await invoke(argv);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /Usage:/);
      assert.equal(result.consumed, false);
    }
    const version = await invoke(['--version']);
    assert.equal(version.code, 0);
    assert.equal(version.stderr, '');
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
    assert.deepEqual(await readdir(process.env.ONOCOMM_PORTAL_HOME!), []);
    await assert.rejects(() => lstat(store.directory), { code: 'ENOENT' });
  } finally { await chmod(process.env.ONOCOMM_PORTAL_HOME!, 0o700); }
});

test('CLI: public production defaults and unconfigured profile diagnostics contain no auth secrets', async () => {
  await isolate();
  assert.deepEqual(success(await invoke(['config', 'show'])).data, productionConfig);
  failure(await invoke(['--profile', 'unconfigured', 'config', 'show']), 3, 'CONFIG_REQUIRED');
  const state = success(await invoke(['auth', 'status']));
  assert.equal(state.data.status, 'login_required');
  assert.equal(state.data.verifiedOnline, false);
});

test('CLI: unknown operations, mutation paths, arbitrary GraphQL and unknown flags fail before login', async () => {
  await isolate();
  for (const argv of [
    ['run', 'not-an-operation'], ['schema', 'domain.delete'], ['run', 'domain.create'],
    ['run', 'customer.update'], ['run', 'support-case.comment'], ['run', 'mutation'],
    ['run', 'mutation { forbidden }'], ['run', 'query { arbitrary }'],
  ]) failure(await invoke(argv), 3, 'UNKNOWN_OPERATION');
  for (const argv of [
    ['mutation'], ['graphql', '--query', 'mutation { forbidden }'], ['domain', 'delete'],
    ['schema', '--unknown'], ['domain', 'list', '--unknown'], ['run', 'domain.list', '--query', 'query { arbitrary }'],
    ['--output', 'yaml', 'schema'], ['--profile', '../escape', 'config', 'show'],
    ['domain', 'list', '--role-arn', 'arn:aws:iam::000000000000:role/forbidden'],
    ['domain', 'list', '--user-id', 'forged'], ['auth', 'login-verify', '--code', secrets[3]!],
  ]) failure(await invoke(argv), 3);
});

test('CLI: run validates JSON, required fields, primitive types, limits and authorization variables before authentication', async () => {
  await isolate();
  for (const argv of [
    ['run', 'domain.get', '--input', '{}'], ['domain', 'get'],
    ['run', 'domain.get', '--input', '{"domain_name":1}'],
    ['run', 'domain.list', '--input', '{"limit":"2"}'],
    ['domain', 'list', '--limit', '1.5'], ['domain', 'list', '--limit', '1e2'],
    ['domain', 'list', '--limit', '9007199254740992'],
    ['domain', 'list', '--limit', '0'], ['domain', 'list', '--limit', '1001'],
    ['invoice', 'list', '--invoice-flag', 'test', '--start-date', 'yesterday', '--end-date', '20261231'],
    ['run', 'domain.get', '--input', '{"domain_name":"example.test"}', '--all'],
    ['domain', 'list', '--max-pages', '0'], ['domain', 'list', '--max-pages', '10001'],
  ]) failure(await invoke(argv), 3);
  for (const name of ['customer_no', 'customer_group', 'user_id', 'auth_user_id', 'admin_flag', 'unknown']) {
    failure(await invoke(['run', 'domain.list', '--input', JSON.stringify({ [name]: 'forged' })]), 3, 'INVALID_INPUT');
  }
  for (const json of ['{', '[]', 'null', '"value"']) failure(await invoke(['run', 'domain.get', '--input', json]), 3);
});

test('CLI: valid read inputs reach LOGIN_REQUIRED, with JSON only on stderr and auth exit code 2', async () => {
  await isolate();
  for (const argv of [
    ['domain', 'get', '--domain-name', 'example.test'],
    ['run', 'domain.get', '--input', '{"domain_name":"example.test"}'],
    ['domain', 'list', '--all', '--limit', '1000', '--max-pages', '10000'],
    ['invoice', 'list', '--invoice-flag', 'test', '--start-date', '20260101', '--end-date', '20261231'],
    ['support-case', 'comments', '--case-id', 'fixture-case'],
  ]) failure(await invoke(argv), 2, 'LOGIN_REQUIRED');
});

test('CLI: config set requires --yes before reading stdin or deleting saved authentication', async () => {
  const store = await isolate();
  await cachedSession(store);
  const result = await invoke(['config', 'set', '--file', '-'], [JSON.stringify(productionConfig)]);
  failure(result, 3, 'INVALID_ARGUMENT');
  assert.equal(result.consumed, false);
  assert.ok(await store.read('session'));
  assert.ok(await store.read('otp'));
  assert.equal(await store.read('config'), undefined);
});

test('CLI: config set consumes injected async stdin, validates config, clears only this profile and returns JSON', async () => {
  const store = await isolate();
  await cachedSession(store);
  const other = new FileStore('other');
  await other.write('session', { keep: true });
  const configured = { ...productionConfig, appsyncEndpoint: 'https://api.example.test/graphql', oauthDomain: 'https://auth.example.test' };
  const json = JSON.stringify(configured);
  const result = await invoke(['config', 'set', '--file', '-', '--yes'], [json.slice(0, 12), Buffer.from(json.slice(12))]);
  assert.equal(result.consumed, true);
  assert.deepEqual(success(result).data, { status: 'configured', profile: 'production' });
  assert.deepEqual(await store.read('config'), configured);
  assert.equal(await store.read('session'), undefined);
  assert.equal(await store.read('otp'), undefined);
  assert.deepEqual(await other.read('session'), { keep: true });
  assert.deepEqual(success(await invoke(['config', 'show'])).data, configured);
});

test('CLI: invalid config/stdin fails without deleting authentication or echoing secrets', async () => {
  const store = await isolate();
  await cachedSession(store);
  for (const chunks of [
    ['{', secrets[0]!],
    [JSON.stringify({ ...productionConfig, appsyncEndpoint: 'http://api.example.test/graphql' })],
    [JSON.stringify({ ...productionConfig, roleArn: secrets[1] })],
    ['x'.repeat(131073)],
  ]) {
    failure(await invoke(['config', 'set', '--file', '-', '--yes'], chunks), 3);
    assert.ok(await store.read('session'));
    assert.ok(await store.read('otp'));
    assert.equal(await store.read('config'), undefined);
  }
});

test('CLI: input-file - parses chunked JSON and validates it before requesting a session', async () => {
  await isolate();
  const valid = await invoke(['run', 'domain.get', '--input-file', '-'], ['{"domain_', Buffer.from('name":"example.test"}')]);
  assert.equal(valid.consumed, true);
  failure(valid, 2, 'LOGIN_REQUIRED');
  failure(await invoke(['run', 'domain.list', '--input-file', '-'], ['{"user_id":"forged"}']), 3, 'INVALID_INPUT');
  failure(await invoke(['run', 'domain.list', '--input-file', '-'], [secrets[0]!]), 3, 'INVALID_JSON');
  failure(await invoke(['run', 'domain.list', '--input-file', join(process.env.ONOCOMM_PORTAL_HOME!, 'missing')]), 3, 'INVALID_JSON');
});

test('CLI: cached, expired and mismatched status never exposes or verifies stored tokens', async () => {
  const store = await isolate();
  await cachedSession(store);
  const cached = success(await invoke(['auth', 'status']));
  assert.equal(cached.data.status, 'cached_session');
  assert.equal(cached.data.refreshable, true);
  assert.equal(cached.data.verifiedOnline, false);
  assert.ok(Number.isFinite(Date.parse(cached.data.tokenValidUntil)));
  assert.deepEqual(success(await invoke(['status'])).data, cached.data);
  await cachedSession(store, 1);
  assert.equal(success(await invoke(['auth', 'status'])).data.status, 'login_required');
  await store.write('session', { version: 1, configHash: 'other-config', tokens: { refreshToken: secrets[2], expiresAt: Date.now() + 3600000 } });
  const mismatch = success(await invoke(['auth', 'status']));
  assert.equal(mismatch.data.status, 'login_required');
  assert.equal(mismatch.data.refreshable, false);
  assert.equal(mismatch.data.tokenValidUntil, null);
});

test('CLI: local-only logout removes this profile tokens without Cognito or OTP requests', async () => {
  const store = await isolate();
  await cachedSession(store);
  const other = new FileStore('other');
  await other.write('session', { keep: true });
  const result = success(await invoke(['auth', 'logout', '--local-only']));
  assert.equal(result.data.status, 'logged_out');
  assert.equal(result.data.remoteRevoked, false);
  assert.equal(await store.read('session'), undefined);
  assert.equal(await store.read('otp'), undefined);
  assert.deepEqual(await other.read('session'), { keep: true });
});

test('CLI: unsafe store and corrupt saved JSON return exit 5 without exposing contents', async () => {
  const store = await isolate();
  await store.read('session');
  const file = join(store.directory, 'session.json');
  await writeFile(file, secrets[0]!, { mode: 0o600 });
  failure(await invoke(['auth', 'status']), 5, 'STORE_ERROR');
  if (process.platform !== 'win32') {
    await chmod(store.directory, 0o755);
    failure(await invoke(['auth', 'status']), 5, 'UNSAFE_STORE');
    await chmod(store.directory, 0o700);
  }
});

test('CLI: noninteractive auth rejects missing stdin flags/manual interaction before any network call', async () => {
  await isolate();
  failure(await invoke(['--non-interactive', 'auth', 'login-verify']), 3, 'STDIN_REQUIRED');
  failure(await invoke(['--non-interactive', 'auth', 'login', '--manual']), 3, 'INTERACTION_REQUIRED');
  failure(await invoke(['auth', 'import']), 3, 'INVALID_ARGUMENT');
});
