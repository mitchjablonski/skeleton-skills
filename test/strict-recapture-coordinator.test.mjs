import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRecaptureCoordinator} from '../lib/strict-recapture-coordinator.mjs';
import {createAuthorityStore,openAuthorityStore} from '../lib/strict-authority-store.mjs';
import {createCaptureStore,openCaptureStore} from '../lib/strict-capture-store.mjs';
const OLD={"format":1,"shapeVersion":"ab6e4927ac2ff9e10d9223093c1df18103f890c3973225427a4df3357c217970","captureVersion":"622181ae3f44518a30bdf8dba8d77a8590a07ba0549898cbb03020d3fa452c32","totalBytes":3,"files":[{"path":"file","mode":"whole","unixMode":420,"text":"old","byteLength":3,"rawSha256":"cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4","exterior":["old"],"fences":[],"display":[{"line":1,"text":"old","ending":"","kind":"exterior"}]}]};
const NEW={"format":1,"shapeVersion":"67184eacd6a8603093886b2aa81525143a656cda2c2c64ee385ad35a06dbe539","captureVersion":"850af2e0f674e297caa4838539491c3a98111816f5f378e2a36938996234066d","totalBytes":3,"files":[{"path":"file","mode":"whole","unixMode":420,"text":"new","byteLength":3,"rawSha256":"11507a0e2f5e69d5dfa40a62a1bd7b6ee57e6bcd85c67c9b8431b36fff21c437","exterior":["new"],"fences":[],"display":[{"line":1,"text":"new","ending":"","kind":"exterior"}]}]};
const intent=(change={})=>({protocolVersion:2,requestId:'r',action:'recapture',projectId:'p',sessionId:'s',reviewRoundId:'round',reviewVersion:OLD.shapeVersion,captureVersion:OLD.captureVersion,expectedRevision:0,...change});
const reply=(capture=NEW,change={})=>({kind:'recaptured',requestId:'r',action:'recapture',protocolVersion:2,reviewVersion:capture.shapeVersion,captureVersion:capture.captureVersion,revision:1,changed:true,...change});
function memory(){const trace=[];const blobs=new Map([[OLD.captureVersion,OLD]]);let result=reply();const captures={get(id){trace.push('get:'+id);if(!blobs.has(id))throw Error();return blobs.get(id);},put(c){trace.push('put');blobs.set(c.captureVersion,c);return c;}};const authority={submit(i,f){trace.push(['submit',i,f]);return result;}};return {trace,blobs,captures,authority,setResult:r=>result=r,coordinator:createRecaptureCoordinator({authorityStore:authority,captureStore:captures})};}
test('publication precedes authority; canonical facts and historical result use their own blobs',()=>{
 const m=memory();assert.deepEqual(m.coordinator.recapture(intent(),NEW),reply());assert.equal(m.trace[0],'get:'+OLD.captureVersion);assert.equal(m.trace[1],'put');assert.deepEqual(m.trace[2][2],{contentVersion:NEW.shapeVersion,captureVersion:NEW.captureVersion,nextReviewRoundId:null,completionVerified:false});assert.equal(m.trace[3],'get:'+NEW.captureVersion);
 m.setResult(reply(OLD,{revision:0,changed:false}));assert.equal(m.coordinator.recapture(intent(),NEW).captureVersion,OLD.captureVersion);
 m.trace.length=0;assert.equal(m.coordinator.retry(intent()).captureVersion,OLD.captureVersion);assert.equal(m.trace[1][2],null);assert.equal(m.trace.some(x=>x==='put'),false);
});
test('bad input, prior blob or failed publication never reaches authority',()=>{
 for(const setup of [m=>m.blobs.clear(),m=>m.captures.put=()=>{throw Error();}]){const m=memory();setup(m);assert.equal(m.coordinator.recapture(intent(),NEW).code,'unavailable');assert.equal(m.trace.some(Array.isArray),false);}
 for(const change of [{protocolVersion:1},{action:'approve'},{extra:true}]){const m=memory();assert.equal(m.coordinator.recapture(intent(change),NEW).code,'unavailable');assert.equal(m.trace.length,0);}
 const m=memory();const bad=JSON.parse(JSON.stringify(NEW));bad.files[0].display[0].text='forged';assert.equal(m.coordinator.recapture(intent(),bad).code,'unavailable');assert.equal(m.trace.length,0);
});
test('wrong replies and missing historical captures refuse; orphan blobs are retained',()=>{
 for(const result of [reply(NEW,{requestId:'other'}),reply(NEW,{protocolVersion:1}),{kind:'rejected',code:'stale-review',requestId:'other'}]){const m=memory();m.setResult(result);assert.equal(m.coordinator.recapture(intent(),NEW).code,'unavailable');assert.ok(m.blobs.has(NEW.captureVersion));}
 const m=memory();m.setResult(reply(NEW));assert.equal(m.coordinator.retry(intent()).code,'unavailable');
 m.setResult({kind:'rejected',code:'revision-conflict',requestId:'r'});assert.equal(m.coordinator.recapture(intent(),NEW).code,'revision-conflict');assert.ok(m.blobs.has(NEW.captureVersion));
 m.authority.submit=()=>{throw Error();};assert.equal(m.coordinator.recapture(intent(),NEW).code,'unavailable');assert.ok(m.blobs.has(NEW.captureVersion));
});
test('real stores reopen exact unchanged and changed results after lost replies and later approval',{skip:process.platform!=='linux'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'skel-coordinator-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const cp=path.join(root,'captures'),ap=path.join(root,'authority');const captures=createCaptureStore(cp);captures.put(OLD);
 const authority=createAuthorityStore(ap,{projectId:'p',sessionId:'s',reviewRoundId:'round',phase:'skeleton',reviewVersion:OLD.shapeVersion,captureVersion:OLD.captureVersion,approvedVersion:null,approvedCaptureVersion:null,revision:0,protocolVersion:2});
 const lost=createRecaptureCoordinator({captureStore:captures,authorityStore:{submit(i,f){authority.submit(i,f);throw Error('lost reply');}}});assert.equal(lost.recapture(intent(),OLD).code,'unavailable');
 const reopen=()=>createRecaptureCoordinator({captureStore:openCaptureStore(cp),authorityStore:openAuthorityStore(ap)});const unchanged=reopen().retry(intent());assert.equal(unchanged.changed,false);assert.equal(unchanged.revision,0);
 const changed=reopen().recapture(intent({requestId:'next'}),NEW);assert.equal(changed.changed,true);assert.equal(changed.revision,1);
 const approval={...intent({requestId:'approve',action:'approve',expectedRevision:1}),reviewVersion:NEW.shapeVersion,captureVersion:NEW.captureVersion};assert.equal(openAuthorityStore(ap).submit(approval,{contentVersion:NEW.shapeVersion,captureVersion:NEW.captureVersion,nextReviewRoundId:null,completionVerified:false}).kind,'committed');assert.deepEqual(reopen().retry(intent()),unchanged);
 fs.unlinkSync(path.join(cp,OLD.captureVersion+'.json'));assert.equal(reopen().retry(intent()).code,'unavailable');assert.ok(fs.existsSync(path.join(cp,NEW.captureVersion+'.json')));
});
