import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

// Current site config and modules 44868, 508566, and 675604 (2026-10-04).
export const SOCKET_ORIGIN = 'wss://api.geoguessr.com';
export class PresenceError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}

function checkedId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new PresenceError('WS_INVALID_ID');
  return value;
}

export function socketUrl() {
  const url = new URL(`${SOCKET_ORIGIN}/ws`);
  url.searchParams.set('c', 'web-1.8153-c1d0cd0');
  url.searchParams.set('tabId', randomUUID());
  url.searchParams.set('attempt', '1');
  url.searchParams.set('visibility', 'visible');
  return url;
}

export function checkedSocketUrl(input) {
  const url = new URL(input);
  if (url.origin !== SOCKET_ORIGIN || url.pathname !== '/ws' || url.hash || url.username || url.password) throw new PresenceError('WS_URL_NOT_ALLOWED');
  if ([...url.searchParams.keys()].length !== 4 || [...url.searchParams.keys()].some(key => !['c', 'tabId', 'attempt', 'visibility'].includes(key))) throw new PresenceError('WS_URL_NOT_ALLOWED');
  if (url.searchParams.get('c') !== 'web-1.8153-c1d0cd0' || url.searchParams.get('attempt') !== '1'
    || url.searchParams.get('visibility') !== 'visible' || !/^[a-f0-9-]{36}$/.test(url.searchParams.get('tabId') ?? '')) throw new PresenceError('WS_URL_NOT_ALLOWED');
  return url;
}

export function initialPresenceMessages(partyId, guestId) {
  checkedId(partyId); checkedId(guestId);
  return [
    { code: 'Subscribe', topic: `self:${guestId}`, client: 'web' },
    { code: 'Subscribe', topic: `partyv2:${partyId}`, client: 'web' },
    { code: 'PartyPlayingStatus', topic: `partyv2:${partyId}`, payload: JSON.stringify({ isPlaying: false }), client: 'web' },
  ];
}

export function sanitizedSocketEvent(message, guestId) {
  const known = ['SubscribeDenied', 'PartyMemberListUpdated', 'PartyUpdated', 'PartyGameStarted', 'PartyDisbanded', 'ConnectionOpened', 'ConnectionReady'];
  const result = { type: 'ws_message', code: known.includes(message?.code) ? message.code : 'other' };
  let payload;
  try { payload = typeof message?.payload === 'string' ? JSON.parse(message.payload) : message?.payload; } catch { return result; }
  if (Array.isArray(payload?.members)) {
    result.memberCount = payload.members.length;
    const own = payload.members.find(member => member?.userId === guestId);
    result.guestListed = Boolean(own);
    result.guestPresent = typeof own?.isPresent === 'boolean' ? own.isPresent : null;
    result.guestRawIsBenched = typeof own?.isBenched === 'boolean' ? own.isBenched : null;
    result.guestUnbenched = typeof own?.isBenched === 'boolean' ? !own.isBenched : null;
  }
  if (Array.isArray(payload?.players)) result.guestSelectedForGame = payload.players.includes(guestId);
  return result;
}

/** No reconnects, redirects, registration cookie, authentication files, or chat. */
export async function openPresence({ url, cookie, partyId, guestId, onEvent = () => {}, onFatal = () => {}, onServerCookies = () => {}, WebSocketImpl = WebSocket }) {
  checkedSocketUrl(url);
  checkedId(partyId); checkedId(guestId);
  if (!/^_geoguessr_guest=[^\s;,\r\n]+$/.test(cookie ?? '')) throw new PresenceError('WS_GUEST_COOKIE_REQUIRED');
  return new Promise((resolve, reject) => {
    let opened = false;
    let intentionalClose = false;
    let failed = false;
    let heartbeat;
    const ws = new WebSocketImpl(url, {
      headers: { Cookie: cookie }, origin: 'https://www.geoguessr.com',
      followRedirects: false, handshakeTimeout: 15000, closeTimeout: 1500,
      perMessageDeflate: false, maxPayload: 256 * 1024,
    });
    const fail = (code, status = null) => {
      if (failed || intentionalClose) return;
      failed = true;
      clearInterval(heartbeat);
      const error = new PresenceError(code, status);
      onEvent({ type: 'ws_stopped', reason: code, status });
      if (!opened) reject(error);
      else onFatal(error);
      ws.terminate();
    };
    ws.on('unexpected-response', (request, response) => {
      response.resume();
      request.destroy();
      fail(response.statusCode === 403 ? 'WS_VERIFICATION_OR_DENIAL_STOPPED' : 'WS_HANDSHAKE_STOPPED', response.statusCode);
    });
    ws.on('upgrade', response => {
      try { onServerCookies(response.headers['set-cookie']); } catch { fail('WS_UNEXPECTED_AUTH_COOKIE'); }
    });
    ws.on('error', () => fail('WS_NETWORK_FAILURE_STOPPED'));
    ws.on('close', code => {
      clearInterval(heartbeat);
      if (!intentionalClose && !failed) fail('WS_CLOSED_STOPPED', code);
      else if (intentionalClose) onEvent({ type: 'ws_closed', code });
    });
    ws.on('message', (data, isBinary) => {
      if (failed || intentionalClose) return;
      if (isBinary) return fail('WS_BINARY_MESSAGE_STOPPED');
      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { return fail('WS_INVALID_JSON_STOPPED'); }
      onEvent(sanitizedSocketEvent(message, guestId));
      if (message?.code === 'SubscribeDenied') fail('WS_SUBSCRIPTION_DENIED');
    });
    ws.on('open', () => {
      if (failed) return;
      opened = true;
      for (const message of initialPresenceMessages(partyId, guestId)) ws.send(JSON.stringify(message));
      heartbeat = setInterval(() => {
        if (!failed && !intentionalClose && ws.readyState === WebSocketImpl.OPEN) ws.send(JSON.stringify({ code: 'HeartBeat' }));
      }, 15000);
      heartbeat.unref?.();
      onEvent({ type: 'ws_open', subscribedSelf: true, subscribedParty: true, credentialsPersisted: false });
      resolve({
        setPlaying(isPlaying) {
          if (typeof isPlaying !== 'boolean' || failed || intentionalClose || ws.readyState !== WebSocketImpl.OPEN) throw new PresenceError('WS_NOT_OPEN');
          ws.send(JSON.stringify({ code: 'PartyPlayingStatus', topic: `partyv2:${partyId}`, payload: JSON.stringify({ isPlaying }), client: 'web' }));
        },
        async close() {
          intentionalClose = true;
          clearInterval(heartbeat);
          if (ws.readyState === WebSocketImpl.CLOSED) return;
          await new Promise(done => {
            const timer = setTimeout(() => { ws.terminate(); done(); }, 1600);
            ws.once('close', () => { clearTimeout(timer); done(); });
            ws.close(4000);
          });
        },
      });
    });
  });
}
