export const NATIVE_HOST = 'com.geoguessr.reserved_seats';
export class NativeSeatError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** Only documented browser error literals become public codes; raw text is never retained. */
export function classifyNativeDisconnect(lastError, { responded = false } = {}) {
  if (responded) return 'NATIVE_DISCONNECTED';
  const message = typeof lastError?.message === 'string' && lastError.message.length <= 512
    ? lastError.message.trim().replace(/\.$/, '').toLowerCase() : '';
  const known = {
    'specified native messaging host not found': 'NATIVE_HOST_NOT_FOUND',
    [`native messaging host ${NATIVE_HOST} is not registered`]: 'NATIVE_HOST_NOT_FOUND',
    'access to the specified native messaging host is forbidden': 'NATIVE_HOST_FORBIDDEN',
    'failed to start native messaging host': 'NATIVE_HOST_START_FAILED',
    'native host has exited': 'NATIVE_HOST_EXITED_BEFORE_READY',
    'error when communicating with the native messaging host': 'NATIVE_PROTOCOL_ERROR',
    'invalid native messaging host name specified': 'NATIVE_HOST_NAME_INVALID',
  };
  return Object.hasOwn(known, message) ? known[message] : 'NATIVE_CONNECT_FAILED';
}

// The browser launches the registered host. Keeping this Port open also keeps
// the service worker alive; the popup does not own the guest connections.
export class NativeSeatClient {
  #runtime;
  #port;
  #pending = new Map();
  #next = 0;
  #lost = false;
  #responded = false;
  #failureCode = null;
  constructor(runtime, { onDisconnect = () => {} } = {}) {
    this.#runtime = runtime;
    this.onDisconnect = onDisconnect;
  }
  #connect() {
    if (this.#port) return;
    if (this.#lost) throw new NativeSeatError(this.#failureCode ?? 'NATIVE_DISCONNECTED');
    if (typeof this.#runtime.connectNative !== 'function') {
      this.#lost = true; this.#failureCode = 'NATIVE_API_UNAVAILABLE';
      throw new NativeSeatError(this.#failureCode);
    }
    try { this.#port = this.#runtime.connectNative(NATIVE_HOST); }
    catch (error) {
      this.#lost = true; this.#failureCode = classifyNativeDisconnect(error);
      throw new NativeSeatError(this.#failureCode);
    }
    this.#responded = false;
    const port = this.#port;
    port.onMessage.addListener(message => {
      if (this.#port !== port) return;
      if (!message || typeof message.requestId !== 'string') return;
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      this.#pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok === true && Object.hasOwn(message, 'result')
        || message.ok === false && typeof message.error === 'string') this.#responded = true;
      if (message.ok === true && Object.hasOwn(message, 'result')) pending.resolve(message.result);
      else pending.reject(new NativeSeatError(typeof message.error === 'string' && /^[A-Z_]{1,64}$/.test(message.error) ? message.error : 'NATIVE_OPERATION_FAILED'));
    });
    port.onDisconnect.addListener(() => {
      // lastError exists only inside this callback. Keep only its safe classification.
      const lastError = this.#runtime.lastError;
      if (this.#port !== port) return;
      const code = classifyNativeDisconnect(lastError, { responded: this.#responded });
      this.#port = undefined;
      this.#lost = true;
      this.#failureCode = code;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new NativeSeatError(code));
      }
      this.#pending.clear();
      this.onDisconnect();
    });
  }
  async request(action, fields = {}) {
    if (!['reserve', 'status', 'handoff', 'remove', 'shutdown'].includes(action)) throw new NativeSeatError('INVALID_ACTION');
    this.#connect();
    const requestId = `request_${++this.#next}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new NativeSeatError('NATIVE_TIMEOUT'));
      }, 35_000);
      this.#pending.set(requestId, { resolve, reject, timer });
      try { this.#port.postMessage({ ...fields, requestId, action }); }
      catch {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(new NativeSeatError('NATIVE_DISCONNECTED'));
      }
    });
  }
  retryConnection() {
    if (this.#pending.size) throw new NativeSeatError('NATIVE_BUSY');
    this.#lost = false;
    this.#failureCode = null;
  }
}
