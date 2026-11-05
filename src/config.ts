import { createHash } from 'node:crypto';
import { CliError, type PortalConfig } from './types.js';

// Public application identifiers, also distributed with the Portal browser app.
export const productionConfig: PortalConfig = {
  region: 'ap-northeast-1',
  userPoolId: 'ap-northeast-1_HHke70QHh',
  userPoolClientId: '5pfpt13i7476qe03mbe5c0tscd',
  identityPoolId: 'ap-northeast-1:1f786bed-1a5a-4db3-8130-1d0dc1995a9b',
  oauthDomain: 'https://login.onocomm.jp',
  appsyncEndpoint: 'https://api-portal.onocomm.jp/graphql',
  redirectUri: 'http://127.0.0.1:19878/callback',
  scopes: ['openid', 'email', 'profile', 'aws.cognito.signin.user.admin'],
};

export function validateConfig(input: unknown): PortalConfig {
  const invalid = () => new CliError('INVALID_CONFIG', '接続設定が不正です。configのスキーマとURLを確認してください。', 3);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const config = input as Record<string, unknown>;
  const keys = Object.keys(productionConfig);
  if (Object.keys(config).some((key) => !keys.includes(key)) || keys.some((key) => !(key in config))) throw invalid();
  for (const key of keys.filter((key) => key !== 'scopes')) {
    if (typeof config[key] !== 'string' || !config[key] || (config[key] as string).length > 2048) throw invalid();
  }
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(config.region as string)) throw invalid();
  if (!(config.userPoolId as string).startsWith(`${config.region}_`) || !/^[a-z0-9-]+_[A-Za-z0-9]+$/.test(config.userPoolId as string)) throw invalid();
  if (!/^[a-z0-9]+$/.test(config.userPoolClientId as string)) throw invalid();
  if (!(config.identityPoolId as string).startsWith(`${config.region}:`) || !/^[a-z0-9-]+:[0-9a-f-]{36}$/.test(config.identityPoolId as string)) throw invalid();
  try {
    for (const key of ['oauthDomain', 'appsyncEndpoint']) {
      const url = new URL(config[key] as string);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw invalid();
      if (key === 'oauthDomain' && url.pathname !== '/') throw invalid();
    }
    const redirect = new URL(config.redirectUri as string);
    if (redirect.href !== productionConfig.redirectUri) throw invalid();
  } catch { throw invalid(); }
  if (!Array.isArray(config.scopes) || !config.scopes.includes('openid') || config.scopes.length > 20 || config.scopes.some((scope) => typeof scope !== 'string' || !/^[\x21-\x7E]+$/.test(scope))) throw invalid();
  return structuredClone(config) as unknown as PortalConfig;
}

export function configHash(config: PortalConfig): string {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
}
