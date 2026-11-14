// Disabled PURE candidate. Consistency/replay only; no authentication, storage,
// integrity, antirollback, capture validation, process termination or activation.
import {timingSafeEqual} from 'node:crypto';
import {types} from 'node:util';
import {parseHumanCommand,humanCommandIdentity,deriveHumanCode} from './strict-human-command.mjs';
import {createAuthorityRecord,parseAuthorityRecord,planAuthorityTransaction,MAX_AUTHORITY_JOURNAL_ENTRIES} from './strict-authority.mjs';
export const HUMAN_AUTHORITY_FORMAT='skel-private-human-record-v1';
export const HUMAN_AUTHORITY_POLICY='candidate-no-recapture-reset-v1';
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
// Snapshot bounded own-data before any codec or JSON comparison. Proxies are
// rejected even when their traps emulate ordinary data successfully.
function snapshot(value,depth=0,budget={left:1500000}){
 if(--budget.left<0||depth>24)throw Error('bounds');
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='number'){if(!Number.isSafeInteger(value)||Object.is(value,-0))throw Error('number');return value;}
 if(typeof value==='string'){if(value.length>4096)throw Error('string');return value;}
 if(typeof value!=='object'||types.isProxy(value))throw Error('data');
 const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
 if(array?proto!==Array.prototype:![Object.prototype,null].includes(proto))throw Error('prototype');
 const keys=Reflect.ownKeys(value),out=array?[]:{};
 if(!array&&keys.length>32)throw Error('object bounds');
 if(array&&(value.length>1025||keys.length!==value.length+1))throw Error('array');
 for(const key of keys){if(array&&key==='length')continue;if(typeof key!=='string'||(array&&!/^(0|[1-9][0-9]*)$/.test(key)))throw Error('key');
 const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!('value'in d))throw Error('descriptor');
 Object.defineProperty(out,key,{value:snapshot(d.value,depth+1,budget),enumerable:true,writable:true,configurable:true});}
 return out;
}
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const equal=(a,b)=>{if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));};
const id=v=>typeof v==='string'&&v.length<=256&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v)&&! /[^A-Za-z0-9._:-]/.test(v);
const hex=v=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
const cap=v=>Number.isSafeInteger(v)&&v>0&&v<=1024;
function policy(v){return exact(v,['policyVersion','roundMismatchCap','sessionMismatchCap','commandCap','authorityCap'])&&v.policyVersion===HUMAN_AUTHORITY_POLICY&&[v.roundMismatchCap,v.sessionMismatchCap,v.commandCap,v.authorityCap].every(cap)&&v.authorityCap<=MAX_AUTHORITY_JOURNAL_ENTRIES;}
function epoch(v,round){return exact(v,['epochId','reviewRoundId','keyHex'])&&id(v.epochId)&&v.reviewRoundId===round&&hex(v.keyHex);}
function timestamp(v){
 if(typeof v!=='string'||v.length!==24||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v))return false;
 const y=+v.slice(0,4),m=+v.slice(5,7),d=+v.slice(8,10),days=[31,y%4===0&&(y%100!==0||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
 return y>=1&&m>=1&&m<=12&&d>=1&&d<=days[m-1]&&+v.slice(11,13)<24&&+v.slice(14,16)<60&&+v.slice(17,19)<60;
}
function command(v){
 if(!v||!exact(v,v.operation==='verifyAndCommit'?['operationVersion','operation','requestId','action','code']:['operationVersion','operation','requestId']))return null;
 const raw=v.operation==='verifyAndCommit'?{requestId:v.requestId,action:v.action,code:v.code}:{requestId:v.requestId};
 const c=parseHumanCommand(v.operation,raw);return c&&equal(c,v)?c:null;
}
const raw=c=>c.operation==='verifyAndCommit'?{requestId:c.requestId,action:c.action,code:c.code}:{requestId:c.requestId};
const identity=c=>humanCommandIdentity(c.operation,raw(c)).toString('hex');
const reject=(code,c)=>({kind:'rejected',code,...(c?{requestId:c.requestId}:{})});
function codeBytes(code){const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let n=0;for(const c of code.replace('-',''))n=n*32+alphabet.indexOf(c);const out=Buffer.alloc(5);out.writeUIntBE(n,0,5);return out;}
function observed(r){const s=r.authority.state;return {epochId:r.current.epochId,revision:s.revision,reviewRoundId:s.reviewRoundId,reviewVersion:s.reviewVersion,captureVersion:s.captureVersion};}
function intent(s,c){const action=c.operation==='recapture'?'recapture':c.action,selected=action!=='reshape';return {protocolVersion:2,requestId:c.requestId,action,projectId:s.projectId,sessionId:s.sessionId,reviewRoundId:s.reviewRoundId,reviewVersion:selected?s.reviewVersion:s.approvedVersion,captureVersion:selected?s.captureVersion:s.approvedCaptureVersion,expectedRevision:s.revision};}
function fresh(enrollment){
 if(!exact(enrollment,['state','policy','epoch'])||!policy(enrollment.policy))return null;
 const authority=createAuthorityRecord(enrollment.state);if(!authority||authority.protocolVersion!==2||![authority.state.projectId,authority.state.sessionId,authority.state.reviewRoundId].every(id)||![authority.state.reviewVersion,authority.state.captureVersion].every(hex)||!epoch(enrollment.epoch,authority.state.reviewRoundId))return null;
 const ep=enrollment.epoch;
 return {format:HUMAN_AUTHORITY_FORMAT,context:{projectId:authority.state.projectId,sessionId:authority.state.sessionId},policy:enrollment.policy,initial:{authority,epoch:ep,admissions:'live'},epochs:[ep],commands:[],authority,current:{epochId:ep.epochId,roundMismatchCount:0,sessionMismatchCount:0,admissions:'live'}};
}
export function createHumanAuthorityRecord(enrollment){try{const r=fresh(snapshot(enrollment));return r?freeze(r):null;}catch{return null;}}
// Shared pure eligibility rules for preparation, append and historical replay.
function prepareAppend(r,c){
 const s=r.authority.state,cur=r.current,requestId=c.requestId;
 const no=(result,extra={})=>({kind:'needs-no-core',result,...extra});
 if(c.operation==='endSession')return no(null,{end:true});
 if(cur.admissions!=='live')return no(reject('session-ended',c));
 if(c.operation==='recapture'&&s.phase!=='skeleton')return no({kind:'refused',requestId,reason:'fill-phase'});
 if(c.operation==='verifyAndCommit'&&((c.action==='approve'&&s.phase!=='skeleton')||(c.action==='reshape'&&s.phase!=='fill')))return no(reject('invalid-transition',c));
 if(c.operation==='verifyAndCommit'&&(cur.roundMismatchCount>=r.policy.roundMismatchCap||cur.sessionMismatchCount>=r.policy.sessionMismatchCap))return no({kind:'locked',requestId,unlock:'new-session'});
 if(c.operation==='verifyAndCommit'){
  const ep=r.epochs.find(x=>x.epochId===cur.epochId);
  if(!timingSafeEqual(codeBytes(c.code),codeBytes(deriveHumanCode(s,c.action,Buffer.from(ep.keyHex,'hex')))))return no({kind:'mismatch',requestId,revision:s.revision,reviewVersion:s.reviewVersion,captureVersion:s.captureVersion,attemptsLeft:Math.min(r.policy.roundMismatchCap-cur.roundMismatchCount-1,r.policy.sessionMismatchCap-cur.sessionMismatchCount-1)},{mismatch:true});
 }
 if(r.authority.journal.length>=r.policy.authorityCap)return no({kind:'journal-full',requestId});
 return {kind:'needs-core',intent:intent(s,c)};
}
function prepareParsed(r,c){
 const ready=(result,replayed=false)=>({kind:'ready-result',result,persist:false,replayed});
 if(!r)return ready(reject('unavailable'));
 if(!c)return ready(reject('invalid-transition'));
 const prior=r.commands.find(x=>x.command.requestId===c.requestId);
 if(prior)return identity(c)===prior.identityHex?ready(prior.result,true):ready(reject('request-reused',c));
 if(r.commands.length>=r.policy.commandCap)return ready({kind:'journal-full',requestId:c.requestId});
 return prepareAppend(r,c);
}
function canonical(value){try{return command(snapshot(value));}catch{return null;}}
/** Pure admission only: exposes no record, keys, codes or effect dependencies.
 * Other than ready-result, every variant still requires authoritative planning.
 */
export function prepareHumanAuthorityCommand(value,canonicalCommand){
 const r=parseHumanAuthorityRecord(value),gate=prepareParsed(r,r?canonical(canonicalCommand):null);
 return freeze(gate.kind==='needs-no-core'?{kind:gate.kind}:gate);
}
// Evidence variants cannot bypass eligibility/counter rules; trusted core facts
// still determine core results. Each core-bearing command owns one V2 append.
function append(r,c,effect,validatedCoreHistory=null,prepared=null){
 if(!exact(effect,['at','evidence'])||!timestamp(effect.at))return null;
 const e=effect.evidence,s=r.authority.state,cur={...r.current},requestId=c.requestId;
 let result,authority=r.authority,epochs=r.epochs;
 const noCore=resultValue=>{if(!exact(e,['kind'])||e.kind!=='no-core')return null;return resultValue;};
 const gate=prepared??prepareAppend(r,c);
 if(gate.kind==='needs-no-core'){
  if(gate.end)cur.admissions='revoked';
  if(gate.mismatch){cur.roundMismatchCount++;cur.sessionMismatchCount++;}
  result=noCore(gate.end?{kind:'admissions-revoked',requestId,at:effect.at}:gate.result);
 }else {
   if(!e||!['core','reshape'].includes(e.kind)||!exact(e,e.kind==='core'?['kind','intent','facts']:['kind','intent','facts','nextEpoch']))return null;
   const expected=gate.intent;if(!equal(expected,e.intent)||!exact(e.facts,['contentVersion','captureVersion','nextReviewRoundId','completionVerified'])||e.facts.completionVerified!==false||!hex(e.facts.contentVersion)||!hex(e.facts.captureVersion)||(e.facts.nextReviewRoundId!==null&&!id(e.facts.nextReviewRoundId)))return null;
   let core;
   if(validatedCoreHistory){
    // PRIVATE replay path only: the complete V2 record was already validated
    // by parseAuthorityRecord. Consume its next entry in strict ownership
    // order; never accept stateAfter/result from unchecked serialized evidence.
    const owned=validatedCoreHistory[authority.journal.length];
    if(!owned||!equal(owned.intent,expected)||!equal(owned.facts,e.facts))return null;
    authority={...authority,state:owned.stateAfter,journal:[...authority.journal,owned]};
    core=owned.result;
   }else{
    // New commands still delegate every transition to the existing planner.
    const planned=planAuthorityTransaction(authority,expected,e.facts);
    if(!planned.persist||planned.replayed||planned.record.journal.length!==authority.journal.length+1)return null;
    authority=planned.record;core=planned.result;
   }
   if(core.kind==='committed'&&core.action==='reshape'){
    const next=e.nextEpoch;if(e.kind!=='reshape'||!epoch(next,authority.state.reviewRoundId)||epochs.some(x=>x.epochId===next.epochId||x.keyHex===next.keyHex))return null;
    epochs=[...epochs,next];cur.epochId=next.epochId;cur.roundMismatchCount=0;
   }else if(e.kind!=='core')return null;
   if(core.kind==='committed'){const {protocolVersion,...publicResult}=core;result={...publicResult,at:effect.at};}
   else if(core.kind==='recaptured'){const {protocolVersion,action,...publicResult}=core;result=publicResult;}
   else result=core;
 }
 if(!result)return null;
 const entry={command:c,identityHex:identity(c),observed:observed(r),evidence:e,result,at:effect.at};
 return {record:{...r,authority,epochs,current:cur,commands:[...r.commands,entry]},result};
}
export function parseHumanAuthorityRecord(value){try{
 const v=snapshot(value);
 if(!exact(v,['format','context','policy','initial','epochs','commands','authority','current'])||v.format!==HUMAN_AUTHORITY_FORMAT||!exact(v.initial,['authority','epoch','admissions'])||v.initial.admissions!=='live'||!Array.isArray(v.commands)||!Array.isArray(v.epochs))return null;
 const initial=parseAuthorityRecord(v.initial.authority);if(!initial||initial.journal.length!==0)return null;
 let r=fresh({state:initial.state,policy:v.policy,epoch:v.initial.epoch});
 if(!r||!equal(r.initial.authority,initial)||!equal(r.context,v.context)||v.commands.length>r.policy.commandCap)return null;
 // Validate the full core history ONCE. Replaying every prefix through the
 // core parser would repeat all earlier transitions for each human entry.
 const validatedAuthority=parseAuthorityRecord(v.authority);
 if(!validatedAuthority||!equal(validatedAuthority.initialState,initial.initialState)||validatedAuthority.protocolVersion!==2)return null;
 const seen=new Set();
 for(const entry of v.commands){if(!exact(entry,['command','identityHex','observed','evidence','result','at']))return null;
  const c=command(entry.command);if(!c||seen.has(c.requestId))return null;seen.add(c.requestId);
  const decision=append(r,c,{at:entry.at,evidence:entry.evidence},validatedAuthority.journal);if(!decision||!equal(decision.record.commands.at(-1),entry))return null;r=decision.record;
 }
 if(!equal(r,v))return null;return freeze(r);
 }catch{return null;}}
export const replayHumanAuthorityRecord=parseHumanAuthorityRecord;
/** Effects are trusted-host DATA, never callbacks. Exact lookup ignores effects.
 * persist=true requires an external atomic durable commit before any reply.
 */
export function planHumanAuthorityCommand(value,canonicalCommand,trustedEffect){
 const r=parseHumanAuthorityRecord(value),reply=(record,result,persist=false,replayed=false)=>freeze({record,result,persist,replayed});
 if(!r)return reply(null,reject('unavailable'));
 const c=canonical(canonicalCommand),gate=prepareParsed(r,c);
 if(gate.kind==='ready-result')return reply(r,gate.result,false,gate.replayed);
 try{const decision=append(r,c,snapshot(trustedEffect),null,gate);if(decision)return reply(freeze(decision.record),decision.result,true);}catch{}
 return reply(r,reject('unavailable',c));
}
