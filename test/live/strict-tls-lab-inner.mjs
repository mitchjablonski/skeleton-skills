// Runs only inside the Python harness's verified isolated network namespace.
import fs from 'node:fs';
import https from 'node:https';
import assert from 'node:assert/strict';
import {createMockModelBroker} from '../../lib/strict-model-broker.mjs';
import {createTlsLabTransport} from '../../lib/strict-model-tls-lab.mjs';
const certRoot=process.argv[2];
const hostNetworkNamespace=process.argv[3];
if(certRoot!=='/fixtures')throw Error('LAB_FIXTURES');
const read=name=>fs.readFileSync(`${certRoot}/${name}`,'utf8');
const rows=[];
for(const name of ['valid','wrong-name','untrusted','expired','peer-mismatch','redirect','handshake-timeout','timeout']) {
  const cert=name==='wrong-name'?'wrong':name==='expired'?'expired':'server';
  let requests=0,sni=[],credentialObserved=false;
  const sockets=new Set();
  const server=https.createServer({key:read(`${cert}.key`),cert:read(`${cert}.crt`),ALPNProtocols:['http/1.1'],
    ...(name==='handshake-timeout'?{SNICallback(){/* Deliberately never finish the fixture handshake. */}}:{})},(req,res)=>{
    requests++;credentialObserved=req.headers['x-api-key']==='strict-mock-upstream-dummy-only';req.resume();
    if(name==='timeout')return;
    const body='{"lab":true}';
    res.writeHead(name==='redirect'?302:200,{'content-type':'application/json','content-length':Buffer.byteLength(body),...(name==='redirect'?{location:'https://127.0.0.1/private'}:{})});res.end(body);
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.on('secureConnection',socket=>sni.push(socket.servername));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(443,'8.8.8.8',resolve);});
  const transport=createTlsLabTransport({ca:read(name==='untrusted'?'other-ca.crt':'ca.crt'),answers:name==='peer-mismatch'?['8.8.4.4']:undefined,hostNetworkNamespace});
  // Host-selected fault: connect to the real fixture peer rather than the
  // resolver's different approved address. Broker must compare actual peer.
  if(name==='peer-mismatch'){
    const connect=transport.connect.bind(transport);
    transport.connect=options=>connect({...options,address:'8.8.8.8'});
  }
  const broker=createMockModelBroker({transport,sessionBudget:{requestTimeoutMs:250,connectTimeoutMs:200}});
  let code=null,result;
  try{result=await broker.submit({method:'POST',target:'/v1/messages',body:'{}'});}catch(error){code=error.code;}
  finally{await broker.close();for(const socket of sockets)socket.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  const expected={valid:null,'wrong-name':'BROKER_TLS',untrusted:'BROKER_TLS',expired:'BROKER_TLS','peer-mismatch':'BROKER_PEER',redirect:'MODEL_REDIRECT_REFUSED','handshake-timeout':'BROKER_TIMEOUT',timeout:'BROKER_TIMEOUT'}[name];
  assert.equal(code,expected,name);
  assert.equal(transport.evidence.connects,1,name);
  const sent=['valid','redirect','timeout'].includes(name);
  assert.equal(requests,sent?1:0,name);assert.equal(transport.evidence.requests,sent?1:0,name);
  if(sent){assert.equal(credentialObserved,true);assert.deepEqual(sni,['api.anthropic.com']);}
  if(name==='valid'){assert.equal(result.body.toString(),'{"lab":true}');assert.deepEqual(transport.evidence.peers,['8.8.8.8']);}
  if(name.endsWith('timeout'))assert.ok(transport.evidence.aborts>0);
  rows.push({case:name,code,requests,connections:transport.evidence.connects,strictState:'unverified'});
}
console.log(JSON.stringify({ok:true,strictState:'unverified',scope:'isolated TLS lab; fixed host-owned DNS answers',rows}));
