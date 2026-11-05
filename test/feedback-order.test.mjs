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
  const oldState = process.env.XDG_STATE_HOME;
  const oldLocal = process.env.LOCALAPPDATA;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.XDG_STATE_HOME = path.join(root, "state");
  process.env.LOCALAPPDATA = path.join(root, "local");
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState; if (oldLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldLocal; });
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
  assert.match(merged.general, /send any old notes that still apply again/);
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
  const old = spawn(process.execPath, ["-e", 'const http=require("http");const server=http.createServer((req,res)=>res.end(JSON.stringify({serverId:"clock-only",pid:process.pid,feedbackEnabled:true,storeProtocol:2})));server.listen(0,"127.0.0.1",()=>console.log(server.address().port));']);
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
    const token = JSON.parse(fs.readFileSync(path.join(root, ".skeleton/serve.json"), "utf8")).token;
    const headers = { "x-skeleton-token": token };
    const version = await (await fetch(new URL("api/version", url), { headers })).json();
    assert.equal(version.feedbackOrder, 1);
    assert.notEqual(version.serverId, "clock-only");
    assert.notEqual(version.pid, old.pid);
    assert.equal(version.storeProtocol, 2);
    assert.equal(version.readAuth, 1);
    assert.equal((await fetch(new URL("api/data", url))).status, 401);
    assert.equal((await fetch(new URL("api/version", url), { headers: { "x-skeleton-token": "wrong" } })).status, 401);
    const data = await (await fetch(new URL("api/data", url), { headers })).json();
    assert.ok(data.skeletonVersion);
    for (const verdict of ["approve", "changes"]) {
      const response = await fetch(new URL("api/feedback", url), { method: "POST", headers: { "content-type": "application/json", "x-skeleton-token": token }, body: JSON.stringify({ verdict, version: version.skeletonVersion, comments: [] }) });
      assert.equal(response.status, 204);
    }
    assert.equal(lastReview(root).unread, 2);
    assert.equal(lastReview(root).record.verdict, "changes");
    const drained = takeFeedback(root).records;
    assert.ok(drained[1].at < drained[0].at);
    assert.equal(mergeRecords(drained).verdict, "changes");
    fs.writeFileSync(path.join(root, ".skeleton/state.json"), "{");
    const broken = await fetch(new URL("api/feedback", url), { method: "POST", headers: { "content-type": "application/json", "x-skeleton-token": token }, body: JSON.stringify({ verdict: "approve", comments: [] }) });
    assert.equal(broken.status, 503);
    const diagnostic = await broken.text();
    assert.ok(diagnostic.includes(path.join(root, ".skeleton/state.json")));
    assert.match(diagnostic, /external terminal/);
    const invalid = await fetch(new URL("api/feedback", url), { method: "POST", headers: { "content-type": "application/json", "x-skeleton-token": token }, body: "{" });
    assert.equal(invalid.status, 400);
  } finally {
    if (current && current.exitCode === null) current.kill();
    if (old.exitCode === null) old.kill();
    await Promise.all([old, current].filter(Boolean).map(child => (child.exitCode !== null || child.signalCode !== null) ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve))));
  }
});
test("async lock remains held through fulfillment or rejection; synchronous calls stay synchronous", async t => {
  const { root } = fixture(t);
  const listeners = process.listenerCount("exit");
  let release;
  const held = withFeedbackLock(root, async () => {
    await new Promise(resolve => { release = resolve; });
    return 42;
  });
  assert.throws(() => withFeedbackLock(root, () => "unexpected"), /locked/);
  release();
  assert.equal(await held, 42);
  assert.equal(withFeedbackLock(root, () => 7), 7);
  await assert.rejects(withFeedbackLock(root, async () => { throw new Error("rejected operation"); }), /rejected operation/);
  assert.equal(fs.existsSync(path.join(queueDir(root), ".order-lock")), false);
  assert.equal(process.listenerCount("exit"), listeners);
});
test("failed approve on legacy fill does not initialize a review round or rewrite state", t => {
  const { root, cli } = fixture(t);
  assert.equal(cli("approve").status, 0);
  const file = path.join(root, ".skeleton/state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  delete state.reviewRound;
  fs.writeFileSync(file, JSON.stringify(state));
  const before = fs.readFileSync(file, "utf8");
  const result = cli("approve");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already approved/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});
test("feedback wait terminates with a frozen wall clock", { timeout: 10000 }, t => {
  const { root } = fixture(t);
  const result = spawnSync(process.execPath, ["--import", "data:text/javascript,Date.now=()=>1", BIN, "feedback", "--wait", "0.1"], {
    cwd: root, env: process.env, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NO_FEEDBACK/);
});
test("CLI retains earlier round notes without canonical approval, current review wins without legacy nag", t => {
  const { root, cli } = fixture(t);
  assert.equal(cli("approve").status, 0);
  send(root, 10, "111111111111");
  assert.equal(cli("reshape").status, 0);
  const earlier = cli("feedback");
  assert.equal(earlier.status, 0, earlier.stderr);
  assert.match(earlier.stdout, /Earlier review round/);
  assert.doesNotMatch(earlier.stdout, /APPROVED/);
  assert.match(earlier.stdout, /Reviewed skeleton version: unknown/);
  assert.equal(cli("review").status, 0);
  const html = fs.readFileSync(path.join(root, ".skeleton/review.html"), "utf8");
  const data = JSON.parse(/<script id="skeleton-data" type="application\/json">(.*?)<\/script>/s.exec(html)[1]);
  send(root, 5, data.skeletonVersion);
  fs.writeFileSync(path.join(queueDir(root), "legacy.json"), JSON.stringify({ session: "known-session", at: 1000, version: "ffffffffffff", verdict: "changes", general: "old note" }));
  const current = cli("feedback");
  assert.match(current.stdout, /APPROVED/);
  assert.match(current.stdout, new RegExp(`Reviewed skeleton version: ${data.skeletonVersion}`));
  assert.match(current.stdout, /old note/);
  const approved = cli("approve");
  assert.equal(approved.status, 0, approved.stderr);
  assert.doesNotMatch(approved.stdout, /legacy feedback ordering is unknown/);
});
test("restored state without round never promotes queued modern approval", t => {
  const { root, cli } = fixture(t);
  send(root, 1, "111111111111");
  const file = path.join(root, ".skeleton/state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  delete state.reviewRound;
  fs.writeFileSync(file, JSON.stringify(state));
  const before = fs.readFileSync(file, "utf8");
  const result = cli("feedback");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /note/);
  assert.doesNotMatch(result.stdout, /Verdict: APPROVED/);
  assert.match(result.stdout, /Reviewed skeleton version: unknown/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});


test("status reports a present ordering lock read-only and approval recovers after external removal", t => {
  const { root, cli } = fixture(t);
  const lock = path.join(queueDir(root), ".order-lock");
  fs.mkdirSync(lock, { recursive: true });
  const before = fs.readFileSync(path.join(root, ".skeleton/state.json"), "utf8");
  const status = cli("status");
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes(lock));
  assert.match(status.stdout, /may be active/);
  assert.match(status.stdout, /stop all skel servers\/commands.*external terminal/);
  const json = cli("status", "--json");
  assert.equal(json.status, 0, json.stderr);
  assert.ok(JSON.parse(json.stdout).feedbackLockNotice.includes(lock));
  assert.equal(fs.lstatSync(lock).isDirectory(), true, "status never repairs the lock");
  assert.equal(fs.readFileSync(path.join(root, ".skeleton/state.json"), "utf8"), before);
  const blocked = cli("approve");
  assert.notEqual(blocked.status, 0);
  assert.ok(blocked.stderr.includes(lock));
  assert.match(blocked.stderr, /external terminal/);
  fs.rmdirSync(lock); // external repair, after the fixture's commands have exited
  assert.equal(JSON.parse(cli("status", "--json").stdout).feedbackLockNotice, undefined);
  const approved = cli("approve");
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(readState(root).phase, "fill");
});
