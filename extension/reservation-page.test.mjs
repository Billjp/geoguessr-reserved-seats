import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./reservation-page.js', import.meta.url), 'utf8');
const LOBBY = 'https://www.geoguessr.com/ja/party/lobby/room-resource';

function fixture({ count = 5, incognito = false } = {}) {
  const documentEvents = new Map();
  const windowEvents = new Map();
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  let clock = 0;
  let href = LOBBY;
  let observer;
  let storageReads = 0;
  const accepted = [];
  const prevented = [];

  class FakeElement {
    constructor(tag, classes = [], parent = null) {
      this.tagName = tag.toUpperCase();
      this.classList = classes;
      this.parentElement = parent;
      this.children = [];
      this.style = {};
      this.attributes = {};
      this.disabled = false;
      this.isConnected = false;
      this.textContent = '';
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(element) { element.parentElement = this; element.isConnected = true; this.children.push(element); }
    remove() { this.isConnected = false; }
    matches(selector) {
      if (selector === 'button') return this.tagName === 'BUTTON';
      const match = /^\[class\*="([^"]+)"\]$/.exec(selector);
      return !!match && this.classList.some(name => name.includes(match[1]));
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
      return null;
    }
    querySelector(selector) {
      for (const child of this.children) {
        if (child.matches(selector)) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }
    click() { return click(this); }
  }

  const root = new FakeElement('html');
  root.isConnected = true;
  const wrapper = new FakeElement('div', ['footer_startButton__source'], root);
  const button = new FakeElement('button', ['start-button_button__source'], wrapper);
  const label = new FakeElement('span', ['start-button_startLabel__source'], button);
  label.textContent = 'Start game';
  button.children.push(label);
  const unrelatedButton = new FakeElement('button', ['some-other-button'], root);
  // Even a matching class must be in the official footer and contain its label.
  const decoyButton = new FakeElement('button', ['start-button_button__source'], root);
  const buttons = [unrelatedButton, decoyButton, button];
  const document = {
    documentElement: root,
    createElement: tag => new FakeElement(tag),
    querySelectorAll: selector => selector === 'button' ? buttons : [],
    addEventListener: (type, callback, capture) => {
      assert.equal(capture, true);
      documentEvents.set(type, callback);
    },
  };
  const location = { get href() { return href; }, get pathname() { return new URL(href).pathname; } };
  const context = {
    document, location, Element: FakeElement,
    MutationObserver: class {
      constructor(callback) { observer = this; this.callback = callback; this.disconnected = false; }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    window: { addEventListener: (type, callback) => windowEvents.set(type, callback) },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    chrome: {
      extension: { inIncognitoContext: incognito },
      storage: { local: { get: async key => {
        storageReads++;
        assert.equal(key, 'reservedSeatCount');
        return { reservedSeatCount: count };
      } } },
      runtime: {
        sendMessage: message => new Promise((resolve, reject) => {
          requests.push({ message: JSON.parse(JSON.stringify(message)), resolve, reject, answered: false });
        }),
        onMessage: { addListener() {} },
      },
    },
  };

  function click(target) {
    const event = {
      target, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
    };
    documentEvents.get('click')?.(event);
    if (event.prevented || event.stopped) prevented.push(target);
    else if (!target.disabled) accepted.push({ target, label: label.textContent, href });
    return event;
  }

  const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  vm.runInNewContext(source, context);
  return {
    requests, accepted, prevented, button, unrelatedButton, decoyButton, label,
    get storageReads() { return storageReads; },
    flush,
    clickStart: () => click(button),
    clickUnrelated: () => click(unrelatedButton),
    clickDecoy: () => click(decoyButton),
    async respond(result, { ok = true } = {}) {
      const request = requests.find(item => !item.answered);
      assert.ok(request, 'a pending page observation is required');
      request.answered = true;
      request.resolve(ok ? { ok, result } : { ok, error: 'OBSERVATION_FAILED' });
      await flush();
    },
    async reject() {
      const request = requests.find(item => !item.answered);
      assert.ok(request);
      request.answered = true;
      request.reject(new Error('private-runtime-message'));
      await flush();
    },
    async advance(milliseconds) {
      clock += milliseconds;
      const due = [...timers].filter(([, timer]) => timer.at <= clock);
      for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
      await flush();
    },
    async navigate(url) { href = url; observer?.callback(); await flush(); },
    async mutate() { observer?.callback(); await flush(); },
    hidePage: () => windowEvents.get('pagehide')?.(),
  };
}

function state({ ready = 0, count = 5, partyCode = 'ABCDE', isLeader = true,
  gameState = 'NoGame', enabled = true, reservation = 'creating', error } = {}) {
  return {
    configuredCount: count, enabled, context: { partyCode, isLeader, gameState },
    reservation: { state: reservation },
    seats: Array.from({ length: ready }, (_, index) => ({
      seatId: `seat-${index}`, partyCode, state: 'holding', selection: 'candidate',
    })),
    ...(error ? { error } : {}),
  };
}

test('saved arbitrary five seats holds an early click and starts exactly once after all seats are ready', async () => {
  const page = fixture();
  await page.flush(); // Preferences loaded; metadata request is still pending.
  assert.equal(page.requests.length, 1);
  assert.equal(page.clickStart().prevented, true);
  assert.equal(page.accepted.length, 0);
  await page.respond(state({ ready: 2 }));
  assert.equal(page.accepted.length, 0);
  await page.advance(2000);
  await page.respond(state({ ready: 5, reservation: 'holding' }));
  assert.equal(page.accepted.length, 1);
  assert.equal(page.accepted[0].target, page.button);
  assert.equal(page.accepted[0].href, LOBBY);
  await page.mutate();
  await page.advance(10000);
  await page.respond(state({ ready: 5, reservation: 'holding' }));
  assert.equal(page.accepted.length, 1);
  for (const request of page.requests) assert.deepEqual(request.message, { action: 'partyObserved' });
});

test('a ready result never starts a game without an earlier user click', async () => {
  const page = fixture();
  await page.flush();
  await page.respond(state({ ready: 5, reservation: 'holding' }));
  await page.mutate();
  assert.equal(page.accepted.length, 0);
  assert.equal(page.clickStart().prevented, false);
  assert.equal(page.accepted.length, 1);
});

test('halted or unknown context cancels the queued start, including a later recovered ready result', async () => {
  for (const failed of [
    state({ reservation: 'halted', error: 'CAPACITY_EXCEEDED' }),
    { enabled: true, configuredCount: 5, error: 'PARTY_CONTEXT_UNAVAILABLE', seats: [] },
  ]) {
    const page = fixture();
    await page.flush();
    assert.equal(page.clickStart().prevented, true);
    await page.respond(failed);
    assert.equal(page.clickStart().prevented, true);
    await page.advance(10000);
    await page.respond(state({ ready: 5, reservation: 'holding' }));
    assert.equal(page.accepted.length, 0);
  }
});

test('observation rejection or failure cannot later release the original stale click', async () => {
  for (const rejection of [true, false]) {
    const page = fixture();
    await page.flush();
    page.clickStart();
    if (rejection) await page.reject();
    else await page.respond(undefined, { ok: false });
    await page.advance(10000);
    await page.respond(state({ ready: 5, reservation: 'holding' }));
    assert.equal(page.accepted.length, 0);
  }
});

test('a nonleader result releases an initially held normal action', async () => {
  const page = fixture();
  await page.flush();
  assert.equal(page.clickStart().prevented, true);
  await page.respond(state({ enabled: false, isLeader: false }));
  assert.equal(page.accepted.length, 1);
  assert.equal(page.clickStart().prevented, false);
  assert.equal(page.accepted.length, 2);
});

test('ongoing game metadata releases the held rejoin click and never blocks further rejoin clicks', async () => {
  const page = fixture();
  await page.flush();
  page.label.textContent = 'Rejoin game';
  assert.equal(page.clickStart().prevented, true);
  await page.respond(state({ gameState: 'Ongoing', reservation: 'holding' }));
  assert.equal(page.accepted.length, 1);
  assert.equal(page.accepted[0].label, 'Rejoin game');
  assert.equal(page.clickStart().prevented, false);
  assert.equal(page.accepted.length, 2);
});

test('SPA navigation cancels the original Party click even when its delayed ready response arrives', async () => {
  const page = fixture();
  await page.flush();
  page.clickStart();
  await page.navigate('https://www.geoguessr.com/party/lobby/new-room');
  await page.respond(state({ ready: 5, reservation: 'holding' }));
  await page.mutate();
  assert.equal(page.accepted.length, 0);
  await page.advance(10000);
  await page.respond(state({ ready: 5, partyCode: 'FGHIJ', reservation: 'holding' }));
  assert.equal(page.accepted.length, 0);
});

test('zero seats, unrelated controls and a matching class outside the official footer remain untouched', async () => {
  const disabled = fixture({ count: 0 });
  await disabled.flush();
  assert.equal(disabled.clickStart().prevented, false);
  const page = fixture();
  await page.flush();
  assert.equal(page.clickUnrelated().prevented, false);
  assert.equal(page.clickDecoy().prevented, false);
  assert.equal(page.prevented.length, 0);
});

test('incognito recipient pages do not read host settings or send Party observations', async () => {
  const page = fixture({ incognito: true });
  await page.flush();
  assert.equal(page.storageReads, 0);
  assert.equal(page.requests.length, 0);
  assert.equal(page.clickStart().prevented, false);
});
