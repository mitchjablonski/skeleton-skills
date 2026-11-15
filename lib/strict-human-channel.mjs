// DISABLED candidate plumbing only. Host-owned endpoints are not authentication,
// private OS channel proof, a listener, or production activation.
import {Duplex} from 'node:stream';
import {types} from 'node:util';
import {parseHumanCommand} from './strict-human-command.mjs';
import {STRICT_REJECTIONS} from './strict-protocol.mjs';

export const HUMAN_CHANNEL_CAPS=Object.freeze({frameBytes:4096,calls:128,timeoutMs:1000});
const unavailable=()=>Object.freeze({kind:'rejected',code:'unavailable'});
const operations=['verifyAndCommit','recapture','endSession','state'];
function data(v,keys){
 try{
  if(!v||typeof v!=='object'||types.isProxy(v)||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return null;
  const names=Reflect.ownKeys(v);if(names.length!==keys.length||names.some(k=>!keys.includes(k)))return null;
  const out={};for(const k of keys){const d=Object.getOwnPropertyDescriptor(v,k);if(!d?.enumerable||!('value'in d))return null;out[k]=d.value;}return out;
 }catch{return null;}
}
const count=v=>Number.isSafeInteger(v)&&v>=0&&!Object.is(v,-0);
const digest=v=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
const id=v=>typeof v==='string'&&v.length>=1&&v.length<=128&&!/[^A-Za-z0-9._:-]/.test(v)&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const utc=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function argsFor(op,args){
 if(op==='state')return data(args,[]);
 const own=data(args,op==='verifyAndCommit'?['action','code','requestId']:['requestId']);if(!own)return null;
 const parsed=parseHumanCommand(op,own);if(!parsed)return null;
 return op==='verifyAndCommit'?{action:parsed.action,code:parsed.code,requestId:parsed.requestId}:{requestId:parsed.requestId};
}
// Exact public schemas: never serialize arbitrary authority objects or errors.
function publicResult(value,op,args){
 const k=data(value,['kind','code']) ;if(k?.kind==='rejected'&&k.code==='unavailable')return unavailable();
 if(op==='state'){
  const s=data(value,['phase','revision','reviewVersion','captureVersion','admissions']);
  return s&&['skeleton','fill','finalized'].includes(s.phase)&&count(s.revision)&&digest(s.reviewVersion)&&digest(s.captureVersion)&&['live','revoked'].includes(s.admissions)?Object.freeze(s):null;
 }
 let kind;try{if(types.isProxy(value))return null;kind=Object.getOwnPropertyDescriptor(value,'kind')?.value;}catch{return null;}
 const shapes={committed:['action','reviewVersion','captureVersion','revision','at'],recaptured:['reviewVersion','captureVersion','revision','changed'],mismatch:['revision','reviewVersion','captureVersion','attemptsLeft'],locked:['unlock'],refused:['reason'],'journal-full':[],'admissions-revoked':['at'],rejected:['code']};
 if(!Object.hasOwn(shapes,kind))return null;
 const r=data(value,['kind','requestId',...shapes[kind]]);if(!r||!id(r.requestId)||r.requestId!==args.requestId)return null;
 if(['committed','recaptured','mismatch'].includes(kind)&&(!count(r.revision)||!digest(r.reviewVersion)||!digest(r.captureVersion)))return null;
 if(kind==='committed'&&(op!=='verifyAndCommit'||r.action!==args.action||!utc(r.at)||r.revision===0))return null;
 if(kind==='recaptured'&&(op!=='recapture'||typeof r.changed!=='boolean'))return null;
 if(kind==='mismatch'&&(op!=='verifyAndCommit'||!count(r.attemptsLeft)||r.attemptsLeft>1024))return null;
 if(kind==='locked'&&(op!=='verifyAndCommit'||r.unlock!=='new-session'))return null;
 if(kind==='refused'&&(op!=='recapture'||r.reason!=='fill-phase'))return null;
 if(kind==='admissions-revoked'&&(op!=='endSession'||!utc(r.at)))return null;
 if(kind==='rejected'&&!STRICT_REJECTIONS.includes(r.code))return null;
 return Object.freeze(r);
}
function frame(value){const body=Buffer.from(JSON.stringify(value));if(body.length>HUMAN_CHANNEL_CAPS.frameBytes)throw Error('bounds');const h=Buffer.alloc(4);h.writeUInt32BE(body.length);return Buffer.concat([h,body]);}
function transport(endpoint,onFrame,onClose){
 if(!(endpoint instanceof Duplex)||types.isProxy(endpoint)||endpoint.destroyed||endpoint.readableEncoding)throw TypeError('host-owned binary Duplex required');
 let closed=false,buffer=Buffer.alloc(0),timer;
 const close=()=>{if(closed)return;closed=true;clearTimeout(timer);buffer=Buffer.alloc(0);endpoint.removeListener('data',receive);endpoint.removeListener('end',close);endpoint.removeListener('close',close);onClose();endpoint.destroy();};
 const receive=chunk=>{
  if(closed)return;
  if(!Buffer.isBuffer(chunk)||buffer.length+chunk.length>HUMAN_CHANNEL_CAPS.frameBytes+4){close();return;}
  buffer=Buffer.concat([buffer,chunk]);
  if(!timer)timer=setTimeout(close,HUMAN_CHANNEL_CAPS.timeoutMs);
  if(buffer.length<4)return;
  const n=buffer.readUInt32BE();if(n===0||n>HUMAN_CHANNEL_CAPS.frameBytes||buffer.length>n+4){close();return;}
  if(buffer.length!==n+4)return;
  const bytes=buffer.subarray(4);buffer=Buffer.alloc(0);clearTimeout(timer);timer=null;
  try{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),value=JSON.parse(text);
   // One canonical representation excludes duplicate keys, whitespace and
   // numeric aliases before any command can reach the authority.
   if(JSON.stringify(value)!==text){close();return;}onFrame(value);
  }catch{close();}
 };
 endpoint.on('data',receive);endpoint.on('end',close);endpoint.on('close',close);
 // Retain this fixed no-op after close: late stream errors must not crash host.
 endpoint.on('error',close);
 return {close,send(value){if(closed)return false;try{if(!endpoint.write(frame(value))){close();return false;}return true;}catch{close();return false;}},get closed(){return closed;}};
}
/** Synchronous four-method authority is a trusted host contract. Rejecting a
 * returned Promise cannot cancel async side effects a bad handle started. */
export function createHumanCommandServer(endpoint,authority){
 const methods=data(authority,operations);if(!methods||operations.some(k=>typeof methods[k]!=='function'||types.isAsyncFunction(methods[k])))throw TypeError('synchronous four-method authority required');
 let sequence=0;
 const wire=transport(endpoint,value=>{
  const r=data(value,['version','sequence','operation','args']);
  if(!r||r.version!==1||r.sequence!==sequence+1||!operations.includes(r.operation)||sequence>=HUMAN_CHANNEL_CAPS.calls){wire.close();return;}
  const args=argsFor(r.operation,r.args);if(!args){wire.close();return;}sequence++;
  let result;try{const value=Reflect.apply(methods[r.operation],authority,r.operation==='state'?[]:[args]);
   // A misconfigured sync handle may return a rejected Promise. Consume only
   // the intrinsic Promise rejection; never inspect or invoke arbitrary then.
   if(types.isPromise(value))Promise.prototype.then.call(value,()=>{},()=>{});
   else result=publicResult(value,r.operation,args);
  }catch{}
  wire.send({version:1,sequence,result:result??unavailable()});
 },()=>{});
 return Object.freeze({close:wire.close});
}
/** One in flight. Unknown outcomes never replay; caller retains requestId. */
export function createHumanCommandClient(endpoint){
 let sequence=0,pending=null;
 const settle=result=>{if(!pending)return;const p=pending;pending=null;clearTimeout(p.timer);p.resolve(result);};
 const wire=transport(endpoint,value=>{
  const r=data(value,['version','sequence','result']);
  if(!pending||!r||r.version!==1||r.sequence!==sequence){wire.close();return;}
  const result=publicResult(r.result,pending.op,pending.args);if(!result){wire.close();return;}settle(result);
 },()=>settle(unavailable()));
 const invoke=(op,input)=>{
  const args=argsFor(op,input);if(!args||pending||wire.closed||sequence>=HUMAN_CHANNEL_CAPS.calls)return Promise.resolve(unavailable());
  return new Promise(resolve=>{sequence++;pending={resolve,op,args,timer:setTimeout(()=>wire.close(),HUMAN_CHANNEL_CAPS.timeoutMs)};wire.send({version:1,sequence,operation:op,args});});
 };
 return Object.freeze({verifyAndCommit:args=>invoke('verifyAndCommit',args),recapture:args=>invoke('recapture',args),endSession:args=>invoke('endSession',args),state:()=>invoke('state',{})});
}
