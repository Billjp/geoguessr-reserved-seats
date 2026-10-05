#!/usr/bin/env node
/**
 * Isolated reserved-guest feasibility probe. Requires Node.js 20 or newer.
 * No browser profile, registered-account cookie, or cookie file is read.
 * The only copied credential is a guest cookie created by this process.
 *
 * Sources checked 2026-10-04 (the URLs may expire with new site builds):
 * guest service: pages/_app-5be96e4e112e1db7.js, module 280874
 * guest form: pages/party/[[...slug]]-503e0451d0a84299.js, module 360438
 * join-code lookup: the Party page, modules 133074 and 331771 (Manual).
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { checkedSocketUrl, openPresence, socketUrl } from './ws-presence.mjs';
import { buildCapsule } from './extension/handoff.js';

export const ORIGIN = 'https://www.geoguessr.com';
export const GAME_ORIGIN = 'https://gs2.geoguessr.com';
export const GUEST_COOKIE = '_geoguessr_guest';
const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 256 * 1024;

export class ProbeError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = 'ProbeError';
    this.code = code;
    this.status = status;
  }
}

/** Exact endpoint/method allowlist; no redirects or user supplied origin. */
export function allowRequest(input, method = 'GET') {
  let url;
  try { url = new URL(input, ORIGIN); } catch { throw new ProbeError('URL_NOT_ALLOWED'); }
  if (![ORIGIN, GAME_ORIGIN].includes(url.origin) || url.username || url.password || url.hash) {
    throw new ProbeError('URL_NOT_ALLOWED');
  }
  const verb = method.toUpperCase();
  if (url.origin === GAME_ORIGIN) {
    if (!url.search && ((verb === 'GET' && /^\/[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_-]{1,100}(?:\/reconnect)?$/.test(url.pathname))
      || (verb === 'POST' && /^\/[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_-]{1,100}\/guess$/.test(url.pathname)))) return url;
    throw new ProbeError('URL_NOT_ALLOWED');
  }
  const exact = {
    '/api/v4/guest-users': ['POST'],
    '/api/v4/guest-users/me': ['GET'],
    '/api/v4/guest-users/id': ['GET'],
    '/api/v4/parties/v2/avatar-presets': ['GET'],
    '/api/v4/parties/v2/active': ['GET'],
  };
  if (exact[url.pathname]?.includes(verb) && !url.search) return url;
  if (verb === 'GET' && url.pathname === '/api/v4/parties/v2/members' && ['?page=0&count=50', '?page=0&count=101'].includes(url.search)) return url;
  if (verb === 'DELETE' && url.pathname === '/api/v4/parties/v2' && url.search === '?permanent=true') return url;
  if (verb === 'GET' && /^\/api\/v3\/join-codes\/[A-Za-z0-9]{5}$/.test(url.pathname)
      && url.search === '?s=Manual') return url;
  if (!url.search && verb === 'GET' && /^\/api\/v4\/parties\/v2\/[A-Za-z0-9_-]{1,100}$/.test(url.pathname)) return url;
  if (!url.search && verb === 'PUT' && /^\/api\/v4\/parties\/v2\/[A-Za-z0-9_-]{1,100}\/associate$/.test(url.pathname)) return url;
  if (!url.search && verb === 'GET' && /^\/api\/v4\/game-server\/phonebook\/[A-Za-z0-9_-]{1,100}$/.test(url.pathname)) return url;
  throw new ProbeError('URL_NOT_ALLOWED');
}

/** Split combined Set-Cookie values without splitting an Expires date. */
export function splitSetCookie(header) {
  if (!header) return [];
  if (Array.isArray(header)) return header.flatMap(splitSetCookie);
  if (typeof header !== 'string' || /[\r\n]/.test(header)) throw new ProbeError('INVALID_COOKIE');
  return header.split(/,(?=\s*[!#$%&'*+\-.^_`|~A-Za-z0-9]+=)/).map(value => value.trim());
}

export function parseSetCookie(header, receivedAt = Date.now()) {
  if (typeof header !== 'string' || /[\r\n]/.test(header)) throw new ProbeError('INVALID_COOKIE');
  const [pair, ...attributes] = header.split(';');
  const equal = pair.indexOf('=');
  if (equal < 1) throw new ProbeError('INVALID_COOKIE');
  const name = pair.slice(0, equal).trim();
  const value = pair.slice(equal + 1).trim();
  if (!/^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/.test(name) || /[\x00-\x20\x7f,;]/.test(value)) {
    throw new ProbeError('INVALID_COOKIE');
  }
  const cookie = { name, value, domain: null, originalDomain: null, path: '/', secure: false, httpOnly: false, sameSite: 'unspecified', expiresAt: null };
  let maxAge = null;
  for (const attribute of attributes) {
    const index = attribute.indexOf('=');
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const data = index < 0 ? '' : attribute.slice(index + 1).trim();
    if (key === 'domain') { cookie.originalDomain = data.toLowerCase(); cookie.domain = cookie.originalDomain.replace(/^\./, ''); }
    else if (key === 'path') cookie.path = data;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = ({ none: 'no_restriction', lax: 'lax', strict: 'strict' })[data.toLowerCase()] ?? 'unspecified';
    else if (key === 'max-age' && /^-?\d+$/.test(data)) maxAge = Number(data);
    else if (key === 'expires' && Number.isFinite(Date.parse(data))) cookie.expiresAt = Date.parse(data);
  }
  if (maxAge !== null) cookie.expiresAt = receivedAt + maxAge * 1000;
  return cookie;
}

function isRegularAuthName(name) {
  return /^(?:_ncfa|authorization|(?:__secure-|__host-)?(?:next-auth|authjs)\.session-token)$/i.test(name);
}

export function redactCookie(cookie) {
  return {
    name: cookie.name,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    expiring: cookie.expiresAt !== null,
    sharedDomain: cookie.domain === 'geoguessr.com',
    valuePresent: Boolean(cookie.value),
  };
}

/** This jar accepts server response cookies; only the guest auth cookie is kept. */
export class GuestCookieJar {
  #guest = null;
  accept(headers, responseUrl = ORIGIN, receivedAt = Date.now()) {
    const url = new URL(responseUrl);
    if (![ORIGIN, GAME_ORIGIN].includes(url.origin)) throw new ProbeError('COOKIE_ORIGIN_NOT_ALLOWED');
    const cookies = splitSetCookie(headers).map(value => parseSetCookie(value, receivedAt));
    if (cookies.some(cookie => isRegularAuthName(cookie.name))) throw new ProbeError('REGISTERED_AUTH_FORBIDDEN');
    for (const cookie of cookies) {
      if (cookie.name !== GUEST_COOKIE) continue;
      if (cookie.domain && (!['www.geoguessr.com', 'gs2.geoguessr.com', 'geoguessr.com'].includes(cookie.domain)
        || !(url.hostname === cookie.domain || url.hostname.endsWith(`.${cookie.domain}`)))) {
        throw new ProbeError('COOKIE_SCOPE_NOT_ALLOWED');
      }
      if (!cookie.path.startsWith('/')) throw new ProbeError('COOKIE_SCOPE_NOT_ALLOWED');
      cookie.domain ??= url.hostname;
      this.#guest = !cookie.value || (cookie.expiresAt !== null && cookie.expiresAt <= receivedAt) ? null : cookie;
    }
  }
  headerFor(input, now = Date.now(), method = 'GET') {
    const url = allowRequest(input, method);
    return this.#scopedHeader(url, now);
  }
  socketHeader(input, now = Date.now()) {
    const url = checkedSocketUrl(input);
    return this.#scopedHeader(url, now);
  }
  #scopedHeader(url, now) {
    const cookie = this.#guest;
    if (!cookie || (cookie.expiresAt !== null && cookie.expiresAt <= now)) return '';
    const domainMatches = url.hostname === cookie.domain || (cookie.domain === 'geoguessr.com' && url.hostname.endsWith('.geoguessr.com'));
    if (!domainMatches) return '';
    const pathMatches = url.pathname === cookie.path || (url.pathname.startsWith(cookie.path)
      && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/'));
    if (!pathMatches) return '';
    return `${cookie.name}=${cookie.value}`;
  }
  cloneInto(other) {
    if (!(other instanceof GuestCookieJar) || !this.#guest) throw new ProbeError('GUEST_COOKIE_MISSING');
    if (other.#guest) throw new ProbeError('TARGET_CLIENT_NOT_EMPTY');
    other.#guest = { ...this.#guest };
  }
  describe() { return this.#guest ? [redactCookie(this.#guest)] : []; }
  clear() { this.#guest = null; }
  cookieForIntentionalHandoff(now = Date.now()) {
    const cookie = this.#guest;
    if (!cookie || (cookie.expiresAt !== null && cookie.expiresAt <= now)) throw new ProbeError('GUEST_COOKIE_MISSING');
    return { name: GUEST_COOKIE, value: cookie.value, domain: cookie.originalDomain ?? cookie.domain,
      path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
      ...(cookie.expiresAt !== null ? { expirationDate: cookie.expiresAt / 1000 } : {}),
    };
  }
}

export function guestId(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || !payload.id.trim()) {
    throw new ProbeError('GUEST_ID_MISSING');
  }
  return payload.id;
}

export function compareGuestIdentity(first, second) { return guestId(first) === guestId(second); }
export function redactGuestIdentity(payload) {
  return { idPresent: true, idFingerprint: createHash('sha256').update(guestId(payload)).digest('hex').slice(0, 12) };
}

export function guestCreationPayload(nick, avatar) {
  if (typeof nick !== 'string' || !nick.trim() || nick.length > 30 || /[\x00-\x1f\x7f]/.test(nick)) {
    throw new ProbeError('INVALID_NICK');
  }
  if (avatar !== undefined && (!avatar || typeof avatar !== 'object' || Array.isArray(avatar))) throw new ProbeError('INVALID_AVATAR_PRESET');
  const { equipped, referrer, ...remaining } = avatar ?? {};
  if (equipped !== undefined && (!Array.isArray(equipped) || equipped.some(item => typeof item?.id !== 'string'))) throw new ProbeError('INVALID_AVATAR_PRESET');
  // Same transformation as module 280874; referrer is optional and omitted here.
  return { ...remaining, ...(equipped ? { equippedAssetIds: equipped.map(item => item.id) } : {}), nick: nick.trim(), countryCode: '' };
}

export class GuestClient {
  #fetch;
  #jar = new GuestCookieJar();
  #stopped = false;
  constructor({ fetchImpl = globalThis.fetch, onEvent = () => {} } = {}) {
    this.#fetch = fetchImpl;
    this.onEvent = onEvent;
  }
  cookieSummary() { return this.#jar.describe(); }
  get stopped() { return this.#stopped; }
  discardGuestCredentials() { this.#stopped = true; this.#jar.clear(); }
  async buildHandoffCapsule(pageUrl, { now = Date.now() } = {}) {
    // Deliberate export only. Never call from diagnostics or status reporting.
    const guest = await this.me();
    guestId(guest);
    return buildCapsule({ guest: { id: guest.id, nick: guest.nick },
      cookie: this.#jar.cookieForIntentionalHandoff(now), pageUrl, now });
  }
  cloneGuestInto(other) {
    if (!(other instanceof GuestClient) || this.#stopped || other.#stopped) throw new ProbeError('CLIENT_STOPPED');
    this.#jar.cloneInto(other.#jar);
  }
  async request(input, { method = 'GET', body } = {}) {
    if (this.#stopped) throw new ProbeError('CLIENT_STOPPED');
    const url = allowRequest(input, method);
    const headers = { Accept: 'application/json', 'X-Client': 'web-1.8153-c1d0cd0' };
    const cookie = this.#jar.headerFor(url, Date.now(), method);
    if (cookie) headers.Cookie = cookie;
    if (url.origin === GAME_ORIGIN && !cookie) throw new ProbeError('GUEST_COOKIE_SCOPE_MISMATCH');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let status = null;
    try {
      const response = await this.#fetch(url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual', signal: AbortSignal.timeout(15000),
      });
      status = response.status;
      this.onEvent({ type: 'http', endpoint: safeEndpoint(url), method, status });
      if (status >= 300 && status < 400) throw new ProbeError('REDIRECT_STOPPED', status);
      if (status === 403 || response.headers.get('cf-mitigated') === 'challenge') throw new ProbeError('VERIFICATION_OR_DENIAL_STOPPED', status);
      if (!response.ok) throw new ProbeError('HTTP_FAILURE_STOPPED', status);
      const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie() : response.headers.get('set-cookie');
      this.#jar.accept(setCookies, url);
      if (setCookies?.length) this.onEvent({ type: 'server_cookie_metadata', cookies: splitSetCookie(setCookies).map(value => redactCookie(parseSetCookie(value))) });
      if (status === 204) return undefined;
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) throw new ProbeError('NON_JSON_STOPPED', status);
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new ProbeError('RESPONSE_TOO_LARGE', status);
      if (/turnstile|captcha|challenge-platform/i.test(text)) throw new ProbeError('VERIFICATION_STOPPED', status);
      let payload;
      try { payload = JSON.parse(text); } catch { throw new ProbeError('INVALID_JSON_STOPPED', status); }
      return payload;
    } catch (error) {
      this.#stopped = true;
      if (error instanceof ProbeError) throw error;
      // Network exceptions may contain URLs or headers; do not include them.
      throw new ProbeError('NETWORK_FAILURE_STOPPED', status);
    }
  }
  async createGuest(nick) {
    const presets = await this.request('/api/v4/parties/v2/avatar-presets');
    if (!Array.isArray(presets) || !presets.length) throw new ProbeError('AVATAR_PRESETS_MISSING');
    return this.request('/api/v4/guest-users', { method: 'POST', body: guestCreationPayload(nick, presets[0]) });
  }
  me() { return this.request('/api/v4/guest-users/me'); }
  lookup(code) {
    if (!/^[A-Za-z0-9]{5}$/.test(code ?? '')) throw new ProbeError('INVALID_PARTY_CODE');
    return this.request(`/api/v3/join-codes/${code}?s=Manual`);
  }
  party(id) { return this.request(`/api/v4/parties/v2/${safeId(id)}`); }
  members(count = 50) {
    if (![50, 101].includes(count)) throw new ProbeError('INVALID_MEMBER_COUNT');
    return this.request(`/api/v4/parties/v2/members?page=0&count=${count}`);
  }
  async connectPresence(partyId, guestId) {
    if (this.#stopped) throw new ProbeError('CLIENT_STOPPED');
    const url = socketUrl();
    const cookie = this.#jar.socketHeader(url);
    if (!cookie) throw new ProbeError('GUEST_COOKIE_SCOPE_MISMATCH');
    try {
      return await openPresence({ url, cookie, partyId, guestId,
        onEvent: this.onEvent,
        onFatal: () => { this.#stopped = true; },
        onServerCookies: values => {
          if (!values?.length) return;
          const parsed = splitSetCookie(values).map(value => parseSetCookie(value));
          if (parsed.some(value => isRegularAuthName(value.name))) throw new ProbeError('REGISTERED_AUTH_FORBIDDEN');
          this.onEvent({ type: 'server_cookie_metadata', cookies: parsed.map(redactCookie) });
        },
      });
    } catch (error) {
      this.#stopped = true;
      throw new ProbeError(error?.code?.startsWith('WS_') ? error.code : 'WS_FAILURE_STOPPED', error?.status ?? null);
    }
  }
  associate(id) { return this.request(`/api/v4/parties/v2/${safeId(id)}/associate`, { method: 'PUT', body: { source: 'CodeForm' } }); }
  leaveParty() { return this.request('/api/v4/parties/v2?permanent=true', { method: 'DELETE' }); }
  phonebook(id) { return this.request(`/api/v4/game-server/phonebook/${safeId(id)}`); }
  game(id, node, reconnect = false) { return this.request(`${GAME_ORIGIN}/${safeId(node)}/${safeId(id)}${reconnect ? '/reconnect' : ''}`); }
  guess(id, node, { lat, lng, roundNumber }) {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180
      || !Number.isInteger(roundNumber) || roundNumber < 1) throw new ProbeError('INVALID_GUESS');
    return this.request(`${GAME_ORIGIN}/${safeId(node)}/${safeId(id)}/guess`, {
      method: 'POST', body: { lat, lng, roundNumber, time: new Date().toISOString() },
    });
  }
}

function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new ProbeError('INVALID_RESOURCE_ID');
  return value;
}
function safeEndpoint(url) {
  if (url.origin === GAME_ORIGIN) return `gs2/[node]/[game]${url.pathname.endsWith('/guess') ? '/guess' : url.pathname.endsWith('/reconnect') ? '/reconnect' : ''}`;
  return url.pathname.replace(/(\/join-codes\/)[^/]+/, '$1[redacted]')
    .replace(/(\/parties\/v2\/)[^/]+(\/associate)?$/, (full, prefix, tail) => full.endsWith('avatar-presets') || full.endsWith('active') ? full : `${prefix}[party]${tail ?? ''}`)
    .replace(/(\/phonebook\/)[^/]+/, '$1[game]');
}

export function partySummary(party) {
  return {
    type: 'party', gameType: typeof party?.gameType === 'string' ? party.gameType : null,
    gameState: typeof party?.gameState === 'string' ? party.gameState : null,
    lobbyPresent: typeof party?.lobbyId === 'string' && Boolean(party.lobbyId),
    guestsAllowed: party?.partySettings?.allowGuests === true,
  };
}

export function memberSummary(info, id, party) {
  const members = Array.isArray(info?.members) ? info.members : [];
  const ownIndex = members.findIndex(member => member?.userId === id);
  const own = members[ownIndex];
  const capacity = party?.gameType === 'Duels' ? 2 : party?.gameType === 'TeamDuels'
    ? (party?.partySettings?.maxPartySize === 101 && party?.partySettings?.masterControl !== true ? 101 : 20) : null;
  // Official module226896.GO derives bench status from member order and mode capacity.
  // This is a client-rule prediction. Actual game membership must still be checked.
  const selected = new Set();
  if (capacity !== null) for (const member of members) {
    if (selected.size >= capacity) break;
    if (!party?.partySettings?.masterControl || member?.userId !== party?.owner?.userId) selected.add(member?.userId);
  }
  const ownTypes = {};
  for (const key of ['userId', 'isPresent', 'isBenched', 'isInCurrentGame', 'team', 'clientType']) {
    ownTypes[key] = own && Object.hasOwn(own, key) ? typeof own[key] : 'missing';
  }
  return {
    type: 'party_members', partyIdMatches: typeof party?.partyId === 'string' && typeof info?.partyId === 'string' ? info.partyId === party.partyId : null,
    memberCount: members.length, totalCount: Number.isInteger(info?.totalCount) ? info.totalCount : null,
    guestListed: Boolean(own), guestPresent: typeof own?.isPresent === 'boolean' ? own.isPresent : null,
    guestRawIsBenched: typeof own?.isBenched === 'boolean' ? own.isBenched : null,
    guestUnbenched: typeof own?.isBenched === 'boolean' ? !own.isBenched : null,
    guestInCurrentGame: typeof own?.isInCurrentGame === 'boolean' ? own.isInCurrentGame : null,
    guestMemberIndex: ownIndex >= 0 ? ownIndex : null, clientModeCapacity: capacity,
    guestSelectedByClientRules: own && capacity !== null ? selected.has(id) : null,
    guestTeam: ['red', 'blue'].includes(own?.team) ? own.team : null, guestFieldTypes: ownTypes,
  };
}

export function gameSummary(game, id) {
  const players = Array.isArray(game?.teams) ? game.teams.flatMap(team => Array.isArray(team.players) ? team.players : []) : [];
  const own = players.find(player => player.playerId === id);
  return {
    type: 'game', status: typeof game?.status === 'string' ? game.status : null,
    currentRoundNumber: Number.isInteger(game?.currentRoundNumber) ? game.currentRoundNumber : null,
    playerCount: players.length, guestIsOriginalPlayer: Boolean(own),
    guestGuessRounds: Array.isArray(own?.guesses) ? own.guesses.map(guess => guess.roundNumber).filter(Number.isInteger) : [],
    guestGuessedCurrentRound: Boolean(own?.guesses?.some(guess => guess.roundNumber === game.currentRoundNumber)),
  };
}

export class ProbeSession {
  #partyId = null;
  #guestId;
  #presence = null;
  constructor(clientA, clientB, identity, { onEvent = () => {}, allowPartyJoin = false, allowGuess = false, memberCount = 50 } = {}) {
    this.clientA = clientA; this.clientB = clientB; this.#guestId = guestId(identity);
    this.onEvent = onEvent; this.allowPartyJoin = allowPartyJoin; this.allowGuess = allowGuess;
    this.memberCount = memberCount;
  }
  client(label) {
    if (label === 'A') return this.clientA;
    if (label === 'B') return this.clientB;
    throw new ProbeError('INVALID_CLIENT_LABEL');
  }
  async join(code) {
    if (!this.allowPartyJoin) throw new ProbeError('PARTY_JOIN_NOT_ENABLED');
    if (this.#partyId) throw new ProbeError('ALREADY_JOINED_TEST_PARTY');
    const lookup = await this.clientA.lookup(code);
    if (lookup?.resourceType !== 'PartiesV2') throw new ProbeError('NOT_A_PARTY_CODE');
    const id = safeId(lookup.resourceId);
    const party = await this.clientA.party(id);
    if (party?.partySettings?.allowGuests !== true) throw new ProbeError('GUESTS_NOT_ALLOWED');
    if (party?.gameState !== 'NoGame' && party?.gameState !== 'Finished') throw new ProbeError('PARTY_ALREADY_PLAYING');
    await this.clientA.associate(id);
    this.#partyId = id;
    const verified = await this.clientB.party(id);
    this.onEvent({ ...partySummary(verified), type: 'party_associated', verifiedGuestClientRead: true });
    return verified;
  }
  async party(label = 'B') {
    if (!this.#partyId) throw new ProbeError('NO_JOINED_TEST_PARTY');
    const party = await this.client(label).party(this.#partyId);
    this.onEvent({ ...partySummary(party), client: label });
    const memberInfo = await this.client(label).members(this.memberCount);
    this.onEvent({ ...memberSummary(memberInfo, this.#guestId, party), client: label,
      partyIdMatches: typeof memberInfo?.partyId === 'string' ? memberInfo.partyId === this.#partyId : null });
    return party;
  }
  async seatProof(label = 'A') {
    if (!this.#partyId) throw new ProbeError('NO_JOINED_TEST_PARTY');
    const party = await this.client(label).party(this.#partyId);
    const info = await this.client(label).members(this.memberCount);
    const summary = memberSummary(info, this.#guestId, party);
    const candidate = summary.guestListed && summary.guestPresent === true && summary.guestSelectedByClientRules === true
      && ['NoGame', 'Finished'].includes(party?.gameState);
    this.onEvent({ ...summary, type: 'preseat_check', client: label, candidate, actualGameMembershipVerified: false });
    if (!candidate) throw new ProbeError('GUEST_NOT_PRESEAT_CANDIDATE');
    return summary;
  }
  async presence(label = 'A') {
    if (!this.#partyId) throw new ProbeError('NO_JOINED_TEST_PARTY');
    await this.closePresence();
    this.#presence = await this.client(label).connectPresence(this.#partyId, this.#guestId);
    this.onEvent({ type: 'presence_connected', client: label });
  }
  async handoffPresence() {
    await this.presence('B');
    this.onEvent({ type: 'presence_handoff', senderDisconnected: true, recipientConnected: true });
  }
  async closePresence() {
    if (this.#presence) await this.#presence.close();
    this.#presence = null;
  }
  async game(label = 'B', reconnect = false) {
    const client = this.client(label);
    const party = await this.party(label);
    if (!party?.lobbyId || party?.gameState !== 'Ongoing' || !['Duels', 'TeamDuels'].includes(party?.gameType)) {
      this.onEvent({ type: 'no_ongoing_duel', client: label });
      return null;
    }
    const id = safeId(party.lobbyId);
    const phonebook = await client.phonebook(id);
    if (phonebook?.status !== 'Active') throw new ProbeError('GAME_NODE_NOT_ACTIVE');
    const node = safeId(phonebook.gameServerNodeId);
    const game = await client.game(id, node, reconnect);
    if (game?.gameId !== id) throw new ProbeError('GAME_ID_MISMATCH');
    const summary = gameSummary(game, this.#guestId);
    if (!summary.guestIsOriginalPlayer) throw new ProbeError('GUEST_NOT_ORIGINAL_PLAYER');
    this.#presence?.setPlaying(true);
    this.onEvent({ ...summary, client: label, reconnect });
    return { game, node, id };
  }
  async guess(label, lat, lng, roundNumber) {
    if (!this.allowGuess) throw new ProbeError('GAME_GUESS_NOT_ENABLED');
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180
      || !Number.isInteger(roundNumber) || roundNumber < 1) throw new ProbeError('INVALID_GUESS');
    const snapshot = await this.game(label);
    if (!snapshot) throw new ProbeError('NO_ONGOING_DUEL');
    const summary = gameSummary(snapshot.game, this.#guestId);
    if (summary.currentRoundNumber !== roundNumber || summary.guestGuessedCurrentRound) throw new ProbeError('ROUND_NOT_AVAILABLE');
    await this.client(label).guess(snapshot.id, snapshot.node, { lat, lng, roundNumber });
    this.onEvent({ type: 'guess_sent', client: label, roundNumber });
    const verified = await this.client(label).game(snapshot.id, snapshot.node);
    const registered = gameSummary(verified, this.#guestId).guestGuessRounds.includes(roundNumber);
    this.onEvent({ type: 'guess_verified', client: label, roundNumber, registered });
    if (!registered) throw new ProbeError('GUESS_NOT_CONFIRMED');
  }
}

export async function runProbe({ nick, partyCode, joinParty = false, connectParty = false, allowGuess = false, fetchImpl, onEvent = () => {} }) {
  const clientA = new GuestClient({ fetchImpl, onEvent });
  const clientB = new GuestClient({ fetchImpl, onEvent });
  const created = await clientA.createGuest(nick);
  guestId(created);
  const identityA = await clientA.me();
  if (!compareGuestIdentity(created, identityA)) throw new ProbeError('CREATED_ID_CHANGED');
  clientA.cloneGuestInto(clientB);
  const identityB = await clientB.me();
  const sameGuest = compareGuestIdentity(identityA, identityB);
  if (!sameGuest) throw new ProbeError('HANDOFF_ID_MISMATCH');
  const summary = {
    type: 'handoff', sameGuest, identity: redactGuestIdentity(identityA),
    clientACookies: clientA.cookieSummary(), clientBCookies: clientB.cookieSummary(),
  };
  onEvent(summary);
  const session = new ProbeSession(clientA, clientB, identityA, { onEvent, allowPartyJoin: joinParty, allowGuess });
  if (partyCode && joinParty) await session.join(partyCode);
  else if (partyCode) {
    const lookup = await clientA.lookup(partyCode);
    onEvent({ type: 'party_lookup', partyTypeVerified: lookup?.resourceType === 'PartiesV2', resourceIdPresent: typeof lookup?.resourceId === 'string' });
  }
  if (connectParty) await session.presence('A');
  return { clientA, clientB, summary, session };
}

export function parseArgs(argv) {
  const options = { createGuest: false, keepAlive: false };
  const values = { '--nick': 'nick', '--party-code': 'partyCode', '--report': 'report' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--create-guest') options.createGuest = true;
    else if (arg === '--keep-alive') options.keepAlive = true;
    else if (arg === '--join-party') options.joinParty = true;
    else if (arg === '--connect-party') options.connectParty = true;
    else if (arg === '--allow-game-guess') options.allowGuess = true;
    else if (arg === '--help') options.help = true;
    else if (values[arg] && argv[index + 1] && !argv[index + 1].startsWith('--')) options[values[arg]] = argv[++index];
    else throw new ProbeError('INVALID_ARGUMENT');
  }
  if (!options.help && (!options.createGuest || !options.nick)) throw new ProbeError('EXPLICIT_GUEST_CREATION_REQUIRED');
  if (options.partyCode && !/^[A-Za-z0-9]{5}$/.test(options.partyCode)) throw new ProbeError('INVALID_PARTY_CODE');
  if (options.joinParty && !options.partyCode) throw new ProbeError('EXPLICIT_TEST_PARTY_REQUIRED');
  if (options.connectParty && !options.joinParty) throw new ProbeError('EXPLICIT_PARTY_JOIN_REQUIRED');
  return options;
}

export function reportPath(path) {
  const target = resolve(ROOT, path);
  const within = relative(ROOT, target);
  if (!within || within.startsWith('..') || isAbsolute(within) || !target.endsWith('.json')) throw new ProbeError('REPORT_PATH_NOT_ALLOWED');
  return target;
}

async function main() {
  const events = [];
  let options;
  let activeSession;
  const log = event => { events.push(event); process.stdout.write(`${JSON.stringify(event)}\n`); };
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('node probe.mjs --create-guest --nick ReserveTest [--party-code ABCDE] [--join-party] [--connect-party] [--allow-game-guess] [--report probe-report.json] [--keep-alive]\nCreates one fresh guest and checks the same guest from an independent client. Cookies remain in process memory. Party join requires --join-party and a test Party code. Presence uses the official WebSocket only with --connect-party. Guess requires its flag and explicit coordinates and round. Stops on denial, verification, network error, or redirect.\n');
      return;
    }
    const targetReport = options.report ? reportPath(options.report) : null;
    const { clientA, clientB, session } = await runProbe({ ...options, onEvent: log });
    activeSession = session;
    if (options.keepAlive) {
      const lines = createInterface({ input: process.stdin, output: process.stdout });
      log({ type: 'ready', commands: ['identity', 'lookup CODE', 'presence A|B', 'handoff-presence', 'disconnect', 'seat A|B', 'party A|B', 'game A|B', 'reconnect A|B', 'guess A|B LAT LNG ROUND', 'exit'], secretsPersisted: false });
      try { for await (const line of lines) {
        const [command, argument, ...rest] = line.trim().split(/\s+/);
        if (command === 'exit') break;
        if (command === 'identity' && !argument) {
          const a = await clientA.me();
          const b = await clientB.me();
          log({ type: 'identity', sameGuest: compareGuestIdentity(a, b), identity: redactGuestIdentity(a) });
        } else if (command === 'lookup' && argument && !rest.length) {
          const result = await clientA.lookup(argument);
          log({ type: 'party_lookup', partyTypeVerified: result?.resourceType === 'PartiesV2', resourceIdPresent: typeof result?.resourceId === 'string' });
        } else if (command === 'party' && ['A', 'B'].includes(argument) && !rest.length) {
          await session.party(argument);
        } else if (command === 'seat' && ['A', 'B'].includes(argument) && !rest.length) {
          await session.seatProof(argument);
        } else if (command === 'presence' && ['A', 'B'].includes(argument) && !rest.length && options.connectParty) {
          await session.presence(argument);
        } else if (command === 'handoff-presence' && !argument && options.connectParty) {
          await session.handoffPresence();
        } else if (command === 'disconnect' && !argument) {
          await session.closePresence();
        } else if (['game', 'reconnect'].includes(command) && ['A', 'B'].includes(argument) && !rest.length) {
          await session.game(argument, command === 'reconnect');
        } else if (command === 'guess' && ['A', 'B'].includes(argument) && rest.length === 3) {
          await session.guess(argument, ...rest.map(Number));
        } else log({ type: 'command_rejected' });
      } } finally { lines.close(); }
    }
    await session.closePresence();
    if (targetReport) await writeFile(targetReport, `${JSON.stringify({ complete: true, events }, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    try { await activeSession?.closePresence(); } catch { /* Preserve original failure. */ }
    log({ type: 'stopped', reason: error instanceof ProbeError ? error.code : 'LOCAL_FAILURE', status: error instanceof ProbeError ? error.status : null });
    if (options?.report) {
      try { await writeFile(reportPath(options.report), `${JSON.stringify({ complete: false, events }, null, 2)}\n`, { flag: 'wx' }); } catch { /* Never overwrite an existing report. */ }
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
