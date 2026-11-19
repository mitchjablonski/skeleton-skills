// Development fixture: same-uid host peers and injected bootstrap, not human proof.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {enumerateStrictManifest} from '../../lib/strict-enumeration.mjs';
import {captureStrictManifest} from '../../lib/strict-capture.mjs';
import {createCaptureStore,openCaptureStore} from '../../lib/strict-capture-store.mjs';
import {createHumanAuthorityStore,openHumanAuthorityStore} from '../../lib/strict-human-authority-store.mjs';
import {HUMAN_AUTHORITY_POLICY} from '../../lib/strict-human-authority.mjs';
import {deriveHumanCode} from '../../lib/strict-human-command.mjs';
import {createHumanCommandServer,createHumanCommandClient} from '../../lib/strict-human-channel.mjs';
const [mode,root,rawFd,round]=process.argv.slice(2);
const authority=path.join(root,'authority'),record=path.join(authority,'human-authority.json'),bootstrap=path.join(root,'bootstrap.json');
const readinessExpected=path.join(root,'readiness-expected.json');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const fail=()=>{throw Error('forbidden replay callback');};
function capture(){const fd=fs.openSync(path.join(root,'candidate'),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{const e=enumerateStrictManifest(fd);assert.deepEqual(e.manifest.map(f=>f.path),['context.txt','plan.js']);assert.deepEqual(e.exclusions,[]);return captureStrictManifest(fd,e.manifest);}finally{fs.closeSync(fd);}}
function output(value){console.log(JSON.stringify({ok:true,strictState:'unverified',...value}));}
try{
 assert.equal(process.platform,'linux');assert.ok(path.isAbsolute(root));assert.equal(fs.statSync(root).mode&0o777,0o700);
 if(mode==='prepare'){
  const candidate=path.join(root,'candidate');fs.mkdirSync(candidate,{mode:0o700});
  fs.writeFileSync(path.join(candidate,'plan.js'),'// SKEL[1] selected\ninitial\n// /SKEL[1]\n',{mode:0o600});fs.writeFileSync(path.join(candidate,'context.txt'),'controlled fixture context\n',{mode:0o600});
  const observed=capture(),captures=createCaptureStore(path.join(root,'captures'));captures.put(observed);
  const state={protocolVersion:2,projectId:'fixture',sessionId:'fixture',reviewRoundId:'round',phase:'skeleton',reviewVersion:observed.shapeVersion,captureVersion:observed.captureVersion,approvedVersion:null,approvedCaptureVersion:null,revision:0};
  createHumanAuthorityStore(authority,{state,policy:{policyVersion:HUMAN_AUTHORITY_POLICY,roundMismatchCap:2,sessionMismatchCap:4,commandCap:20,authorityCap:10}},{captureStore:captures,observeUnderLock:capture});
  const {phase,revision,reviewVersion,captureVersion}=state;
  fs.writeFileSync(readinessExpected,JSON.stringify({phase,revision,reviewVersion,captureVersion,admissions:'live'}),{flag:'wx',mode:0o600});
  output({captureVersion:observed.captureVersion,reviewVersion:observed.shapeVersion});
 }else if(mode==='readiness-server'){
  const endpoint=new net.Socket({fd:Number(rawFd),readable:true,writable:true});
  const store=openHumanAuthorityStore(authority,{projectId:'fixture',sessionId:'fixture'},
   {captureStore:openCaptureStore(path.join(root,'captures')),observeUnderLock:fail,clock:fail,keyBytes:fail,epochId:fail,roundId:fail});
  let calls=0,validated=false;
  const server=createHumanCommandServer(endpoint,{verifyAndCommit:fail,recapture:fail,endSession:fail,state(){
   calls++;
   const state=store.state();
   assert.deepEqual(state,read(readinessExpected));
   validated=true;
   switch(round){
    case 'live':return state;
    // These wrappers exercise the public observation without altering the store.
    case 'malformed':return {...state,revision:'invalid'};
    case 'revoked':return {...state,admissions:'revoked'};
    case 'captureMismatch':return {...state,captureVersion:(state.captureVersion[0]==='0'?'1':'0')+state.captureVersion.slice(1)};
    case 'revisionMismatch':return {...state,revision:state.revision+1};
    default:throw Error('invalid readiness case');
   }
  }});
  const guard=setTimeout(()=>{process.exitCode=1;server.close();},5000);
  endpoint.once('close',()=>{clearTimeout(guard);assert.equal(calls,1);assert.ok(validated);output({stateCalls:calls});});
 }else if(mode==='readiness-client'){
  assert.ok(['live','malformed','noReply','revoked','captureMismatch','revisionMismatch'].includes(round));
  const endpoint=new net.Socket({fd:Number(rawFd),readable:true,writable:true});
  const expected=read(readinessExpected);
  try{
   const observed=await createHumanCommandClient(endpoint).state();
   // Match the entire public observation. Its schema carries no project or session identity.
   const ready=observed.admissions==='live'&&isDeepStrictEqual(observed,expected);
   if(ready){
    const sentinel=spawnSync(process.execPath,['-e',
     'require("node:fs").writeFileSync(process.argv[1],"started\\n",{flag:"wx",mode:0o600})',
     path.join(root,'sentinel-'+round)],{cwd:root,env:{},timeout:1000,maxBuffer:1024});
    assert.equal(sentinel.status,0);
   }
   assert.equal(ready,round==='live');
   switch(round){
    case 'malformed':case 'noReply':assert.deepEqual(observed,{kind:'rejected',code:'unavailable'});break;
    case 'revoked':assert.deepEqual(observed,{...expected,admissions:'revoked'});break;
    case 'captureMismatch':assert.notEqual(observed.captureVersion,expected.captureVersion);assert.deepEqual({...observed,captureVersion:expected.captureVersion},expected);break;
    case 'revisionMismatch':assert.deepEqual(observed,{...expected,revision:expected.revision+1});break;
   }
   output({sentinelStarted:ready});
  }finally{
   endpoint.destroy();
  }
 }else if(mode==='server'){
  const endpoint=new net.Socket({fd:Number(rawFd),readable:true,writable:true});let observations=0,calls=0;
  const store=openHumanAuthorityStore(authority,{projectId:'fixture',sessionId:'fixture'},{captureStore:openCaptureStore(path.join(root,'captures')),observeUnderLock:round==='first'?()=>{assert.ok(fs.statSync(path.join(authority,'.authority-lock')).isDirectory());observations++;return capture();}:fail,...(round==='first'?{}:{clock:fail,keyBytes:fail,epochId:fail,roundId:fail})});
  if(round==='first'){
   const r=read(record),key=Buffer.from(r.epochs.at(-1).keyHex,'hex');
   fs.writeFileSync(bootstrap,JSON.stringify({command:{action:'approve',code:deriveHumanCode(r.authority.state,'approve',key),requestId:'fixture-injected-approve'}}),{flag:'wx',mode:0o600});
  }
  const saved=read(bootstrap),before=fs.readFileSync(record);
  const server=createHumanCommandServer(endpoint,{verifyAndCommit(args){calls++;assert.deepEqual(args,saved.command);const result=store.verifyAndCommit(args);assert.equal(result.kind,'committed');
   if(round==='first'){fs.writeFileSync(bootstrap,JSON.stringify({...saved,result}),{mode:0o600});fs.writeFileSync(path.join(root,'committed-record'),fs.readFileSync(record),{flag:'wx',mode:0o600});endpoint.destroy();}
   else{assert.deepEqual(result,saved.result);assert.deepEqual(fs.readFileSync(record),before);}
   return result;},recapture:fail,endSession:fail,state:fail});
  const guard=setTimeout(()=>{server.close();process.exitCode=1;},8000);
  endpoint.once('close',()=>{clearTimeout(guard);assert.equal(calls,1);assert.equal(observations,round==='first'?1:0);output({committed:true,replay:round!=='first',observations,calls});});
  fs.writeFileSync(path.join(root,'ready-'+round),'ready',{flag:'wx',mode:0o600});
 }else if(mode==='client'){
  const endpoint=new net.Socket({fd:Number(rawFd),readable:true,writable:true});const client=createHumanCommandClient(endpoint),saved=read(bootstrap);
  const result=await client.verifyAndCommit(saved.command);
  if(round==='first')assert.deepEqual(result,{kind:'rejected',code:'unavailable'});else assert.deepEqual(result,saved.result);
  endpoint.destroy();output({fixedUnavailable:round==='first',retainedResult:round!=='first'});
 }else if(mode==='verify'){
  const r=read(record);assert.deepEqual(fs.readFileSync(record),fs.readFileSync(path.join(root,'committed-record')));assert.equal(r.commands.length,1);assert.equal(r.authority.journal.length,1);assert.equal(r.authority.state.phase,'fill');
  output({durableBytesUnchanged:true,commands:1,journal:1});
 }else throw Error('invalid mode');
}catch{console.log(JSON.stringify({ok:false,strictState:'unverified'}));process.exitCode=1;}
