import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/store.js';
import { productionConfig, configHash } from '../src/config.js';
import { currentTokens, saveSession, loadConfig, logout } from '../src/session.js';
import type { Tokens, Session } from '../src/types.js';

const tokens = (): Tokens => ({
  idToken: 'id-token-fixture', accessToken: 'access-token-fixture', refreshToken: 'refresh-token-fixture',
  expiresAt: Date.now() + 3600000, sub: 'fixture-user', username: 'fixture-user', clientId: productionConfig.userPoolClientId,
});
async function fixture(run: (store: FileStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'portal-session-test-'));
  try { await run(new FileStore('production', root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('session: 設定と結び付けて保存し有効期限内も検証する', async () => fixture(async (store) => {
  const original = tokens();
  await saveSession(store, productionConfig, original);
  let verified = 0;
  const result = await currentTokens(store, productionConfig, {
    verify: async (value, config) => { verified++; assert.deepEqual(value, original); assert.deepEqual(config, productionConfig); return value; },
    refresh: async () => { assert.fail('Must not refresh'); },
  });
  assert.deepEqual(result, original);
  assert.equal(verified, 1);
  const saved = await store.read<Session>('session');
  assert.equal(saved?.configHash, configHash(productionConfig));
  assert.ok(!JSON.stringify(saved).includes('secretAccessKey'));
}));

test('session: 保存なし・別設定の認証を検証/更新前に拒否する', async () => fixture(async (store) => {
  const deps = { verify: async () => { assert.fail(); }, refresh: async () => { assert.fail(); } };
  await assert.rejects(currentTokens(store, productionConfig, deps), { code: 'LOGIN_REQUIRED' });
  await saveSession(store, productionConfig, tokens());
  await assert.rejects(currentTokens(store, { ...productionConfig, appsyncEndpoint: 'https://other.example.com/graphql' }, deps), { code: 'LOGIN_REQUIRED' });
}));

test('session: 期限直前はrefreshしrotation後の値を保存する', async () => fixture(async (store) => {
  const original = { ...tokens(), expiresAt: Date.now() + 5000 };
  await saveSession(store, productionConfig, original);
  const next = { ...tokens(), refreshToken: 'rotated-refresh-fixture' };
  await currentTokens(store, productionConfig, {
    verify: async () => { assert.fail(); }, refresh: async (_config, value) => { assert.deepEqual(value, original); return next; },
  });
  assert.deepEqual((await store.read<Session>('session'))?.tokens, next);
}));

test('session: refreshなしの期限切れは明示的な再ログインを求める', async () => fixture(async (store) => {
  const { refreshToken: _refresh, ...original } = tokens();
  await saveSession(store, productionConfig, { ...original, expiresAt: Date.now() - 100 });
  await assert.rejects(currentTokens(store, productionConfig), { code: 'LOGIN_REQUIRED' });
}));

test('session: refresh失敗で認証を上書きせずlockを解放する', async () => fixture(async (store) => {
  const original = { ...tokens(), expiresAt: Date.now() - 1000 };
  await saveSession(store, productionConfig, original);
  await assert.rejects(currentTokens(store, productionConfig, { refresh: async () => { throw new Error('mock failure'); } }));
  assert.deepEqual((await store.read<Session>('session'))?.tokens, original);
  assert.equal(await store.read('lock'), undefined);
}));

test('session: 失効成功後にsessionとOTPを消す', async () => fixture(async (store) => {
  await saveSession(store, productionConfig, tokens()); await store.write('otp', { fixture: true });
  let called = 0;
  const result = await logout(store, productionConfig, false, async (token) => { called++; assert.equal(token, 'refresh-token-fixture'); });
  assert.equal(result, true); assert.equal(called, 1);
  assert.equal(await store.read('session'), undefined); assert.equal(await store.read('otp'), undefined);
}));

test('session: 失効失敗でもローカルを消すが成功と報告しない', async () => fixture(async (store) => {
  await saveSession(store, productionConfig, tokens());
  assert.equal(await logout(store, productionConfig, false, async () => { throw new Error('mock failure'); }), false);
  assert.equal(await store.read('session'), undefined);
}));

test('session: local-onlyと設定不一致ではrefresh tokenを送信しない', async () => fixture(async (store) => {
  const rejectSend = async () => { assert.fail('Must not send'); };
  await saveSession(store, productionConfig, tokens());
  assert.equal(await logout(store, productionConfig, true, rejectSend), false);
  await saveSession(store, productionConfig, tokens());
  assert.equal(await logout(store, { ...productionConfig, oauthDomain: 'https://other.example.com' }, false, rejectSend), false);
}));

test('config: production既定値以外のprofileは明示的な設定が必要', async () => fixture(async (store) => {
  assert.deepEqual(await loadConfig(store), productionConfig);
  const other = new FileStore('develop', join(store.directory, '..'));
  await assert.rejects(loadConfig(other), { code: 'CONFIG_REQUIRED' });
}));
