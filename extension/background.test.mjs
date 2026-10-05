import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const helperSource = await readFile(new URL('./handoff.js', import.meta.url), 'utf8');
const helpers = await import(`data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`);
const backgroundSource = await readFile(new URL('./background.js', import.meta.url), 'utf8');
const hostSource = await readFile(new URL('./host-automation.js', import.meta.url), 'utf8');
const host = await import(`data:text/javascript;base64,${Buffer.from(hostSource).toString('base64')}`);
const nativeSource = await readFile(new URL('./native-client.js', import.meta.url), 'utf8');
const nativeHelpers = await import(`data:text/javascript;base64,${Buffer.from(nativeSource).toString('base64')}`);
const contextSource = await readFile(new URL('./party-context.js', import.meta.url), 'utf8');
const contexts = await import(`data:text/javascript;base64,${Buffer.from(contextSource).toString('base64')}`);
const executable = backgroundSource.replace(/^import\s+\{[^}]+\}\s+from\s+['"]\.\/(?:handoff|host-automation|native-client|party-context)\.js['"];?\s*/gmu, '');
assert.notEqual(executable, backgroundSource, 'The background module import must be identified.');

const SECRET = 'synthetic-only-guest-credential.TEST_123=';
const USER = { id: 'reserved_guest', nick: '検証ゲスト' };
const PAGE_URL = 'https://www.geoguessr.com/team-duels/game-123';
const guestCookie = () => ({
  name: '_geoguessr_guest', value: SECRET, domain: '.geoguessr.com', path: '/',
  secure: true, httpOnly: true, sameSite: 'lax', storeId: 'destination-store',
});
const transfer = () => helpers.buildCapsule({ guest: USER, cookie: guestCookie(), pageUrl: PAGE_URL });
const SEAT_ID = '0a'.repeat(16);
const HOST_CONTEXT = { partyCode: 'PZM2F', isLeader: true, gameState: 'NoGame', guestsAllowed: true,
  capacity: 20, memberCount: 1, participatingCount: 1, roomCapacity: 20, observedAt: Date.now() };
const nativeStatus = count => ({ ready: true, maxSeats: 100, seats: [], reservation: {
  partyCode: 'PZM2F', target: count, state: 'checking', warning: null, capacity: 20, availableToReserve: 19,
} });

function harness(options = {}) {
  const calls = { query: [], stores: [], getAll: [], set: [], remove: [], script: [], update: [], storage: [],
    nativeConnect: [], nativeMessages: [], contentMessages: [], tabRemovedListeners: [] };
  const state = { cookies: (options.cookies ?? []).map(cookie => ({ ...cookie })), settings: { ...options.settings } };
  let listener, nativeMessageListener, nativeDisconnectListener;
  const port = {
    onMessage: { addListener(callback) { nativeMessageListener = callback; } },
    onDisconnect: { addListener(callback) { nativeDisconnectListener = callback; } },
    postMessage(message) {
      calls.nativeMessages.push(structuredClone(message));
      if (options.nativePostError) throw options.nativePostError;
      if (options.nativeHold) return;
      queueMicrotask(async () => {
        const reply = options.nativeReply ? await options.nativeReply(message)
          : options.nativeError ? { ok: false, error: options.nativeError }
            : { ok: true, result: nativeStatus(message.count ?? state.settings.reservedSeatCount ?? 0) };
        nativeMessageListener({ requestId: message.requestId, ...reply });
      });
    },
  };
  const chrome = {
    runtime: {
      id: 'test-extension-id', getURL: path => `chrome-extension://test-extension-id/${path}`,
      onMessage: { addListener(callback) { listener = callback; } },
      connectNative(name) {
        calls.nativeConnect.push(name);
        if (options.nativeConnectError) throw options.nativeConnectError;
        assert.equal(name, nativeHelpers.NATIVE_HOST);
        return port;
      },
      lastError: options.nativeLastError,
    },
    tabs: {
      async query(details) {
        calls.query.push(details);
        if (!details.active) return options.contentTabs ?? [];
        return options.tabs ?? [{
          id: 42, url: 'https://www.geoguessr.com/party/lobby/lobby-123', incognito: false,
        }];
      },
      async update(tabId, details) {
        calls.update.push({ tabId, details });
        if (options.updateError) throw options.updateError;
        return { id: tabId, ...details };
      },
      async sendMessage(tabId, message) { calls.contentMessages.push({ tabId, message }); },
      onRemoved: { addListener(callback) { calls.tabRemovedListeners.push(callback); } },
    },
    cookies: {
      async getAllCookieStores() {
        calls.stores.push(true);
        return options.stores ?? [{ id: 'destination-store', tabIds: [42] }];
      },
      async getAll(details) {
        calls.getAll.push(details);
        return state.cookies.map(cookie => ({ ...cookie }));
      },
      async set(details) {
        calls.set.push(details);
        if (options.setError) throw options.setError;
        if (options.setReturnsNothing) return undefined;
        state.cookies.push({ ...details });
        return { ...details };
      },
      async remove(details) {
        calls.remove.push(details);
        if (options.removeError) throw options.removeError;
        if (options.removeReturnsNull) return null;
        state.cookies = state.cookies.filter(cookie => cookie.name !== details.name);
        return details;
      },
    },
    scripting: {
      async executeScript(details) {
        calls.script.push(details);
        if (options.scriptError) throw options.scriptError;
        if (details.func === contexts.readActivePartyContext) {
          return [{ result: Object.hasOwn(options, 'hostContext') ? options.hostContext : { ...HOST_CONTEXT, observedAt: Date.now() } }];
        }
        if (options.onIdentity) await options.onIdentity(details);
        return options.scriptResults ?? [{ result: { status: 200, guest: { ...USER } } }];
      },
    },
    storage: Object.fromEntries(['local', 'session', 'sync'].map(area => [area, {
      async get(value) {
        calls.storage.push({ area, operation: 'get', value });
        assert.equal(area, 'local', 'Only the seat-count preference may be read.');
        assert.equal(value, 'reservedSeatCount');
        return { [value]: state.settings[value] };
      },
      async set(value) {
        calls.storage.push({ area, operation: 'set', value });
        assert.equal(area, 'local', 'Credentials must not be stored in any extension area.');
        assert.deepEqual(Object.keys(value), ['reservedSeatCount']);
        assert.ok(Number.isInteger(value.reservedSeatCount));
        Object.assign(state.settings, value);
      },
    }])),
  };
  // Evaluate the actual background implementation with its imported pure helpers
  // supplied as lexical dependencies, without global Chrome state or network I/O.
  const imports = { ...helpers, ...host, ...nativeHelpers, ...contexts };
  new Function('chrome', ...Object.keys(imports), executable)(chrome, ...Object.values(imports));
  assert.equal(typeof listener, 'function');
  const popup = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') };
  async function request(message, sender = popup) {
    return new Promise((resolve, reject) => {
      try {
        const pending = listener(message, sender, resolve);
        if (pending !== true) resolve(undefined);
      } catch (error) {
        reject(error);
      }
    });
  }
  return { chrome, calls, state, popup, request,
    partySender: { id: chrome.runtime.id, url: 'https://www.geoguessr.com/party/lobby/PZM2F', tab: { id: 42, incognito: false } },
    disconnect() { nativeDisconnectListener(); },
    nativeResponse(message) { nativeMessageListener(message); },
  };
}

test('credential operations are available only to the exact extension popup', async () => {
  const h = harness({ cookies: [guestCookie()] });
  const untrustedSenders = [
    { id: 'another-extension', url: h.popup.url },
    { id: h.popup.id, url: 'https://www.geoguessr.com/party/lobby/lobby-123', tab: { id: 42 } },
    { ...h.popup, tab: { id: 42 } },
    { id: h.popup.id, url: h.chrome.runtime.getURL('popup.html?untrusted=1') },
    { id: h.popup.id, url: h.chrome.runtime.getURL('options.html') },
    { id: h.popup.id },
  ];
  for (const sender of untrustedSenders) {
    assert.equal(await h.request({ action: 'export' }, sender), undefined);
  }
  assert.equal(h.calls.query.length, 0);
  assert.equal(h.calls.script.length, 0);
  assert.equal(h.calls.set.length, 0);
});

test('unknown actions including Object prototype names are rejected', async () => {
  const h = harness();
  for (const action of ['unknown', 'toString', 'constructor', '__proto__', 'hasOwnProperty', 'hostConnect', 'hostCreate']) {
    assert.equal(await h.request({ action }), undefined, `Unknown action ${action} must not succeed.`);
  }
  assert.equal(h.calls.query.length, 0);
});

test('regular account scope is rejected whenever _ncfa exists, including an empty value', async () => {
  for (const value of ['synthetic-account-value', '']) {
    for (const action of ['inspect', 'export', 'import']) {
      const h = harness({ cookies: [{ name: '_ncfa', value, domain: '.geoguessr.com', path: '/' }] });
      const response = await h.request({ action, capsule: JSON.stringify(transfer()) });
      assert.equal(response.ok, false, `${action} must reject registered-account scope even with an empty cookie.`);
      assert.match(response.error, /通常アカウント/);
      assert.equal(h.calls.script.length, 0);
      assert.equal(h.calls.set.length, 0);
      assert.equal(h.calls.remove.length, 0);
      assert.equal(h.calls.update.length, 0);
    }
  }
});

test('malformed transfer data is rejected before any browser context or cookie mutation', async () => {
  const malformed = [
    '{invalid', '{}',
    JSON.stringify({ ...transfer(), pageUrl: 'https://evil.test/duels/game-123' }),
    JSON.stringify({ ...transfer(), cookie: { ...guestCookie(), name: '_ncfa' } }),
    JSON.stringify({ ...transfer(), expiresAt: Date.now() - 1 }),
  ];
  for (const capsule of malformed) {
    const h = harness();
    const response = await h.request({ action: 'import', capsule });
    assert.equal(response.ok, false);
    assert.equal(h.calls.query.length, 0);
    assert.equal(h.calls.getAll.length, 0);
    assert.equal(h.calls.set.length, 0);
    assert.ok(!JSON.stringify(response).includes(SECRET));
  }
});

test('destination guest is never overwritten', async () => {
  const h = harness({ cookies: [guestCookie()] });
  const response = await h.request({ action: 'import', capsule: JSON.stringify(transfer()) });
  assert.equal(response.ok, false);
  assert.match(response.error, /すでにゲスト/);
  assert.equal(h.calls.set.length, 0);
  assert.equal(h.calls.remove.length, 0);
  assert.equal(h.calls.script.length, 0);
});

test('valid import uses the selected tab store and navigates only after matching guest identity', async () => {
  const h = harness();
  const response = await h.request({ action: 'import', capsule: JSON.stringify(transfer()) });
  assert.equal(response.ok, true);
  assert.equal(response.result.verified, true);
  assert.equal(response.result.guest.id, USER.id);
  assert.equal(h.calls.getAll[0].storeId, 'destination-store');
  assert.equal(h.calls.set.length, 1);
  assert.equal(h.calls.set[0].name, '_geoguessr_guest');
  assert.equal(h.calls.set[0].storeId, 'destination-store');
  assert.equal(h.calls.script[0].target.tabId, 42);
  assert.deepEqual(h.calls.update, [{ tabId: 42, details: { url: PAGE_URL } }]);
  assert.equal(h.calls.remove.length, 0);
  assert.equal(h.calls.storage.length, 0);
  assert.ok(!JSON.stringify(response).includes(SECRET));
});

test('identity mismatch rolls back only the imported guest cookie in the selected store', async () => {
  const h = harness({ scriptResults: [{ result: { status: 200, guest: { id: 'wrong_guest', nick: 'other' } } }] });
  const response = await h.request({ action: 'import', capsule: JSON.stringify(transfer()) });
  assert.equal(response.ok, false);
  assert.match(response.error, /IDが一致しません/);
  assert.equal(h.calls.set.length, 1);
  assert.deepEqual(h.calls.remove, [{
    url: 'https://www.geoguessr.com/', name: '_geoguessr_guest', storeId: 'destination-store',
  }]);
  assert.equal(h.state.cookies.length, 0);
  assert.equal(h.calls.update.length, 0);
  assert.ok(!JSON.stringify(response).includes(SECRET));
});

test('failed guest verification or failed navigation rolls back the imported cookie', async () => {
  for (const options of [
    { scriptResults: [{ result: { status: 401 } }] },
    { scriptError: new Error('Synthetic network failure.') },
    { updateError: new Error('Synthetic navigation failure.') },
  ]) {
    const h = harness(options);
    const response = await h.request({ action: 'import', capsule: JSON.stringify(transfer()) });
    assert.equal(response.ok, false);
    assert.equal(h.calls.remove.length, 1);
    assert.equal(h.state.cookies.length, 0);
  }
});

test('expiry is checked again after guest verification and triggers rollback', async () => {
  const realNow = Date.now;
  let current = realNow();
  Date.now = () => current;
  try {
    const capsule = transfer();
    const h = harness({ onIdentity() { current += 600001; } });
    const response = await h.request({ action: 'import', capsule: JSON.stringify(capsule) });
    assert.equal(response.ok, false);
    assert.ok(!JSON.stringify(response).includes(SECRET));
    assert.equal(h.calls.remove.length, 1);
    assert.equal(h.calls.update.length, 0);
  } finally {
    Date.now = realNow;
  }
});

test('identity runs a fixed read-only official request in the selected tab', async () => {
  let fetchCall;
  const originalFetch = globalThis.fetch;
  const h = harness({
    cookies: [guestCookie()],
    async onIdentity(details) {
      globalThis.fetch = async (url, init) => {
        fetchCall = { url, init };
        return { ok: true, status: 200, json: async () => ({ ...USER, extraPrivateField: 'excluded' }) };
      };
      try {
        const result = await details.func();
        assert.deepEqual(result, { status: 200, guest: USER });
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  });
  const response = await h.request({ action: 'inspect' });
  assert.equal(response.ok, true);
  assert.deepEqual(fetchCall, {
    url: '/api/v4/guest-users/me',
    init: { credentials: 'include', cache: 'no-store', redirect: 'error' },
  });
  assert.equal(h.calls.set.length, 0);
  assert.equal(h.calls.storage.length, 0);
});

test('export reveals the capsule only to the trusted popup and never writes extension storage', async () => {
  const h = harness({ cookies: [guestCookie()] });
  const response = await h.request({ action: 'export' });
  assert.equal(response.ok, true);
  assert.equal(helpers.validateCapsule(response.result.capsule).cookie.value, SECRET);
  assert.ok(!JSON.stringify(response.result.summary).includes(SECRET));
  assert.equal(h.calls.storage.length, 0);
  assert.equal(h.calls.set.length, 0);
  assert.equal(h.calls.remove.length, 0);
});

test('unexpected browser errors cannot echo the imported credential to the popup', async () => {
  const h = harness({ scriptError: new Error(`Synthetic failure containing ${SECRET}`) });
  const response = await h.request({ action: 'import', capsule: JSON.stringify(transfer()) });
  assert.equal(response.ok, false);
  assert.ok(!JSON.stringify(response).includes(SECRET), 'Error responses must exclude the imported credential.');
  assert.equal(h.calls.remove.length, 1);
});

test('cookie setter exceptions do not disclose credentials or attempt game navigation', async () => {
  const h = harness({ setError: new Error(`Synthetic setter failure containing ${SECRET}`) });
  const response = await h.request({ action: 'import', capsule: JSON.stringify(transfer()) });
  assert.equal(response.ok, false);
  assert.ok(!JSON.stringify(response).includes(SECRET));
  assert.equal(h.calls.set.length, 1);
  assert.equal(h.calls.script.length, 0);
  assert.equal(h.calls.update.length, 0);
  assert.equal(h.calls.storage.length, 0);
});

test('rollback exceptions do not disclose credentials and import cannot report success', async () => {
  const h = harness({
    scriptResults: [{ result: { status: 200, guest: { id: 'wrong_guest', nick: 'other' } } }],
    removeError: new Error(`Synthetic rollback failure containing ${SECRET}`),
  });
  const response = await h.request({ action: 'import', capsule: JSON.stringify(transfer()) });
  assert.equal(response.ok, false);
  assert.match(response.error, /削除.*確認できません/);
  assert.ok(!JSON.stringify(response).includes(SECRET));
  assert.equal(h.calls.remove.length, 1);
  assert.equal(h.calls.update.length, 0);
  assert.equal(h.calls.storage.length, 0);
});

test('a null rollback result reports removal failure and leaves navigation stopped', async () => {
  const h = harness({
    scriptResults: [{ result: { status: 200, guest: { id: 'wrong_guest', nick: 'other' } } }],
    removeReturnsNull: true,
  });
  const response = await h.request({ action: 'import', capsule: JSON.stringify(transfer()) });
  assert.equal(response.ok, false);
  assert.match(response.error, /削除.*確認できません/);
  assert.ok(!JSON.stringify(response).includes(SECRET));
  assert.equal(h.calls.remove.length, 1);
  assert.equal(h.calls.update.length, 0);
  assert.equal(h.calls.storage.length, 0);
  assert.equal(h.state.cookies.length, 1, 'A failed rollback is not treated as cleanup success.');
});

test('host URL information uses only the tab URL even when the profile has a regular account', async () => {
  const h = harness({ cookies: [{ name: '_ncfa', value: 'account-test' }] });
  const response = await h.request({ action: 'hostContext' });
  assert.equal(response.ok, true);
  assert.equal(response.result.partyCode, '');
  assert.equal(h.calls.getAll.length, 0);
  assert.equal(h.calls.stores.length, 0);
  assert.equal(h.calls.script.length, 0);
});

test('seat-count setting accepts zero, arbitrary seven, and the global bound outside GeoGuessr without starting Node', async () => {
  for (const count of [0, 7, 100]) {
    const h = harness({ tabs: [{ id: 42, url: 'https://example.test/', incognito: false }] });
    const response = await h.request({ action: 'saveReservations', count, cookie: SECRET, token: SECRET });
    assert.equal(response.ok, true);
    assert.equal(response.result.configuredCount, count);
    assert.equal(response.result.enabled, false);
    assert.deepEqual(h.state.settings, { reservedSeatCount: count });
    assert.deepEqual(h.calls.storage.filter(call => call.operation === 'set'), [
      { area: 'local', operation: 'set', value: { reservedSeatCount: count } },
    ]);
    assert.equal(h.calls.nativeConnect.length, 0);
    assert.equal(h.calls.script.length, 0);
    assert.equal(h.calls.getAll.length, 0);
    assert.doesNotMatch(JSON.stringify(h.calls.storage), /synthetic-only-guest-credential/);
  }
});

test('invalid counts are rejected before storage, metadata reads, or native launch', async () => {
  for (const count of [-1, 101, 7.5, '5', null, undefined, NaN]) {
    const h = harness();
    const response = await h.request({ action: 'saveReservations', count });
    assert.equal(response.ok, false);
    assert.equal(h.calls.storage.length, 0);
    assert.equal(h.calls.nativeConnect.length, 0);
    assert.equal(h.calls.script.length, 0);
  }
});

test('settings lookup sanitizes stale invalid values and reads only the numeric preference', async () => {
  for (const stored of [undefined, SECRET, -1, 101, 1.5, 7]) {
    const h = harness({ settings: { reservedSeatCount: stored } });
    const response = await h.request({ action: 'reservationSettings' });
    assert.equal(response.ok, true);
    assert.equal(response.result.configuredCount, stored === 7 ? 7 : 0);
    assert.equal(h.calls.nativeConnect.length, 0);
    assert.deepEqual(h.calls.storage, [{ area: 'local', operation: 'get', value: 'reservedSeatCount' }]);
    assert.ok(!JSON.stringify(response).includes(SECRET));
  }
});

test('page signals cannot invoke settings or credential actions and untrusted observed senders are rejected', async () => {
  const h = harness({ settings: { reservedSeatCount: 5 } });
  for (const sender of [
    { ...h.partySender, id: 'another-extension' },
    { ...h.partySender, url: 'https://evil.test/party/lobby/PZM2F' },
    { ...h.partySender, url: 'https://www.geoguessr.com/duels/game' },
    { ...h.partySender, tab: { id: 42, incognito: true } },
    { ...h.partySender, tab: undefined },
  ]) assert.equal(await h.request({ action: 'partyObserved' }, sender), undefined);
  for (const action of ['saveReservations', 'reservationSettings', 'hostHandoff', 'hostStop', 'export', 'import']) {
    assert.equal(await h.request({ action, count: 100, seatId: SEAT_ID, capsule: JSON.stringify(transfer()) }, h.partySender), undefined);
  }
  assert.equal(h.calls.storage.length, 0);
  assert.equal(h.calls.script.length, 0);
  assert.equal(h.calls.nativeConnect.length, 0);
  assert.equal(h.calls.set.length, 0);
});

test('automatic reservation forwards official leader metadata and the saved five-seat count without account-cookie access', async () => {
  const context = { ...HOST_CONTEXT, observedAt: Date.now() };
  const h = harness({
    cookies: [{ name: '_ncfa', value: 'synthetic-account-value' }],
    settings: { reservedSeatCount: 5 }, hostContext: context,
  });
  const response = await h.request({ action: 'partyObserved', count: 100, hostContext: { ...context, isLeader: false }, token: SECRET }, h.partySender);
  assert.equal(response.ok, true);
  assert.equal(response.result.configuredCount, 5);
  assert.equal(response.result.enabled, true);
  assert.deepEqual(response.result.context, context);
  assert.equal(h.calls.nativeConnect.length, 1);
  assert.deepEqual(h.calls.nativeMessages, [{ requestId: 'request_1', action: 'reserve', partyCode: 'PZM2F', count: 5, hostContext: context }]);
  assert.equal(h.calls.script.length, 1);
  assert.equal(h.calls.script[0].func, contexts.readActivePartyContext);
  assert.equal(h.calls.script[0].target.tabId, 42);
  assert.equal(h.calls.stores.length, 0);
  assert.equal(h.calls.getAll.length, 0);
  assert.equal(h.calls.set.length, 0);
  assert.equal(h.calls.remove.length, 0);
  assert.doesNotMatch(JSON.stringify(h.calls.nativeMessages), /synthetic-account-value|synthetic-only-guest-credential/);
  assert.ok(h.calls.storage.every(call => call.area === 'local' && call.operation === 'get' && call.value === 'reservedSeatCount'));
});

test('a verified nonleader receives disabled state and cannot reserve guests through the native host', async () => {
  const context = { ...HOST_CONTEXT, isLeader: false, observedAt: Date.now() };
  const h = harness({ settings: { reservedSeatCount: 5 }, hostContext: context });
  const response = await h.request({ action: 'partyObserved' }, h.partySender);
  assert.equal(response.ok, true);
  assert.equal(response.result.enabled, false);
  assert.deepEqual(response.result.context, context);
  assert.equal(h.calls.nativeConnect.length, 0);
  assert.equal(h.calls.nativeMessages.length, 0);
  assert.equal(h.calls.getAll.length, 0);
});

test('disabled reservations and unavailable Party metadata cannot launch native guest creation', async () => {
  for (const options of [{ settings: { reservedSeatCount: 0 } },
    { settings: { reservedSeatCount: 5 }, hostContext: null },
    { settings: { reservedSeatCount: 5 }, hostContext: { error: SECRET } }]) {
    const h = harness(options);
    const response = await h.request({ action: 'partyObserved' }, h.partySender);
    assert.equal(response.ok, true);
    assert.equal(response.result.enabled, options.settings.reservedSeatCount > 0);
    if (options.settings.reservedSeatCount > 0) assert.ok(response.result.error, 'Unavailable metadata must keep the start guard stopped.');
    assert.equal(h.calls.nativeConnect.length, 0); assert.equal(h.calls.set.length, 0);
    assert.ok(!JSON.stringify(response).includes(SECRET));
  }
});

test('a thrown tab inspection cannot turn a positive reservation preference into a released start guard', async () => {
  const h = harness({ settings: { reservedSeatCount: 5 }, scriptError: new Error(SECRET) });
  const response = await h.request({ action: 'partyObserved' }, h.partySender);
  assert.equal(response.ok, true);
  assert.equal(response.result.configuredCount, 5);
  assert.equal(response.result.enabled, true);
  assert.ok(response.result.error);
  assert.ok(!JSON.stringify(response).includes(SECRET));
  assert.equal(h.calls.nativeConnect.length, 0);
  assert.equal(h.calls.getAll.length, 0);
});

test('saving a setting notifies normal GeoGuessr content tabs while skipping InPrivate tabs', async () => {
  const h = harness({ tabs: [{ id: 42, url: 'https://example.test/', incognito: false }], contentTabs: [
    { id: 7, url: 'https://www.geoguessr.com/party/lobby/PZM2F', incognito: false },
    { id: 8, url: 'https://www.geoguessr.com/party/lobby/PZM2F', incognito: true },
  ] });
  assert.equal((await h.request({ action: 'saveReservations', count: 7 })).ok, true);
  assert.deepEqual(h.calls.contentMessages, [{ tabId: 7, message: { action: 'reservationSettingsChanged' } }]);
  assert.ok(h.calls.query.some(query => query.url === 'https://www.geoguessr.com/*'));
  assert.equal(h.calls.nativeConnect.length, 0);
  assert.equal(h.calls.getAll.length, 0);
});

test('an ongoing Duel polls status without requesting replacement seats', async () => {
  const h = harness({ settings: { reservedSeatCount: 5 }, hostContext: { ...HOST_CONTEXT, gameState: 'Ongoing', observedAt: Date.now() } });
  const response = await h.request({ action: 'partyObserved' }, h.partySender);
  assert.equal(response.ok, true);
  assert.deepEqual(h.calls.nativeMessages, [{ action: 'status', requestId: 'request_1' }]);
  assert.equal(h.calls.getAll.length, 0); assert.equal(h.calls.set.length, 0);
});

test('setting count zero cancels an owned batch using its Party code without invented fresh host metadata', async () => {
  const h = harness({ settings: { reservedSeatCount: 5 } });
  assert.equal((await h.request({ action: 'partyObserved' }, h.partySender)).ok, true);
  const cancelled = await h.request({ action: 'saveReservations', count: 0 });
  assert.equal(cancelled.ok, true); assert.equal(cancelled.result.enabled, false);
  assert.deepEqual(h.calls.nativeMessages[1], { requestId: 'request_2', action: 'reserve', partyCode: 'PZM2F', count: 0 });
  assert.deepEqual(h.state.settings, { reservedSeatCount: 0 });
  assert.equal(h.calls.getAll.length, 0); assert.equal(h.calls.set.length, 0);
});

test('concurrent signals share one metadata read and reserve operation for the same tab', async () => {
  const h = harness({ settings: { reservedSeatCount: 5 } });
  const [first, second] = await Promise.all([
    h.request({ action: 'partyObserved' }, h.partySender), h.request({ action: 'partyObserved' }, h.partySender),
  ]);
  assert.equal(first.ok, true); assert.deepEqual(second, first);
  assert.equal(h.calls.script.length, 1); assert.equal(h.calls.nativeMessages.length, 1);
});

test('native failure responses and browser lastError cannot disclose raw secret text', async () => {
  for (const options of [ { nativeError: SECRET }, { nativeError: 'SECRET_REMOTE_ERROR' },
    { nativeConnectError: new Error(SECRET) }, { nativePostError: new Error(SECRET) } ]) {
    const h = harness({ settings: { reservedSeatCount: 5 }, ...options });
    const response = await h.request({ action: 'partyObserved' }, h.partySender);
    assert.equal(response.ok, true); assert.ok(response.result.error);
    assert.ok(!JSON.stringify(response).includes(SECRET));
    assert.ok(!JSON.stringify(response).includes('SECRET_REMOTE_ERROR'));
    assert.equal(h.calls.set.length, 0);
  }
  const h = harness({ settings: { reservedSeatCount: 5 }, nativeHold: true, nativeLastError: { message: SECRET } });
  const pending = h.request({ action: 'partyObserved' }, h.partySender);
  await new Promise(done => setImmediate(done));
  h.disconnect();
  const disconnected = await pending;
  assert.ok(!JSON.stringify(disconnected).includes(SECRET));
  assert.match(disconnected.result.error, /初回の応答/);
});

test('native handoff remains available only on explicit trusted popup action and never stores the capsule', async () => {
  const h = harness({
    nativeReply: async () => ({ ok: true, result: { capsule: transfer() } }),
  });
  assert.equal(await h.request({ action: 'hostHandoff', seatId: SEAT_ID }, { ...h.popup, tab: { id: 42 } }), undefined);
  assert.equal(h.calls.nativeConnect.length, 0);
  const response = await h.request({ action: 'hostHandoff', seatId: SEAT_ID });
  assert.equal(response.ok, true);
  assert.equal(helpers.validateCapsule(response.result.capsule).cookie.value, SECRET);
  assert.ok(!JSON.stringify(response.result.summary).includes(SECRET));
  assert.deepEqual(h.calls.nativeMessages, [{ action: 'handoff', requestId: 'request_1', seatId: SEAT_ID }]);
  assert.equal(h.calls.storage.length, 0);
  assert.equal(h.calls.getAll.length, 0);
  assert.equal(h.calls.set.length, 0);
});

test('malformed native handoff capsules are rejected before exposing credentials or touching browser cookies', async () => {
  const h = harness({ nativeReply: async () => ({ ok: true, result: { capsule: {
    ...transfer(), pageUrl: 'https://evil.test/duels/private', cookie: { ...guestCookie(), value: SECRET },
  } } }) });
  const response = await h.request({ action: 'hostHandoff', seatId: SEAT_ID });
  assert.equal(response.ok, false);
  assert.ok(!JSON.stringify(response).includes(SECRET));
  assert.equal(h.calls.storage.length, 0);
  assert.equal(h.calls.getAll.length, 0);
  assert.equal(h.calls.set.length, 0);
});
