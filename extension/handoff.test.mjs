import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The standalone diagnostic can be tested without changing Daily Bot's package
// configuration or requiring extension/package.json to exist yet.
const source = await readFile(new URL("./handoff.js", import.meta.url), "utf8");
const { buildCapsule, validateCapsule, cookieSetDetails, summarizeCapsule } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const secret = "disposable-guest-secret.ABCD_1234=";
const now = Date.now();
const sourceGuest = { id: "guest_123", nick: "待機ゲスト 🎮", deviceToken: "excluded" };
const sourceCookie = {
  name: "_geoguessr_guest", value: secret, domain: ".geoguessr.com", path: "/",
  secure: true, httpOnly: true, sameSite: "lax", storeId: "0", session: true,
  hostOnly: false,
};
const pageUrl = "https://www.geoguessr.com/team-duels/duel-123";
const capsule = () => buildCapsule({ guest: sourceGuest, cookie: sourceCookie, pageUrl, now });
const changed = (changes) => Object.assign(capsule(), changes);

function rejectsSafely(value, pattern) {
  assert.throws(() => validateCapsule(value, { now }), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(secret));
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("build selects disposable guest fields and limits capsule to ten minutes", () => {
  const built = capsule();
  assert.equal(built.format, "geoguessr-reserved-seat-v1");
  assert.equal(built.expiresAt - built.exportedAt, 600000);
  assert.deepEqual(built.guest, { id: sourceGuest.id, nick: sourceGuest.nick });
  assert.equal(built.cookie.value, secret);
  assert.ok(!Object.hasOwn(built.cookie, "storeId"));
  assert.ok(!Object.hasOwn(built.cookie, "session"));
  assert.deepEqual(validateCapsule(JSON.stringify(built), { now }), built);
});

test("source cookie expiry shortens transfer window", () => {
  const expirationDate = (now + 30000) / 1000;
  const built = buildCapsule({
    guest: sourceGuest, cookie: { ...sourceCookie, expirationDate }, pageUrl, now,
  });
  assert.equal(built.expiresAt, Math.floor(expirationDate * 1000));
});

test("only fixed guest cookie name, safe cookie attributes and domains pass", () => {
  const invalid = [
    { name: "_ncfa" }, { name: "_geoguessr_guest_other" },
    { value: 42 }, { value: "" }, { value: secret + "\n" },
    { value: "contains;cookie" }, { value: "contains space" },
    { value: "x".repeat(16385) },
    { domain: "evil.test" }, { domain: ".geoguessr.com.evil.test" },
    { domain: ".www.geoguessr.com" }, { domain: "GEOGUESSR.COM" },
    { domain: 42 }, { path: "/duels" }, { secure: false },
    { httpOnly: "true" }, { sameSite: "none" },
    { expirationDate: "12345" }, { expirationDate: NaN },
    { expirationDate: Infinity }, { expirationDate: now / 1000 },
    { expirationDate: Number.MAX_VALUE }, { _ncfa: secret },
  ];
  for (const change of invalid) {
    const built = capsule();
    Object.assign(built.cookie, change);
    rejectsSafely(built);
  }
  for (const domain of ["geoguessr.com", ".geoguessr.com", "www.geoguessr.com"]) {
    const built = capsule();
    built.cookie.domain = domain;
    assert.equal(validateCapsule(built, { now }).cookie.domain, domain);
  }
});

test("only canonical official Party and Duel URLs pass", () => {
  for (const valid of [
    "https://www.geoguessr.com/party/lobby/ABcd1234",
    "https://www.geoguessr.com/party/join/ABcd1234",
    "https://www.geoguessr.com/duels/uuid-123",
    pageUrl,
  ]) {
    assert.equal(validateCapsule(changed({ pageUrl: valid }), { now }).pageUrl, valid);
  }
  for (const invalid of [
    "https://evil.test/duels/123",
    "https://www.geoguessr.com.evil.test/duels/123",
    "https://www.geoguessr.com@evil.test/duels/123",
    "https://user@www.geoguessr.com/duels/123",
    "http://www.geoguessr.com/duels/123",
    "https://geoguessr.com/duels/123",
    "https://www.geoguessr.com:443/duels/123",
    "https://www.geoguessr.com:444/duels/123",
    "https://www.geoguessr.com/duels/123?token=" + secret,
    "https://www.geoguessr.com/duels/123?",
    "https://www.geoguessr.com/duels/123#" + secret,
    "https://www.geoguessr.com/duels/123#",
    "https://www.geoguessr.com/duels/123/spectate",
    "https://www.geoguessr.com/duels/123/",
    "https://www.geoguessr.com/duels/%31%32%33",
    "https://www.geoguessr.com/duels/other/../123",
    "https://www.geoguessr.com/party/lobby/123/evil",
    "https://www.geoguessr.com/jp/party/lobby/123",
    "https://www.geoguessr.com/JA/party/lobby/123",
    "https://www.geoguessr.com/ja/ja/duels/123",
    "https://www.geoguessr.com/ja//duels/123",
    "https://www.geoguessr.com/ja/duels/123/spectate",
    "https://www.geoguessr.com/ja/duels/123?token=" + secret,
    "https://www.geoguessr.com/ja/duels/123#" + secret,
    "javascript:alert(1)", "//www.geoguessr.com/duels/123",
    "https://www.geoguessr.com/duels/123\n", 42,
  ]) rejectsSafely(changed({ pageUrl: invalid }));
});

test("observed Japanese locale Party and Duel URLs normalize to official plain paths", () => {
  for (const path of [
    "/party/lobby/PZM2F", "/party/join/PZM2F", "/duels/game-123", "/team-duels/game-123",
  ]) {
    const plain = "https://www.geoguessr.com" + path;
    const localized = "https://www.geoguessr.com/ja" + path;
    assert.equal(validateCapsule(changed({ pageUrl: localized }), { now }).pageUrl, plain);
    const built = buildCapsule({ guest: sourceGuest, cookie: sourceCookie, pageUrl: localized, now });
    assert.equal(built.pageUrl, plain);
  }
});

test("expiry cannot be extended or constructed in the future", () => {
  for (const change of [
    { exportedAt: now + 1 }, { exportedAt: -1 }, { exportedAt: "1" },
    { exportedAt: now + 0.5 }, { expiresAt: now },
    { expiresAt: now - 1 }, { expiresAt: now + 600001 },
    { expiresAt: Infinity }, { expiresAt: "999999" },
    { format: "another-format" },
  ]) rejectsSafely(changed(change));
  const built = capsule();
  built.cookie.expirationDate = (now + 30000) / 1000;
  rejectsSafely(built);
  assert.throws(() => validateCapsule(capsule(), { now: now + 600000 }), /期限切れ/);
});

test("malformed or extended objects never leak values in errors", () => {
  for (const value of [null, [], 123, "{" + secret, changed({ unexpected: secret })]) {
    rejectsSafely(value);
  }
  const unsafe = capsule();
  Object.defineProperty(unsafe.cookie, "value", { get() { throw new Error(secret); } });
  rejectsSafely(unsafe);
  rejectsSafely(JSON.parse(JSON.stringify(capsule()).replace(
    '"format":', '"__proto__":{"polluted":true},"format":',
  )));
  for (const guest of [
    { id: "", nick: "ok" }, { id: "guest\n123", nick: "ok" },
    { id: "a".repeat(129), nick: "ok" }, { id: "guest", nick: "" },
    { id: "guest", nick: " \t " }, { id: "guest", nick: "name\n" },
    { id: "guest", nick: "a".repeat(101) }, { id: "guest", nick: 42 },
    { id: "guest", nick: "ok", credential: secret },
  ]) rejectsSafely(changed({ guest }));
  assert.equal({}.polluted, undefined);
});

test("Cookie setter requires an explicit store and preserves only fixed attributes", () => {
  const built = capsule();
  const details = cookieSetDetails(built, "1");
  assert.deepEqual(details, {
    url: "https://www.geoguessr.com/", ...built.cookie, storeId: "1",
  });
  assert.notEqual(details, built.cookie);
  for (const storeId of [undefined, "", 0, "1\n", "a".repeat(129)]) {
    assert.throws(() => cookieSetDetails(built, storeId), /Cookieストア/);
  }
  const persistent = buildCapsule({
    guest: sourceGuest,
    cookie: { ...sourceCookie, expirationDate: (now + 6000000) / 1000 },
    pageUrl, now,
  });
  assert.equal(cookieSetDetails(persistent, "0").expirationDate,
    persistent.cookie.expirationDate);
});

test("summary omits credential and returned objects do not alias input", () => {
  const built = capsule();
  const summary = summarizeCapsule(built);
  assert.ok(!JSON.stringify(summary).includes(secret));
  assert.ok(!Object.hasOwn(summary.cookie, "value"));
  summary.guest.nick = "changed";
  summary.cookie.domain = "evil.test";
  assert.equal(built.guest.nick, sourceGuest.nick);
  assert.equal(built.cookie.domain, sourceCookie.domain);
  const checked = validateCapsule(built, { now });
  checked.cookie.value = "changed";
  assert.equal(built.cookie.value, secret);
});

test("host-only www guest cookie stays host-only when imported", () => {
  const built = buildCapsule({
    guest: sourceGuest,
    cookie: { ...sourceCookie, domain: "www.geoguessr.com", hostOnly: true },
    pageUrl, now,
  });
  const details = cookieSetDetails(built, "0");
  assert.equal(details.url, "https://www.geoguessr.com/");
  assert.ok(!Object.hasOwn(details, "domain"));
  assert.equal(details.path, "/");
  assert.equal(details.secure, true);
  assert.equal(details.httpOnly, true);
  assert.equal(details.value, secret);
  assert.equal(details.storeId, "0");
  assert.equal(cookieSetDetails(capsule(), "0").domain, ".geoguessr.com");
});
