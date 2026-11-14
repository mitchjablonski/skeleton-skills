// Disabled PURE candidate codec. No key generation/storage, channel proof,
// comparison/verification, authority transition, journal, or production wiring.
import {createHmac} from 'node:crypto';
import {parseAuthorityState} from './strict-protocol.mjs';
export const HUMAN_COMMAND_VERSION='human-code-v1';
export const HUMAN_CODE_DOMAIN='skel-human-code-v1';
export const HUMAN_COMMAND_DOMAIN='skel-human-command-v1';
export const HUMAN_CODE_INPUT_LIMIT=200;
const ALPHABET='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const OPERATIONS=['verifyAndCommit','recapture','endSession'];
const opaqueId=(value,max)=>typeof value==='string' && value.length<=max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && !/[^A-Za-z0-9._:-]/.test(value);
const requestId=value=>opaqueId(value,128);
const digest=value=>typeof value==='string' && value.length===64 && /^[a-f0-9]{64}$/.test(value);
export class HumanCommandError extends Error {
 constructor(code){super(code);this.name='HumanCommandError';this.code=code;}
}
const fail=code=>{throw new HumanCommandError(code);};
function data(value,names){
 try {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
  const keys=Reflect.ownKeys(value);if(keys.length!==names.length||keys.some(key=>!names.includes(key)))return null;
  const out=Object.create(null);
  for(const key of names){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!('value' in d))return null;out[key]=d.value;}
  return out;
 }catch{return null;}
}
/** Same folds as the console on accepted printable ASCII; no Unicode folds. */
export function normalizeHumanCode(value){
 if(typeof value!=='string'||value.length>HUMAN_CODE_INPUT_LIMIT||/[^\x20-\x7e]/.test(value))return null;
 const canonical=value.replace(/[ -]/g,'').toUpperCase().replace(/[IL]/g,'1').replace(/O/g,'0');
 if(canonical.length!==8||[...canonical].some(c=>!ALPHABET.includes(c)))return null;
 return canonical.slice(0,4)+'-'+canonical.slice(4);
}
/** Raw method input, not a console wire extension or a V2 Intent. */
export function parseHumanCommand(operation,value){
 if(!OPERATIONS.includes(operation))return null;
 const parsed=data(value,operation==='verifyAndCommit'?['action','code','requestId']:['requestId']);
 if(!parsed||!requestId(parsed.requestId))return null;
 if(operation==='verifyAndCommit'){
  const code=normalizeHumanCode(parsed.code);
  if(!['approve','reshape'].includes(parsed.action)||!code)return null;
  return Object.freeze({operationVersion:HUMAN_COMMAND_VERSION,operation,requestId:parsed.requestId,action:parsed.action,code});
 }
 return Object.freeze({operationVersion:HUMAN_COMMAND_VERSION,operation,requestId:parsed.requestId});
}
function encode(domain,fields){
 const chunks=[Buffer.from(domain,'ascii')];
 for(const field of fields){const bytes=Buffer.from(field,'utf8'),size=Buffer.alloc(4);size.writeUInt32BE(bytes.length);chunks.push(size,bytes);}
 return Buffer.concat(chunks);
}
/** Fresh bytes; journal scope MUST separately bind enrolled project/session. */
export function humanCommandIdentity(operation,value){
 const command=parseHumanCommand(operation,value);if(!command)fail('HUMAN_COMMAND');
 return encode(HUMAN_COMMAND_DOMAIN,[command.operationVersion,command.operation,command.requestId,command.action??'',command.code??'']);
}
export function encodeHumanCodeMessage(value,action){
 const state=parseAuthorityState(value);
 if(!state||state.protocolVersion!==2||Object.is(state.revision,-0)
  ||![state.projectId,state.sessionId,state.reviewRoundId].every(v=>opaqueId(v,256))
  ||![state.reviewVersion,state.captureVersion].every(digest)
  ||(state.phase!=='skeleton'&&![state.approvedVersion,state.approvedCaptureVersion].every(digest)))fail('HUMAN_STATE');
 if(!((action==='approve'&&state.phase==='skeleton')||(action==='reshape'&&state.phase==='fill')))fail('HUMAN_ACTION');
 const shape=action==='approve'?state.reviewVersion:state.approvedVersion;
 const capture=action==='approve'?state.captureVersion:state.approvedCaptureVersion;
 return encode(HUMAN_CODE_DOMAIN,[action,state.projectId,state.sessionId,state.reviewRoundId,String(state.revision),shape,capture]);
}
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf=Object.getOwnPropertyDescriptor(typedArrayPrototype,'buffer').get;
const offsetOf=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteOffset').get;
const lengthOf=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteLength').get;
function keyCopy(value){
 try {
  // Intrinsic getters reject proxies and avoid attacker-controlled .buffer,
  // length, iterator or conversion accessors. Shared memory is not snapshotted.
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Buffer.prototype&&prototype!==Uint8Array.prototype)fail('HUMAN_KEY');
  const buffer=bufferOf.call(value),offset=offsetOf.call(value),length=lengthOf.call(value);
  if(Object.getPrototypeOf(buffer)!==ArrayBuffer.prototype||length!==32)fail('HUMAN_KEY');
  return Buffer.from(new Uint8Array(buffer,offset,length));
 }catch{fail('HUMAN_KEY');}
}
export function deriveHumanCode(state,action,key){
 const copied=keyCopy(key);
 try {
  const digest=createHmac('sha256',copied).update(encodeHumanCodeMessage(state,action)).digest();
  const bits=digest.readUIntBE(0,5);let code='';
  for(let index=0;index<8;index++)code+=ALPHABET[Math.floor(bits/(2**((7-index)*5)))&31];
  return code.slice(0,4)+'-'+code.slice(4);
 }finally{copied.fill(0);}
}
