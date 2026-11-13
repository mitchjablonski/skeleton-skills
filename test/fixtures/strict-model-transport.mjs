// Deterministic in-memory DNS/TLS/HTTP simulator. Never opens a socket.
export function createStrictModelTransport(options={}) {
  const evidence={resolutions:[],connections:[],requests:[],aborts:0,closes:0};
  const settings={...options};
  const wait=signal=>new Promise((_,reject)=>{
    if(signal.aborted)return reject(new Error('aborted'));
    signal.addEventListener('abort',()=>{evidence.aborts++;reject(new Error('aborted'));},{once:true});
  });
  const transport={
    async resolve(host,{signal}) {
      evidence.resolutions.push(host);
      if(settings.hang==='resolve')return wait(signal);
      return [...(settings.addresses??['8.8.8.8'])];
    },
    async connect(input) {
      const {signal,...safe}=input;evidence.connections.push({...safe});
      if(settings.hang==='connect')return wait(signal);
      return {
        peerAddress:settings.peerAddress??input.address,
        tls:{authorized:true,hostname:'api.anthropic.com',servername:input.servername,alpn:'http/1.1',...settings.tls},
        async request(request) {
          // Evidence is trusted test-only and intentionally carries dummy headers
          // for assertions. Broker diagnostics/snapshots do not expose it.
          evidence.requests.push({method:request.method,target:request.target,headers:{...request.headers},body:Buffer.from(request.body)});
          if(settings.hang==='request')return wait(request.signal);
          return {status:settings.status??200,rawHeaders:settings.rawHeaders??['content-type',settings.sse?'text/event-stream':'application/json'],
            body:{async *[Symbol.asyncIterator](){
              if(settings.hang==='stream'){await wait(request.signal);return;}
              for(const chunk of settings.chunks??[Buffer.from(settings.sse?'event: message_stop\ndata: {}\n\n':'{"ok":true}')])yield chunk;
            }}};
        },
        close(){evidence.closes++;},
      };
    },
  };
  return {transport,evidence};
}
