#!/usr/bin/env node
/** Browser-launched stdio bridge. It never starts an HTTP server or reads account cookies. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CompanionState, CompanionError } from './companion.mjs';
import { validateCapsule, summarizeCapsule } from './extension/handoff.js';

export const NATIVE_HOST_NAME = 'com.geoguessr.reserved_seats';
export const MAX_INPUT_BYTES = 2048;
export const MAX_OUTPUT_BYTES = 131072;
const MAX_PENDING_REQUESTS = 16;
const ORIGIN = /^chrome-extension:\/\/([a-p]{32})\/?$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SEAT_ID = /^[a-f0-9]{32}$/;
const FLAGS = ['guestListed', 'guestPresent', 'guestUnbenched', 'guestRawIsBenched', 'guestInCurrentGame',
  'guestSelectedByClientRules', 'guestMemberIndex', 'clientModeCapacity', 'guestIsOriginalPlayer',
  'guestSelectedForGame', 'currentRoundNumber', 'playerCount', 'memberCount', 'totalCount'];
const SAFE_ERRORS = new Set(['INVALID_BODY', 'INVALID_PARTY_CODE', 'INVALID_COUNT', 'INVALID_SEAT_ID',
  'SHUTTING_DOWN', 'CREATE_BUSY', 'MAX_SEATS_REACHED', 'SEAT_NOT_FOUND', 'SEAT_BUSY', 'CLOSE_FAILED',
  'HANDOFF_EXPIRED', 'SEAT_NOT_HOLDING', 'HANDOFF_DEADLINE', 'NOT_A_PARTY_CODE', 'GUESTS_NOT_ALLOWED',
  'PARTY_ALREADY_PLAYING', 'GUEST_ID_CHANGED', 'GUEST_NOT_ORIGINAL_PLAYER', 'SEAT_NOT_IN_ONGOING_DUEL',
  'UNKNOWN_PARTY_STATE', 'GUEST_COOKIE_SCOPE_MISMATCH', 'VERIFICATION_OR_DENIAL_STOPPED',
  'VERIFICATION_STOPPED', 'HTTP_FAILURE_STOPPED', 'NETWORK_FAILURE_STOPPED',
  'WS_VERIFICATION_OR_DENIAL_STOPPED', 'WS_HANDSHAKE_STOPPED', 'WS_SUBSCRIPTION_DENIED',
  'WS_NETWORK_FAILURE_STOPPED', 'REGISTERED_AUTH_FORBIDDEN', 'CLIENT_STOPPED', 'SEAT_CANCELLED',
  'WEBSOCKET_STOPPED', 'GUEST_OPERATION_FAILED', 'SEAT_HALTED', 'SEAT_BENCHED',
  'CAPACITY_UNKNOWN', 'UNSUPPORTED_GAME_TYPE', 'INSUFFICIENT_CAPACITY', 'RESERVATION_BUSY',
  'PARTY_CHANGED', 'RESERVATION_HALTED', 'INVALID_RESERVATION_COUNT', 'PARTY_LEADER_REQUIRED',
  'HOST_CONTEXT_EXPIRED', 'HOST_CONTEXT_MISMATCH', 'PARTY_CAPACITY_EXCEEDED', 'ACTIVE_PARTY_MISMATCH',
  'RESERVATION_ACTIVE', 'RESERVATION_HAS_HALTED_SEAT', 'GUEST_NOT_PRESEAT_CANDIDATE']);

export class NativeHostError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.getOwnPropertyNames(value).every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

/** Browser supplies its origin and, on Windows, an optional parent-window argument. */
export function validateLaunchOrigin(args, allowedOrigins) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 2
    || typeof args[0] !== 'string' || !ORIGIN.test(args[0])
    || args.length === 2 && !/^--parent-window=[0-9]{1,20}$/.test(args[1] ?? '')) {
    throw new NativeHostError('ORIGIN_REJECTED');
  }
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.length > 8
    || allowedOrigins.some(value => typeof value !== 'string' || !/^chrome-extension:\/\/[a-p]{32}\/$/.test(value))) {
    throw new NativeHostError('ORIGIN_REJECTED');
  }
  const origin = `chrome-extension://${ORIGIN.exec(args[0])[1]}/`;
  if (!allowedOrigins.includes(origin)) throw new NativeHostError('ORIGIN_REJECTED');
  return origin;
}

export function validateNativeRequest(value) {
  if (!plainObject(value) || typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId)
    || typeof value.action !== 'string') throw new NativeHostError('INVALID_REQUEST');
  const fields = { reserve: ['requestId', 'action', 'partyCode', 'count', 'hostContext'], status: ['requestId', 'action'],
    handoff: ['requestId', 'action', 'seatId'], remove: ['requestId', 'action', 'seatId'], shutdown: ['requestId', 'action'] };
  if (!Object.hasOwn(fields, value.action) || Object.keys(value).some(key => !fields[value.action].includes(key))
    || fields[value.action].some(key => key !== 'hostContext' && !Object.hasOwn(value, key))) throw new NativeHostError('INVALID_REQUEST');
  if (value.action === 'reserve' && (typeof value.partyCode !== 'string' || !/^[A-Za-z0-9]{5}$/.test(value.partyCode)
    || !Number.isInteger(value.count) || value.count < 0 || value.count > 100)) throw new NativeHostError('INVALID_REQUEST');
  if (value.action === 'reserve') {
    const context = value.hostContext;
    if (!(value.count === 0 && (context === undefined || context === null))) {
      const contextFields = ['partyCode', 'isLeader', 'gameState', 'guestsAllowed', 'capacity',
        'memberCount', 'participatingCount', 'roomCapacity', 'observedAt'];
      const boundedCount = number => Number.isInteger(number) && number >= 0 && number <= 101;
      if (!plainObject(context) || Object.keys(context).length !== contextFields.length
        || Object.keys(context).some(key => !contextFields.includes(key))
        || typeof context.partyCode !== 'string' || context.partyCode.toUpperCase() !== value.partyCode.toUpperCase()
        || typeof context.isLeader !== 'boolean' || typeof context.guestsAllowed !== 'boolean'
        || !['NoGame', 'Ongoing', 'Finished'].includes(context.gameState)
        || !boundedCount(context.capacity) || context.capacity < 1 || !boundedCount(context.memberCount)
        || !boundedCount(context.participatingCount) || !boundedCount(context.roomCapacity) || context.roomCapacity < 1
        || !Number.isSafeInteger(context.observedAt) || context.observedAt < 1) throw new NativeHostError('INVALID_REQUEST');
    }
  }
  if (['handoff', 'remove'].includes(value.action) && (typeof value.seatId !== 'string' || !SEAT_ID.test(value.seatId))) {
    throw new NativeHostError('INVALID_REQUEST');
  }
  return value.action === 'reserve' ? { ...value, partyCode: value.partyCode.toUpperCase(),
    ...(value.hostContext ? { hostContext: { ...value.hostContext, partyCode: value.hostContext.partyCode.toUpperCase() } } : {}) } : { ...value };
}

/** Incremental bounded binary parser: payload allocation occurs only after validating its length. */
export class NativeFrameDecoder {
  #header = Buffer.alloc(4);
  #headerSize = 0;
  #body = null;
  #bodySize = 0;
  #failed = false;
  push(chunk, onMessage) {
    if (this.#failed || !Buffer.isBuffer(chunk) || typeof onMessage !== 'function') throw new NativeHostError('PROTOCOL_ERROR');
    try {
      let position = 0;
      while (position < chunk.length) {
        if (this.#body === null) {
          const size = Math.min(4 - this.#headerSize, chunk.length - position);
          chunk.copy(this.#header, this.#headerSize, position, position + size);
          position += size; this.#headerSize += size;
          if (this.#headerSize !== 4) continue;
          const length = this.#header.readUInt32LE(0);
          if (length < 1 || length > MAX_INPUT_BYTES) throw new NativeHostError('PROTOCOL_ERROR');
          this.#body = Buffer.alloc(length); this.#bodySize = 0;
        }
        const size = Math.min(this.#body.length - this.#bodySize, chunk.length - position);
        chunk.copy(this.#body, this.#bodySize, position, position + size);
        position += size; this.#bodySize += size;
        if (this.#bodySize !== this.#body.length) continue;
        let message;
        try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.#body)); }
        catch { throw new NativeHostError('PROTOCOL_ERROR'); }
        this.#body = null; this.#headerSize = 0; this.#bodySize = 0;
        onMessage(message);
      }
    } catch (error) { this.#failed = true; throw error; }
  }
  finish() {
    if (this.#failed || this.#headerSize || this.#body !== null) throw new NativeHostError('PROTOCOL_ERROR');
  }
}

export function encodeNativeMessage(message) {
  let body;
  try { body = Buffer.from(JSON.stringify(message), 'utf8'); }
  catch { throw new NativeHostError('INVALID_RESPONSE'); }
  if (!body.length || body.length > MAX_OUTPUT_BYTES) throw new NativeHostError('RESPONSE_TOO_LARGE');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function safeError(error) {
  return error instanceof CompanionError && SAFE_ERRORS.has(error.code) ? error.code
    : error instanceof NativeHostError && ['INVALID_REQUEST', 'RESPONSE_TOO_LARGE'].includes(error.code) ? error.code
      : 'NATIVE_OPERATION_FAILED';
}
function warning(value) { return value === null || value === undefined ? null : SAFE_ERRORS.has(value) ? value : 'GUEST_OPERATION_FAILED'; }

/** Project cached status fields explicitly, so credentials can only leave through a requested handoff. */
export function publicNativeStatus(value) {
  if (!plainObject(value) || typeof value.ready !== 'boolean' || !Number.isInteger(value.maxSeats)
    || value.maxSeats < 1 || value.maxSeats > 100 || !Array.isArray(value.seats) || value.seats.length > 100) {
    throw new NativeHostError('INVALID_RESPONSE');
  }
  const seats = value.seats.map(seat => {
    if (!plainObject(seat) || !SEAT_ID.test(seat.seatId ?? '') || typeof seat.nick !== 'string' || !seat.nick.trim()
      || seat.nick.length > 30 || /[\x00-\x1f\x7f]/.test(seat.nick) || !/^[A-Z0-9]{5}$/.test(seat.partyCode ?? '')
      || !['creating', 'holding', 'halted', 'handed_off'].includes(seat.state)
      || !['unknown', 'candidate', 'benched', 'in_game'].includes(seat.selection) || !plainObject(seat.latestFlags)) {
      throw new NativeHostError('INVALID_RESPONSE');
    }
    const latestFlags = {};
    for (const key of FLAGS) {
      if (!Object.hasOwn(seat.latestFlags, key)) continue;
      const flag = seat.latestFlags[key];
      if (flag === null || typeof flag === 'boolean' || typeof flag === 'number' && Number.isFinite(flag) && Math.abs(flag) <= 10000) latestFlags[key] = flag;
    }
    return { seatId: seat.seatId, nick: seat.nick, partyCode: seat.partyCode, state: seat.state,
      selection: seat.selection, latestFlags, warning: warning(seat.warning) };
  });
  const result = { ready: value.ready, maxSeats: value.maxSeats, seats };
  if (value.reservation !== undefined) {
    const reservation = value.reservation;
    if (!plainObject(reservation) || reservation.partyCode !== null && !/^[A-Z0-9]{5}$/.test(reservation.partyCode ?? '')
      || !Number.isInteger(reservation.target) || reservation.target < 0 || reservation.target > 100
      || !['idle', 'checking', 'creating', 'holding', 'clearing', 'halted'].includes(reservation.state)) {
      throw new NativeHostError('INVALID_RESPONSE');
    }
    const nullableCount = count => count === null || Number.isInteger(count) && count >= 0 && count <= 101;
    if (!nullableCount(reservation.capacity) || !nullableCount(reservation.availableToReserve)) throw new NativeHostError('INVALID_RESPONSE');
    result.reservation = { partyCode: reservation.partyCode, target: reservation.target, state: reservation.state,
      warning: warning(reservation.warning), capacity: reservation.capacity, availableToReserve: reservation.availableToReserve };
  }
  return result;
}

/** One browser Port owns one isolated guest state; disconnect cancels that state immediately. */
export function runNativeHost({ input, output, args, allowedOrigins, state, monitorIntervalMs = 10000, signal } = {}) {
  validateLaunchOrigin(args, allowedOrigins);
  const guestState = state ?? new CompanionState();
  const decoder = new NativeFrameDecoder();
  let stopped = false, processing = false, monitoring = false, monitor;
  const pending = [];
  return new Promise(resolveDone => {
    async function stop(reason) {
      if (stopped) return;
      stopped = true; pending.length = 0; clearInterval(monitor);
      input.removeListener('data', onData); input.pause();
      signal?.removeEventListener('abort', onAbort);
      try { await guestState.shutdown(); } catch { /* Cleanup errors never include credentials. */ }
      if (output.destroyed || output.writableEnded) { resolveDone({ reason }); return; }
      try { output.end(() => resolveDone({ reason })); }
      catch { resolveDone({ reason }); }
    }
    const onAbort = () => { void stop('DISCONNECTED'); };
    function send(message) {
      if (stopped) return Promise.resolve();
      return new Promise((resolveWrite, rejectWrite) => {
        let frame;
        try { frame = encodeNativeMessage(message); } catch (error) { rejectWrite(error); return; }
        output.write(frame, error => error ? rejectWrite(new NativeHostError('OUTPUT_CLOSED')) : resolveWrite());
      });
    }
    async function dispatch(request) {
      switch (request.action) {
        case 'reserve': return publicNativeStatus(await guestState.reserve({ partyCode: request.partyCode, count: request.count,
          ...(request.hostContext ? { hostContext: request.hostContext } : {}) }));
        case 'status': return publicNativeStatus(guestState.status());
        case 'handoff': {
          const result = await guestState.handoff(request.seatId, {});
          const capsule = validateCapsule(result.capsule);
          return { capsule, summary: summarizeCapsule(capsule) };
        }
        case 'remove': {
          const result = await guestState.remove(request.seatId);
          if (result?.removed !== true) throw new NativeHostError('INVALID_RESPONSE');
          return { removed: true };
        }
        case 'shutdown': await guestState.shutdown(); return { stopped: true };
      }
      throw new NativeHostError('INVALID_REQUEST');
    }
    async function drain() {
      if (processing || stopped) return;
      processing = true;
      try {
        while (pending.length && !stopped) {
          const value = pending.shift();
          const requestId = plainObject(value) && typeof value.requestId === 'string' && REQUEST_ID.test(value.requestId) ? value.requestId : null;
          let request;
          try {
            request = validateNativeRequest(value);
            const result = await dispatch(request);
            await send({ requestId, ok: true, result });
          } catch (error) {
            if (stopped) break;
            try { await send({ requestId, ok: false, error: safeError(error) }); }
            catch { void stop('OUTPUT_CLOSED'); break; }
          }
          if (request?.action === 'shutdown') { void stop('SHUTDOWN'); break; }
        }
      } finally { processing = false; }
    }
    function onData(chunk) {
      if (stopped) return;
      try {
        decoder.push(chunk, value => {
          if (pending.length >= MAX_PENDING_REQUESTS) throw new NativeHostError('PROTOCOL_ERROR');
          pending.push(value);
        });
        void drain();
      } catch { void stop('PROTOCOL_ERROR'); }
    }
    input.on('data', onData);
    input.once('end', () => { try { decoder.finish(); void stop('DISCONNECTED'); } catch { void stop('PROTOCOL_ERROR'); } });
    input.once('error', () => { void stop('DISCONNECTED'); });
    output.once('error', () => { void stop('OUTPUT_CLOSED'); });
    output.once('close', () => { if (!stopped) void stop('OUTPUT_CLOSED'); });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { void stop('DISCONNECTED'); return; }
    monitor = setInterval(async () => {
      if (stopped || monitoring) return;
      monitoring = true;
      try { await guestState.refreshHolding(); } catch { /* Public status owns sanitized failures. */ }
      finally { monitoring = false; }
    }, monitorIntervalMs);
    monitor.unref();
  });
}

async function main() {
  const configBytes = await readFile(new URL('./native-messaging/com.geoguessr.reserved_seats.json', import.meta.url));
  if (configBytes.length > 16384) throw new NativeHostError('ORIGIN_REJECTED');
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes));
  if (config.name !== NATIVE_HOST_NAME || config.type !== 'stdio') throw new NativeHostError('ORIGIN_REJECTED');
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  await runNativeHost({ input: process.stdin, output: process.stdout, args: process.argv.slice(2),
    allowedOrigins: config.allowed_origins, signal: controller.signal });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch { process.stderr.write('Native host could not start.\n'); process.exitCode = 1; }
}
