import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeSeatClient, NATIVE_HOST, classifyNativeDisconnect } from './native-client.js';

function mockPort() {
  const listeners = {};
  return {
    messages: [],
    onMessage: { addListener(fn) { listeners.message = fn; } },
    onDisconnect: { addListener(fn) { listeners.disconnect = fn; } },
    postMessage(message) { this.messages.push(message); },
    receive(message) { listeners.message(message); },
    lose() { listeners.disconnect(); },
  };
}

test('registered native host launches once and explicit request ids route responses', async () => {
  const port = mockPort();
  const names = [];
  const client = new NativeSeatClient({ connectNative(name) { names.push(name); return port; } });
  const first = client.request('status');
  const second = client.request('reserve', { partyCode: 'ABCDE', count: 5 });
  port.receive({ requestId: port.messages[1].requestId, ok: true, result: { accepted: true } });
  port.receive({ requestId: port.messages[0].requestId, ok: true, result: { seats: [] } });
  assert.deepEqual(await first, { seats: [] });
  assert.deepEqual(await second, { accepted: true });
  assert.deepEqual(names, [NATIVE_HOST]);
});

test('disconnect does not blindly restart the guest host, but explicit retry permits reconnect', async () => {
  const port = mockPort();
  let starts = 0;
  const client = new NativeSeatClient({ connectNative() { starts++; return port; } });
  const pending = client.request('status');
  port.lose();
  await assert.rejects(pending, { code: 'NATIVE_CONNECT_FAILED' });
  await assert.rejects(client.request('status'), { code: 'NATIVE_CONNECT_FAILED' });
  assert.equal(starts, 1);
  client.retryConnection();
  const retry = client.request('status');
  port.receive({ requestId: port.messages.at(-1).requestId, ok: true, result: {} });
  await retry;
  assert.equal(starts, 2);
});

const KNOWN_ERRORS = [
  ['Specified native messaging host not found.', 'NATIVE_HOST_NOT_FOUND'],
  [`Native messaging host ${NATIVE_HOST} is not registered.`, 'NATIVE_HOST_NOT_FOUND'],
  ['Access to the specified native messaging host is forbidden.', 'NATIVE_HOST_FORBIDDEN'],
  ['Failed to start native messaging host.', 'NATIVE_HOST_START_FAILED'],
  ['Native host has exited.', 'NATIVE_HOST_EXITED_BEFORE_READY'],
  ['Error when communicating with the native messaging host.', 'NATIVE_PROTOCOL_ERROR'],
  ['Invalid native messaging host name specified.', 'NATIVE_HOST_NAME_INVALID'],
];

test('documented browser errors become distinct fixed codes without returning their text', () => {
  for (const [message, code] of KNOWN_ERRORS) {
    assert.equal(classifyNativeDisconnect({ message }), code);
    assert.equal(classifyNativeDisconnect({ message: ` ${message.toUpperCase().slice(0, -1)} ` }), code);
    assert.equal(classifyNativeDisconnect({ message }, { responded: true }), 'NATIVE_DISCONNECTED');
  }
});

test('unknown, augmented, malformed, and secret-bearing errors always use the fixed initial failure', () => {
  for (const lastError of [undefined, null, {}, { message: null }, { message: 42 },
    { message: 'credential=synthetic-secret' }, { message: 'x'.repeat(513) },
    { message: 'Specified native messaging host not found. credential=synthetic-secret' },
    { message: 'Native host has exited.\ncredential=synthetic-secret' },
    { message: 'constructor' }]) {
    assert.equal(classifyNativeDisconnect(lastError), 'NATIVE_CONNECT_FAILED');
    assert.equal(classifyNativeDisconnect(lastError, { responded: true }), 'NATIVE_DISCONNECTED');
  }
});

test('initial disconnect reads lastError inside its callback and retains only a safe code until explicit retry', async () => {
  for (const [message, code] of KNOWN_ERRORS) {
    const port = mockPort(); let starts = 0, errorReads = 0, losses = 0;
    const runtime = { connectNative() { starts += 1; return port; },
      get lastError() { errorReads += 1; return { message }; } };
    const client = new NativeSeatClient(runtime, { onDisconnect() { losses += 1; } });
    const first = client.request('status'), second = client.request('reserve', { partyCode: 'ABCDE', count: 5 });
    const rejected = Promise.all([
      assert.rejects(first, error => error.code === code && error.message === code),
      assert.rejects(second, error => error.code === code && error.message === code),
    ]);
    port.lose(); await rejected;
    assert.equal(errorReads, 1); assert.equal(losses, 1);
    await assert.rejects(client.request('status'), { code });
    assert.equal(starts, 1, 'Polling must not restart a failed host.');
    client.retryConnection();
    const retry = client.request('status');
    port.receive({ requestId: port.messages.at(-1).requestId, ok: true, result: {} });
    await retry; assert.equal(starts, 2);
  }
});

test('a disconnect after an acknowledged native reply is a connection loss rather than a setup error', async () => {
  const port = mockPort(); let starts = 0;
  const runtime = { connectNative() { starts += 1; return port; }, lastError: { message: 'Native host has exited.' } };
  const client = new NativeSeatClient(runtime);
  const handshake = client.request('status');
  port.receive({ requestId: port.messages.at(-1).requestId, ok: true, result: { ready: true } });
  await handshake;
  const pending = client.request('status');
  const rejected = assert.rejects(pending, { code: 'NATIVE_DISCONNECTED' });
  port.lose(); await rejected;
  await assert.rejects(client.request('status'), { code: 'NATIVE_DISCONNECTED' });
  assert.equal(starts, 1);
});

test('a valid guest-operation denial still proves that the native host answered', async () => {
  const port = mockPort();
  const client = new NativeSeatClient({ connectNative() { return port; }, lastError: { message: 'Native host has exited.' } });
  const operation = client.request('reserve', { partyCode: 'ABCDE', count: 5 });
  const denial = assert.rejects(operation, { code: 'PARTY_CAPACITY_EXCEEDED' });
  port.receive({ requestId: port.messages.at(-1).requestId, ok: false, error: 'PARTY_CAPACITY_EXCEEDED' });
  await denial;
  const pending = client.request('status');
  const disconnected = assert.rejects(pending, { code: 'NATIVE_DISCONNECTED' });
  port.lose(); await disconnected;
});

test('unrelated messages do not count as the initial handshake', async () => {
  const port = mockPort();
  const client = new NativeSeatClient({ connectNative() { return port; }, lastError: { message: 'Native host has exited.' } });
  const pending = client.request('status');
  port.receive({ requestId: 'unrelated-request', ok: true, result: { ready: true } });
  const rejected = assert.rejects(pending, { code: 'NATIVE_HOST_EXITED_BEFORE_READY' });
  port.lose(); await rejected;
});

test('synchronous launch failures are classified and do not cause an automatic second launch', async () => {
  let starts = 0;
  const client = new NativeSeatClient({ connectNative() { starts += 1; throw new Error('Failed to start native messaging host.'); } });
  await assert.rejects(client.request('status'), { code: 'NATIVE_HOST_START_FAILED' });
  await assert.rejects(client.request('status'), { code: 'NATIVE_HOST_START_FAILED' });
  assert.equal(starts, 1);
  client.retryConnection();
  await assert.rejects(client.request('status'), { code: 'NATIVE_HOST_START_FAILED' });
  assert.equal(starts, 2);
  const unavailable = new NativeSeatClient({});
  await assert.rejects(unavailable.request('status'), { code: 'NATIVE_API_UNAVAILABLE' });
});

test('retry refuses pending requests and stale port events cannot affect a new connection', async () => {
  const oldPort = mockPort(), newPort = mockPort(); let starts = 0;
  const runtime = { connectNative() { return starts++ === 0 ? oldPort : newPort; }, lastError: { message: 'Native host has exited.' } };
  const client = new NativeSeatClient(runtime);
  const pending = client.request('status');
  assert.throws(() => client.retryConnection(), { code: 'NATIVE_BUSY' });
  const stopped = assert.rejects(pending, { code: 'NATIVE_HOST_EXITED_BEFORE_READY' });
  oldPort.lose(); await stopped;
  client.retryConnection();
  const retry = client.request('status');
  oldPort.receive({ requestId: newPort.messages.at(-1).requestId, ok: true, result: { wrongPort: true } });
  oldPort.lose();
  newPort.receive({ requestId: newPort.messages.at(-1).requestId, ok: true, result: { currentPort: true } });
  assert.deepEqual(await retry, { currentPort: true });
  assert.equal(starts, 2);
});

test('unrelated replies and raw host errors cannot disclose arbitrary values', async () => {
  const port = mockPort();
  const client = new NativeSeatClient({ connectNative() { return port; } });
  const pending = client.request('status');
  port.receive({ requestId: 'other', ok: true, result: { secret: 'ignored' } });
  port.receive({ requestId: port.messages[0].requestId, ok: false, error: 'credential=synthetic' });
  await assert.rejects(pending, { code: 'NATIVE_OPERATION_FAILED' });
  await assert.rejects(client.request('unapproved'), { code: 'INVALID_ACTION' });
  assert.equal(port.messages.length, 1);
});
