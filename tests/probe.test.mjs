import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowRequest, splitSetCookie, parseSetCookie, redactCookie, GuestCookieJar, GuestClient,
  compareGuestIdentity, redactGuestIdentity, guestCreationPayload, parseArgs, reportPath, runProbe,
  ProbeSession, gameSummary, memberSummary,
} from '../probe.mjs';

const cookie = '_geoguessr_guest=test-secret; Path=/; Secure; HttpOnly; SameSite=Lax';
const response = (payload, { status = 200, cookies = [], type = 'application/json' } = {}) => {
  const headers = new Headers({ 'content-type': type });
  for (const item of cookies) headers.append('set-cookie', item);
  return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers });
};

test('exact GeoGuessr allowlist rejects other origins, credentials, fragments, verbs, and queries', () => {
  assert.equal(allowRequest('/api/v4/guest-users', 'POST').origin, 'https://www.geoguessr.com');
  assert.equal(allowRequest('/api/v3/join-codes/PZM2F?s=Manual').search, '?s=Manual');
  assert.equal(allowRequest('https://gs2.geoguessr.com/node/game/reconnect').hostname, 'gs2.geoguessr.com');
  for (const [url, method] of [
    ['https://attacker.test/api/v4/guest-users/me'],
    ['https://name:secret@www.geoguessr.com/api/v4/guest-users/me'],
    ['/api/v4/guest-users/me#fragment'], ['/api/v4/guest-users/me?extra=1'],
    ['/api/v4/guest-users/update', 'PUT'], ['/api/v4/guest-users/me', 'POST'],
    ['/api/v3/join-codes/PZM2F?s=manual'], ['/api/v3/join-codes/../me?s=Manual'],
  ]) assert.throws(() => allowRequest(url, method), /URL_NOT_ALLOWED/);
});

test('cookie parsing keeps Expires comma and never exposes values in summaries', () => {
  const headers = `${cookie}; Expires=Wed, 21 Oct 2030 07:28:00 GMT, ignore=other; Path=/`;
  const parts = splitSetCookie(headers);
  assert.equal(parts.length, 2);
  const parsed = parseSetCookie(parts[0]);
  assert.equal(parsed.value, 'test-secret');
  assert.equal(parsed.httpOnly, true);
  assert.equal(parsed.secure, true);
  assert.equal(parsed.path, '/');
  assert.doesNotMatch(JSON.stringify(redactCookie(parsed)), /test-secret/);
  assert.throws(() => parseSetCookie('_geoguessr_guest=x\r\n_n cfa=x'), /INVALID_COOKIE/);
});

test('jar rejects registered auth and unrelated guest scopes, discards unrelated cookies', () => {
  const jar = new GuestCookieJar();
  assert.throws(() => jar.accept(['_ncfa=registered-secret; Path=/']), /REGISTERED_AUTH_FORBIDDEN/);
  assert.throws(() => jar.accept(['__Secure-next-auth.session-token=registered; Path=/']), /REGISTERED_AUTH_FORBIDDEN/);
  assert.throws(() => jar.accept([`${cookie}; Domain=attacker.test`]), /COOKIE_SCOPE_NOT_ALLOWED/);
  assert.throws(() => jar.accept(cookie, 'https://attacker.test'), /COOKIE_ORIGIN_NOT_ALLOWED/);
  jar.accept([cookie, 'analytics=ignore; Path=/']);
  assert.deepEqual(jar.describe().map(value => value.name), ['_geoguessr_guest']);
  const second = new GuestCookieJar();
  jar.cloneInto(second);
  assert.equal(second.headerFor('/api/v4/guest-users/me'), '_geoguessr_guest=test-secret');
  assert.throws(() => jar.cloneInto(second), /TARGET_CLIENT_NOT_EMPTY/);
});

test('guest cookie expires, clears, and matches its path boundary', () => {
  const jar = new GuestCookieJar();
  jar.accept(`${cookie}; Max-Age=1`, undefined, 1000);
  assert.equal(jar.headerFor('/api/v4/guest-users/me', 1999), '_geoguessr_guest=test-secret');
  assert.equal(jar.headerFor('/api/v4/guest-users/me', 2000), '');
  jar.accept('_geoguessr_guest=path-secret; Path=/api/v4/guest-users; Secure');
  assert.equal(jar.headerFor('/api/v3/join-codes/PZM2F?s=Manual'), '');
  jar.accept('_geoguessr_guest=; Path=/; Max-Age=0');
  assert.deepEqual(jar.describe(), []);
});

test('guest id comparison requires nonempty id; output is a fingerprint', () => {
  assert.equal(compareGuestIdentity({ id: 'guest-a' }, { id: 'guest-a' }), true);
  assert.equal(compareGuestIdentity({ id: 'guest-a' }, { id: 'guest-b' }), false);
  assert.throws(() => compareGuestIdentity({}, { id: 'guest-a' }), /GUEST_ID_MISSING/);
  assert.doesNotMatch(JSON.stringify(redactGuestIdentity({ id: 'raw-guest-id' })), /raw-guest-id/);
});

test('probe creates one guest, checks A, clones only guest auth to B, and emits safe report', async () => {
  const calls = [];
  const events = [];
  const result = await runProbe({ nick: 'ReserveTest', onEvent: event => events.push(event), fetchImpl: async (url, request) => {
    calls.push({ url: url.href, ...request });
    if (calls.length === 1) return response([{ equipped: [{ id: 'asset-1' }], avatarPath: 'avatar/preset' }]);
    return response({ id: 'raw-guest-id', nick: 'ReserveTest' }, calls.length === 2 ? { cookies: [cookie] } : {});
  } });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].body), { nick: 'ReserveTest', countryCode: '', equippedAssetIds: ['asset-1'], avatarPath: 'avatar/preset' });
  assert.equal(calls[1].headers.Cookie, undefined);
  assert.equal(calls[2].headers.Cookie, '_geoguessr_guest=test-secret');
  assert.equal(calls[3].headers.Cookie, '_geoguessr_guest=test-secret');
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(result.summary.sameGuest, true);
  assert.doesNotMatch(JSON.stringify(events), /raw-guest-id|test-secret|ReserveTest/);
});

test('a denial, challenge, redirect, or unexpected HTML stops with no retry', async () => {
  for (const [reply, code] of [
    [response('denied', { status: 403, type: 'text/html' }), 'VERIFICATION_OR_DENIAL_STOPPED'],
    [response({}, { status: 302 }), 'REDIRECT_STOPPED'],
    [response('<html>page</html>', { type: 'text/html' }), 'NON_JSON_STOPPED'],
    [response({ error: 'Turnstile required' }), 'VERIFICATION_STOPPED'],
  ]) {
    let calls = 0;
    const client = new GuestClient({ fetchImpl: async () => { calls += 1; return reply; } });
    await assert.rejects(() => client.me(), new RegExp(code));
    await assert.rejects(() => client.me(), /CLIENT_STOPPED/);
    assert.equal(calls, 1);
  }
});

test('network exception is sanitized and disables the client', async () => {
  const client = new GuestClient({ fetchImpl: async () => { throw new Error('private-token'); } });
  await assert.rejects(() => client.me(), error => error.message === 'NETWORK_FAILURE_STOPPED');
  await assert.rejects(() => client.me(), /CLIENT_STOPPED/);
});

test('auth mismatch and regular auth cookie stop the handoff', async () => {
  let calls = 0;
  await assert.rejects(() => runProbe({ nick: 'test', fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return response([{}]);
    return response({ id: calls < 4 ? 'guest-a' : 'guest-b' }, calls === 2 ? { cookies: [cookie] } : {});
  } }), /HANDOFF_ID_MISMATCH/);
  await assert.rejects(() => runProbe({ nick: 'test', fetchImpl: async () => response([{}], { cookies: [cookie, '_ncfa=secret'] }) }), /REGISTERED_AUTH_FORBIDDEN/);
});

test('explicit CLI flag and a scoped non-overwriting JSON report path are required', () => {
  assert.throws(() => parseArgs(['--nick', 'test']), /EXPLICIT_GUEST_CREATION_REQUIRED/);
  assert.throws(() => parseArgs(['--create-guest', '--nick', 'test', '--cookie', 'secret']), /INVALID_ARGUMENT/);
  assert.equal(parseArgs(['--create-guest', '--nick', 'test', '--party-code', 'PZM2F']).partyCode, 'PZM2F');
  assert.deepEqual(guestCreationPayload(' test '), { nick: 'test', countryCode: '' });
  assert.throws(() => guestCreationPayload('test\nname'), /INVALID_NICK/);
  assert.throws(() => reportPath('../outside.json'), /REPORT_PATH_NOT_ALLOWED/);
  assert.throws(() => reportPath('probe.mjs'), /REPORT_PATH_NOT_ALLOWED/);
  assert.throws(() => parseArgs(['--create-guest', '--nick', 'test', '--join-party']), /EXPLICIT_TEST_PARTY_REQUIRED/);
});

test('guest cookie obeys domain scope for GS2 and is never sent to a different host', () => {
  const jar = new GuestCookieJar();
  jar.accept(cookie);
  assert.equal(jar.headerFor('https://gs2.geoguessr.com/node/game'), '');
  jar.accept(`${cookie}; Domain=.geoguessr.com`);
  assert.equal(jar.headerFor('https://gs2.geoguessr.com/node/game'), '_geoguessr_guest=test-secret');
  assert.throws(() => jar.accept(`${cookie}; Domain=com`), /COOKIE_SCOPE_NOT_ALLOWED/);
});

test('join requires explicit flag and rejects already playing parties before association', async () => {
  let associated = 0;
  const a = {
    lookup: async () => ({ resourceType: 'PartiesV2', resourceId: 'test-party' }),
    party: async () => ({ partySettings: { allowGuests: true }, gameState: 'Ongoing' }),
    associate: async () => { associated += 1; },
  };
  const blocked = new ProbeSession(a, a, { id: 'guest' });
  await assert.rejects(() => blocked.join('PZM2F'), /PARTY_JOIN_NOT_ENABLED/);
  const session = new ProbeSession(a, a, { id: 'guest' }, { allowPartyJoin: true });
  await assert.rejects(() => session.join('PZM2F'), /PARTY_ALREADY_PLAYING/);
  assert.equal(associated, 0);
});

test('joined A guest is read and reconnects through B as an original Duel player', async () => {
  const requests = [];
  let partyPlaying = false;
  const events = [];
  const result = await runProbe({ nick: 'test', joinParty: true, partyCode: 'PZM2F', onEvent: event => events.push(event), fetchImpl: async (url, request) => {
    requests.push({ url: url.href, ...request });
    if (url.pathname.endsWith('/avatar-presets')) return response([{}]);
    if (url.pathname === '/api/v4/guest-users') return response({ id: 'guest-id' }, { cookies: [`${cookie}; Domain=.geoguessr.com`] });
    if (url.pathname.endsWith('/me')) return response({ id: 'guest-id' });
    if (url.pathname.includes('/join-codes/')) return response({ resourceType: 'PartiesV2', resourceId: 'test-party' });
    if (url.pathname.endsWith('/associate')) {
      assert.deepEqual(JSON.parse(request.body), { source: 'CodeForm' });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/api/v4/parties/v2/test-party') return response({ gameType: 'TeamDuels', gameState: partyPlaying ? 'Ongoing' : 'NoGame', lobbyId: partyPlaying ? 'test-game' : null, partySettings: { allowGuests: true } });
    if (url.pathname === '/api/v4/parties/v2/members') return response({ partyId: 'test-party', totalCount: 1, members: [{ userId: 'guest-id', isPresent: true, isBenched: false, isInCurrentGame: partyPlaying }] });
    if (url.pathname.endsWith('/phonebook/test-game')) return response({ status: 'Active', gameServerNodeId: 'test-node' });
    if (url.origin === 'https://gs2.geoguessr.com') {
      assert.equal(request.headers.Cookie, '_geoguessr_guest=test-secret');
      return response({ gameId: 'test-game', status: 'Ongoing', currentRoundNumber: 1, teams: [{ players: [{ playerId: 'guest-id', guesses: [] }] }] });
    }
    throw new Error('unexpected route');
  } });
  partyPlaying = true;
  await result.session.game('B', true);
  assert.ok(requests.some(request => request.url === 'https://gs2.geoguessr.com/test-node/test-game/reconnect'));
  assert.equal(events.at(-1).guestIsOriginalPlayer, true);
  assert.doesNotMatch(JSON.stringify(events), /test-secret|test-game|test-party|guest-id/);
  await assert.rejects(() => result.session.guess('B', 35, 139, 1), /GAME_GUESS_NOT_ENABLED/);
});

test('guest Cookie is applicable only to official API WebSocket URL with genuine shared domain', async () => {
  const { socketUrl } = await import('../ws-presence.mjs');
  const jar = new GuestCookieJar();
  jar.accept(cookie);
  assert.equal(jar.socketHeader(socketUrl()), '');
  jar.accept(`${cookie}; Domain=.geoguessr.com`);
  assert.equal(jar.socketHeader(socketUrl()), '_geoguessr_guest=test-secret');
});

test('game summary tracks rounds without disclosing other players or answer coordinates', () => {
  const summary = gameSummary({ status: 'Ongoing', currentRoundNumber: 2, teams: [{ players: [
    { playerId: 'guest-id', guesses: [{ roundNumber: 1, lat: 1, lng: 2 }] },
    { playerId: 'private-player', guesses: [] },
  ] }] }, 'guest-id');
  assert.deepEqual(summary.guestGuessRounds, [1]);
  assert.equal(summary.guestGuessedCurrentRound, false);
  assert.equal(summary.playerCount, 2);
  assert.doesNotMatch(JSON.stringify(summary), /private-player|lat|lng/);
});

test('missing raw bench status is unknown; official client rules bench the third Duel guest', () => {
  const party = { partyId: 'private-party', gameType: 'Duels', owner: { userId: 'private-host' }, partySettings: { masterControl: false } };
  const info = { partyId: 'private-party', totalCount: 3, members: [
    { userId: 'private-host', isPresent: true }, { userId: 'old-guest', isPresent: true },
    { userId: 'reserved-guest', isPresent: true },
  ] };
  const summary = memberSummary(info, 'reserved-guest', party);
  assert.equal(summary.guestRawIsBenched, null);
  assert.equal(summary.guestUnbenched, null);
  assert.equal(summary.guestFieldTypes.isBenched, 'missing');
  assert.equal(summary.clientModeCapacity, 2);
  assert.equal(summary.guestSelectedByClientRules, false);
  assert.doesNotMatch(JSON.stringify(summary), /reserved-guest|old-guest|private-host|private-party/);
  info.members.splice(1, 1);
  assert.equal(memberSummary(info, 'reserved-guest', party).guestSelectedByClientRules, true);
});

test('deliberate capsule export preserves guest cookie attributes and discard clears both auth and access', async () => {
  let calls = 0;
  const client = new GuestClient({ fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return response([{}]);
    return response({ id: 'fixture-guest', nick: 'ReservedSeat' }, calls === 2 ? {
      cookies: ['_geoguessr_guest=fixture-capsule-secret; Domain=.geoguessr.com; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=3600'],
    } : {});
  } });
  await client.createGuest('ReservedSeat');
  const capsule = await client.buildHandoffCapsule('https://www.geoguessr.com/party/lobby/PZM2F');
  assert.equal(capsule.cookie.domain, '.geoguessr.com');
  assert.equal(capsule.cookie.sameSite, 'no_restriction');
  assert.equal(capsule.cookie.httpOnly, true);
  assert.equal(capsule.cookie.value, 'fixture-capsule-secret');
  assert.ok(capsule.cookie.expirationDate > Date.now() / 1000);
  assert.doesNotMatch(JSON.stringify(client.cookieSummary()), /fixture-capsule-secret/);
  client.discardGuestCredentials();
  assert.deepEqual(client.cookieSummary(), []);
  await assert.rejects(() => client.me(), /CLIENT_STOPPED/);
});
