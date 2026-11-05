import { RevokeTokenCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { verifyTokens, refreshTokens } from './auth.js';
import { configHash, productionConfig, validateConfig } from './config.js';
import { FileStore } from './store.js';
import { CliError, type PortalConfig, type Session, type Tokens } from './types.js';

export async function loadConfig(store: FileStore): Promise<PortalConfig> {
  const configured = await store.read<unknown>('config');
  if (configured) return validateConfig(configured);
  if (store.profile === 'production') return validateConfig(productionConfig);
  throw new CliError('CONFIG_REQUIRED', 'このprofileの接続設定がありません。config set --fileで登録してください。', 3);
}

export async function saveSession(store: FileStore, config: PortalConfig, tokens: Tokens): Promise<void> {
  await store.write('session', { version: 1, configHash: configHash(config), tokens } satisfies Session);
}

export async function currentTokens(store: FileStore, config: PortalConfig, deps: {
  verify?: (tokens: Tokens, config: PortalConfig) => Promise<Tokens>;
  refresh?: (config: PortalConfig, tokens: Tokens) => Promise<Tokens>;
} = {}): Promise<Tokens> {
  return store.withLock(async () => {
    const session = await store.read<Session>('session');
    if (!session || session.version !== 1 || session.configHash !== configHash(config) || !session.tokens) throw new CliError('LOGIN_REQUIRED', '有効なPortalセッションがありません。loginを実行してください。', 2);
    let tokens: Tokens;
    if (typeof session.tokens.expiresAt !== 'number' || session.tokens.expiresAt < Date.now() + 60000) {
      if (!session.tokens.refreshToken) throw new CliError('LOGIN_REQUIRED', '認証の有効期限が切れました。loginを実行してください。', 2);
      tokens = await (deps.refresh ?? refreshTokens)(config, session.tokens);
    } else { tokens = await (deps.verify ?? verifyTokens)(session.tokens, config); }
    await saveSession(store, config, tokens);
    return tokens;
  });
}

export async function logout(store: FileStore, config: PortalConfig, localOnly = false, revoke?: (token: string) => Promise<void>): Promise<boolean> {
  return store.withLock(async () => {
    const session = await store.read<Session>('session');
    let revoked = false;
    try {
      if (!localOnly && session?.configHash === configHash(config) && session.tokens?.refreshToken) {
        const client = new CognitoIdentityProviderClient({ region: config.region, maxAttempts: 1, requestHandler: { connectionTimeout: 10000, requestTimeout: 10000 } });
        try {
          if (revoke) await revoke(session.tokens.refreshToken);
          else await client.send(new RevokeTokenCommand({ ClientId: config.userPoolClientId, Token: session.tokens.refreshToken }));
          revoked = true;
        }
        catch { /* Local removal must still complete when remote revocation fails. */ }
        finally { client.destroy(); }
      }
    } finally { await store.remove('session'); await store.remove('otp'); }
    return revoked;
  });
}
