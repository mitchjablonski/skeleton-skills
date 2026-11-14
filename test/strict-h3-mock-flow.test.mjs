// #77/#79: end-to-end H3 PROTOTYPE flow with a MOCK authority (test fixture):
// real captures -> listener /api/view codes (derived by the real codec) ->
// page-side code check -> human types the code into the real console ->
// mock authority verifies with the same codec. Proves the three pieces agree;
// proves nothing about the real adapter, isolation or human authentication.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecisionListener, TAB_HEADER } from "../lib/strict-decision-listener.mjs";
import { captureStrictManifest } from "../lib/strict-capture.mjs";
import { parseStrictCaptureViewModel } from "../lib/strict-capture-view-dom.mjs";
import { parseDecisionCodes } from "../lib/strict-decision-codes.mjs";
import { createControlConsole, normalizeCode, CONSOLE_COPY as C } from "../lib/strict-control-console.mjs";
import { normalizeHumanCode } from "../lib/strict-human-command.mjs";
import { createMockH3Authority } from "./fixtures/strict-h3-mock-authority.mjs";

const lt = (name, fn) => test(name, { skip: process.platform !== "linux" && "capture needs Linux" }, fn);
const KEY = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"); // public fixture key
const PAGE_PHASE = { skeleton: "scaffold", fill: "fill", finalized: "done" };

function captureOf(text) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "skel-h3-"));
  const root = path.join(base, "root"); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "a.js"), text);
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { return JSON.parse(JSON.stringify(captureStrictManifest(fd, [{ path: "a.js", mode: "fenced" }]))); }
  finally { fs.closeSync(fd); fs.rmSync(base, { recursive: true, force: true }); }
}
const pairOf = (cap) => ({ reviewVersion: cap.shapeVersion, captureVersion: cap.captureVersion });

async function setup(t) {
  const caps = new Map();
  const remember = (cap) => { caps.set(cap.captureVersion, cap); return cap; };
  const capA = remember(captureOf("const a = 1;\n// SKEL[1] step one\nthrow Error('SKEL_TODO');\n// /SKEL[1]\n"));
  const authority = createMockH3Authority({ projectId: "example-project", sessionId: "example-session", pair: pairOf(capA), key: KEY });
  const provider = { read: () => {
    const s = authority.authorityState();
    const binding = { protocolVersion: 2, projectId: s.projectId, sessionId: s.sessionId, reviewRoundId: s.reviewRoundId,
      phase: PAGE_PHASE[s.phase], reviewVersion: s.reviewVersion, captureVersion: s.captureVersion,
      approvedVersion: s.approvedVersion, approvedCaptureVersion: s.approvedCaptureVersion, pendingNotes: false };
    return { binding, capture: caps.get(s.captureVersion), codes: authority.issueCodes() };
  } };
  const listener = createDecisionListener({ provider });
  const { origin } = await listener.start();
  t.after(() => listener.close());
  const host = new URL(origin).host;
  const req = (method, url, headers = {}, body) => new Promise((resolve, reject) => {
    const r = http.request(`${origin}${url}`, { method, headers: { host, ...headers }, agent: false }, (res) => {
      let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, text: b }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
  const nonce = new URL(listener.mintNavigation()).hash.slice(3);
  const bound = await req("POST", "/api/bind", { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, JSON.stringify({ nonce }));
  const tab = JSON.parse(bound.text).tab;
  // What the page does: fetch, validate the view, then check the codes against the rendered binding.
  const page = async () => {
    const r = await req("GET", "/api/view", { "sec-fetch-site": "same-origin", [TAB_HEADER]: tab });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    const model = parseStrictCaptureViewModel(body.view);
    const codes = parseDecisionCodes(body.codes, model);
    assert.ok(codes, "page accepts the codes for the capture it renders");
    return { model, codes, dropped: body.codesDropped };
  };
  let n = 0;
  const con = createControlConsole({ authority, newRequestId: () => `req-${++n}` });
  return { authority, page, con, remember };
}

lt("approve: the code the page shows is accepted by the console and the authority", async (t) => {
  const { authority, page, con } = await setup(t);
  const { codes, model } = await page();
  assert.equal(model.binding.phase, "scaffold");
  // the human types it lowercase with a space: same canonical code
  const typed = codes.approve.code.toLowerCase().replace("-", " ");
  const out = await con.handle(`approve ${typed}`);
  assert.match(out[0], /^Recorded: approve · shape [0-9a-f]{12}… · capture [0-9a-f]{12}… · revision 1 · 2026-11-14T00:00:00Z\.$/);
  assert.equal(authority.authorityState().phase, "fill");
});

lt("reshape: after approve the page shows a reshape code bound to the approved pair; typing it rotates the round", async (t) => {
  const { authority, page, con } = await setup(t);
  await con.handle(`approve ${(await page()).codes.approve.code}`);
  const fill = await page();
  assert.deepEqual(Object.keys(fill.codes), ["reshape"]);
  assert.equal(fill.codes.reshape.captureVersion, fill.model.binding.approvedCaptureVersion);
  const out = await con.handle(`reshape ${fill.codes.reshape.code}`);
  assert.match(out[0], /^Recorded: reshape/);
  const s = authority.authorityState();
  assert.deepEqual([s.phase, s.reviewRoundId], ["skeleton", "round-2"]);
  const again = await page();
  assert.notEqual(again.codes.approve.code, fill.codes.reshape.code);
});

lt("a code from an older snapshot is a mismatch after a changed recapture; the new page code works", async (t) => {
  const { authority, page, con, remember } = await setup(t);
  const old = (await page()).codes.approve.code;
  const capB = remember(captureOf("const a = 2;\n// SKEL[1] step one\nthrow Error('SKEL_TODO');\n// /SKEL[1]\n"));
  authority.stageCapture(pairOf(capB));
  await con.handle("recapture");
  assert.match((await con.handle("yes"))[0], /new snapshot is under review/);
  const stale = await con.handle(`approve ${old}`);
  assert.match(stale[0], /doesn't match the snapshot under review now/);
  const fresh = (await page()).codes.approve.code;
  assert.notEqual(fresh, old);
  assert.match((await con.handle(`approve ${fresh}`))[0], /^Recorded: approve/);
});

lt("a lost reply after commit: retry returns the journaled answer and commits only once", async (t) => {
  const { authority, page, con } = await setup(t);
  const code = (await page()).codes.approve.code;
  authority.loseNextReply();
  assert.deepEqual(await con.handle(`approve ${code}`), [C.unknownOutcome]);
  assert.deepEqual(await con.handle(`approve ${code}`), [C.keptBlocksNew]);
  await con.handle("retry");
  assert.match((await con.handle("yes"))[0], /^Recorded: approve · .* revision 1 /);
  assert.equal(authority.authorityState().revision, 1, "committed once");
});

lt("five wrong codes lock the round; recapture unlocks it", async (t) => {
  const { page, con } = await setup(t);
  const real = (await page()).codes.approve.code;
  const wrong = real.startsWith("0") ? "1111-1111" : "0000-0000";
  for (let i = 0; i < 5; i++) assert.match((await con.handle(`approve ${wrong}`))[0], /doesn't match/);
  assert.deepEqual(await con.handle(`approve ${real}`), [C.locked.recapture]);
  await con.handle("recapture"); await con.handle("yes");
  assert.match((await con.handle(`approve ${real}`))[0], /^Recorded: approve/);
});

test("console and codec normalise admitted code spellings identically", () => {
  const vectors = JSON.parse(fs.readFileSync(new URL("./fixtures/strict-human-code-vectors.json", import.meta.url), "utf8")).codeVectors;
  for (const v of vectors) {
    for (const spelling of [v.code, v.code.toLowerCase(), v.code.replace("-", ""), v.code.replace("-", " "), v.code.replaceAll("1", "l").replaceAll("0", "o")])
      assert.equal(normalizeCode(spelling), normalizeHumanCode(spelling), spelling);
  }
});
