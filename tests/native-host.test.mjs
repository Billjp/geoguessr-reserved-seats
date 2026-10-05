import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { NativeFrameDecoder, NativeHostError, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES,
  encodeNativeMessage, validateNativeRequest, validateLaunchOrigin, publicNativeStatus, runNativeHost } from '../native-host.mjs';
import { CompanionState, CompanionError } from '../companion.mjs';
import { buildCapsule } from '../extension/handoff.js';

// All identities and credentials below are fixtures. These tests make no GeoGuessr requests.
const ID = 'a'.repeat(32);
const ORIGIN = `chrome-extension://${ID}`;
const ALLOWED = [`${ORIGIN}/`];
const SEAT = '0a'.repeat(16);
const CONTEXT = { partyCode: 'PZM2F', isLeader: true, gameState: 'NoGame', guestsAllowed: true,
  capacity: 20, memberCount: 1, participatingCount: 1, roomCapacity: 20, observedAt: Date.now() };
const RESERVE = { requestId: 'reserve-1', action: 'reserve', partyCode: 'PZM2F', count: 5, hostContext: CONTEXT };
const STATUS = { requestId: 'status-1', action: 'status' };
const nextTurn = () => new Promise(done => setImmediate(done));
function deferred() {
  let resolvePromise;
  const promise = new Promise(done => { resolvePromise = done; });
  return { promise, resolve: resolvePromise };
}
function status() {
  return { ready: true, maxSeats: 100, seats: [{ seatId: SEAT, nick: 'ReservedSeat-1', partyCode: 'PZM2F',
    state: 'holding', selection: 'candidate', latestFlags: { guestPresent: true, guestSelectedByClientRules: true }, warning: null }],
    reservation: { partyCode: 'PZM2F', target: 5, state: 'holding', warning: null, capacity: 20, availableToReserve: 19 } };
}
function capsule() {
  return buildCapsule({ guest: { id: 'fixture-guest', nick: 'ReservedSeat-1' },
    cookie: { name: '_geoguessr_guest', value: 'fixture-credential', domain: '.geoguessr.com', path: '/',
      secure: true, httpOnly: true, sameSite: 'lax' }, pageUrl: 'https://www.geoguessr.com/team-duels/fixture-game' });
}
function fakeState(overrides = {}) {
  const calls = [];
  return { calls, reserve: async body => { calls.push(['reserve', body]); return status(); },
    status: () => { calls.push(['status']); return status(); },
    handoff: async (id, body) => { calls.push(['handoff', id, body]); return { capsule: capsule(), summary: { untrusted: true } }; },
    remove: async id => { calls.push(['remove', id]); return { removed: true }; },
    shutdown: async () => { calls.push(['shutdown']); },
    refreshHolding: async () => { calls.push(['refresh']); }, ...overrides };
}
function frame(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function collectResponses(output) {
  let bytes = Buffer.alloc(0);
  const responses = [], readers = [];
  output.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 4) {
      const length = bytes.readUInt32LE(0);
      assert.ok(length > 0 && length <= MAX_OUTPUT_BYTES);
      if (bytes.length < length + 4) break;
      const response = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(4, length + 4)));
      bytes = bytes.subarray(length + 4);
      const reader = readers.shift();
      if (reader) reader(response); else responses.push(response);
    }
  });
  return { responses, next: () => responses.length ? Promise.resolve(responses.shift()) : new Promise(done => readers.push(done)),
    assertComplete: () => assert.equal(bytes.length, 0) };
}
function harness(t, state = fakeState(), options = {}) {
  const input = new PassThrough(), output = new PassThrough();
  const collected = collectResponses(output);
  const done = runNativeHost({ input, output, args: [ORIGIN, '--parent-window=0'], allowedOrigins: ALLOWED, state, ...options });
  t.after(async () => { input.end(); await done; collected.assertComplete(); });
  return { input, output, state, done, collected, send: value => { input.write(frame(value)); return collected.next(); } };
}

test('native framing handles every possible split, UTF-8 byte lengths, and consecutive frames', () => {
  const values = [STATUS, { requestId: 'r', action: 'status', extra: '日本語🌍' }];
  const encoded = Buffer.concat(values.map(frame));
  for (let split = 0; split <= encoded.length; split += 1) {
    const decoder = new NativeFrameDecoder(), decoded = [];
    decoder.push(encoded.subarray(0, split), value => decoded.push(value));
    decoder.push(encoded.subarray(split), value => decoded.push(value));
    decoder.finish(); assert.deepEqual(decoded, values);
  }
  const decoder = new NativeFrameDecoder(), decoded = [];
  for (const byte of encoded) decoder.push(Buffer.from([byte]), value => decoded.push(value));
  decoder.finish(); assert.deepEqual(decoded, values);
});

test('input length is checked before allocation; malformed UTF-8, JSON, and incomplete frames stop parsing', () => {
  for (const size of [0, MAX_INPUT_BYTES + 1, 0xffffffff]) {
    const header = Buffer.alloc(4); header.writeUInt32LE(size);
    const decoder = new NativeFrameDecoder();
    assert.throws(() => decoder.push(header, () => assert.fail()), NativeHostError);
    assert.throws(() => decoder.finish(), NativeHostError);
  }
  for (const payload of [Buffer.from('{'), Buffer.from([0x22, 0xc0, 0xaf, 0x22])]) {
    assert.throws(() => new NativeFrameDecoder().push(frame(payload), () => assert.fail()), NativeHostError);
  }
  for (const incomplete of [Buffer.from([5]), frame(STATUS).subarray(0, 7)]) {
    const decoder = new NativeFrameDecoder(); decoder.push(incomplete, () => assert.fail());
    assert.throws(() => decoder.finish(), NativeHostError);
  }
});

test('outgoing JSON is little endian, byte-counted, and bounded for larger reservation statuses', () => {
  const response = { requestId: 'r', ok: true, result: '日本語' };
  const encoded = encodeNativeMessage(response);
  assert.equal(encoded.readUInt32LE(0), Buffer.byteLength(JSON.stringify(response)));
  assert.deepEqual(JSON.parse(encoded.subarray(4).toString('utf8')), response);
  assert.throws(() => encodeNativeMessage({ value: 'x'.repeat(MAX_OUTPUT_BYTES) }), /RESPONSE_TOO_LARGE/);
  const large = status(); large.seats = Array.from({ length: 100 }, () => structuredClone(large.seats[0]));
  assert.ok(encodeNativeMessage({ requestId: 'r', ok: true, result: publicNativeStatus(large) }).length <= MAX_OUTPUT_BYTES + 4);
});

test('launch authorization accepts the configured exact extension only and validates Windows arguments', () => {
  assert.equal(validateLaunchOrigin([ORIGIN], ALLOWED), `${ORIGIN}/`);
  assert.equal(validateLaunchOrigin([`${ORIGIN}/`, '--parent-window=12345'], ALLOWED), `${ORIGIN}/`);
  for (const args of [[], [`chrome-extension://${'b'.repeat(32)}`], ['https://www.geoguessr.com'],
    [`${ORIGIN}/path`], [`${ORIGIN}?token=x`], [ORIGIN, '--parent-window=abc'], [ORIGIN, '--help'],
    [ORIGIN, '--parent-window=0', 'extra']]) assert.throws(() => validateLaunchOrigin(args, ALLOWED), /ORIGIN_REJECTED/);
  for (const origins of [[], ['chrome-extension://*/'], [ORIGIN], ['https://www.geoguessr.com/']]) {
    assert.throws(() => validateLaunchOrigin([ORIGIN], origins), /ORIGIN_REJECTED/);
  }
});

test('requests require an exact action schema and bounded identifiers, count, and safe host metadata', () => {
  assert.deepEqual(validateNativeRequest({ ...RESERVE, partyCode: 'pzm2f' }), RESERVE);
  for (const count of [0, 100]) assert.equal(validateNativeRequest({ ...RESERVE, count }).count, count);
  assert.equal(validateNativeRequest({ requestId: 'cancel', action: 'reserve', partyCode: 'PZM2F', count: 0 }).count, 0);
  assert.equal(validateNativeRequest({ requestId: 'cancel', action: 'reserve', partyCode: 'PZM2F', count: 0, hostContext: null }).count, 0);
  for (const value of [null, [], {}, { ...STATUS, extra: 'fixture-credential' }, { ...STATUS, action: 'toString' },
    { ...STATUS, requestId: 'x'.repeat(65) }, { ...STATUS, requestId: 'x\nsecret' }, { ...STATUS, requestId: 5 },
    { ...RESERVE, count: -1 }, { ...RESERVE, count: 101 }, { ...RESERVE, count: 1.5 }, { ...RESERVE, count: '5' },
    { ...RESERVE, hostContext: undefined }, { ...RESERVE, hostContext: { ...CONTEXT, cookie: 'fixture-credential' } },
    { ...RESERVE, hostContext: { ...CONTEXT, partyCode: 'AAAAA' } }, { ...RESERVE, hostContext: { ...CONTEXT, memberCount: -1 } },
    { ...RESERVE, hostContext: { ...CONTEXT, observedAt: NaN } }, { ...RESERVE, partyCode: 'PZM2F?auth=x' },
    { requestId: 'r', action: 'handoff', seatId: 'not-a-seat' }, { requestId: 'r', action: 'remove', seatId: SEAT, cookie: 'x' }]) {
    assert.throws(() => validateNativeRequest(value), /INVALID_REQUEST/);
  }
  const accessor = { ...STATUS }; Object.defineProperty(accessor, 'secret', { get() { assert.fail('Accessor was evaluated'); } });
  assert.throws(() => validateNativeRequest(accessor), /INVALID_REQUEST/);
});

test('cached status projects known metadata and excludes identity and credential fields at every level', () => {
  const source = status();
  source.cookie = 'fixture-credential'; source.seats[0].guestId = 'fixture-guest';
  source.seats[0].cookie = { value: 'fixture-credential' };
  source.seats[0].latestFlags.private = 'fixture-credential';
  source.reservation.cookie = 'fixture-credential'; source.reservation.warning = 'fixture-credential';
  const result = publicNativeStatus(source);
  assert.doesNotMatch(JSON.stringify(result), /fixture-credential|fixture-guest/);
  assert.equal(result.reservation.warning, 'GUEST_OPERATION_FAILED');
  assert.equal(result.seats[0].latestFlags.guestPresent, true);
  assert.throws(() => publicNativeStatus({ ...source, seats: Array(101).fill(source.seats[0]) }), /INVALID_RESPONSE/);
});

test('an unauthorized origin cannot start monitoring or call guest state', () => {
  const state = fakeState(), input = new PassThrough(), output = new PassThrough();
  assert.throws(() => runNativeHost({ input, output, state, args: ['https://attacker.test'], allowedOrigins: ALLOWED }), /ORIGIN_REJECTED/);
  assert.deepEqual(state.calls, []);
});

test('reserve forwards only exact host metadata and uses cached status without a local HTTP server', async t => {
  const h = harness(t);
  const reserved = await h.send(RESERVE);
  assert.deepEqual(reserved, { requestId: 'reserve-1', ok: true, result: status() });
  assert.deepEqual(h.state.calls[0], ['reserve', { partyCode: 'PZM2F', count: 5, hostContext: CONTEXT }]);
  const current = await h.send(STATUS);
  assert.equal(current.ok, true); assert.equal(current.result.seats[0].selection, 'candidate');
  assert.doesNotMatch(JSON.stringify(current), /fixture-credential|fixture-guest/);
});

test('invalid native requests never create or modify guests and never echo supplied secrets', async t => {
  const h = harness(t);
  const reply = await h.send({ ...RESERVE, bearer: 'fixture-credential' });
  assert.deepEqual(reply, { requestId: 'reserve-1', ok: false, error: 'INVALID_REQUEST' });
  assert.deepEqual(h.state.calls, []);
  const malformed = await h.send({ requestId: 'fixture-credential\n', action: 'status' });
  assert.deepEqual(malformed, { requestId: null, ok: false, error: 'INVALID_REQUEST' });
  assert.doesNotMatch(JSON.stringify([reply, malformed]), /fixture-credential/);
});

test('handoff is the only operation returning a validated guest capsule; its summary is regenerated', async t => {
  const h = harness(t);
  const reply = await h.send({ requestId: 'handoff-1', action: 'handoff', seatId: SEAT });
  assert.equal(reply.ok, true);
  assert.equal(reply.result.capsule.cookie.value, 'fixture-credential');
  assert.equal(reply.result.summary.cookie.value, undefined);
  assert.equal(reply.result.summary.untrusted, undefined);
  assert.deepEqual(h.state.calls[0], ['handoff', SEAT, {}]);
});

test('malformed handoff output and untrusted exception messages are replaced with fixed codes', async t => {
  const h = harness(t, fakeState({ handoff: async () => ({ capsule: { cookie: { value: 'fixture-credential' } } }),
    remove: async () => { const error = new Error('fixture-credential'); error.code = 'fixture-credential'; throw error; } }));
  for (const action of ['handoff', 'remove']) {
    const reply = await h.send({ requestId: action, action, seatId: SEAT });
    assert.deepEqual(reply, { requestId: action, ok: false, error: 'NATIVE_OPERATION_FAILED' });
    assert.doesNotMatch(JSON.stringify(reply), /fixture-credential/);
  }
});

test('only allowlisted CompanionError codes can reach the extension', async t => {
  const h = harness(t, fakeState({ reserve: async () => { throw new CompanionError('HOST_CONTEXT_EXPIRED'); },
    remove: async () => { throw new CompanionError('fixture-credential'); } }));
  assert.equal((await h.send(RESERVE)).error, 'HOST_CONTEXT_EXPIRED');
  const unknown = await h.send({ requestId: 'remove', action: 'remove', seatId: SEAT });
  assert.equal(unknown.error, 'NATIVE_OPERATION_FAILED');
});

test('delete is validated and shutdown flushes its response before ending the host', async t => {
  const h = harness(t);
  assert.deepEqual(await h.send({ requestId: 'delete', action: 'remove', seatId: SEAT }),
    { requestId: 'delete', ok: true, result: { removed: true } });
  assert.deepEqual(await h.send({ requestId: 'stop', action: 'shutdown' }),
    { requestId: 'stop', ok: true, result: { stopped: true } });
  assert.equal((await h.done).reason, 'SHUTDOWN');
  assert.ok(h.state.calls.some(call => call[0] === 'shutdown'));
});

test('messages are serialized; disconnect cancels state even while an operation is pending', async t => {
  const blocked = deferred(), state = fakeState({ reserve: async () => { state.calls.push(['reserve']); await blocked.promise; return status(); } });
  const h = harness(t, state);
  h.input.write(Buffer.concat([frame(RESERVE), frame(STATUS)]));
  await nextTurn(); assert.deepEqual(state.calls, [['reserve']]);
  h.input.end();
  assert.equal((await h.done).reason, 'DISCONNECTED');
  assert.deepEqual(state.calls, [['reserve'], ['shutdown']]);
  blocked.resolve(); await nextTurn();
  assert.deepEqual(h.collected.responses, []);
});

test('a bounded pending queue shuts down a flooding port instead of accumulating commands', async t => {
  const h = harness(t);
  h.input.write(Buffer.concat(Array.from({ length: 17 }, () => frame(STATUS))));
  assert.equal((await h.done).reason, 'PROTOCOL_ERROR');
  assert.deepEqual(h.state.calls, [['shutdown']]);
});

test('monitor refreshes are bounded and never overlap, and disconnect stops them', async t => {
  const blocked = deferred(); let refreshes = 0;
  const h = harness(t, fakeState({ refreshHolding: async () => { refreshes += 1; await blocked.promise; } }), { monitorIntervalMs: 5 });
  await new Promise(done => setTimeout(done, 25));
  assert.equal(refreshes, 1);
  h.input.end(); await h.done;
  blocked.resolve(); await new Promise(done => setTimeout(done, 15));
  assert.equal(refreshes, 1);
});

test('protocol corruption and aborted ports release guests without exposing byte contents', async t => {
  const h = harness(t);
  h.input.write(frame(Buffer.from('fixture-credential')));
  assert.equal((await h.done).reason, 'PROTOCOL_ERROR');
  assert.deepEqual(h.state.calls, [['shutdown']]);
  assert.deepEqual(h.collected.responses, []);
  const controller = new AbortController();
  const aborted = harness(t, fakeState(), { signal: controller.signal });
  controller.abort(); assert.equal((await aborted.done).reason, 'DISCONNECTED');
});

test('closing the output pipe releases guests and produces no further frames', async t => {
  const h = harness(t);
  h.output.destroy();
  assert.equal((await h.done).reason, 'OUTPUT_CLOSED');
  assert.deepEqual(h.state.calls, [['shutdown']]);
});

test('a maximum-size cached reservation status fits inside the output ceiling', async t => {
  const h = harness(t, fakeState({ status: () => {
    const large = status(); large.seats = Array.from({ length: 100 }, () => ({ ...large.seats[0], nick: 'n'.repeat(30),
      latestFlags: Object.fromEntries(['guestListed', 'guestPresent', 'guestUnbenched', 'guestRawIsBenched',
        'guestInCurrentGame', 'guestSelectedByClientRules', 'guestMemberIndex', 'clientModeCapacity', 'guestIsOriginalPlayer',
        'guestSelectedForGame', 'currentRoundNumber', 'playerCount', 'memberCount', 'totalCount'].map(key => [key, 10000])) }));
    return large;
  } }));
  // A valid maximum-seat status stays comfortably within the 128 KB native ceiling.
  const reply = await h.send(STATUS); assert.equal(reply.ok, true); assert.equal(reply.result.seats.length, 100);
});

test('real empty CompanionState returns metadata through stdio without guest operations', async t => {
  const h = harness(t, new CompanionState({ createSeat: async () => assert.fail('Unexpected GeoGuessr operation') }));
  const reply = await h.send(STATUS);
  assert.equal(reply.ok, true); assert.equal(reply.result.seats.length, 0); assert.equal(reply.result.ready, true);
});

test('native reserve drives the real batch state to five isolated fixture seats and count zero releases them', async t => {
  let created = 0, closed = 0;
  const state = new CompanionState({ inspectParty: async () => ({ gameState: 'NoGame', guestsAllowed: true,
    capacity: 20, memberCount: 1, participatingCount: 1, roomCapacity: 20 }),
    createSeat: async (_input, event) => {
      created += 1;
      event({ guestListed: true, guestPresent: true, guestSelectedByClientRules: true });
      return { refresh: async () => {}, handoff: async () => capsule(), close: async () => { closed += 1; } };
    } });
  const h = harness(t, state);
  const response = await h.send({ ...RESERVE, hostContext: { ...CONTEXT, observedAt: Date.now() } });
  assert.equal(response.ok, true); assert.equal(response.result.reservation.target, 5);
  for (let turn = 0; turn < 20 && state.status().reservation.state !== 'holding'; turn += 1) await nextTurn();
  const current = await h.send(STATUS);
  assert.equal(current.result.reservation.state, 'holding');
  assert.equal(current.result.seats.length, 5); assert.equal(created, 5);
  assert.doesNotMatch(JSON.stringify(current), /fixture-credential|fixture-guest/);
  const cancelled = await h.send({ requestId: 'cancel', action: 'reserve', partyCode: 'PZM2F', count: 0 });
  assert.equal(cancelled.ok, true); assert.equal(cancelled.result.reservation.target, 0);
  for (let turn = 0; turn < 20 && state.status().reservation.state !== 'idle'; turn += 1) await nextTurn();
  assert.equal(state.status().seats.length, 0); assert.equal(closed, 5);
});

test('a separate Node process emits only framed status and shutdown JSON, with empty stderr', async () => {
  const hostUrl = pathToFileURL(resolve('native-host.mjs')).href;
  const program = `import {runNativeHost} from ${JSON.stringify(hostUrl)}; await runNativeHost({input:process.stdin,output:process.stdout,args:[${JSON.stringify(ORIGIN)}],allowedOrigins:${JSON.stringify(ALLOWED)}});`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', program], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const collected = collectResponses(child.stdout);
  const exit = new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })); });
  child.stdin.write(frame(STATUS));
  const reply = await collected.next(); assert.equal(reply.ok, true); assert.equal(reply.result.seats.length, 0);
  child.stdin.write(frame({ requestId: 'stop', action: 'shutdown' }));
  assert.equal((await collected.next()).result.stopped, true);
  child.stdin.end();
  assert.deepEqual(await exit, { code: 0, signal: null });
  assert.equal(stderr, ''); collected.assertComplete();
});
