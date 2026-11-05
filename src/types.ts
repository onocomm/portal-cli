export interface PortalConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  oauthDomain: string;
  appsyncEndpoint: string;
  redirectUri: string;
  scopes: string[];
}

export interface TokenInput {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
}

export interface Tokens extends TokenInput {
  expiresAt: number;
  sub: string;
  username: string;
  clientId: string;
}

export interface Session {
  version: 1;
  configHash: string;
  tokens: Tokens;
}

export class CliError extends Error {
  constructor(public code: string, message: string, public exitCode = 1) {
    super(message);
    this.name = 'CliError';
  }
}
