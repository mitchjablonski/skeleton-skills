// Namespace-local HTTP shim and actual CLI. No provider credential or broker implementation.
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
const socket=new net.Socket({fd:Number(process.argv[2]),readable:true,writable:true});
let input=Buffer.alloc(0),serial=0,waiting=null;
const MAX=2*1024*1024;
socket.on('data',chunk=>{input=Buffer.concat([input,chunk]);if(input.length>MAX+4)throw Error('reply limit');while(input.length>=4){const n=input.readUInt32BE();if(n>MAX)throw Error('reply length');if(input.length<n+4)return;const r=JSON.parse(input.subarray(4,n+4));input=input.subarray(n+4);if(!waiting||r.id!==waiting.id)throw Error('correlation');const w=waiting;waiting=null;clearTimeout(w.timer);w.resolve(r);}});
socket.on('error',()=>{waiting?.reject(Error('relay closed'));});
socket.on('close',()=>{waiting?.reject(Error('relay closed'));});
function rpc(method,target,rawHeaders,body){if(waiting)throw Error('one in flight');const id=++serial;const frame=Buffer.from(JSON.stringify({version:1,id,request:{method,target,rawHeaders,bodyBase64:body.toString('base64')}}));if(frame.length>MAX)throw Error('frame limit');const head=Buffer.alloc(4);head.writeUInt32BE(frame.length);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.destroy();reject(Error('relay deadline'));},12000);waiting={id,resolve,reject,timer};socket.write(Buffer.concat([head,frame]));});}
const negatives=[];
for(const [target,body,code] of [['https://evil.example/v1/messages',Buffer.from('{}'),'MODEL_TARGET'],['/v1/messages',Buffer.from(JSON.stringify({x:'x'.repeat(1048576)})),'MODEL_BODY_LIMIT']]){const r=await rpc('POST',target,[],body);if(r.ok!==false||r.code!==code)throw Error('negative not refused');negatives.push(code);}
let requests=0,refused=0,refusalCodes=[];
const server=http.createServer((req,res)=>{
 const chunks=[];let size=0;
 req.on('data',chunk=>{size+=chunk.length;if(size>1048576){req.destroy();return;}chunks.push(chunk);});
 req.on('end',async()=>{
  try {
   if(Object.keys(req.trailers).length||Object.keys(req.headers).some(k=>['transfer-encoding','upgrade','trailer','expect'].includes(k))){refused++;res.writeHead(400);res.end('{}');return;}
   const r=await rpc(req.method,req.url,req.rawHeaders,Buffer.concat(chunks));requests++;
   if(!r.ok){refused++;refusalCodes.push(r.code);res.writeHead(400);res.end(JSON.stringify({error:r.code}));return;}
   res.writeHead(r.status,r.headers);res.end(Buffer.from(r.bodyBase64,'base64'));
  }catch{refused++;res.writeHead(502);res.end('{}');}
 });
});
await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
const env={HOME:'/home/agent',USER:'agent',SHELL:'/bin/bash',PATH:'/usr/bin:/bin',LANG:'C.UTF-8',CLAUDE_CONFIG_DIR:'/home/agent/.claude',ANTHROPIC_API_KEY:'worker-dummy-not-upstream',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_AUTOUPDATER:'1',DISABLE_ERROR_REPORTING:'1'};
const version=spawnSync('/opt/claude',['--version'],{env,cwd:'/work',timeout:10000,maxBuffer:4096,encoding:'utf8'});
const child=spawn('/opt/claude',['-p','Run the fixed local tool sequence.','--output-format','stream-json','--verbose','--max-turns','8','--model','claude-sonnet-4-5','--tools','Read,Edit,Bash','--allowedTools','Read,Edit,Bash','--permission-mode','bypassPermissions','--no-session-persistence','--strict-mcp-config','--disable-slash-commands'],{cwd:'/work',env,stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
const relayIdentity=fs.readlinkSync('/proc/self/fd/'+process.argv[2]);
const relayAbsent=fs.readdirSync('/proc/'+child.pid+'/fd').every(name=>{try{return fs.readlinkSync('/proc/'+child.pid+'/fd/'+name)!==relayIdentity;}catch(error){if(error.code==='ENOENT')return true;throw error;}});
let bytes=0,overflow=false;
for(const s of [child.stdout,child.stderr])s.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576){overflow=true;child.kill('SIGKILL');}});
const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
const exit=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});clearTimeout(timer);
server.closeAllConnections();await new Promise(r=>server.close(r));socket.unref();
const checks={clientExitZero:exit===0,versionRead:version.status===0,policyNegatives:negatives.join(',')==='MODEL_TARGET,MODEL_BODY_LIMIT',noHttpRefusals:refused===0,requestsCrossed:requests>=4&&requests<=6,noOutputOverflow:!overflow,relayDescriptorAbsentFromCli:relayAbsent};
const result={ok:Object.values(checks).every(x=>x===true),strictState:'unverified',clientVersion:version.stdout?.trim(),clientExit:exit,requests,negatives,checks};
if(!result.ok)result.refusalCodes=refusalCodes;
fs.writeFileSync('/control/client-complete.json',JSON.stringify(result));process.stdout.write(JSON.stringify(result)+'\n');if(!result.ok)process.exitCode=1;
