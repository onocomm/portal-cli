import type { ReadStream } from 'node:tty';
import { StringDecoder } from 'node:string_decoder';
import { CliError } from './types.js';

export function readSecretLine(input: ReadStream, write: (value: string) => void, prompt: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new CliError('STDIN_REQUIRED', '秘密入力を非表示で受け取れません。標準入力のパイプを使用してください。', 3));
      return;
    }
    const decoder = new StringDecoder('utf8');
    const wasRaw = input.isRaw;
    let value = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.off('data', onData); input.off('end', onEnd); input.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      input.setRawMode(wasRaw);
      input.pause();
      write('\n');
      if (error) reject(error); else resolve(value.trim());
    };
    const onAbort = () => finish(new CliError('INPUT_CANCELLED', '秘密入力をキャンセルしました。', 2));
    const onEnd = () => finish(new CliError('STDIN_REQUIRED', '秘密入力を完了できませんでした。', 3));
    const onError = () => finish(new CliError('STDIN_REQUIRED', '秘密入力を読み取れませんでした。', 3));
    const onData = (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (const character of text) {
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u0003' || character === '\u0004') { onAbort(); return; }
        if (character === '\u007f' || character === '\b') { value = Array.from(value).slice(0, -1).join(''); continue; }
        if (/\p{Cc}/u.test(character)) continue;
        value += character;
        if (Buffer.byteLength(value) > 131072) { finish(new CliError('INPUT_TOO_LARGE', '秘密入力が大きすぎます。', 3)); return; }
      }
    };
    try {
      input.setRawMode(true);
      write(prompt);
      input.on('data', onData); input.once('end', onEnd); input.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort(); else input.resume();
    } catch { onError(); }
  });
}
