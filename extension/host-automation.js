export const COMPANION_URL = 'http://127.0.0.1:38477';
export class HostAutomationError extends Error {}

export function validatePairingToken(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value.trim())) {
    throw new HostAutomationError('補助プログラムに表示された64文字の接続キーを貼り付けてください。');
  }
  return value.trim();
}

export function validatePartyCode(value) {
  if (typeof value !== 'string' || !/^[a-z0-9]{5}$/i.test(value.trim())) {
    throw new HostAutomationError('Party画面の5文字の参加コードを入力してください。');
  }
  return value.trim().toUpperCase();
}

// The lobby URL often contains a resource ID rather than the invitation code.
// Never mistake it for a code or read the host's authentication cookies.
export function partyTabInfo(value) {
  let url;
  try { url = new URL(value); } catch { throw new HostAutomationError('主催者のPartyロビーを開いてください。'); }
  const match = /^\/(?:ja\/)?party\/(?:lobby|join)\/([a-z0-9_-]+)\/?$/i.exec(url.pathname);
  if (url.origin !== 'https://www.geoguessr.com' || url.username || url.password || !match) {
    throw new HostAutomationError('主催者のGeoGuessr Partyロビーで開いてください。');
  }
  return { partyCode: /^[a-z0-9]{5}$/i.test(match[1]) ? match[1].toUpperCase() : '', pageUrl: url.origin + url.pathname };
}

export function seatPath(value, handoff = false) {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(value)) {
    throw new HostAutomationError('予備席の情報が不正です。状態を更新してください。');
  }
  return `/seats/${value}${handoff ? '/handoff' : ''}`;
}

export async function companionRequest(token, path, method = 'GET', body, fetchImpl = fetch) {
  const checkedToken = validatePairingToken(token);
  const allowed = (method === 'GET' && path === '/status')
    || (method === 'POST' && (path === '/seats' || /^\/seats\/[a-z0-9_-]{1,80}\/handoff$/i.test(path)))
    || (method === 'DELETE' && /^\/seats\/[a-z0-9_-]{1,80}$/i.test(path));
  if (!allowed) throw new HostAutomationError('未対応の操作です。');
  let response;
  try {
    response = await fetchImpl(COMPANION_URL + path, {
      method, credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { Authorization: `Bearer ${checkedToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new HostAutomationError('補助プログラムに接続できません。起動状態と接続キーを確認してください。作成中に失敗した場合は、状態を更新してから再試行してください。');
  }
  if (!response.ok) {
    const messages = {
      401: '接続キーが一致しません。補助プログラムの現在のキーを貼り付け直してください。',
      403: 'この拡張からの接続が許可されていません。補助プログラムの接続先を確認してください。',
      409: '予備席を作成・引き継ぎできる状態ではありません。Partyの開始前状態と選手枠を確認してください。',
      429: '予備席は最大2名です。また、操作の間隔を空けてください。',
    };
    throw new HostAutomationError(messages[response.status] ?? '補助プログラムの処理に失敗しました。状態を更新して確認してください。');
  }
  try { return await response.json(); } catch { throw new HostAutomationError('補助プログラムの応答を確認できませんでした。'); }
}
