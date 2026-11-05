import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';
import { inspect } from 'node:util';
import { CognitoIdentityClient, GetCredentialsForIdentityCommand, GetIdCommand } from '@aws-sdk/client-cognito-identity';
import { getOperation, type Operation } from '../src/catalog.js';
import {
  exchangeIdentity, executeQuery, runOperation, validateInput,
  type IdentityResponse, type TemporaryCredentials,
} from '../src/client.js';
import { CliError, type PortalConfig } from '../src/types.js';

const config: PortalConfig = {
  region: 'ap-northeast-1', userPoolId: 'ap-northeast-1_TestPool', userPoolClientId: 'publicclient',
  identityPoolId: 'ap-northeast-1:00000000-0000-0000-0000-000000000000',
  oauthDomain: 'https://auth.example.test', appsyncEndpoint: 'https://api.example.test/graphql',
  redirectUri: 'http://127.0.0.1:19878/callback', scopes: ['openid'],
};
const detail = getOperation('domain.get')!;
const list = getOperation('domain.list')!;
const secrets = ['fixture-id-token', 'fixture-temporary-secret', 'fixture-session-token', 'fixture-ambient-secret'];
const credentials = (): TemporaryCredentials => ({
  accessKeyId: 'FIXTURETEMPORARYKEY', secretAccessKey: secrets[1]!, sessionToken: secrets[2]!,
  expiration: new Date(Date.now() + 3600000),
});
const envKeys = ['ONOCOMM_PORTAL_HOME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED'] as const;
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let sandbox: string;
let networkCalls = 0;

test('GraphQL: HTTP 200内の認可拒否も安全な終了コード2へ分類する', async () => {
  for (const error of [
    { errorType: 'Unauthorized', message: 'fixture-private-message' },
    { extensions: { errorType: 'AccessDeniedException' }, message: 'fixture-private-message' },
    { extensions: { code: 'FORBIDDEN' }, message: 'fixture-private-message' },
  ]) {
    await assert.rejects(executeQuery(config, credentials(), detail, { domain_name: 'example.test' },
      async () => new Response(JSON.stringify({ data: { getDomain: { fixture: true } }, errors: [error] }), { status: 200 })),
    (problem: unknown) => problem instanceof CliError && problem.code === 'ACCESS_DENIED'
      && problem.exitCode === 2 && !problem.message.includes('fixture-private-message'));
  }
});

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'portal-client-test-'));
  process.env.ONOCOMM_PORTAL_HOME = sandbox;
  process.env.AWS_ACCESS_KEY_ID = 'FIXTUREAMBIENTKEY';
  process.env.AWS_SECRET_ACCESS_KEY = secrets[3];
  process.env.AWS_SESSION_TOKEN = 'fixture-ambient-session';
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(sandbox, 'no-credentials');
  process.env.AWS_CONFIG_FILE = join(sandbox, 'no-config');
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  const forbidden = async (): Promise<never> => { networkCalls++; throw new Error('Network is forbidden in client tests'); };
  mock.method(globalThis, 'fetch', forbidden);
  mock.method(CognitoIdentityClient.prototype, 'send', forbidden);
});

after(async () => {
  mock.restoreAll();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  await rm(sandbox, { recursive: true, force: true });
  assert.equal(networkCalls, 0, 'All Identity and GraphQL calls must use injected fakes');
});

function problem(code: string, exitCode: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, code);
    assert.equal(error.exitCode, exitCode);
    assert.equal(error.cause, undefined);
    const visible = inspect(error, { depth: 8 }) + JSON.stringify(error);
    for (const value of secrets) assert.ok(!visible.includes(value), 'Raw secrets must not appear in errors');
    return true;
  };
}

test('validateInput: required fields, unknown fields and proxy authorization variables fail closed', () => {
  for (const input of [undefined, null, [], 'example.test', 1, {}, { domain_name: null }, { domain_name: '' }, { domain_name: '  ' }]) {
    assert.throws(() => validateInput(detail, input), problem('INVALID_INPUT', 3));
  }
  for (const name of ['unknown', 'user_id', 'auth_user_id', 'customer_group', 'admin_flag', 'roleArn', 'Logins', 'query', 'variables']) {
    assert.throws(() => validateInput(detail, { domain_name: 'example.test', [name]: 'forged' }), problem('INVALID_INPUT', 3));
  }
  for (const name of ['customer_no', 'user_id', 'auth_user_id', 'customer_group', 'admin_flag']) {
    assert.throws(() => validateInput(list, { [name]: 'forged' }), problem('INVALID_INPUT', 3));
  }
  assert.throws(() => validateInput(detail, JSON.parse('{"domain_name":"example.test","__proto__":{}}')), problem('INVALID_INPUT', 3));
});

test('validateInput: exact primitive types, integer safety and string bounds are enforced', () => {
  const typed: Operation = { ...detail, parameters: [
    ...detail.parameters,
    { name: 'count', type: 'integer', required: true, description: '' },
    { name: 'enabled', type: 'boolean', required: true, description: '' },
  ] };
  const valid = { domain_name: 'example.test', count: 0, enabled: false };
  assert.deepEqual(validateInput(typed, valid), valid);
  assert.notEqual(validateInput(typed, valid), valid);
  for (const value of ['1', true, null, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateInput(typed, { ...valid, count: value }), problem('INVALID_INPUT', 3));
  }
  for (const value of ['true', 'false', 0, 1, null, undefined]) {
    assert.throws(() => validateInput(typed, { ...valid, enabled: value }), problem('INVALID_INPUT', 3));
  }
  for (const value of [0, false, {}, ['example.test'], 'x'.repeat(131073)]) {
    assert.throws(() => validateInput(detail, { domain_name: value }), problem('INVALID_INPUT', 3));
  }
  assert.deepEqual(validateInput(detail, { domain_name: 'x'.repeat(131072) }), { domain_name: 'x'.repeat(131072) });
  const invoice = getOperation('invoice.list')!;
  assert.deepEqual(validateInput(invoice, { invoice_flag: 'test', start_date: 20260101, end_date: 20261231 }),
    { invoice_flag: 'test', start_date: 20260101, end_date: 20261231 });
  assert.throws(() => validateInput(invoice, { invoice_flag: 'test', start_date: '20260101', end_date: 20261231 }), problem('INVALID_INPUT', 3));
});

test('validateInput: pagination permits only bounded integer limits and nonempty string tokens', () => {
  for (const limit of [1, 1000]) assert.deepEqual(validateInput(list, { limit, nextToken: 'opaque' }), { limit, nextToken: 'opaque' });
  for (const limit of [0, -1, 1001, 1.1, '10', null, true, NaN, Infinity]) {
    assert.throws(() => validateInput(list, { limit }), problem('INVALID_INPUT', 3));
  }
  for (const nextToken of ['', ' ', 1, {}, null]) {
    assert.throws(() => validateInput(list, { nextToken }), problem('INVALID_INPUT', 3));
  }
  for (const input of [{ domain_name: 'example.test', limit: 1 }, { domain_name: 'example.test', nextToken: 'opaque' }]) {
    assert.throws(() => validateInput(detail, input), problem('INVALID_INPUT', 3));
  }
});

test('Identity exchange: both commands carry only the signed-in user ID token, never a role or ambient credentials', async () => {
  const issued = credentials();
  const commands: unknown[] = [];
  const result = await exchangeIdentity(config, secrets[0]!, async command => {
    commands.push(command);
    if (command instanceof GetIdCommand) return { IdentityId: 'fixture-identity' };
    assert.ok(command instanceof GetCredentialsForIdentityCommand);
    return { Credentials: { AccessKeyId: issued.accessKeyId, SecretKey: issued.secretAccessKey,
      SessionToken: issued.sessionToken, Expiration: issued.expiration } };
  });
  assert.equal(commands.length, 2);
  assert.ok(commands[0] instanceof GetIdCommand);
  assert.ok(commands[1] instanceof GetCredentialsForIdentityCommand);
  const logins = { [`cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`]: secrets[0] };
  assert.deepEqual(commands[0].input, { IdentityPoolId: config.identityPoolId, Logins: logins });
  assert.deepEqual(commands[1].input, { IdentityId: 'fixture-identity', Logins: logins });
  assert.deepEqual(result, issued);
  assert.notEqual(result.accessKeyId, process.env.AWS_ACCESS_KEY_ID);
  assert.ok(!JSON.stringify(commands).includes(secrets[3]!));
});

test('Identity exchange: missing identity stops before credential exchange; raw SDK errors are sanitized', async () => {
  let calls = 0;
  await assert.rejects(() => exchangeIdentity(config, secrets[0]!, async () => { calls++; return {}; }), problem('IDENTITY_AUTH_FAILED', 2));
  assert.equal(calls, 1);
  for (const failAt of [1, 2]) {
    calls = 0;
    await assert.rejects(() => exchangeIdentity(config, secrets[0]!, async () => {
      if (++calls === failAt) throw Object.assign(new Error(secrets.join(' ')), { credentials: secrets });
      return { IdentityId: 'fixture-identity' };
    }), problem('IDENTITY_AUTH_FAILED', 2));
    assert.equal(calls, failAt);
  }
});

test('Identity exchange: incomplete and expired credentials must be rejected', async (t) => {
  const complete = { AccessKeyId: 'FIXTURETEMPORARYKEY', SecretKey: secrets[1], SessionToken: secrets[2], Expiration: new Date(Date.now() + 3600000) };
  const cases: [string, IdentityResponse['Credentials']][] = [
    ['missing credentials', undefined],
    ...Object.keys(complete).map(key => [key, { ...complete, [key]: undefined }] as [string, IdentityResponse['Credentials']]),
    ['expired', { ...complete, Expiration: new Date(0) }],
  ];
  for (const [name, value] of cases) await t.test(name, async () => {
    await assert.rejects(() => exchangeIdentity(config, secrets[0]!, async command => command instanceof GetIdCommand
      ? { IdentityId: 'fixture-identity' } : { Credentials: value }), problem('IDENTITY_AUTH_FAILED', 2));
  });
});

test('Identity exchange: invalid-date credentials must be rejected rather than treated as unexpired', async () => {
  await assert.rejects(() => exchangeIdentity(config, secrets[0]!, async command => command instanceof GetIdCommand
    ? { IdentityId: 'fixture-identity' }
    : { Credentials: { AccessKeyId: 'FIXTURETEMPORARYKEY', SecretKey: secrets[1], SessionToken: secrets[2], Expiration: new Date(NaN) } }),
  problem('IDENTITY_AUTH_FAILED', 2));
});

test('GraphQL: SigV4 signs exact query/variables with temporary credentials and rejects redirects', async () => {
  const input = { domain_name: 'example.test' };
  const issued = credentials();
  let calls = 0;
  const result = await executeQuery(config, issued, detail, input, async (url, init) => {
    calls++;
    assert.equal(String(url), config.appsyncEndpoint);
    assert.equal(init?.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.deepEqual(JSON.parse(String(init.body)), { query: detail.query, variables: input });
    const headers = new Headers(init.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('host'), new URL(config.appsyncEndpoint).host);
    assert.equal(headers.get('x-amz-security-token'), issued.sessionToken);
    assert.match(headers.get('x-amz-date')!, /^\d{8}T\d{6}Z$/);
    const authorization = headers.get('authorization')!;
    assert.match(authorization, /^AWS4-HMAC-SHA256 /);
    assert.ok(authorization.includes(`Credential=${issued.accessKeyId}/`));
    assert.ok(authorization.includes(`/${config.region}/appsync/aws4_request`));
    assert.match(authorization, /SignedHeaders=[^,]*content-type[^,]*host[^,]*x-amz-date[^,]*x-amz-security-token/);
    assert.match(authorization, /Signature=[a-f0-9]{64}$/);
    assert.ok(!authorization.includes('FIXTUREAMBIENTKEY'));
    assert.ok(!String(init.body).includes(secrets[0]!));
    assert.ok(!String(init.body).includes(issued.secretAccessKey));
    return Response.json({ data: { [detail.field]: { domain_name: 'example.test' } } });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, input);
});

test('GraphQL: changing variables changes the SigV4 signature and variables are not interpolated into query text', async () => {
  const signatures: string[] = [];
  const issued = credentials();
  for (const domain_name of ['example.test', '\" } mutation { forbidden } #']) {
    await executeQuery(config, issued, detail, { domain_name }, async (_url, init) => {
      signatures.push(new Headers(init!.headers).get('authorization')!);
      assert.deepEqual(JSON.parse(String(init!.body)), { query: detail.query, variables: { domain_name } });
      return Response.json({ data: { [detail.field]: null } });
    });
  }
  assert.notEqual(signatures[0], signatures[1]);
});

test('GraphQL: HTTP, transport, invalid JSON and partial GraphQL errors never expose raw secrets', async (t) => {
  const cases: [string, () => Promise<Response>, string, number][] = [
    ['unauthorized', async () => new Response(secrets.join(' '), { status: 401 }), 'ACCESS_DENIED', 2],
    ['forbidden', async () => new Response(secrets.join(' '), { status: 403 }), 'ACCESS_DENIED', 2],
    ['server error', async () => new Response(secrets.join(' '), { status: 500 }), 'API_HTTP_ERROR', 4],
    ['redirect', async () => new Response('', { status: 302, headers: { location: 'https://other.example.test' } }), 'API_HTTP_ERROR', 4],
    ['transport', async () => { throw new Error(secrets.join(' ')); }, 'API_CONNECTION_FAILED', 4],
    ['malformed JSON', async () => new Response(secrets.join(' ')), 'API_CONNECTION_FAILED', 4],
    ['partial data', async () => Response.json({ data: { [detail.field]: { domain_name: 'example.test' } }, errors: [{ message: secrets.join(' '), extensions: { token: secrets[0] } }] }), 'GRAPHQL_ERROR', 4],
    ['only errors', async () => Response.json({ errors: [{ message: secrets[1] }] }), 'GRAPHQL_ERROR', 4],
    ['malformed errors', async () => Response.json({ data: { [detail.field]: null }, errors: { message: secrets[0] } }), 'GRAPHQL_ERROR', 4],
    ['null response', async () => Response.json(null), 'GRAPHQL_ERROR', 4],
    ['missing data', async () => Response.json({}), 'INVALID_API_RESPONSE', 4],
    ['missing selected field', async () => Response.json({ data: { other: secrets[0] } }), 'INVALID_API_RESPONSE', 4],
  ];
  for (const [name, fetcher, code, exitCode] of cases) await t.test(name, async () => {
    await assert.rejects(() => executeQuery(config, credentials(), detail, { domain_name: 'example.test' }, fetcher), problem(code, exitCode));
  });
});

test('GraphQL: an explicitly null field and an empty errors array are valid results', async () => {
  assert.equal(await executeQuery(config, credentials(), detail, { domain_name: 'example.test' },
    async () => Response.json({ data: { [detail.field]: null }, errors: [] })), null);
});

test('pagination: empty pages with nextToken continue, preserving filters and caller input', async () => {
  const operation = getOperation('support-case.list')!;
  const input = Object.freeze({ status: 'fixture-status', limit: 2 });
  const seen: Record<string, unknown>[] = [];
  const pages = [{ items: [], nextToken: 'page-2' }, { items: [{ case_id: 'fixture-case' }], nextToken: 'page-3' }, { items: [], nextToken: null }];
  const result = await runOperation(operation, input, async variables => {
    seen.push({ ...variables });
    return pages[seen.length - 1];
  }, true);
  assert.deepEqual(seen, [input, { ...input, nextToken: 'page-2' }, { ...input, nextToken: 'page-3' }]);
  assert.deepEqual(input, { status: 'fixture-status', limit: 2 });
  assert.deepEqual(result, { data: [{ case_id: 'fixture-case' }], meta: { operation: operation.name, pages: 3, nextToken: null } });
});

test('pagination: single-page mode returns the continuation token without fetching further', async () => {
  let calls = 0;
  const result = await runOperation(list, { nextToken: 'start' }, async variables => {
    calls++;
    assert.equal(variables.nextToken, 'start');
    return { items: [], nextToken: 'continue' };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { data: [], meta: { operation: list.name, pages: 1, nextToken: 'continue' } });
});

test('pagination: repeated tokens, including the initial token, fail rather than returning partial success', async () => {
  for (const input of [{}, { nextToken: 'same' }]) {
    let calls = 0;
    await assert.rejects(() => runOperation(list, input, async () => {
      calls++; return { items: [{ domain_name: 'example.test' }], nextToken: 'same' };
    }, true), problem('PAGINATION_LOOP', 4));
    assert.equal(calls, 'nextToken' in input ? 1 : 2);
  }
  let calls = 0;
  await assert.rejects(() => runOperation(list, {}, async () => ({ items: [], nextToken: ['a', 'b', 'a'][calls++] }), true), problem('PAGINATION_LOOP', 4));
  assert.equal(calls, 3);
});

test('pagination: maxPages is enforced and invalid limits or non-list --all never execute', async () => {
  let calls = 0;
  await assert.rejects(() => runOperation(list, {}, async () => ({ items: [], nextToken: `page-${++calls}` }), true, 2), problem('PAGINATION_LIMIT', 4));
  assert.equal(calls, 2);
  for (const maxPages of [0, -1, 1.5, 10001, NaN, Infinity]) {
    await assert.rejects(() => runOperation(list, {}, async () => { assert.fail('Invalid limit must not execute'); }, true, maxPages), problem('INVALID_INPUT', 3));
  }
  await assert.rejects(() => runOperation(detail, { domain_name: 'example.test' }, async () => { assert.fail('Non-list --all must not execute'); }, true), problem('INVALID_INPUT', 3));
  const result = await runOperation(detail, { domain_name: 'example.test' }, async () => null);
  assert.deepEqual(result, { data: null, meta: { operation: detail.name } });
});

test('pagination: malformed pages and downstream errors fail the complete operation', async () => {
  for (const page of [null, {}, [], { items: null }, { items: {} }, { items: [], nextToken: 1 }]) {
    await assert.rejects(() => runOperation(list, {}, async () => page, true), problem('INVALID_API_RESPONSE', 4));
  }
  let calls = 0;
  await assert.rejects(() => runOperation(list, {}, async () => {
    if (++calls === 2) throw new CliError('GRAPHQL_ERROR', 'fixture failure', 4);
    return { items: [{ domain_name: 'example.test' }], nextToken: 'second' };
  }, true), problem('GRAPHQL_ERROR', 4));
  assert.equal(calls, 2);
  assert.deepEqual(await runOperation(list, {}, async () => ({ items: [] }), true, 1),
    { data: [], meta: { operation: list.name, pages: 1, nextToken: null } });
});
