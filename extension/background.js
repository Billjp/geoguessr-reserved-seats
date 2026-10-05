import { buildCapsule, validateCapsule, cookieSetDetails, summarizeCapsule } from './handoff.js';
import { HostAutomationError, partyTabInfo, seatPath } from './host-automation.js';
import { NativeSeatClient, NativeSeatError } from './native-client.js';
import { readActivePartyContext } from './party-context.js';

const ORIGIN = 'https://www.geoguessr.com';
const GUEST_COOKIE = '_geoguessr_guest';

class DisplayError extends Error {}
const native = new NativeSeatClient(chrome.runtime);
const tabContexts = new Map();
const inspections = new Map();
let automaticError = null;
let ownerTabId = null;

function nativeErrorMessage(error) {
  const messages = {
    NATIVE_SETUP_REQUIRED: '補助プログラムへの接続を確認できませんでした。セットアップと起動状態を確認してください。',
    NATIVE_HOST_NOT_FOUND: '補助プログラムの登録が見つかりません。setup-native-host.ps1を実行し、拡張を再読み込みしてください。',
    NATIVE_HOST_FORBIDDEN: '補助プログラムへの接続が拒否されました。拡張IDとホストの許可設定を確認してください。',
    NATIVE_HOST_START_FAILED: 'ブラウザーが補助プログラムを起動できませんでした。Node.jsと起動ファイルの実行可否を確認してください。',
    NATIVE_HOST_EXITED_BEFORE_READY: '補助プログラムが最初の応答前に終了しました。Node.jsと起動ファイルを確認してください。',
    NATIVE_PROTOCOL_ERROR: '補助プログラムとの通信形式を確認できませんでした。拡張と補助プログラムの版を確認してください。',
    NATIVE_HOST_NAME_INVALID: '補助プログラムの連携名が不正です。拡張を再読み込みしてください。',
    NATIVE_CONNECT_FAILED: '補助プログラムから初回の応答を受け取れませんでした。セットアップと起動状態を確認してください。',
    NATIVE_API_UNAVAILABLE: 'この拡張で補助プログラムとの連携を利用できません。拡張の権限と再読み込みを確認してください。',
    NATIVE_DISCONNECTED: '補助プログラムとの接続が切れました。設定を保存し直して状態を確認してください。',
    NATIVE_TIMEOUT: '処理の応答を確認できませんでした。状態を更新してください。',
    CAPACITY_UNKNOWN: 'Partyの定員を確認できませんでした。',
    CAPACITY_EXCEEDED: '現在のPartyの空き枠では、設定した予約席を確保できません。',
    PARTY_CAPACITY_EXCEEDED: '現在のPartyの空き枠では、設定した予約席を確保できません。',
    INSUFFICIENT_CAPACITY: '現在のPartyの空き枠では、設定した予約席を確保できません。',
    NOT_PARTY_LEADER: 'Partyの主催者だけが予約席を作成できます。',
    PARTY_LEADER_REQUIRED: 'Partyの主催者だけが予約席を作成できます。',
    HOST_CONTEXT_REQUIRED: '主催者のPartyロビーを開いてください。',
    HOST_CONTEXT_STALE: 'Partyの状態が変わりました。ロビーで状態を更新してください。',
    HOST_CONTEXT_EXPIRED: 'Partyの状態が変わりました。ロビーで状態を更新してください。',
    PARTY_ALREADY_PLAYING: '試合開始後には予約席を追加できません。',
    GUESTS_NOT_ALLOWED: 'このPartyはゲストの参加が許可されていません。',
    HANDOFF_EXPIRED: '引き継ぎデータの読み込み期限が切れています。',
  };
  return messages[error?.code] ?? '予約席の処理を停止しました。ロビーと設定を確認してください。';
}

async function configuredCount() {
  const saved = await chrome.storage.local.get('reservedSeatCount');
  return Number.isInteger(saved.reservedSeatCount) && saved.reservedSeatCount >= 0 && saved.reservedSeatCount <= 100 ? saved.reservedSeatCount : 0;
}

async function hostContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) throw new DisplayError('主催者のPartyロビーを開いてください。');
  return partyTabInfo(tab.url);
}

async function readHostTab(tabId, { fresh = false } = {}) {
  if (!fresh) {
    const cached = tabContexts.get(tabId);
    if (cached && Date.now() - cached.observedAt < 10_000) return cached;
  }
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: readActivePartyContext });
  const context = results[0]?.result;
  if (context?.error === 'UNSUPPORTED_GAME_TYPE') return { unsupported: true };
  if (!context || context.error || typeof context.partyCode !== 'string' || typeof context.isLeader !== 'boolean') return null;
  tabContexts.set(tabId, context);
  return context;
}

async function observeParty(tabId, { fresh = false } = {}) {
  if (inspections.has(tabId)) return inspections.get(tabId);
  const pending = (async () => {
    const count = await configuredCount();
    if (!count) {
      if (ownerTabId === tabId) {
        const result = await native.request('status');
        return { ...result, configuredCount: 0, enabled: result.reservation?.state === 'clearing', context: tabContexts.get(tabId) };
      }
      return { configuredCount: 0, enabled: false };
    }
    let context;
    try { context = await readHostTab(tabId, { fresh }); } catch { context = null; }
    if (context?.unsupported) return { configuredCount: count, enabled: false };
    if (!context) return { configuredCount: count, enabled: true, error: '主催者とPartyの状態を確認できませんでした。予約席の準備を停止しています。', seats: [] };
    if (!context.isLeader) return { configuredCount: count, enabled: false, context };
    ownerTabId = tabId;
    let result;
    try {
      result = context.gameState === 'NoGame'
        ? await native.request('reserve', { partyCode: context.partyCode, count, hostContext: context })
        : await native.request('status');
      automaticError = null;
    } catch (error) {
      automaticError = nativeErrorMessage(error);
      return { configuredCount: count, enabled: true, context, error: automaticError, seats: [] };
    }
    return { ...result, configuredCount: count, enabled: true, context };
  })().finally(() => inspections.delete(tabId));
  inspections.set(tabId, pending);
  return pending;
}

async function automaticStatus() {
  const count = await configuredCount();
  if (!count && ownerTabId === null) return { configuredCount: 0, enabled: false, seats: [] };
  const result = await native.request('status');
  return { ...result, configuredCount: count, ...(automaticError ? { error: automaticError } : {}) };
}

async function applyReservations(message) {
  const count = message.count;
  if (!Number.isInteger(count) || count < 0 || count > 100) throw new DisplayError('予約席数を0〜100の整数で入力してください。実際の上限はPartyの空き枠です。');
  native.retryConnection();
  automaticError = null;
  await chrome.storage.local.set({ reservedSeatCount: count });
  if (!count) {
    if (ownerTabId !== null) {
      const context = tabContexts.get(ownerTabId);
      if (context) await native.request('reserve', { partyCode: context.partyCode, count: 0 });
    }
    return { configuredCount: 0, enabled: false, seats: [] };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { partyTabInfo(tab?.url); } catch { return { configuredCount: count, enabled: false, seats: [], message: '設定を保存しました。主催者のPartyロビーを開くと自動で確保します。' }; }
  return observeParty(tab.id, { fresh: true });
}

async function saveReservations(message) {
  const result = await applyReservations(message);
  if (chrome.tabs.sendMessage) {
    const tabs = await chrome.tabs.query({ url: 'https://www.geoguessr.com/*' });
    await Promise.allSettled(tabs.filter(tab => !tab.incognito).map(tab => chrome.tabs.sendMessage(tab.id, { action: 'reservationSettingsChanged' })));
  }
  return result;
}

async function hostHandoff(message) {
  seatPath(message.seatId);
  const result = await native.request('handoff', { seatId: message.seatId });
  const capsule = validateCapsule(result.capsule);
  return { capsule: JSON.stringify(capsule), summary: summarizeCapsule(capsule) };
}

async function activeContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new DisplayError('GeoGuessrのタブを開いてください。');
  const url = new URL(tab.url);
  if (url.origin !== ORIGIN) throw new DisplayError('GeoGuessrの公式ページで開いてください。');
  const stores = await chrome.cookies.getAllCookieStores();
  const store = stores.find(item => item.tabIds.includes(tab.id));
  if (!store) throw new DisplayError('このタブのログイン保存領域を特定できません。');
  const cookies = await chrome.cookies.getAll({ domain: 'geoguessr.com', storeId: store.id });
  // Regular account credentials are neither exported nor modified.
  if (cookies.some(cookie => cookie.name === '_ncfa')) {
    throw new DisplayError('通常アカウントでログイン中です。空の専用プロファイルかシークレットを使ってください。');
  }
  return { tab, storeId: store.id, cookies };
}

async function guestIdentity(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const response = await fetch('/api/v4/guest-users/me', {
        credentials: 'include', cache: 'no-store', redirect: 'error'
      });
      if (!response.ok) return { status: response.status };
      const guest = await response.json();
      return { status: response.status, guest: { id: guest.id, nick: guest.nick } };
    }
  });
  const result = results[0]?.result;
  if (!result?.guest?.id || typeof result.guest.id !== 'string') {
    const status = Number.isInteger(result?.status) ? result.status : '接続エラー';
    throw new DisplayError(`ゲスト本人確認に失敗しました（${status}）。`);
  }
  return result.guest;
}

async function inspect() {
  const context = await activeContext();
  const guestCookies = context.cookies.filter(cookie => cookie.name === GUEST_COOKIE);
  if (guestCookies.length !== 1) {
    return { empty: guestCookies.length === 0, ready: false, message: '引き継ぐゲストがまだいません。' };
  }
  const guest = await guestIdentity(context.tab.id);
  return { ready: true, empty: false, guest, pageUrl: context.tab.url, incognito: !!context.tab.incognito };
}

async function exportGuest() {
  const context = await activeContext();
  const cookies = context.cookies.filter(cookie => cookie.name === GUEST_COOKIE);
  if (cookies.length !== 1) throw new DisplayError('引き継ぐゲストを1名だけ用意してください。');
  const guest = await guestIdentity(context.tab.id);
  const url = new URL(context.tab.url);
  url.search = '';
  url.hash = '';
  const capsule = buildCapsule({ guest, cookie: cookies[0], pageUrl: url.href });
  return { capsule: JSON.stringify(capsule), summary: summarizeCapsule(capsule) };
}

async function importGuest(text) {
  const capsule = validateCapsule(text);
  const context = await activeContext();
  if (context.cookies.some(cookie => cookie.name === GUEST_COOKIE)) {
    throw new DisplayError('受取側にはすでにゲストがいます。空の専用プロファイルを使ってください。');
  }
  const added = await chrome.cookies.set(cookieSetDetails(capsule, context.storeId));
  if (!added) throw new DisplayError('ゲストのログイン状態を設定できませんでした。');
  try {
    const guest = await guestIdentity(context.tab.id);
    if (guest.id !== capsule.guest.id) throw new DisplayError('元のゲストとIDが一致しません。引き継ぎは失敗しました。');
    // Revalidate expiry after the network round trip before continuing.
    validateCapsule(capsule);
    await chrome.tabs.update(context.tab.id, { url: capsule.pageUrl });
    return {
      verified: true, guest, pageUrl: capsule.pageUrl,
      message: '同じゲストIDで本人確認できました。公式ゲーム画面で再参加と回答を確認してください。'
    };
  } catch (error) {
    try {
      const removed = await chrome.cookies.remove({ url: ORIGIN + '/', name: GUEST_COOKIE, storeId: context.storeId });
      if (!removed) throw new Error('rollback failed');
    } catch {
      throw new DisplayError('引き継ぎに失敗し、ゲスト情報の削除も確認できませんでした。このプロファイルを閉じ、別の空の専用プロファイルを使ってください。');
    }
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'partyObserved' && sender.id === chrome.runtime.id && sender.tab?.id && !sender.tab.incognito) {
    try { partyTabInfo(sender.url); } catch { return false; }
    observeParty(sender.tab.id).then(
      result => sendResponse({ ok: true, result }),
      () => sendResponse({ ok: true, result: { configuredCount: null, enabled: true, seats: [], error: 'Partyの状態を確認できませんでした。' } })
    );
    return true;
  }
  // Only the extension popup may request credential-bearing operations.
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  const actions = {
    inspect, export: exportGuest, import: () => importGuest(message.capsule),
    hostContext,
    reservationSettings: async () => ({ configuredCount: await configuredCount() }),
    saveReservations: () => saveReservations(message),
    hostStatus: automaticStatus,
    hostHandoff: () => hostHandoff(message),
    hostStop: async () => { seatPath(message.seatId); return native.request('remove', { seatId: message.seatId }); },
  };
  if (!Object.hasOwn(actions, message?.action)) return false;
  const action = actions[message?.action];
  if (!action) return false;
  Promise.resolve().then(action).then(
    result => sendResponse({ ok: true, result }),
    error => sendResponse({ ok: false, error: error instanceof NativeSeatError ? nativeErrorMessage(error) : error instanceof DisplayError || error instanceof HostAutomationError ? error.message : '処理に失敗しました。ページと引き継ぎデータを確認してください。' })
  );
  return true;
});

chrome.tabs.onRemoved?.addListener(tabId => { tabContexts.delete(tabId); });
