// Pure candidate codec tests. Fixture keys are public test data, never credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {normalizeCode as consoleNormalize,acceptInput} from '../lib/strict-control-console.mjs';
import {HUMAN_COMMAND_VERSION,HUMAN_CODE_DOMAIN,HUMAN_COMMAND_DOMAIN,HUMAN_CODE_INPUT_LIMIT,HumanCommandError,normalizeHumanCode,parseHumanCommand,humanCommandIdentity,encodeHumanCodeMessage,deriveHumanCode} from '../lib/strict-human-command.mjs';
const vectors=JSON.parse(readFileSync(new URL('./fixtures/strict-human-code-vectors.json',import.meta.url),'utf8'));
const key=()=>Buffer.from(Array.from({length:32},(_,i)=>i));
const state=(change={})=>({protocolVersion:2,projectId:'project-1',sessionId:'session-1',reviewRoundId:'round-1',revision:4,phase:'skeleton',reviewVersion:'a'.repeat(64),captureVersion:'b'.repeat(64),approvedVersion:null,approvedCaptureVersion:null,...change});
const raw=(change={})=>({requestId:'request-1',action:'approve',code:'qfbf 8qm4',...change});
const expectCode=(code,fn)=>assert.throws(fn,error=>error instanceof HumanCommandError&&error.code===code&&error.message===code);
function fields(bytes,domain){
 assert.equal(bytes.subarray(0,domain.length).toString(),domain);let offset=domain.length;const out=[];
 while(offset<bytes.length){const n=bytes.readUInt32BE(offset);offset+=4;out.push(bytes.subarray(offset,offset+n).toString('utf8'));offset+=n;}
 assert.equal(offset,bytes.length);return out;
}

test('versioned candidate fixtures reproduce bytes, full HMAC and 40-bit bit order',()=>{
 assert.equal(HUMAN_COMMAND_VERSION,'human-code-v1');assert.equal(HUMAN_CODE_DOMAIN,'skel-human-code-v1');assert.equal(HUMAN_COMMAND_DOMAIN,'skel-human-command-v1');
 for(const row of vectors.codeVectors){
  const fixtureKey=Buffer.from(row.keyHex,'hex'),message=encodeHumanCodeMessage(row.state,row.action);
  assert.equal(message.toString('hex'),row.messageHex,row.name);
  assert.equal(createHmac('sha256',fixtureKey).update(message).digest('hex'),row.hmacHex,row.name);
  assert.equal(deriveHumanCode(row.state,row.action,fixtureKey),row.code,row.name);
  const first5=Buffer.from(row.hmacHex,'hex').subarray(0,5);
  let binary=[...first5].map(x=>x.toString(2).padStart(8,'0')).join('');
  const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let encoded='';
  for(let i=0;i<40;i+=5)encoded+=alphabet[Number.parseInt(binary.slice(i,i+5),2)];
  assert.equal(row.code,encoded.slice(0,4)+'-'+encoded.slice(4),row.name);
 }
});

test('command vectors canonicalize raw method arguments and exact five LP identity fields',()=>{
 for(const row of vectors.commandVectors){
  assert.deepEqual(parseHumanCommand(row.operation,row.input),row.canonical,row.name);
  const identity=humanCommandIdentity(row.operation,row.input);
  assert.equal(identity.toString('hex'),row.identityHex,row.name);
  assert.deepEqual(fields(identity,HUMAN_COMMAND_DOMAIN),['human-code-v1',row.operation,row.canonical.requestId,row.canonical.action??'',row.canonical.code??'']);
 }
});

test('ASCII code normalization agrees with accepted console spellings and rejects Unicode before folding',()=>{
 assert.equal(HUMAN_CODE_INPUT_LIMIT,200);
 for(const row of vectors.normalizationVectors)assert.equal(normalizeHumanCode(row.input),row.expected);
 for(const input of ['k7m2 qx9d','IOLL-0000','   q-f-b-f 8-q-m-4  ','qfbf8qm4']){
  assert.notEqual(acceptInput(input),null);assert.equal(normalizeHumanCode(input),consoleNormalize(input));
 }
 for(const input of [null,undefined,Buffer.from('QFBF8QM4'),new String('QFBF8QM4'),'QFBF\t8QM4','QFBF\n8QM4','QFBF\r8QM4','QFBF\x1b8QM4','QFBF\u00a08QM4','\u212a7M2QX9D','Ｋ7M2QX9D','QFBF_8QM4','QFBFUQM4','QFBF8QM','QFBF8QM44',' '.repeat(100000)])assert.equal(normalizeHumanCode(input),null);
});

test('canonical commands retain action/id spelling and exclude caller state, version and transition facts',()=>{
 const command=parseHumanCommand('verifyAndCommit',raw());assert.ok(Object.isFrozen(command));
 assert.deepEqual(command,{operationVersion:'human-code-v1',operation:'verifyAndCommit',requestId:'request-1',action:'approve',code:'QFBF-8QM4'});
 assert.deepEqual(parseHumanCommand('recapture',{requestId:'R-1'}),{operationVersion:'human-code-v1',operation:'recapture',requestId:'R-1'});
 assert.deepEqual(parseHumanCommand('endSession',{requestId:'R-1'}),{operationVersion:'human-code-v1',operation:'endSession',requestId:'R-1'});
 for(const operation of ['finalize','Approve','verifyandcommit','end','state',null])assert.equal(parseHumanCommand(operation,raw()),null);
 for(const extra of ['operationVersion','operation','projectId','sessionId','reviewRoundId','revision','captureVersion','key','completionVerified'])assert.equal(parseHumanCommand('verifyAndCommit',raw({[extra]:'injected'})),null);
 for(const action of ['Approve','approve ','finalize','recapture',null])assert.equal(parseHumanCommand('verifyAndCommit',raw({action})),null);
 for(const operation of ['recapture','endSession'])assert.equal(parseHumanCommand(operation,raw()),null);
});

test('request IDs use the console opaque grammar and 128-character bound, without an entropy claim',()=>{
 for(const requestId of ['A','r.1_:-Z','a'.repeat(128)])assert.equal(parseHumanCommand('verifyAndCommit',raw({requestId})).requestId,requestId);
 for(const requestId of ['',':a','a'.repeat(129),'a b','a/../b','a\n','a\0','é',Buffer.from('r')])assert.equal(parseHumanCommand('verifyAndCommit',raw({requestId})),null);
 assert.notDeepEqual(humanCommandIdentity('verifyAndCommit',raw({requestId:'Case'})),humanCommandIdentity('verifyAndCommit',raw({requestId:'case'})));
});

test('identities collapse only code aliases and distinguish all operations/action/code/id changes',()=>{
 assert.deepEqual(humanCommandIdentity('verifyAndCommit',raw({code:'ioll 0000'})),humanCommandIdentity('verifyAndCommit',raw({code:'1011-OOOO'})));
 const base=humanCommandIdentity('verifyAndCommit',raw());
 for(const value of [raw({action:'reshape'}),raw({code:'0000-0000'}),raw({requestId:'request-2'})])assert.notDeepEqual(base,humanCommandIdentity('verifyAndCommit',value));
 assert.notDeepEqual(humanCommandIdentity('recapture',{requestId:'same'}),humanCommandIdentity('endSession',{requestId:'same'}));
 expectCode('HUMAN_COMMAND',()=>humanCommandIdentity('verifyAndCommit',raw({code:'bad'})));
 const changed=humanCommandIdentity('verifyAndCommit',raw());changed.fill(0);assert.deepEqual(humanCommandIdentity('verifyAndCommit',raw()),base);
});

test('approve uses selected pair and reshape uses approved pair, not filled selected capture',()=>{
 assert.equal(deriveHumanCode(state(),'approve',key()),'QFBF-8QM4');
 const fill=state({phase:'fill',approvedVersion:'a'.repeat(64),approvedCaptureVersion:'b'.repeat(64),reviewVersion:'c'.repeat(64),captureVersion:'d'.repeat(64)});
 assert.equal(deriveHumanCode(fill,'reshape',key()),'7AAR-VVF1');
 assert.equal(deriveHumanCode({...fill,reviewVersion:'e'.repeat(64),captureVersion:'f'.repeat(64)},'reshape',key()),'7AAR-VVF1');
 for(const [s,action] of [[state(),'reshape'],[fill,'approve'],[{...fill,phase:'finalized'},'reshape'],[state(),'finalize']])expectCode('HUMAN_ACTION',()=>deriveHumanCode(s,action,key()));
});

test('every bound HMAC field changes the message and code, with canonical numeric revision',()=>{
 const original=deriveHumanCode(state(),'approve',key()),message=encodeHumanCodeMessage(state(),'approve');
 assert.deepEqual(fields(message,HUMAN_CODE_DOMAIN),['approve','project-1','session-1','round-1','4','a'.repeat(64),'b'.repeat(64)]);
 for(const patch of [{projectId:'project-2'},{sessionId:'session-2'},{reviewRoundId:'round-2'},{revision:5},{reviewVersion:'c'.repeat(64)},{captureVersion:'d'.repeat(64)}])assert.notEqual(deriveHumanCode(state(patch),'approve',key()),original);
 for(const revision of [0,Number.MAX_SAFE_INTEGER])assert.equal(fields(encodeHumanCodeMessage(state({revision}),'approve'),HUMAN_CODE_DOMAIN)[4],String(revision));
 for(const patch of [{protocolVersion:1},{revision:'04'},{revision:4n},{revision:-0},{revision:-1},{revision:NaN},{revision:Number.MAX_SAFE_INTEGER+1},{projectId:'x\n'},{sessionId:'é'},{reviewRoundId:'a'.repeat(257)},{reviewVersion:'A'.repeat(64)},{captureVersion:'b'.repeat(64)+'\n'},{approvedVersion:'a'.repeat(64)}])expectCode('HUMAN_STATE',()=>encodeHumanCodeMessage(state(patch),'approve'));
});

test('records reject accessors, extra/prototype/symbol keys and throwing proxies without leaking errors',()=>{
 let touched=false;
 const accessor=raw();Object.defineProperty(accessor,'code',{enumerable:true,get(){touched=true;throw Error('SECRET');}});
 assert.equal(parseHumanCommand('verifyAndCommit',accessor),null);assert.equal(touched,false);
 const inherited=Object.assign(Object.create({}),raw());assert.equal(parseHumanCommand('verifyAndCommit',inherited),null);
 const symbol=raw();symbol[Symbol('secret')]=true;assert.equal(parseHumanCommand('verifyAndCommit',symbol),null);
 const proxy=new Proxy(raw(),{ownKeys(){throw Error('SECRET');}});assert.equal(parseHumanCommand('verifyAndCommit',proxy),null);
 const hostileState=new Proxy(state(),{ownKeys(){throw Error('SECRET');}});expectCode('HUMAN_STATE',()=>deriveHumanCode(hostileState,'approve',key()));
 const nullProto=Object.assign(Object.create(null),raw());assert.ok(parseHumanCommand('verifyAndCommit',nullProto));
});

test('keys require exactly 32 private buffer bytes and copy before inspecting state',()=>{
 const original=key(),baseline=deriveHumanCode(state(),'approve',original);
 assert.equal(deriveHumanCode(state(),'approve',new Uint8Array(original)),baseline);
 const backing=Buffer.alloc(40);original.copy(backing,4);assert.equal(deriveHumanCode(state(),'approve',backing.subarray(4,36)),baseline);
 let touched=false;const shadowed=new Uint8Array(original);Object.defineProperty(shadowed,'buffer',{get(){touched=true;throw Error('SECRET');}});
 assert.equal(deriveHumanCode(state(),'approve',shadowed),baseline);assert.equal(touched,false);
 const changed=key();const mutatingState=new Proxy(state(),{ownKeys(target){changed.fill(255);return Reflect.ownKeys(target);}});
 assert.equal(deriveHumanCode(mutatingState,'approve',changed),baseline);assert.equal(changed[0],255);
 for(const invalid of [null,'00'.repeat(32),Array(32).fill(0),new ArrayBuffer(32),Buffer.alloc(31),Buffer.alloc(33),new Uint16Array(16),new Uint8Array(new SharedArrayBuffer(32)),new Proxy(key(),{})])expectCode('HUMAN_KEY',()=>deriveHumanCode(state(),'approve',invalid));
 assert.deepEqual(original,key(),'caller key bytes are retained unchanged');
});

test('codec is disabled and production lib/bin do not import it',()=>{
 for(const directory of ['lib','bin'])for(const file of readdirSync(new URL('../'+directory+'/',import.meta.url)))if(file!=='strict-human-command.mjs')assert.doesNotMatch(readFileSync(new URL('../'+directory+'/'+file,import.meta.url),'utf8'),/strict-human-command/);
});
