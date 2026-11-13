import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createMockModelBroker,StrictModelBrokerError,STRICT_MOCK_BROKER_LIMITS} from '../lib/strict-model-broker.mjs';
import {createStrictModelTransport} from './fixtures/strict-model-transport.mjs';

test('exported socket-free simulator exercises JSON, SSE and peer refusal',async()=>{
 for(const sse of [false,true]){
  const fixture=createStrictModelTransport({sse});
  const broker=createMockModelBroker({transport:fixture.transport});
  try {
   const result=await broker.submit(request());
   assert.equal(result.status,200);
   assert.equal(result.headers['content-type'],sse?'text/event-stream':'application/json');
   assert.equal(fixture.evidence.requests.length,1);
   assert.equal(fixture.evidence.closes,1);
  } finally {await broker.close();}
 }
 const fixture=createStrictModelTransport({peerAddress:'127.0.0.1'});
 const broker=createMockModelBroker({transport:fixture.transport});
 try {await assert.rejects(broker.submit(request()),error=>error.code==='BROKER_PEER');assert.equal(fixture.evidence.requests.length,0);}
 finally {await broker.close();}
});

const INBOUND='DUMMY_INBOUND_BROKER_SECRET_NEVER_FORWARD';
const PUBLIC='8.8.8.8';
const request=(change={})=>({method:'POST',target:'/v1/messages',rawHeaders:['Content-Type','application/json','Authorization',INBOUND,'Cookie',INBOUND],body:Buffer.from('{"model":"fixture"}'),...change});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function harness(change={}) {
 const evidence={resolve:0,connect:0,send:0,close:0,aborts:0};
 const calls={};
 const body=change.body??Buffer.from('{"fixture":true}');
 const transport={
  async resolve(host,{signal}) {evidence.resolve++;calls.host=host;calls.resolveSignal=signal;if(change.resolve)return change.resolve(host,{signal});return change.answers??[PUBLIC];},
  async connect(options) {
   evidence.connect++;calls.connect=options;
   if(change.connect)return change.connect(options);
   return {
    peerAddress:change.peerAddress??options.address,
    tls:change.tls??{authorized:true,hostname:'api.anthropic.com',servername:'api.anthropic.com',alpn:'http/1.1'},
    async request(value) {
     evidence.send++;calls.request=value;
     return {status:change.status??200,rawHeaders:change.rawHeaders??['content-type','application/json'],body:change.stream??(async function*(){yield body;})()};
    },
    close(){evidence.close++;},
   };
  },
 };
 return {transport,evidence,calls};
}
async function code(promise,expected) {
 await assert.rejects(promise,error=>error instanceof StrictModelBrokerError && error.code===expected,expected);
}
async function control() {
 const h=harness(),broker=createMockModelBroker({transport:h.transport});
 try {const r=await broker.submit(request());assert.equal(r.ok,true);assert.equal(h.evidence.send,1);}
 finally {await broker.close();}
}
function abortPending(signal,evidence) {
 return new Promise((resolve,reject)=>{
  const abort=()=>{evidence.aborts++;reject(new Error('fixture-aborted'));};
  if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
 });
}

test('valid JSON/SSE/count endpoints use one literal peer and rebuilt credential-safe headers',async()=>{
 for(const [target,type] of [['/v1/messages','application/json'],['/v1/messages?beta=true','text/event-stream'],['/v1/messages/count_tokens','application/json'],['/v1/messages/count_tokens?beta=true','application/json']]) {
  const h=harness({rawHeaders:['content-type',type,'set-cookie','DUMMY_RESPONSE_SECRET','connection','keep-alive']}),broker=createMockModelBroker({transport:h.transport});
  try {
   const r=await broker.submit(request({target,rawHeaders:['Content-Type','application/json','Authorization',INBOUND,'x-api-key',INBOUND,'Cookie',INBOUND,'Proxy-Authorization',INBOUND,'Connection','anthropic-beta','anthropic-beta','untrusted-beta']}));
   assert.equal(r.ok,true);assert.equal(r.strictState,'unverified');assert.ok(Buffer.isBuffer(r.body));
   assert.equal(h.evidence.resolve,1);assert.equal(h.evidence.connect,1);assert.equal(h.evidence.send,1);
   assert.equal(h.calls.host,'api.anthropic.com');
   for(const [k,v] of Object.entries({address:PUBLIC,port:443,servername:'api.anthropic.com',rejectUnauthorized:true,alpn:'http/1.1'}))assert.equal(h.calls.connect[k],v);
   assert.equal(h.calls.request.target,target);assert.equal(h.calls.request.method,'POST');
   assert.equal(h.calls.request.body.toString(),'{"model":"fixture"}');
   assert.equal(h.calls.request.headers.host,'api.anthropic.com:443');
   assert.equal(h.calls.request.headers['anthropic-version'],'2023-06-01');
   assert.equal(JSON.stringify(h.calls.request.headers).includes(INBOUND),false);
   assert.equal(Object.hasOwn(h.calls.request.headers,'cookie'),false);
   assert.equal(h.calls.request.headers['x-api-key']==='strict-mock-upstream-dummy-only',true);
   assert.equal(Object.hasOwn(h.calls.request.headers,'anthropic-beta'),false);
   assert.equal(JSON.stringify(r).includes('DUMMY_RESPONSE_SECRET'),false);
   const snapshot=broker.snapshot();assert.equal(snapshot.inFlight,0);assert.equal(snapshot.admitted,1);assert.equal(snapshot.reservedResponseBytes,STRICT_MOCK_BROKER_LIMITS.maxResponseBytes);
   assert.equal(snapshot.receivedResponseBytes,r.body.length);
  } finally {await broker.close();}
 }
});

// Specific refusal codes are supplied by the disabled broker contract, not
// generic throws that could pass because an unrelated check happened to fail.
test('request and raw-header ambiguity refuse before DNS, connection or credential send',async()=>{
 await control();
 for(const [change,expected] of [
  [{method:'CONNECT'},'MODEL_METHOD'],[{target:'https://evil.example/v1/messages'},'MODEL_TARGET'],
  [{target:'/v1/messages?beta=true&destination=evil'},'MODEL_TARGET'],
  [{rawHeaders:['Host','a','host','b']},'BROKER_HEADERS'],
  [{rawHeaders:['content-length','1','transfer-encoding','chunked']},'BROKER_FRAMING'],
  [{rawHeaders:['upgrade','websocket']},'BROKER_FRAMING'],
 ]) {
  const h=harness(),broker=createMockModelBroker({transport:h.transport});
  try {await code(broker.submit(request(change)),expected);assert.equal(h.evidence.resolve,0);assert.equal(h.evidence.connect,0);assert.equal(h.evidence.send,0);assert.equal(broker.snapshot().inFlight,0);}
  finally {await broker.close();}
 }
});

test('all resolver answers are validated, and mismatched connected peer sends nothing',async()=>{
 await control();
 for(const answers of [[],Array(65).fill(PUBLIC),['127.0.0.1'],['10.0.0.1'],['169.254.169.254'],['100.64.0.1'],['192.0.2.1'],['224.0.0.1'],['::1'],['::ffff:8.8.8.8'],[PUBLIC,'172.16.0.1']]) {
  const h=harness({answers}),broker=createMockModelBroker({transport:h.transport});
  try {await code(broker.submit(request()),answers.length===0||answers.length>64?'MODEL_DNS_ANSWERS':'MODEL_DNS_NONPUBLIC_OR_UNSUPPORTED');assert.equal(h.evidence.resolve,1);assert.equal(h.evidence.connect,0);assert.equal(h.evidence.send,0);assert.equal(broker.snapshot().admitted,1);}
  finally {await broker.close();}
 }
 const h=harness({peerAddress:'1.1.1.1'}),broker=createMockModelBroker({transport:h.transport});
 try {await code(broker.submit(request()),'BROKER_PEER');assert.equal(h.evidence.resolve,1);assert.equal(h.evidence.connect,1);assert.equal(h.evidence.send,0);assert.equal(h.evidence.close,1);}
 finally {await broker.close();}
});

test('a resolver that would rebind is called once and connection remains literal pinned',async()=>{
 let lookup=0;
 const h=harness({resolve:async()=>++lookup===1?[PUBLIC]:['127.0.0.1']}),broker=createMockModelBroker({transport:h.transport});
 try {assert.equal((await broker.submit(request())).ok,true);assert.equal(lookup,1);assert.equal(h.calls.connect.address,PUBLIC);assert.equal(h.evidence.connect,1);assert.equal(h.evidence.send,1);}
 finally {await broker.close();}
});

test('untrusted TLS identity never receives credentials/body and never retries',async()=>{
 await control();
 const valid={authorized:true,hostname:'api.anthropic.com',servername:'api.anthropic.com',alpn:'http/1.1'};
 for(const tls of [{...valid,authorized:false},{...valid,hostname:'evil.example'},{...valid,servername:'evil.example'},{...valid,alpn:'h2'}]) {
  const h=harness({tls}),broker=createMockModelBroker({transport:h.transport});
  try {await code(broker.submit(request()),'BROKER_TLS');assert.equal(h.evidence.send,0);assert.equal(h.evidence.connect,1);assert.equal(h.evidence.close,1);}
  finally {await broker.close();}
 }
});

test('redirects, unsafe response types and bounded streams refuse without fallback',async()=>{
 await control();
 for(const [change,expected] of [
  [{status:302,rawHeaders:['content-type','application/json','location','https://127.0.0.1/']},'MODEL_REDIRECT_REFUSED'],
  [{status:307},'MODEL_REDIRECT_REFUSED'],[{rawHeaders:['content-type','application/json','location','https://api.anthropic.com/v1/messages']},'MODEL_REDIRECT_REFUSED'],
  [{rawHeaders:['content-type','application/json','location','']},'MODEL_REDIRECT_REFUSED'],
  [{rawHeaders:['content-type','text/html']},'BROKER_RESPONSE_TYPE'],
  [{rawHeaders:['content-type','application/json','content-encoding','gzip']},'BROKER_RESPONSE_ENCODING'],
 ]) {
  const h=harness(change),broker=createMockModelBroker({transport:h.transport});
  try {await code(broker.submit(request()),expected);assert.equal(h.evidence.send,1);assert.equal(h.evidence.connect,1);assert.equal(h.evidence.resolve,1);assert.equal(h.evidence.close,1);assert.equal(broker.snapshot().inFlight,0);}
  finally {await broker.close();}
 }
 const h=harness({body:Buffer.alloc(65)}),broker=createMockModelBroker({transport:h.transport,sessionBudget:{maxResponseBytes:64}});
 try {await code(broker.submit(request()),'BROKER_RESPONSE_BYTES');assert.equal(h.evidence.send,1);assert.equal(h.evidence.close,1);assert.equal(broker.snapshot().inFlight,0);assert.equal(broker.snapshot().reservedResponseBytes,64);}
 finally {await broker.close();}
});

test('admission reserves synchronously before DNS awaits and closes active work',async()=>{
 await control();
 const entered=deferred();let evidence;
 const h=harness({resolve:(_,{signal})=>{entered.resolve();return abortPending(signal,evidence);}});evidence=h.evidence;
 const broker=createMockModelBroker({transport:h.transport});
 const first=broker.submit(request());const failed=code(first,'BROKER_CLOSED');
 await entered.promise;
 assert.equal(broker.snapshot().inFlight,1);assert.equal(broker.snapshot().admitted,1);
 await code(broker.submit(request()),'BROKER_CONCURRENCY');
 assert.equal(h.evidence.resolve,1);assert.equal(broker.snapshot().admitted,1);
 await broker.close();await failed;
 assert.equal(h.evidence.aborts,1);assert.equal(broker.snapshot().inFlight,0);
 assert.equal(broker.snapshot().admitted,1);assert.equal(broker.snapshot().closed,true);
 await code(broker.submit(request()),'BROKER_CLOSED');assert.equal(h.evidence.resolve,1);
});

test('rolling admission bounds include count_tokens and failure attempts retain reservations',async()=>{
 let instant=0;
 const h=harness(),broker=createMockModelBroker({transport:h.transport,now:()=>instant,sessionBudget:{maxResponseBytes:32,maxSessionResponseBytes:512}});
 try {
  for(let n=0;n<4;n++)assert.equal((await broker.submit(request({target:'/v1/messages/count_tokens'}))).ok,true);
  instant=999;await code(broker.submit(request()),'BROKER_RATE');assert.equal(h.evidence.send,4);
  instant=1000;assert.equal((await broker.submit(request())).ok,true);
  assert.equal(broker.snapshot().admitted,5);assert.equal(broker.snapshot().reservedResponseBytes,160);
 } finally {await broker.close();}
 const bad=harness({peerAddress:'1.1.1.1'}),limited=createMockModelBroker({transport:bad.transport,sessionBudget:{maxResponseBytes:32,maxSessionResponseBytes:64}});
 try {
  await code(limited.submit(request()),'BROKER_PEER');await code(limited.submit(request()),'BROKER_PEER');
  await code(limited.submit(request()),'BROKER_SESSION_BYTES');
  assert.equal(limited.snapshot().admitted,2);assert.equal(limited.snapshot().reservedResponseBytes,64);assert.equal(bad.evidence.send,0);assert.equal(bad.evidence.resolve,2);
 } finally {await limited.close();}
});

test('hard request and session lifetime bounds reject before another DNS lookup',async()=>{
 const h=harness(),broker=createMockModelBroker({transport:h.transport,sessionBudget:{maxRequests:2,maxResponseBytes:32}});
 try {await broker.submit(request());await broker.submit(request());await code(broker.submit(request()),'BROKER_REQUESTS');assert.equal(h.evidence.resolve,2);assert.equal(broker.snapshot().admitted,2);}
 finally {await broker.close();}
 let instant=0;const s=harness(),session=createMockModelBroker({transport:s.transport,now:()=>instant,sessionBudget:{sessionTimeoutMs:100}});
 try {await session.submit(request());instant=100;await code(session.submit(request()),'BROKER_SESSION');assert.equal(s.evidence.resolve,1);}
 finally {await session.close();}
});

test('DNS/connect/stream timeouts abort underlying transport, release slot and do not retry',async()=>{
 await control();
 for(const phase of ['resolve','connect','stream']) {
  let evidence;
  const change={};
  if(phase==='resolve')change.resolve=(_,{signal})=>abortPending(signal,evidence);
  if(phase==='connect')change.connect=({signal})=>abortPending(signal,evidence);
  const h=harness(change);evidence=h.evidence;
  if(phase==='stream') {
   const original=h.transport.connect;
   h.transport.connect=async options=>{
    const connection=await original(options),send=connection.request;
    connection.request=async value=>{const response=await send(value);response.body={async *[Symbol.asyncIterator](){await abortPending(value.signal,evidence);}};return response;};
    return connection;
   };
  }
  const broker=createMockModelBroker({transport:h.transport,sessionBudget:{dnsTimeoutMs:20,connectTimeoutMs:20,requestTimeoutMs:40}});
  try {await code(broker.submit(request()),'BROKER_TIMEOUT');assert.equal(evidence.aborts,1,phase);assert.equal(evidence.resolve,1);assert.equal(evidence.send,phase==='stream'?1:0);assert.equal(broker.snapshot().inFlight,0);assert.equal(broker.snapshot().admitted,1);}
  finally {await broker.close();}
 }
});

test('close during connect and stream aborts and never falls back',async()=>{
 for(const phase of ['connect','stream']) {
  const entered=deferred();let evidence;
  const change={};if(phase==='connect')change.connect=({signal})=>{entered.resolve();return abortPending(signal,evidence);};
  const h=harness(change);evidence=h.evidence;
  if(phase==='stream') {
   const original=h.transport.connect;
   h.transport.connect=async options=>{const connection=await original(options),send=connection.request;connection.request=async value=>{const r=await send(value);r.body={async *[Symbol.asyncIterator](){entered.resolve();await abortPending(value.signal,evidence);}};return r;};return connection;};
  }
  const broker=createMockModelBroker({transport:h.transport});
  const job=broker.submit(request()),rejected=code(job,'BROKER_CLOSED');
  await entered.promise;await broker.close();await rejected;
  assert.equal(evidence.aborts,1);assert.equal(evidence.resolve,1);assert.equal(evidence.connect,1);assert.equal(broker.snapshot().inFlight,0);
 }
});

test('caller mutations cannot alter admitted body, limits or bound transport functions',async()=>{
 const gate=deferred(),entered=deferred();
 const h=harness({resolve:async()=>{entered.resolve();await gate.promise;return [PUBLIC];}});
 const budget={maxRequests:1,maxResponseBytes:32},broker=createMockModelBroker({transport:h.transport,sessionBudget:budget});
 const body=Buffer.from('{"model":"fixture"}'),headers=['content-type','application/json'],input=request({body,rawHeaders:headers});
 const job=broker.submit(input);await entered.promise;
 body.fill(120);headers[1]='text/html';input.target='/evil';budget.maxRequests=16;
 h.transport.connect=()=>{throw Error('mutated transport must not run');};gate.resolve();
 try {assert.equal((await job).ok,true);assert.equal(h.calls.request.body.toString(),'{"model":"fixture"}');assert.equal(h.calls.request.target,'/v1/messages');await code(broker.submit(request()),'BROKER_REQUESTS');}
 finally {await broker.close();}
});

test('errors and snapshots never expose inbound or host dummy credentials',async()=>{
 const h=harness({status:302,rawHeaders:['content-type','application/json','location','https://example.com/'+INBOUND]}),broker=createMockModelBroker({transport:h.transport});
 let failure;
 try {await broker.submit(request());assert.fail('redirect unexpectedly passed');}catch(error){failure=error;}
 assert.equal(failure.code,'MODEL_REDIRECT_REFUSED');
 const diagnostics=JSON.stringify({error:{name:failure.name,message:failure.message,code:failure.code},snapshot:broker.snapshot()});
 assert.equal(diagnostics.includes(INBOUND),false);assert.equal(diagnostics.includes('strict-mock-upstream-dummy-only'),false);
 await broker.close();
});

test('header cap, framing, infinite SSE and invalid chunks abort their exact failure paths',async()=>{
 await control();
 for(const [change,budget,expected] of [
  [{rawHeaders:['content-type','application/json','x-long','x'.repeat(80)]},{maxResponseHeaderBytes:64},'BROKER_RESPONSE_HEADERS'],
  [{rawHeaders:['content-type','application/json','content-length','999']},{maxResponseBytes:64},'BROKER_RESPONSE_BYTES'],
  [{rawHeaders:['content-type','application/json','content-length','1']},{},'BROKER_RESPONSE_FRAMING'],
  [{rawHeaders:['content-type','application/json','transfer-encoding','chunked']},{},'BROKER_RESPONSE_FRAMING'],
  [{rawHeaders:['content-type','application/json','Content-Type','application/json']},{},'BROKER_RESPONSE_HEADERS'],
  [{stream:(async function*(){yield 'invalid-string-chunk';})()},{},'BROKER_RESPONSE_BODY'],
 ]) {
  const h=harness(change),broker=createMockModelBroker({transport:h.transport,sessionBudget:budget});
  try {await code(broker.submit(request()),expected);assert.equal(h.evidence.send,1);assert.equal(h.evidence.close,1);assert.equal(broker.snapshot().inFlight,0);}
  finally {await broker.close();}
 }
 let yielded=0,returned=false;
 const stream={async *[Symbol.asyncIterator](){try{while(true){yielded++;yield Buffer.alloc(8);}}finally{returned=true;}}};
 const h=harness({rawHeaders:['content-type','text/event-stream'],stream}),broker=createMockModelBroker({transport:h.transport,sessionBudget:{maxResponseBytes:32}});
 try {await code(broker.submit(request()),'BROKER_RESPONSE_BYTES');assert.equal(yielded,5);await Promise.resolve();assert.equal(returned,true);assert.ok(broker.snapshot().receivedResponseBytes<=32);assert.equal(h.evidence.close,1);}
 finally {await broker.close();}
});

test('plain configuration and request descriptors refuse getters without evaluating them',async()=>{
 await control();
 let touched=false;
 const budget={};Object.defineProperty(budget,'maxRequests',{enumerable:true,get(){touched=true;return 1;}});
 assert.throws(()=>createMockModelBroker({transport:harness().transport,sessionBudget:budget}),error=>error instanceof StrictModelBrokerError&&error.code==='BROKER_LIMITS');
 assert.equal(touched,false);
 for(const invalid of [{unknown:1},{maxRequests:17},{maxInFlight:2},{maxResponseBytes:0}])assert.throws(()=>createMockModelBroker({transport:harness().transport,sessionBudget:invalid}),error=>error.code==='BROKER_LIMITS');
 const h=harness(),broker=createMockModelBroker({transport:h.transport});
 const input=request();Object.defineProperty(input,'body',{enumerable:true,get(){touched=true;return '{}';}});
 try {await code(broker.submit(input),'BROKER_REQUEST');assert.equal(touched,false);assert.equal(h.evidence.resolve,0);assert.equal(broker.snapshot().admitted,0);}
 finally {await broker.close();}
});

test('late connection after timeout is closed without sends or unhandled close rejection',()=>{
 const moduleUrl=new URL('../lib/strict-model-broker.mjs',import.meta.url).href;
 execFileSync(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',`
  import assert from 'node:assert/strict';
  import {setTimeout as delay} from 'node:timers/promises';
  import {createMockModelBroker} from ${JSON.stringify(moduleUrl)};
  let release,closes=0,sends=0;
  const transport={resolve:async()=>['8.8.8.8'],connect:()=>new Promise(r=>{release=r;})};
  const broker=createMockModelBroker({transport,sessionBudget:{connectTimeoutMs:10,requestTimeoutMs:100}});
  await assert.rejects(broker.submit({method:'POST',target:'/v1/messages',body:'{}'}),e=>e.code==='BROKER_TIMEOUT');
  assert.equal(broker.snapshot().inFlight,0);
  release({peerAddress:'8.8.8.8',tls:{authorized:true,hostname:'api.anthropic.com',servername:'api.anthropic.com',alpn:'http/1.1'},request(){sends++;},close(){closes++;return Promise.reject(Error('fixture-close-rejected'));}});
  await delay(30);
  assert.equal(closes,1);assert.equal(sends,0);
  await broker.close();
 `],{timeout:3000,stdio:'pipe'});
});

test('dependency codes cannot smuggle credential-shaped text into broker diagnostics',async()=>{
 await control();
 const sentinel='BROKER_DUMMY_INBOUND_SECRET_NEVER_LOG';
 const h=harness({resolve:async()=>{throw Object.assign(new Error(INBOUND),{code:sentinel});}}),broker=createMockModelBroker({transport:h.transport});
 try {
  await assert.rejects(broker.submit(request()),error=>{
   assert.equal(error.code,'BROKER_TRANSPORT');
   const diagnostic=JSON.stringify({name:error.name,message:error.message,code:error.code,snapshot:broker.snapshot()});
   assert.equal(diagnostic.includes(INBOUND),false);assert.equal(diagnostic.includes(sentinel),false);
   return true;
  });
  assert.equal(h.evidence.connect,0);assert.equal(h.evidence.send,0);
 } finally {await broker.close();}
});

test('immediate empty and one-byte infinite streams refuse before starving deadline timers',()=>{
 const moduleUrl=new URL('../lib/strict-model-broker.mjs',import.meta.url).href;
 execFileSync(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',`
  import assert from 'node:assert/strict';
  import {createMockModelBroker} from ${JSON.stringify(moduleUrl)};
  const input={method:'POST',target:'/v1/messages',body:'{}'};
  let closed=0,yielded=0;
  function transport(size,infinite=true){return {
   resolve:async()=>['8.8.8.8'],
   connect:async()=>({peerAddress:'8.8.8.8',tls:{authorized:true,hostname:'api.anthropic.com',servername:'api.anthropic.com',alpn:'http/1.1'},
    request:async()=>({status:200,rawHeaders:['content-type','text/event-stream'],body:{async *[Symbol.asyncIterator](){do{yielded++;yield Buffer.alloc(size);}while(infinite);}}}),
    close(){closed++;}})
  };}
  const positive=createMockModelBroker({transport:transport(1,false),sessionBudget:{maxResponseChunks:4}});
  assert.equal((await positive.submit(input)).ok,true);await positive.close();
  yielded=0;closed=0;
  const empty=createMockModelBroker({transport:transport(0),sessionBudget:{requestTimeoutMs:100,maxResponseChunks:4}});
  await assert.rejects(empty.submit(input),e=>e.code==='BROKER_RESPONSE_BODY');
  assert.equal(yielded,1);assert.equal(closed,1);assert.equal(empty.snapshot().inFlight,0);await empty.close();
  yielded=0;closed=0;
  const chunks=createMockModelBroker({transport:transport(1),sessionBudget:{requestTimeoutMs:100,maxResponseChunks:4}});
  await assert.rejects(chunks.submit(input),e=>e.code==='BROKER_RESPONSE_CHUNKS');
  assert.equal(yielded,5);assert.equal(closed,1);assert.equal(chunks.snapshot().inFlight,0);await chunks.close();
 `],{timeout:1000,stdio:'pipe'});
});
