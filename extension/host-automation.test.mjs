import test from 'node:test';
import assert from 'node:assert/strict';
import { partyTabInfo, validatePartyCode, seatPath, companionRequest } from './host-automation.js';

const TOKEN = 'a'.repeat(64);

test('invitation code detection accepts only official Party tabs and does not confuse lobby IDs', () => {
  assert.equal(partyTabInfo('https://www.geoguessr.com/ja/party/join/abcde').partyCode, 'ABCDE');
  assert.equal(partyTabInfo('https://www.geoguessr.com/party/lobby/room-long-id').partyCode, '');
  for (const url of ['https://evil.test/party/join/ABCDE', 'https://www.geoguessr.com/duels/a', 'http://www.geoguessr.com/party/join/ABCDE', 'https://someone@www.geoguessr.com/party/join/ABCDE']) {
    assert.throws(() => partyTabInfo(url));
  }
  assert.equal(validatePartyCode(' abc12 '), 'ABC12');
  assert.throws(() => validatePartyCode('ABC/1'));
});

test('companion route construction cannot redirect the key to another origin or inject a path', async () => {
  let called = false;
  for (const path of ['https://evil.test/status', '//evil.test/status', '/status?url=evil', '/shutdown', '/seats/../handoff']) {
    await assert.rejects(companionRequest(TOKEN, path, 'POST', {}, async () => { called = true; }));
  }
  for (const id of ['../status', 'a/b', '', 'a?b']) assert.throws(() => seatPath(id));
  assert.equal(called, false);
});

test('requests use fixed localhost, trimmed key, no cookies, no redirects and bounded timeout', async () => {
  let request;
  const result = await companionRequest(` ${TOKEN} `, '/status', 'GET', undefined, async (url, init) => {
    request = { url, init };
    return { ok: true, json: async () => ({ ready: true, seats: [] }) };
  });
  assert.equal(result.ready, true);
  assert.equal(request.url, 'http://127.0.0.1:38477/status');
  assert.equal(request.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.redirect, 'error');
  assert.ok(request.init.signal instanceof AbortSignal);
});
