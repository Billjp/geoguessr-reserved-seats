#!/usr/bin/env node
/** Guest-only local companion. Normal account cookies are never read. */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { GuestClient, ProbeSession, memberSummary, guestId, ORIGIN } from './probe.mjs';
import { summarizeCapsule } from './extension/handoff.js';

export const COMPANION_PORT = 38477;
export const MAX_SEATS = 100;
const BODY_LIMIT = 2048;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;
const SEAT_ID = /^[a-f0-9]{32}$/;
const RESERVED_EVENT_KEYS = ['guestListed', 'guestPresent', 'guestUnbenched', 'guestRawIsBenched', 'guestInCurrentGame', 'guestSelectedByClientRules', 'guestMemberIndex', 'clientModeCapacity', 'guestIsOriginalPlayer', 'guestSelectedForGame', 'currentRoundNumber', 'playerCount', 'memberCount', 'totalCount'];

export class CompanionError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function objectBody(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw new CompanionError('INVALID_BODY');
  return body;
}

export function validateSeatInput(body) {
  objectBody(body, ['partyCode', 'nick']);
  if (typeof body.partyCode !== 'string' || !/^[A-Za-z0-9]{5}$/.test(body.partyCode)) throw new CompanionError('INVALID_PARTY_CODE');
  if (typeof body.nick !== 'string' || !body.nick.trim() || body.nick.length > 30 || /[\x00-\x1f\x7f]/.test(body.nick)) throw new CompanionError('INVALID_NICK');
  return { partyCode: body.partyCode.toUpperCase(), nick: body.nick.trim() };
}

const HOST_CONTEXT_KEYS = ['partyCode', 'isLeader', 'gameState', 'guestsAllowed', 'capacity', 'memberCount', 'participatingCount', 'roomCapacity', 'observedAt'];
export function validateReservationInput(body, now = Date.now()) {
  objectBody(body, ['partyCode', 'count', 'hostContext']);
  if (typeof body.partyCode !== 'string' || !/^[A-Za-z0-9]{5}$/.test(body.partyCode)) throw new CompanionError('INVALID_PARTY_CODE');
  if (!Number.isInteger(body.count) || body.count < 0 || body.count > MAX_SEATS) throw new CompanionError('INVALID_RESERVATION_COUNT');
  const partyCode = body.partyCode.toUpperCase();
  if (!body.count) return { partyCode, count: 0, hostContext: null };
  const context = objectBody(body.hostContext, HOST_CONTEXT_KEYS);
  if (context.partyCode !== partyCode || context.isLeader !== true) throw new CompanionError('PARTY_LEADER_REQUIRED', 409);
  if (!Number.isSafeInteger(context.observedAt) || context.observedAt > now || now - context.observedAt > 15000) throw new CompanionError('HOST_CONTEXT_EXPIRED', 409);
  reservationCapacity(context, 0, 0);
  return { partyCode, count: body.count, hostContext: { ...context } };
}

export function reservationCapacity(snapshot, existingCount, target) {
  if (snapshot?.guestsAllowed !== true) throw new CompanionError('GUESTS_NOT_ALLOWED', 409);
  if (snapshot?.gameState !== 'NoGame') throw new CompanionError('PARTY_ALREADY_PLAYING', 409);
  const { capacity, memberCount, participatingCount = memberCount, roomCapacity = capacity } = snapshot;
  if (![capacity, memberCount, participatingCount, roomCapacity].every(value => Number.isInteger(value) && value >= 0)
    || capacity < 2 || roomCapacity < 2 || participatingCount > memberCount) throw new CompanionError('CAPACITY_UNKNOWN', 409);
  const availableToReserve = Math.min(MAX_SEATS, existingCount + Math.max(0, Math.min(capacity - participatingCount, roomCapacity - memberCount)));
  if (target > availableToReserve) throw new CompanionError('PARTY_CAPACITY_EXCEEDED', 409);
  return { capacity, availableToReserve };
}

export async function inspectOfficialParty({ partyCode, hostContext }, { signal } = {}) {
  const client = new GuestClient({ fetchImpl: (url, options) => fetch(url, { ...options,
    signal: AbortSignal.any([signal, options.signal].filter(Boolean)),
  }) });
  const lookup = await client.lookup(partyCode);
  if (lookup?.resourceType !== 'PartiesV2' || typeof lookup.resourceId !== 'string') throw new CompanionError('NOT_A_PARTY_CODE');
  const party = await client.party(lookup.resourceId);
  const capacity = party?.gameType === 'Duels' ? 2 : party?.gameType === 'TeamDuels'
    ? party?.partySettings?.maxPartySize === 101 && party?.partySettings?.masterControl !== true ? 101 : 20 : null;
  if (!hostContext || hostContext.partyCode !== partyCode || hostContext.isLeader !== true
    || Date.now() - hostContext.observedAt > 15000) throw new CompanionError('HOST_CONTEXT_EXPIRED', 409);
  if (hostContext.capacity !== capacity || hostContext.gameState !== party?.gameState
    || hostContext.guestsAllowed !== (party?.partySettings?.allowGuests === true)
    || hostContext.roomCapacity !== party?.partySettings?.maxPartySize) throw new CompanionError('HOST_CONTEXT_MISMATCH', 409);
  // Counts come from the authorized host extension's fixed official read. The
  // anonymous service independently corroborates room settings before writes.
  return { gameState: party?.gameState, guestsAllowed: party?.partySettings?.allowGuests === true,
    capacity, memberCount: hostContext.memberCount, participatingCount: hostContext.participatingCount,
    roomCapacity: party?.partySettings?.maxPartySize };
}

function emptyBody(body) { objectBody(body, []); }
async function beforeDeadline(action, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new CompanionError('HANDOFF_DEADLINE', 504);
  let timer;
  try {
    return await Promise.race([action(), new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new CompanionError('HANDOFF_DEADLINE', 504)), remaining);
    })]);
  } finally { clearTimeout(timer); }
}
function selection(flags) {
  if (flags.guestSelectedForGame === true) return 'in_game';
  if (flags.guestSelectedForGame === false) return 'benched';
  if (flags.guestIsOriginalPlayer === true) return 'in_game';
  if (flags.guestSelectedByClientRules === false) return 'benched';
  if (flags.guestSelectedByClientRules === true) return 'candidate';
  return 'unknown';
}

function publicSeat(seat) {
  const state = seat.state;
  const selected = selection(seat.flags);
  return { seatId: seat.seatId, nick: seat.nick, partyCode: seat.partyCode, state,
    selection: selected, latestFlags: { ...seat.flags },
    warning: state === 'halted' || state === 'handed_off' && seat.failure ? seat.failure ?? 'SEAT_HALTED' : selected === 'benched' ? 'SEAT_BENCHED' : null,
  };
}

/** Source-backed guest flow; its returned handle is kept only in server memory. */
export async function createOfficialSeat(input, onEvent, { signal } = {}) {
  let operationSignal = null;
  let cleanupSignal = null;
  const guestFetch = (url, options) => fetch(url, { ...options,
    signal: AbortSignal.any([cleanupSignal ? null : signal, cleanupSignal ?? operationSignal, options.signal].filter(Boolean)),
  });
  const client = new GuestClient({ onEvent, fetchImpl: guestFetch });
  const lookup = await client.lookup(input.partyCode);
  if (lookup?.resourceType !== 'PartiesV2' || typeof lookup.resourceId !== 'string') throw new CompanionError('NOT_A_PARTY_CODE');
  const party = await client.party(lookup.resourceId);
  if (party?.partySettings?.allowGuests !== true) throw new CompanionError('GUESTS_NOT_ALLOWED', 409);
  if (party?.gameState !== 'NoGame') throw new CompanionError('PARTY_ALREADY_PLAYING', 409);
  const created = await client.createGuest(input.nick);
  const identity = await client.me();
  if (guestId(created) !== guestId(identity)) throw new CompanionError('GUEST_ID_CHANGED', 502);
  const unusedClient = new GuestClient({ onEvent, fetchImpl: guestFetch });
  const session = new ProbeSession(client, unusedClient, identity, { onEvent, allowPartyJoin: true, memberCount: 101 });
  // ProbeSession verifies a new isolated client can read the same associated Party.
  client.cloneGuestInto(unusedClient);
  let closed = false;
  const close = async ({ leaveParty = false } = {}) => {
    if (closed) return;
    closed = true;
    try {
      if (leaveParty && client.stopped) throw new CompanionError('CLIENT_STOPPED', 502);
      if (leaveParty) {
        // Cancellation may have aborted the creation controller. Cleanup is a
        // separate bounded action on this same guest, never an auth reset/retry.
        cleanupSignal = AbortSignal.timeout(8000);
        const currentParty = await client.party(lookup.resourceId);
        if (['NoGame', 'Finished'].includes(currentParty?.gameState)) await client.leaveParty();
      }
    } finally {
      try { await session.closePresence(); }
      finally { client.discardGuestCredentials(); unusedClient.discardGuestCredentials(); cleanupSignal = null; }
    }
  };
  try {
    await session.join(input.partyCode);
    if (signal?.aborted) throw new CompanionError('SEAT_CANCELLED', 410);
    await session.presence('A');
    if (signal?.aborted) throw new CompanionError('SEAT_CANCELLED', 410);
    const refresh = async () => {
      const currentParty = await client.party(lookup.resourceId);
    const info = await client.members(101);
      const flags = memberSummary(info, identity.id, currentParty);
      onEvent({ ...flags, type: 'party_refresh', gameState: currentParty?.gameState });
      return { party: currentParty, flags };
    };
    await refresh();
    return {
      async refresh() { if (closed) throw new CompanionError('SEAT_ALREADY_CLOSED', 410); return refresh(); },
      async handoff({ deadlineAt = Date.now() + 23000 } = {}) {
        if (closed) throw new CompanionError('SEAT_ALREADY_CLOSED', 410);
        // One combined budget across all official reads, without HTTP retries.
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new CompanionError('HANDOFF_DEADLINE', 504);
        operationSignal = AbortSignal.timeout(remaining);
        const { party: currentParty } = await refresh();
        let pageUrl = `${ORIGIN}/party/lobby/${input.partyCode}`;
        if (currentParty?.gameState === 'Ongoing') {
          const snapshot = await session.game('A');
          if (!snapshot) throw new CompanionError('SEAT_NOT_IN_ONGOING_DUEL', 409);
          pageUrl = `${ORIGIN}/${currentParty.gameType === 'TeamDuels' ? 'team-duels' : 'duels'}/${snapshot.id}`;
        } else if (!['NoGame', 'Finished'].includes(currentParty?.gameState)) throw new CompanionError('UNKNOWN_PARTY_STATE', 409);
        const capsule = await client.buildHandoffCapsule(pageUrl);
        if (capsule.guest.id !== identity.id) throw new CompanionError('GUEST_ID_CHANGED', 502);
        if (operationSignal.aborted || signal?.aborted) throw new CompanionError('HANDOFF_DEADLINE', 504);
        await session.closePresence();
        client.discardGuestCredentials(); unusedClient.discardGuestCredentials();
        closed = true;
        return capsule;
      },
      close,
    };
  } catch (error) {
    try { await close({ leaveParty: true }); }
    catch (cleanupError) {
      if (cleanupError?.code === 'CLIENT_STOPPED' && error?.code && error.code !== 'NETWORK_FAILURE_STOPPED') throw error;
      throw cleanupError;
    }
    throw error;
  }
}

export class CompanionState {
  #seats = new Map();
  #createSeat;
  #creating = false;
  #shuttingDown = false;
  #now;
  #handoffTimeoutMs;
  #inspectParty;
  #reservation = { partyCode: null, target: 0, state: 'idle', warning: null, capacity: null, availableToReserve: null };
  #reservationJob = null;
  #reservationController = null;
  #reservationRevision = 0;
  #hostContext = null;
  #trimJobs = new Set();
  constructor({ createSeat = createOfficialSeat, inspectParty = inspectOfficialParty, now = Date.now, handoffTimeoutMs = 25000 } = {}) {
    this.#createSeat = createSeat; this.#now = now; this.#handoffTimeoutMs = handoffTimeoutMs;
    this.#inspectParty = inspectParty;
  }
  #expire(seat) {
    if (seat.capsule && seat.capsule.expiresAt <= this.#now()) { seat.capsule = null; seat.failure = 'HANDOFF_EXPIRED'; }
  }
  status() {
    for (const seat of this.#seats.values()) this.#expire(seat);
    return { ready: !this.#shuttingDown, maxSeats: MAX_SEATS, reservation: { ...this.#reservation },
      seats: [...this.#seats.values()].filter(seat => !seat.cancelled).map(publicSeat) };
  }
  #event(seat, event) {
    if (seat.cancelled) return;
    if (Number.isInteger(event?.totalCount)) seat.memberCountObservedAt = this.#now();
    if (event?.type === 'party_refresh' && ['NoGame', 'Finished'].includes(event.gameState)) {
      delete seat.flags.guestSelectedForGame;
      delete seat.flags.guestIsOriginalPlayer;
    }
    for (const key of RESERVED_EVENT_KEYS) if (['boolean', 'number'].includes(typeof event?.[key]) || event?.[key] === null) seat.flags[key] = event[key];
    if (event?.type === 'ws_stopped') {
      seat.state = 'halted'; seat.failure = 'WEBSOCKET_STOPPED';
      const handle = seat.handle; seat.handle = null;
      handle?.close().catch(() => {});
      if (this.#reservation.target && seat.partyCode === this.#reservation.partyCode) this.#haltReservation('WEBSOCKET_STOPPED');
    }
    if (this.#reservation.target && seat.partyCode === this.#reservation.partyCode && selection(seat.flags) === 'benched') {
      this.#haltReservation('SEAT_BENCHED');
    }
  }
  #begin(body, fromReservation = false) {
    const input = validateSeatInput(body);
    if (this.#shuttingDown) throw new CompanionError('SHUTTING_DOWN', 503);
    if (!fromReservation && this.#reservation.target) throw new CompanionError('RESERVATION_ACTIVE', 409);
    if (this.#creating) throw new CompanionError('CREATE_BUSY', 409);
    if (this.#seats.size >= MAX_SEATS) throw new CompanionError('MAX_SEATS_REACHED', 409);
    const seat = { ...input, seatId: randomBytes(16).toString('hex'), state: 'creating', flags: {}, handle: null,
      busy: false, cancelled: false, controller: new AbortController(), refreshing: null, capsule: null, memberCountObservedAt: -1 };
    this.#seats.set(seat.seatId, seat);
    this.#creating = true;
    return seat;
  }
  async #finish(seat) {
    try {
      seat.handle = await this.#createSeat({ partyCode: seat.partyCode, nick: seat.nick }, event => this.#event(seat, event), { signal: seat.controller.signal });
      if (this.#shuttingDown || seat.cancelled) { await seat.handle.close({ leaveParty: true }); seat.handle = null; throw new CompanionError('SEAT_CANCELLED', 410); }
      if (seat.state === 'halted') { await seat.handle.close(); seat.handle = null; throw new CompanionError('WEBSOCKET_STOPPED', 502); }
      if (seat.state !== 'halted') seat.state = 'holding';
      return publicSeat(seat);
    } catch (error) {
      seat.state = 'halted'; seat.failure = safeFailure(error); seat.handle = null;
      throw new CompanionError(seat.failure, error instanceof CompanionError ? error.status : 502);
    } finally { this.#creating = false; }
  }
  async create(body) { return this.#finish(this.#begin(body)); }
  startCreate(body) {
    const seat = this.#begin(body);
    this.#finish(seat).catch(() => { /* Failure is retained as safe status metadata. */ });
    return publicSeat(seat);
  }
  #ownSeats() { return [...this.#seats.values()].filter(seat => !seat.cancelled && seat.partyCode === this.#reservation.partyCode); }
  #haltReservation(code) {
    this.#reservation.state = 'halted'; this.#reservation.warning = code;
    this.#reservationController?.abort();
    for (const seat of this.#ownSeats()) if (seat.state === 'creating') {
      seat.cancelled = true; seat.controller.abort(); this.#seats.delete(seat.seatId);
    }
  }
  reserve(body) {
    const input = validateReservationInput(body, this.#now());
    if (this.#shuttingDown) throw new CompanionError('SHUTTING_DOWN', 503);
    const active = [...this.#seats.values()].filter(seat => !seat.cancelled);
    const changingParty = input.count && active.some(seat => seat.partyCode !== input.partyCode);
    if (input.partyCode === this.#reservation.partyCode && input.count === this.#reservation.target) return this.status();
    const excess = changingParty ? [] : active.slice(input.count);
    if (excess.some(seat => seat.busy)) throw new CompanionError('SEAT_BUSY', 409);
    this.#reservationRevision += 1;
    this.#hostContext = input.hostContext;
    this.#reservationController?.abort();
    this.#reservation = { partyCode: input.partyCode, target: input.count,
      state: input.count ? 'checking' : 'clearing', warning: null, capacity: null, availableToReserve: null };
    for (const seat of excess) {
      // Abort immediately, including a currently-creating seat. The worker cannot
      // turn its late response into another held slot after deletion.
      const job = this.remove(seat.seatId).catch(error => {
        if (!this.#shuttingDown) this.#haltReservation(safeFailure(error));
      }).finally(() => this.#trimJobs.delete(job));
      this.#trimJobs.add(job);
    }
    this.#ensureReservationJob();
    return this.status();
  }
  #ensureReservationJob() {
    if (this.#reservationJob || this.#shuttingDown) return;
    this.#reservationJob = this.#runReservation().catch(error => {
      if (!this.#shuttingDown) this.#haltReservation(safeFailure(error));
    }).finally(() => {
      this.#reservationJob = null;
      // Multiple Native Messaging frames can change intent in the same turn
      // after the previous worker returned but before its finally callback.
      if (['checking', 'clearing'].includes(this.#reservation.state)) this.#ensureReservationJob();
    });
  }
  async #runReservation() {
    while (!this.#shuttingDown) {
      const revision = this.#reservationRevision;
      if (this.#trimJobs.size) await Promise.allSettled([...this.#trimJobs]);
      if (revision !== this.#reservationRevision) continue;
      if (this.#reservation.state === 'halted') return;
      const target = this.#reservation.target;
      const own = this.#ownSeats();
      if (!target) { this.#reservation.state = 'idle'; return; }
      if (own.some(seat => seat.state === 'halted')) { this.#haltReservation('RESERVATION_HAS_HALTED_SEAT'); return; }
      // A handed-off guest remains an allocated slot. It is never replenished.
      if (own.length >= target) { this.#reservation.state = 'holding'; return; }
      if (this.#creating) { this.#haltReservation('CREATE_BUSY'); return; }
      this.#reservation.state = 'checking';
      this.#reservationController = new AbortController();
      try {
        const snapshot = await this.#inspectParty({ partyCode: this.#reservation.partyCode, hostContext: this.#hostContext }, { signal: this.#reservationController.signal });
        if (revision !== this.#reservationRevision || this.#shuttingDown) continue;
        const knownCount = Math.max(snapshot.memberCount ?? 0, ...own.map(seat =>
          Number.isInteger(seat.flags.totalCount) && seat.memberCountObservedAt >= this.#hostContext.observedAt ? seat.flags.totalCount : 0));
        const adjusted = { ...snapshot, memberCount: knownCount,
          participatingCount: (snapshot.participatingCount ?? snapshot.memberCount) + knownCount - snapshot.memberCount };
        Object.assign(this.#reservation, reservationCapacity(adjusted, own.length, 0));
        if (target > this.#reservation.availableToReserve) throw new CompanionError('PARTY_CAPACITY_EXCEEDED', 409);
        const oldSeats = [...this.#seats.values()].filter(seat => !seat.cancelled && seat.partyCode !== this.#reservation.partyCode);
        if (oldSeats.some(seat => seat.busy)) throw new CompanionError('SEAT_BUSY', 409);
        // Validate the new room before releasing any holder from the old one.
        if (oldSeats.length) {
          this.#reservation.state = 'clearing';
          await Promise.all(oldSeats.map(seat => this.remove(seat.seatId)));
          if (revision !== this.#reservationRevision || this.#shuttingDown) continue;
        }
        this.#reservation.state = 'creating';
        while (revision === this.#reservationRevision && !this.#shuttingDown
          && this.#reservation.state !== 'halted' && this.#ownSeats().length < this.#reservation.target) {
          const used = new Set(this.#ownSeats().map(seat => seat.nick));
          let index = 1;
          while (used.has(`ReservedSeat-${index}`)) index += 1;
          const seat = this.#begin({ partyCode: this.#reservation.partyCode, nick: `ReservedSeat-${index}` }, true);
          await this.#finish(seat);
          if (revision !== this.#reservationRevision || this.#shuttingDown) break;
          if (seat.flags.guestListed !== true || seat.flags.guestPresent !== true || seat.flags.guestSelectedByClientRules !== true) {
            throw new CompanionError('GUEST_NOT_PRESEAT_CANDIDATE', 409);
          }
        }
        if (revision === this.#reservationRevision && this.#reservation.state !== 'halted') this.#reservation.state = 'holding';
      } catch (error) {
        if (this.#shuttingDown) return;
        if (this.#reservation.state === 'halted') return;
        if (revision !== this.#reservationRevision && ['SEAT_CANCELLED', 'NETWORK_FAILURE_STOPPED'].includes(error?.code)) continue;
        this.#haltReservation(safeFailure(error)); return;
      }
      if (revision === this.#reservationRevision) return;
    }
  }
  async refreshHolding() {
    await Promise.allSettled([...this.#seats.values()].map(async seat => {
      this.#expire(seat);
      if (this.#shuttingDown || seat.cancelled || seat.busy || seat.state !== 'holding' || !seat.handle || seat.refreshing) return;
      const handle = seat.handle;
      seat.refreshing = handle.refresh().catch(async error => {
        if (seat.cancelled) return;
        seat.state = 'halted'; seat.failure = safeFailure(error);
        if (this.#reservation.target && seat.partyCode === this.#reservation.partyCode) this.#haltReservation(seat.failure);
        try { await handle.close(); } catch { /* No retry after failure. */ }
        seat.handle = null;
      }).finally(() => { seat.refreshing = null; });
      await seat.refreshing;
    }));
  }
  async handoff(id, body) {
    emptyBody(body);
    const seat = this.#seat(id);
    this.#expire(seat);
    if (seat.state === 'handed_off') {
      if (!seat.capsule) throw new CompanionError('HANDOFF_EXPIRED', 409);
      return { capsule: seat.capsule, summary: summarizeCapsule(seat.capsule) };
    }
    if (seat.state !== 'holding' || !seat.handle) throw new CompanionError('SEAT_NOT_HOLDING', 409);
    if (seat.busy) throw new CompanionError('SEAT_BUSY', 409);
    seat.busy = true;
    const startedAt = Date.now();
    const networkDeadline = startedAt + Math.min(23000, this.#handoffTimeoutMs);
    const overallDeadline = startedAt + this.#handoffTimeoutMs;
    try {
      if (seat.refreshing) await beforeDeadline(() => seat.refreshing, networkDeadline);
      if (seat.state !== 'holding' || !seat.handle) throw new CompanionError('SEAT_NOT_HOLDING', 409);
      const capsule = await beforeDeadline(() => seat.handle.handoff({ deadlineAt: networkDeadline }), overallDeadline);
      if (seat.state !== 'holding') throw new CompanionError('SEAT_NOT_HOLDING', 409);
      const summary = summarizeCapsule(capsule);
      seat.state = 'handed_off'; seat.handle = null; seat.capsule = capsule;
      return { capsule, summary };
    } catch (error) {
      seat.state = 'halted'; seat.failure = safeFailure(error);
      seat.capsule = null; seat.controller.abort();
      try { await seat.handle?.close(); } catch { /* Guest connection is already stopped. */ }
      seat.handle = null;
      throw new CompanionError(seat.failure, error instanceof CompanionError ? error.status : 502);
    } finally { seat.busy = false; }
  }
  async remove(id) {
    const seat = this.#seat(id);
    if (seat.busy) throw new CompanionError('SEAT_BUSY', 409);
    seat.cancelled = true;
    seat.capsule = null;
    seat.controller.abort();
    seat.busy = true;
    try { await seat.handle?.close({ leaveParty: true }); this.#seats.delete(id); return { removed: true }; }
    catch (error) {
      seat.state = 'halted'; seat.failure = safeFailure(error);
      if (seat.failure === 'GUEST_OPERATION_FAILED') seat.failure = 'CLOSE_FAILED';
      seat.handle = null;
      throw new CompanionError(seat.failure, 502);
    }
    finally { seat.busy = false; }
  }
  #seat(id) {
    if (!SEAT_ID.test(id ?? '')) throw new CompanionError('INVALID_SEAT_ID');
    const seat = this.#seats.get(id);
    if (!seat) throw new CompanionError('SEAT_NOT_FOUND', 404);
    return seat;
  }
  async shutdown() {
    this.#shuttingDown = true;
    this.#reservationRevision += 1; this.#reservationController?.abort();
    this.#reservation.state = 'idle'; this.#reservation.target = 0;
    this.#hostContext = null;
    for (const seat of this.#seats.values()) { seat.cancelled = true; seat.capsule = null; seat.controller.abort(); }
    const stopped = await Promise.allSettled([...this.#seats.values()].map(seat => seat.handle?.close({ leaveParty: true })));
    const failure = stopped.find(result => result.status === 'rejected');
    if (failure) this.#reservation.warning = safeFailure(failure.reason);
    this.#seats.clear();
  }
}

function safeFailure(error) {
  const allowed = ['NOT_A_PARTY_CODE', 'GUESTS_NOT_ALLOWED', 'PARTY_ALREADY_PLAYING', 'GUEST_ID_CHANGED', 'SHUTTING_DOWN',
    'GUEST_NOT_ORIGINAL_PLAYER', 'SEAT_NOT_IN_ONGOING_DUEL', 'UNKNOWN_PARTY_STATE', 'GUEST_COOKIE_SCOPE_MISMATCH',
    'VERIFICATION_OR_DENIAL_STOPPED', 'VERIFICATION_STOPPED', 'HTTP_FAILURE_STOPPED', 'NETWORK_FAILURE_STOPPED',
    'WS_VERIFICATION_OR_DENIAL_STOPPED', 'WS_HANDSHAKE_STOPPED', 'WS_SUBSCRIPTION_DENIED', 'WS_NETWORK_FAILURE_STOPPED',
    'REGISTERED_AUTH_FORBIDDEN', 'CLIENT_STOPPED', 'SEAT_CANCELLED', 'WEBSOCKET_STOPPED', 'SEAT_NOT_HOLDING', 'HANDOFF_DEADLINE',
    'CAPACITY_UNKNOWN', 'PARTY_CAPACITY_EXCEEDED', 'HOST_CONTEXT_EXPIRED', 'HOST_CONTEXT_MISMATCH',
    'RESERVATION_HAS_HALTED_SEAT', 'GUEST_NOT_PRESEAT_CANDIDATE', 'CREATE_BUSY', 'CLOSE_FAILED', 'SEAT_BENCHED', 'SEAT_BUSY'];
  return allowed.includes(error?.code) ? error.code : 'GUEST_OPERATION_FAILED';
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new CompanionError('JSON_REQUIRED', 415);
  if (Number(request.headers['content-length'] ?? 0) > BODY_LIMIT) throw new CompanionError('BODY_TOO_LARGE', 413);
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > BODY_LIMIT) throw new CompanionError('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CompanionError('INVALID_JSON'); }
}

export function createCompanionServer({ extensionId = null, token = randomBytes(32).toString('hex'), createSeat, inspectParty, now = Date.now } = {}) {
  if (extensionId !== null && !/^[a-p]{32}$/.test(extensionId)) throw new CompanionError('INVALID_EXTENSION_ID');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new CompanionError('INVALID_SETUP_TOKEN');
  let pinnedOrigin = extensionId ? `chrome-extension://${extensionId}` : null;
  const state = new CompanionState({ createSeat, inspectParty, now });
  const counts = { requests: [], creates: [] };
  const allowedMethods = new Set(['GET', 'POST', 'DELETE']);
  function rate(name, maximum) {
    const time = now();
    counts[name] = counts[name].filter(timestamp => time - timestamp < 60000);
    if (counts[name].length >= maximum) throw new CompanionError('RATE_LIMITED', 429);
    counts[name].push(time);
  }
  const server = createServer(async (request, response) => {
    let corsOrigin = null;
    const send = (status, data) => {
      const payload = JSON.stringify(data);
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Vary': 'Origin', ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      response.end(payload);
    };
    try {
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
        || request.headers.host !== `127.0.0.1:${request.socket.localPort}`) throw new CompanionError('LOCALHOST_REQUIRED', 403);
      const origin = request.headers.origin;
      if (typeof origin !== 'string' || !EXTENSION_ORIGIN.test(origin) || (pinnedOrigin && origin !== pinnedOrigin)) throw new CompanionError('EXTENSION_ORIGIN_REQUIRED', 403);
      corsOrigin = origin;
      if (request.method === 'OPTIONS') {
        const method = request.headers['access-control-request-method'];
        const headers = (request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (!allowedMethods.has(method) || !headers.includes('authorization') || headers.some(key => !['authorization', 'content-type'].includes(key))) throw new CompanionError('PREFLIGHT_REJECTED', 403);
        response.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, DELETE',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '60', 'Cache-Control': 'no-store', 'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' });
        response.end(); return;
      }
      const supplied = /^Bearer ([a-fA-F0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1];
      if (!supplied || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(token, 'hex'))) throw new CompanionError('UNAUTHORIZED', 401);
      // OPTIONS and bad credentials cannot claim the extension identity.
      pinnedOrigin ??= origin;
      rate('requests', 60);
      const route = request.url;
      if (request.method === 'GET' && route === '/status') return send(200, state.status());
      if (request.method === 'POST' && route === '/reserve') return send(202, state.reserve(await readBody(request)));
      if (request.method === 'POST' && route === '/seats') {
        const body = await readBody(request);
        validateSeatInput(body);
        // Legacy single-seat HTTP clicks remain bounded. reserve() owns one
        // explicit finite batch and does not make a separate HTTP call per seat.
        rate('creates', 2);
        return send(202, { seat: state.startCreate(body) });
      }
      const handoff = /^\/seats\/([a-f0-9]{32})\/handoff$/.exec(route ?? '');
      if (request.method === 'POST' && handoff) return send(200, await state.handoff(handoff[1], await readBody(request)));
      const remove = /^\/seats\/([a-f0-9]{32})$/.exec(route ?? '');
      if (request.method === 'DELETE' && remove) {
        if (request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0') throw new CompanionError('DELETE_BODY_FORBIDDEN');
        return send(200, await state.remove(remove[1]));
      }
      if (request.method === 'POST' && route === '/shutdown') {
        emptyBody(await readBody(request));
        await state.shutdown();
        send(200, { stopped: true });
        server.close(); return;
      }
      throw new CompanionError('NOT_FOUND', 404);
    } catch (error) {
      if (!response.headersSent) send(error instanceof CompanionError ? error.status : 500, { error: error instanceof CompanionError ? error.code : 'LOCAL_SERVER_ERROR' });
      request.resume();
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 15000;
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 30;
  const refreshTimer = setInterval(() => { state.refreshHolding(); }, 10000);
  refreshTimer.unref();
  server.on('close', () => clearInterval(refreshTimer));
  return { server, state, token, async close() {
    await state.shutdown();
    await new Promise(done => { server.close(done); server.closeAllConnections(); });
  } };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('node companion.mjs [--extension-id 32-character-Chrome-extension-id]\nListens only on 127.0.0.1:38477. Prints a fresh setup token once; paste it into the extension. Without an id, pins the first correctly authenticated extension Origin. No guest is created until a button sends POST /seats.\n'); return;
  }
  if (args.length && !(args.length === 2 && args[0] === '--extension-id' && /^[a-p]{32}$/.test(args[1]))) throw new CompanionError('INVALID_ARGUMENT');
  const runtime = createCompanionServer({ extensionId: args[1] ?? null });
  runtime.server.on('error', () => { process.stderr.write('Local companion could not start. Port 38477 may already be in use.\n'); process.exitCode = 1; });
  runtime.server.listen(COMPANION_PORT, '127.0.0.1', () => {
    process.stdout.write(`GeoGuessr guest companion: http://127.0.0.1:${COMPANION_PORT}\nSetup token (memory only): ${runtime.token}\n`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await runtime.close(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch { process.stderr.write('Invalid companion arguments. Use --help.\n'); process.exitCode = 1; }
}
