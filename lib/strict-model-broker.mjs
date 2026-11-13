// Disabled host-only mock orchestration. No socket, DNS, TLS implementation,
// real credential, listener, launcher, monetary admission or activation.
import { parseModelRequest, validateResolvedAddresses, validateNoRedirect, STRICT_MODEL_PROFILE } from './strict-model-policy.mjs';

export const STRICT_MOCK_BROKER_LIMITS = Object.freeze({maxInFlight:1,maxRequests:16,maxRequestsPerSecond:4,
  maxRequestBytes:1048576,maxResponseHeaderBytes:32768,maxResponseBytes:2097152,maxResponseChunks:4096,maxSessionResponseBytes:8388608,
  dnsTimeoutMs:2000,connectTimeoutMs:2000,requestTimeoutMs:10000,sessionTimeoutMs:60000});
export class StrictModelBrokerError extends Error {
  constructor(code) { super(code); this.name='StrictModelBrokerError'; this.code=code; }
}
const SAFE_CODES=new Set(('BROKER_LIMITS BROKER_REQUEST BROKER_HEADERS BROKER_FRAMING BROKER_TRANSPORT BROKER_CLOSED BROKER_SESSION BROKER_CONCURRENCY BROKER_REQUESTS BROKER_RATE BROKER_SESSION_BYTES BROKER_TIMEOUT BROKER_PEER BROKER_TLS BROKER_RESPONSE_HEADERS BROKER_RESPONSE_FRAMING BROKER_RESPONSE_ENCODING BROKER_RESPONSE_TYPE BROKER_RESPONSE_BYTES BROKER_RESPONSE_CHUNKS BROKER_RESPONSE_BODY '
  +'MODEL_PROFILE MODEL_DESTINATION MODEL_BODY_LIMIT MODEL_DNS_ANSWERS MODEL_DNS_NONPUBLIC_OR_UNSUPPORTED MODEL_RESPONSE_STATUS MODEL_REDIRECT_REFUSED MODEL_HEADERS MODEL_HOST_OVERRIDE MODEL_HEADER_NAME MODEL_DUPLICATE_HEADER MODEL_HEADER_VALUE MODEL_HEADER_LIMIT MODEL_HOP_HEADER MODEL_CONTENT_TYPE MODEL_CONTENT_LENGTH MODEL_BETA_HEADER MODEL_BODY_UTF8 MODEL_BODY_TYPE MODEL_BODY_BOM MODEL_BODY_COMPLEXITY MODEL_BODY_JSON MODEL_BODY_OBJECT MODEL_REQUEST MODEL_REQUEST_FIELD MODEL_METHOD MODEL_TARGET').split(' '));
const safeCode=error=>SAFE_CODES.has(error?.code)?error.code:'BROKER_TRANSPORT';
const fail=code=>{throw new StrictModelBrokerError(code);};
const record=(value,code)=>{
  if(!value || typeof value!=='object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail(code);
  const out=Object.create(null);
  for(const key of Reflect.ownKeys(value)) {
    const d=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string' || !d?.enumerable || !('value' in d)) fail(code);
    out[key]=d.value;
  }
  return out;
};
function rawHeaders(raw,code,maxBytes=32768) {
  if(!Array.isArray(raw) || raw.length%2 || raw.length>2048) fail(code);
  const out=Object.create(null); let bytes=0;
  for(let i=0;i<raw.length;i+=2) {
    const a=Object.getOwnPropertyDescriptor(raw,String(i)),b=Object.getOwnPropertyDescriptor(raw,String(i+1));
    if(!a || !b || !('value'in a) || !('value'in b)) fail(code);
    const name=a.value, value=b.value;
    if(typeof name!=='string' || typeof value!=='string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\0\r\n]/.test(value)) fail(code);
    const lower=name.toLowerCase(); bytes+=Buffer.byteLength(name)+Buffer.byteLength(value);
    if(bytes>maxBytes || Object.hasOwn(out,lower)) fail(code);
    out[lower]=value;
  }
  return out;
}
function requestCopy(value,limit) {
  const request=record(value,'BROKER_REQUEST');
  if(Object.keys(request).some(k=>!['method','target','headers','rawHeaders','body'].includes(k))) fail('BROKER_REQUEST');
  if(Object.hasOwn(request,'headers') && Object.hasOwn(request,'rawHeaders')) fail('BROKER_HEADERS');
  let headers;
  if(Object.hasOwn(request,'rawHeaders')) headers=rawHeaders(request.rawHeaders,'BROKER_HEADERS');
  else headers=record(request.headers??{},'BROKER_HEADERS');
  // Reject ambiguous transport framing rather than forwarding or interpreting it.
  for(const key of Object.keys(headers)) if(['transfer-encoding','trailer','upgrade','expect'].includes(key.toLowerCase())) fail('BROKER_FRAMING');
  return parseModelRequest({method:request.method,target:request.target,headers,body:request.body},
    {...STRICT_MODEL_PROFILE,maxBodyBytes:limit});
}
const responseHeaders=(response,limit,target)=>{
  const headers=rawHeaders(response.rawHeaders,'BROKER_RESPONSE_HEADERS',limit);
  if(Object.hasOwn(headers,'location')) fail('MODEL_REDIRECT_REFUSED');
  validateNoRedirect(response.status,headers.location);
  if(Object.hasOwn(headers,'transfer-encoding') || Object.hasOwn(headers,'trailer') || Object.hasOwn(headers,'upgrade')) fail('BROKER_RESPONSE_FRAMING');
  if(headers['content-encoding'] && headers['content-encoding'].toLowerCase()!=='identity') fail('BROKER_RESPONSE_ENCODING');
  const type=headers['content-type']?.toLowerCase();
  const json=/^application\/json(?:;\s*charset=utf-8)?$/i.test(type??'');
  const sse=/^text\/event-stream(?:;\s*charset=utf-8)?$/i.test(type??'');
  if(!json && !(sse && !target.startsWith('/v1/messages/count_tokens'))) fail('BROKER_RESPONSE_TYPE');
  if(headers['content-length']!==undefined && !/^(0|[1-9][0-9]*)$/.test(headers['content-length'])) fail('BROKER_RESPONSE_FRAMING');
  return {safe:Object.freeze({'content-type':type}),length:headers['content-length']===undefined?null:Number(headers['content-length'])};
};

export function createMockModelBroker({transport,sessionBudget={},now=Date.now}={}) {
  const supplied=record(sessionBudget,'BROKER_LIMITS'),limits={...STRICT_MOCK_BROKER_LIMITS};
  for(const [key,value] of Object.entries(supplied)) {
    if(!Object.hasOwn(limits,key) || !Number.isSafeInteger(value) || value<1 || value>limits[key]) fail('BROKER_LIMITS');
    limits[key]=value;
  }
  Object.freeze(limits);
  if(!transport || typeof transport.resolve!=='function' || typeof transport.connect!=='function' || typeof now!=='function') fail('BROKER_TRANSPORT');
  // Trusted host dependencies, captured once, never request supplied.
  const resolve=transport.resolve.bind(transport),connect=transport.connect.bind(transport);
  let closed=false,inFlight=0,admitted=0,reservedResponseBytes=0,receivedResponseBytes=0;
  const started=now(),recent=[],active=new Set();
  const sessionExpired=()=>now()-started>=limits.sessionTimeoutMs;
  const sessionTimer=setTimeout(()=>{closed=true;for(const job of active)job.abort('BROKER_SESSION');},limits.sessionTimeoutMs);
  sessionTimer.unref?.();
  const snapshot=()=>Object.freeze({strictState:'unverified',closed,inFlight,admitted,reservedResponseBytes,receivedResponseBytes});
  async function submit(value) {
    // Snapshot all untrusted bytes and headers synchronously before the first await.
    let request;
    try { request=requestCopy(value,limits.maxRequestBytes); }
    catch(error) { throw new StrictModelBrokerError(SAFE_CODES.has(error?.code)?error.code:'BROKER_REQUEST'); }
    if(closed) fail('BROKER_CLOSED');
    if(sessionExpired()) fail('BROKER_SESSION');
    if(inFlight>=limits.maxInFlight) fail('BROKER_CONCURRENCY');
    if(admitted>=limits.maxRequests) fail('BROKER_REQUESTS');
    const instant=now(); while(recent.length && instant-recent[0]>=1000)recent.shift();
    if(recent.length>=limits.maxRequestsPerSecond) fail('BROKER_RATE');
    if(reservedResponseBytes+limits.maxResponseBytes>limits.maxSessionResponseBytes) fail('BROKER_SESSION_BYTES');
    admitted++;inFlight++;recent.push(instant);reservedResponseBytes+=limits.maxResponseBytes;
    const controller=new AbortController();let reason=null,connection=null,total=0;
    let rejectAbort;
    const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
    // Race is always installed before abort can reject.
    const abort=code=>{if(!reason){reason=code;controller.abort();rejectAbort(new StrictModelBrokerError(code));}};
    let finishJob;
    const done=new Promise(resolve=>{finishJob=resolve;});
    const job={abort,done};active.add(job);
    const timer=setTimeout(()=>abort('BROKER_TIMEOUT'),limits.requestTimeoutMs);
    const bounded=async(fn,milliseconds)=>{
      let t;
      try {return await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)fail(reason??'BROKER_CLOSED');return fn();}),aborted,new Promise((_,reject)=>{
        t=setTimeout(()=>{abort('BROKER_TIMEOUT');reject(new StrictModelBrokerError('BROKER_TIMEOUT'));},milliseconds);
      })]);} finally {clearTimeout(t);}
    };
    try {
      const answers=await bounded(()=>resolve(request.host,{signal:controller.signal}),limits.dnsTimeoutMs);
      const addresses=validateResolvedAddresses(answers);
      const address=addresses[0];
      connection=await bounded(async()=>{
        const opened=await connect({address,port:443,servername:request.host,rejectUnauthorized:true,alpn:'http/1.1',signal:controller.signal});
        if(controller.signal.aborted){try{Promise.resolve(opened.close()).catch(()=>{});}catch{}fail(reason??'BROKER_CLOSED');}
        return opened;
      },limits.connectTimeoutMs);
      if(connection?.peerAddress!==address) fail('BROKER_PEER');
      const tls=connection.tls;
      if(!tls || tls.authorized!==true || tls.hostname!==request.host || tls.servername!==request.host || tls.alpn!=='http/1.1') fail('BROKER_TLS');
      if(typeof connection.request!=='function' || typeof connection.close!=='function') fail('BROKER_TRANSPORT');
      // This unmistakable fixed dummy is not a production credential interface.
      const headers=Object.freeze({...request.headers,'x-api-key':'strict-mock-upstream-dummy-only'});
      const response=await bounded(()=>connection.request({method:request.method,target:request.target,headers,body:Buffer.from(request.bodyText),signal:controller.signal}),limits.requestTimeoutMs);
      const metadata=responseHeaders(response,limits.maxResponseHeaderBytes,request.target);
      if(metadata.length!==null && (!Number.isSafeInteger(metadata.length) || metadata.length>limits.maxResponseBytes)) fail('BROKER_RESPONSE_BYTES');
      if(!response.body || typeof response.body[Symbol.asyncIterator]!=='function') fail('BROKER_RESPONSE_BODY');
      const iterator=response.body[Symbol.asyncIterator](),chunks=[];let chunkCount=0;
      try {
        for(;;){
          const part=await bounded(()=>iterator.next(),limits.requestTimeoutMs);
          if(part.done)break;
          if(!(part.value instanceof Uint8Array)) fail('BROKER_RESPONSE_BODY');
          if(part.value.byteLength===0) fail('BROKER_RESPONSE_BODY');
          if(++chunkCount>limits.maxResponseChunks) fail('BROKER_RESPONSE_CHUNKS');
          total+=part.value.byteLength;
          if(total>limits.maxResponseBytes) fail('BROKER_RESPONSE_BYTES');
          receivedResponseBytes+=part.value.byteLength;chunks.push(Buffer.from(part.value));
        }
      } finally {if(typeof iterator.return==='function')Promise.resolve().then(()=>iterator.return()).catch(()=>{});}
      if(metadata.length!==null && total!==metadata.length) fail('BROKER_RESPONSE_FRAMING');
      return Object.freeze({ok:true,strictState:'unverified',status:response.status,headers:metadata.safe,body:Buffer.concat(chunks,total)});
    } catch(error) {
      const code=reason??safeCode(error);
      throw new StrictModelBrokerError(code);
    } finally {
      clearTimeout(timer);controller.abort();active.delete(job);inFlight--;
      try {const closing=connection?.close();Promise.resolve(closing).catch(()=>{});} catch{}
      finishJob();
    }
  }
  return Object.freeze({submit,snapshot,async close(){
    closed=true;clearTimeout(sessionTimer);
    const jobs=[...active];for(const job of jobs)job.abort('BROKER_CLOSED');
    let timer;
    try {await Promise.race([Promise.all(jobs.map(job=>job.done)),new Promise(resolve=>{timer=setTimeout(resolve,100);})]);}
    finally {clearTimeout(timer);}
  }});
}
