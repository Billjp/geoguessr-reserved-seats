import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readActivePartyContext } from './party-context.js';

const PATHS = [
  '/api/v4/parties/v2/active', '/api/v3/profiles/',
  '/api/v4/parties/v2/members?page=0&count=101',
];
const FAILED = { error: 'PARTY_CONTEXT_UNAVAILABLE' };

function setup({ url = 'https://www.geoguessr.com/ja/party/lobby/room-resource',
  partyPatch = {}, profile = { user: { id: 'host-id' }, email: 'private-profile-value' },
  members = [{ userId: 'host-id' }, { userId: 'member-id' }], totalCount = members.length,
  settingsPatch = {}, responsePatch = {}, beforeResponse, failFetch = false, abort = false } = {}) {
  const party = {
    partyId: 'room-resource', joinCode: { code: 'abC12' }, owner: { userId: 'host-id' },
    gameType: 'TeamDuels', gameState: 'NoGame',
    partySettings: { allowGuests: true, masterControl: false, maxPartySize: 100, ...settingsPatch },
    ...partyPatch,
  };
  const bodies = [party, profile, { members, totalCount }];
  const requests = [];
  const location = { href: url };
  let timeout;
  const signal = { aborted: abort };
  const context = {
    URL, location, Date: { now: () => 123456 },
    AbortSignal: { timeout: milliseconds => { timeout = milliseconds; return signal; } },
    fetch: async (path, options) => {
      requests.push({ path, options });
      beforeResponse?.(path, location);
      if (failFetch || options.signal.aborted) throw new Error('secret-cookie-value');
      const index = PATHS.indexOf(path);
      if (index < 0) throw new Error('unexpected endpoint');
      return {
        ok: true, redirected: false, headers: { get: () => 'application/json; charset=utf-8' },
        json: async () => bodies[index], ...responsePatch,
      };
    },
  };
  return {
    requests, location, party, bodies,
    run: async () => JSON.parse(JSON.stringify(await vm.runInNewContext(
      `(${readActivePartyContext.toString()})()`, context))),
    timeout: () => timeout,
  };
}

test('standalone function returns only whitelist metadata and uses fixed read-only tab requests', async () => {
  const fixture = setup();
  assert.deepEqual(await fixture.run(), {
    partyCode: 'ABC12', isLeader: true, gameState: 'NoGame', guestsAllowed: true,
    capacity: 20, memberCount: 2, participatingCount: 2, roomCapacity: 100, observedAt: 123456,
  });
  assert.deepEqual(fixture.requests.map(request => request.path), PATHS);
  assert.equal(fixture.timeout(), 8000);
  for (const { options } of fixture.requests) {
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'include');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(Object.hasOwn(options, 'headers'), false);
    assert.equal(Object.hasOwn(options, 'body'), false);
  }
});

test('URL must be the official current lobby and must match its active Party', async () => {
  for (const url of [
    'https://evil.test/party/lobby/room-resource',
    'http://www.geoguessr.com/party/lobby/room-resource',
    'https://user@www.geoguessr.com/party/lobby/room-resource',
    'https://www.geoguessr.com/party/join/ABC12',
    'https://www.geoguessr.com/duels/room-resource',
    'https://www.geoguessr.com/party/lobby/%72oom-resource',
  ]) {
    const fixture = setup({ url });
    assert.deepEqual(await fixture.run(), FAILED);
    assert.equal(fixture.requests.length, 0);
  }
  assert.deepEqual(await setup({ url: 'https://www.geoguessr.com/party/lobby/another-room' }).run(), FAILED);
  assert.equal((await setup({ url: 'https://www.geoguessr.com/party/lobby/abc12?x=1#tab' }).run()).partyCode, 'ABC12');
});

test('navigation during reads fails while hash/query changes do not change the lobby identity', async () => {
  assert.deepEqual(await setup({ beforeResponse: (_, location) => {
    location.href = 'https://www.geoguessr.com/party/lobby/other-room';
  } }).run(), FAILED);
  const fixture = setup({ beforeResponse: (_, location) => {
    location.href = 'https://www.geoguessr.com/ja/party/lobby/room-resource?tab=members#changed';
  } });
  assert.equal((await fixture.run()).isLeader, true);
});

test('leader comparison stays inside the tab and the official userId fallback is supported', async () => {
  assert.equal((await setup({ profile: { user: { userId: 'host-id' } } }).run()).isLeader, true);
  const result = await setup({ profile: { user: { id: 'another-account' } } }).run();
  assert.equal(result.isLeader, false);
  assert.equal(JSON.stringify(result).includes('another-account'), false);
  for (const profile of [null, {}, { user: {} }, { user: { id: 42 } }]) {
    assert.deepEqual(await setup({ profile }).run(), FAILED);
  }
});

test('official mode capacity and game-master owner exclusion determine participation', async () => {
  assert.equal((await setup({ partyPatch: { gameType: 'Duels' } }).run()).capacity, 2);
  const spectator = await setup({ settingsPatch: { masterControl: true, maxPartySize: 101 } }).run();
  assert.equal(spectator.capacity, 20);
  assert.equal(spectator.participatingCount, 1);
  assert.equal(spectator.memberCount, 2);
  const allAgainstOne = await setup({ settingsPatch: { maxPartySize: 101 } }).run();
  assert.equal(allAgainstOne.capacity, 101);
  const smallRoom = await setup({ settingsPatch: { maxPartySize: 3 } }).run();
  assert.equal(smallRoom.capacity, 20);
  assert.equal(smallRoom.roomCapacity, 3);
  const full = await setup({ members: [{ userId: 'host-id' }, ...Array.from({ length: 23 }, (_, i) => ({ userId: `member-${i}` }))] }).run();
  assert.equal(full.participatingCount, 20);
  assert.equal(full.memberCount, 24);
});

test('incomplete, duplicate, malformed or cross-Party membership fails without exporting IDs', async () => {
  for (const patch of [
    { totalCount: 3 }, { totalCount: -1 }, { totalCount: 1.5 }, { totalCount: 102 },
    { members: [{ userId: 'host-id' }, { userId: 'host-id' }] },
    { members: [{ userId: 'member-id' }] },
    { members: [{ userId: 'host-id' }, {}] },
  ]) assert.deepEqual(await setup(patch).run(), FAILED);
  const fixture = setup();
  fixture.bodies[2].partyId = 'another-room';
  assert.deepEqual(await fixture.run(), FAILED);
  const exact = setup();
  exact.bodies[2].partyId = 'room-resource';
  assert.equal((await exact.run()).memberCount, 2);
});

test('missing settings or unsupported mode/state cannot supply guessed defaults', async () => {
  for (const patch of [
    { settingsPatch: { masterControl: undefined } },
    { settingsPatch: { allowGuests: undefined } },
    { settingsPatch: { maxPartySize: undefined } },
    { settingsPatch: { maxPartySize: 0 } },
    { partyPatch: { gameType: null } },
    { partyPatch: { gameState: 'Unknown' } },
    { partyPatch: { joinCode: { code: 'NOT-A-CODE' } } },
  ]) assert.deepEqual(await setup(patch).run(), FAILED);
  assert.equal((await setup({ partyPatch: { gameState: 'Ongoing' }, settingsPatch: { allowGuests: false } }).run()).guestsAllowed, false);
});

test('other valid Party modes bypass reservation only after verifying their context', async () => {
  for (const gameType of ['LiveChallenge', 'Bullseye', 'Quiz', 'FreeForAll']) {
    assert.deepEqual(await setup({ partyPatch: { gameType } }).run(), { error: 'UNSUPPORTED_GAME_TYPE' });
  }
  assert.deepEqual(await setup({ partyPatch: { gameType: 'Bullseye' }, settingsPatch: { masterControl: undefined } }).run(), FAILED);
  assert.deepEqual(await setup({ partyPatch: { gameType: 'Bullseye' }, url: 'https://www.geoguessr.com/party/lobby/wrong-room' }).run(), FAILED);
});

test('HTTP denial, redirects, HTML, parsing, network and timeout failure expose one fixed code', async () => {
  for (const patch of [
    { responsePatch: { ok: false, status: 403 } },
    { responsePatch: { redirected: true } },
    { responsePatch: { headers: { get: () => 'text/html' } } },
    { responsePatch: { json: async () => { throw new Error('private-server-message'); } } },
    { failFetch: true }, { abort: true },
  ]) assert.deepEqual(await setup(patch).run(), FAILED);
});
