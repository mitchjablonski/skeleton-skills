import test from "node:test";
import assert from "node:assert/strict";
import { MAX_AUTHORITY_JOURNAL_ENTRIES, createAuthorityRecord, parseAuthorityRecord, planAuthorityTransaction } from "../lib/strict-authority.mjs";

const initial = () => ({ projectId: "p", sessionId: "s", reviewRoundId: "round1",
  phase: "skeleton", reviewVersion: "v1", approvedVersion: null, revision: 0 });
const intent = (changes = {}) => ({ protocolVersion: 1, requestId: "req1", action: "approve",
  projectId: "p", sessionId: "s", reviewRoundId: "round1", reviewVersion: "v1", expectedRevision: 0, ...changes });
const facts = (changes = {}) => ({ contentVersion: "v1", nextReviewRoundId: null, completionVerified: false, ...changes });
const fresh = () => createAuthorityRecord(initial());
const roundtrip = value => JSON.parse(JSON.stringify(value));
const approve = () => planAuthorityTransaction(fresh(), intent(), facts());

test("approve binds independent host content and plans one immutable whole-record commit", () => {
  const record = fresh(), request = intent(), host = facts();
  const before = JSON.stringify({ record, request, host });
  const tx = planAuthorityTransaction(record, request, host);
  assert.equal(tx.persist, true); assert.equal(tx.result.kind, "committed");
  assert.equal(tx.record.state.phase, "fill"); assert.equal(tx.record.state.approvedVersion, "v1");
  assert.equal(tx.record.state.revision, 1); assert.equal(tx.record.journal.length, 1);
  assert.equal(JSON.stringify({ record, request, host }), before);
  for (const v of [tx, tx.record, tx.record.state, tx.record.journal, tx.record.journal[0], tx.record.journal[0].facts]) assert.ok(Object.isFrozen(v));
  assert.deepEqual(parseAuthorityRecord(roundtrip(tx.record)), tx.record);
  const changed = planAuthorityTransaction(record, request, facts({ contentVersion: "v2" }));
  assert.equal(changed.result.code, "stale-review"); assert.equal(changed.record.state.reviewVersion, "v1");
  assert.equal(changed.record.state.revision, 0); assert.equal(changed.persist, true);
});

test("restart retry returns original result before revision or host facts; changed reuse refuses", () => {
  const committed = approve(), restarted = roundtrip(committed.record);
  const retry = planAuthorityTransaction(restarted, intent(), null);
  assert.deepEqual(retry.result, committed.result); assert.equal(retry.replayed, true); assert.equal(retry.persist, false);
  for (const changes of [{ action: "finalize" }, { expectedRevision: 1 }, { reviewVersion: "v2" }, { reviewRoundId: "round2" }]) {
    const reused = planAuthorityTransaction(restarted, intent(changes), facts());
    assert.equal(reused.result.code, "request-reused"); assert.equal(reused.persist, false);
  }
  // If no commit happened, replay from the old record produces the same plan.
  assert.deepEqual(planAuthorityTransaction(roundtrip(fresh()), intent(), facts()), committed);
});

test("terminal rejections survive restart, while unavailable and wrong-channel requests reserve nothing", () => {
  const rejected = planAuthorityTransaction(fresh(), intent(), facts({ contentVersion: "v2" }));
  assert.equal(rejected.persist, true); assert.equal(rejected.record.journal.length, 1);
  const retry = planAuthorityTransaction(roundtrip(rejected.record), intent(), facts());
  assert.equal(retry.result.code, "stale-review"); assert.equal(retry.replayed, true);
  assert.equal(retry.record.state.revision, 0);
  const next = planAuthorityTransaction(rejected.record, intent({ requestId: "req2" }), facts());
  assert.equal(next.result.kind, "committed"); assert.equal(next.record.state.revision, 1);
  assert.equal(next.record.journal.length, 2); assert.ok(parseAuthorityRecord(roundtrip(next.record)));
  const afterOtherCommit = planAuthorityTransaction(roundtrip(next.record), intent(), null);
  assert.equal(afterOtherCommit.result.code, "stale-review"); assert.equal(afterOtherCommit.replayed, true);
  assert.equal(afterOtherCommit.record.state.revision, 1);
  for (const tx of [planAuthorityTransaction(fresh(), intent(), null),
    planAuthorityTransaction(fresh(), intent({ sessionId: "other" }), facts()),
    planAuthorityTransaction(fresh(), {}, facts())]) {
    assert.equal(tx.persist, false); assert.equal(tx.record.journal.length, 0);
  }
});

test("reshape clears approval, rotates a fresh round, and requires a new human approval", () => {
  const fill = approve().record;
  const reshape = intent({ requestId: "req2", action: "reshape", expectedRevision: 1 });
  const next = planAuthorityTransaction(fill, reshape, facts({ contentVersion: "v2", nextReviewRoundId: "round2" }));
  assert.equal(next.result.kind, "committed");
  assert.deepEqual(next.record.state, { ...initial(), reviewRoundId: "round2", reviewVersion: "v2", revision: 2 });
  assert.equal(planAuthorityTransaction(fill, reshape, facts()).result.code, "invalid-transition");
  assert.equal(planAuthorityTransaction(fill, reshape, facts({ nextReviewRoundId: "round1" })).result.code, "invalid-transition");
  const reapprove = intent({ requestId: "req3", reviewRoundId: "round2", reviewVersion: "v2", expectedRevision: 2 });
  const approved = planAuthorityTransaction(next.record, reapprove, facts({ contentVersion: "v2" }));
  assert.equal(approved.result.kind, "committed");
  const reuseRound = planAuthorityTransaction(approved.record,
    { ...reapprove, requestId: "req4", action: "reshape", expectedRevision: 3 },
    facts({ contentVersion: "v3", nextReviewRoundId: "round1" }));
  assert.equal(reuseRound.result.code, "invalid-transition");
  assert.ok(parseAuthorityRecord(roundtrip(reuseRound.record)));
});

test("finalize requires independently verified completion and matching approved version", () => {
  const fill = approve().record;
  const request = intent({ requestId: "req2", action: "finalize", expectedRevision: 1 });
  assert.equal(planAuthorityTransaction(fill, request, facts()).result.code, "invalid-transition");
  assert.equal(planAuthorityTransaction(fill, request, facts({ contentVersion: "v2", completionVerified: true })).result.code, "stale-review");
  const done = planAuthorityTransaction(fill, request, facts({ completionVerified: true }));
  assert.equal(done.record.state.phase, "finalized"); assert.equal(done.record.state.revision, 2);
  assert.ok(parseAuthorityRecord(roundtrip(done.record)));
  assert.equal(planAuthorityTransaction(done.record, { ...request, requestId: "req3", expectedRevision: 2 }, facts({ completionVerified: true })).result.code, "invalid-transition");
});

test("round, revision and phase conflicts are terminal but do not advance revision", () => {
  for (const [changes, code] of [[{ reviewRoundId: "old" }, "stale-review"],
    [{ expectedRevision: 1 }, "revision-conflict"], [{ action: "reshape" }, "stale-review"]]) {
    const tx = planAuthorityTransaction(fresh(), intent(changes), facts());
    assert.equal(tx.result.code, code); assert.equal(tx.persist, true); assert.equal(tx.record.state.revision, 0);
    assert.ok(parseAuthorityRecord(roundtrip(tx.record)));
  }
});

test("corrupt history, mismatched state, duplicate request IDs and unsafe records refuse", () => {
  const committed = approve().record;
  const corrupt = mutate => { const v = roundtrip(committed); mutate(v); return v; };
  for (const value of [null, {}, { ...fresh(), extra: true },
    corrupt(v => { v.state.revision++; }), corrupt(v => { v.journal[0].result.revision++; }),
    corrupt(v => { v.journal[0].intent.reviewVersion = "other"; }),
    corrupt(v => { v.journal.push(v.journal[0]); }),
    corrupt(v => { delete v.journal[0]; }),
    corrupt(v => { v.journal[0].facts.contentVersion = "other"; }),
    corrupt(v => { v.initialState.phase = "fill"; v.initialState.approvedVersion = "v1"; })]) {
    assert.equal(parseAuthorityRecord(value), null);
    const tx = planAuthorityTransaction(value, intent(), facts());
    assert.equal(tx.result.code, "unavailable"); assert.equal(tx.persist, false); assert.equal(tx.record, null);
  }
  let called = false;
  const hostile = { ...fresh() }; Object.defineProperty(hostile, "journal", { get() { called = true; throw Error(); } });
  assert.equal(parseAuthorityRecord(hostile), null); assert.equal(called, false);
  const host = facts(); Object.defineProperty(host, "contentVersion", { get() { called = true; throw Error(); } });
  assert.equal(planAuthorityTransaction(fresh(), intent(), host).result.code, "unavailable"); assert.equal(called, false);
});

test("full journals retain exact retries and refuse new requests without pruning or reserving IDs", () => {
  const record = roundtrip(fresh());
  for (let n = 0; n < MAX_AUTHORITY_JOURNAL_ENTRIES; n++) {
    const request = intent({ requestId: `req${n}`, expectedRevision: 1 });
    record.journal.push({ intent: request, facts: facts(),
      result: { kind: "rejected", code: "revision-conflict", requestId: request.requestId }, stateAfter: initial() });
  }
  assert.ok(parseAuthorityRecord(record));
  const retry = planAuthorityTransaction(record, intent({ requestId: "req0", expectedRevision: 1 }), null);
  assert.equal(retry.replayed, true); assert.equal(retry.result.code, "revision-conflict");
  const newRequest = planAuthorityTransaction(record, intent({ requestId: "new" }), facts());
  assert.equal(newRequest.result.code, "unavailable"); assert.equal(newRequest.persist, false);
  assert.equal(newRequest.record.journal.length, MAX_AUTHORITY_JOURNAL_ENTRIES);
  assert.equal(newRequest.record.journal.some(e => e.intent.requestId === "new"), false);
  const oversized = { ...record, journal: new Array(MAX_AUTHORITY_JOURNAL_ENTRIES + 1) };
  assert.equal(parseAuthorityRecord(oversized), null);
});

const SHAPE2='a'.repeat(64), RAW2='b'.repeat(64), NEXT2='c'.repeat(64);
const initial2=()=>({...initial(),protocolVersion:2,reviewVersion:SHAPE2,captureVersion:RAW2,approvedCaptureVersion:null});
const intent2=(change={})=>({...intent(),protocolVersion:2,reviewVersion:SHAPE2,captureVersion:RAW2,...change});
const facts2=(change={})=>({...facts(),contentVersion:SHAPE2,captureVersion:RAW2,...change});
const fresh2=()=>createAuthorityRecord(initial2());
test('v2 approval binds independent shape and raw capture; exact retries survive changed facts',()=>{
  const approved=planAuthorityTransaction(fresh2(),intent2(),facts2());
  assert.equal(approved.result.kind,'committed');assert.equal(approved.result.protocolVersion,2);assert.equal(approved.result.captureVersion,RAW2);
  assert.equal(approved.record.protocolVersion,2);assert.equal(approved.record.state.approvedCaptureVersion,RAW2);
  assert.deepEqual(parseAuthorityRecord(roundtrip(approved.record)),approved.record);
  assert.deepEqual(planAuthorityTransaction(roundtrip(approved.record),intent2(),null).result,approved.result);
  assert.equal(planAuthorityTransaction(approved.record,intent2({captureVersion:NEXT2}),null).result.code,'request-reused');
  for(const change of [{captureVersion:NEXT2},{contentVersion:NEXT2}]) {
    const refusal=planAuthorityTransaction(fresh2(),intent2(),facts2(change));
    assert.equal(refusal.result.code,'stale-review');assert.equal(refusal.persist,true);assert.equal(refusal.record.state.revision,0);
    assert.equal(planAuthorityTransaction(roundtrip(refusal.record),intent2(),facts2()).result.code,'stale-review');
  }
  const downgraded=planAuthorityTransaction(fresh2(),intent(),facts());
  assert.equal(downgraded.result.code,'invalid-transition');assert.equal(downgraded.persist,false);
  assert.equal(planAuthorityTransaction(fresh2(),intent2(),facts()).result.code,'unavailable');
});
test('v2 reshape installs a new capture pair and finalize permits legitimate changed body bytes',()=>{
  const fill=planAuthorityTransaction(fresh2(),intent2(),facts2()).record;
  const reshape=intent2({requestId:'reshape',action:'reshape',expectedRevision:1});
  const next=planAuthorityTransaction(fill,reshape,facts2({contentVersion:NEXT2,captureVersion:'d'.repeat(64),nextReviewRoundId:'round2'}));
  assert.equal(next.result.kind,'committed');assert.equal(next.result.captureVersion,RAW2);
  assert.equal(next.record.state.reviewVersion,NEXT2);assert.equal(next.record.state.captureVersion,'d'.repeat(64));
  assert.equal(next.record.state.approvedVersion,null);assert.equal(next.record.state.approvedCaptureVersion,null);
  assert.ok(parseAuthorityRecord(roundtrip(next.record)));
  const finalize=intent2({requestId:'finalize',action:'finalize',expectedRevision:1});
  const completed=planAuthorityTransaction(fill,finalize,facts2({captureVersion:NEXT2,completionVerified:true}));
  assert.equal(completed.result.kind,'committed');assert.equal(completed.result.captureVersion,RAW2);
  assert.equal(completed.record.state.approvedCaptureVersion,RAW2);assert.equal(completed.record.state.phase,'finalized');
  assert.ok(parseAuthorityRecord(roundtrip(completed.record)));
  assert.equal(planAuthorityTransaction(fill,{...finalize,captureVersion:NEXT2},facts2({captureVersion:NEXT2,completionVerified:true})).result.code,'stale-review');
  assert.equal(planAuthorityTransaction(fill,finalize,facts2({contentVersion:NEXT2,completionVerified:true})).result.code,'stale-review');
  assert.equal(planAuthorityTransaction(fill,finalize,facts2({captureVersion:NEXT2})).result.code,'invalid-transition');
});
test('v2 records reject dropped capture fields, mismatched journal versions and downgrade envelopes',()=>{
  const tx=planAuthorityTransaction(fresh2(),intent2(),facts2()).record;
  for(const mutate of [v=>{v.protocolVersion=1;},v=>{delete v.state.captureVersion;},v=>{delete v.initialState.approvedCaptureVersion;},
    v=>{delete v.journal[0].intent.captureVersion;},v=>{delete v.journal[0].facts.captureVersion;},v=>{delete v.journal[0].result.captureVersion;},
    v=>{delete v.journal[0].stateAfter.approvedCaptureVersion;},v=>{v.journal[0].intent.protocolVersion=1;},
    v=>{delete v.journal[0].result.protocolVersion;},v=>{v.journal[0].facts.captureVersion=NEXT2;}]) {
    const corrupt=roundtrip(tx);mutate(corrupt);assert.equal(parseAuthorityRecord(corrupt),null);
    assert.equal(planAuthorityTransaction(corrupt,intent2(),facts2()).result.code,'unavailable');
  }
});

test('recapture journals unchanged revision-zero outcome and replays it after later changes',()=>{
 const req=intent2({action:'recapture'});const unchanged=planAuthorityTransaction(fresh2(),req,facts2());
 assert.equal(unchanged.result.kind,'recaptured');assert.equal(unchanged.result.changed,false);assert.equal(unchanged.result.revision,0);assert.equal(unchanged.persist,true);assert.equal(unchanged.record.journal.length,1);
 const changedReq=intent2({action:'recapture',requestId:'new'});
 const changed=planAuthorityTransaction(unchanged.record,changedReq,facts2({captureVersion:NEXT2}));
 assert.equal(changed.result.changed,true);assert.equal(changed.record.state.revision,1);assert.equal(changed.record.state.reviewVersion,SHAPE2);assert.equal(changed.record.state.captureVersion,NEXT2);
 assert.equal(changed.record.state.reviewRoundId,'round1');assert.equal(changed.record.state.approvedVersion,null);assert.equal(changed.record.state.approvedCaptureVersion,null);
 const restarted=roundtrip(changed.record);assert.ok(parseAuthorityRecord(restarted));assert.deepEqual(planAuthorityTransaction(restarted,req,null).result,unchanged.result);
 assert.equal(planAuthorityTransaction(restarted,intent2({requestId:'new'}),null).result.code,'request-reused');
 assert.equal(planAuthorityTransaction(restarted,intent2({action:'recapture',requestId:'race'}),facts2()).result.code,'revision-conflict');
 const approveReq=intent2({requestId:'approve',expectedRevision:1,captureVersion:NEXT2});const fill=planAuthorityTransaction(restarted,approveReq,facts2({captureVersion:NEXT2})).record;
 assert.deepEqual(planAuthorityTransaction(roundtrip(fill),req,null).result,unchanged.result);
 assert.equal(planAuthorityTransaction(fill,{...approveReq,action:'recapture'},null).result.code,'request-reused');
 const forbidden=planAuthorityTransaction(fill,intent2({action:'recapture',requestId:'forbidden',expectedRevision:2,captureVersion:NEXT2}),facts2({captureVersion:NEXT2}));
 assert.equal(forbidden.result.code,'invalid-transition');assert.equal(forbidden.persist,true);assert.ok(parseAuthorityRecord(roundtrip(forbidden.record)));
});
test('recapture validates host facts, v1 refusal, shape changes and common cap',()=>{
 const req=intent2({action:'recapture'});
 for(const change of [{nextReviewRoundId:'round2'},{completionVerified:true}])assert.equal(planAuthorityTransaction(fresh2(),req,facts2(change)).result.code,'invalid-transition');
 assert.equal(planAuthorityTransaction(fresh2(),{...req,protocolVersion:1},facts2()).result.code,'invalid-transition');
 const changed=planAuthorityTransaction(fresh2(),req,facts2({contentVersion:NEXT2}));assert.equal(changed.record.state.reviewVersion,NEXT2);assert.ok(parseAuthorityRecord(roundtrip(changed.record)));
 const record=roundtrip(fresh2());
 for(let n=0;n<MAX_AUTHORITY_JOURNAL_ENTRIES;n++){const r=intent2({action:'recapture',requestId:'cap'+n});record.journal.push({intent:r,facts:facts2(),result:{kind:'recaptured',action:'recapture',protocolVersion:2,requestId:r.requestId,reviewVersion:SHAPE2,captureVersion:RAW2,revision:0,changed:false},stateAfter:initial2()});}
 assert.ok(parseAuthorityRecord(record));assert.equal(planAuthorityTransaction(record,req,facts2()).result.code,'unavailable');assert.equal(planAuthorityTransaction(record,intent2({action:'recapture',requestId:'cap0'}),null).replayed,true);
});
