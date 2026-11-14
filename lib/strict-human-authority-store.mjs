// Disabled trusted-host adapter: no authentication, antirollback, runtime wiring or activation.
import {types} from 'node:util';
import {randomUUID,randomBytes} from 'node:crypto';
import {humanAuthorityFile,requireLinux} from './strict-authority-file.mjs';
import {createHumanAuthorityRecord,prepareHumanAuthorityCommand,planHumanAuthorityCommand} from './strict-human-authority.mjs';
import {parseHumanCommand} from './strict-human-command.mjs';
import {planAuthorityTransaction} from './strict-authority.mjs';
import {validateStoredCapture} from './strict-capture.mjs';
const unavailable=()=>Object.freeze({kind:'rejected',code:'unavailable'});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function dependencies(value){
 const store=value?.captureStore;
 if(typeof store?.get!=='function'||typeof store?.put!=='function'||typeof value.observeUnderLock!=='function')throw Error('protected dependencies required');
 const d={get:store.get.bind(store),put:store.put.bind(store),observe:value.observeUnderLock,clock:value.clock??(()=>new Date().toISOString()),roundId:value.roundId??randomUUID,epochId:value.epochId??randomUUID,keyBytes:value.keyBytes??(()=>randomBytes(32))};
 if(Object.values(d).some(v=>typeof v!=='function'))throw Error('invalid protected dependency');
 return Object.freeze(d);
}
function resolve(d,shape,identity){
 const c=validateStoredCapture(d.get(identity));
 if(c.shapeVersion!==shape||c.captureVersion!==identity)throw Error('capture binding mismatch');
 return c;
}
function validatePairs(d,value){
 const seen=new Set();
 const visit=v=>{if(!v||typeof v!=='object')return;
  for(const [shape,identity] of [['reviewVersion','captureVersion'],['approvedVersion','approvedCaptureVersion'],['contentVersion','captureVersion']]){
   if(typeof v[shape]==='string'&&typeof v[identity]==='string'){
    const key=v[shape]+v[identity];if(!seen.has(key)){resolve(d,v[shape],v[identity]);seen.add(key);}
   }
  }
  for(const child of Object.values(v))visit(child);
 };visit(value);
}
function epoch(d,round){
 const bytes=d.keyBytes();
 if(!(Buffer.isBuffer(bytes)||bytes instanceof Uint8Array)||bytes.length!==32)throw Error('invalid protected key');
 const keyHex=Buffer.from(bytes).toString('hex'); // snapshot before any further protected callback
 return {epochId:d.epochId(),reviewRoundId:round,keyHex};
}
function ownData(value,names){
 if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('invalid own data');
 const keys=Reflect.ownKeys(value);if(keys.length!==names.length||keys.some(k=>!names.includes(k)))throw Error('invalid own keys');
 const out={};for(const key of names){const desc=Object.getOwnPropertyDescriptor(value,key);if(!desc?.enumerable||!('value' in desc))throw Error('invalid data descriptor');out[key]=desc.value;}return out;
}
function context(value){
 const c=ownData(value,['projectId','sessionId']);if(typeof c.projectId!=='string'||typeof c.sessionId!=='string')throw Error('invalid expected context');return Object.freeze(c);
}
function read(file,expected){const r=file.read();if(!equal(r.context,expected))throw Error('context mismatch');return r;}
function handle(file,expected,d){
 function invoke(operation,args){
  try{
   const c=parseHumanCommand(operation,args);if(!c)return unavailable();
   const release=file.acquireLock();
   try{
    const r=read(file,expected),prep=prepareHumanAuthorityCommand(r,c);
    if(prep.kind==='ready-result'){
     // Resolve retained history, never a fresh workspace observation.
     const prior=r.commands.find(e=>e.command.requestId===c.requestId);
     if(prep.replayed&&prior)validatePairs(d,prior);
     file.sync();return prep.result;
    }
    let evidence={kind:'no-core'},preflight;
    if(prep.kind==='needs-core'){
     validatePairs(d,r.authority.state);
     const capture=validateStoredCapture(d.observe());
     const published=validateStoredCapture(d.put(capture));
     if(published.shapeVersion!==capture.shapeVersion||published.captureVersion!==capture.captureVersion)throw Error('publication mismatch');
     const facts={contentVersion:published.shapeVersion,captureVersion:published.captureVersion,nextReviewRoundId:prep.intent.action==='reshape'?d.roundId():null,completionVerified:false};
     preflight=planAuthorityTransaction(r.authority,prep.intent,facts);
     if(!preflight.persist||preflight.replayed)throw Error('invalid preflight');
     evidence={kind:'core',intent:prep.intent,facts};
     if(preflight.result.kind==='committed'&&preflight.result.action==='reshape')evidence={...evidence,kind:'reshape',nextEpoch:epoch(d,preflight.record.state.reviewRoundId)};
    }else if(prep.kind!=='needs-no-core')throw Error('invalid preparation');
    const plan=planHumanAuthorityCommand(r,c,{at:d.clock(),evidence});
    if(!plan.persist||!plan.record)throw Error('planner disagreement');
    if(preflight&&!equal(plan.record.authority,preflight.record))throw Error('core disagreement');
    validatePairs(d,plan.record.commands.at(-1));
    file.replace(plan.record);return plan.result;
   }finally{release();}
  }catch{return unavailable();}
 }
 return Object.freeze({verifyAndCommit:args=>invoke('verifyAndCommit',args),recapture:args=>invoke('recapture',args),endSession:args=>invoke('endSession',args),state(){
  try{const release=file.acquireLock();try{const r=read(file,expected),s=r.authority.state;file.sync();return Object.freeze({phase:s.phase,revision:s.revision,reviewVersion:s.reviewVersion,captureVersion:s.captureVersion,admissions:r.current.admissions});}finally{release();}}catch{return unavailable();}
 }});
}
export function createHumanAuthorityStore(directory,enrollment,protectedDependencies){
 requireLinux();const d=dependencies(protectedDependencies);
 const enrolled=ownData(enrollment,['state','policy']);
 if(!enrolled.state||typeof enrolled.state!=='object'||types.isProxy(enrolled.state))throw Error('invalid enrollment state');
 // Validate enrollment and bound immutable capture before consuming host entropy.
 const trial=createHumanAuthorityRecord({state:enrolled.state,policy:enrolled.policy,epoch:{epochId:'validation',reviewRoundId:Object.getOwnPropertyDescriptor(enrolled.state??{},'reviewRoundId')?.value,keyHex:'00'.repeat(32)}});
 if(!trial||trial.authority.state.phase!=='skeleton')throw Error('invalid enrollment');
 validatePairs(d,trial.authority.state);
 const file=humanAuthorityFile(directory,protectedDependencies.storageOperations);
 file.createDirectory();
 const release=file.acquireLock();
 let record;
 try{record=createHumanAuthorityRecord({state:trial.authority.initialState,policy:trial.policy,epoch:epoch(d,trial.authority.state.reviewRoundId)});if(!record)throw Error('invalid enrollment epoch');file.replace(record);}finally{release();}
 return handle(file,context(record.context),d);
}
export function openHumanAuthorityStore(directory,expectedContext,protectedDependencies){
 requireLinux();const expected=context(expectedContext),d=dependencies(protectedDependencies),file=humanAuthorityFile(directory,protectedDependencies.storageOperations);
 read(file,expected);return handle(file,expected,d);
}
