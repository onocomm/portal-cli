import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { createServer, request } from 'node:http';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { InitiateAuthCommand, RespondToAuthChallengeCommand } from '@aws-sdk/client-cognito-identity-provider';
import {
  beginEmailOtp, browserLogin, completeEmailOtp, refreshTokens, verifyTokens,
  type AuthDeps, type OtpChallenge,
} from '../src/auth.js';
import { CliError, type PortalConfig, type TokenInput } from '../src/types.js';

const config: PortalConfig = {
  region: 'ap-northeast-1', userPoolId: 'ap-northeast-1_TestPool', userPoolClientId: 'publicclient',
  identityPoolId: 'unused', oauthDomain: 'https://auth.example.test',
  appsyncEndpoint: 'https://api.example.test/graphql',
  redirectUri: 'http://127.0.0.1:19878/callback', scopes: ['openid', 'email', 'profile'],
};
const issuer = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const jwks = createLocalJWKSet({ keys: [jwk] });
const expiry = () => Math.floor(Date.now() / 1000) + 3600;
const secret = 'SECRET-TOKEN-SESSION-URL-CODE';

async function sign(payload: JWTPayload, key = privateKey, algorithm = 'RS256'): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: algorithm, kid: 'test-key' }).sign(key);
}

async function pair(
  id: JWTPayload = {}, access: JWTPayload = {}, refreshToken = 'refresh-original',
): Promise<TokenInput> {
  return {
    idToken: await sign({
      iss: issuer, aud: config.userPoolClientId, sub: 'user-sub', exp: expiry(),
      token_use: 'id', 'cognito:username': 'canonical-user', ...id,
    }),
    accessToken: await sign({
      iss: issuer, client_id: config.userPoolClientId, sub: 'user-sub', exp: expiry(),
      token_use: 'access', username: 'canonical-user', ...access,
    }),
    refreshToken,
  };
}

function tokenResponse(input: TokenInput): Response {
  return Response.json({
    id_token: input.idToken, access_token: input.accessToken,
    ...(input.refreshToken === undefined ? {} : { refresh_token: input.refreshToken }),
  });
}

async function rejectsSafe(
  action: () => Promise<unknown>, code?: string, hidden: string[] = [secret],
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof CliError);
    if (code) assert.equal(error.code, code);
    assert.match(error.message, /[\u3040-\u30ff\u4e00-\u9fff]/);
    for (const value of hidden) {
      assert.ok(!inspect(error, { depth: 5 }).includes(value));
      assert.ok(!JSON.stringify(error).includes(value));
    }
    assert.equal(error.cause, undefined);
    return true;
  });
}

function callback(authorize: URL, mutate?: (url: URL) => void): string {
  const url = new URL(config.redirectUri);
  url.searchParams.set('state', authorize.searchParams.get('state')!);
  url.searchParams.set('code', 'authorization-code');
  mutate?.(url);
  return url.toString();
}

async function manualLogin(
  deps: AuthDeps, mutate?: (url: URL) => void,
): Promise<Awaited<ReturnType<typeof browserLogin>>> {
  let authorize!: URL;
  return browserLogin(config, {
    openBrowser: false, onUrl: (url) => { authorize = new URL(url); },
    manualCallback: async () => callback(authorize, mutate),
  }, deps);
}

test('verifyTokens: RS256署名と両トークンを検証し短い有効期限を採用する', async () => {
  const exp = expiry() - 600;
  const input = await pair({ nonce: 'expected-nonce' }, { exp });
  const result = await verifyTokens(input, config, { nonce: 'expected-nonce', jwks });
  assert.deepEqual(result, {
    ...input, expiresAt: exp * 1000, sub: 'user-sub', username: 'canonical-user', clientId: config.userPoolClientId,
  });
});

test('verifyTokens: issuer/audience/token_use/client_id/exp/sub/username/nonceを拒否する', async (t) => {
  const cases: [string, JWTPayload, JWTPayload][] = [
    ['ID issuer', { iss: 'https://untrusted.example.test' }, {}],
    ['access issuer', {}, { iss: 'https://untrusted.example.test' }],
    ['audience', { aud: 'other-client' }, {}],
    ['ID token_use', { token_use: 'access' }, {}],
    ['access token_use', {}, { token_use: 'id' }],
    ['client_id', {}, { client_id: 'other-client' }],
    ['expired ID', { exp: 1 }, {}],
    ['expired access', {}, { exp: 1 }],
    ['missing ID exp', { exp: undefined }, {}],
    ['missing access exp', {}, { exp: undefined }],
    ['missing ID sub', { sub: undefined }, {}],
    ['empty sub', { sub: '' }, { sub: '' }],
    ['sub mismatch', {}, { sub: 'other-user' }],
    ['username mismatch', { 'cognito:username': 'other-user' }, {}],
    ['missing username', {}, { username: undefined }],
    ['nonce mismatch', { nonce: 'wrong' }, {}],
    ['missing nonce', {}, {}],
  ];
  for (const [name, id, access] of cases) {
    await t.test(name, async () => {
      const input = await pair(id, access);
      await rejectsSafe(() => verifyTokens(input, config, { nonce: 'expected', jwks }), 'TOKEN_INVALID',
        [input.idToken, input.accessToken, input.refreshToken!]);
    });
  }
});

test('verifyTokens: 不正署名・RS256以外・壊れたJWTを拒否し値を漏らさない', async () => {
  const input = await pair();
  const other = await generateKeyPair('RS256');
  const invalidSignature = await sign({ sub: secret }, other.privateKey);
  const { privateKey: ecKey } = await generateKeyPair('ES256');
  const esToken = await sign({ sub: secret }, ecKey, 'ES256');
  for (const idToken of [invalidSignature, esToken, secret]) {
    await rejectsSafe(() => verifyTokens({ ...input, idToken }, config, { jwks }), 'TOKEN_INVALID',
      [idToken, input.accessToken, input.refreshToken!]);
  }
  await rejectsSafe(() => verifyTokens({ ...input, accessToken: secret }, config, { jwks }), 'TOKEN_INVALID');
});

test('verifyTokens: remote JWKSのURL・timeout・redirect:errorを検証する', async () => {
  let calls = 0;
  const input = await pair();
  const result = await verifyTokens(input, config, {}, {
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), `${issuer}/.well-known/jwks.json`);
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.method, 'GET');
      assert.ok(init?.signal instanceof AbortSignal);
      return Response.json({ keys: [jwk] });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.sub, 'user-sub');
});

test('verifyTokens: remote JWKSのHTTP異常・JSON異常・通信例外・timeoutを隠蔽する', async () => {
  const input = await pair();
  for (const mock of [
    async () => new Response(secret, { status: 503 }),
    async () => new Response(secret),
    async () => { throw new Error(secret); },
    async () => new Response(null, { status: 302, headers: { location: `https://${secret}.test` } }),
  ]) {
    await rejectsSafe(() => verifyTokens(input, config, {}, { fetch: mock }), 'TOKEN_INVALID');
  }
  let signal: AbortSignal | null | undefined;
  await rejectsSafe(() => verifyTokens(input, config, {}, {
    httpTimeoutMs: 20,
    fetch: async (_, init) => { signal = init?.signal; return new Promise<Response>(() => {}); },
  }), 'TOKEN_INVALID');
  assert.ok(signal?.aborted);
});

test('browserLogin: manual入力はlistenせずPKCE S256/state/nonceを検証してcodeだけを交換する', async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(19878, '127.0.0.1', resolve));
  let authorize!: URL;
  let exchanged = false;
  try {
    const result = await browserLogin(config, {
      openBrowser: false,
      onUrl: (raw) => {
        authorize = new URL(raw);
        assert.equal(authorize.origin, config.oauthDomain);
        assert.equal(authorize.pathname, '/oauth2/authorize');
        assert.equal(authorize.searchParams.get('response_type'), 'code');
        assert.equal(authorize.searchParams.get('client_id'), config.userPoolClientId);
        assert.equal(authorize.searchParams.get('redirect_uri'), config.redirectUri);
        assert.equal(authorize.searchParams.get('scope'), config.scopes.join(' '));
        assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
        assert.match(authorize.searchParams.get('state')!, /^[A-Za-z0-9_-]{43}$/);
        assert.match(authorize.searchParams.get('nonce')!, /^[A-Za-z0-9_-]{43}$/);
        assert.notEqual(authorize.searchParams.get('state'), authorize.searchParams.get('nonce'));
        assert.equal(authorize.searchParams.has('code_verifier'), false);
      },
      manualCallback: async () => callback(authorize),
    }, {
      jwks,
      fetch: async (url, init) => {
        exchanged = true;
        assert.equal(String(url), `${config.oauthDomain}/oauth2/token`);
        assert.equal(init?.method, 'POST');
        assert.equal(init?.redirect, 'error');
        assert.ok(init?.signal instanceof AbortSignal);
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get('grant_type'), 'authorization_code');
        assert.equal(body.get('code'), 'authorization-code');
        assert.equal(body.get('redirect_uri'), config.redirectUri);
        assert.equal(body.get('client_id'), config.userPoolClientId);
        assert.equal(body.has('client_secret'), false);
        const verifier = body.get('code_verifier')!;
        assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
        return tokenResponse(await pair({ nonce: authorize.searchParams.get('nonce') }));
      },
    });
    assert.ok(exchanged);
    assert.equal(result.sub, 'user-sub');
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

test('browserLogin: 別endpoint・redirect・state・重複・token直渡しを交換前に拒否する', async (t) => {
  const mutations: [string, (url: URL) => void][] = [
    ['host', (url) => { url.hostname = 'localhost'; }],
    ['port', (url) => { url.port = '19879'; }],
    ['scheme', (url) => { url.protocol = 'https:'; }],
    ['path', (url) => { url.pathname = '/other'; }],
    ['userinfo', (url) => { url.username = secret; }],
    ['state', (url) => { url.searchParams.set('state', secret); }],
    ['missing state', (url) => { url.searchParams.delete('state'); }],
    ['duplicate state', (url) => { url.searchParams.append('state', secret); }],
    ['missing code', (url) => { url.searchParams.delete('code'); }],
    ['duplicate code', (url) => { url.searchParams.append('code', secret); }],
    ['error', (url) => { url.searchParams.set('error', secret); }],
    ['error_description', (url) => { url.searchParams.set('error_description', secret); }],
    ['id_token', (url) => { url.searchParams.set('id_token', secret); }],
    ['access_token', (url) => { url.searchParams.set('access_token', secret); }],
    ['refresh_token', (url) => { url.searchParams.set('refresh_token', secret); }],
    ['fragment', (url) => { url.hash = `access_token=${secret}`; }],
    ['URL length', (url) => { url.searchParams.set('code', secret.repeat(400)); }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      let calls = 0;
      await rejectsSafe(() => manualLogin({
        fetch: async () => { calls++; throw new Error(secret); }, jwks,
      }, mutate), 'AUTH_CALLBACK');
      assert.equal(calls, 0);
    });
  }
});

test('browserLogin: nonce不一致は署名が正しくても拒否する', async () => {
  await rejectsSafe(() => manualLogin({
    jwks, fetch: async () => tokenResponse(await pair({ nonce: secret })),
  }), 'TOKEN_INVALID');
});

test('browserLogin: ブラウザ起動はshellなしの引数で実行し、起動例外を隠蔽する', async () => {
  let authorize!: URL;
  let launched = false;
  await browserLogin(config, {
    onUrl: (url) => { authorize = new URL(url); },
    manualCallback: async () => callback(authorize),
  }, {
    jwks,
    fetch: async () => tokenResponse(await pair({ nonce: authorize.searchParams.get('nonce') })),
    execFile: (program, args, options, done) => {
      launched = true;
      assert.equal(program, process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open');
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 10_000);
      assert.ok(options.signal instanceof AbortSignal);
      if (process.platform === 'win32') {
        assert.equal(options.windowsVerbatimArguments, true);
        assert.equal(options.env?.ONOCOMM_PORTAL_AUTH_URL, authorize.toString());
        assert.equal(args.at(-1), 'start "" "%ONOCOMM_PORTAL_AUTH_URL%"');
      } else {
        assert.deepEqual(args, [authorize.toString()]);
      }
      done(null);
    },
  });
  assert.ok(launched);
  await rejectsSafe(() => browserLogin(config, {
    onUrl: () => {}, manualCallback: async () => secret,
  }, { execFile: (_, __, ___, done) => { done(new Error(secret)); } }), 'AUTH_BROWSER');
});

test('browserLogin: 認証全体のtimeoutでtoken交換・署名鍵取得もabortする', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stage of ['token', 'jwks']) {
    let authorize!: URL;
    let signal: AbortSignal | null | undefined;
    let reached!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    const rejected = rejectsSafe(() => browserLogin(config, {
      openBrowser: false, timeoutMs: 30,
      onUrl: (url) => { authorize = new URL(url); }, manualCallback: async () => callback(authorize),
    }, {
      fetch: async (url, init) => {
        if (stage === 'jwks' && String(url).endsWith('/oauth2/token')) {
          return tokenResponse(await pair({ nonce: authorize.searchParams.get('nonce') }));
        }
        signal = init?.signal;
        reached();
        return new Promise(() => {});
      },
    }), 'AUTH_TIMEOUT');
    await started;
    context.mock.timers.tick(30);
    await rejected;
    assert.ok(signal?.aborted);
  }
});

test('browserLogin: 毎回異なるstate・nonce・PKCEを生成する', async () => {
  const urls: URL[] = [];
  for (let i = 0; i < 2; i++) {
    await rejectsSafe(() => browserLogin(config, {
      openBrowser: false, onUrl: (url) => { urls.push(new URL(url)); }, manualCallback: async () => secret,
    }), 'AUTH_CALLBACK');
  }
  for (const key of ['state', 'nonce', 'code_challenge']) {
    assert.notEqual(urls[0]!.searchParams.get(key), urls[1]!.searchParams.get(key));
  }
});

test('browserLogin: no-browserでもURL通知しloopback成功後ポートを解放する', async () => {
  let nonce = '';
  let response: Promise<Response> | undefined;
  const result = await browserLogin(config, {
    openBrowser: false,
    onUrl: (url) => {
      const authorize = new URL(url);
      nonce = authorize.searchParams.get('nonce')!;
      response = fetch(callback(authorize));
    },
  }, { jwks, fetch: async () => tokenResponse(await pair({ nonce })) });
  assert.equal(result.sub, 'user-sub');
  assert.equal((await response)?.status, 200);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(19878, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

test('browserLogin: 不正callbackの400後も待機を継続し正規callbackで正常完了する', async () => {
  let nonce = '';
  let calls = 0;
  const result = await browserLogin(config, {
    openBrowser: false,
    timeoutMs: 2000,
    onUrl: async (raw) => {
      const authorize = new URL(raw);
      nonce = authorize.searchParams.get('nonce')!;
      const invalid = [
        `${config.redirectUri}?state=${secret}&code=${secret}`,
        callback(authorize, (url) => { url.searchParams.delete('state'); }),
        callback(authorize, (url) => { url.searchParams.append('state', secret); }),
        callback(authorize, (url) => { url.searchParams.delete('code'); }),
        callback(authorize, (url) => { url.searchParams.append('code', secret); }),
        callback(authorize, (url) => { url.searchParams.set('id_token', secret); }),
        callback(authorize, (url) => { url.searchParams.set('code', secret.repeat(400)); }),
        callback(authorize, (url) => {
          url.searchParams.delete('code');
          url.searchParams.set('state', secret);
          url.searchParams.set('error', 'access_denied');
          url.searchParams.set('error_description', secret);
        }),
        callback(authorize, (url) => { url.searchParams.set('error', secret); }),
      ];
      for (const url of invalid) {
        const response = await fetch(url);
        assert.equal(response.status, 400);
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        assert.ok(!(await response.text()).includes(secret));
        assert.equal(calls, 0);
      }
      assert.equal((await fetch(callback(authorize))).status, 200);
    },
  }, { jwks, fetch: async () => { calls++; return tokenResponse(await pair({ nonce })); } });
  assert.equal(result.sub, 'user-sub');
  assert.equal(calls, 1);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(19878, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

test('browserLogin: 正規stateのOAuthエラーのみ固定エラーで終了する', async () => {
  for (const manual of [false, true]) {
    let authorize!: URL;
    let response: Promise<Response> | undefined;
    const denied = () => callback(authorize, (url) => {
      url.searchParams.delete('code');
      url.searchParams.set('error', 'access_denied');
      url.searchParams.set('error_description', secret);
      url.searchParams.set('error_uri', `https://example.test/${secret}`);
    });
    await rejectsSafe(() => browserLogin(config, {
      openBrowser: false, timeoutMs: 2000,
      onUrl: (raw) => {
        authorize = new URL(raw);
        if (!manual) response = fetch(denied());
      },
      ...(manual ? { manualCallback: async () => denied() } : {}),
    }, { fetch: async () => { assert.fail('OAuthエラー時はtokenを交換しない'); } }), 'AUTH_OAUTH');
    if (response) {
      assert.equal((await response).status, 400);
      assert.ok(!(await (await response).text()).includes(secret));
    }
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(19878, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
});

test('browserLogin: 親signalが開始前にabort済みなら副作用なしの固定キャンセルエラー', async () => {
  const parent = new AbortController();
  parent.abort(new CliError('LEAK', secret));
  await rejectsSafe(() => browserLogin(config, {
    onUrl: () => { assert.fail('URL通知してはいけない'); },
    manualCallback: async () => { assert.fail('入力を開始してはいけない'); },
  }, {
    signal: parent.signal,
    execFile: () => { assert.fail('ブラウザを起動してはいけない'); },
    fetch: async () => { assert.fail('通信してはいけない'); },
  }), 'AUTH_CANCELLED');
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('browserLogin: 親abortは全段階を即キャンセルし通信・起動・serverをcleanupする', async (t) => {
  for (const stage of ['callback', 'notification', 'manual', 'browser', 'token', 'jwks']) {
    await t.test(stage, async () => {
      const parent = new AbortController();
      let authorize!: URL;
      let childSignal: AbortSignal | null | undefined;
      let manualCalls = 0;
      await rejectsSafe(() => browserLogin(config, {
        openBrowser: stage === 'browser', timeoutMs: 2000,
        onUrl: (raw) => {
          authorize = new URL(raw);
          if (stage === 'notification') parent.abort(new Error(secret));
          if (stage === 'callback') setImmediate(() => parent.abort(new Error(secret)));
        },
        ...(['callback', 'notification'].includes(stage) ? {} : {
          manualCallback: async () => {
            manualCalls++;
            if (stage === 'manual') {
              parent.abort(new Error(secret));
              return new Promise<string>(() => {});
            }
            return callback(authorize);
          },
        }),
      }, {
        signal: parent.signal,
        execFile: (_, __, options) => {
          assert.equal(stage, 'browser');
          childSignal = options.signal;
          parent.abort(new Error(secret));
        },
        fetch: async (url, init) => {
          assert.ok(stage === 'token' || stage === 'jwks');
          if (stage === 'jwks' && String(url).endsWith('/oauth2/token')) {
            return tokenResponse(await pair({ nonce: authorize.searchParams.get('nonce') }));
          }
          childSignal = init?.signal;
          parent.abort(new Error(secret));
          return new Promise<Response>(() => {});
        },
      }), 'AUTH_CANCELLED');
      assert.ok(parent.signal.aborted);
      if (['browser', 'token', 'jwks'].includes(stage)) assert.ok(childSignal?.aborted);
      if (stage === 'browser' || stage === 'notification') assert.equal(manualCalls, 0);
      assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(19878, '127.0.0.1', resolve);
      });
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    });
  }
});

test('browserLogin: 正常終了時も親abortのlistenerを解放する', async () => {
  const parent = new AbortController();
  let authorize!: URL;
  await browserLogin(config, {
    openBrowser: false,
    onUrl: (raw) => { authorize = new URL(raw); }, manualCallback: async () => callback(authorize),
  }, {
    signal: parent.signal, jwks,
    fetch: async () => tokenResponse(await pair({ nonce: authorize.searchParams.get('nonce') })),
  });
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  assert.equal(parent.signal.aborted, false);
});

test('browserLogin: loopbackのHost・メソッド・パスを制限し応答にcodeやstateを含めない', async () => {
  let nonce = '';
  let calls = 0;
  await browserLogin(config, {
    openBrowser: false,
    onUrl: async (raw) => {
      const authorize = new URL(raw);
      nonce = authorize.searchParams.get('nonce')!;
      const url = callback(authorize);
      assert.equal((await fetch(url, { method: 'POST' })).status, 400);
      assert.equal((await fetch('http://127.0.0.1:19878/other')).status, 400);
      const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
        const outgoing = request(url, { headers: { host: 'untrusted.example.test' } }, (incoming) => {
          incoming.resume();
          incoming.on('end', () => resolve(incoming.statusCode));
        });
        outgoing.on('error', reject);
        outgoing.end();
      });
      assert.equal(wrongHost, 400);
      assert.equal(calls, 0);
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      const body = await response.text();
      assert.ok(!body.includes('authorization-code'));
      assert.ok(!body.includes(authorize.searchParams.get('state')!));
    },
  }, {
    jwks, fetch: async () => { calls++; return tokenResponse(await pair({ nonce })); },
  });
  assert.equal(calls, 1);
});

test('browserLogin: timeoutと通知例外とmanual例外を隠蔽しcleanupする', async () => {
  await rejectsSafe(() => browserLogin(config, {
    openBrowser: false, timeoutMs: 25, onUrl: () => {},
  }), 'AUTH_TIMEOUT');
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(19878, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await rejectsSafe(() => browserLogin(config, {
    openBrowser: false, onUrl: () => { throw new CliError('LEAK', secret); },
    manualCallback: async () => secret,
  }), 'AUTH_URL');
  await rejectsSafe(() => browserLogin(config, {
    openBrowser: false, onUrl: () => {}, manualCallback: async () => { throw new Error(secret); },
  }), 'AUTH_CALLBACK');
  await rejectsSafe(() => browserLogin(config, {
    openBrowser: false, timeoutMs: 25, onUrl: () => {}, manualCallback: async () => new Promise(() => {}),
  }), 'AUTH_TIMEOUT');
});

test('browserLogin: 使用中ポートを勝手に変更しない', async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(19878, '127.0.0.1', resolve));
  try {
    await rejectsSafe(() => browserLogin(config, {
      openBrowser: false, onUrl: () => { assert.fail('通知してはいけない'); },
    }), 'AUTH_LOOPBACK');
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

test('browserLogin: HTTPS originと固定127.0.0.1 redirectだけ許可する', async () => {
  for (const patch of [
    { oauthDomain: `http://${secret}.test` },
    { oauthDomain: `https://${secret}.test/path` },
    { oauthDomain: `https://${secret}@auth.example.test` },
    { oauthDomain: `https://auth.example.test?${secret}` },
    { redirectUri: `http://localhost:19878/callback?${secret}` },
    { redirectUri: 'http://127.0.0.1:19879/callback' },
    { redirectUri: 'http://0.0.0.0:19878/callback' },
  ]) {
    await rejectsSafe(() => browserLogin({ ...config, ...patch }, {
      openBrowser: false, onUrl: () => { assert.fail('通知してはいけない'); },
    }), 'AUTH_CONFIG');
  }
});

test('OAuth HTTP: 失敗・redirect・不正JSON・欠落token・生例外を非公開にする', async () => {
  for (const mock of [
    async () => new Response(secret, { status: 400 }),
    async () => new Response(null, { status: 302, headers: { location: `https://${secret}.test` } }),
    async () => new Response(secret),
    async () => Response.json({ error_description: secret }),
    async () => Response.json({ id_token: secret, access_token: secret, refresh_token: 123 }),
    async () => { throw new CliError('LEAK', secret); },
  ]) {
    await rejectsSafe(() => manualLogin({ fetch: mock, jwks }), 'AUTH_HTTP');
  }
});

test('OAuth HTTP: fetchとレスポンスbodyの両方にtimeoutを適用する', async () => {
  let signal: AbortSignal | null | undefined;
  await rejectsSafe(() => manualLogin({
    httpTimeoutMs: 20,
    fetch: async (_, init) => { signal = init?.signal; return new Promise(() => {}); },
  }), 'AUTH_HTTP');
  assert.ok(signal?.aborted);
  await rejectsSafe(() => manualLogin({
    httpTimeoutMs: 20,
    fetch: async () => new Response(new ReadableStream({ start() {} })),
  }), 'AUTH_HTTP');
});

test('refreshTokens: OAuth endpointを使いrotationを保持し、省略時は旧refreshを維持する', async () => {
  const existing = await verifyTokens(await pair(), config, { jwks });
  for (const rotated of [undefined, 'refresh-rotated']) {
    const input = await pair();
    input.refreshToken = rotated;
    const result = await refreshTokens(config, { ...existing, expiresAt: 1 }, {
      jwks,
      fetch: async (url, init) => {
        assert.equal(String(url), `${config.oauthDomain}/oauth2/token`);
        assert.equal(init?.redirect, 'error');
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get('grant_type'), 'refresh_token');
        assert.equal(body.get('refresh_token'), existing.refreshToken);
        assert.equal(body.get('client_id'), config.userPoolClientId);
        assert.equal(body.has('client_secret'), false);
        return tokenResponse(input);
      },
    });
    assert.equal(result.refreshToken, rotated ?? existing.refreshToken);
    assert.ok(result.expiresAt > Date.now());
  }
});

test('refreshTokens: refresh欠落・client変更・署名異常・利用者変更を拒否する', async () => {
  const existing = await verifyTokens(await pair(), config, { jwks });
  await rejectsSafe(() => refreshTokens(config, { ...existing, refreshToken: undefined }), 'AUTH_REFRESH');
  await rejectsSafe(() => refreshTokens(config, { ...existing, clientId: 'other' }), 'AUTH_REFRESH');
  await rejectsSafe(() => refreshTokens(config, existing, {
    jwks, fetch: async () => tokenResponse({ idToken: secret, accessToken: secret }),
  }), 'TOKEN_INVALID');
  await rejectsSafe(() => refreshTokens(config, existing, {
    jwks, fetch: async () => tokenResponse(await pair({ sub: 'other-user' }, { sub: 'other-user' })),
  }), 'TOKEN_INVALID');
  await rejectsSafe(() => refreshTokens(config, existing, {
    fetch: async () => { throw new Error(secret); },
  }), 'AUTH_HTTP');
});

test('email OTP: USER_AUTH+PREFERRED_CHALLENGEで開始しEMAIL_OTP_CODEで完了する', async () => {
  const commands: unknown[] = [];
  const input = await pair();
  const deps: AuthDeps = {
    jwks,
    send: async (command, options) => {
      commands.push(command);
      assert.ok(options.abortSignal instanceof AbortSignal);
      if (command instanceof InitiateAuthCommand) {
        assert.deepEqual(command.input, {
          ClientId: config.userPoolClientId, AuthFlow: 'USER_AUTH',
          AuthParameters: { USERNAME: 'user@example.test', PREFERRED_CHALLENGE: 'EMAIL_OTP' },
        });
        return { $metadata: {}, ChallengeName: 'EMAIL_OTP', Session: secret, ChallengeParameters: { USERNAME: 'canonical-user' } };
      }
      assert.ok(command instanceof RespondToAuthChallengeCommand);
      assert.deepEqual(command.input, {
        ClientId: config.userPoolClientId, ChallengeName: 'EMAIL_OTP', Session: secret,
        ChallengeResponses: { USERNAME: 'canonical-user', EMAIL_OTP_CODE: '123456' },
      });
      return { $metadata: {}, AuthenticationResult: {
        IdToken: input.idToken, AccessToken: input.accessToken, RefreshToken: input.refreshToken,
      } };
    },
  };
  const before = Date.now();
  const challenge = await beginEmailOtp(config, 'user@example.test', deps);
  assert.equal(challenge.session, secret);
  assert.equal(challenge.username, 'canonical-user');
  assert.ok(challenge.expiresAt >= before + 300_000);
  assert.ok(challenge.expiresAt <= Date.now() + 300_000);
  assert.equal((await completeEmailOtp(config, challenge, '123456', deps)).sub, 'user-sub');
  assert.equal(commands.length, 2);
});

test('email OTP: SELECT_CHALLENGEでEMAIL_OTPのみ選択する', async () => {
  for (const named of [true, false]) {
    let calls = 0;
    const result = await beginEmailOtp(config, 'user@example.test', {
      send: async (command) => {
        calls++;
        if (calls === 1) return {
          $metadata: {}, ...(named ? { ChallengeName: 'SELECT_CHALLENGE' as const } : {}),
          Session: 'select-session', AvailableChallenges: ['EMAIL_OTP', 'PASSWORD'],
        };
        assert.deepEqual(command.input, {
          ClientId: config.userPoolClientId, ChallengeName: 'SELECT_CHALLENGE', Session: 'select-session',
          ChallengeResponses: { USERNAME: 'user@example.test', ANSWER: 'EMAIL_OTP' },
        });
        return { $metadata: {}, ChallengeName: 'EMAIL_OTP', Session: 'otp-session' };
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.session, 'otp-session');
  }
});

test('email OTP: MFA・password・未対応challengeでブラウザ誘導しfallbackしない', async () => {
  for (const ChallengeName of ['PASSWORD', 'SOFTWARE_TOKEN_MFA', 'SMS_MFA', 'NEW_PASSWORD_REQUIRED', 'SELECT_CHALLENGE'] as const) {
    let calls = 0;
    await assert.rejects(() => beginEmailOtp(config, 'user@example.test', {
      send: async () => {
        calls++;
        return { $metadata: {}, ChallengeName, Session: secret, AvailableChallenges: ['PASSWORD'] };
      },
    }), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, 'AUTH_CHALLENGE');
      assert.match(error.message, /ブラウザ認証/);
      assert.ok(!inspect(error).includes(secret));
      return true;
    });
    assert.equal(calls, 1);
  }
  await rejectsSafe(() => beginEmailOtp(config, 'user@example.test', {
    send: async () => ({ $metadata: {}, ChallengeName: 'EMAIL_OTP' }),
  }), 'AUTH_CHALLENGE');
  await rejectsSafe(() => beginEmailOtp(config, 'user@example.test', {
    send: async (command) => command instanceof InitiateAuthCommand
      ? { $metadata: {}, ChallengeName: 'SELECT_CHALLENGE', AvailableChallenges: ['EMAIL_OTP'], Session: secret }
      : { $metadata: {}, ChallengeName: 'PASSWORD', Session: secret },
  }), 'AUTH_CHALLENGE');
});

const challenge: OtpChallenge = { session: secret, username: 'canonical-user', expiresAt: Date.now() + 300_000 };

test('email OTP: 完了時の追加MFA・不正token・SDK例外も非公開にする', async () => {
  await rejectsSafe(() => completeEmailOtp(config, challenge, '123456', {
    send: async () => ({ $metadata: {}, ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: secret }),
  }), 'AUTH_CHALLENGE');
  await rejectsSafe(() => completeEmailOtp(config, challenge, '123456', {
    jwks, send: async () => ({ $metadata: {}, AuthenticationResult: { IdToken: secret, AccessToken: secret } }),
  }), 'TOKEN_INVALID');
  for (const action of [
    () => beginEmailOtp(config, 'user@example.test', { send: async () => { throw new Error(secret); } }),
    () => completeEmailOtp(config, challenge, '123456', { send: async () => { throw new CliError('LEAK', secret); } }),
  ]) await rejectsSafe(action, 'AUTH_OTP');
});

test('email OTP: 期限切れ・不正入力は送信せずSDK timeoutをabortする', async () => {
  const never: AuthDeps = { send: async () => { assert.fail('送信してはいけない'); } };
  await rejectsSafe(() => beginEmailOtp(config, secret, never), 'AUTH_EMAIL');
  await rejectsSafe(() => completeEmailOtp(config, { ...challenge, expiresAt: 1 }, '123456', never), 'AUTH_OTP');
  await rejectsSafe(() => completeEmailOtp(config, challenge, secret, never), 'AUTH_OTP');
  await rejectsSafe(() => completeEmailOtp(config, { ...challenge, session: '' }, '123456', never), 'AUTH_OTP');
  let signal: AbortSignal | undefined;
  await rejectsSafe(() => beginEmailOtp(config, 'user@example.test', {
    httpTimeoutMs: 20,
    send: async (_, options) => { signal = options.abortSignal; return new Promise(() => {}); },
  }), 'AUTH_OTP');
  assert.ok(signal?.aborted);
});
