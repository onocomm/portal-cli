import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { operations, getOperation, type Operation } from './catalog.js';
import { browserLogin, beginEmailOtp, completeEmailOtp, verifyTokens, type OtpChallenge } from './auth.js';
import { validateConfig, configHash } from './config.js';
import { exchangeIdentity, executeQuery, runOperation, validateInput } from './client.js';
import { currentTokens, loadConfig, saveSession, logout } from './session.js';
import { FileStore } from './store.js';
import { CliError, type Session, type TokenInput } from './types.js';
import { readSecretLine } from './secret-input.js';

export interface CliIO {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  isTTY: boolean;
  stdin: AsyncIterable<string | Buffer>;
}
const defaultIO: CliIO = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  isTTY: Boolean(process.stdout.isTTY), stdin: process.stdin,
};

export function integer(value: string): number {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('整数を指定してください。');
  return Number(value);
}

async function readInput(io: CliIO, prompt?: string, signal?: AbortSignal): Promise<string> {
  if (process.stdin.isTTY && io === defaultIO) {
    if (!prompt) throw new CliError('STDIN_REQUIRED', '秘密情報はパイプまたは標準入力から渡してください。', 3);
    return readSecretLine(process.stdin, (value) => io.stderr(value), prompt, signal);
  }
  const cancel = () => { if (io.stdin === process.stdin) process.stdin.destroy(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    let text = '';
    for await (const chunk of io.stdin) {
      text += chunk.toString();
      if (Buffer.byteLength(text, 'utf8') > 131072) throw new CliError('INPUT_TOO_LARGE', '標準入力が大きすぎます。', 3);
    }
    return text.trim();
  } finally { signal?.removeEventListener('abort', cancel); }
}

async function readJsonFile(file: string, io: CliIO): Promise<unknown> {
  try {
    const text = file === '-' ? await readInput(io) : await readFile(file, 'utf8');
    if (Buffer.byteLength(text) > 131072) throw new Error('size');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('INVALID_JSON', 'JSONファイルまたは標準入力を読み取れません。内容とサイズを確認してください。', 3);
  }
}

export function createProgram(io = defaultIO): Command {
  const program = new Command();
  program.name('onocomm-portal').description('ONOCOMM Portal利用者向けCLI（参照専用）').version('0.1.0')
    .option('--profile <name>', 'CLIの接続・認証profile。AWS profileとは別', 'production')
    .option('--output <format>', 'json または table', io.isTTY ? 'table' : 'json')
    .option('--json', 'JSON形式で出力')
    .option('--non-interactive', '対話入力を行わない')
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: () => undefined });
  program.hook('preAction', () => {
    const output = program.opts().output;
    if (!['json', 'table'].includes(output)) throw new CliError('INVALID_OUTPUT', 'outputはjsonまたはtableを指定してください。', 3);
  });
  const store = () => new FileStore(String(program.opts().profile));
  const output = (data: unknown, meta: Record<string, unknown> = {}) => {
    if (program.opts().json || program.opts().output === 'json') {
      io.stdout(`${JSON.stringify({ ok: true, data, meta })}\n`);
    } else {
      io.stdout(`${inspect(data, { colors: false, depth: 8, maxArrayLength: 100, breakLength: 120 })}\n`);
      if (Object.keys(meta).length) io.stdout(`${JSON.stringify(meta)}\n`);
    }
  };
  const business = async (operation: Operation, input: unknown, options: { all?: boolean; maxPages?: number } = {}) => {
    const variables = validateInput(operation, input);
    if (options.all && !operation.paginated) throw new CliError('INVALID_INPUT', '--allは一覧操作だけで利用できます。', 3);
    if (options.maxPages !== undefined && (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 10000)) throw new CliError('INVALID_INPUT', 'max-pagesは1から10000までです。', 3);
    const sessionStore = store();
    const config = await loadConfig(sessionStore);
    const tokens = await currentTokens(sessionStore, config);
    const credentials = await exchangeIdentity(config, tokens.idToken);
    const result = await runOperation(operation, variables, (page) => executeQuery(config, credentials, operation, page), options.all, options.maxPages);
    output(result.data, result.meta);
  };

  const configCommand = program.command('config').description('接続設定（認証値は含めない）');
  configCommand.command('show').description('現在の接続設定を表示').action(async () => output(await loadConfig(store())));
  configCommand.command('set').description('接続設定を登録し、このprofileの保存済み認証を消去')
    .requiredOption('--file <path>', '設定JSON。標準入力は -')
    .requiredOption('--yes', '接続先の信頼性と、保存済み認証の消去を確認')
    .action(async (options: { file: string }) => {
      const config = validateConfig(await readJsonFile(options.file, io));
      const sessionStore = store();
      await sessionStore.withLock(async () => {
        await sessionStore.remove('session'); await sessionStore.remove('otp');
        await sessionStore.write('config', config);
      });
      output({ status: 'configured', profile: sessionStore.profile });
    });

  const auth = program.command('auth').description('Portal利用者の認証');
  auth.command('login').description('共通ログイン画面でブラウザ認証（PKCE）')
    .option('--no-browser', '自動起動せず認証URLを表示')
    .option('--manual', '別端末で認証し、折り返しURLを標準入力で受け取る')
    .action(async (options: { browser: boolean; manual?: boolean }) => {
      if (program.opts().nonInteractive && options.manual) throw new CliError('INTERACTION_REQUIRED', '--manualは人間の対話操作で使用してください。非対話利用は事前ログインかauth importを使用してください。', 3);
      const sessionStore = store();
      const config = await loadConfig(sessionStore);
      const controller = new AbortController();
      try {
        const tokens = await browserLogin(config, {
          openBrowser: options.browser && !options.manual && !program.opts().nonInteractive,
          onUrl: (url) => io.stderr(`ブラウザで認証してください（有効期限5分）:\n${url}\n`),
          ...(options.manual ? { manualCallback: () => readInput(io, '認証後の折り返しURL（他者へ共有しない）: ', controller.signal) } : {}),
        });
        await sessionStore.withLock(() => saveSession(sessionStore, config, tokens));
        output({ status: 'authenticated', username: tokens.username, expiresAt: new Date(tokens.expiresAt).toISOString(), refreshable: Boolean(tokens.refreshToken) });
      } finally { controller.abort(); }
    });
  auth.command('login-init').description('メールOTP認証を開始（利用可能なアカウントのみ）')
    .requiredOption('--email <email>', 'ログインメールアドレス')
    .action(async (options: { email: string }) => {
      const sessionStore = store();
      const config = await loadConfig(sessionStore);
      await sessionStore.withLock(async () => {
        const challenge = await beginEmailOtp(config, options.email);
        await sessionStore.write('otp', { configHash: configHash(config), challenge });
      });
      output({ status: 'otp_sent', message: '人間が受信したコードをauth login-verifyの標準入力へ渡してください。' });
    });
  auth.command('login-verify').description('メールOTP認証を完了。コードは引数へ渡さない')
    .option('--code-stdin', 'コードを標準入力から取得')
    .action(async (options: { codeStdin?: boolean }) => {
      if (program.opts().nonInteractive && !options.codeStdin) throw new CliError('STDIN_REQUIRED', '--code-stdinを指定してください。', 3);
      const code = await readInput(io, options.codeStdin ? undefined : 'メール確認コード: ');
      const sessionStore = store();
      const config = await loadConfig(sessionStore);
      await sessionStore.withLock(async () => {
        const saved = await sessionStore.read<{ configHash: string; challenge: OtpChallenge }>('otp');
        if (!saved || saved.configHash !== configHash(config)) throw new CliError('OTP_REQUIRED', '先にauth login-initを実行してください。', 2);
        const tokens = await completeEmailOtp(config, saved.challenge, code);
        await saveSession(sessionStore, config, tokens); await sessionStore.remove('otp');
        output({ status: 'authenticated', username: tokens.username, expiresAt: new Date(tokens.expiresAt).toISOString() });
      });
    });
  auth.command('import').description('既存の本人トークンを標準入力から取り込み、署名と宛先を検証')
    .requiredOption('--stdin', 'JSON形式のidToken/accessToken/任意refreshTokenを入力')
    .action(async () => {
      const input = await readJsonFile('-', io) as TokenInput;
      const sessionStore = store();
      const config = await loadConfig(sessionStore);
      const tokens = await verifyTokens(input, config);
      await sessionStore.withLock(() => saveSession(sessionStore, config, tokens));
      output({ status: 'authenticated', username: tokens.username, expiresAt: new Date(tokens.expiresAt).toISOString(), refreshable: Boolean(tokens.refreshToken) });
    });
  auth.command('status').description('保存済み認証の期限を表示（トークンは表示しない）').action(async () => {
    const sessionStore = store();
    const session = await sessionStore.read<Session>('session');
    const config = await loadConfig(sessionStore);
    const matches = session?.version === 1 && session.configHash === configHash(config);
    const expiresAt = matches && Number.isFinite(session.tokens?.expiresAt) ? session.tokens.expiresAt : 0;
    output({ status: expiresAt > Date.now() ? 'cached_session' : 'login_required', tokenValidUntil: expiresAt ? new Date(expiresAt).toISOString() : null, refreshable: Boolean(matches && session.tokens?.refreshToken), verifiedOnline: false });
  });
  auth.command('logout').description('このCLIのrefresh tokenを失効し、保存済み認証を削除')
    .option('--local-only', 'ネットワーク接続せず、この端末の認証を削除')
    .action(async (options: { localOnly?: boolean }) => {
      const sessionStore = store();
      const revoked = await logout(sessionStore, await loadConfig(sessionStore), options.localOnly);
      output({ status: 'logged_out', remoteRevoked: revoked, note: revoked ? 'このCLIのrefresh tokenを失効しました。' : 'ローカル認証を削除しました。リモート失効は未確認です。' });
    });
  const aliases = [
    ['login', 'ブラウザ認証', 'login'], ['logout', 'ログアウト', 'logout'], ['status', '認証状態', 'status'],
  ] as const;
  for (const [name, description, target] of aliases) {
    program.command(name).description(`${description}。詳細はauth ${target} --help`)
      .action(async () => { await auth.commands.find((command) => command.name() === target)!.parseAsync([], { from: 'user' }); });
  }

  program.command('schema').description('操作一覧または入力仕様をJSONで表示（認証不要）')
    .argument('[operation]', '例: domain.get')
    .action((name?: string) => {
      const operation = name ? getOperation(name) : undefined;
      if (name && !operation) throw new CliError('UNKNOWN_OPERATION', '指定された操作はありません。schemaで一覧を確認してください。', 3);
      output(operation ?? { schemaVersion: 1, readOnly: true, operations });
    });

  program.command('run').description('カタログ内の参照操作をJSON入力で実行（任意GraphQLは不可）')
    .argument('<operation>', '例: domain.get')
    .option('--input <json>', '入力JSON', '{}')
    .option('--input-file <path>', '入力JSONファイル。標準入力は -')
    .option('--all', '全ページを取得')
    .option('--max-pages <count>', '全件取得のページ数上限', integer, 1000)
    .action(async (name: string, options: { input: string; inputFile?: string; all?: boolean; maxPages: number }) => {
      const operation = getOperation(name);
      if (!operation) throw new CliError('UNKNOWN_OPERATION', '許可された参照操作を指定してください。', 3);
      let input: unknown;
      try { input = options.inputFile ? await readJsonFile(options.inputFile, io) : JSON.parse(options.input); }
      catch { throw new CliError('INVALID_JSON', '入力JSONが不正です。', 3); }
      await business(operation, input, options);
    });

  const groups = new Map<string, Command>([['auth', auth]]);
  for (const operation of operations) {
    const [group, action] = operation.name.split('.') as [string, string];
    let parent = groups.get(group);
    if (!parent) { parent = program.command(group).description(`${group}の参照`); groups.set(group, parent); }
    const command = parent.command(action).description(operation.description);
    for (const parameter of operation.parameters) {
      const flag = `--${parameter.name.replaceAll('_', '-')} <value>`;
      const parser: (value: string) => string | number | boolean = parameter.type === 'integer' ? integer : parameter.type === 'boolean' ? (value: string): boolean => {
        if (!['true', 'false'].includes(value)) throw new InvalidArgumentError('trueまたはfalseを指定してください。');
        return value === 'true';
      } : (value: string) => value;
      if (parameter.required) command.requiredOption(flag, parameter.description, parser);
      else command.option(flag, parameter.description, parser);
    }
    if (operation.paginated) command.option('--limit <count>', '1ページの件数（1〜1000）', integer)
      .option('--next-token <token>', '続きのページトークン')
      .option('--all', '全ページを取得').option('--max-pages <count>', '取得ページ上限', integer, 1000);
    command.action(async (options: Record<string, unknown>) => {
      const input: Record<string, unknown> = {};
      for (const parameter of operation.parameters) {
        const option = parameter.name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
        if (options[option] !== undefined) input[parameter.name] = options[option];
      }
      if (options.limit !== undefined) input.limit = options.limit;
      if (options.nextToken !== undefined) input.nextToken = options.nextToken;
      await business(operation, input, { all: Boolean(options.all), maxPages: options.maxPages as number | undefined });
    });
  }
  return program;
}

export async function main(argv = process.argv.slice(2), io = defaultIO): Promise<number> {
  try { await createProgram(io).parseAsync(argv.length ? argv : ['--help'], { from: 'user' }); return 0; }
  catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      io.stderr(`${JSON.stringify({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'コマンドまたは引数が不正です。--helpで使用方法を確認してください。' } })}\n`);
      return 3;
    }
    const problem = error instanceof CliError ? error : new CliError('CLI_ERROR', '処理を完了できませんでした。設定・入力・接続状態を確認してください。', 5);
    io.stderr(`${JSON.stringify({ ok: false, error: { code: problem.code, message: problem.message } })}\n`);
    return problem.exitCode;
  }
}
