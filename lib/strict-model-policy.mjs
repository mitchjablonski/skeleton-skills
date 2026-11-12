// Pure request policy for a future host-side model broker. This module never
// resolves names, opens sockets, attaches credentials, follows redirects, or
// performs TLS. Callers must provide resolver answers separately and enforce
// connection pinning themselves.
import net from "node:net";
import { TextDecoder } from "node:util";

export const STRICT_MODEL_PROFILE = Object.freeze({
  host: "api.anthropic.com",
  port: 443,
  maxBodyBytes: 1024 * 1024,
});
export const DEFAULT_MODEL_PROFILE = STRICT_MODEL_PROFILE;

export const STRICT_MODEL_HEADERS = Object.freeze({
  version: "2023-06-01",
  contentType: "application/json",
  accept: "application/json, text/event-stream",
});

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const MAX_HEADER_BYTES = 32 * 1024;
const MAX_HEADER_VALUE_BYTES = 8192;
const MAX_JSON_DEPTH = 64;
const HOST_OVERRIDE_HEADERS = new Set([
  ":authority", ":method", ":path", ":scheme",
  "forwarded", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto",
  "x-host", "x-original-host", "x-original-url", "x-rewrite-url",
]);
const AUTH_AND_HOP_HEADERS = new Set([
  "authorization", "proxy-authorization", "proxy-authenticate", "x-api-key",
  "cookie", "cookie2", "set-cookie", "connection", "keep-alive",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);
const SAFE_HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const IPV4_DENY_CIDRS = Object.freeze([
  ["0.0.0.0", 8],       // unspecified and this-network
  ["10.0.0.0", 8],      // private
  ["100.64.0.0", 10],   // shared address space
  ["127.0.0.0", 8],     // loopback
  ["169.254.0.0", 16],  // link-local
  ["172.16.0.0", 12],   // private
  ["192.0.0.0", 24],    // protocol assignments
  ["192.0.2.0", 24],    // documentation
  ["192.88.99.0", 24],  // deprecated 6to4 relay
  ["192.168.0.0", 16],  // private
  ["198.18.0.0", 15],   // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24],  // documentation
  ["224.0.0.0", 4],     // multicast
  ["240.0.0.0", 4],     // reserved and broadcast
].map(([network, bits]) => [ipv4Number(network), bits]));

export class StrictModelPolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = "StrictModelPolicyError";
    this.code = code;
  }
}

function refuse(code) {
  throw new StrictModelPolicyError(code);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownDataEntries(value, code) {
  if (!isPlainRecord(value)) refuse(code);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string")) refuse(code);
  return keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) refuse(code);
    return [key, descriptor.value];
  });
}

export function validateTrustedProfile(profile = STRICT_MODEL_PROFILE) {
  const entries = ownDataEntries(profile, "MODEL_PROFILE");
  const values = new Map(entries);
  const keys = new Set(values.keys());
  if ([...keys].some(key => !["host", "port", "maxBodyBytes"].includes(key))) refuse("MODEL_PROFILE");
  if (values.get("host") !== STRICT_MODEL_PROFILE.host || values.get("port") !== STRICT_MODEL_PROFILE.port) refuse("MODEL_DESTINATION");
  const maxBodyBytes = values.get("maxBodyBytes") ?? DEFAULT_BODY_LIMIT;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > DEFAULT_BODY_LIMIT) refuse("MODEL_BODY_LIMIT");
  return Object.freeze({ host: STRICT_MODEL_PROFILE.host, port: STRICT_MODEL_PROFILE.port, maxBodyBytes });
}

function ipv4Number(address) {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function inCidr(address, network, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((address & mask) >>> 0) === ((network & mask) >>> 0);
}

export function validatePublicIPv4(address) {
  if (typeof address !== "string" || net.isIP(address) !== 4) return false;
  const number = ipv4Number(address);
  return number !== null && !IPV4_DENY_CIDRS.some(([network, bits]) => inCidr(number, network, bits));
}

export function validateResolvedAddresses(addresses, trustedProfile = STRICT_MODEL_PROFILE) {
  validateTrustedProfile(trustedProfile);
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 64) refuse("MODEL_DNS_ANSWERS");
  const candidates = [];
  for (const address of addresses) {
    if (!validatePublicIPv4(address)) refuse("MODEL_DNS_NONPUBLIC_OR_UNSUPPORTED");
    if (!candidates.includes(address)) candidates.push(address);
  }
  return Object.freeze(candidates);
}

export function validateNoRedirect(statusCode, location = undefined) {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) refuse("MODEL_RESPONSE_STATUS");
  if ((statusCode >= 300 && statusCode < 400) || (location !== undefined && location !== "")) refuse("MODEL_REDIRECT_REFUSED");
  return true;
}

function validIncomingHost(value, profile) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || /[\s\/@?#\\]/.test(value)) return false;
  const expected = `${profile.host}:${profile.port}`;
  if (value.toLowerCase() === profile.host || value.toLowerCase() === expected) return true;
  const authority = value.toLowerCase();
  if (/^localhost(?::[0-9]{1,5})?$/.test(authority)) return validOptionalPort(authority);
  const ipv4Host = authority.match(/^((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?::([0-9]{1,5}))?$/);
  if (ipv4Host && net.isIP(ipv4Host[1]) === 4 && ipv4Host[1].split(".")[0] === "127") return validOptionalPort(authority);
  const ipv6Loopback = authority.match(/^\[::1\](?::([0-9]{1,5}))?$/);
  return ipv6Loopback !== null && (!ipv6Loopback[1] || validPort(ipv6Loopback[1]));
}

function validOptionalPort(authority) {
  const colon = authority.lastIndexOf(":");
  return colon < 0 || validPort(authority.slice(colon + 1));
}

function validPort(value) {
  return /^[0-9]{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
}

function parseHeaders(rawHeaders, profile, bodyLength) {
  const entries = ownDataEntries(rawHeaders ?? {}, "MODEL_HEADERS");
  const input = new Map();
  let totalBytes = 0;
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (rawName.startsWith(":")) {
      if (HOST_OVERRIDE_HEADERS.has(name)) refuse("MODEL_HOST_OVERRIDE");
      refuse("MODEL_HEADER_NAME");
    }
    if (!SAFE_HEADER_TOKEN.test(rawName) && !rawName.startsWith(":")) refuse("MODEL_HEADER_NAME");
    if (input.has(name)) refuse("MODEL_DUPLICATE_HEADER");
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_HEADER_VALUE_BYTES || /[\0\r\n]/.test(value)) refuse("MODEL_HEADER_VALUE");
    totalBytes += Buffer.byteLength(rawName, "utf8") + Buffer.byteLength(value, "utf8");
    if (totalBytes > MAX_HEADER_BYTES) refuse("MODEL_HEADER_LIMIT");
    input.set(name, value);
  }

  for (const name of input.keys()) if (HOST_OVERRIDE_HEADERS.has(name)) refuse("MODEL_HOST_OVERRIDE");
  const host = input.get("host");
  if (host !== undefined && !validIncomingHost(host, profile)) refuse("MODEL_HOST_OVERRIDE");

  const connectionTokens = new Set();
  const connection = input.get("connection");
  if (connection !== undefined) {
    for (const token of connection.split(",")) {
      const name = token.trim().toLowerCase();
      if (!SAFE_HEADER_TOKEN.test(name)) refuse("MODEL_HOP_HEADER");
      connectionTokens.add(name);
    }
  }

  const contentType = input.get("content-type");
  if (contentType !== undefined && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) refuse("MODEL_CONTENT_TYPE");
  const contentLength = input.get("content-length");
  if (contentLength !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) !== bodyLength)) refuse("MODEL_CONTENT_LENGTH");

  const forwardedBeta = input.get("anthropic-beta");
  if (forwardedBeta !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._=,-]{0,1023}$/.test(forwardedBeta)) refuse("MODEL_BETA_HEADER");

  // Rebuild from an allowlist. Secrets, cookies, all proxy/hop headers, the
  // client Host and the client version header are never forwarded.
  const headers = {
    host: `${profile.host}:${profile.port}`,
    "anthropic-version": STRICT_MODEL_HEADERS.version,
    "content-type": STRICT_MODEL_HEADERS.contentType,
    accept: STRICT_MODEL_HEADERS.accept,
    "content-length": String(bodyLength),
  };
  if (forwardedBeta !== undefined && !AUTH_AND_HOP_HEADERS.has("anthropic-beta") && !connectionTokens.has("anthropic-beta")) {
    headers["anthropic-beta"] = forwardedBeta;
  }
  return Object.freeze(headers);
}

function parseBody(rawBody, maxBodyBytes) {
  let bytes;
  if (typeof rawBody === "string") {
    if (Buffer.byteLength(rawBody, "utf8") > maxBodyBytes) refuse("MODEL_BODY_LIMIT");
    bytes = Buffer.from(rawBody, "utf8");
  } else if (Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array) {
    if (rawBody.byteLength > maxBodyBytes) refuse("MODEL_BODY_LIMIT");
    bytes = Buffer.from(rawBody);
  } else refuse("MODEL_BODY_TYPE");
  if (bytes.byteLength < 1 || bytes.byteLength > maxBodyBytes) refuse("MODEL_BODY_LIMIT");
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) refuse("MODEL_BODY_BOM");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { refuse("MODEL_BODY_UTF8"); }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) refuse("MODEL_BODY_COMPLEXITY");
    } else if (character === "}" || character === "]") depth -= 1;
  }
  let body;
  try { body = JSON.parse(text); }
  catch { refuse("MODEL_BODY_JSON"); }
  if (!isPlainRecord(body)) refuse("MODEL_BODY_OBJECT");
  // The parsed object is used only for this top-level shape check, never
  // merged, executed, or returned. Preserve the exact validated JSON text.
  return text;
}

export function parseModelRequest(request, trustedProfile = STRICT_MODEL_PROFILE) {
  const profile = validateTrustedProfile(trustedProfile);
  const requestEntries = ownDataEntries(request, "MODEL_REQUEST");
  const values = new Map(requestEntries);
  if ([...values.keys()].some(key => !["method", "target", "headers", "body"].includes(key))) refuse("MODEL_REQUEST_FIELD");
  if (values.get("method") !== "POST") refuse("MODEL_METHOD");
  const target = values.get("target");
  if (typeof target !== "string" || !["/v1/messages", "/v1/messages?beta=true", "/v1/messages/count_tokens", "/v1/messages/count_tokens?beta=true"].includes(target)) refuse("MODEL_TARGET");

  const bodyText = parseBody(values.get("body"), profile.maxBodyBytes);
  const headers = parseHeaders(values.get("headers"), profile, Buffer.byteLength(bodyText, "utf8"));
  return Object.freeze({
    method: "POST",
    host: profile.host,
    port: profile.port,
    target,
    url: `https://${profile.host}:${profile.port}${target}`,
    headers,
    bodyText,
  });
}
