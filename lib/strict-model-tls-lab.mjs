// LAB ONLY: actual TLS against an isolated fixture address. No production
// adapter, DNS proof, system trust changes or real credentials.
import tls from 'node:tls';
import http from 'node:http';
import fs from 'node:fs';
const HOST='api.anthropic.com',ADDRESS='8.8.8.8';
function isolatedLab(hostNetworkNamespace) {
  if(process.platform!=='linux' || !/^net:\[\d+\]$/.test(hostNetworkNamespace??'')
    || fs.readlinkSync('/proc/self/ns/net')===hostNetworkNamespace)throw Error('LAB_NAMESPACE');
  const interfaces=fs.readFileSync('/proc/net/dev','utf8').split('\n').filter(line=>line.includes(':')).map(line=>line.split(':')[0].trim());
  if(interfaces.length!==1 || interfaces[0]!=='lo')throw Error('LAB_INTERFACES');
  const ipv4=fs.readFileSync('/proc/net/route','utf8').trim().split('\n').slice(1);
  if(ipv4.some(line=>{const columns=line.trim().split(/\s+/);return columns[0]!=='lo' || columns[1]==='00000000';}))throw Error('LAB_ROUTES');
  const ipv6=fs.readFileSync('/proc/net/ipv6_route','utf8').trim();
  if(ipv6 && ipv6.split('\n').some(line=>{
    const columns=line.trim().split(/\s+/),flags=Number.parseInt(columns[8],16);
    // Linux lists its unreachable ::/0 sentinel in procfs even with no
    // netlink default route. Only a non-UP reject entry on lo is harmless.
    const defaultRoute=columns[0]==='0'.repeat(32) && columns[1]==='00';
    return columns.length!==10 || columns[9]!=='lo' || !Number.isSafeInteger(flags)
      || (defaultRoute && (!(flags&0x200) || (flags&1)));
  }))throw Error('LAB_ROUTES');
}
export function createTlsLabTransport({ca,answers=[ADDRESS],hostNetworkNamespace}={}) {
  isolatedLab(hostNetworkNamespace);
  if(typeof ca!=='string' || !ca.includes('BEGIN CERTIFICATE'))throw Error('LAB_CA');
  const pinnedAnswers=Object.freeze([...answers]);
  const evidence={connects:0,requests:0,aborts:0,peers:[],sni:[]};
  return {evidence,
    async resolve(host,{signal}){if(host!==HOST || signal.aborted)throw Error('LAB_HOST');return [...pinnedAnswers];},
    async connect({address,port,servername,rejectUnauthorized,alpn,signal}) {
      isolatedLab(hostNetworkNamespace);
      if(address!==ADDRESS || port!==443 || servername!==HOST || rejectUnauthorized!==true || alpn!=='http/1.1')throw Error('LAB_DESTINATION');
      evidence.connects++;
      const socket=tls.connect({host:address,port,servername,ca,rejectUnauthorized:true,ALPNProtocols:['http/1.1'],checkServerIdentity:tls.checkServerIdentity});
      const abort=()=>{evidence.aborts++;socket.destroy();};
      signal.addEventListener('abort',abort,{once:true});
      try {
        await new Promise((resolve,reject)=>{
          const fail=()=>reject(Object.assign(new Error('BROKER_TLS'),{code:'BROKER_TLS'}));
          socket.once('secureConnect',resolve);socket.once('error',fail);socket.once('close',fail);
          if(signal.aborted){abort();fail();}
        });
      } catch(error){signal.removeEventListener('abort',abort);socket.destroy();throw error;}
      evidence.peers.push(socket.remoteAddress);evidence.sni.push(servername);
      const agent=new http.Agent({keepAlive:false});agent.createConnection=()=>socket;
      let used=false;
      return {peerAddress:socket.remoteAddress,tls:{authorized:socket.authorized,hostname:HOST,servername,alpn:socket.alpnProtocol},
        request({method,target,headers,body,signal:requestSignal}){
          if(used)throw Error('LAB_REUSE');used=true;evidence.requests++;
          return new Promise((resolve,reject)=>{
            const req=http.request({host:address,port,method,path:target,headers,agent,signal:requestSignal},res=>resolve({status:res.statusCode,rawHeaders:res.rawHeaders,body:res}));
            req.on('error',reject);req.end(body);
          });
        },
        close(){signal.removeEventListener('abort',abort);socket.destroy();agent.destroy();},
      };
    },
  };
}
