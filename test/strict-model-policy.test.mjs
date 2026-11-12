import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODEL_PROFILE,
  STRICT_MODEL_HEADERS,
  STRICT_MODEL_PROFILE,
  StrictModelPolicyError,
  parseModelRequest,
  validateNoRedirect,
  validatePublicIPv4,
  validateResolvedAddresses,
  validateTrustedProfile,
} from "../lib/strict-model-policy.mjs";

const json = value => Buffer.from(JSON.stringify(value));
const request = (overrides = {}) => {
  const body = overrides.body ?? json({ model: "fixture", stream: true });
  const bodyLength = Buffer.isBuffer(body) || body instanceof Uint8Array ? body.byteLength : Buffer.byteLength(body, "utf8");
  return {
    method: "POST",
    target: "/v1/messages",
    headers: overrides.headers ?? { host: "127.0.0.1:39121", "content-type": "application/json", "content-length": String(bodyLength) },
    body,
    ...overrides,
  };
};
const expectCode = (code, fn) => assert.throws(fn, error => error instanceof StrictModelPolicyError && error.code === code);

test("fixed provider profile accepts only the supported destination and bounded lower caps", () => {
  assert.deepEqual(STRICT_MODEL_PROFILE, { host: "api.anthropic.com", port: 443, maxBodyBytes: 1024 * 1024 });
  assert.deepEqual(validateTrustedProfile({ host: "api.anthropic.com", port: 443, maxBodyBytes: 128 }), {
    host: "api.anthropic.com", port: 443, maxBodyBytes: 128,
  });
  expectCode("MODEL_DESTINATION", () => validateTrustedProfile({ host: "127.0.0.1", port: 443 }));
  expectCode("MODEL_DESTINATION", () => validateTrustedProfile({ host: "api.anthropic.com.evil.test", port: 443 }));
  expectCode("MODEL_DESTINATION", () => validateTrustedProfile({ host: "api.anthropic.com", port: 8443 }));
  expectCode("MODEL_BODY_LIMIT", () => validateTrustedProfile({ host: "api.anthropic.com", port: 443, maxBodyBytes: 1024 * 1024 + 1 }));
  expectCode("MODEL_PROFILE", () => validateTrustedProfile({ host: "api.anthropic.com", port: 443, extra: true }));

  const lowerCap = new Proxy({ host: "api.anthropic.com", port: 443, maxBodyBytes: 64 }, {
    get(target, key, receiver) {
      if (key === "maxBodyBytes") return 1024 * 1024;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(validateTrustedProfile(lowerCap).maxBodyBytes, 64);
  const overCap = "x".repeat(65);
  expectCode("MODEL_BODY_LIMIT", () => parseModelRequest(request({ body: JSON.stringify({ value: overCap }) }), lowerCap));
});

test("validates only POST fixed Messages endpoints and forces trusted upstream authority/version", () => {
  const body = json({ model: "fixture", stream: true });
  const parsed = parseModelRequest({
    method: "POST",
    target: "/v1/messages?beta=true",
    headers: {
      Host: "localhost:39001",
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
      "anthropic-version": "attacker-version",
      "anthropic-beta": "prompt-caching-2024-07-31",
    },
    body,
  });
  assert.equal(parsed.url, "https://api.anthropic.com:443/v1/messages?beta=true");
  assert.equal(parsed.target, "/v1/messages?beta=true");
  assert.equal(parsed.headers.host, "api.anthropic.com:443");
  assert.equal(parsed.headers["anthropic-version"], STRICT_MODEL_HEADERS.version);
  assert.equal(parsed.headers["anthropic-beta"], "prompt-caching-2024-07-31");
  assert.equal(parsed.headers["content-length"], String(body.length));
  assert.equal(JSON.parse(parsed.bodyText).stream, true);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.headers));

  for (const target of [
    "https://evil.example/v1/messages", "//evil.example/v1/messages", "/v1/messages/",
    "/v1/messages?beta=true&x=1", "/v1/messages#fragment", "/v1/messages/count_tokens/",
  ]) expectCode("MODEL_TARGET", () => parseModelRequest(request({ target })));
  expectCode("MODEL_METHOD", () => parseModelRequest(request({ method: "CONNECT" })));
  expectCode("MODEL_METHOD", () => parseModelRequest(request({ method: "GET" })));
});

test("removes all input credentials, cookies, proxy and hop headers", () => {
  const body = json({ model: "fixture" });
  const parsed = parseModelRequest({
    method: "POST", target: "/v1/messages",
    headers: {
      host: "127.0.0.1",
      authorization: "Bearer user-secret",
      "x-api-key": "sk-ant-user-secret",
      cookie: "sid=secret",
      "proxy-authorization": "Basic secret",
      connection: "keep-alive, x-hop-secret",
      "x-hop-secret": "not-forwarded",
      "transfer-encoding": "chunked",
      "anthropic-version": "bad-version",
      "anthropic-beta": "feature-a,feature-b",
    },
    body,
  });
  assert.deepEqual(Object.keys(parsed.headers).sort(), [
    "accept", "anthropic-beta", "anthropic-version", "content-length", "content-type", "host",
  ].sort());
  const serialized = JSON.stringify(parsed.headers);
  for (const secret of ["user-secret", "sk-ant-user-secret", "sid=secret", "not-forwarded", "bad-version"])
    assert.equal(serialized.includes(secret), false);
});

test("rejects absolute host targets, host-override metadata, and hostile Host values", () => {
  expectCode("MODEL_HOST_OVERRIDE", () => parseModelRequest(request({ headers: { host: "evil.example" } })));
  for (const name of ["x-forwarded-host", "x-original-host", "forwarded", ":authority", "x-rewrite-url"])
    expectCode("MODEL_HOST_OVERRIDE", () => parseModelRequest(request({ headers: { [name]: "evil.example" } })));
  expectCode("MODEL_DUPLICATE_HEADER", () => parseModelRequest(request({ headers: { host: "localhost", Host: "localhost" } })));
  expectCode("MODEL_REQUEST_FIELD", () => parseModelRequest({ ...request(), url: "https://evil.example" }));
});

test("enforces body byte limit, strict UTF-8 and top-level plain-object JSON without merging nested keys", () => {
  const body = json({ model: "fixture", nested: { ok: true } });
  const headers = { "content-length": String(body.length) };
  assert.equal(JSON.parse(parseModelRequest(request({ body, headers }), { ...STRICT_MODEL_PROFILE, maxBodyBytes: body.length }).bodyText).nested.ok, true);
  expectCode("MODEL_BODY_LIMIT", () => parseModelRequest(request({ body, headers }), { ...STRICT_MODEL_PROFILE, maxBodyBytes: body.length - 1 }));
  expectCode("MODEL_CONTENT_LENGTH", () => parseModelRequest(request({ body, headers: { "content-length": "1" } })));
  expectCode("MODEL_BODY_UTF8", () => parseModelRequest(request({ body: Buffer.from([0xff]) })));
  expectCode("MODEL_BODY_BOM", () => parseModelRequest(request({ body: "\uFEFF{}" })));
  expectCode("MODEL_BODY_JSON", () => parseModelRequest(request({ body: "{" })));
  for (const source of ["[]", "null", "42", '"text"'])
    expectCode("MODEL_BODY_OBJECT", () => parseModelRequest(request({ body: source })));
  const opaqueData = '{"__proto__":{"polluted":true},"nested":{"constructor":{"prototype":{"polluted":true}}}}';
  assert.equal(parseModelRequest(request({ body: opaqueData })).bodyText, opaqueData);
  assert.equal({}.polluted, undefined);
  expectCode("MODEL_BODY_COMPLEXITY", () => parseModelRequest(request({ body: "{".repeat(65) + "}".repeat(65) })));
});

test("rejects malformed or duplicate headers and bad content type", () => {
  expectCode("MODEL_DUPLICATE_HEADER", () => parseModelRequest(request({ headers: { Accept: "a", accept: "b" } })));
  expectCode("MODEL_HEADER_VALUE", () => parseModelRequest(request({ headers: { accept: "application/json\r\nHost: evil" } })));
  expectCode("MODEL_CONTENT_TYPE", () => parseModelRequest(request({ headers: { "content-type": "text/plain" } })));
  expectCode("MODEL_BETA_HEADER", () => parseModelRequest(request({ headers: { "anthropic-beta": "bad beta" } })));
  expectCode("MODEL_HEADER_VALUE", () => parseModelRequest(request({ headers: { "x-large": "x".repeat(9000) } })));
  expectCode("MODEL_HEADER_LIMIT", () => parseModelRequest(request({ headers: {
    "x-a": "a".repeat(7000), "x-b": "b".repeat(7000), "x-c": "c".repeat(7000),
    "x-d": "d".repeat(7000), "x-e": "e".repeat(7000),
  } })));
});

test("accepts canonical public IPv4 and rejects private, reserved and unusual forms", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34"]) assert.equal(validatePublicIPv4(address), true, address);
  for (const address of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1",
    "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "240.0.0.1", "255.255.255.255", "0177.0.0.1", "2130706433", "0x7f000001",
    "::1", "::ffff:127.0.0.1", "2001:4860:4860::8888",
  ]) assert.equal(validatePublicIPv4(address), false, address);
});

test("address-list validation refuses empty, mixed-public/private and IPv6 resolver answers", () => {
  assert.deepEqual(validateResolvedAddresses(["8.8.8.8", "1.1.1.1", "8.8.8.8"]), ["8.8.8.8", "1.1.1.1"]);
  expectCode("MODEL_DNS_ANSWERS", () => validateResolvedAddresses([]));
  expectCode("MODEL_DNS_NONPUBLIC_OR_UNSUPPORTED", () => validateResolvedAddresses(["8.8.8.8", "127.0.0.1"]));
  expectCode("MODEL_DNS_NONPUBLIC_OR_UNSUPPORTED", () => validateResolvedAddresses(["::ffff:127.0.0.1"]));
  assert.equal(DEFAULT_MODEL_PROFILE, STRICT_MODEL_PROFILE);
});

test("redirect guard refuses redirects and Location headers", () => {
  assert.equal(validateNoRedirect(200), true);
  expectCode("MODEL_REDIRECT_REFUSED", () => validateNoRedirect(302, "https://elsewhere.example/"));
  expectCode("MODEL_REDIRECT_REFUSED", () => validateNoRedirect(301));
  expectCode("MODEL_RESPONSE_STATUS", () => validateNoRedirect(700));
});
