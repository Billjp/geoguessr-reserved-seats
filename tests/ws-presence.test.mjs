import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkedSocketUrl, socketUrl, initialPresenceMessages, sanitizedSocketEvent, openPresence } from '../ws-presence.mjs';

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  static latest;
  readyState = 0;
  sent = [];
  constructor(url, options) {
    super(); this.url = url; this.options = options; FakeSocket.latest = this;
    queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code) { this.readyState = 3; this.emit('close', code); }
  terminate() { this.readyState = 3; this.emit('close', 1006); }
}

test('WS URL rejects other hosts, paths, duplicate keys, and unsupported queries', () => {
  const url = socketUrl();
  assert.equal(checkedSocketUrl(url).hostname, 'api.geoguessr.com');
  for (const mutate of [
    u => { u.hostname = 'attacker.test'; }, u => { u.pathname = '/other'; },
    u => { u.searchParams.append('c', 'other'); }, u => { u.searchParams.append('token', 'secret'); },
    u => { u.searchParams.set('attempt', '2'); },
  ]) { const candidate = new URL(url); mutate(candidate); assert.throws(() => checkedSocketUrl(candidate), /WS_URL_NOT_ALLOWED/); }
});

test('presence messages contain only source-backed subscriptions and lobby status', () => {
  assert.deepEqual(initialPresenceMessages('test-party', 'test-guest'), [
    { code: 'Subscribe', topic: 'self:test-guest', client: 'web' },
    { code: 'Subscribe', topic: 'partyv2:test-party', client: 'web' },
    { code: 'PartyPlayingStatus', topic: 'partyv2:test-party', payload: '{"isPlaying":false}', client: 'web' },
  ]);
  assert.throws(() => initialPresenceMessages('../path', 'guest'), /WS_INVALID_ID/);
});

test('socket event summary reveals only own membership flags and counts', () => {
  const event = sanitizedSocketEvent({ code: 'PartyMemberListUpdated', payload: JSON.stringify({ members: [
    { userId: 'own-guest', isPresent: true, isBenched: false }, { userId: 'other-private-id', nick: 'private-name' },
  ] }) }, 'own-guest');
  assert.equal(event.guestListed, true);
  assert.equal(event.guestPresent, true);
  assert.equal(event.guestUnbenched, true);
  assert.equal(event.memberCount, 2);
  assert.doesNotMatch(JSON.stringify(event), /own-guest|other-private-id|private-name/);
});

test('one socket connection passes guest Cookie internally, never logs it, and closes intentionally', async () => {
  const events = [];
  const handle = await openPresence({ url: socketUrl(), cookie: '_geoguessr_guest=guest-secret', partyId: 'party', guestId: 'guest', WebSocketImpl: FakeSocket, onEvent: event => events.push(event) });
  assert.equal(FakeSocket.latest.options.headers.Cookie, '_geoguessr_guest=guest-secret');
  assert.equal(FakeSocket.latest.options.followRedirects, false);
  assert.equal(FakeSocket.latest.options.handshakeTimeout, 15000);
  assert.equal(FakeSocket.latest.sent.length, 3);
  handle.setPlaying(true);
  assert.equal(FakeSocket.latest.sent.at(-1).payload, '{"isPlaying":true}');
  await handle.close();
  assert.equal(events.at(-1).type, 'ws_closed');
  assert.doesNotMatch(JSON.stringify(events), /guest-secret/);
});

test('denied subscription stops without reconnecting or exposing server message', async () => {
  const events = [];
  let fatal = null;
  await openPresence({ url: socketUrl(), cookie: '_geoguessr_guest=secret', partyId: 'party', guestId: 'guest', WebSocketImpl: FakeSocket, onEvent: event => events.push(event), onFatal: error => { fatal = error; } });
  FakeSocket.latest.emit('message', Buffer.from(JSON.stringify({ code: 'SubscribeDenied', payload: 'private-server-reason' })), false);
  assert.equal(fatal.code, 'WS_SUBSCRIPTION_DENIED');
  assert.equal(FakeSocket.latest.readyState, FakeSocket.CLOSED);
  assert.doesNotMatch(JSON.stringify(events), /private-server-reason|secret/);
});
