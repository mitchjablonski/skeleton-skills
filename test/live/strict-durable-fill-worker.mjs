// Development-only protected-host fixture; injected codes are not human approval evidence.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {enumerateStrictManifest} from '../../lib/strict-enumeration.mjs';
import {captureStrictManifest} from '../../lib/strict-capture.mjs';
import {createCaptureStore,openCaptureStore} from '../../lib/strict-capture-store.mjs';
import {createHumanAuthorityStore,openHumanAuthorityStore} from '../../lib/strict-human-authority-store.mjs';
import {HUMAN_AUTHORITY_POLICY} from '../../lib/strict-human-authority.mjs';
import {deriveHumanCode} from '../../lib/strict-human-command.mjs';
import {createControlConsole,CONSOLE_COPY} from '../../lib/strict-control-console.mjs';
import {assertSelectedFill} from './strict-candidate-inner.mjs';
const [action,source,session,caseName]=process.argv.slice(2);
const members=['context.txt','plan.js'];
function capture(root){const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{const e=enumerateStrictManifest(fd);assert.deepEqual(e.manifest.map(f=>f.path),members);assert.deepEqual(e.exclusions,[]);return captureStrictManifest(fd,e.manifest);}finally{fs.closeSync(fd);}}
function record(){return JSON.parse(fs.readFileSync(path.join(session,'authority','human-authority.json'),'utf8'));}
function fail(){throw Error('replay invoked protected observation or entropy');}
function validateRoot(){assert.ok(path.isAbsolute(session));assert.equal(path.basename(session),'host-session');const parent=path.dirname(session);assert.equal(fs.realpathSync(parent),parent);assert.match(path.basename(parent),/^strict-candidate-probe-[A-Za-z0-9_-]{8}$/);const st=fs.lstatSync(path.join(parent,'.fixture-owner'));assert.ok(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1);assert.match(fs.readFileSync(path.join(parent,'.fixture-owner'),'utf8'),/^[a-f0-9-]{36}$/);}
try{
 assert.equal(process.platform,'linux');assert.ok(['--prepare','--seed','--check'].includes(action));assert.equal(process.argv.length,action==='--check'?6:5);validateRoot();
 let answer;
 if(action==='--prepare'){
  fs.mkdirSync(session,{mode:0o700});const staged=path.join(session,'candidate');fs.mkdirSync(staged,{mode:0o700});
  // Outer host created source and has not admitted workers: fixed host-quiescent copy.
  capture(source);
  for(const name of members){const from=path.join(source,name),st=fs.lstatSync(from);assert.ok(st.isFile()&&st.nlink===1&&!st.isSymbolicLink());fs.copyFileSync(from,path.join(staged,name),fs.constants.COPYFILE_EXCL);fs.chmodSync(path.join(staged,name),st.mode&0o777);}
  const observed=capture(staged),captures=createCaptureStore(path.join(session,'captures'));captures.put(observed);
  const dir=path.join(session,'authority');let observations=0;
  const state={protocolVersion:2,projectId:'fixture',sessionId:'fixture',reviewRoundId:'round',phase:'skeleton',reviewVersion:observed.shapeVersion,captureVersion:observed.captureVersion,approvedVersion:null,approvedCaptureVersion:null,revision:0};
  const store=createHumanAuthorityStore(dir,{state,policy:{policyVersion:HUMAN_AUTHORITY_POLICY,roundMismatchCap:2,sessionMismatchCap:4,commandCap:20,authorityCap:10}},{captureStore:captures,observeUnderLock(){assert.ok(fs.statSync(path.join(dir,'.authority-lock')).isDirectory());observations++;return capture(staged);}});
  const r=record(),key=Buffer.from(r.epochs.at(-1).keyHex,'hex');
  const code=deriveHumanCode(r.authority.state,'approve',key);let writer=store,command,result,sends=0,ids=0;
  const control=createControlConsole({newRequestId(){ids++;return 'fixture-injected-approve';},authority:{verifyAndCommit(args){
   sends++;const reply=writer.verifyAndCommit(args);assert.equal(reply.kind,'committed');
   if(sends===1){command={...args};result=reply;throw Error('fixture dropped committed response');}
   assert.deepEqual(args,command);assert.deepEqual(reply,result);return reply;
  }}});
  assert.deepEqual(await control.handle('approve '+code),[CONSOLE_COPY.unknownOutcome]);
  const committedBytes=fs.readFileSync(path.join(dir,'human-authority.json'));
  writer=openHumanAuthorityStore(dir,{projectId:'fixture',sessionId:'fixture'},{captureStore:openCaptureStore(path.join(session,'captures')),observeUnderLock:fail,clock:fail,keyBytes:fail,epochId:fail,roundId:fail});
  await control.handle('retry');assert.match((await control.handle('yes'))[0],/^Recorded: approve/);
  assert.equal(control.kept(),null);assert.equal(sends,2);assert.equal(ids,1);assert.equal(observations,1);
  assert.deepEqual(fs.readFileSync(path.join(dir,'human-authority.json')),committedBytes);
  const after=record();assert.equal(after.commands.length,1);assert.equal(after.authority.journal.length,1);assert.equal(after.authority.state.phase,'fill');
  fs.writeFileSync(path.join(session,'fixture-command.json'),JSON.stringify({command,result}),{mode:0o600,flag:'wx'});
  answer={ok:true,strictState:'unverified',action:'prepare',reviewVersion:observed.shapeVersion,captureVersion:observed.captureVersion,trace:['private-copy','enumerate','independent-capture','durable-capture-put','authority-reference','protected-observer-under-lock','console-injected-approve','lost-approval-response','console-same-id-retry']};
 }else{
  const captures=openCaptureStore(path.join(session,'captures')),saved=JSON.parse(fs.readFileSync(path.join(session,'fixture-command.json'),'utf8'));
  const before=fs.readFileSync(path.join(session,'authority','human-authority.json'));
  const store=openHumanAuthorityStore(path.join(session,'authority'),{projectId:'fixture',sessionId:'fixture'},{captureStore:captures,observeUnderLock:fail,clock:fail,keyBytes:fail,epochId:fail,roundId:fail});
  assert.deepEqual(store.verifyAndCommit(saved.command),saved.result);assert.ok(fs.readFileSync(path.join(session,'authority','human-authority.json')).equals(before),'durable record changed on replay');
  const r=record(),s=r.authority.state;assert.equal(s.phase,'fill');const approved=captures.get(s.approvedCaptureVersion);assert.equal(approved.shapeVersion,s.approvedVersion);
  if(action==='--seed'){
   assert.equal(path.basename(source),'tree');assert.equal(path.dirname(path.dirname(source)),path.dirname(session));assert.match(path.basename(path.dirname(source)),/^stage-[0-9]+$/);assert.equal(fs.realpathSync(path.dirname(source)),path.dirname(source));
   fs.mkdirSync(source,{mode:0o700});for(const f of approved.files){assert.ok(members.includes(f.path));fs.writeFileSync(path.join(source,f.path),f.text,{mode:f.unixMode,flag:'wx'});fs.chmodSync(path.join(source,f.path),f.unixMode);const a=fs.statSync(path.join(source,f.path)),b=fs.statSync(path.join(session,'candidate',f.path));assert.ok(a.ino!==b.ino||a.dev!==b.dev);}
   assert.equal(capture(source).captureVersion,approved.captureVersion);
   answer={ok:true,strictState:'unverified',action:'seed',reviewVersion:s.approvedVersion,captureVersion:s.approvedCaptureVersion,exactStoredClone:true};
  }else{
   assert.ok(['valid','exterior'].includes(caseName));const candidate=capture(source);let refusal=null;try{assertSelectedFill(approved,candidate);}catch(e){if(!e.code)throw e;refusal=e.code;}
   assert.equal(refusal,caseName==='valid'?null:'FIXTURE_EXTERIOR');
   // The negative control must still execute the selected-body edit.
   assert.ok(candidate.files.find(f=>f.path==='plan.js').text.includes('filled!'));
   answer={ok:true,strictState:'unverified',action:'check',case:caseName,outcome:refusal?'rejected':'accepted',code:refusal,selectedBodyChanged:true,completionVerified:false};
  }
 }
 console.log(JSON.stringify(answer));
}catch(e){console.log(JSON.stringify({ok:false,strictState:'unverified',error:String(e.message).slice(0,1024)}));process.exitCode=1;}

