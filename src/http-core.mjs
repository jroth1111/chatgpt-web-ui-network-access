import {cancelBestEffort,waitBounded} from './cleanup.mjs';
// Destination-independent mechanics; authorization, destinations and transport are injected.
export class HttpError extends Error{constructor(code,status=400,details){super(code);this.code=code;this.status=status;this.details=details}}
const fail=(c,s=400,d)=>{throw new HttpError(c,s,d)};
export const DEFAULT_METHODS=Object.freeze(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
export const DEFAULT_LIMITS=Object.freeze({request:8388608,response:33554432,aggregate:67108864,chunk:65536,timeout:60000,concurrency:8,url:8192,headerValue:8192,headerTotal:16384,headerCount:64});
export function reviewedLimits(input={}){const b={...DEFAULT_LIMITS,...input};if(Object.keys(b).some(k=>!Object.hasOwn(DEFAULT_LIMITS,k)||!Number.isInteger(b[k])||b[k]<1||b[k]>DEFAULT_LIMITS[k]))throw Error('invalid_gateway_bounds');return Object.freeze(b)}
export const encodeBody=b=>{const chunks=[];for(let i=0;i<b.length;i+=32768)chunks.push(String.fromCharCode(...b.subarray(i,i+32768)));return btoa(chunks.join(''))};
export function decodeBody(s,max=65536){if(typeof s!=='string'||s.length>4*Math.ceil(max/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))fail('body_base64_invalid');const b=Uint8Array.from(atob(s),x=>x.charCodeAt(0));if(b.length>max)fail('request_body_limit',413);if(encodeBody(b)!==s)fail('body_base64_noncanonical');return b}
export const bodyHash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');
const bannedHeader=k=>['authorization','proxy-authorization','cookie','host','content-length','connection','transfer-encoding','upgrade','te','trailer','expect','forwarded'].includes(k)||k.startsWith('x-forwarded-')||k.startsWith('x-network-access-')||k.startsWith('oai-')||k.startsWith('sec-');
export function normalizeHttpRequest(input,limits={},methods=DEFAULT_METHODS){const b=reviewedLimits(typeof limits==='number'?{request:limits}:limits);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['url','method','headers','body','body_base64'].includes(k))||!Object.hasOwn(input,'url')||!Object.hasOwn(input,'method')||!Object.hasOwn(input,'headers')||Object.hasOwn(input,'body')===Object.hasOwn(input,'body_base64'))fail('request_shape');
 if(typeof input.url!=='string'||input.url.length>b.url||/[\x00-\x20\x7f\\]/.test(input.url))fail('url_syntax');let url;try{url=new URL(input.url)}catch{fail('url_syntax')}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail('url_protocol_or_userinfo');url.hash='';
 if(!methods.includes(input.method))fail(input.method==='TRACE'?'trace_disabled':'method_unsupported');
 if(!input.headers||typeof input.headers!=='object'||Array.isArray(input.headers)||Object.keys(input.headers).length>b.headerCount)fail('header_shape');
 const headers={};let n=0;for(const [key,value] of Object.entries(input.headers)){const k=key.toLowerCase();if(!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(k)||bannedHeader(k)||Object.hasOwn(headers,k)||typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value)||new TextEncoder().encode(value).length>b.headerValue)fail('header_policy');n+=k.length+new TextEncoder().encode(value).length;if(n>b.headerTotal)fail('header_limit');headers[k]=value}
 const body=Object.hasOwn(input,'body_base64')?decodeBody(input.body_base64,b.request):input.body;if(!(body instanceof Uint8Array)&&!(body instanceof ReadableStream))fail('body_type');if(body instanceof Uint8Array&&body.length>b.request)fail('request_body_limit',413);return {url:url.href,method:input.method,headers,body};
}
function withAbort(p,signal){const work=Promise.resolve(p);work.then(r=>{if(signal.aborted)cancelBestEffort(r?.body);},()=>{});return waitBounded(()=>work,{signal,error:()=>new HttpError(signal.reason==='deadline'?'request_timeout':'request_cancelled',signal.reason==='deadline'?504:499),onLate:r=>cancelBestEffort(r?.body)});}
async function collect(body,max,signal){if(body===null)return new Uint8Array();if(body instanceof Uint8Array){if(body.length>max)fail('body_limit',413);return body}if(!(body instanceof ReadableStream))fail('transport_body_type',502);const reader=body.getReader(),chunks=[];let n=0;try{while(true){const r=await withAbort(reader.read(),signal);if(r.done)break;if(!(r.value instanceof Uint8Array))fail('stream_chunk_type',502);n+=r.value.length;if(n>max)fail('body_limit',413);chunks.push(r.value)}const b=new Uint8Array(n);let o=0;for(const c of chunks){b.set(c,o);o+=c.length}return b}finally{cancelBestEffort(reader);}}
export function createHttpGateway({policy,transport,authorize=async()=>false,limits={},methods=DEFAULT_METHODS}){
 if(typeof policy!=='function'||typeof transport!=='function'||typeof authorize!=='function')throw Error('injected_policy_transport_authorization_required');const bound=reviewedLimits(limits),methodSet=Object.freeze([...methods]);if(!methodSet.length||new Set(methodSet).size!==methodSet.length||methodSet.some(m=>!DEFAULT_METHODS.includes(m)))throw Error('invalid_method_configuration');let active=0;
 async function request(input,{signal,stream=false}={}){
  const p=normalizeHttpRequest(input,bound,methodSet);if(signal?.aborted)fail('request_cancelled',499);let decision;
  const controller=new AbortController();let admitted=false,closed=false,timer,responseBody;const readers=new Set(),streams=new Set();let traffic=0;
  const stop=()=>controller.abort('caller');signal?.addEventListener('abort',stop,{once:true});
  const release=()=>{if(closed)return;closed=true;if(admitted)active--;clearTimeout(timer);signal?.removeEventListener('abort',stop);controller.abort('complete');for(const r of readers){cancelBestEffort(r);}};timer=setTimeout(()=>controller.abort('deadline'),bound.timeout);
  if(signal?.aborted)stop();
  try{
   if(active>=bound.concurrency)fail('concurrency_limit',429);
   active++;admitted=true;
   decision=await withAbort(policy(p,{signal:controller.signal}),controller.signal);
   if(!decision?.allowed)fail(decision?.reason||'destination_not_authorized',403,decision?.blockers);
   if(!await withAbort(authorize(decision,p,{signal:controller.signal}),controller.signal))fail('scope_not_authorized',403,decision.scope);
   if(!Array.isArray(decision.methods)||!decision.methods.includes(p.method))fail('method_policy',403);
   if(!Array.isArray(decision.headers)||Object.keys(p.headers).some(k=>!decision.headers.includes(k)))fail('header_policy');
  }catch(e){cancelBestEffort(p.body);release();throw e}
  const take=n=>{traffic+=n;if(traffic>bound.aggregate)fail('aggregate_byte_limit',413)};
  function boundedStream(source,max,onDone=()=>{}){if(source===null)source=new Uint8Array();let reader,offset=0,total=0,pending=null,pendingOffset=0,delivery,ended=false;if(source instanceof ReadableStream){reader=source.getReader();readers.add(reader)}else if(!(source instanceof Uint8Array))fail('transport_body_type',502);
   const cleanup=()=>{if(ended)return;ended=true;controller.signal.removeEventListener('abort',abort);streams.delete(output);if(reader){readers.delete(reader);cancelBestEffort(reader);}};
   const abort=()=>{try{delivery.error(new HttpError(controller.signal.reason==='deadline'?'request_timeout':'request_cancelled',controller.signal.reason==='deadline'?504:499))}catch{}cleanup();onDone()};
   const output=new ReadableStream({start(c){delivery=c},async pull(c){try{
    if(ended)return;if(!pending){if(reader){const r=await withAbort(reader.read(),controller.signal);if(r.done){cleanup();c.close();onDone();return}if(!(r.value instanceof Uint8Array))fail('stream_chunk_type',502);if(total+r.value.length>max)fail('body_limit',413);pending=r.value;pendingOffset=0}else{if(offset>=source.length){cleanup();c.close();onDone();return}pending=source.subarray(offset,Math.min(offset+bound.chunk,source.length));offset+=pending.length;pendingOffset=0}}
    const end=Math.min(pendingOffset+bound.chunk,pending.length),chunk=pending.subarray(pendingOffset,end);total+=chunk.length;if(total>max)fail('body_limit',413);take(chunk.length);c.enqueue(chunk);pendingOffset=end;if(pendingOffset===pending.length)pending=null;
   }catch(e){try{c.error(e)}catch{}cleanup();controller.abort('stream_error');onDone()}},cancel(){cleanup();controller.abort('consumer_cancel');onDone()}},{highWaterMark:0});streams.add(output);controller.signal.addEventListener('abort',abort,{once:true});return output;
  }
  try{
   const requestMax=Math.min(bound.request,decision.request_bytes??bound.request),responseMax=Math.min(bound.response,decision.response_bytes??bound.response);
   let body;
   if(stream&&decision.streaming){if(['GET','HEAD'].includes(p.method)){const bytes=await collect(p.body,0,controller.signal);body=bytes}else body=boundedStream(p.body,requestMax)}else{body=await collect(p.body,requestMax,controller.signal);take(body.length);if(['GET','HEAD'].includes(p.method)&&body.length)fail('body_method_policy')}
   const r=await withAbort(transport({...p,body,signal:controller.signal},decision),controller.signal);responseBody=r?.body;if(!r||!Number.isInteger(r.status)||r.status<200||r.status>599)fail('transport_status_invalid',502);
   const headers={};let hb=0;for(const [k,v] of new Headers(r.headers||{})){if(['content-type','etag','last-modified','cache-control','content-range','accept-ranges','allow'].includes(k)){hb+=k.length+v.length;if(hb>bound.headerTotal||v.length>bound.headerValue||/[\r\n\x00]/.test(v))fail('response_header_limit',502);headers[k]=v}}
   const metadata={...(r.metadata||{}),content_type:headers['content-type']||'application/octet-stream',transport_attempts:1,platform_maximum:'unknown'};
   if(p.method==='HEAD'||[204,205,304].includes(r.status)){cancelBestEffort(r.body);const sha256=await withAbort(bodyHash(new Uint8Array()),controller.signal);release();return {status:r.status,headers,body:new Uint8Array(),metadata:{...metadata,bytes:0,sha256,delivery_mode:'buffered'}}}
   if(stream&&decision.streaming){const output=boundedStream(r.body,responseMax,release);return {status:r.status,headers,body:output,metadata:{...metadata,bytes:null,sha256:null,delivery_mode:'streaming'},cancel:()=>controller.abort('caller')}}
   const result=await collect(r.body,responseMax,controller.signal);take(result.length);const sha256=await withAbort(bodyHash(result),controller.signal);release();return {status:r.status,headers,body:result,metadata:{...metadata,bytes:result.length,sha256,delivery_mode:'buffered'}};
  }catch(e){cancelBestEffort(responseBody);release();throw e}
 }
 return Object.freeze({request,state:()=>({active,scope:'per_engine_isolate',limits:{...bound},methods:methodSet})});
}
