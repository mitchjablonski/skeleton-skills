// Host-only. One fixed, non-generating request. Nothing imports this from a launcher.
import { Resolver } from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import { addAbortSignal } from "node:stream";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { parseModelRequest, validateResolvedAddresses, STRICT_MODEL_PROFILE } from "../../lib/strict-model-policy.mjs";

const { host: HOST, port: PORT } = STRICT_MODEL_PROFILE;
const TARGET = "/v1/messages/count_tokens";
const DEADLINE_MS = 10_000;
const MAX_KEY_BYTES = 512;
const MAX_RESPONSE_BYTES = 16_384;
const REQUEST = parseModelRequest({
  method: "POST", target: TARGET,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "claude-haiku-5-5",
    messages: [{ role: "user", content: "Count this synthetic qualification sentence." }] }),
});

class Refusal extends Error {}
const result = (ok, code) => Object.freeze({ ok, code, strictState: "unverified" });

function readHeader(response, name) {
  const values = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    if (response.rawHeaders[index].toLowerCase() === name) values.push(response.rawHeaders[index + 1]);
  }
  if (values.length > 1) throw new Refusal("upstream-response-refused");
  return values[0];
}

// transport is a trusted host dependency. No caller-provided destination,
// prompt, headers, model or tool definitions reach the wire.
export async function checkUpstreamAuthentication(credential, transport = createUpstreamTransport()) {
  if (!Buffer.isBuffer(credential) || credential.length > MAX_KEY_BYTES)
    return result(false, "upstream-credential-refused");
  const key = Buffer.from(credential);
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(key.toString("latin1"))) {
    key.fill(0);
    return result(false, "upstream-credential-refused");
  }
  const controller = new AbortController();
  const signal = controller.signal;
  const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
  let connection;
  try {
    const address = validateResolvedAddresses(await transport.resolve(signal))[0];
    signal.throwIfAborted();
    connection = await transport.connect(address, signal);
    if (connection.peerAddress !== address || !connection.authorized
        || connection.servername !== HOST || connection.alpn !== "http/1.1")
      throw new Refusal("upstream-tls-refused");
    signal.throwIfAborted();
    const headers = { ...REQUEST.headers, "anthropic-version": "2026-10-21",
      authorization: `Bearer ${key.toString("latin1")}` };
    const response = await connection.send({ method: REQUEST.method, target: REQUEST.target,
      headers, body: REQUEST.bodyText }, signal);
    if (readHeader(response, "location") !== undefined || (response.status >= 300 && response.status < 400))
      throw new Refusal("upstream-redirect-refused");
    if (response.status === 401 || response.status === 403) throw new Refusal("upstream-auth-refused");
    if (response.status !== 200 || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(readHeader(response, "content-type") ?? ""))
      throw new Refusal("upstream-response-refused");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES || chunks.length >= 128) throw new Refusal("upstream-response-refused");
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    const body = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!Number.isSafeInteger(body?.input_tokens) || body.input_tokens < 1)
      throw new Refusal("upstream-response-refused");
    return result(true, "upstream-authenticated-count-passed");
  } catch (error) {
    return result(false, signal.aborted ? "upstream-timeout"
      : error instanceof Refusal ? error.message : "upstream-unavailable");
  } finally {
    clearTimeout(deadline);
    controller.abort();
    key.fill(0);
    try { connection?.close(); } catch { /* Transport errors are kept out of the receipt. */ }
  }
}

function createUpstreamTransport() {
  return {
    async resolve(signal) {
      const resolver = new Resolver();
      const cancel = () => resolver.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        return await resolver.resolve4(HOST);
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    async connect(address, signal) {
      const socket = tls.connect({
        host: address, port: PORT, servername: HOST, rejectUnauthorized: true,
        minVersion: "TLSv1.2", ca: tls.rootCertificates, ALPNProtocols: ["http/1.1"], signal,
      });
      try {
        await new Promise((resolve, reject) => {
          socket.once("secureConnect", resolve);
          socket.on("error", reject);
          socket.once("close", () => reject(new Refusal("upstream-tls-refused")));
        });
        if (socket.authorized !== true || tls.checkServerIdentity(HOST, socket.getPeerCertificate()) !== undefined)
          throw new Refusal("upstream-tls-refused");
      } catch {
        socket.destroy();
        throw new Refusal("upstream-tls-refused");
      }
      const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
      agent.createConnection = () => socket;
      return {
        peerAddress: socket.remoteAddress, authorized: true,
        servername: HOST, alpn: socket.alpnProtocol,
        send({ method, target, headers, body }, requestSignal) {
          return new Promise((resolve, reject) => {
            const request = http.request({
              host: HOST, port: PORT, method, path: target,
              headers, agent, signal: requestSignal, maxHeaderSize: 16_384,
            }, (response) => resolve({ status: response.statusCode, rawHeaders: response.rawHeaders, body: response }));
            request.once("error", reject);
            request.end(body);
          });
        },
        close() { agent.destroy(); socket.destroy(); },
      };
    },
  };
}

async function readCredential() {
  if (!fs.fstatSync(0).isFIFO()) throw new Refusal("upstream-credential-pipe-required");
  const bytes = Buffer.alloc(MAX_KEY_BYTES + 1);
  let size = 0;
  try {
    for await (const chunk of addAbortSignal(AbortSignal.timeout(DEADLINE_MS), process.stdin)) {
      if (size + chunk.length > bytes.length) throw new Refusal("upstream-credential-refused");
      chunk.copy(bytes, size);
      size += chunk.length;
      chunk.fill(0);
    }
    if (bytes[size - 1] === 10) size--;
    return bytes.subarray(0, size);
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let credential;
  let report = result(false, "upstream-invocation-refused");
  try {
    if (process.platform === "linux" && process.argv.length === 3 && process.argv[2] === "--authenticate-count") {
      credential = await readCredential();
      report = await checkUpstreamAuthentication(credential);
    }
  } catch (error) {
    report = result(false, error instanceof Refusal ? error.message : "upstream-credential-unavailable");
  } finally {
    credential?.fill(0);
  }
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exitCode = report.ok ? 0 : 1;
}
