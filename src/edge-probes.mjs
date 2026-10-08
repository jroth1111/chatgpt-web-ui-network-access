import {waitBounded,cancelBestEffort} from './cleanup.mjs';
import {parseDnsTcpResponse} from './dns-response.mjs';
// Edge capability expansion: raw TCP (cloudflare:sockets), outbound WebSockets,
// runtime capability probe. Mechanical bounds only — theSites dispatch guard
// remains the authority; these tools extend egress below the HTTP layer.
// DNS over TCP uses a fixed non-Cloudflare public resolver (8.8.8.8:53).
// Cloudflare Workers restrict outbound TCP to Cloudflare address ranges.
// raw-protocol demonstration; arbitrary host:port TCP is exposed.
// cloudflare:sockets in workerd; node:net adapter when executed under plain
// Node (tests). Adapter exposes {writable, readable, close} like workerd sockets.
let cachedConnect,connectSource;
const nodeConnectAdapter=async()=>{
 if(cachedConnect)return cachedConnect;
 let net;
 try{net=await import('node:net');}catch{return null;}
 cachedConnect=(address,options)=>{
  const socket=new net.Socket();
  const readable=new ReadableStream({start(c){socket.on('data',d=>c.enqueue(new Uint8Array(d)));socket.on('end',()=>{try{c.close()}catch{}});socket.on('error',e=>{try{c.error(e)}catch{}});},cancel(){socket.destroy();}});
  const writable=new WritableStream({start(c){socket.on('error',e=>{try{c.error(e)}catch{}});},write(chunk){return new Promise((res,rej)=>{socket.write(Buffer.from(chunk),err=>err?rej(err):res());});},close(){return new Promise(res=>{socket.end(res);});},abort(){socket.destroy();}});
  socket.connect({host:address.hostname,port:address.port},()=>{});
  return {writable,readable,close:async()=>{try{socket.end();}catch{}socket.destroy();}};
 };
 connectSource='node:net adapter (test runtime)';
 return cachedConnect;
};
const resolveConnect=async()=>{
 if(connectSource)return cachedConnect;
 try{const m=await import('cloudflare:sockets');connectSource='cloudflare:sockets';cachedConnect=m.connect;return cachedConnect;}
 catch(e){return nodeConnectAdapter();}
};
export const EDGE_LIMITS=Object.freeze({tcp_timeout_ms:15000,tcp_read_max:262144,tcp_write_max:65536,ws_timeout_ms:15000,ws_message_max:262144,probe_cache_ms:60000});
let cachedProbe=null,probeAt=0;
export async function edgeProbe(){
 if(cachedProbe&&Date.now()-probeAt<EDGE_LIMITS.probe_cache_ms)return cachedProbe;
 const connect=await resolveConnect();
 const probe={
  raw_tcp:!!connect,
  raw_tcp_basis:connect?('connect() available: '+connectSource):'cloudflare:sockets import failed and no adapter',
  outbound_websocket:typeof WebSocket==='function'||typeof WebSocketPair!=='undefined',
  caches_api:typeof caches!=='undefined'&&!!caches?.default,
  crypto_subtle:!!crypto?.subtle,
  limits:EDGE_LIMITS,
  measured_at:new Date().toISOString(),
 };
 cachedProbe=probe;probeAt=Date.now();
 return probe;
}
const sha256Hex=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
function withTimeout(signal,ms,label){
 if(signal?.aborted)throw Error('cancelled_before_start');
 const c=new AbortController();
 const t=setTimeout(()=>c.abort('deadline:'+label),Math.min(ms,EDGE_LIMITS.tcp_timeout_ms));
 const abort=()=>c.abort(signal.reason||'caller');signal?.addEventListener('abort',abort,{once:true});
 return {signal:c.signal,cleanup:()=>{clearTimeout(t);signal?.removeEventListener('abort',abort);},controller:c};
}
// ---- raw TCP tool ----
// args: {host, port, payload_base64|payload_text, read_timeout_ms, secure (starttls|on|off), close_after_write}
export async function edgeTcp(args,{signal,connectImpl,onReceived}={}){
 const connect=connectImpl??await resolveConnect();
 if(!connect)throw Error('RAW_TCP_UNAVAILABLE: cloudflare:sockets not importable in this runtime');
 const host=args.host,port=args.port;
 if(typeof host!=='string'||!/^[a-z0-9.\-]+$/i.test(host)||host.length>253)throw Error('host_syntax');
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('port_range');
 if(args.secure!==undefined&&!['on','off','starttls'].includes(args.secure))throw Error('secure_mode');
 const mode=args.secure==='on'?'secureTransport:on':args.secure==='off'?'secureTransport:off':'secureTransport:starttls';
 const timeout=Math.min(Math.max(1,Number(args.read_timeout_ms)||EDGE_LIMITS.tcp_timeout_ms),EDGE_LIMITS.tcp_timeout_ms);
 let payload;
 if(args.payload_base64!==undefined){
  if(typeof args.payload_base64!=='string')throw Error('payload_type');
  payload=Uint8Array.from(atob(args.payload_base64),x=>x.charCodeAt(0));
 }else if(args.payload_text!==undefined){
  if(typeof args.payload_text!=='string')throw Error('payload_type');
  payload=new TextEncoder().encode(args.payload_text);
 }else payload=new Uint8Array(0);
 if(payload.length>EDGE_LIMITS.tcp_write_max)throw Error('payload_byte_limit:'+EDGE_LIMITS.tcp_write_max);
 const started=Date.now();
 const t=withTimeout(signal,timeout,'tcp');
 let socket;const deadline=started+timeout;const wait=fn=>waitBounded(fn,{signal:t.signal,deadline,error:()=>Error('TCP_DEADLINE: operation budget exhausted')});
 let writer,reader,closedByPeer=false;const chunks=[];let receivedLen=0;
 try{
  socket=connect({hostname:host,port},{secureTransport:mode.split(':')[1],allowHalfOpen:true});
  writer=socket.writable.getWriter();
  reader=socket.readable.getReader();
  if(payload.length)await wait(()=>writer.write(payload));
  // close_after_write default false: half-close races servers that echo after
  // processing the full request (FIN can truncate their reply). Deadline bounds
  // the read instead.
  if(args.close_after_write===true)await wait(()=>writer.close());

  let pending;
  for(;;){
   pending??=reader.read();
   let timer;
   const pause=new Promise(res=>{if(receivedLen)timer=setTimeout(()=>res(null),Math.min(400,Math.max(1,deadline-Date.now())));});
   let x;
   try{x=await wait(()=>Promise.race([pending,pause]));}finally{clearTimeout(timer);}
   if(x===null)break;
   pending=null;
   if(x.done){closedByPeer=true;break;}
   if(x.value?.length){
    // chunk accumulator: O(n) total copy (single join at end) instead of the
    // O(n²) re-copy per chunk (ST-7: 1-byte trickle cost ~34GB memcpy)
    const count=Math.min(x.value.length,EDGE_LIMITS.tcp_read_max-receivedLen);
    if(count>0){chunks.push(x.value.subarray(0,count));receivedLen+=count;}
   }
   if(receivedLen>=EDGE_LIMITS.tcp_read_max)break;
  }
 }finally{
  t.cleanup();
  cancelBestEffort(reader);
  try{Promise.resolve(writer?.abort?.()).catch(()=>{});}catch{}
  try{writer?.releaseLock?.();}catch{}
  try{Promise.resolve(socket?.close?.()).catch(()=>{});}catch{}
 }
 const received=new Uint8Array(receivedLen);let _ro=0;for(const c of chunks){received.set(c,_ro);_ro+=c.length;}
 if(onReceived)onReceived(received);
 const hash=await sha256Hex(received);
 const textual=receivedLen&&(()=>{try{const s=new TextDecoder('utf-8',{fatal:true}).decode(received);return {textual:true,text:s.length>16384?s.slice(0,16384)+'…[truncated]':s};}catch{return {textual:false};}})();
 return {ok:true,host,port,secure:mode,bytes_written:payload.length,bytes_received:receivedLen,closed_by_peer:closedByPeer,body_sha256:hash,duration_ms:Date.now()-started,...(textual||{})};
}
// ---- DNS over TCP helper (proves raw TCP with a deterministic protocol) ----
export function buildDnsQuery(name,id=0x1234){
 if(typeof name!=='string'||name.length>253)throw Error('DNS_QUERY: bad name');
 const labels=name.replace(/\.$/,'').split('.');
 if(labels.some(l=>!/^[a-z0-9\-]{1,63}$/i.test(l))||labels.length<1||labels.length>10)throw Error('DNS_QUERY: bad label');
 const q=[id>>8,id&255,0x01,0x00,0,1,0,0,0,0,0,0];
 for(const l of labels)q.push(l.length,...new TextEncoder().encode(l));
 q.push(0,0,1,0,1); // A, IN
 return new Uint8Array(q);
}
export async function edgeDnsTcp(name,{signal,connectImpl}={}){
 const id=crypto.getRandomValues(new Uint16Array(1))[0],q=buildDnsQuery(name,id);
 const prefixed=new Uint8Array(q.length+2);prefixed[0]=q.length>>8;prefixed[1]=q.length&255;prefixed.set(q,2);
 let received;
 const r=await edgeTcp({host:'8.8.8.8',port:53,payload_base64:btoa(String.fromCharCode(...prefixed)),read_timeout_ms:8000,secure:'off',close_after_write:false},{signal,connectImpl,onReceived:bytes=>{received=bytes;}});
 const base={...r,protocol:'DNS-over-TCP',resolver:'8.8.8.8:53',source:'validated length-framed DNS A response; no HTTP/DoH fallback'};
 try{return {...base,status:'PASS',...parseDnsTcpResponse(received,{name,id})};}
 catch(error){return {...base,ok:false,status:'FAIL',dns_response_validated:false,error:{code:error.code||'dns_response_invalid',message:'No valid matching DNS response was received.'}};}
}
// ---- WebSocket tool ----
// args: {url, send_text|send_base64, subprotocol, timeout_ms, expect_messages(=1)}
export async function edgeWebSocket(args,{signal,WebSocketImpl}={}){
 if(typeof args.url!=='string'||!/^(wss?|https?):\/\//i.test(args.url))throw Error('ws_url_scheme');
 const url=new URL(args.url);url.protocol=url.protocol.replace(/^http/i,'ws');
 const timeout=args.timeout_ms??EDGE_LIMITS.ws_timeout_ms,started=Date.now(),deadline=started+timeout;
 const t=withTimeout(signal,timeout,'ws');let ws;const messages=[];let bytes=0;let dispose=()=>{};
 const wait=(fn,onLate)=>waitBounded(fn,{signal:t.signal,deadline,error:()=>Error('WS_DEADLINE: operation budget exhausted'),onLate});
 try{
  ws=await wait(async()=>{
   if(WebSocketImpl)return new WebSocketImpl(url.href,args.subprotocol?[args.subprotocol]:[]);
   const target=new URL(url);target.protocol=target.protocol==='wss:'?'https:':'http:';
   const res=await fetch(target.href,{headers:{upgrade:'websocket',...(args.subprotocol?{'sec-websocket-protocol':args.subprotocol}:{})},signal:t.signal});
   if(!res.webSocket)throw Error('WS_UPGRADE_REFUSED: status '+res.status);
   res.webSocket.accept();return res.webSocket;
  },late=>{try{late.close();}catch{}});
  let resolveNext,rejectNext,queue=[],failure;
  const onMessage=e=>{if(resolveNext){const r=resolveNext;resolveNext=null;rejectNext=null;r(e.data);}else if(queue.length<4)queue.push(e.data);else{failure=Error('ws_message_count_limit');try{ws.close();}catch{}}};
  const onError=()=>{failure=Error('ws_error_event');rejectNext?.(failure);};
  const onClose=()=>{failure=Error('ws_closed');rejectNext?.(failure);};
  ws.addEventListener('message',onMessage);ws.addEventListener('error',onError);ws.addEventListener('close',onClose);
  dispose=()=>{ws.removeEventListener('message',onMessage);ws.removeEventListener('error',onError);ws.removeEventListener('close',onClose);};
  if(ws.readyState===0){let cleanup;try{await wait(()=>new Promise((res,rej)=>{const open=()=>res(),error=()=>rej(Error('ws_open_error'));ws.addEventListener('open',open,{once:true});ws.addEventListener('error',error,{once:true});cleanup=()=>{ws.removeEventListener('open',open);ws.removeEventListener('error',error);};}));}finally{cleanup?.();}}
  const send=args.send_base64!==undefined?Uint8Array.from(atob(args.send_base64),x=>x.charCodeAt(0)):args.send_text;
  if(send!==undefined){if((typeof send==='string'?new TextEncoder().encode(send).length:send.length)>EDGE_LIMITS.ws_message_max)throw Error('ws_message_limit');ws.send(send);}
  for(let i=0;i<(args.expect_messages??1);i++){
   const msg=await wait(()=>{if(queue.length)return queue.shift();if(failure)throw failure;return new Promise((res,rej)=>{resolveNext=res;rejectNext=rej;});});
   const size=typeof msg==='string'?new TextEncoder().encode(msg).length:msg.byteLength??msg.size??0;
   if(size>EDGE_LIMITS.ws_message_max)throw Error('ws_message_limit');bytes+=size;
   messages.push(typeof msg==='string'?msg.slice(0,2048):'[binary '+size+'b]');
  }
  return {ok:true,url:url.href,subprotocol:args.subprotocol||null,messages,bytes_received:bytes,message_preview_chars:2048,duration_ms:Date.now()-started};
 }finally{dispose();try{ws?.close(1000,'done');}catch{}t.cleanup();}
}
