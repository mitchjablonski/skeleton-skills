import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { createAuthorityStore, openAuthorityStore, inspectAuthorityStore } from "../lib/strict-authority-store.mjs";

const storeTest = (name, options, fn) => typeof options === "function"
  ? test(name, { skip: process.platform !== "linux" }, options)
  : test(name, { ...options, skip: process.platform !== "linux" }, fn);

const initial = () => ({ projectId: "p", sessionId: "s", reviewRoundId: "round1", phase: "skeleton",
  reviewVersion: "v1", approvedVersion: null, revision: 0 });
const request = (changes = {}) => ({ protocolVersion: 1, requestId: "req1", action: "approve",
  projectId: "p", sessionId: "s", reviewRoundId: "round1", reviewVersion: "v1", expectedRevision: 0, ...changes });
const facts = (changes = {}) => ({ contentVersion: "v1", nextReviewRoundId: null, completionVerified: false, ...changes });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skel-authority-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const dir = path.join(root, "private-authority");
  return { root, dir, record: () => JSON.parse(fs.readFileSync(path.join(dir, "authority.json"), "utf8")) };
}

storeTest("committed and terminal rejected outcomes survive reopened stores and lost replies", t => {
  const { dir, record } = fixture(t);
  const store = createAuthorityStore(dir, initial());
  const reject = store.submit(request(), facts({ contentVersion: "v2" }));
  assert.equal(reject.code, "stale-review"); assert.equal(record().state.revision, 0);
  assert.deepEqual(openAuthorityStore(dir).submit(request(), facts()), reject);
  const committed = store.submit(request({ requestId: "req2" }), facts());
  assert.equal(committed.kind, "committed"); assert.equal(committed.revision, 1);
  assert.deepEqual(openAuthorityStore(dir).submit(request({ requestId: "req2" }), null), committed);
  assert.equal(record().journal.length, 2);
  assert.equal(openAuthorityStore(dir).submit(request({ requestId: "req2", expectedRevision: 1 }), facts()).code, "request-reused");
  assert.equal(record().journal.length, 2);
});

storeTest("create and open are distinct and never repair missing or corrupt authority", t => {
  const { root, dir } = fixture(t);
  assert.throws(() => openAuthorityStore(dir));
  fs.mkdirSync(dir);
  assert.throws(() => openAuthorityStore(dir));
  assert.throws(() => createAuthorityStore(dir, initial()));
  fs.writeFileSync(path.join(dir, "authority.json"), "{");
  assert.throws(() => openAuthorityStore(dir));
  assert.throws(() => createAuthorityStore(dir, initial()));
  const other = path.join(root, "other");
  const store = createAuthorityStore(other, initial());
  fs.unlinkSync(path.join(other, "authority.json"));
  assert.equal(store.submit(request(), facts()).code, "unavailable");
  assert.equal(fs.existsSync(path.join(other, "authority.json")), false);
  fs.writeFileSync(path.join(other, "authority.json"), "{}");
  assert.equal(store.submit(request(), facts()).code, "unavailable");
  assert.equal(fs.readFileSync(path.join(other, "authority.json"), "utf8"), "{}");
  const fileDirectory = path.join(root, "not-a-directory"); fs.writeFileSync(fileDirectory, "data");
  assert.throws(() => openAuthorityStore(fileDirectory));
});

storeTest("existing locks refuse without cleanup or automatic expiry", t => {
  const { dir, record } = fixture(t);
  const store = createAuthorityStore(dir, initial());
  const lock = path.join(dir, ".authority-lock"); fs.mkdirSync(lock);
  fs.utimesSync(lock, new Date(0), new Date(0));
  assert.equal(store.submit(request(), facts()).code, "unavailable");
  assert.ok(fs.statSync(lock).isDirectory()); assert.equal(record().state.revision, 0);
});

storeTest("open and submit reject nonregular records and symlink directory/record", t => {
  const { root, dir } = fixture(t);
  const store = createAuthorityStore(dir, initial());
  const file = path.join(dir, "authority.json"), saved = path.join(root, "saved.json");
  fs.renameSync(file, saved); fs.mkdirSync(file);
  assert.throws(() => openAuthorityStore(dir)); assert.equal(store.submit(request(), facts()).code, "unavailable");
  fs.rmdirSync(file);
  try { fs.symlinkSync(saved, file, "file"); }
  catch (err) { if (err.code === "EPERM") { t.diagnostic("file symlink creation unavailable on this host"); return; } throw err; }
  assert.throws(() => openAuthorityStore(dir)); assert.equal(store.submit(request(), facts()).code, "unavailable");
  const alias = path.join(root, "alias"); fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => openAuthorityStore(alias));
});

storeTest("before-rename failure preserves old authority, reserves no ID, and never returns success", t => {
  const { dir, record } = fixture(t); createAuthorityStore(dir, initial());
  const store = openAuthorityStore(dir, { renameSync() { throw Error("injected before rename"); } });
  assert.equal(store.submit(request(), facts()).code, "unavailable");
  assert.equal(record().state.revision, 0); assert.equal(record().journal.length, 0);
  assert.deepEqual(fs.readdirSync(dir), ["authority.json"]);
  assert.equal(openAuthorityStore(dir).submit(request(), facts()).kind, "committed");
});

storeTest("after-rename failure is ambiguous unavailable and same-ID recovery returns the committed result", t => {
  const { dir, record } = fixture(t); createAuthorityStore(dir, initial());
  const store = openAuthorityStore(dir, { renameSync(from, to) { fs.renameSync(from, to); throw Error("lost reply after rename"); } });
  assert.equal(store.submit(request(), facts()).code, "unavailable");
  assert.equal(record().state.revision, 1); assert.equal(record().journal.length, 1);
  const retry = openAuthorityStore(dir).submit(request(), null);
  assert.equal(retry.kind, "committed"); assert.equal(retry.revision, 1); assert.equal(record().journal.length, 1);
});

storeTest("file fsync failure prevents rename; duplicate retry must also complete fsync", t => {
  const { dir, record } = fixture(t); createAuthorityStore(dir, initial());
  let renamed = false;
  const store = openAuthorityStore(dir, { fsyncSync(fd) {
    const name = fs.readlinkSync(`/proc/self/fd/${fd}`);
    if (name.endsWith(".tmp") || name.endsWith("/authority.json")) throw Error("injected fsync");
    fs.fsyncSync(fd);
  },
    renameSync(from, to) { renamed = true; fs.renameSync(from, to); } });
  assert.equal(store.submit(request(), facts()).code, "unavailable"); assert.equal(renamed, false);
  assert.equal(record().state.revision, 0);
  assert.equal(openAuthorityStore(dir).submit(request(), facts()).kind, "committed");
  assert.equal(store.submit(request(), null).code, "unavailable");
  assert.equal(record().journal.length, 1);
});

storeTest("Linux parent fsync failure after rename never reports committed", t => {
  const { dir, record } = fixture(t); createAuthorityStore(dir, initial());
  let renamed = false;
  const store = openAuthorityStore(dir, { fsyncSync(fd) {
    if (renamed && fs.fstatSync(fd).isDirectory()) throw Error("injected directory fsync");
    fs.fsyncSync(fd);
  }, renameSync(from, to) { fs.renameSync(from, to); renamed = true; } });
  assert.equal(store.submit(request(), facts()).code, "unavailable"); assert.equal(record().state.revision, 1);
  assert.equal(store.submit(request(), null).code, "unavailable");
  assert.equal(openAuthorityStore(dir).submit(request(), null).kind, "committed");
});

storeTest("failed enrollment parent fsync must recover before reopened submits or retries acknowledge", t => {
  const { root, dir, record } = fixture(t);
  const parent = fs.statSync(root);
  let failParent = true, parentSyncs = 0;
  const io = { fsyncSync(fd) {
    const stat = fs.fstatSync(fd);
    if (stat.dev === parent.dev && stat.ino === parent.ino) {
      parentSyncs++;
      if (failParent) throw Error("injected enrollment parent fsync");
    }
    fs.fsyncSync(fd);
  } };
  assert.throws(() => createAuthorityStore(dir, initial(), io), /enrollment parent fsync/);
  assert.equal(record().state.revision, 0); assert.equal(parentSyncs, 1);
  const reopened = openAuthorityStore(dir, io);
  assert.equal(reopened.submit(request(), facts()).code, "unavailable");
  assert.equal(record().state.revision, 1); assert.equal(parentSyncs, 2);
  // The record is visible and the intent is already journaled; neither fact
  // can substitute for persisting the store's own directory entry.
  assert.equal(openAuthorityStore(dir, io).submit(request(), null).code, "unavailable");
  assert.equal(parentSyncs, 3); assert.equal(record().journal.length, 1);
  failParent = false;
  const retry = openAuthorityStore(dir, io).submit(request(), null);
  assert.equal(retry.kind, "committed"); assert.equal(retry.revision, 1);
  assert.equal(parentSyncs, 4); assert.equal(record().journal.length, 1);
});

storeTest("cooperating processes reread under lock and commit exactly one competing revision", { timeout: 10_000 }, async t => {
  const { root, dir, record } = fixture(t); createAuthorityStore(dir, initial());
  const modulePath = new URL("../lib/strict-authority-store.mjs", import.meta.url).href;
  const worker = path.join(root, "worker.mjs");
  fs.writeFileSync(worker, `import { openAuthorityStore } from ${JSON.stringify(modulePath)};
const store = openAuthorityStore(process.argv[2]);
process.send('ready');
process.on('message', ({request,facts}) => { process.send(store.submit(request,facts)); process.disconnect(); });\n`);
  const children = [0, 1].map(() => fork(worker, [dir], { stdio: ["ignore", "pipe", "pipe", "ipc"] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const ready = child => new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", code => { if (code) reject(Error(`worker exit ${code}`)); }); });
  await Promise.all(children.map(ready));
  const replies = children.map(child => new Promise((resolve, reject) => {
    child.once("message", resolve); child.once("error", reject);
    child.once("exit", code => reject(Error(`worker exited before response: ${code}`)));
  }));
  children.forEach((child, n) => child.send({ request: request({ requestId: `race${n}` }), facts: facts() }));
  const results = await Promise.all(replies);
  assert.equal(results.filter(r => r.kind === "committed").length, 1);
  assert.ok(results.filter(r => r.kind === "rejected").every(r => ["unavailable", "revision-conflict"].includes(r.code)));
  assert.equal(record().state.revision, 1);
  assert.equal(record().journal.filter(e => e.result.kind === "committed").length, 1);
});

storeTest("trusted path permissions and replaced ancestors refuse", t => {
  const { root, dir } = fixture(t); const store = createAuthorityStore(dir, initial());
  for (const target of [dir, path.join(dir, "authority.json"), root]) {
    const mode = fs.statSync(target).mode & 0o777;
    fs.chmodSync(target, mode | 0o020);
    assert.throws(() => openAuthorityStore(dir));
    assert.equal(store.submit(request(), facts()).code, "unavailable");
    fs.chmodSync(target, mode);
  }
  const moved = root + "-moved";
  fs.renameSync(root, moved); fs.symlinkSync(moved, root);
  try { assert.throws(() => openAuthorityStore(dir)); }
  finally { fs.unlinkSync(root); fs.renameSync(moved, root); }
});

storeTest("inspection distinguishes held, PID reuse, old boot and unknown without mutation", t => {
  const { dir } = fixture(t); const store = createAuthorityStore(dir, initial());
  assert.equal(inspectAuthorityStore(dir).lock, "absent");
  const lock = path.join(dir, ".authority-lock"); fs.mkdirSync(lock, { mode: 0o700 });
  assert.equal(inspectAuthorityStore(dir).lock, "unknown");
  const file = path.join(lock, "holder.json");
  const startTime = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ").at(-1).split(" ")[19];
  const live = { pid: process.pid, bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), startTime };
  const write = v => fs.writeFileSync(file, JSON.stringify(v), { mode: 0o600 });
  write(live); assert.equal(inspectAuthorityStore(dir).lock, "held");
  write({ ...live, startTime: "0" }); assert.equal(inspectAuthorityStore(dir).lock, "abandoned");
  write({ ...live, bootId: "00000000-0000-0000-0000-000000000000" }); assert.equal(inspectAuthorityStore(dir).lock, "abandoned");
  write({}); assert.equal(inspectAuthorityStore(dir).lock, "unknown");
  const before = fs.readFileSync(file, "utf8");
  assert.equal(store.submit(request(), facts()).code, "unavailable");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  fs.unlinkSync(file); fs.rmdirSync(lock); fs.symlinkSync(path.join(dir, "missing"), lock);
  assert.equal(inspectAuthorityStore(dir).lock, "unknown", "dangling lock isn't absent");
});

storeTest("process crash after temporary fsync preserves inspectable lock and owned temp", { timeout: 10000 }, async t => {
  const { root, dir, record } = fixture(t); createAuthorityStore(dir, initial());
  const worker = path.join(root, "crash.mjs");
  fs.writeFileSync(worker, `import fs from 'node:fs';
import {openAuthorityStore} from ${JSON.stringify(new URL("../lib/strict-authority-store.mjs", import.meta.url).href)};
const store=openAuthorityStore(process.argv[2], {fsyncSync(fd) { fs.fsyncSync(fd); const name=fs.readlinkSync('/proc/self/fd/'+fd); if(name.endsWith('.tmp')) process.exit(71); }});
store.submit(${JSON.stringify(request())}, ${JSON.stringify(facts())});`);
  const child = fork(worker, [dir], { stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => { assert.equal(code, 71); resolve(); }); });
  const inspection = inspectAuthorityStore(dir);
  assert.equal(inspection.lock, "abandoned"); assert.equal(inspection.orphanTemps.length, 1);
  const temp = path.join(dir, inspection.orphanTemps[0]); fs.chmodSync(temp, 0o666);
  assert.deepEqual(inspectAuthorityStore(dir).orphanTemps, []);
  assert.equal(openAuthorityStore(dir).submit(request(), facts()).code, "unavailable");
  assert.equal(record().state.revision, 0); assert.ok(fs.existsSync(path.join(dir, ".authority-lock", "holder.json")));
});

test("unsupported platforms refuse before touching supplied paths or initial state", { skip: process.platform === "linux" }, () => {
  let touched = false;
  const hostile = new Proxy({}, { get() { touched = true; throw Error("path accessed"); },
    getOwnPropertyDescriptor() { touched = true; throw Error("state accessed"); } });
  assert.throws(() => createAuthorityStore(hostile, hostile), /requires Linux/);
  assert.throws(() => openAuthorityStore(hostile), /requires Linux/);
  assert.equal(touched, false);
});

storeTest('v2 exact-capture commits and terminal refusals survive stored reopen without downgrade',t=>{
  const {dir,record}=fixture(t);const shape='a'.repeat(64),raw='b'.repeat(64),other='c'.repeat(64);
  const state={...initial(),protocolVersion:2,reviewVersion:shape,captureVersion:raw,approvedCaptureVersion:null};
  const req={...request(),protocolVersion:2,reviewVersion:shape,captureVersion:raw};
  const host={...facts(),contentVersion:shape,captureVersion:raw};
  createAuthorityStore(dir,state);
  const refused=openAuthorityStore(dir).submit(req,{...host,captureVersion:other});assert.equal(refused.code,'stale-review');
  assert.deepEqual(openAuthorityStore(dir).submit(req,null),refused);
  const accepted={...req,requestId:'accepted'};const result=openAuthorityStore(dir).submit(accepted,host);
  assert.equal(result.kind,'committed');assert.equal(result.protocolVersion,2);assert.equal(result.captureVersion,raw);
  assert.deepEqual(openAuthorityStore(dir).submit(accepted,null),result);
  assert.equal(openAuthorityStore(dir).submit({...accepted,captureVersion:other},null).code,'request-reused');
  assert.equal(record().protocolVersion,2);assert.equal(record().state.approvedCaptureVersion,raw);
  const corrupt=record();delete corrupt.journal[1].result.captureVersion;
  fs.writeFileSync(path.join(dir,'authority.json'),JSON.stringify(corrupt));assert.throws(()=>openAuthorityStore(dir));
});
