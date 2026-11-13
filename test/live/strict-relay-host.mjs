// Outside-host deterministic mock broker. Inherited socketpair only; no listener/network.
import fs from 'node:fs';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {createMockModelBroker} from '../../lib/strict-model-broker.mjs';
const fd=Number(process.argv[2]),sentinel=process.argv[3];
if(!Number.isInteger(fd)||fd<3||!sentinel?.startsWith('/'))throw Error('host invocation');
const MAX=2*1024*1024;
const writer=String.raw`import os,pathlib,json,time
if os.fork():
 os.wait();print('RELAY_PRIVATE_MISSING_WRITER_STARTED',flush=True);os._exit(0)
os.setsid()
if os.fork():os._exit(0)
for x in range(1024):
 try:os.close(x)
 except OSError:pass
fd=os.open('/work/plan.js',os.O_RDWR)
offset=os.pread(fd,8192,0).index(b'filled!')
log=os.open('/control/writer-log',os.O_CREAT|os.O_WRONLY|os.O_APPEND,0o600)
pathlib.Path('/control/writer-ready').write_text(json.dumps({'pid':os.getpid(),'namespace':os.readlink('/proc/self/ns/pid')}))
end=time.monotonic()+90
while time.monotonic()<end:
 os.pwrite(fd,b'filled!',offset);os.write(log,b'x');time.sleep(.01)
`;
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const steps=[{name:'Read',input:{file_path:'/work/plan.js'}},{name:'Edit',input:{file_path:'/work/plan.js',old_string:'initial',new_string:'filled!'}},{name:'Bash',input:{command:'if test -e '+quote(sentinel)+'; then echo RELAY_PRIVATE_VISIBLE; exit 1; fi; /usr/bin/python3 -I -c '+quote(writer),description:'Check missing private fixture and start detached writer'}}];
const evidence={resolve:0,connect:0,send:0,closes:0,credentialAdded:true,requests:[],refusals:[],frameLimit:false,partialTimeout:false,closed:false,toolResultsVerified:false};
let resultCount=0;
const transport={
 async resolve(host){evidence.resolve++;if(host!=='api.anthropic.com')throw Error('host');return ['8.8.8.8'];},
 async connect(o){evidence.connect++;if(o.address!=='8.8.8.8'||o.port!==443||o.servername!=='api.anthropic.com'||o.rejectUnauthorized!==true||o.alpn!=='http/1.1')throw Error('pin');return {peerAddress:o.address,tls:{authorized:true,hostname:'api.anthropic.com',servername:o.servername,alpn:o.alpn},
 async request(r){
  evidence.send++;evidence.credentialAdded&&=r.headers['x-api-key']==='strict-mock-upstream-dummy-only';
  evidence.requests.push({target:r.target,credentialAdded:evidence.credentialAdded});
  await delay(300); // Fixed provider latency keeps the existing rolling rate profile intact.
  const body=JSON.parse(r.body.toString());let response;
  if(r.target.startsWith('/v1/messages/count_tokens'))response={input_tokens:1};
  else {
   const offered=body.tools?.map(t=>t.name).sort();if(JSON.stringify(offered)!=='["Bash","Edit","Read"]')throw Error('tools');
   const results=body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(x=>x.type==='tool_result');
   if(results.length!==resultCount || results.some((x,i)=>x.tool_use_id!==`toolu_relay_${i+1}`||x.is_error===true))throw Error('results');
   if(results.length===3){const text=r=>typeof r.content==='string'?r.content:JSON.stringify(r.content);evidence.toolResultsVerified=text(results[0]).includes('initial')&&text(results[2]).includes('RELAY_PRIVATE_MISSING_WRITER_STARTED');if(!evidence.toolResultsVerified)throw Error('tool acceptance');}
   if(results.length)resultCount=results.length;
   const step=steps[results.length];
   if(step)resultCount=results.length+1;
   response={id:'msg_relay',type:'message',role:'assistant',model:'mock',content:step?[{type:'tool_use',id:`toolu_relay_${results.length+1}`,...step}]:[{type:'text',text:'Fixed relay complete.'}],stop_reason:step?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}};
   // Prior result count expected on next model request equals the step just issued.
  }
  let bytes=Buffer.from(JSON.stringify(response)),type='application/json';
  if(body.stream && !r.target.startsWith('/v1/messages/count_tokens')) {
   type='text/event-stream';let output='';const send=(event,data)=>{output+=`event: ${event}\ndata: ${JSON.stringify({type:event,...data})}\n\n`;};
   send('message_start',{message:{...response,content:[],stop_reason:null}});
   response.content.forEach((b,index)=>{if(b.type==='text'){send('content_block_start',{index,content_block:{type:'text',text:''}});send('content_block_delta',{index,delta:{type:'text_delta',text:b.text}});}else{send('content_block_start',{index,content_block:{type:'tool_use',id:b.id,name:b.name,input:{}}});send('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}});}send('content_block_stop',{index});});
   send('message_delta',{delta:{stop_reason:response.stop_reason,stop_sequence:null},usage:{output_tokens:1}});send('message_stop',{});bytes=Buffer.from(output);
  }
  return {status:200,rawHeaders:['content-type',type],body:{async *[Symbol.asyncIterator](){yield bytes;}}};
 },close(){evidence.closes++;}};}
};
const broker=createMockModelBroker({transport,sessionBudget:{maxResponseBytes:65536,maxSessionResponseBytes:1048576}});
const socket=new net.Socket({fd,readable:true,writable:true});
let pending=Buffer.alloc(0),last=0,busy=false,done=false,frames=0,partialTimer=null;
socket.setTimeout(5000,()=>socket.destroy());
function reply(value){const data=Buffer.from(JSON.stringify(value));if(socket.writableLength+data.length+4>131072){void broker.close();socket.destroy();return;}const header=Buffer.alloc(4);header.writeUInt32BE(data.length);socket.write(Buffer.concat([header,data]));}
const keys=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===n.slice().sort().join(',');
async function frame(raw){
 let id=null,owns=false;
 try {
   let f;try{f=JSON.parse(raw);}catch{throw Object.assign(Error(),{code:'RELAY_FRAME'});}
  if(!keys(f,['version','id','request']))throw Object.assign(Error(),{code:'RELAY_FRAME'});
  id=f.id;
  if(f.version!==1||!Number.isSafeInteger(id)||id!==last+1||id>32)throw Object.assign(Error(),{code:'RELAY_FRAME'});
  last=id;
  if(!keys(f.request,['method','target','rawHeaders','bodyBase64'])||typeof f.request.bodyBase64!=='string')throw Object.assign(Error(),{code:'RELAY_FRAME'});
  if(busy)throw Object.assign(Error(),{code:'BROKER_CONCURRENCY'});
  const bytes=Buffer.from(f.request.bodyBase64,'base64');
  if(bytes.toString('base64')!==f.request.bodyBase64)throw Object.assign(Error(),{code:'RELAY_FRAME'});
  busy=true;owns=true;
  const r=await broker.submit({method:f.request.method,target:f.request.target,rawHeaders:f.request.rawHeaders,body:bytes});
  reply({version:1,id,ok:true,status:r.status,headers:r.headers,bodyBase64:r.body.toString('base64')});
 }catch(error){const code=['RELAY_FRAME','BROKER_CONCURRENCY','BROKER_CLOSED','MODEL_TARGET','MODEL_BODY_LIMIT','BROKER_HEADERS','BROKER_FRAMING','BROKER_RATE','BROKER_REQUESTS','BROKER_SESSION_BYTES'].includes(error.code)?error.code:'RELAY_REFUSED';evidence.refusals.push(code);reply({version:1,id,ok:false,code});if(code==='RELAY_FRAME'){await broker.close();socket.end();}}
 finally{if(owns)busy=false;}
}
socket.on('data',chunk=>{
 if(pending.length+chunk.length>MAX+4){evidence.frameLimit=true;socket.destroy();return;}
 pending=Buffer.concat([pending,chunk]);
 if(!partialTimer)partialTimer=setTimeout(()=>{evidence.partialTimeout=true;void broker.close();reply({version:1,id:null,ok:false,code:'RELAY_PARTIAL_TIMEOUT'});socket.end();},2000);
 while(pending.length>=4){const size=pending.readUInt32BE();if(size>MAX){evidence.frameLimit=true;void broker.close();reply({version:1,id:null,ok:false,code:'RELAY_FRAME_BYTES'});socket.end();return;}if(pending.length<size+4)return;if(++frames>32){void broker.close();socket.destroy();return;}const raw=pending.subarray(4,4+size);pending=pending.subarray(4+size);void frame(raw);}if(!pending.length){clearTimeout(partialTimer);partialTimer=null;}
});
process.stdin.setEncoding('utf8');process.stdin.on('data',async text=>{if(text==='STOP\n'){await broker.close();evidence.closed=true;process.stdout.write(JSON.stringify({event:'closed'})+'\n');}});
async function finish(){if(done)return;done=true;clearTimeout(partialTimer);await broker.close();evidence.closed=true;process.stdout.write(JSON.stringify({event:'summary',strictState:'unverified',...evidence,snapshot:broker.snapshot()})+'\n');process.stdin.destroy();}
socket.on('error',()=>{});socket.on('close',finish);socket.on('end',()=>socket.end());
