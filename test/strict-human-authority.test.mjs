// Public fixture keys; this disabled candidate has no storage or auth surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHumanAuthorityRecord,parseHumanAuthorityRecord,prepareHumanAuthorityCommand,planHumanAuthorityCommand,HUMAN_AUTHORITY_POLICY} from '../lib/strict-human-authority.mjs';
import {parseHumanCommand,deriveHumanCode,humanCommandIdentity} from '../lib/strict-human-command.mjs';
import {planAuthorityTransaction,parseAuthorityRecord} from '../lib/strict-authority.mjs';
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64),at='2026-11-13T12:00:00.000Z';
const state=()=>({protocolVersion:2,projectId:'p',sessionId:'s',reviewRoundId:'r1',phase:'skeleton',revision:0,reviewVersion:A,captureVersion:B,approvedVersion:null,approvedCaptureVersion:null});
const enrollment=(caps={})=>({state:state(),policy:{policyVersion:HUMAN_AUTHORITY_POLICY,roundMismatchCap:3,sessionMismatchCap:5,commandCap:30,authorityCap:20,...caps},epoch:{epochId:'e1',reviewRoundId:'r1',keyHex:'00'.repeat(32)}});
const fresh=caps=>{const r=createHumanAuthorityRecord(enrollment(caps));assert.ok(r);assert.ok(parseHumanAuthorityRecord(r));return r;};
const cmd=(op,id,extras={})=>parseHumanCommand(op,{requestId:id,...extras});
function verify(r,id,action='approve',code){const ep=r.epochs.at(-1);return cmd('verifyAndCommit',id,{action,code:code??deriveHumanCode(r.authority.state,action,Buffer.from(ep.keyHex,'hex'))});}
const no=()=>({at,evidence:{kind:'no-core'}});
function coreEffect(r,c,facts={},nextEpoch){const s=r.authority.state,action=c.operation==='recapture'?'recapture':c.action,selected=action!=='reshape';return {at,evidence:{kind:nextEpoch?'reshape':'core',intent:{protocolVersion:2,requestId:c.requestId,action,projectId:s.projectId,sessionId:s.sessionId,reviewRoundId:s.reviewRoundId,reviewVersion:selected?s.reviewVersion:s.approvedVersion,captureVersion:selected?s.captureVersion:s.approvedCaptureVersion,expectedRevision:s.revision},facts:{contentVersion:s.reviewVersion,captureVersion:s.captureVersion,nextReviewRoundId:null,completionVerified:false,...facts},...(nextEpoch?{nextEpoch}:{})}};}
const run=(r,c,e)=>{const prep=prepareHumanAuthorityCommand(r,c);assert.deepEqual(prep,e.evidence.kind==='no-core'?{kind:'needs-no-core'}:{kind:'needs-core',intent:e.evidence.intent});const p=planHumanAuthorityCommand(r,c,e);assert.equal(p.persist,true,JSON.stringify(p.result));assert.ok(parseHumanAuthorityRecord(p.record));return p;};
const copy=v=>JSON.parse(JSON.stringify(v));
const wrong=(r,id,action='approve')=>{const good=verify(r,id,action);return {...good,code:good.code==='0000-0000'?'1111-1111':'0000-0000'};};

test('fresh explicit V2 enrollment, deeply frozen canonical copy and bounded own data',()=>{
 const r=fresh();assert.ok(Object.isFrozen(r.current));assert.ok(Object.isFrozen(r.initial.epoch));
 for(const mutate of [e=>{delete e.policy.commandCap;},e=>e.policy.commandCap=1025,e=>e.policy.authorityCap=0,e=>e.policy.policyVersion='default',e=>e.state.revision=1,e=>e.state.phase='fill',e=>e.epoch.reviewRoundId='other',e=>e.epoch.keyHex='AA'.repeat(32),e=>e.state.revision=-0]){const e=enrollment();mutate(e);assert.equal(createHumanAuthorityRecord(e),null);}
 let reads=0;const e=enrollment();Object.defineProperty(e,'epoch',{enumerable:true,get(){reads++;throw Error();}});assert.equal(createHumanAuthorityRecord(e),null);assert.equal(reads,0);
 assert.equal(createHumanAuthorityRecord(new Proxy(enrollment(),{})),null);
 const exotic=enrollment();exotic.epoch=new Proxy(exotic.epoch,{get(){throw Error();}});assert.equal(createHumanAuthorityRecord(exotic),null);
});

test('wrong-code identity, canonical aliases, invalid syntax and same-ID reuse do not recount',()=>{
 let r=fresh();const c=wrong(r,'bad'),p=run(r,c,no());r=p.record;
 assert.equal(p.result.kind,'mismatch');assert.equal(p.result.attemptsLeft,2);assert.equal(r.current.sessionMismatchCount,1);assert.equal(r.authority.journal.length,0);
 const alias=parseHumanCommand(c.operation,{requestId:c.requestId,action:c.action,code:c.code.toLowerCase().replace('-',' ')});
 const retry=planHumanAuthorityCommand(copy(r),alias,new Proxy({},{get(){throw Error();}}));assert.equal(retry.replayed,true);assert.deepEqual(retry.result,p.result);assert.deepEqual(retry.record,r);
 for(const changed of [verify(r,'bad'),{...c,action:'reshape'},cmd('endSession','bad'),cmd('recapture','bad')]){const q=planHumanAuthorityCommand(r,changed,no());assert.equal(q.result.code,'request-reused');assert.equal(q.persist,false);assert.deepEqual(q.record,r);}
 for(const malformed of [{...c,extra:true},{...c,code:'Ａ000-0000'},{...c,code:'a'.repeat(5000)},new Proxy(c,{}),Object.defineProperty({...c},'code',{get(){throw Error();}})]){const q=planHumanAuthorityCommand(r,malformed,no());assert.equal(q.persist,false);assert.deepEqual(q.record,r);}
});

test('approve exact pair, reshape approved old pair, new epoch only successful reshape, historical lookup survives end',()=>{
 let r=fresh();const approval=verify(r,'approve');const first=run(r,approval,coreEffect(r,approval));r=first.record;
 assert.equal(r.authority.state.phase,'fill');assert.equal(first.result.at,at);assert.equal('protocolVersion'in first.result,false);
 const mismatch=run(r,wrong(r,'bad-reshape','reshape'),no());r=mismatch.record;
 const reshape=verify(r,'reshape','reshape'),ep={epochId:'e2',reviewRoundId:'r2',keyHex:'11'.repeat(32)};
 const effect=coreEffect(r,reshape,{contentVersion:C,captureVersion:D,nextReviewRoundId:'r2'},ep);
 const selectedInstead=copy(effect);selectedInstead.evidence.intent.reviewVersion=C;assert.equal(planHumanAuthorityCommand(r,reshape,selectedInstead).persist,false);
 const p=run(r,reshape,effect);r=p.record;assert.equal(p.result.reviewVersion,A);assert.equal(p.result.captureVersion,B);assert.equal(r.authority.state.reviewVersion,C);assert.equal(r.authority.state.captureVersion,D);assert.equal(r.current.roundMismatchCount,0);assert.equal(r.current.sessionMismatchCount,1);assert.equal(r.current.epochId,'e2');
 r=run(r,cmd('endSession','end'),no()).record;
 assert.equal(r.current.admissions,'revoked');assert.equal(r.authority.state.phase,'skeleton');
 const replay=planHumanAuthorityCommand(copy(r),approval,null);assert.equal(replay.replayed,true);assert.deepEqual(replay.result,first.result);
 const denied=run(r,verify(r,'after-end'),no());assert.equal(denied.result.code,'session-ended');assert.equal(denied.record.authority.journal.length,2);
 const end=run(r,cmd('endSession','end-again'),no());assert.deepEqual(end.result,{kind:'admissions-revoked',requestId:'end-again',at});assert.equal(end.record.authority.journal.length,2);
});

test('recapture changed and unchanged retain round/key/counts; lock recovery is new-session',()=>{
 let r=fresh({roundMismatchCap:1});r=run(r,wrong(r,'bad'),no()).record;
 const locked=run(r,verify(r,'locked'),no());assert.deepEqual(locked.result,{kind:'locked',requestId:'locked',unlock:'new-session'});r=locked.record;
 for(const [id,facts,changed] of [['same',{},false],['changed',{contentVersion:C,captureVersion:D},true]]){const c=cmd('recapture',id),p=run(r,c,coreEffect(r,c,facts));assert.equal(p.result.changed,changed);assert.equal('action'in p.result,false);r=p.record;assert.equal(r.current.epochId,'e1');assert.equal(r.current.roundMismatchCount,1);assert.equal(r.current.sessionMismatchCount,1);assert.equal(r.authority.state.reviewRoundId,'r1');assert.equal(r.epochs.length,1);}
 assert.equal(run(r,verify(r,'still-locked'),no()).result.kind,'locked');
 let fill=fresh();const a=verify(fill,'a');fill=run(fill,a,coreEffect(fill,a)).record;const c=cmd('recapture','fill-recapture');const refused=run(fill,c,no());assert.deepEqual(refused.result,{kind:'refused',requestId:'fill-recapture',reason:'fill-phase'});assert.equal(refused.record.authority.journal.length,1);
});

test('command and core capacities belong to effects, including historical exact retries',()=>{
 let r=fresh({authorityCap:1,commandCap:6});const c=cmd('recapture','capture');r=run(r,c,coreEffect(r,c)).record;
 const mismatch=run(r,wrong(r,'wrong'),no());assert.equal(mismatch.result.kind,'mismatch');r=mismatch.record;
 const matched=verify(r,'matched'),full=run(r,matched,no());assert.equal(full.result.kind,'journal-full');assert.equal(full.record.current.sessionMismatchCount,1);assert.equal(full.record.authority.journal.length,1);r=full.record;
 r=run(r,cmd('endSession','end'),no()).record;r=run(r,cmd('endSession','end2'),no()).record;r=run(r,cmd('endSession','end3'),no()).record;
 const q=planHumanAuthorityCommand(r,cmd('endSession','overflow'),null);assert.equal(q.result.kind,'journal-full');assert.equal(q.persist,false);assert.equal(q.record.commands.length,6);
 assert.equal(planHumanAuthorityCommand(copy(r),matched,null).replayed,true);assert.equal(planHumanAuthorityCommand(copy(r),c,null).replayed,true);
 assert.equal(planHumanAuthorityCommand(r,{...matched,code:'1111-1111'},null).result.code,'request-reused');
});

test('core terminal rejections are owned, no entropy on rejected reshape and facts are bounded',()=>{
 let r=fresh(),a=verify(r,'a');const stale=run(r,a,coreEffect(r,a,{captureVersion:C}));assert.equal(stale.result.code,'stale-review');assert.equal(stale.record.authority.journal.length,1);assert.equal(stale.record.current.sessionMismatchCount,0);r=stale.record;
 a=verify(r,'a2');r=run(r,a,coreEffect(r,a)).record;
 const reshape=verify(r,'rs','reshape');const invalid=run(r,reshape,coreEffect(r,reshape));assert.equal(invalid.result.code,'invalid-transition');assert.equal(invalid.record.epochs.length,1);
 for(const mutate of [e=>e.evidence.facts.completionVerified=true,e=>e.evidence.facts.extra=true,e=>e.evidence.intent.expectedRevision++,e=>e.evidence.nextEpoch={epochId:'x',reviewRoundId:'x',keyHex:C},e=>e.at='2026-02-30T00:00:00.000Z']){const e=coreEffect(r,reshape);mutate(e);const p=planHumanAuthorityCommand(r,reshape,e);assert.equal(p.persist,false);assert.equal(p.record.commands.length,r.commands.length);}
});

test('full replay rejects coherent core orphan history, missing ownership, historical code/result/counter/epoch tamper',()=>{
 let r=fresh();r=run(r,wrong(r,'bad'),no()).record;const a=verify(r,'a');r=run(r,a,coreEffect(r,a)).record;
 const rs=verify(r,'rs','reshape');r=run(r,rs,coreEffect(r,rs,{contentVersion:C,captureVersion:D,nextReviewRoundId:'r2'},{epochId:'e2',reviewRoundId:'r2',keyHex:'22'.repeat(32)})).record;
 assert.ok(parseHumanAuthorityRecord(copy(r)));
 const mutations=[v=>v.current.sessionMismatchCount=0,v=>v.commands[0].result.attemptsLeft++,v=>v.commands[0].command.code='1111-1111',v=>v.commands[1].result.at='2026-11-13T13:00:00.000Z',v=>v.commands[1].evidence.intent.captureVersion=C,v=>v.commands[1].observed.revision++,v=>v.commands[1].identityHex='ff',v=>v.commands.splice(1,1),v=>v.commands.push(copy(v.commands[0])),v=>v.epochs.push({...v.epochs[0],epochId:'orphan'}),v=>v.epochs[0].keyHex='33'.repeat(32),v=>v.commands[2].evidence.nextEpoch.keyHex='00'.repeat(32),v=>v.extra=true,v=>v.commands.foo=true,v=>v.commands[0].evidence.extra=true];
 for(const mutate of mutations){const v=copy(r);mutate(v);assert.equal(parseHumanAuthorityRecord(v),null,mutate.toString());}
 const orphan=copy(r),c=cmd('recapture','orphan');orphan.authority=planAuthorityTransaction(r.authority,coreEffect(r,c).evidence.intent,coreEffect(r,c).evidence.facts).record;assert.ok(orphan.authority.journal.length>r.authority.journal.length);assert.equal(parseHumanAuthorityRecord(orphan),null);
 for(const hostile of [new Proxy(r,{}),Object.defineProperty(copy(r),'authority',{enumerable:true,get(){throw Error();}})])assert.equal(parseHumanAuthorityRecord(hostile),null);
});

test('newline suffixes and invalid real UTC instants cannot enter private records',()=>{
 for(const mutate of [e=>e.state.projectId+='\n',e=>e.state.reviewVersion+='\n',e=>e.epoch.keyHex+='\n',e=>e.epoch.epochId+='\n']){const e=enrollment();mutate(e);assert.equal(createHumanAuthorityRecord(e),null);}
 const r=fresh(),c=verify(r,'a');assert.equal(run(r,c,coreEffect(r,c)).result.kind,'committed');
 for(const invalid of ['2026-11-13T12:00:00.000Z\n','2025-02-29T00:00:00.000Z','0000-01-01T00:00:00.000Z','2026-01-01T24:00:00.000Z','2026-01-01T00:00:60.000Z']){const e=coreEffect(r,c);e.at=invalid;assert.equal(planHumanAuthorityCommand(r,c,e).persist,false);}
 for(const field of ['contentVersion','captureVersion']){const e=coreEffect(r,c);e.evidence.facts[field]+='\n';assert.equal(planHumanAuthorityCommand(r,c,e).persist,false);}
});

test('approve and rejected reshape preserve counts; successful new-round reshape cannot reset session cap',()=>{
 let r=fresh({roundMismatchCap:5,sessionMismatchCap:2});r=run(r,wrong(r,'bad-approve'),no()).record;
 const a=verify(r,'approve');r=run(r,a,coreEffect(r,a)).record;assert.equal(r.current.roundMismatchCount,1);assert.equal(r.current.sessionMismatchCount,1);assert.equal(r.current.epochId,'e1');
 const rejected=verify(r,'rejected-reshape','reshape');const p=run(r,rejected,coreEffect(r,rejected));assert.equal(p.result.code,'invalid-transition');r=p.record;assert.equal(r.current.roundMismatchCount,1);assert.equal(r.current.sessionMismatchCount,1);assert.equal(r.current.epochId,'e1');
 const rs=verify(r,'reshape','reshape');r=run(r,rs,coreEffect(r,rs,{contentVersion:C,captureVersion:D,nextReviewRoundId:'r2'},{epochId:'e2',reviewRoundId:'r2',keyHex:'44'.repeat(32)})).record;assert.equal(r.current.roundMismatchCount,0);assert.equal(r.current.sessionMismatchCount,1);
 const mismatch=run(r,wrong(r,'bad-new-round'),no());assert.equal(mismatch.result.attemptsLeft,0);r=mismatch.record;
 assert.deepEqual(run(r,verify(r,'session-locked'),no()).result,{kind:'locked',requestId:'session-locked',unlock:'new-session'});
});

test('oversized own-key objects refuse before copying properties or invoking accessors',()=>{
 const r=fresh(),c=verify(r,'a');assert.equal(run(r,c,coreEffect(r,c)).result.kind,'committed');
 let reads=0;const oversized={};for(let i=0;i<64;i++)Object.defineProperty(oversized,'extra'+i,{enumerable:true,get(){reads++;throw Error('never');}});
 assert.equal(createHumanAuthorityRecord(oversized),null);assert.equal(parseHumanAuthorityRecord(oversized),null);
 const planned=planHumanAuthorityCommand(r,c,oversized);assert.equal(planned.persist,false);assert.deepEqual(planned.record,r);assert.equal(reads,0);
});

// Build a public fixture directly: 1024 unchanged recaptures, each at revision
// zero. The complete fixture is checked by the existing V2 parser on replay;
// constructing it must not itself pay 1024 repeated prefix validations.
function maximumRecaptureFixture(){
 const r=copy(fresh({commandCap:1024,authorityCap:1024}));
 for(let i=0;i<1024;i++){
  const c=cmd('recapture','capture-'+i),effect=coreEffect(r,c);
  const core={kind:'recaptured',requestId:c.requestId,action:'recapture',protocolVersion:2,reviewVersion:A,captureVersion:B,revision:0,changed:false};
  r.authority.journal.push({intent:effect.evidence.intent,facts:effect.evidence.facts,result:core,stateAfter:copy(r.authority.state)});
  const {protocolVersion,action,...result}=core;
  r.commands.push({command:c,identityHex:humanCommandIdentity(c.operation,{requestId:c.requestId}).toString('hex'),observed:{epochId:'e1',revision:0,reviewRoundId:'r1',reviewVersion:A,captureVersion:B},evidence:effect.evidence,result,at});
 }
 return r;
}
test('maximum explicit 1024-entry core history replays, retries, and rejects ownership/tamper',()=>{
 const r=maximumRecaptureFixture();assert.ok(parseAuthorityRecord(r.authority));
 const canonical=parseHumanAuthorityRecord(r);assert.ok(canonical);assert.equal(canonical.commands.length,1024);assert.equal(canonical.authority.journal.length,1024);
 for(const index of [0,511,1023]){const p=planHumanAuthorityCommand(r,r.commands[index].command,null);assert.equal(p.replayed,true);assert.equal(p.persist,false);assert.deepEqual(p.result,r.commands[index].result);}
 assert.equal(planHumanAuthorityCommand(r,cmd('endSession','overflow'),null).result.kind,'journal-full');
 for(const mutate of [
  v=>{[v.authority.journal[511],v.authority.journal[512]]=[v.authority.journal[512],v.authority.journal[511]];},
  v=>v.commands[511].evidence.facts.captureVersion=C,
  v=>v.authority.journal[511].stateAfter.revision=1,
  v=>v.authority.journal[511].result.changed=true,
  v=>v.commands[511].result.changed=true,
  v=>v.commands.splice(511,1),
 ]){const v=copy(r);mutate(v);assert.equal(parseHumanAuthorityRecord(v),null,mutate.toString());}
});

test('evidence variants cannot bypass wrong-code, lock, admission or action gates',()=>{
 let r=fresh({roundMismatchCap:1});const w=wrong(r,'bad');assert.equal(planHumanAuthorityCommand(r,w,coreEffect(r,w)).persist,false);r=run(r,w,no()).record;
 const locked=verify(r,'locked');assert.equal(planHumanAuthorityCommand(r,locked,coreEffect(r,locked)).persist,false);
 const recapture=cmd('recapture','invalid-core');const rejected=run(r,recapture,coreEffect(r,recapture,{nextReviewRoundId:'forbidden'}));assert.equal(rejected.result.code,'invalid-transition');assert.equal(rejected.record.authority.journal.length,1);assert.equal(rejected.record.current.roundMismatchCount,1);
 r=run(r,cmd('endSession','end'),no()).record;const ended=cmd('recapture','after-end');assert.equal(planHumanAuthorityCommand(r,ended,coreEffect(r,ended)).persist,false);
 r=fresh();const approve=verify(r,'approve');const e=coreEffect(r,approve,{}, {epochId:'e2',reviewRoundId:'r1',keyHex:'11'.repeat(32)});assert.equal(planHumanAuthorityCommand(r,approve,e).persist,false);
});


test('preparation ready results agree with final planner without effects or secret exposure',()=>{
 let r=fresh({commandCap:2}),c=wrong(r,'bad');r=run(r,c,no()).record;r=run(r,cmd('endSession','end'),no()).record;
 let effects=0;const hostile=new Proxy({},{get(){effects++;throw Error('effect');}});
 const cases=[[null,c],[r,null],[r,{...c,extra:true}],[r,c],[r,verify(r,'bad')],[r,cmd('endSession','end')],[r,cmd('endSession','full')]];
 for(const [record,command] of cases){
  const prep=prepareHumanAuthorityCommand(record,command),final=planHumanAuthorityCommand(record,command,hostile);
  assert.deepEqual(prep,{kind:'ready-result',result:final.result,persist:final.persist,replayed:final.replayed});
  assert.ok(Object.isFrozen(prep));assert.ok(Object.isFrozen(prep.result));
  assert.equal(/keyHex|identityHex|evidence|"code":"[0-9A-Z]{4}-/.test(JSON.stringify(prep)),false);
 }
 assert.equal(effects,0);
});

test('preparation exposes only exact intent or no-core and never touches host dependencies',()=>{
 const r=fresh(),c=verify(r,'approve');let reads=0;
 const host={get clock(){reads++;throw Error('clock');},get observe(){reads++;throw Error('observer');},get randomBytes(){reads++;throw Error('entropy');}};
 assert.deepEqual(prepareHumanAuthorityCommand(r,c,host),{kind:'needs-core',intent:coreEffect(r,c).evidence.intent});
 assert.deepEqual(prepareHumanAuthorityCommand(r,wrong(r,'bad'),host),{kind:'needs-no-core'});
 assert.equal(reads,0);
 const getter=Object.defineProperty({...c},'code',{enumerable:true,get(){reads++;throw Error('code');}});
 assert.equal(prepareHumanAuthorityCommand(r,getter).result.code,'invalid-transition');assert.equal(reads,0);
});
