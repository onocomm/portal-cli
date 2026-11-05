import { constants, type FileHandle } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CliError } from './types.js';

const noFollow = constants.O_NOFOLLOW ?? 0;
const own = (uid: number) => typeof process.getuid !== 'function' || uid === process.getuid();
const permissionError = () => new CliError('UNSAFE_STORE', '認証保存先の所有者・権限・シンボリックリンクを確認してください。', 5);

export class FileStore {
  readonly directory: string;
  constructor(readonly profile = 'production', base = process.env.ONOCOMM_PORTAL_HOME ?? path.join(homedir(), '.onocomm-portal')) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile)) throw new CliError('INVALID_PROFILE', 'profile名が不正です。', 3);
    const root = path.resolve(base);
    if (root === path.parse(root).root || root === homedir()) throw permissionError();
    this.directory = path.join(root, profile);
  }

  private async ensureDirectory(): Promise<void> {
    const base = path.dirname(this.directory);
    for (const dir of [base, this.directory]) {
      await fs.mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !own(stat.uid) || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw permissionError();
    }
  }

  private file(name: string): string {
    if (!['config', 'session', 'otp', 'lock'].includes(name)) throw new CliError('STORE_ERROR', '保存名が不正です。', 5);
    return path.join(this.directory, `${name}.json`);
  }

  async read<T>(name: string): Promise<T | undefined> {
    await this.ensureDirectory();
    let handle: FileHandle;
    try { handle = await fs.open(this.file(name), constants.O_RDONLY | noFollow); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw permissionError();
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !own(stat.uid) || stat.size > 1024 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw permissionError();
      return JSON.parse(await handle.readFile('utf8')) as T;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('STORE_ERROR', '保存済みデータを読み取れません。認証情報は再ログインで更新してください。', 5);
    } finally { await handle.close(); }
  }

  async write(name: string, value: unknown): Promise<void> {
    await this.ensureDirectory();
    const destination = this.file(name);
    const existing = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || !own(existing.uid) || (process.platform !== 'win32' && (existing.mode & 0o077) !== 0))) throw permissionError();
    const temp = `${destination}.${randomBytes(12).toString('hex')}.tmp`;
    try {
      const handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
      try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, destination);
    } finally { await fs.unlink(temp).catch(() => undefined); }
  }

  async remove(name: string): Promise<void> {
    await this.ensureDirectory();
    await fs.unlink(this.file(name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }

  async withLock<T>(action: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    let lock: FileHandle;
    try { lock = await fs.open(this.file('lock'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600); }
    catch { throw new CliError('SESSION_BUSY', '同じprofileの認証処理が実行中です。終了後に再実行してください。停止した処理のlockは手動で確認してください。', 5); }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid })); return await action(); }
    finally { await lock.close(); await fs.unlink(this.file('lock')); }
  }
}
