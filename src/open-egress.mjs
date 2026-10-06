import {cancelBestEffort,waitBounded} from './cleanup.mjs';
import {Sha256} from './sha256.mjs';
// Owner-directed HTTP using platform fetch, not a raw socket/proxy/cookie jar.
export const OPEN_LIMITS=Object.freeze({request_bytes:8*1024*1024,response_bytes:32*1024*1024,timeout_ms:60000,header_count:64,header_value_bytes:8192,header_total_bytes:65536,url_chars:4096,body_preview_bytes:4096,response_header_count:64,response_header_bytes:4096,redirects:10,mcp_input_bytes:4*Math.ceil(8*1024*1024/3)+98304});
const TOKEN=/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;const encoder=new TextEncoder();
const error=code=>{const e=Error(code);e.code=code;return e;};
export function normalizeOpenRequest(input,limits=OPEN_LIMITS){
 if(!input||typeof input!=='object'||Array.isArray(input))throw error('request_shape');
 const {url,method='GET',headers}=input;
 if(typeof url!=='string'||url.length>limits.url_chars||/[\x00-\x20\x7f\\]/.test(url))throw error('url_syntax');
 let u;try{u=new URL(url);}catch{throw error('url_syntax');}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw error('url_scheme_or_userinfo');u.hash='';
 if(typeof method!=='string'||method.length>128||!TOKEN.test(method))throw error('method_syntax');
 if(headers!==undefined&&(!headers||typeof headers!=='object'||Array.isArray(headers)))throw error('header_shape');
 const clean=Object.create(null);let total=0;const entries=Object.entries(headers??{});if(entries.length>limits.header_count)throw error('header_count_limit');
 for(const [key,value] of entries){const k=key.toLowerCase();if(!TOKEN.test(key)||Object.hasOwn(clean,k))throw error('header_name_syntax');
  if(k.startsWith('oai-')||k.startsWith('x-openai-')||k.startsWith('mcp-'))throw error('protected_platform_header');
  if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value))throw error('header_value_syntax');const n=encoder.encode(value).length;if(n>limits.header_value_bytes)throw error('header_value_limit');total+=key.length+n;if(total>limits.header_total_bytes)throw error('header_total_limit');clean[k]=value;
 }
 let body;if(input.body_base64!==undefined){const s=input.body_base64;if(typeof s!=='string'||s.length>4*Math.ceil(limits.request_bytes/3)||(s.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(s)))throw error('body_base64_invalid');let raw;try{raw=atob(s);}catch{throw error('body_base64_invalid');}if(raw.length>limits.request_bytes)throw error('request_body_limit');if(btoa(raw)!==s)throw error('body_base64_noncanonical');body=Uint8Array.from(raw,x=>x.charCodeAt(0));}
 if(input.body!==undefined){if(body!==undefined||!(input.body instanceof Uint8Array)||input.body.length>limits.request_bytes)throw error('request_body_limit');body=input.body;}
 for(const [key,max] of [['timeout_ms',limits.timeout_ms],['max_bytes',limits.response_bytes]])if(input[key]!==undefined&&(!Number.isSafeInteger(input[key])||input[key]<1||input[key]>max))throw error(key+'_limit');
 if(input.follow_redirects!==undefined&&typeof input.follow_redirects!=='boolean')throw error('follow_redirects_type');
 return {url:u.href,method,headers:clean,body};
}
const encodeBody=b=>btoa(String.fromCharCode(...b));
export async function openFetch(args,{signal,fetchImpl=fetch}={}){
 const started=Date.now(),req=normalizeOpenRequest(args),timeout=args.timeout_ms??OPEN_LIMITS.timeout_ms,max=args.max_bytes??OPEN_LIMITS.response_bytes,deadline=started+timeout;
 const controller=new AbortController(),abort=()=>controller.abort('caller_cancelled');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(()=>controller.abort('deadline'),Math.max(0,deadline-Date.now()));
 const guard=()=>{if(controller.signal.aborted||Date.now()>=deadline)throw error(controller.signal.reason==='caller_cancelled'?'cancelled':'request_timeout');};
 const wait=fn=>waitBounded(fn,{signal:controller.signal,deadline,error:()=>error(controller.signal.reason==='caller_cancelled'?'cancelled':'request_timeout'),onLate:r=>cancelBestEffort(r?.body)});
 let response,reader,requests=0,getRequests=0,headRequests=0,url=req.url,method=req.method,headers={...req.headers},body=req.body,redirected=false;
 try{guard();for(let hop=0;;hop++){
  response=await wait(()=>{requests++;if(method.toUpperCase()==='GET')getRequests++;if(method.toUpperCase()==='HEAD')headRequests++;return fetchImpl(url,{method,headers,redirect:'manual',credentials:'omit',signal:controller.signal,...(body?.length?{body}:{})});});guard();
  if(args.follow_redirects!==false&&[301,302,303,307,308].includes(response.status)&&response.headers.has('location')){
   cancelBestEffort(response.body);if(hop>=OPEN_LIMITS.redirects)throw error('redirect_limit');let next;try{next=new URL(response.headers.get('location'),url);}catch{throw error('redirect_url');}if(!['http:','https:'].includes(next.protocol)||next.username||next.password)throw error('redirect_scheme_or_userinfo');next.hash='';normalizeOpenRequest({url:next.href});
   if(next.origin!==new URL(url).origin)for(const k of ['authorization','cookie','proxy-authorization'])delete headers[k];
   if(response.status===303&&!['GET','HEAD'].includes(method.toUpperCase())||[301,302].includes(response.status)&&method.toUpperCase()==='POST'){method='GET';body=undefined;delete headers['content-type'];delete headers['content-length'];}
   url=next.href;redirected=true;continue;
  }break;
 }
 const hash=new Sha256(),preview=new Uint8Array(OPEN_LIMITS.body_preview_bytes);let bytes=0,kept=0;
 if(method.toUpperCase()==='HEAD'||[204,205,304].includes(response.status))cancelBestEffort(response.body);
 else{reader=response.body?.getReader();if(reader)for(;;){const x=await wait(()=>reader.read());guard();if(x.done)break;if(!(x.value instanceof Uint8Array))throw error('stream_chunk_type');bytes+=x.value.length;if(bytes>max)throw error('response_byte_limit');for(let i=0;i<x.value.length;i+=65536){guard();hash.update(x.value.subarray(i,i+65536));}const n=Math.min(preview.length-kept,x.value.length);preview.set(x.value.subarray(0,n),kept);kept+=n;}}
 guard();const rawType=response.headers.get('content-type')||'application/octet-stream',type=rawType.slice(0,512),outHeaders=Object.create(null);let headerBytes=0,headersTruncated=false;
 for(const [k,v] of response.headers){const n=encoder.encode(k+v).length;if(Object.keys(outHeaders).length>=OPEN_LIMITS.response_header_count||headerBytes+n>OPEN_LIMITS.response_header_bytes){headersTruncated=true;continue;}outHeaders[k]=v;headerBytes+=n;}
 const raw=preview.subarray(0,kept),textual=/^(text\/|application\/(?:json|[^;/]*\+json|javascript|xml|xhtml\+xml))/i.test(type),decodedText=textual?new TextDecoder().decode(raw):undefined;let text=decodedText,json;while(text!==undefined&&encoder.encode(JSON.stringify(text)).length>6000)text=text.slice(0,Math.floor(text.length*0.8));if(textual&&bytes<=kept&&/json/i.test(type))try{json=JSON.parse(text);}catch{}
 return {status:response.status,http_status:response.status,ok:response.status>=200&&response.status<300,content_type:type,content_type_truncated:rawType.length>512,headers:outHeaders,headers_truncated:headersTruncated,final_url:url,redirected,method:req.method,final_method:method,bytes,body_sha256:hash.hex(),hash_scope:'complete decoded response body',source_complete:true,...(textual?{text,text_truncated:bytes>kept||text!==decodedText,...(json!==undefined&&encoder.encode(JSON.stringify(json)).length<=4096?{json}:{})}:{body_base64:encodeBody(raw),body_base64_truncated:bytes>kept}),returned_body_bytes:kept,timeout_ms:timeout,max_bytes:max,duration_ms:Date.now()-started,resource_use:{requests,get_requests:getRequests,head_requests:headRequests,dns_requests:0,platform_dns_queries:null},transport:'platform HTTP fetch; actual private/loopback reachability not guaranteed',data_quality:{classification:'raw_owner_directed_response',useful_data:null,quality_gate:false},automatic_retry:false,credential_source:'explicit caller arguments only; no Sites identity/env credentials or cookie jar'};
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort('complete');cancelBestEffort(reader||response?.body);}
}
