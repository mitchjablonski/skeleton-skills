import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {captureStrictManifest} from '../lib/strict-capture.mjs';
import {createCaptureStore} from '../lib/strict-capture-store.mjs';
import {createHumanAuthorityStore,openHumanAuthorityStore} from '../lib/strict-human-authority-store.mjs';
import {HUMAN_AUTHORITY_POLICY} from '../lib/strict-human-authority.mjs';
import {deriveHumanCode} from '../lib/strict-human-command.mjs';
const linux=(name,fn)=>test(name,{skip:process.platform!=='linux'},fn);
function fixture(t,caps={}){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'human-writer-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const work=path.join(base,'work');fs.mkdirSync(work);fs.writeFileSync(path.join(work,'file'),'// SKEL[1] body\nreturn 1;\n// /SKEL[1]\n');
 const fd=fs.openSync(work,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);t.after(()=>fs.closeSync(fd));
 const observe=()=>captureStrictManifest(fd,[{path:'file',mode:'fenced'}]);const capture=observe();
 const captures=createCaptureStore(path.join(base,'captures'));captures.put(capture);
 const state={protocolVersion:2,projectId:'p',sessionId:'s',reviewRoundId:'r1',phase:'skeleton',revision:0,reviewVersion:capture.shapeVersion,captureVersion:capture.captureVersion,approvedVersion:null,approvedCaptureVersion:null};
 const enrollment={state,policy:{policyVersion:HUMAN_AUTHORITY_POLICY,roundMismatchCap:2,sessionMismatchCap:4,commandCap:20,authorityCap:10,...caps}};
 const count={observe:0,clock:0,key:0,epoch:0,round:0};let store;
 const deps={captureStore:captures,observeUnderLock(){count.observe++;assert.equal(fs.existsSync(path.join(dir,'.authority-lock')),true);return observe();},clock(){count.clock++;return '2026-11-13T12:00:00.000Z';},keyBytes(){count.key++;return Buffer.alloc(32,count.key);},epochId(){return 'e'+(++count.epoch);},roundId(){return 'r'+(1+(++count.round));}};
 const dir=path.join(base,'authority');store=createHumanAuthorityStore(dir,enrollment,deps);
 const record=()=>JSON.parse(fs.readFileSync(path.join(dir,'human-authority.json'),'utf8'));
 const command=(requestId,action='approve')=>{const r=record(),key=Buffer.from(r.epochs.at(-1).keyHex,'hex');return {requestId,action,code:deriveHumanCode(r.authority.state,action,key)};};
 return {base,dir,store,deps,count,record,command,capture,captures,enrollment,context:{projectId:'p',sessionId:'s'}};
}
linux('fixed human namespace, redacted handle and reopen preserve durable approval',t=>{
 const f=fixture(t);assert.deepEqual(Object.keys(f.store).sort(),['endSession','recapture','state','verifyAndCommit']);
 const c=f.command('approve'),result=f.store.verifyAndCommit(c);assert.equal(result.kind,'committed');
 assert.deepEqual(Object.keys(f.store.state()).sort(),['admissions','captureVersion','phase','reviewVersion','revision']);
 const before={...f.count};const reopened=openHumanAuthorityStore(f.dir,f.context,f.deps);assert.deepEqual(reopened.verifyAndCommit(c),result);assert.deepEqual(f.count,before);
 assert.equal(fs.existsSync(path.join(f.dir,'authority.json')),false);assert.throws(()=>createHumanAuthorityStore(f.dir,f.enrollment,f.deps));assert.throws(()=>openHumanAuthorityStore(f.dir,{projectId:'other',sessionId:'s'},f.deps));
 fs.writeFileSync(path.join(f.dir,'authority.json'),'{}');assert.throws(()=>openHumanAuthorityStore(f.dir,f.context,f.deps));
});
linux('mismatch, lockout, end and full ledger replay without observation or entropy',t=>{
 const f=fixture(t,{commandCap:4});const good=f.command('wrong');const wrong={...good,code:good.code==='0000-0000'?'1111-1111':'0000-0000'};
 const mismatch=f.store.verifyAndCommit(wrong);assert.equal(mismatch.kind,'mismatch');assert.equal(f.store.verifyAndCommit({...wrong,requestId:'wrong2'}).kind,'mismatch');assert.equal(f.store.verifyAndCommit(f.command('locked')).kind,'locked');
 const end=f.store.endSession({requestId:'end'});assert.equal(end.kind,'admissions-revoked');const before={...f.count};assert.deepEqual(f.store.verifyAndCommit(wrong),mismatch);assert.deepEqual(f.store.endSession({requestId:'end'}),end);assert.equal(f.store.endSession({requestId:'overflow'}).kind,'journal-full');assert.equal(f.store.recapture({requestId:'wrong'}).code,'request-reused');assert.deepEqual(f.count,before);assert.equal(f.count.observe,0);
});
linux('recapture publication, reshape epoch and historical approval survive logical end',t=>{
 const f=fixture(t);assert.equal(f.store.recapture({requestId:'same'}).changed,false);const a=f.command('a'),approved=f.store.verifyAndCommit(a);assert.equal(approved.kind,'committed');
 const reshape=f.command('reshape','reshape'),reshaped=f.store.verifyAndCommit(reshape);assert.equal(reshaped.kind,'committed');assert.equal(f.count.key,2);assert.equal(f.count.epoch,2);assert.equal(f.count.round,1);
 f.store.endSession({requestId:'end'});const before={...f.count};assert.deepEqual(f.store.verifyAndCommit(a),approved);assert.deepEqual(f.store.verifyAndCommit(reshape),reshaped);assert.deepEqual(f.count,before);
});
linux('historical missing blobs refuse acknowledgment without rewriting result',t=>{
 const f=fixture(t),c=f.command('a');assert.equal(f.store.verifyAndCommit(c).kind,'committed');const bytes=fs.readFileSync(path.join(f.dir,'human-authority.json'));fs.unlinkSync(path.join(f.captures.directory,f.capture.captureVersion+'.json'));const before={...f.count};assert.equal(f.store.verifyAndCommit(c).code,'unavailable');assert.deepEqual(fs.readFileSync(path.join(f.dir,'human-authority.json')),bytes);assert.deepEqual(f.count,before);
});
linux('after rename failure is unknown and reopened retry durabilizes retained result',t=>{
 const f=fixture(t),c=f.command('a');const faulty=openHumanAuthorityStore(f.dir,f.context,{...f.deps,storageOperations:{renameSync(from,to){fs.renameSync(from,to);throw Error('after rename');}}});
 assert.equal(faulty.verifyAndCommit(c).code,'unavailable');const before={...f.count};const result=openHumanAuthorityStore(f.dir,f.context,f.deps).verifyAndCommit(c);assert.equal(result.kind,'committed');assert.deepEqual(f.count,before);
 const noSync=openHumanAuthorityStore(f.dir,f.context,{...f.deps,storageOperations:{fsyncSync(){throw Error('sync');}}});assert.equal(noSync.verifyAndCommit(c).code,'unavailable');
});
linux('protected dependency methods captured once; leftover lock never expires',t=>{
 const f=fixture(t);f.deps.captureStore={get(){throw Error('mutated');}};f.deps.observeUnderLock=()=>{throw Error('mutated');};assert.equal(f.store.recapture({requestId:'same'}).kind,'recaptured');
 fs.mkdirSync(path.join(f.dir,'.authority-lock'),{mode:0o700});assert.equal(f.store.endSession({requestId:'end'}).code,'unavailable');assert.equal(fs.existsSync(path.join(f.dir,'.authority-lock')),true);
});
test('unsupported host refuses before path inspection',{skip:process.platform==='linux'},()=>{let touched=false;const dir={toString(){touched=true;throw Error();}};assert.throws(()=>createHumanAuthorityStore(dir,{},{}));assert.throws(()=>openHumanAuthorityStore(dir,{},{}));assert.equal(touched,false);});
linux('enrollment callbacks cannot replace validated state or policy; exact constructor own data',t=>{
 const f=fixture(t);const dir=path.join(f.base,'second');const enrollment=JSON.parse(JSON.stringify(f.enrollment));
 const deps={...f.deps,keyBytes(){enrollment.state.captureVersion='a'.repeat(64);enrollment.policy.commandCap=1;return Buffer.alloc(32,8);}};
 const handle=createHumanAuthorityStore(dir,enrollment,deps);assert.equal(handle.state().captureVersion,f.capture.captureVersion);const r=JSON.parse(fs.readFileSync(path.join(dir,'human-authority.json')));assert.equal(r.policy.commandCap,20);
 const accessor=Object.defineProperty({state:f.enrollment.state},'policy',{enumerable:true,get(){throw Error('must not execute');}});assert.throws(()=>createHumanAuthorityStore(path.join(f.base,'accessor'),accessor,deps));
 assert.throws(()=>openHumanAuthorityStore(f.dir,{...f.context,[Symbol('extra')]:1},f.deps));
});
linux('pre-rename and file fsync faults reserve no command; same identity can later commit',t=>{
 for(const mode of ['rename','file-sync']){
  const f=fixture(t),c=f.command('approve');let renamed=false;
  const faulty=openHumanAuthorityStore(f.dir,f.context,{...f.deps,storageOperations:{renameSync(from,to){if(mode==='rename')throw Error('before rename');renamed=true;fs.renameSync(from,to);},fsyncSync(fd){if(mode==='file-sync'&&fs.readlinkSync('/proc/self/fd/'+fd).endsWith('.tmp'))throw Error('before file sync');fs.fsyncSync(fd);}}});
  assert.equal(faulty.verifyAndCommit(c).code,'unavailable');assert.equal(renamed,false);assert.equal(f.record().commands.length,0);assert.equal(f.record().authority.journal.length,0);assert.equal(f.record().current.sessionMismatchCount,0);
  assert.equal(openHumanAuthorityStore(f.dir,f.context,f.deps).verifyAndCommit(c).kind,'committed');assert.equal(f.record().commands.length,1);assert.equal(f.record().authority.journal.length,1);
 }
});
linux('parent barrier and lock cleanup faults never acknowledge retained success',t=>{
 for(const mode of ['parent-sync','cleanup']){
  const f=fixture(t),c=f.command('approve'),parent=fs.statSync(f.base);let armed=true;
  const faulty=openHumanAuthorityStore(f.dir,f.context,{...f.deps,storageOperations:{fsyncSync(fd){const st=fs.fstatSync(fd);if(armed&&mode==='parent-sync'&&st.dev===parent.dev&&st.ino===parent.ino)throw Error('parent barrier');fs.fsyncSync(fd);}}});
  const original=fs.rmdirSync;
  if(mode==='cleanup')fs.rmdirSync=function(name,...args){if(name===path.join(f.dir,'.authority-lock')&&armed)throw Error('lock cleanup');return original.call(fs,name,...args);};
  try{assert.equal(faulty.verifyAndCommit(c).code,'unavailable');}finally{fs.rmdirSync=original;armed=false;}
  assert.equal(f.record().commands.length,1);assert.equal(f.record().authority.journal.length,1);assert.equal(f.record().current.sessionMismatchCount,0);const before={...f.count};
  if(mode==='cleanup'){
   // Deliberate test-host reconciliation after verifying the known retained record.
   assert.equal(fs.existsSync(path.join(f.dir,'.authority-lock')),true);assert.equal(f.store.verifyAndCommit(c).code,'unavailable');fs.rmdirSync(path.join(f.dir,'.authority-lock'));
  }
  assert.equal(openHumanAuthorityStore(f.dir,f.context,f.deps).verifyAndCommit(c).kind,'committed');assert.deepEqual(f.count,before);assert.equal(f.record().commands.length,1);
 }
});
linux('publication failure cannot introduce a capture reference and wrong code cannot observe',t=>{
 const f=fixture(t);const file=path.join(f.base,'work','file');fs.writeFileSync(file,'// SKEL[1] body\nreturn 2;\n// /SKEL[1]\n');
 let attempted=0;const protectedStore={get:f.captures.get,put(){attempted++;throw Error('publication failure');}};
 const failing=openHumanAuthorityStore(f.dir,f.context,{...f.deps,captureStore:protectedStore});const good=f.command('bad');const bad={...good,code:good.code==='0000-0000'?'1111-1111':'0000-0000'};
 assert.equal(failing.verifyAndCommit(bad).kind,'mismatch');assert.equal(f.count.observe,0);assert.equal(attempted,0);
 assert.equal(failing.recapture({requestId:'capture'}).code,'unavailable');assert.equal(attempted,1);assert.equal(f.count.observe,1);assert.equal(f.record().commands.length,1);assert.equal(f.record().authority.journal.length,0);assert.equal(f.record().authority.state.captureVersion,f.capture.captureVersion);assert.equal(f.record().current.sessionMismatchCount,1);
 assert.equal(openHumanAuthorityStore(f.dir,f.context,f.deps).recapture({requestId:'capture'}).kind,'recaptured');assert.equal(f.record().commands.length,2);assert.equal(f.record().authority.journal.length,1);
});
linux('reused reshape round journals core refusal without key or epoch generation',t=>{
 const f=fixture(t);assert.equal(f.store.verifyAndCommit(f.command('approve')).kind,'committed');const rejected=openHumanAuthorityStore(f.dir,f.context,{...f.deps,roundId:()=> 'r1'}),c=f.command('reshape','reshape');const before={...f.count};const result=rejected.verifyAndCommit(c);
 assert.equal(result.kind,'rejected');assert.equal(result.code,'invalid-transition');assert.equal(f.count.key,before.key);assert.equal(f.count.epoch,before.epoch);assert.equal(f.record().epochs.length,1);assert.equal(f.record().commands.length,2);assert.equal(f.record().authority.journal.length,2);assert.equal(f.record().authority.state.phase,'fill');const after={...f.count};assert.deepEqual(rejected.verifyAndCommit(c),result);assert.deepEqual(f.count,after);
});
linux('missing, corrupt, legacy and mixed namespaces never open or repair',t=>{
 for(const mode of ['missing','corrupt','legacy','mixed']){
  const f=fixture(t),file=path.join(f.dir,'human-authority.json');
  if(mode==='missing'||mode==='legacy')fs.unlinkSync(file);
  if(mode==='corrupt')fs.writeFileSync(file,'{"format":"forged"}');
  if(mode==='legacy'||mode==='mixed')fs.writeFileSync(path.join(f.dir,'authority.json'),'{}');
  const names=fs.readdirSync(f.dir),bytes=Object.fromEntries(names.map(n=>[n,fs.readFileSync(path.join(f.dir,n),'utf8')]));const before={...f.count};
  assert.throws(()=>openHumanAuthorityStore(f.dir,f.context,f.deps));assert.throws(()=>createHumanAuthorityStore(f.dir,f.enrollment,f.deps));assert.deepEqual(f.count,before);assert.deepEqual(fs.readdirSync(f.dir),names);for(const n of names)assert.equal(fs.readFileSync(path.join(f.dir,n),'utf8'),bytes[n]);
 }
});
linux('separate processes contend under observation lock and reopen one retained core decision',async t=>{
 const f=fixture(t),c=f.command('same'),worker=path.join(f.base,'worker.mjs');
 fs.writeFileSync(worker,`import fs from 'node:fs';
import {openHumanAuthorityStore} from ${JSON.stringify(new URL('../lib/strict-human-authority-store.mjs',import.meta.url).href)};
import {openCaptureStore} from ${JSON.stringify(new URL('../lib/strict-capture-store.mjs',import.meta.url).href)};
process.on('message',v=>{const captures=openCaptureStore(v.captures);const store=openHumanAuthorityStore(v.dir,{projectId:'p',sessionId:'s'},{captureStore:captures,observeUnderLock(){process.send({held:true});if(v.pause){const until=Date.now()+10000;while(!fs.existsSync(v.release)){if(Date.now()>until)throw Error('test host did not release observation');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}return captures.get(v.capture);},clock:()=> '2026-11-13T12:00:00.000Z'});const result=store.verifyAndCommit(v.command);process.send({result});setImmediate(()=>process.disconnect());});`);
 const launch=pause=>{
  const child=fork(worker,[],{stdio:['ignore','ignore','inherit','ipc']});t.after(()=>{if(child.connected)child.kill();});
  let onHeld;const held=new Promise(resolve=>{onHeld=resolve;});const done=new Promise((resolve,reject)=>{let result;child.on('message',v=>{if(v.held)onHeld();if(v.result)result=v.result;});child.once('error',reject);child.once('exit',code=>code===0?resolve(result):reject(Error('child exit '+code)));});
  child.send({pause,release:path.join(f.base,'release-observer'),dir:f.dir,captures:f.captures.directory,capture:f.capture.captureVersion,command:c});return {held,done};
 };
 const first=launch(true);await first.held;const second=launch(false);try{assert.equal((await second.done).code,'unavailable');}finally{fs.writeFileSync(path.join(f.base,'release-observer'),'release');}const committed=await first.done;assert.equal(committed.kind,'committed');
 const before={...f.count};assert.deepEqual(openHumanAuthorityStore(f.dir,f.context,f.deps).verifyAndCommit(c),committed);assert.deepEqual(f.count,before);assert.equal(f.record().commands.length,1);assert.equal(f.record().authority.journal.length,1);assert.equal(f.record().authority.state.revision,1);assert.equal(f.record().current.sessionMismatchCount,0);
});

linux('post-rename, release-directory and historical-record sync faults retain unknown outcomes',t=>{
 for(const mode of ['post-rename-directory','release-directory','historical-record']){
  const f=fixture(t),c=f.command('approve');
  if(mode==='historical-record')assert.equal(f.store.verifyAndCommit(c).kind,'committed');
  const directory=fs.statSync(f.dir),record=fs.statSync(path.join(f.dir,'human-authority.json'));
  let renamed=false,tripped=false;
  const faulty=openHumanAuthorityStore(f.dir,f.context,{...f.deps,storageOperations:{
   renameSync(from,to){fs.renameSync(from,to);renamed=true;},
   fsyncSync(fd){
    const stat=fs.fstatSync(fd),isDir=stat.dev===directory.dev&&stat.ino===directory.ino;
    const isRecord=stat.dev===record.dev&&stat.ino===record.ino;
    const held=fs.existsSync(path.join(f.dir,'.authority-lock'));
    const target=mode==='post-rename-directory'?renamed&&isDir&&held:mode==='release-directory'?renamed&&isDir&&!held:isRecord;
    if(target&&!tripped){tripped=true;throw Error('targeted durability barrier');}
    fs.fsyncSync(fd);
   }
  }});
  assert.equal(faulty.verifyAndCommit(c).code,'unavailable');assert.equal(tripped,true,'targeted barrier was reached');
  const retained=f.record();assert.equal(retained.commands.length,1);assert.equal(retained.authority.journal.length,1);
  assert.equal(retained.current.sessionMismatchCount,0);assert.equal(fs.existsSync(path.join(f.dir,'.authority-lock')),false);
  const before={...f.count},result=openHumanAuthorityStore(f.dir,f.context,f.deps).verifyAndCommit(c);
  assert.deepEqual(result,retained.commands[0].result);assert.deepEqual(f.count,before);
  assert.equal(f.record().commands.length,1);assert.equal(f.record().authority.journal.length,1);
 }
});
