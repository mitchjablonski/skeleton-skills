import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import { addSession, storeFeedback, takeFeedback, mergeRecords, lastReview, queueDir, historyDir, withFeedbackLock } from "../lib/feedback.mjs";
import { readState } from "../lib/state.mjs";
const BIN = fileURLToPath(new URL("../bin/skel.mjs", import.meta.url));
const MODULE = new URL("../lib/feedback.mjs", import.meta.url).href;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-order-"));
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; });
  const cli = (...args) => spawnSync(process.execPath, ["--import", "data:text/javascript,Date.now=()=>1", BIN, ...args], { cwd: root, env: process.env, encoding: "utf8" });
  assert.equal(cli("init", "logical ordering").status, 0);
  fs.writeFileSync(path.join(root, "a.js"), '// SKEL[1] value\nconst value=1;\n// /SKEL[1]\n');
  addSession(root, "known-session");
  return { root, cli };
}
function send(root, time, version, verdict = "approve") {
  const code = `import {storeFeedback} from ${JSON.stringify(MODULE)}; Date.now=()=>${time}; storeFeedback(${JSON.stringify(root)},"known-session",{version:${JSON.stringify(version)},verdict:${JSON.stringify(verdict)},general:"note",comments:[]});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
test("backward/same clock sends never hide unread, latest survives archive and process restart", t => {
  const { root, cli } = fixture(t);
  send(root, -1000, "111111111111");
  send(root, -2000, "222222222222", "changes");
  send(root, -2000, "333333333333", "approve");
  assert.equal(lastReview(root, readState(root).reviewRound).record.version, "333333333333");
  assert.equal(lastReview(root).unread, 3);
  assert.match(cli("approve").stderr, /haven't read/);
  assert.equal(fs.existsSync(path.join(queueDir(root), ".order-lock")), false);
  const merged = mergeRecords(takeFeedback(root).records);
  assert.equal(merged.version, "333333333333");
  assert.equal(merged.verdict, "approve");
  fs.rmSync(path.join(queueDir(root), ".order"));
  send(root, -3000, "444444444444");
  assert.equal(lastReview(root).record.version, "444444444444");
  assert.equal(lastReview(root).record.order, "4");
  assert.equal(fs.readdirSync(historyDir(root)).length, 3);
});
test("reshape changes round while older unread remains visible; legacy never wins verdict", t => {
  const { root, cli } = fixture(t);
  assert.equal(cli("approve").status, 0);
  send(root, -500, "111111111111");
  const before = readState(root).reviewRound;
  assert.equal(cli("reshape").status, 0);
  assert.notEqual(readState(root).reviewRound, before);
  assert.equal(lastReview(root).record, null);
  assert.equal(lastReview(root).unread, 1);
  assert.match(cli("approve").stderr, /haven't read/);
  takeFeedback(root);
  fs.writeFileSync(path.join(queueDir(root), "legacy.json"), JSON.stringify({ session: "known-session", at: 9999999999999, version: "ffffffffffff", verdict: "approve", general: "legacy note" }));
  assert.equal(lastReview(root).unread, 1);
  const merged = mergeRecords(takeFeedback(root).records);
  assert.equal(merged.verdict, null);
  assert.equal(merged.version, null);
  assert.match(merged.general, /legacy note/);
  assert.match(merged.general, /send the review again/);
});
test("concurrent accepted sends get unique order; busy lock refuses without stealing", async t => {
  const { root } = fixture(t);
  assert.throws(() => withFeedbackLock(root, () => storeFeedback(root, "known-session", {})), /locked/);
  const code = `import {storeFeedback} from ${JSON.stringify(MODULE)}; for(let n=0;n<100;n++){try{storeFeedback(${JSON.stringify(root)},"known-session",{version:"111111111111",comments:[]});process.exit(0)}catch(e){if(!e.message.includes("locked"))throw e;await new Promise(r=>setTimeout(r,10))}}process.exit(1);`;
  await Promise.all(Array.from({ length: 5 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code]);
    let error = "";
    child.stderr.on("data", chunk => error += chunk);
    child.on("exit", status => status === 0 ? resolve() : reject(new Error(error || "send failed")));
  })));
  const records = takeFeedback(root).records;
  assert.deepEqual(records.map(r => r.order), ["1", "2", "3", "4", "5"]);
});
test("new feedback writes reject outward directory links and corrupt state", t => {
  const { root } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(queueDir(root), { recursive: true });
  fs.rmSync(queueDir(root), { recursive: true });
  try { fs.symlinkSync(outside, queueDir(root), process.platform === "win32" ? "junction" : "dir"); }
  catch (err) { if (["EPERM", "EACCES"].includes(err.code)) return t.skip("symlink privilege unavailable"); throw err; }
  assert.throws(() => storeFeedback(root, "known-session", {}), /real directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(queueDir(root));
  fs.writeFileSync(path.join(root, ".skeleton/state.json"), '{}');
  assert.throws(() => storeFeedback(root, "known-session", {}), /state is invalid/);
});
test("corrupt counter recovers verified maximum; duplicate ordinals refuse", t => {
  const { root } = fixture(t);
  send(root, 10, "111111111111");
  fs.writeFileSync(path.join(queueDir(root), ".order"), '{');
  send(root, 1, "222222222222");
  assert.equal(lastReview(root).record.order, "2");
  const file = fs.readdirSync(queueDir(root)).find(name => name.endsWith('.json'));
  fs.copyFileSync(path.join(queueDir(root), file), path.join(queueDir(root), 'duplicate.json'));
  assert.throws(() => takeFeedback(root), /duplicate feedback order/);
});
test("serve replaces verified clock-only server instead of silently reusing it", { timeout: 60000 }, async t => {
  const { root } = fixture(t);
  const old = spawn(process.execPath, ["-e", 'const http=require("http");const server=http.createServer((req,res)=>res.end(JSON.stringify({serverId:"clock-only",pid:process.pid,feedbackEnabled:true})));server.listen(0,"127.0.0.1",()=>console.log(server.address().port));']);
  let current;
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("legacy start timeout")), 5000);
      old.stdout.once("data", data => { clearTimeout(timer); resolve(Number(String(data).trim())); });
    });
    fs.writeFileSync(path.join(root, ".skeleton/serve.json"), JSON.stringify({ url: `http://127.0.0.1:${port}/`, serverId: "clock-only", pid: old.pid }));
    current = spawn(process.execPath, ["--import", "data:text/javascript,Date.now=(()=>{let n=-1000;return()=>--n})()", BIN, "serve", "--send", "--port", "0"], { cwd: root, env: process.env });
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("replacement start timeout")), 15000);
      let output = "";
      current.stdout.on("data", data => { output += data; const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//); if (match) { clearTimeout(timer); resolve(match[0]); } });
      current.on("exit", code => { clearTimeout(timer); reject(new Error("server exited " + code)); });
    });
    const version = await (await fetch(new URL("api/version", url))).json();
    assert.equal(version.feedbackOrder, 1);
    assert.notEqual(version.serverId, "clock-only");
    assert.notEqual(version.pid, old.pid);
    const html = await (await fetch(url)).text();
    const data = JSON.parse(/<script id="skeleton-data" type="application\/json">(.*?)<\/script>/s.exec(html)[1]);
    for (const verdict of ["approve", "changes"]) {
      const response = await fetch(new URL("api/feedback", url), { method: "POST", headers: { "content-type": "application/json", "x-skeleton-token": data.token }, body: JSON.stringify({ verdict, version: version.skeletonVersion, comments: [] }) });
      assert.equal(response.status, 204);
    }
    assert.equal(lastReview(root).unread, 2);
    assert.equal(lastReview(root).record.verdict, "changes");
    const drained = takeFeedback(root).records;
    assert.ok(drained[1].at < drained[0].at);
    assert.equal(mergeRecords(drained).verdict, "changes");
  } finally {
    if (current && current.exitCode === null) current.kill();
    if (old.exitCode === null) old.kill();
    await Promise.all([old, current].filter(Boolean).map(child => (child.exitCode !== null || child.signalCode !== null) ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve))));
  }
});
