import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { CompanionState, createCompanionServer, createOfficialSeat, validateSeatInput, validateReservationInput, reservationCapacity, inspectOfficialParty, MAX_SEATS } from '../companion.mjs';
import { GuestClient } from '../probe.mjs';
import { buildCapsule } from '../extension/handoff.js';

// These credentials are test fixtures; no official GeoGuessr requests are made.
const TOKEN = '0a'.repeat(32);
const ORIGIN_A = `chrome-extension://${'a'.repeat(32)}`;
const ORIGIN_B = `chrome-extension://${'b'.repeat(32)}`;
const INPUT = { partyCode: 'PZM2F', nick: 'ReservedSeat-Test' };
const capsule = () => buildCapsule({ guest: { id: 'fixture-guest-id', nick: INPUT.nick },
  cookie: { name: '_geoguessr_guest', value: 'fixture-secret', domain: '.geoguessr.com',
    path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
  pageUrl: 'https://www.geoguessr.com/party/lobby/PZM2F' });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeHandle({ onRefresh = async () => {}, onClose = async () => {} } = {}) {
  let closes = 0, handoffs = 0;
  return { async refresh() { return onRefresh(); }, async handoff() { handoffs += 1; return capsule(); },
    async close() { closes += 1; await onClose(); }, get closes() { return closes; }, get handoffs() { return handoffs; } };
}
async function localServer(t, options = {}) {
  const runtime = createCompanionServer({ token: TOKEN, createSeat: async () => fakeHandle(), ...options });
  await new Promise((resolve, reject) => { runtime.server.once('error', reject); runtime.server.listen(0, '127.0.0.1', resolve); });
  const port = runtime.server.address().port;
  t.after(() => runtime.close());
  return { ...runtime, port, async send(path = '/status', { method = 'GET', body, origin = ORIGIN_A, auth = `Bearer ${TOKEN}`, headers = {} } = {}) {
    const requestHeaders = { ...(origin !== null ? { Origin: origin } : {}),
      ...(auth !== null ? { Authorization: auth } : {}), ...headers };
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    if (payload !== undefined) { requestHeaders['Content-Type'] ??= 'application/json'; requestHeaders['Content-Length'] ??= Buffer.byteLength(payload); }
    return new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, method, path, headers: requestHeaders, agent: false }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode, headers: response.headers, text, data: text ? JSON.parse(text) : null });
        });
      });
      request.once('error', reject);
      request.end(payload);
    });
  } };
}

test('seat input accepts a five-character code and bounded nick only', () => {
  assert.deepEqual(validateSeatInput({ partyCode: 'pzm2f', nick: ' Seat ' }), { partyCode: 'PZM2F', nick: 'Seat' });
  for (const body of [null, [], {}, { ...INPUT, cookie: 'secret' }, { ...INPUT, partyCode: 'abcde?x=1' },
    { ...INPUT, partyCode: 'ABCDEF' }, { ...INPUT, nick: '' }, { ...INPUT, nick: 'x'.repeat(31) }, { ...INPUT, nick: 'test\nname' }]) {
    assert.throws(() => validateSeatInput(body));
  }
});

test('local API requires loopback Host, mandatory extension Origin, and independent Bearer token', async t => {
  const local = await localServer(t, { extensionId: 'a'.repeat(32) });
  for (const options of [ { origin: null }, { origin: 'https://www.geoguessr.com' }, { origin: ORIGIN_B },
    { headers: { Host: `localhost:${local.port}` } }, { headers: { Host: `attacker.test:${local.port}` } } ]) {
    assert.equal((await local.send('/status', options)).status, 403);
  }
  assert.equal((await local.send('/status', { auth: null })).status, 401);
  assert.equal((await local.send('/status', { auth: `Bearer ${'00'.repeat(32)}` })).status, 401);
  assert.equal((await local.send(`/status?token=${TOKEN}`, { auth: null })).status, 401);
  const reply = await local.send('/status', { auth: `Bearer ${TOKEN.toUpperCase()}` });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['access-control-allow-origin'], ORIGIN_A);
  assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(reply.headers['access-control-allow-credentials'], undefined);
  assert.doesNotMatch(reply.text, new RegExp(TOKEN));
});

test('preflight and wrong credentials do not claim an unpaired extension Origin', async t => {
  const local = await localServer(t);
  const preflight = { method: 'OPTIONS', origin: ORIGIN_B, auth: null,
    headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } };
  assert.equal((await local.send('/seats', preflight)).status, 204);
  assert.equal((await local.send('/status', { origin: ORIGIN_B, auth: 'Bearer invalid' })).status, 401);
  assert.equal((await local.send('/status')).status, 200);
  const other = await local.send('/status', { origin: ORIGIN_B });
  assert.equal(other.status, 403);
  assert.equal(other.headers['access-control-allow-origin'], undefined);
  assert.equal((await local.send('/seats', { ...preflight, origin: ORIGIN_A,
    headers: { ...preflight.headers, 'Access-Control-Request-Headers': 'authorization, x-cookie' } })).status, 403);
  assert.equal((await local.send('/seats', { ...preflight, origin: ORIGIN_A,
    headers: { ...preflight.headers, 'Access-Control-Request-Method': 'PUT' } })).status, 403);
});

test('202 creates exactly one guest job, preserves creating metadata, and serializes admission', async t => {
  const job = deferred();
  let factoryCalls = 0, listener;
  const handle = fakeHandle();
  const local = await localServer(t, { createSeat: async (input, onEvent) => {
    factoryCalls += 1; assert.deepEqual(input, INPUT); listener = onEvent;
    return job.promise;
  } });
  const created = await local.send('/seats', { method: 'POST', body: INPUT });
  assert.equal(created.status, 202);
  assert.equal(created.data.seat.state, 'creating');
  assert.equal(created.data.seat.selection, 'unknown');
  assert.match(created.data.seat.seatId, /^[a-f0-9]{32}$/);
  assert.equal((await local.send('/status')).data.seats[0].state, 'creating');
  const duplicate = await local.send('/seats', { method: 'POST', body: INPUT });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error, 'CREATE_BUSY');
  assert.equal(factoryCalls, 1);
  listener({ guestListed: true, guestPresent: true, guestSelectedByClientRules: true,
    guestId: 'fixture-guest-id', cookie: 'fixture-secret', members: ['private-other-player'] });
  job.resolve(handle);
  await nextTurn();
  const status = await local.send('/status');
  assert.equal(status.data.seats[0].state, 'holding');
  assert.equal(status.data.seats[0].selection, 'candidate');
  assert.doesNotMatch(status.text, /fixture-secret|fixture-guest-id|private-other-player/);
});

test('pending deletion aborts the job and closes a late handle without recreating its seat', async () => {
  const job = deferred();
  let signal;
  const handle = fakeHandle();
  const state = new CompanionState({ createSeat: async (_input, _onEvent, options) => { signal = options.signal; return job.promise; } });
  const first = state.startCreate(INPUT);
  assert.equal(signal.aborted, false);
  await state.remove(first.seatId);
  assert.equal(signal.aborted, true);
  assert.equal(state.status().seats.length, 0);
  assert.throws(() => state.startCreate(INPUT), /CREATE_BUSY/);
  job.resolve(handle);
  await nextTurn();
  assert.equal(handle.closes, 1);
  assert.equal(state.status().seats.length, 0);
  const next = state.startCreate(INPUT);
  await nextTurn();
  assert.equal(state.status().seats[0].seatId, next.seatId);
  await state.shutdown();
});

test('held seats have a hard resource bound; delete frees capacity', async () => {
  const state = new CompanionState({ createSeat: async () => fakeHandle() });
  const a = await state.create(INPUT);
  for (let index = 1; index < MAX_SEATS; index += 1) await state.create({ ...INPUT, nick: `Seat-${index}` });
  await assert.rejects(() => state.create(INPUT), /MAX_SEATS_REACHED/);
  await state.remove(a.seatId);
  assert.equal((await state.create(INPUT)).state, 'holding');
  await state.shutdown();
});

test('body type, size, malformed JSON, and unsupported parameters are rejected before creating a guest', async t => {
  let calls = 0;
  const local = await localServer(t, { createSeat: async () => { calls += 1; return fakeHandle(); } });
  const invalid = [
    [{ body: INPUT, headers: { 'Content-Type': 'text/plain' } }, 415],
    [{ body: 'x'.repeat(2049) }, 413],
    [{ body: '{' }, 400],
    [{ body: { ...INPUT, token: TOKEN } }, 400],
  ];
  for (const [options, expected] of invalid) {
    const reply = await local.send('/seats', { method: 'POST', ...options });
    assert.equal(reply.status, expected);
    assert.doesNotMatch(reply.text, new RegExp(TOKEN));
  }
  assert.equal(calls, 0);
});

test('creation rate limit applies independently of seat count and clears after one minute', async t => {
  let clock = 0, calls = 0;
  const local = await localServer(t, { now: () => clock, createSeat: async () => { calls += 1; return fakeHandle(); } });
  for (let index = 0; index < 2; index += 1) {
    const reply = await local.send('/seats', { method: 'POST', body: INPUT });
    assert.equal(reply.status, 202);
    await nextTurn();
    assert.equal((await local.send(`/seats/${reply.data.seat.seatId}`, { method: 'DELETE' })).status, 200);
  }
  assert.equal((await local.send('/seats', { method: 'POST', body: INPUT })).status, 429);
  assert.equal(calls, 2);
  clock = 60000;
  assert.equal((await local.send('/seats', { method: 'POST', body: INPUT })).status, 202);
  assert.equal(calls, 3);
});

test('authenticated request rate is bounded without GeoGuessr calls', async t => {
  const local = await localServer(t, { now: () => 1000 });
  for (let index = 0; index < 60; index += 1) assert.equal((await local.send('/status')).status, 200);
  assert.equal((await local.send('/status')).status, 429);
});

test('deliberate handoff exports a recoverable capsule while releasing the guest handle', async t => {
  const handle = fakeHandle();
  const local = await localServer(t, { createSeat: async () => handle });
  const created = await local.send('/seats', { method: 'POST', body: INPUT });
  await nextTurn();
  const id = created.data.seat.seatId;
  const before = await local.send('/status');
  assert.doesNotMatch(before.text, /fixture-secret|fixture-guest-id/);
  const exported = await local.send(`/seats/${id}/handoff`, { method: 'POST', body: {} });
  assert.equal(exported.status, 200);
  assert.equal(exported.data.capsule.cookie.value, 'fixture-secret');
  assert.equal(exported.data.summary.cookie.value, undefined);
  assert.equal(handle.handoffs, 1);
  const after = await local.send('/status');
  assert.equal(after.data.seats[0].state, 'handed_off');
  assert.doesNotMatch(after.text, /fixture-secret|fixture-guest-id/);
  const repeated = await local.send(`/seats/${id}/handoff`, { method: 'POST', body: {} });
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.data.capsule, exported.data.capsule);
  assert.equal(handle.handoffs, 1);
  await local.send(`/seats/${id}`, { method: 'DELETE' });
  assert.equal(handle.handoffs, 1);
  assert.equal(handle.closes, 0);
});

test('capsule expiry erases its credential and rejects re-display without creating a new capsule', async () => {
  let clock = Date.now();
  const handle = fakeHandle();
  const state = new CompanionState({ createSeat: async () => handle, now: () => clock });
  const seat = await state.create(INPUT);
  const exported = await state.handoff(seat.seatId, {});
  clock = exported.capsule.expiresAt;
  assert.equal(state.status().seats[0].state, 'handed_off');
  assert.equal(state.status().seats[0].warning, 'HANDOFF_EXPIRED');
  assert.doesNotMatch(JSON.stringify(state.status()), /fixture-secret|fixture-guest-id/);
  await assert.rejects(() => state.handoff(seat.seatId, {}), /HANDOFF_EXPIRED/);
  assert.equal(handle.handoffs, 1);
  await state.shutdown();
});

test('denial halts once, sanitizes failure, and retains no retry-capable handle', async () => {
  let calls = 0;
  const state = new CompanionState({ createSeat: async () => { calls += 1; throw new Error('fixture-secret'); } });
  await assert.rejects(() => state.create(INPUT), error => error.message === 'GUEST_OPERATION_FAILED');
  assert.equal(state.status().seats[0].state, 'halted');
  assert.equal(state.status().seats[0].warning, 'GUEST_OPERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(state.status()), /fixture-secret/);
  await state.refreshHolding();
  assert.equal(calls, 1);
  await state.shutdown();
});

test('WebSocket denial closes its own guest and refuses handoff', async () => {
  let listener;
  const handle = fakeHandle();
  const state = new CompanionState({ createSeat: async (_input, onEvent) => { listener = onEvent; return handle; } });
  const seat = await state.create(INPUT);
  listener({ type: 'ws_stopped', reason: 'WS_SUBSCRIPTION_DENIED' });
  await nextTurn();
  assert.equal(state.status().seats[0].state, 'halted');
  assert.equal(handle.closes, 1);
  await assert.rejects(() => state.handoff(seat.seatId, {}), /SEAT_NOT_HOLDING/);
  await state.shutdown();
});

test('cached flags distinguish client candidate from actual game membership and reset after finish', async () => {
  let listener;
  const handle = fakeHandle({ onRefresh: async () => listener({ type: 'party_refresh', gameState: 'Finished', guestSelectedByClientRules: true }) });
  const state = new CompanionState({ createSeat: async (_input, onEvent) => { listener = onEvent; return handle; } });
  await state.create(INPUT);
  listener({ guestSelectedByClientRules: true });
  assert.equal(state.status().seats[0].selection, 'candidate');
  listener({ guestSelectedForGame: false });
  assert.equal(state.status().seats[0].selection, 'benched');
  assert.equal(state.status().seats[0].warning, 'SEAT_BENCHED');
  listener({ guestSelectedForGame: true });
  assert.equal(state.status().seats[0].selection, 'in_game');
  await state.refreshHolding();
  assert.equal(state.status().seats[0].selection, 'candidate');
  await state.shutdown();
});

test('refresh failure halts presence before a handoff can export a credential', async () => {
  const job = deferred();
  const handle = fakeHandle({ onRefresh: () => job.promise });
  const state = new CompanionState({ createSeat: async () => handle });
  const seat = await state.create(INPUT);
  const refresh = state.refreshHolding();
  const handoff = state.handoff(seat.seatId, {});
  job.reject(new Error('fixture-secret'));
  await refresh;
  await assert.rejects(handoff);
  assert.equal(handle.handoffs, 0);
  assert.equal(state.status().seats[0].state, 'halted');
  assert.doesNotMatch(JSON.stringify(state.status()), /fixture-secret/);
  await state.shutdown();
});

test('the overall handoff deadline includes waiting for an in-flight refresh', async () => {
  const job = deferred();
  let signal;
  const handle = fakeHandle({ onRefresh: () => job.promise });
  const state = new CompanionState({ handoffTimeoutMs: 20, createSeat: async (_input, _onEvent, options) => {
    signal = options.signal; return handle;
  } });
  const seat = await state.create(INPUT);
  const refresh = state.refreshHolding();
  await assert.rejects(() => state.handoff(seat.seatId, {}), /HANDOFF_DEADLINE/);
  assert.equal(signal.aborted, true);
  assert.equal(handle.handoffs, 0);
  assert.equal(handle.closes, 1);
  assert.equal(state.status().seats[0].state, 'halted');
  job.resolve();
  await refresh;
  await state.shutdown();
});

test('an invalid produced capsule never enters the recovery cache', async () => {
  const handle = fakeHandle();
  handle.handoff = async () => ({ cookie: { value: 'fixture-secret' } });
  const state = new CompanionState({ createSeat: async () => handle });
  const seat = await state.create(INPUT);
  await assert.rejects(() => state.handoff(seat.seatId, {}), /GUEST_OPERATION_FAILED/);
  await assert.rejects(() => state.handoff(seat.seatId, {}), /SEAT_NOT_HOLDING/);
  assert.equal(handle.closes, 1);
  assert.doesNotMatch(JSON.stringify(state.status()), /fixture-secret/);
  await state.shutdown();
});

test('shutdown closes existing guests and cancels future admission', async () => {
  const handle = fakeHandle();
  const state = new CompanionState({ createSeat: async () => handle });
  await state.create(INPUT);
  await state.shutdown();
  assert.equal(handle.closes, 1);
  assert.equal(state.status().ready, false);
  assert.equal(state.status().seats.length, 0);
  await assert.rejects(() => state.create(INPUT), /SHUTTING_DOWN/);
});

function reservationInput(count, overrides = {}) {
  return { partyCode: INPUT.partyCode, count, ...(count ? { hostContext: {
    partyCode: INPUT.partyCode, isLeader: true, gameState: 'NoGame', guestsAllowed: true,
    capacity: 20, memberCount: 1, participatingCount: 1, roomCapacity: 20, observedAt: Date.now(), ...overrides,
  } } : {}) };
}
const fakeInspection = async ({ hostContext }) => hostContext;
function candidate(onEvent, totalCount = 2) {
  onEvent({ guestListed: true, guestPresent: true, guestSelectedByClientRules: true, totalCount });
  return fakeHandle();
}

test('reserve validates a fresh official leader context and an arbitrary bounded integer count', () => {
  assert.equal(validateReservationInput(reservationInput(100, { capacity: 101, roomCapacity: 101 })).count, 100);
  assert.equal(validateReservationInput({ partyCode: INPUT.partyCode, count: 0, hostContext: null }).hostContext, null);
  for (const count of [-1, 101, 1.1, '5', null]) assert.throws(() => validateReservationInput(reservationInput(count)), /INVALID_RESERVATION_COUNT/);
  assert.throws(() => validateReservationInput({ partyCode: INPUT.partyCode, count: 1 }), /INVALID_BODY/);
  assert.throws(() => validateReservationInput(reservationInput(5, { isLeader: false })), /PARTY_LEADER_REQUIRED/);
  assert.throws(() => validateReservationInput(reservationInput(5, { partyCode: 'ABCDE' })), /PARTY_LEADER_REQUIRED/);
  assert.throws(() => validateReservationInput(reservationInput(5, { observedAt: Date.now() - 15001 })), /HOST_CONTEXT_EXPIRED/);
  assert.throws(() => validateReservationInput(reservationInput(5, { observedAt: Date.now() + 10000 })), /HOST_CONTEXT_EXPIRED/);
  assert.throws(() => validateReservationInput(reservationInput(5, { cookie: 'fixture-secret' })), /INVALID_BODY/);
  assert.throws(() => validateReservationInput(reservationInput(5, { gameState: 'Ongoing' })), /PARTY_ALREADY_PLAYING/);
});

test('capacity uses both mode participants and room membership while counting existing reserved slots', () => {
  assert.deepEqual(reservationCapacity(reservationInput(5).hostContext, 0, 5), { capacity: 20, availableToReserve: 19 });
  assert.deepEqual(reservationCapacity({ ...reservationInput(5).hostContext, memberCount: 6, participatingCount: 6 }, 5, 19), { capacity: 20, availableToReserve: 19 });
  assert.throws(() => reservationCapacity({ ...reservationInput(5).hostContext, roomCapacity: 5 }, 0, 5), /PARTY_CAPACITY_EXCEEDED/);
  assert.throws(() => reservationCapacity({ ...reservationInput(5).hostContext, memberCount: null }, 0, 1), /CAPACITY_UNKNOWN/);
  assert.throws(() => reservationCapacity({ ...reservationInput(5).hostContext, capacity: 2 }, 0, 5), /PARTY_CAPACITY_EXCEEDED/);
});

test('anonymous inspection corroborates room settings and sends no authentication or guest creation', async t => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, request) => {
    calls.push({ url, request });
    return new Response(JSON.stringify(url.pathname.includes('join-codes') ? { resourceType: 'PartiesV2', resourceId: 'fixture-party' } : {
      gameType: 'TeamDuels', gameState: 'NoGame', partySettings: { allowGuests: true, maxPartySize: 20 },
    }), { headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const input = reservationInput(5);
  const snapshot = await inspectOfficialParty(input);
  assert.equal(snapshot.capacity, 20);
  assert.equal(snapshot.memberCount, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.request.method === 'GET' && call.request.headers.Cookie === undefined));
  await assert.rejects(() => inspectOfficialParty(reservationInput(5, { capacity: 101 })), /HOST_CONTEXT_MISMATCH/);
  assert.ok(calls.every(call => !call.url.pathname.includes('guest-users')));
});

test('one reservation click serially creates exactly five guests; duplicate in-flight intent creates none extra', async () => {
  const firstJob = deferred();
  let calls = 0, inspections = 0, concurrent = 0, maxConcurrent = 0;
  const state = new CompanionState({ inspectParty: async input => { inspections += 1; return fakeInspection(input); },
    createSeat: async (_input, onEvent) => {
      calls += 1; concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
      const handle = candidate(onEvent, calls + 1);
      if (calls === 1) await firstJob.promise;
      concurrent -= 1; return handle;
    } });
  const input = reservationInput(5);
  assert.equal(state.reserve(input).reservation.target, 5);
  await nextTurn();
  assert.equal(state.status().reservation.state, 'creating');
  assert.equal(state.reserve(input).reservation.target, 5);
  assert.equal(calls, 1);
  firstJob.resolve();
  await nextTurn();
  const status = state.status();
  assert.equal(status.reservation.state, 'holding');
  assert.equal(status.seats.length, 5);
  assert.equal(calls, 5); assert.equal(inspections, 1); assert.equal(maxConcurrent, 1);
  state.reserve(input);
  await nextTurn();
  assert.equal(calls, 5);
  assert.doesNotMatch(JSON.stringify(status), /fixture-secret|fixture-guest-id/);
  await state.shutdown();
});

test('capacity rejection occurs before any guest creation and exposes the verified maximum', async () => {
  let calls = 0;
  const state = new CompanionState({ inspectParty: fakeInspection, createSeat: async () => { calls += 1; return fakeHandle(); } });
  state.reserve(reservationInput(5, { capacity: 2, roomCapacity: 20 }));
  await nextTurn();
  const status = state.status();
  assert.equal(status.reservation.state, 'halted');
  assert.equal(status.reservation.warning, 'PARTY_CAPACITY_EXCEEDED');
  assert.equal(status.reservation.availableToReserve, 1);
  assert.equal(calls, 0);
  await state.shutdown();
});

test('unknown capacity and ongoing-game inspection stop before creating guests', async () => {
  for (const snapshot of [ { ...reservationInput(1).hostContext, memberCount: null },
    { ...reservationInput(1).hostContext, gameState: 'Ongoing' } ]) {
    let calls = 0;
    const state = new CompanionState({ inspectParty: async () => snapshot, createSeat: async () => { calls += 1; return fakeHandle(); } });
    state.reserve(reservationInput(1));
    await nextTurn();
    assert.equal(state.status().reservation.state, 'halted');
    assert.equal(calls, 0);
    await state.shutdown();
  }
});

test('batch denial stops all queued creation and repeated intent never retries', async () => {
  let calls = 0;
  const state = new CompanionState({ inspectParty: fakeInspection, createSeat: async (_input, onEvent) => {
    calls += 1;
    if (calls === 3) throw Object.assign(new Error('fixture-secret'), { code: 'VERIFICATION_OR_DENIAL_STOPPED' });
    return candidate(onEvent, calls + 1);
  } });
  const input = reservationInput(5);
  state.reserve(input);
  await nextTurn();
  assert.equal(calls, 3);
  assert.equal(state.status().reservation.state, 'halted');
  assert.equal(state.status().reservation.warning, 'VERIFICATION_OR_DENIAL_STOPPED');
  state.reserve(input);
  await state.refreshHolding(); await nextTurn();
  assert.equal(calls, 3);
  assert.doesNotMatch(JSON.stringify(state.status()), /fixture-secret/);
  state.reserve(reservationInput(0)); await nextTurn();
  assert.equal(state.status().seats.length, 0);
  await state.shutdown();
});

test('zero aborts an in-flight guest and closes its late result without continuing the queue', async () => {
  const job = deferred();
  let calls = 0, signal;
  const handle = fakeHandle();
  const state = new CompanionState({ inspectParty: fakeInspection, createSeat: async (_input, onEvent, options) => {
    calls += 1; signal = options.signal;
    onEvent({ guestListed: true, guestPresent: true, guestSelectedByClientRules: true });
    return job.promise;
  } });
  state.reserve(reservationInput(5)); await nextTurn();
  state.reserve(reservationInput(0));
  assert.equal(signal.aborted, true);
  assert.equal(state.status().seats.length, 0);
  job.resolve(handle); await nextTurn();
  assert.equal(handle.closes, 1); assert.equal(calls, 1);
  assert.equal(state.status().reservation.state, 'idle');
  await state.shutdown();
});

test('zero cancels a pending capacity inspection before the first guest can be created', async () => {
  const job = deferred();
  let signal, calls = 0;
  const state = new CompanionState({ inspectParty: async (_input, options) => { signal = options.signal; return job.promise; },
    createSeat: async () => { calls += 1; return fakeHandle(); } });
  state.reserve(reservationInput(5));
  state.reserve(reservationInput(0));
  assert.equal(signal.aborted, true);
  job.resolve(reservationInput(5).hostContext); await nextTurn();
  assert.equal(calls, 0); assert.equal(state.status().reservation.state, 'idle');
  await state.shutdown();
});

test('decreasing target closes only excess own seats and cancels the remaining queue', async () => {
  const job = deferred();
  const handles = [];
  let calls = 0;
  const state = new CompanionState({ inspectParty: fakeInspection, createSeat: async (_input, onEvent) => {
    calls += 1; const handle = candidate(onEvent, calls + 1); handles.push(handle);
    if (calls === 4) await job.promise;
    return handle;
  } });
  state.reserve(reservationInput(5)); await nextTurn();
  assert.equal(calls, 4);
  state.reserve(reservationInput(2));
  job.resolve(); await nextTurn();
  assert.equal(calls, 4); assert.equal(state.status().seats.length, 2);
  assert.equal(state.status().reservation.state, 'holding');
  assert.deepEqual(handles.map(handle => handle.closes), [0, 0, 1, 1]);
  await state.shutdown();
});

test('handed-off slots satisfy their original target and are never replenished during a match', async () => {
  let calls = 0;
  const state = new CompanionState({ inspectParty: fakeInspection, createSeat: async (_input, onEvent) => { calls += 1; return candidate(onEvent, calls + 1); } });
  const input = reservationInput(2);
  state.reserve(input); await nextTurn();
  const id = state.status().seats[0].seatId;
  await state.handoff(id, {});
  state.reserve(input); await nextTurn();
  assert.equal(calls, 2);
  assert.equal(state.status().seats[0].state, 'handed_off');
  await state.shutdown();
});

test('shutdown cancels a pending batch and closes any late-created guest', async () => {
  const job = deferred(); let calls = 0;
  const handle = fakeHandle();
  const state = new CompanionState({ inspectParty: fakeInspection, createSeat: async () => { calls += 1; return job.promise; } });
  state.reserve(reservationInput(5)); await nextTurn();
  await state.shutdown();
  job.resolve(handle); await nextTurn();
  assert.equal(calls, 1); assert.equal(handle.closes, 1);
  assert.equal(state.status().seats.length, 0); assert.equal(state.status().ready, false);
});

test('same-turn intent changes after a no-op worker are not lost', async () => {
  let calls = 0;
  const state = new CompanionState({ inspectParty: fakeInspection, createSeat: async (_input, onEvent) => { calls += 1; return candidate(onEvent, calls + 1); } });
  await state.create(INPUT);
  state.reserve(reservationInput(1));
  state.reserve(reservationInput(2));
  await nextTurn();
  assert.equal(state.status().seats.length, 2); assert.equal(calls, 2);
  assert.equal(state.status().reservation.state, 'holding');
  await state.shutdown();
});

test('special 101-player configuration supports 100 finite sequential reservations', async () => {
  let calls = 0;
  const state = new CompanionState({ inspectParty: fakeInspection, createSeat: async (_input, onEvent) => { calls += 1; return candidate(onEvent, calls + 1); } });
  state.reserve(reservationInput(100, { capacity: 101, roomCapacity: 101 })); await nextTurn();
  assert.equal(calls, 100); assert.equal(state.status().seats.length, 100);
  assert.equal(state.status().reservation.state, 'holding');
  await state.shutdown();
});

test('new-room intent validates capacity, closes only old holders, and creates the same target automatically', async () => {
  const handles = [], rooms = [];
  const state = new CompanionState({ inspectParty: fakeInspection, createSeat: async (input, onEvent) => {
    rooms.push(input.partyCode); const handle = candidate(onEvent, rooms.length % 5 + 1); handles.push(handle); return handle;
  } });
  state.reserve(reservationInput(5)); await nextTurn();
  const next = reservationInput(5, { partyCode: 'ABCDE' }); next.partyCode = 'ABCDE';
  state.reserve(next); await nextTurn();
  assert.deepEqual(rooms, [...Array(5).fill('PZM2F'), ...Array(5).fill('ABCDE')]);
  assert.deepEqual(handles.map(handle => handle.closes), [...Array(5).fill(1), ...Array(5).fill(0)]);
  assert.equal(state.status().reservation.state, 'holding');
  assert.ok(state.status().seats.every(seat => seat.partyCode === 'ABCDE'));
  await state.shutdown();
});

test('new-room capacity failure preserves previous room holders and does not create new accounts', async () => {
  let calls = 0;
  const handles = [];
  const state = new CompanionState({ inspectParty: fakeInspection, createSeat: async (_input, onEvent) => {
    calls += 1; const handle = candidate(onEvent, calls + 1); handles.push(handle); return handle;
  } });
  state.reserve(reservationInput(5)); await nextTurn();
  const next = reservationInput(5, { partyCode: 'ABCDE', capacity: 2 }); next.partyCode = 'ABCDE';
  state.reserve(next); await nextTurn();
  assert.equal(calls, 5); assert.ok(handles.every(handle => handle.closes === 0));
  assert.equal(state.status().reservation.warning, 'PARTY_CAPACITY_EXCEEDED');
  assert.ok(state.status().seats.every(seat => seat.partyCode === 'PZM2F'));
  state.reserve(next); await nextTurn(); assert.equal(calls, 5);
  await state.shutdown();
});

test('a held guest becoming benched halts its reservation without replacing or deleting other members', async () => {
  let calls = 0; const listeners = [];
  const state = new CompanionState({ inspectParty: fakeInspection, createSeat: async (_input, onEvent) => {
    calls += 1; listeners.push(onEvent); return candidate(onEvent, calls + 1);
  } });
  const input = reservationInput(5);
  state.reserve(input); await nextTurn();
  listeners[0]({ type: 'party_refresh', gameState: 'NoGame', guestSelectedByClientRules: false });
  assert.equal(state.status().reservation.state, 'halted');
  assert.equal(state.status().reservation.warning, 'SEAT_BENCHED');
  assert.equal(state.status().seats.length, 5);
  state.reserve(input); await nextTurn(); assert.equal(calls, 5);
  await state.shutdown();
});

async function officialFixture(t, { cancelAtPresence = false, initialState = 'NoGame' } = {}) {
  const originalFetch = globalThis.fetch;
  const originalPresence = GuestClient.prototype.connectPresence;
  const controller = new AbortController();
  const calls = [];
  let state = initialState, deny = false, closes = 0;
  globalThis.fetch = async (url, request) => {
    calls.push({ path: url.pathname + url.search, method: request.method, aborted: request.signal.aborted });
    if (request.signal.aborted) throw new Error('aborted fixture request');
    if (deny && url.pathname === '/api/v4/parties/v2/fixture-party') return new Response('fixture-secret', { status: 403 });
    let payload;
    const headers = { 'Content-Type': 'application/json' };
    if (url.pathname.includes('/join-codes/')) payload = { resourceType: 'PartiesV2', resourceId: 'fixture-party' };
    else if (url.pathname.endsWith('/avatar-presets')) payload = [{}];
    else if (url.pathname === '/api/v4/guest-users') {
      payload = { id: 'fixture-guest', nick: INPUT.nick };
      headers['Set-Cookie'] = '_geoguessr_guest=fixture-secret; Domain=.geoguessr.com; Path=/; Secure; HttpOnly; SameSite=Lax';
    } else if (url.pathname.endsWith('/me')) payload = { id: 'fixture-guest', nick: INPUT.nick };
    else if (url.pathname.endsWith('/associate') || request.method === 'DELETE') return new Response(null, { status: 204 });
    else if (url.pathname === '/api/v4/parties/v2/fixture-party') payload = {
      partyId: 'fixture-party', gameType: 'TeamDuels', gameState: state, owner: { userId: 'fixture-host' },
      partySettings: { allowGuests: true, maxPartySize: 20, masterControl: false },
    };
    else if (url.pathname.endsWith('/members')) payload = { partyId: 'fixture-party', totalCount: 2, members: [
      { userId: 'fixture-host', isPresent: true }, { userId: 'fixture-guest', isPresent: true },
    ] };
    else throw new Error('unexpected fixture endpoint');
    return new Response(JSON.stringify(payload), { headers });
  };
  GuestClient.prototype.connectPresence = async () => {
    if (cancelAtPresence) controller.abort();
    return { async close() { closes += 1; }, setPlaying() {} };
  };
  t.after(() => { globalThis.fetch = originalFetch; GuestClient.prototype.connectPresence = originalPresence; });
  return { calls, controller, setState(value) { state = value; }, denyClose() { deny = true; }, get closes() { return closes; } };
}

test('removing an unused official guest verifies NoGame and permanently leaves only its own Party', async t => {
  const fixture = await officialFixture(t);
  const handle = await createOfficialSeat(INPUT, () => {}, { signal: fixture.controller.signal });
  fixture.controller.abort();
  await handle.close({ leaveParty: true });
  const deletes = fixture.calls.filter(call => call.method === 'DELETE');
  assert.deepEqual(deletes, [{ path: '/api/v4/parties/v2?permanent=true', method: 'DELETE', aborted: false }]);
  assert.equal(fixture.calls.at(-2).path, '/api/v4/parties/v2/fixture-party');
  assert.equal(fixture.closes, 1);
  await assert.rejects(() => handle.refresh(), /SEAT_ALREADY_CLOSED/);
});

test('an ongoing Duel guest closes its presence without changing the roster', async t => {
  const fixture = await officialFixture(t);
  const handle = await createOfficialSeat(INPUT, () => {}, { signal: fixture.controller.signal });
  fixture.setState('Ongoing');
  await handle.close({ leaveParty: true });
  assert.equal(fixture.calls.filter(call => call.method === 'DELETE').length, 0);
  assert.equal(fixture.closes, 1);
});

test('official handoff never leaves the Party and releases the holder even in NoGame', async t => {
  const fixture = await officialFixture(t);
  const handle = await createOfficialSeat(INPUT, () => {}, { signal: fixture.controller.signal });
  const exported = await handle.handoff();
  assert.equal(exported.cookie.value, 'fixture-secret');
  await handle.close({ leaveParty: true });
  assert.equal(fixture.calls.filter(call => call.method === 'DELETE').length, 0);
  assert.equal(fixture.closes, 1);
});

test('cleanup denial closes memory and presence once without issuing DELETE or resetting stopped auth', async t => {
  const fixture = await officialFixture(t);
  const handle = await createOfficialSeat(INPUT, () => {}, { signal: fixture.controller.signal });
  fixture.denyClose();
  await assert.rejects(() => handle.close({ leaveParty: true }), /VERIFICATION_OR_DENIAL_STOPPED/);
  const requests = fixture.calls.length;
  await handle.close({ leaveParty: true });
  assert.equal(fixture.calls.length, requests);
  assert.equal(fixture.calls.filter(call => call.method === 'DELETE').length, 0);
  assert.equal(fixture.closes, 1);
});

test('cancelled creation can clean up its own joined guest with a separate bounded cleanup signal', async t => {
  const fixture = await officialFixture(t, { cancelAtPresence: true });
  await assert.rejects(() => createOfficialSeat(INPUT, () => {}, { signal: fixture.controller.signal }), /SEAT_CANCELLED/);
  assert.equal(fixture.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.ok(fixture.calls.filter(call => call.method === 'DELETE').every(call => call.aborted === false));
  assert.equal(fixture.closes, 1);
});

test('previously stopped guest auth refuses cleanup and warns without resetting or retrying HTTP', async t => {
  const fixture = await officialFixture(t);
  const handle = await createOfficialSeat(INPUT, () => {}, { signal: fixture.controller.signal });
  fixture.denyClose();
  await assert.rejects(() => handle.refresh(), /VERIFICATION_OR_DENIAL_STOPPED/);
  const requests = fixture.calls.length;
  await assert.rejects(() => handle.close({ leaveParty: true }), /CLIENT_STOPPED/);
  assert.equal(fixture.calls.length, requests);
  assert.equal(fixture.calls.filter(call => call.method === 'DELETE').length, 0);
  assert.equal(fixture.closes, 1);
});
