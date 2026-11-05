import { execFile, type ExecFileOptions } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type InitiateAuthCommandOutput,
  type RespondToAuthChallengeCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { CliError, type PortalConfig, type TokenInput, type Tokens } from './types.js';

const REDIRECT_URI = 'http://127.0.0.1:19878/callback';
const LOGIN_TIMEOUT = 300_000;
const HTTP_TIMEOUT = 10_000;
const CALLBACK_URL_LIMIT = 8192;

export interface OtpChallenge {
  session: string;
  username: string;
  expiresAt: number;
}

type AuthCommand = InitiateAuthCommand | RespondToAuthChallengeCommand;
type AuthResponse = InitiateAuthCommandOutput | RespondToAuthChallengeCommandOutput;

export interface AuthDeps {
  fetch?: typeof fetch;
  jwks?: JWTVerifyGetKey;
  send?: (command: AuthCommand, options: { abortSignal: AbortSignal }) => Promise<AuthResponse>;
  execFile?: (program: string, args: string[], options: ExecFileOptions, callback: (error: Error | null) => void) => unknown;
  httpTimeoutMs?: number;
  signal?: AbortSignal;
}

function authError(code: string, message: string): CliError {
  return new CliError(code, message);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function timeoutMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > fallback) {
    throw authError('AUTH_CONFIG', '認証の待機時間設定が不正です。');
  }
  return value;
}

async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  failure: CliError,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return work(signal);
      }),
      new Promise<never>((_, reject) => {
        abort = () => reject(failure);
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => controller.abort(), milliseconds);
        if (signal.aborted) reject(failure);
      }),
    ]);
  } catch {
    throw failure;
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    controller.abort();
  }
}

function issuerFor(config: PortalConfig): string {
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(config.region)
      || !new RegExp(`^${config.region}_[A-Za-z0-9]+$`).test(config.userPoolId)
      || !/^[A-Za-z0-9]+$/.test(config.userPoolClientId)) {
    throw authError('AUTH_CONFIG', '認証先の設定が不正です。');
  }
  const suffix = config.region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  return `https://cognito-idp.${config.region}.${suffix}/${config.userPoolId}`;
}

function oauthOrigin(config: PortalConfig): string {
  try {
    const url = new URL(config.oauthDomain);
    if (url.protocol !== 'https:' || url.username || url.password
        || config.oauthDomain !== url.origin || config.redirectUri !== REDIRECT_URI) throw new Error();
    issuerFor(config);
    return url.origin;
  } catch {
    throw authError('AUTH_CONFIG', 'ブラウザ認証先または折り返し先の設定が不正です。');
  }
}

export async function verifyTokens(
  input: TokenInput,
  config: PortalConfig,
  options: { nonce?: string; jwks?: JWTVerifyGetKey } = {},
  deps: AuthDeps = {},
): Promise<Tokens> {
  const failure = authError('TOKEN_INVALID', '認証情報を検証できませんでした。再度ログインしてください。');
  const milliseconds = timeoutMs(deps.httpTimeoutMs, HTTP_TIMEOUT);
  return bounded(async (signal) => {
    const issuer = issuerFor(config);
    if (!text(input.idToken) || !text(input.accessToken)
        || (input.refreshToken !== undefined && !text(input.refreshToken))) throw failure;
    const jwks = options.jwks ?? deps.jwks ?? createRemoteJWKSet(
      new URL(`${issuer}/.well-known/jwks.json`),
      {
        timeoutDuration: milliseconds,
        [customFetch]: (url, init) => (deps.fetch ?? fetch)(url, {
          ...init, redirect: 'error', signal: AbortSignal.any([signal, init.signal]),
        }),
      },
    );
    const common = { issuer, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'token_use'] };
    const { payload: id } = await jwtVerify(input.idToken, jwks, {
      ...common, audience: config.userPoolClientId,
    });
    const { payload: access } = await jwtVerify(input.accessToken, jwks, {
      ...common, requiredClaims: [...common.requiredClaims, 'client_id', 'username'],
    });
    if (id.token_use !== 'id' || access.token_use !== 'access'
        || access.client_id !== config.userPoolClientId
        || !text(id.sub) || id.sub !== access.sub
        || !text(access.username) || !text(id['cognito:username'])
        || id['cognito:username'] !== access.username
        || (options.nonce !== undefined && (!text(options.nonce) || id.nonce !== options.nonce))
        || !Number.isFinite(id.exp) || !Number.isFinite(access.exp)) throw failure;
    const expiresAt = Math.min(id.exp!, access.exp!) * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw failure;
    return {
      idToken: input.idToken,
      accessToken: input.accessToken,
      ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
      expiresAt,
      sub: id.sub,
      username: access.username,
      clientId: config.userPoolClientId,
    };
  }, milliseconds, failure, deps.signal);
}

async function tokenRequest(
  config: PortalConfig,
  parameters: URLSearchParams,
  deps: AuthDeps,
  parent?: AbortSignal,
): Promise<TokenInput> {
  const endpoint = `${oauthOrigin(config)}/oauth2/token`;
  parameters.set('client_id', config.userPoolClientId);
  return bounded(async (signal) => {
    const response = await (deps.fetch ?? fetch)(endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: parameters.toString(),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') throw new Error();
    const result = body as Record<string, unknown>;
    if (!text(result.id_token) || !text(result.access_token)
        || (result.refresh_token !== undefined && !text(result.refresh_token))) throw new Error();
    return {
      idToken: result.id_token, accessToken: result.access_token,
      ...(result.refresh_token === undefined ? {} : { refreshToken: result.refresh_token as string }),
    };
  }, timeoutMs(deps.httpTimeoutMs, HTTP_TIMEOUT),
  authError('AUTH_HTTP', '認証サーバーとの通信に失敗しました。時間をおいて再度お試しください。'), parent ?? deps.signal);
}

function callbackCode(raw: string, state: string, redirectUri: string): string {
  const failure = authError('AUTH_CALLBACK', '認証の折り返し情報を確認できませんでした。再度ログインしてください。');
  let url: URL;
  try {
    if (Buffer.byteLength(raw) > CALLBACK_URL_LIMIT) throw failure;
    url = new URL(raw);
    const expected = new URL(redirectUri);
    const actualState = url.searchParams.get('state');
    if (url.origin !== expected.origin || url.pathname !== expected.pathname
        || url.username || url.password || url.hash
        || url.searchParams.getAll('state').length !== 1 || !text(actualState)
        || Buffer.byteLength(actualState) !== Buffer.byteLength(state)
        || !timingSafeEqual(Buffer.from(actualState), Buffer.from(state))
        || ['id_token', 'access_token', 'refresh_token'].some((key) => url.searchParams.has(key))) throw failure;
  } catch {
    throw failure;
  }
  if (url.searchParams.has('error')) {
    if (url.searchParams.getAll('error').length !== 1 || !text(url.searchParams.get('error'))
        || url.searchParams.has('code') || url.searchParams.getAll('error_description').length > 1
        || url.searchParams.getAll('error_uri').length > 1) throw failure;
    throw authError('AUTH_OAUTH', '認証が許可されませんでした。ブラウザで再度ログインしてください。');
  }
  const code = url.searchParams.get('code');
  if (url.searchParams.has('error_description') || url.searchParams.has('error_uri')
      || url.searchParams.getAll('code').length !== 1 || !text(code)) throw failure;
  return code;
}

async function launchBrowser(url: string, parent: AbortSignal, deps: AuthDeps): Promise<void> {
  await bounded((signal) => new Promise<void>((resolve, reject) => {
    const program = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    // Windows expands a single environment variable; the URL never becomes command syntax.
    const args = process.platform === 'win32'
      ? ['/d', '/v:off', '/s', '/c', 'start "" "%ONOCOMM_PORTAL_AUTH_URL%"'] : [url];
    (deps.execFile ?? execFile)(program, args, {
      shell: false, timeout: HTTP_TIMEOUT, windowsHide: true, signal,
      ...(process.platform === 'win32'
        ? { env: { ...process.env, ONOCOMM_PORTAL_AUTH_URL: url }, windowsVerbatimArguments: true } : {}),
    }, (error) => error ? reject(error) : resolve());
  }), HTTP_TIMEOUT, authError('AUTH_BROWSER', 'ブラウザを開けませんでした。表示された認証先を手動で開いてください。'), parent);
}

export async function browserLogin(
  config: PortalConfig,
  options: {
    onUrl: (url: string) => void;
    openBrowser?: boolean;
    timeoutMs?: number;
    manualCallback?: () => Promise<string>;
  },
  deps: AuthDeps = {},
): Promise<Tokens> {
  const cancelled = authError('AUTH_CANCELLED', 'ログインをキャンセルしました。');
  if (deps.signal?.aborted) throw cancelled;
  const origin = oauthOrigin(config);
  const milliseconds = timeoutMs(options.timeoutMs, LOGIN_TIMEOUT);
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const authorize = new URL('/oauth2/authorize', origin);
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: config.userPoolClientId, redirect_uri: config.redirectUri,
    scope: config.scopes.join(' '), state, nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const controller = new AbortController();
  const timeout = authError('AUTH_TIMEOUT', 'ログインの待機時間を超えました。再度ログインしてください。');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let parentAbort: (() => void) | undefined;
  try {
    const stopped = new Promise<never>((_, reject) => {
      parentAbort = () => { reject(cancelled); controller.abort(); };
      deps.signal?.addEventListener('abort', parentAbort, { once: true });
      timer = setTimeout(() => { reject(timeout); controller.abort(); }, milliseconds);
      if (deps.signal?.aborted) parentAbort();
    });
    const operation = async (): Promise<Tokens> => {
      if (controller.signal.aborted) throw cancelled;
      let callback: Promise<string> | undefined;
      if (!options.manualCallback) {
        let accept!: (value: string) => void;
        let reject!: (error: CliError) => void;
        callback = new Promise<string>((resolve, fail) => { accept = resolve; reject = fail; });
        // OAuth denial or a server failure can arrive before URL notification completes.
        void callback.catch(() => {});
        server = createServer((request, response) => {
          response.setHeader('cache-control', 'no-store');
          response.setHeader('referrer-policy', 'no-referrer');
          response.setHeader('content-type', 'text/plain; charset=utf-8');
          response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
          response.setHeader('connection', 'close');
          if (request.method !== 'GET' || request.headers.host !== '127.0.0.1:19878'
              || !request.url?.startsWith('/callback?')) {
            response.writeHead(400).end('認証の折り返し先が不正です。');
            return;
          }
          try {
            const raw = `http://127.0.0.1:19878${request.url}`;
            callbackCode(raw, state, config.redirectUri);
            response.end('認証情報を受け付けました。この画面を閉じてください。');
            accept(raw);
          } catch (error) {
            response.writeHead(400).end('認証の折り返し情報が不正です。');
            if (error instanceof CliError && error.code === 'AUTH_OAUTH') reject(error);
          }
        });
        server.headersTimeout = HTTP_TIMEOUT;
        server.requestTimeout = HTTP_TIMEOUT;
        server.timeout = HTTP_TIMEOUT;
        await new Promise<void>((resolve, rejectListen) => {
          server!.on('error', () => {
            const failure = authError('AUTH_LOOPBACK', '認証用の受信ポートを利用できません。手動の折り返し入力を使用してください。');
            rejectListen(failure);
            reject(failure);
          });
          server!.listen({ host: '127.0.0.1', port: 19878, signal: controller.signal }, resolve);
        });
      }
      await bounded(async () => options.onUrl(authorize.toString()), milliseconds,
        authError('AUTH_URL', '認証先を通知できませんでした。'), controller.signal);
      if (options.openBrowser !== false) await launchBrowser(authorize.toString(), controller.signal, deps);
      const raw = options.manualCallback
        ? await bounded(() => options.manualCallback!(), milliseconds,
          authError('AUTH_CALLBACK', '認証の折り返し情報を読み取れませんでした。'), controller.signal)
        : await callback!;
      controller.signal.throwIfAborted();
      const code = callbackCode(raw, state, config.redirectUri);
      const input = await tokenRequest(config, new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, code_verifier: verifier,
      }), deps, controller.signal);
      controller.signal.throwIfAborted();
      return verifyTokens(input, config, { nonce }, { ...deps, signal: controller.signal });
    };
    return await Promise.race([stopped, Promise.resolve().then(operation)]);
  } finally {
    clearTimeout(timer);
    if (parentAbort) deps.signal?.removeEventListener('abort', parentAbort);
    controller.abort();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  }
}

export async function refreshTokens(config: PortalConfig, tokens: Tokens, deps: AuthDeps = {}): Promise<Tokens> {
  if (!text(tokens.refreshToken) || tokens.clientId !== config.userPoolClientId) {
    throw authError('AUTH_REFRESH', '認証情報を更新できません。ブラウザで再度ログインしてください。');
  }
  const input = await tokenRequest(config, new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: tokens.refreshToken,
  }), deps);
  const verified = await verifyTokens({ ...input, refreshToken: input.refreshToken ?? tokens.refreshToken }, config, {}, deps);
  if (verified.sub !== tokens.sub || verified.username !== tokens.username) {
    throw authError('TOKEN_INVALID', '更新後の利用者情報が一致しません。再度ログインしてください。');
  }
  return verified;
}

async function cognitoSend(config: PortalConfig, command: AuthCommand, deps: AuthDeps): Promise<AuthResponse> {
  issuerFor(config);
  const client = deps.send ? undefined : new CognitoIdentityProviderClient({
    region: config.region, maxAttempts: 1,
    requestHandler: {
      connectionTimeout: timeoutMs(deps.httpTimeoutMs, HTTP_TIMEOUT),
      requestTimeout: timeoutMs(deps.httpTimeoutMs, HTTP_TIMEOUT),
    },
  });
  try {
    return await bounded(async (abortSignal) => {
      if (deps.send) return deps.send(command, { abortSignal });
      if (command instanceof InitiateAuthCommand) return client!.send(command, { abortSignal });
      return client!.send(command, { abortSignal });
    }, timeoutMs(deps.httpTimeoutMs, HTTP_TIMEOUT),
    authError('AUTH_OTP', 'メール認証を処理できませんでした。再試行するかブラウザ認証を使用してください。'), deps.signal);
  } finally {
    client?.destroy();
  }
}

function unsupportedChallenge(): CliError {
  return authError('AUTH_CHALLENGE', 'この認証方式や追加の認証には対応していません。ブラウザ認証を使用してください。');
}

export async function beginEmailOtp(config: PortalConfig, email: string, deps: AuthDeps = {}): Promise<OtpChallenge> {
  if (!text(email) || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw authError('AUTH_EMAIL', 'メールアドレスを確認してください。');
  }
  const expiresAt = Date.now() + LOGIN_TIMEOUT;
  let response = await cognitoSend(config, new InitiateAuthCommand({
    ClientId: config.userPoolClientId, AuthFlow: 'USER_AUTH',
    AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: 'EMAIL_OTP' },
  }), deps);
  let username = response.ChallengeParameters?.USERNAME ?? email;
  if (response.ChallengeName === 'SELECT_CHALLENGE'
      || (!response.ChallengeName && response.AvailableChallenges?.includes('EMAIL_OTP'))) {
    if (!response.AvailableChallenges?.includes('EMAIL_OTP') || !text(response.Session)) throw unsupportedChallenge();
    response = await cognitoSend(config, new RespondToAuthChallengeCommand({
      ClientId: config.userPoolClientId, ChallengeName: 'SELECT_CHALLENGE', Session: response.Session,
      ChallengeResponses: { USERNAME: username, ANSWER: 'EMAIL_OTP' },
    }), deps);
    username = response.ChallengeParameters?.USERNAME ?? username;
  }
  if (response.ChallengeName !== 'EMAIL_OTP' || !text(response.Session) || !text(username)) throw unsupportedChallenge();
  return { session: response.Session, username, expiresAt };
}

export async function completeEmailOtp(
  config: PortalConfig, challenge: OtpChallenge, code: string, deps: AuthDeps = {},
): Promise<Tokens> {
  if (!Number.isFinite(challenge.expiresAt) || challenge.expiresAt <= Date.now()
      || !text(challenge.session) || !text(challenge.username) || !/^\d{6,8}$/.test(code)) {
    throw authError('AUTH_OTP', '認証コードまたは有効期限を確認し、必要に応じてメール認証をやり直してください。');
  }
  const response = await cognitoSend(config, new RespondToAuthChallengeCommand({
    ClientId: config.userPoolClientId, ChallengeName: 'EMAIL_OTP', Session: challenge.session,
    ChallengeResponses: { USERNAME: challenge.username, EMAIL_OTP_CODE: code },
  }), deps);
  if (response.ChallengeName || !response.AuthenticationResult) throw unsupportedChallenge();
  const result = response.AuthenticationResult;
  return verifyTokens({
    idToken: result.IdToken ?? '', accessToken: result.AccessToken ?? '',
    ...(result.RefreshToken === undefined ? {} : { refreshToken: result.RefreshToken }),
  }, config, {}, deps);
}
