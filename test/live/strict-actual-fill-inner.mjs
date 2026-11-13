// Real pinned CLI, fixed local API only. All children remain inside fixture PID namespace.
import fs from 'node:fs';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
const caseName=process.argv[2];
if(!['valid','exterior'].includes(caseName)) throw Error('invalid fixed case');
const writer=String.raw`import os,pathlib,json,time
pid=os.fork()
if pid:
 os.waitpid(pid,0)
 print('DETACHED_WRITER_STARTED',flush=True)
 os._exit(0)
os.setsid()
if os.fork(): os._exit(0)
for fd in (0,1,2):
 try: os.close(fd)
 except OSError: pass
os.closerange(3,1024)
fd=os.open('/work/plan.js',os.O_RDWR)
raw=os.pread(fd,8192,0)
offset=raw.index(b'filled!')
log=os.open('/control/writer-log',os.O_CREAT|os.O_WRONLY|os.O_APPEND,0o600)
pathlib.Path('/control/writer-ready').write_text(json.dumps({'pid':os.getpid(),'namespace':os.readlink('/proc/self/ns/pid')}))
end=time.monotonic()+90
while time.monotonic()<end:
 os.pwrite(fd,b'filled!',offset)
 os.write(log,b'x')
 time.sleep(.01)
`;
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const steps=[{name:'Read',input:{file_path:'/work/plan.js'}},{name:'Edit',input:{file_path:'/work/plan.js',old_string:'initial',new_string:'filled!'}}];
if(caseName==='exterior') steps.push({name:'Edit',input:{file_path:'/work/plan.js',old_string:'// fixture exterior',new_string:'// changed exterior'}});
steps.push({name:'Bash',input:{command:'/usr/bin/python3 -I -c '+quote(writer),description:'Start fixed detached synchronous fixture writer'}});
const MAX=1024*1024;
let malformed=0,requestCount=0,countRequests=0,results=[];
const textOf=c=>typeof c==='string'?c:Array.isArray(c)?c.map(b=>b?.text??'').join(''):'';
function reply(res,body,blocks,stop) {
 const message={id:'msg_actual_fill',type:'message',role:'assistant',model:'mock',content:blocks,stop_reason:stop,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}};
 if(!body.stream) {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(message));return;}
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
 const send=(event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify({type:event,...data})}\n\n`);
 send('message_start',{message:{...message,content:[],stop_reason:null}});
 blocks.forEach((b,index)=>{
  if(b.type==='text') {send('content_block_start',{index,content_block:{type:'text',text:''}});send('content_block_delta',{index,delta:{type:'text_delta',text:b.text}});}
  else {send('content_block_start',{index,content_block:{type:'tool_use',id:b.id,name:b.name,input:{}}});send('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}});}
  send('content_block_stop',{index});
 });
 send('message_delta',{delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:1}});send('message_stop',{});res.end();
}
const server=http.createServer((req,res)=>{
 let raw='';
 req.on('data',c=>{raw+=c;if(Buffer.byteLength(raw)>MAX){malformed++;req.destroy();}});
 req.on('end',()=>{
  try {
   const body=JSON.parse(raw);
   if(req.url?.includes('count_tokens')) {if(++countRequests>8)throw Error();res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":1}');return;}
   if(!req.url?.startsWith('/v1/messages') || ++requestCount>steps.length+1) throw Error();
   const tools=body.tools?.map(t=>t.name).sort();
   if(JSON.stringify(tools)!==JSON.stringify(['Bash','Edit','Read'])) throw Error();
   const incoming=body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(i=>i.type==='tool_result');
   if(incoming.length!==requestCount-1 || incoming.some((r,i)=>r.tool_use_id!==`toolu_fill_${i+1}` || r.is_error===true)) throw Error();
   results=incoming.map(r=>({id:r.tool_use_id,isError:r.is_error===true,text:textOf(r.content).slice(0,4096)}));
   const step=steps[incoming.length];
   reply(res,body,step?[{type:'tool_use',id:`toolu_fill_${incoming.length+1}`,...step}]:[{type:'text',text:'Fixed actual-client fill complete.'}],step?'tool_use':'end_turn');
  } catch {malformed++;res.writeHead(400);res.end('{}');}
 });
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const env={HOME:'/home/agent',USER:'agent',SHELL:'/bin/bash',PATH:'/usr/bin:/bin',LANG:'C.UTF-8',CLAUDE_CONFIG_DIR:'/home/agent/.claude',ANTHROPIC_API_KEY:'sk-ant-local-dummy-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_AUTOUPDATER:'1',DISABLE_ERROR_REPORTING:'1'};
const version=spawnSync('/opt/claude',['--version'],{env,cwd:'/work',timeout:10000,maxBuffer:4096,encoding:'utf8'});
const child=spawn('/opt/claude',['-p','Run the deterministic fixture tool sequence.','--output-format','stream-json','--verbose','--max-turns','8','--model','claude-sonnet-4-5','--tools','Read,Edit,Bash','--allowedTools','Read,Edit,Bash','--permission-mode','bypassPermissions','--no-session-persistence','--strict-mcp-config','--disable-slash-commands'],{cwd:'/work',env,stdio:['ignore','pipe','pipe']});
let bytes=0,overflow=false,diagnostic='';
for(const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{bytes+=chunk.length;if(diagnostic.length<4096)diagnostic+=chunk.toString().slice(0,4096-diagnostic.length);if(bytes>MAX){overflow=true;child.kill('SIGKILL');}});
const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
let exit=null;
try {exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}
finally {clearTimeout(timer);server.closeAllConnections();await new Promise(r=>server.close(r));}
const checks={clientExitZero:exit===0,exactToolSequence:results.length===steps.length && results.every((r,i)=>r.id===`toolu_fill_${i+1}`&&!r.isError),readSawApprovedSentinel:results[0]?.text.includes('initial')===true,bashStartedDetachedWriter:results.at(-1)?.text.includes('DETACHED_WRITER_STARTED')===true,exactRequestCount:requestCount===steps.length+1,noMalformedRequests:malformed===0,noOutputOverflow:!overflow,pinnedVersionRead:version.status===0};
const result={ok:Object.values(checks).every(v=>v===true),strictState:'unverified',case:caseName,clientExit:exit,clientVersion:version.stdout?.trim().slice(0,256),toolIds:results.map(r=>r.id),apiRequestCount:requestCount,checks};
if(!result.ok)result.diagnostic=diagnostic.replaceAll('sk-ant-local-dummy-only','[dummy redacted]');
fs.writeFileSync('/control/client-complete.json',JSON.stringify(result));
process.stdout.write(JSON.stringify(result)+'\n');
if(!result.ok)process.exitCode=1;
