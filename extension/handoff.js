// Transfer diagnostics for a disposable, already-joined official guest only.
// This module never persists or logs the guest credential.
const FORMAT = "geoguessr-reserved-seat-v1";
const TTL_MS = 10 * 60 * 1000;
const COOKIE_NAME = "_geoguessr_guest";
const COOKIE_DOMAINS = new Set([
  "geoguessr.com",
  ".geoguessr.com",
  "www.geoguessr.com",
]);
const SAME_SITES = new Set(["unspecified", "no_restriction", "lax", "strict"]);
const COOKIE_KEYS = [
  "name", "value", "domain", "path", "secure", "httpOnly", "sameSite",
  "expirationDate",
];
const COOKIE_VALUE_PATTERN = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/;

function fail(message) {
  // Never interpolate a rejected value: it may contain the credential.
  throw new Error(message);
}

function clock(now) {
  if (!Number.isSafeInteger(now) || now < 0) {
    fail("検証時刻が不正です。");
  }
  return now;
}

function record(value, permittedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label}の形式が不正です。`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label}の形式が不正です。`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !permittedKeys.includes(key)) {
      fail(`${label}に許可されていない項目があります。`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      fail(`${label}の形式が不正です。`);
    }
  }
  return value;
}

function guestDetails(value) {
  const guest = record(value, ["id", "nick"], "ゲスト情報");
  if (typeof guest.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(guest.id)) {
    fail("ゲストIDが不正です。");
  }
  if (typeof guest.nick !== "string" || guest.nick.length > 100 ||
      !guest.nick.trim() || CONTROLS.test(guest.nick)) {
    fail("ゲスト名が不正です。");
  }
  return { id: guest.id, nick: guest.nick };
}

function canonicalPageUrl(value) {
  if (typeof value !== "string" || value.length > 2048 ||
      CONTROLS.test(value) || /[?#]/.test(value)) {
    fail("移動先はクエリを含まない公式PartyまたはDuel URLにしてください。");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("移動先URLが不正です。");
  }
  if (url.protocol !== "https:" || url.hostname !== "www.geoguessr.com" ||
      url.port || url.username || url.password || url.search || url.hash ||
      url.href !== value ||
      !/^\/(?:ja\/)?(?:party\/(?:lobby|join)|duels|team-duels)\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) {
    fail("移動先は公式Party参加・ロビーまたはDuelのURLにしてください。");
  }
  // GeoGuessr may redirect Japanese browsers to /ja/... . Normalize only this
  // observed official locale prefix; arbitrary leading path segments stay invalid.
  return url.origin + url.pathname.replace(/^\/ja\//, "/");
}

function cookieDetails(value, now) {
  const cookie = record(value, COOKIE_KEYS, "Cookie情報");
  if (cookie.name !== COOKIE_NAME) {
    fail("転送できるのは使い捨てゲストのCookieだけです。");
  }
  if (typeof cookie.value !== "string" || !cookie.value ||
      cookie.value.length > 16384 || !COOKIE_VALUE_PATTERN.test(cookie.value)) {
    fail("ゲストCookieの形式が不正です。");
  }
  if (!COOKIE_DOMAINS.has(cookie.domain) || cookie.path !== "/" ||
      cookie.secure !== true || typeof cookie.httpOnly !== "boolean" ||
      !SAME_SITES.has(cookie.sameSite)) {
    fail("ゲストCookieのドメインまたは属性が不正です。");
  }
  const result = {
    name: COOKIE_NAME,
    value: cookie.value,
    domain: cookie.domain,
    path: "/",
    secure: true,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  };
  if (Object.hasOwn(cookie, "expirationDate")) {
    if (typeof cookie.expirationDate !== "number" ||
        !Number.isFinite(cookie.expirationDate) || cookie.expirationDate <= now / 1000 ||
        !Number.isSafeInteger(Math.floor(cookie.expirationDate * 1000))) {
      fail("ゲストCookieが期限切れ、または期限の形式が不正です。");
    }
    result.expirationDate = cookie.expirationDate;
  }
  return result;
}

/** Build a short-lived capsule from an official guest response and chrome cookie. */
export function buildCapsule({ guest, cookie, pageUrl, now = Date.now() }) {
  clock(now);
  if (!guest || !cookie) fail("ゲスト情報とゲストCookieが必要です。");
  // chrome.cookies.Cookie has storeId/session/hostOnly fields. They cannot be
  // imported or forwarded; only the agreed credential attributes are selected.
  const selectedCookie = {};
  for (const key of COOKIE_KEYS) {
    if (Object.hasOwn(cookie, key)) selectedCookie[key] = cookie[key];
  }
  const checkedCookie = cookieDetails(selectedCookie, now);
  const expiresAt = Math.min(
    now + TTL_MS,
    checkedCookie.expirationDate === undefined
      ? now + TTL_MS
      : Math.floor(checkedCookie.expirationDate * 1000),
  );
  return validateCapsule({
    format: FORMAT,
    exportedAt: now,
    expiresAt,
    guest: { id: guest.id, nick: guest.nick },
    cookie: checkedCookie,
    pageUrl,
  }, { now });
}

/** Validate untrusted JSON without including any submitted value in errors. */
export function validateCapsule(value, { now = Date.now() } = {}) {
  clock(now);
  let parsed = value;
  if (typeof parsed === "string") {
    if (!parsed || parsed.length > 24576) fail("引き継ぎデータのサイズが不正です。");
    try {
      parsed = JSON.parse(parsed);
    } catch {
      fail("引き継ぎデータは正しいJSONにしてください。");
    }
  }
  const capsule = record(parsed, [
    "format", "exportedAt", "expiresAt", "guest", "cookie", "pageUrl",
  ], "引き継ぎデータ");
  if (capsule.format !== FORMAT) fail("対応していない引き継ぎデータです。");
  if (!Number.isSafeInteger(capsule.exportedAt) || capsule.exportedAt < 0 ||
      !Number.isSafeInteger(capsule.expiresAt) ||
      capsule.exportedAt > now || capsule.expiresAt <= capsule.exportedAt ||
      capsule.expiresAt - capsule.exportedAt > TTL_MS) {
    fail("引き継ぎデータの有効期限が不正です。");
  }
  if (capsule.expiresAt <= now) fail("引き継ぎデータは期限切れです。再度作成してください。");
  const checkedCookie = cookieDetails(capsule.cookie, now);
  if (checkedCookie.expirationDate !== undefined &&
      capsule.expiresAt > Math.floor(checkedCookie.expirationDate * 1000)) {
    fail("引き継ぎデータの期限がゲストCookieの期限を超えています。");
  }
  return {
    format: FORMAT,
    exportedAt: capsule.exportedAt,
    expiresAt: capsule.expiresAt,
    guest: guestDetails(capsule.guest),
    cookie: checkedCookie,
    pageUrl: canonicalPageUrl(capsule.pageUrl),
  };
}

/** Cookie arguments only; the caller must first check the selected store is empty. */
export function cookieSetDetails(capsule, storeId) {
  const checked = validateCapsule(capsule);
  if (typeof storeId !== "string" || !storeId || storeId.length > 128 ||
      CONTROLS.test(storeId)) {
    fail("転送先のCookieストアを指定してください。");
  }
  const { domain, ...attributes } = checked.cookie;
  return {
    url: "https://www.geoguessr.com/",
    ...attributes,
    // A Chrome host-only cookie has no leading dot. Supplying domain to set()
    // would convert www.geoguessr.com into a broader domain cookie. Omitting it
    // preserves the original host-only scope through the fixed URL above.
    ...(domain === "www.geoguessr.com" ? {} : { domain }),
    storeId,
  };
}

/** A review/log-safe summary; the credential value is deliberately omitted. */
export function summarizeCapsule(capsule) {
  const checked = validateCapsule(capsule);
  const { value: ignoredCredential, ...metadata } = checked.cookie;
  return {
    format: checked.format,
    exportedAt: checked.exportedAt,
    expiresAt: checked.expiresAt,
    guest: { ...checked.guest },
    pageUrl: checked.pageUrl,
    cookie: metadata,
  };
}
