import { CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand } from '@aws-sdk/client-cognito-identity';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import type { Operation } from './catalog.js';
import { CliError, type PortalConfig } from './types.js';

export interface IdentityResponse {
  IdentityId?: string;
  Credentials?: { AccessKeyId?: string; SecretKey?: string; SessionToken?: string; Expiration?: Date };
}
export interface TemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export async function exchangeIdentity(config: PortalConfig, idToken: string, send?: (command: unknown) => Promise<IdentityResponse>): Promise<TemporaryCredentials> {
  const client = new CognitoIdentityClient({ region: config.region, maxAttempts: 1, requestHandler: { connectionTimeout: 10000, requestTimeout: 60000 } });
  const logins = { [`cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`]: idToken };
  try {
    const identity = await (send ? send(new GetIdCommand({ IdentityPoolId: config.identityPoolId, Logins: logins })) : client.send(new GetIdCommand({ IdentityPoolId: config.identityPoolId, Logins: logins })));
    if (!identity.IdentityId) throw new Error('Missing identity');
    const result = await (send ? send(new GetCredentialsForIdentityCommand({ IdentityId: identity.IdentityId, Logins: logins })) : client.send(new GetCredentialsForIdentityCommand({ IdentityId: identity.IdentityId, Logins: logins })));
    const credentials = result.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretKey || !credentials.SessionToken || !credentials.Expiration || !Number.isFinite(credentials.Expiration.getTime()) || credentials.Expiration.getTime() <= Date.now()) throw new Error('Missing credentials');
    return { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretKey, sessionToken: credentials.SessionToken, expiration: credentials.Expiration };
  } catch {
    throw new CliError('IDENTITY_AUTH_FAILED', 'Portal利用者の一時資格情報を取得できません。ログイン状態と接続設定を確認してください。', 2);
  } finally { client.destroy(); }
}

export async function executeQuery(config: PortalConfig, credentials: TemporaryCredentials, operation: Operation, variables: Record<string, unknown>, fetcher = fetch): Promise<unknown> {
  const endpoint = new URL(config.appsyncEndpoint);
  const body = JSON.stringify({ query: operation.query, variables });
  const signer = new SignatureV4({ service: 'appsync', region: config.region, credentials, sha256: Sha256 });
  try {
    const signed = await signer.sign(new HttpRequest({
      protocol: endpoint.protocol, hostname: endpoint.hostname,
      ...(endpoint.port ? { port: Number(endpoint.port) } : {}),
      method: 'POST', path: endpoint.pathname,
      headers: { host: endpoint.host, 'content-type': 'application/json' }, body,
    }));
    const response = await fetcher(endpoint, { method: 'POST', headers: signed.headers, body, signal: AbortSignal.timeout(60000), redirect: 'error' });
    if ([401, 403].includes(response.status)) throw new CliError('ACCESS_DENIED', 'Portal APIがアクセスを拒否しました。Portal利用権限と対象顧客を確認してください。', 2);
    if (!response.ok) throw new CliError('API_HTTP_ERROR', `Portal APIへの接続に失敗しました（HTTP ${response.status}）。`, 4);
    const result = await response.json() as { data?: Record<string, unknown>; errors?: unknown[] };
    if (Array.isArray(result?.errors) && result.errors.some((error) => {
      if (!error || typeof error !== 'object') return false;
      const item = error as { errorType?: unknown; extensions?: { errorType?: unknown; code?: unknown } };
      const denied = new Set(['Unauthorized', 'UnauthorizedException', 'AccessDenied', 'AccessDeniedException', 'UNAUTHORIZED', 'FORBIDDEN', 'Forbidden']);
      return [item.errorType, item.extensions?.errorType, item.extensions?.code].some((code) => typeof code === 'string' && denied.has(code));
    })) throw new CliError('ACCESS_DENIED', 'Portal APIがアクセスを拒否しました。Portal利用権限と対象顧客を確認してください。', 2);
    if (!result || typeof result !== 'object' || (result.errors && (!Array.isArray(result.errors) || result.errors.length > 0))) throw new CliError('GRAPHQL_ERROR', 'Portal APIが操作を完了できませんでした。権限・入力・サービス状態を確認してください。', 4);
    if (!result.data || !Object.hasOwn(result.data, operation.field)) throw new CliError('INVALID_API_RESPONSE', 'Portal APIの応答形式が不正です。', 4);
    return result.data[operation.field];
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('API_CONNECTION_FAILED', 'Portal APIへの接続が失敗またはタイムアウトしました。', 4);
  }
}

export function validateInput(operation: Operation, input: unknown): Record<string, unknown> {
  const fail = () => new CliError('INVALID_INPUT', '入力項目・必須項目・型が不正です。schemaで操作仕様を確認してください。', 3);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail();
  const values = input as Record<string, unknown>;
  const parameters = [...operation.parameters, ...(operation.paginated ? [
    { name: 'limit', type: 'integer', required: false }, { name: 'nextToken', type: 'string', required: false },
  ] : [])];
  if (Object.keys(values).some((key) => !parameters.some((param) => param.name === key))) throw fail();
  for (const param of parameters) {
    const value = values[param.name];
    if (value === undefined) { if (param.required) throw fail(); continue; }
    if (param.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length > 131072)) throw fail();
    if (param.type === 'integer' && (!Number.isSafeInteger(value) || typeof value !== 'number')) throw fail();
    if (param.type === 'boolean' && typeof value !== 'boolean') throw fail();
  }
  if (values.limit !== undefined && ((values.limit as number) < 1 || (values.limit as number) > 1000)) throw fail();
  return { ...values };
}

export async function runOperation(operation: Operation, input: unknown, execute: (variables: Record<string, unknown>) => Promise<unknown>, all = false, maxPages = 1000): Promise<{ data: unknown; meta: Record<string, unknown> }> {
  const variables = validateInput(operation, input);
  if (all && !operation.paginated) throw new CliError('INVALID_INPUT', '--allは一覧操作だけで利用できます。', 3);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10000) throw new CliError('INVALID_INPUT', 'max-pagesは1から10000までです。', 3);
  if (!operation.paginated) return { data: await execute(variables), meta: { operation: operation.name } };
  const items: unknown[] = [];
  const visited = new Set<string>();
  if (typeof variables.nextToken === 'string') visited.add(variables.nextToken);
  for (let page = 1; page <= maxPages; page++) {
    const value = await execute(variables) as { items?: unknown[]; nextToken?: string | null } | null;
    if (!value || !Array.isArray(value.items) || (value.nextToken != null && typeof value.nextToken !== 'string')) throw new CliError('INVALID_API_RESPONSE', '一覧応答の形式が不正です。', 4);
    items.push(...value.items);
    const nextToken = value.nextToken || null;
    if (!all || !nextToken) return { data: items, meta: { operation: operation.name, pages: page, nextToken } };
    if (visited.has(nextToken)) throw new CliError('PAGINATION_LOOP', 'ページングトークンが重複しました。部分取得を成功として返しません。', 4);
    visited.add(nextToken);
    variables.nextToken = nextToken;
  }
  throw new CliError('PAGINATION_LIMIT', 'ページ数上限に達しました。条件を絞るかmax-pagesを調整してください。', 4);
}
