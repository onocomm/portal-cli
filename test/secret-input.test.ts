import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ReadStream } from 'node:tty';
import { readSecretLine } from '../src/secret-input.js';

function terminal() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(value: boolean): unknown };
  input.isTTY = true; input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; return input; };
  const output: string[] = [];
  return { input, output, read: (signal?: AbortSignal) => readSecretLine(input as unknown as ReadStream, (value) => output.push(value), '秘密入力: ', signal) };
}

test('secret input: OTP/callback text is never echoed', async () => {
  for (const secret of ['123456', 'http://127.0.0.1:19878/callback?code=code-fixture&state=state-fixture']) {
    const { input, output, read } = terminal();
    const result = read();
    input.write(`${secret}\r`);
    assert.equal(await result, secret); assert.equal(input.isRaw, false);
    assert.equal(output.join(''), '秘密入力: \n');
    assert.equal(input.listenerCount('data'), 0);
    input.destroy();
  }
});
test('secret input: backspace and split UTF-8 are handled without display', async () => {
  const { input, output, read } = terminal(); const result = read();
  const bytes = Buffer.from('あ'); input.write(bytes.subarray(0, 1)); input.write(bytes.subarray(1));
  input.write('x\b\n');
  assert.equal(await result, 'あ'); assert.equal(output.join(''), '秘密入力: \n'); input.destroy();
});
test('secret input: abort restores terminal and removes listeners', async () => {
  const { input, output, read } = terminal(); const controller = new AbortController();
  const result = read(controller.signal); input.write('token-fixture'); controller.abort();
  await assert.rejects(result, { code: 'INPUT_CANCELLED' });
  assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0);
  assert.ok(!output.join('').includes('token-fixture')); input.destroy();
});
test('secret input: Ctrl-C cancels without echo', async () => {
  const { input, read } = terminal(); const result = read(); input.write('\u0003');
  await assert.rejects(result, { code: 'INPUT_CANCELLED' }); assert.equal(input.isRaw, false); input.destroy();
});
