// Development-only controlled fixture integration. Caller must establish source
// quiescence before invocation; this helper neither verifies nor certifies it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { enumerateStrictManifest } from '../../lib/strict-enumeration.mjs';
import { captureStrictManifest, validateStoredCapture } from '../../lib/strict-capture.mjs';
import { createCaptureStore, openCaptureStore } from '../../lib/strict-capture-store.mjs';
import { createAuthorityStore, openAuthorityStore } from '../../lib/strict-authority-store.mjs';
import { parseAuthorityRecord } from '../../lib/strict-authority.mjs';

export const FIXTURE_PLAN = '// fixture exterior\n// SKEL[1] selected\ninitial\n// /SKEL[1]\n// SKEL[2] other\npreserved\n// /SKEL[2]\n';
export const FIXTURE_CONTEXT = 'controlled fixture context\n';
const MEMBERS = ['context.txt', 'plan.js'];
const MAX_BYTES = 1024 * 1024;
const mkdir = p => fs.mkdirSync(p, { mode: 0o700 });
const check = (condition,code) => { if(!condition) throw Object.assign(new Error(code),{code}); };
const equal = (a,b) => JSON.stringify(a)===JSON.stringify(b);
function ownedRoot(prefix) {
  assert.ok(['strict-candidate-inner-','strict-candidate-source-'].includes(prefix));
  const parent=fs.realpathSync(os.tmpdir());
  const root=fs.mkdtempSync(path.join(parent,prefix));
  fs.chmodSync(root,0o700);
  const token=randomUUID();
  exclusiveFile(path.join(root,'.fixture-owner'),Buffer.from(token),0o600);
  return {root,parent,prefix,token};
}
function cleanupOwned(owned) {
  const stat=fs.lstatSync(owned.root);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  const resolved=fs.realpathSync(owned.root);
  assert.equal(resolved,owned.root);
  assert.equal(path.dirname(resolved),owned.parent);
  const suffix=path.basename(resolved).slice(owned.prefix.length);
  assert.ok(path.basename(resolved).startsWith(owned.prefix) && /^[A-Za-z0-9]{6}$/.test(suffix));
  const marker=path.join(resolved,'.fixture-owner'), markerStat=fs.lstatSync(marker);
  assert.ok(markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink===1 && markerStat.size===36);
  assert.match(owned.token,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(fs.readFileSync(marker,'utf8'),owned.token);
  fs.rmSync(resolved,{recursive:true}); // Cleanup failure is a failed experiment.
}
function capture(root) {
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const enumeration = enumerateStrictManifest(fd);
    // No exclusions or extra members are admitted by this fixed experiment.
    check(equal(enumeration.manifest.map(f => f.path), MEMBERS),'FIXTURE_MEMBERS');
    assert.deepEqual(enumeration.exclusions, []);
    return { enumeration, capture: captureStrictManifest(fd, enumeration.manifest) };
  } finally { fs.closeSync(fd); }
}
function exclusiveFile(target, bytes, mode) {
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); } finally { fs.closeSync(fd); }
}
function copy(source, destination) {
  const stat = fs.lstatSync(source);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  check(equal(fs.readdirSync(source).sort(), MEMBERS),'FIXTURE_MEMBERS');
  mkdir(destination);
  for (const name of MEMBERS) {
    const from = path.join(source, name), before = fs.lstatSync(from);
    assert.ok(before.isFile() && before.nlink === 1 && before.size <= MAX_BYTES);
    const fd = fs.openSync(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const pinned = fs.fstatSync(fd);
      assert.equal(pinned.ino, before.ino); assert.equal(pinned.dev, before.dev);
      assert.ok(pinned.isFile() && pinned.nlink === 1 && pinned.size <= MAX_BYTES);
      const bytes = Buffer.alloc(pinned.size + 1);
      let size = 0;
      while (size < bytes.length) { const n = fs.readSync(fd, bytes, size, bytes.length-size, null); if (!n) break; size += n; }
      assert.equal(size, pinned.size);
      const after = fs.fstatSync(fd);
      for (const key of ['dev','ino','size','mode','mtimeMs','ctimeMs','nlink']) assert.equal(after[key], pinned[key]);
      exclusiveFile(path.join(destination,name), bytes.subarray(0,size), pinned.mode & 0o7777);
      const copied = fs.lstatSync(path.join(destination,name));
      assert.ok(copied.ino !== pinned.ino || copied.dev !== pinned.dev);
    } finally { fs.closeSync(fd); }
  }
  return capture(destination);
}
function materialize(store, pair, root) {
  let approved;
  try { approved = validateStoredCapture(store.get(pair.captureVersion)); }
  catch { check(false,'FIXTURE_CAPTURE_PAIR'); }
  check(approved.captureVersion===pair.captureVersion,'FIXTURE_CAPTURE_PAIR');
  check(approved.shapeVersion===pair.reviewVersion,'FIXTURE_REVIEW_PAIR');
  mkdir(root);
  for (const file of approved.files) {
    assert.ok(MEMBERS.includes(file.path));
    exclusiveFile(path.join(root,file.path), Buffer.from(file.text,'utf8'), file.unixMode);
  }
  assert.equal(capture(root).capture.captureVersion, approved.captureVersion);
  return approved;
}
function bodies(file) {
  return file.fences.map(f => file.display.slice(f.openLine, f.closeLine-1).map(l => l.text+l.ending).join(''));
}
export function assertSelectedFill(approvedValue, candidateValue) {
  const approved = validateStoredCapture(approvedValue), candidate = validateStoredCapture(candidateValue);
  check(equal(candidate.files.map(f => f.path),approved.files.map(f => f.path)),'FIXTURE_MEMBERS');
  let selectedChanged = false;
  for (let i=0;i<approved.files.length;i++) {
    const a=approved.files[i], b=candidate.files[i];
    check(a.mode===b.mode && a.unixMode===b.unixMode,'FIXTURE_MODE');
    if(a.path !== 'plan.js') { check(b.rawSha256===a.rawSha256,'FIXTURE_WHOLE'); continue; }
    check(equal(b.exterior,a.exterior),'FIXTURE_EXTERIOR');
    check(equal(b.fences.map(f=>[f.id,f.title]),a.fences.map(f=>[f.id,f.title])),'FIXTURE_FENCES');
    assert.equal(a.mode,'fenced'); assert.deepEqual(a.fences.map(f=>f.id),['1','2']);
    const oldBodies=bodies(a), newBodies=bodies(b);
    for(let n=0;n<a.fences.length;n++) {
      if(a.fences[n].id==='1') selectedChanged=oldBodies[n]!==newBodies[n];
      else check(newBodies[n]===oldBodies[n],'FIXTURE_OTHER_FENCE');
    }
  }
  check(selectedChanged,'FIXTURE_SELECTED_UNCHANGED');
  check(candidate.shapeVersion===approved.shapeVersion,'FIXTURE_SHAPE');
  return Object.freeze({selectedPath:'plan.js',selectedFence:'1',selectedBodyChanged:true});
}
export function runCandidateIntegration(source) {
  assert.equal(process.platform,'linux');
  const owned=ownedRoot('strict-candidate-inner-'), scratch=owned.root;
  const trace=[];
  try {
    const privateRoot=path.join(scratch,'candidate');
    const observed=copy(source,privateRoot); trace.push('private-copy','enumerate','independent-capture');
    const capturesPath=path.join(scratch,'captures');
    const captures=createCaptureStore(capturesPath);
    const stored=captures.put(observed.capture); trace.push('durable-capture-put');
    assert.equal(openCaptureStore(capturesPath).get(stored.captureVersion).captureVersion,stored.captureVersion);
    const authorityPath=path.join(scratch,'authority');
    const initial={protocolVersion:2,projectId:'fixture',sessionId:'fixture',reviewRoundId:'round',phase:'skeleton',reviewVersion:stored.shapeVersion,captureVersion:stored.captureVersion,approvedVersion:null,approvedCaptureVersion:null,revision:0};
    createAuthorityStore(authorityPath,initial); trace.push('authority-reference');
    const intent={protocolVersion:2,projectId:'fixture',sessionId:'fixture',reviewRoundId:'round',requestId:'mock-approve',action:'approve',reviewVersion:stored.shapeVersion,captureVersion:stored.captureVersion,expectedRevision:0};
    const result=openAuthorityStore(authorityPath).submit(intent,{contentVersion:stored.shapeVersion,captureVersion:stored.captureVersion,nextReviewRoundId:null,completionVerified:false});
    assert.equal(result.kind,'committed'); trace.push('mock-approve');
    // Single host writer, fixed local test lifetime; no concurrent state reader API claim.
    const record=parseAuthorityRecord(JSON.parse(fs.readFileSync(path.join(authorityPath,'authority.json'),'utf8')));
    assert.ok(record); assert.equal(record.state.phase,'fill');
    const pair={reviewVersion:record.state.approvedVersion,captureVersion:record.state.approvedCaptureVersion};
    const fillRoot=path.join(scratch,'fill');
    const approved=materialize(openCaptureStore(capturesPath),pair,fillRoot); trace.push('fresh-approved-capture-clone');
    const original=approved.files.find(f=>f.path==='plan.js').text;
    // Host-controlled mock fill only. This is not worker execution or completion verification.
    fs.writeFileSync(path.join(fillRoot,'plan.js'),original.replace('initial\n','filled\nsecond selected line\n'));
    const delta=assertSelectedFill(approved,capture(fillRoot).capture); trace.push('mock-fill-delta-checked');
    const negatives=[];
    const expectedCodes={'selected-unchanged':'FIXTURE_SELECTED_UNCHANGED',member:'FIXTURE_MEMBERS',mode:'FIXTURE_MODE',exterior:'FIXTURE_EXTERIOR','other-fence':'FIXTURE_OTHER_FENCE','whole-file':'FIXTURE_WHOLE','malformed-markers':'ENUM_MARKERS',symlink:'ENUM_TYPE',hardlink:'ENUM_TYPE'};
    const validFill=original.replace('initial\n','filled\nsecond selected line\n');
    for(const [name,mutate] of [
      ['selected-unchanged',()=>{}],
      ['member',r=>fs.writeFileSync(path.join(r,'extra.txt'),'extra')],
      ['mode',r=>fs.chmodSync(path.join(r,'plan.js'),fs.statSync(path.join(r,'plan.js')).mode ^ 0o100)],
      ['exterior',r=>fs.writeFileSync(path.join(r,'plan.js'),original.replace('fixture exterior','changed exterior').replace('initial\n','filled\n'))],
      ['other-fence',r=>fs.writeFileSync(path.join(r,'plan.js'),original.replace('initial\n','filled\n').replace('preserved\n','changed\n'))],
      ['whole-file',r=>fs.writeFileSync(path.join(r,'context.txt'),'changed context\n')],
      ['malformed-markers',r=>fs.writeFileSync(path.join(r,'plan.js'),original.replace('// /SKEL[1]','// /SKEL[9]'))],
      ['symlink',r=>{fs.unlinkSync(path.join(r,'context.txt'));fs.symlinkSync(path.join(privateRoot,'context.txt'),path.join(r,'context.txt'));}],
      ['hardlink',r=>{fs.unlinkSync(path.join(r,'context.txt'));fs.linkSync(path.join(privateRoot,'context.txt'),path.join(r,'context.txt'));}],
    ]) {
      const root=path.join(scratch,'negative-'+name); materialize(captures,pair,root);
      if(name!=='selected-unchanged') {
        fs.writeFileSync(path.join(root,'plan.js'),validFill);
        assertSelectedFill(approved,capture(root).capture); // Positive control before the targeted mutation.
      }
      mutate(root);
      assert.throws(()=>assertSelectedFill(approved,capture(root).capture),error=>error.code===expectedCodes[name],name); negatives.push(name);
    }
    // A second clone uses stored approved bytes despite prior mock fill.
    materialize(captures,pair,path.join(scratch,'fresh-again'));
    assert.throws(()=>materialize(captures,{...pair,reviewVersion:'0'.repeat(64)},path.join(scratch,'wrong-pair')),error=>error.code==='FIXTURE_REVIEW_PAIR'); negatives.push('wrong-review-pair');
    assert.throws(()=>materialize(captures,{...pair,captureVersion:'0'.repeat(64)},path.join(scratch,'wrong-capture')),error=>error.code==='FIXTURE_CAPTURE_PAIR'); negatives.push('wrong-capture-pair');
    return {ok:true,strictState:'unverified',scope:'controlled mock candidate integration; caller-established quiescence prerequisite',trace,delta,negativeCases:negatives,exactStoredClone:true,completionVerified:false};
  } finally { cleanupOwned(owned); }
}
// Fixed local fixture-session commands. The outer Python host owns this root
// across worker lifetimes; none of these paths is bound into the worker.
function sessionRoot(value, create=false) {
  check(path.isAbsolute(value),'FIXTURE_SESSION');
  const root=path.resolve(value), parent=path.dirname(root);
  check(path.basename(root)==='host-session' && fs.realpathSync(parent)===parent,'FIXTURE_SESSION');
  check(/^strict-candidate-probe-[A-Za-z0-9_-]{8}$/.test(path.basename(parent)),'FIXTURE_SESSION');
  const marker=path.join(parent,'.fixture-owner'), stat=fs.lstatSync(marker);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink===1,'FIXTURE_SESSION');
  check(/^[a-f0-9-]{36}$/.test(fs.readFileSync(marker,'utf8')),'FIXTURE_SESSION');
  if(create) { mkdir(root); exclusiveFile(path.join(root,'.fixture-session'),Buffer.from(randomUUID()),0o600); }
  check(fs.realpathSync(root)===root && !fs.lstatSync(root).isSymbolicLink(),'FIXTURE_SESSION');
  const token=fs.lstatSync(path.join(root,'.fixture-session'));
  check(token.isFile() && token.nlink===1 && token.size===36,'FIXTURE_SESSION');
  return root;
}
function approvedSession(root) {
  const record=parseAuthorityRecord(JSON.parse(fs.readFileSync(path.join(root,'authority','authority.json'),'utf8')));
  check(record?.state.protocolVersion===2 && record.state.phase==='fill','FIXTURE_APPROVAL');
  const pair={reviewVersion:record.state.approvedVersion,captureVersion:record.state.approvedCaptureVersion};
  const store=openCaptureStore(path.join(root,'captures'));
  const approved=validateStoredCapture(store.get(pair.captureVersion));
  check(approved.shapeVersion===pair.reviewVersion,'FIXTURE_REVIEW_PAIR');
  return {store,pair,approved};
}
function runSession(action,source,session,caseName) {
  const root=sessionRoot(session,action==='--prepare');
  if(action==='--prepare') {
    const observed=copy(source,path.join(root,'candidate'));
    const store=createCaptureStore(path.join(root,'captures'));
    const stored=store.put(observed.capture);
    check(openCaptureStore(path.join(root,'captures')).get(stored.captureVersion).captureVersion===stored.captureVersion,'FIXTURE_CAPTURE_PAIR');
    const initial={protocolVersion:2,projectId:'fixture',sessionId:'fixture',reviewRoundId:'round',phase:'skeleton',reviewVersion:stored.shapeVersion,captureVersion:stored.captureVersion,approvedVersion:null,approvedCaptureVersion:null,revision:0};
    const authority=createAuthorityStore(path.join(root,'authority'),initial);
    const result=authority.submit({protocolVersion:2,projectId:'fixture',sessionId:'fixture',reviewRoundId:'round',requestId:'mock-approve',action:'approve',reviewVersion:stored.shapeVersion,captureVersion:stored.captureVersion,expectedRevision:0},{contentVersion:stored.shapeVersion,captureVersion:stored.captureVersion,nextReviewRoundId:null,completionVerified:false});
    check(result.kind==='committed','FIXTURE_APPROVAL');
    approvedSession(root);
    return {ok:true,strictState:'unverified',action:'prepare',reviewVersion:stored.shapeVersion,captureVersion:stored.captureVersion,trace:['private-copy','enumerate','independent-capture','durable-capture-put','authority-reference','mock-approve']};
  }
  const {store,pair,approved}=approvedSession(root);
  if(action==='--seed') {
    // Destination must be the absent tree child of an existing outer-owned stage.
    check(path.isAbsolute(source) && path.basename(source)==='tree','FIXTURE_DESTINATION');
    const stage=path.dirname(source);
    check(path.dirname(stage)===path.dirname(root) && /^stage-[0-9]+$/.test(path.basename(stage)) && fs.realpathSync(stage)===stage,'FIXTURE_DESTINATION');
    materialize(store,pair,source);
    for(const file of approved.files) {
      const a=fs.statSync(path.join(source,file.path)), b=fs.statSync(path.join(root,'candidate',file.path));
      check(a.ino!==b.ino || a.dev!==b.dev,'FIXTURE_FRESH_INODE');
    }
    return {ok:true,strictState:'unverified',action:'seed',...pair,exactStoredClone:true};
  }
  check(action==='--check' && ['valid','exterior','member','mode'].includes(caseName),'FIXTURE_CASE');
  // Establish the positive fill control independently even when an added member
  // prevents the subsequent full-tree copy/enumeration from succeeding.
  const sourceFd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  let selectedPlan;
  try { selectedPlan=captureStrictManifest(sourceFd,[{path:'plan.js',mode:'fenced'}]).files[0]; }
  finally { fs.closeSync(sourceFd); }
  const baselinePlan=approved.files.find(file=>file.path==='plan.js');
  check(selectedPlan.fences[0]?.id==='1' && bodies(selectedPlan)[0]!==bodies(baselinePlan)[0],'FIXTURE_SELECTED_UNCHANGED');
  const codes={valid:null,exterior:'FIXTURE_EXTERIOR',member:'FIXTURE_MEMBERS',mode:'FIXTURE_MODE'};
  let refusal=null;
  try {
    const observed=copy(source,path.join(root,'checked-'+caseName));
    assertSelectedFill(approved,observed.capture);
  } catch(error) { refusal=error.code; if(!refusal) throw error; }
  check(refusal===codes[caseName],'FIXTURE_CASE_OUTCOME');
  return {ok:true,strictState:'unverified',action:'check',case:caseName,outcome:refusal?'rejected':'accepted',code:refusal,selectedBodyChanged:true,completionVerified:false};
}
function main() {
  let source,owned;
  try {
    if(['--prepare','--seed','--check'].includes(process.argv[2])) {
      const [action,source,session,caseName]=process.argv.slice(2);
      check(process.argv.length===(action==='--check'?6:5),'FIXTURE_ARGUMENTS');
      console.log(JSON.stringify(runSession(action,source,session,caseName))); return;
    }
    if(process.argv.length===3 && process.argv[2]==='--self-test') {
      owned=ownedRoot('strict-candidate-source-'); source=path.join(owned.root,'source'); mkdir(source);
      exclusiveFile(path.join(source,'plan.js'),Buffer.from(FIXTURE_PLAN),0o600);
      exclusiveFile(path.join(source,'context.txt'),Buffer.from(FIXTURE_CONTEXT),0o600);
    } else {
      assert.equal(process.argv.length,4); assert.equal(process.argv[2],'--source');
      source=process.argv[3]; assert.ok(path.isAbsolute(source));
    }
    console.log(JSON.stringify(runCandidateIntegration(source)));
  } catch(error) {
    console.log(JSON.stringify({ok:false,strictState:'unverified',code:'candidate-integration-failed',error:String(error.message).slice(0,1024)})); process.exitCode=1;
  } finally {
    if(owned) {
      try { cleanupOwned(owned); }
      catch(error) { console.error('owned fixture cleanup failed: '+String(error.message).slice(0,1024)); process.exitCode=1; }
    }
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main();
