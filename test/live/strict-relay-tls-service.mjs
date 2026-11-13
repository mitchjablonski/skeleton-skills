// Trusted sibling service namespace only: real TLS server and relay broker.
import fs from 'node:fs';
import https from 'node:https';
import {createFixedProvider,serveRelay} from './strict-relay-host.mjs';
import {createTlsLabTransport} from '../../lib/strict-model-tls-lab.mjs';
const [rawFd,hostNetworkNamespace,scenario,sentinel]=process.argv.slice(2);
if(!['valid','untrusted','peer-mismatch','redirect'].includes(scenario)||!sentinel?.startsWith('/'))throw Error('LAB_INVOCATION');
const read=name=>fs.readFileSync('/fixtures/'+name,'utf8');
const provider=createFixedProvider(sentinel),sockets=new Set(),sni=[];
let httpRequests=0,keyObserved=true;
const server=https.createServer({key:read('server.key'),cert:read('server.crt'),ALPNProtocols:['http/1.1']},async(req,res)=>{
 httpRequests++;keyObserved&&=req.headers['x-api-key']==='strict-mock-upstream-dummy-only';
 let size=0;const chunks=[];
 try {
  for await(const chunk of req){size+=chunk.length;if(size>1048576)throw Error('BODY_LIMIT');chunks.push(chunk);}
  if(scenario==='redirect'){res.writeHead(302,{'content-type':'application/json',location:'https://127.0.0.1/private'});res.end('{}');return;}
  const response=await provider.respond({target:req.url,headers:req.headers,body:Buffer.concat(chunks)});
  const outgoing=[];let total=0;
  for await(const chunk of response.body){total+=chunk.length;if(total>65536)throw Error('RESPONSE_LIMIT');outgoing.push(chunk);}
  res.writeHead(response.status,{...Object.fromEntries(Array.from({length:response.rawHeaders.length/2},(_,i)=>response.rawHeaders.slice(i*2,i*2+2))),'content-length':total});
  res.end(Buffer.concat(outgoing,total));
 }catch{res.destroy();}
});
server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
server.on('secureConnection',socket=>sni.push(socket.servername));
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(443,'8.8.8.8',resolve);});
const tls=createTlsLabTransport({ca:read(scenario==='untrusted'?'other-ca.crt':'ca.crt'),answers:scenario==='peer-mismatch'?['8.8.4.4']:undefined,hostNetworkNamespace});
let resolves=0;
const transport={resolve(...args){resolves++;return tls.resolve(...args);},connect(options){return tls.connect(scenario==='peer-mismatch'?{...options,address:'8.8.8.8'}:options);}};
async function cancelSockets(){
 for(const socket of sockets)socket.destroy();
 const end=Date.now()+1000;
 while(sockets.size && Date.now()<end)await new Promise(r=>setTimeout(r,5));
 if(sockets.size)throw Error('LAB_SOCKET_CLEANUP');
}
process.stdout.write(JSON.stringify({event:'ready',scenario,networkNamespace:fs.readlinkSync('/proc/self/ns/net'),pidNamespace:fs.readlinkSync('/proc/self/ns/pid')})+'\n');
await serveRelay({fd:Number(rawFd),transport,evidence:provider.evidence,onStop:cancelSockets,onFinish:async()=>{
 await cancelSockets();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 return {scenario,serviceNetworkNamespace:fs.readlinkSync('/proc/self/ns/net'),tls:{connects:tls.evidence.connects,requests:tls.evidence.requests,peers:tls.evidence.peers,sni,httpRequests,keyObserved:httpRequests>0&&keyObserved,resolves,liveSockets:sockets.size}};
}});
