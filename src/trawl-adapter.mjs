// TRAWL adapter: browser-grade scraping with availability failover.
// Primary: TRAWL /v1 API (FlareSolverr-compatible) on the operator's VPS.
// Failover: existing guarded public stack (browser_read_page / openFetch path
// chosen by the caller) — this module returns a typed routing decision, never
// silently downgrades.
//
// Availability model: cached probe with TTL + cooldown after failures.
// The adapter NEVER bypasses the guarded stack and NEVER fakes a TRAWL result.
import {extractReadable,detectAppShell} from './readability.mjs';
import {cancelBestEffort,waitBounded} from './cleanup.mjs';
import {Sha256} from './sha256.mjs';
export const TRAWL_LIMITS=Object.freeze({
  probe_ttl_ms:30000,          // availability result cache
  failure_cooldown_ms:60000,   // after a hard failure, skip TRAWL this long
  request_timeout_ms:120000,   // TRAWL solves can take ~2min (browser tier)
  max_timeout_ms:180000,       // caller maxTimeout cap passed to TRAWL
  response_bytes:8*1024*1024,  // solution response cap
  body_preview:262144,         // html text returned to caller
  probe_timeout_ms:4000,       // fast failover: probe latency adds to every first-call
  circuit_breaker_threshold:3, // consecutive timeouts before exponential cooldown
  circuit_max_cooldown_ms:240000,
  batch_max_items:10,          // parallel scrape batch cap
  batch_concurrency:4,         // parallel in-flight TRAWL requests per batch
  batch_timeout_ms:240000,     // whole-batch deadline
});
// Config injection: the MCP layer passes {url, token} from env/bindings so the
// adapter stays testable and free of ambient reads.
let state={available:null,checkedAt:0,failures:0,lastError:null,lastLatency:0,consecutiveTimeouts:0,circuitCooldownUntil:0};
export function trawlState(){return {...state};}
export function resetTrawlState(){state={available:null,checkedAt:0,failures:0,lastError:null,lastLatency:0,consecutiveTimeouts:0,circuitCooldownUntil:0};}
// Exponential circuit breaker: after N consecutive timeouts, widen the cooldown
// 60s → 120s → 240s (capped). Distinguishes timeouts (network hanging) from
// clean failures (fast health-false) — only timeouts trip the breaker.
function effectiveCooldown(now=Date.now()){
  if(state.consecutiveTimeouts>=TRAWL_LIMITS.circuit_breaker_threshold){
    const exponent=Math.min(state.consecutiveTimeouts-TRAWL_LIMITS.circuit_breaker_threshold,4);
    return Math.min(TRAWL_LIMITS.failure_cooldown_ms*Math.pow(2,exponent),TRAWL_LIMITS.circuit_max_cooldown_ms);
  }
  return TRAWL_LIMITS.failure_cooldown_ms;
}
export function isCooldownActive(now=Date.now(),cooldown){
  if(cooldown!==undefined)return state.available===false && state.failures>0 && (now-state.checkedAt)<cooldown;
  if(state.circuitCooldownUntil>now)return true;
  return state.available===false && state.failures>0 && (now-state.checkedAt)<TRAWL_LIMITS.failure_cooldown_ms;
}
function recordTimeout(){state.consecutiveTimeouts++;state.circuitCooldownUntil=Date.now()+effectiveCooldown();}
function recordHealthy(){state.consecutiveTimeouts=0;state.circuitCooldownUntil=0;state.lastError=null;}
const probeJitter=()=>Math.floor(Math.random()*400); // 0-400ms anti-herd jitter
function authHeaders(config){return config.token?{authorization:'Basic '+btoa('sites:'+config.token)}:{};}
function safeFailure(error,fallback){
  const message=String(error?.message||error);
  return /^(?:probe_deadline|trawl_deadline|trawl_response_limit|trawl_envelope_invalid|trawl_http_\d{3})$/.test(message)?message:fallback;
}
function targetFailure(envelope){
  if(envelope?.status!=='error')return null;
  // A HTTP 500 alone is not target evidence. Recognize explicit browser target
  // errors; opaque service errors still degrade endpoint availability.
  return String(envelope.message||'').match(/\bERR_(?:NAME_NOT_RESOLVED|CERT_[A-Z_]+|CONNECTION_REFUSED|CONNECTION_RESET|ADDRESS_UNREACHABLE|BLOCKED_BY_[A-Z_]+)\b/)?.[0]||null;
}
function publicHeaders(headers){
  return Object.fromEntries(Object.entries(headers&&typeof headers==='object'&&!Array.isArray(headers)?headers:{}).filter(([key,value])=>typeof value==='string'&&!/(?:^set-cookie$|^cookie$|authorization|^oai-|^x-sites-)/i.test(key)).slice(0,64).map(([key,value])=>[key,value.slice(0,512)]));
}
export async function probeTrawl(config,{fetchImpl=fetch,signal,cooldown}={}){
  const now=Date.now();
  if(signal?.aborted)return {available:false,cached:false,error:'caller_abort'};
  if(!config?.url)return {available:false,cached:true,error:'trawl_not_configured'};
  if(state.available===true && (now-state.checkedAt)<TRAWL_LIMITS.probe_ttl_ms){
    return {available:true,cached:true,latency:state.lastLatency,error:null};
  }
  if(isCooldownActive(now,cooldown) && state.available!==null){
    return {available:false,cached:true,cooldown:true,error:state.lastError};
  }
  const started=Date.now();
  let callerAborted=false;
  // anti-herd: after failures, stagger the retry across isolates (0-400ms)
  if(state.failures>0&&state.available!==null&&!isCooldownActive(now,cooldown)){
    let jitter;
    try{await waitBounded(()=>new Promise(resolve=>{jitter=setTimeout(resolve,probeJitter());}),{signal,error:()=>Error('caller_abort')});}
    catch{return {available:false,cached:false,error:'caller_abort'};}
    finally{clearTimeout(jitter);}
  }
  try{
    const controller=new AbortController();
    const deadline=Date.now()+TRAWL_LIMITS.probe_timeout_ms;
    const wait=operation=>waitBounded(operation,{signal:controller.signal,deadline,error:()=>Error(callerAborted?'caller_abort':'probe_deadline'),onLate:response=>cancelBestEffort(response?.body)});
    const abort=()=>{callerAborted=true;controller.abort('caller_abort');};
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    let res;
    try{
      res=await wait(()=>fetchImpl(new URL(config.url.replace(/\/+$/,'')+'/health').href,{signal:controller.signal,headers:authHeaders(config)}));
      const ok=res.ok;
      let detail=null;
      if(ok){try{detail=await wait(()=>res.json());}catch(e){if(controller.signal.aborted||Date.now()>=deadline)throw e;detail=null;}}
      state={...state,available:ok,checkedAt:Date.now(),failures:ok?0:state.failures+1,lastError:ok?null:'health_http_'+res.status,lastLatency:Date.now()-started};
      if(ok)recordHealthy();
      return {available:ok,cached:false,latency:state.lastLatency,detail};
    }finally{controller.abort('probe_complete');cancelBestEffort(res?.body);signal?.removeEventListener('abort',abort);}
  }catch(e){
    // Caller abort is not a TRAWL health signal — return without state pollution.
    if(callerAborted)return {available:false,cached:false,latency:Date.now()-started,error:'caller_abort'};
    const msg=safeFailure(e,'trawl_probe_transport_error');
    if(/probe_deadline/i.test(msg))recordTimeout();
    state={...state,available:false,checkedAt:Date.now(),failures:state.failures+1,lastError:msg.slice(0,200),lastLatency:Date.now()-started};
    return {available:false,cached:false,latency:state.lastLatency,error:state.lastError};
  }
}
// Routing decision — the core of the failover contract.
// Returns one of:
//   {route:'trawl', url, init}          -> caller performs this POST
//   {route:'fallback', reason, probe}   -> caller uses existing guarded stack
export async function routeTrawl(targetUrl,args,config,{fetchImpl=fetch,signal,cooldown}={}){
  if(signal?.aborted)return {route:'fallback',reason:'caller_abort',probe:null};
  if(!config?.url) return {route:'fallback',reason:'trawl_not_configured',probe:null};
  // Plain-HTTP targets hang the TRAWL browser tier (observed live: neverssl.com
  // 120s timeout). Route them to the guarded stack immediately instead.
  if(/^http:\/\//i.test(targetUrl)) return {route:'fallback',reason:'plain_http_target',probe:null};
  const probe=await probeTrawl(config,{fetchImpl,signal,cooldown});
  if(!config?.url||!probe.available) return {route:'fallback',reason:config?.url?'trawl_unavailable:'+String(probe.error||'health_false'):'trawl_not_configured',probe};
  const maxTimeout=Math.min(Math.max(1000,Number(args.timeout_ms)||60000),TRAWL_LIMITS.max_timeout_ms);
  const body={cmd:'request.get',url:targetUrl,maxTimeout,
    ...(args.session!==undefined?{session:args.session}:{}),
    ...(args.returnOnlyCookies===true?{returnOnlyCookies:true}:{}),
  };
  const headers={'content-type':'application/json'};
  Object.assign(headers,authHeaders(config));
  return {route:'trawl',url:new URL(config.url.replace(/\/+$/,'')+'/v1').href,init:{method:'POST',headers,body:JSON.stringify(body)},maxTimeout,probe};
}
// Execute the routed request and normalize the envelope. Fallback decisions are
// surfaced, not hidden: if TRAWL errors at request time, we mark cooldown and
// return {ok:false, fallback:true} so the caller can retry via guarded stack.
export async function trawlScrape(targetUrl,args,config,{fetchImpl=fetch,signal,cooldown}={}){
  const decision=await routeTrawl(targetUrl,args,config,{fetchImpl,signal,cooldown});
  if(decision.route==='fallback')return {ok:false,fallback:true,reason:decision.reason,probe:decision.probe};
  const started=Date.now();
  const controller=new AbortController();
  const deadline=started+Math.max(decision.maxTimeout+5000,TRAWL_LIMITS.request_timeout_ms);
  let callerAborted=false;
  const abort=()=>{callerAborted=true;controller.abort('caller_abort');};
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  const wait=operation=>waitBounded(operation,{signal:controller.signal,deadline,error:()=>Error(callerAborted?'caller_abort':'trawl_deadline'),onLate:response=>cancelBestEffort(response?.body)});
  let res;
  try{
    res=await wait(()=>fetchImpl(decision.url,{...decision.init,signal:controller.signal}));
    const httpError=()=>{
      const err=Error('trawl_http_'+res.status);
      // 4xx = request-level problem (auth, bad path) — transient for the caller,
      // don't trip the breaker. 5xx = TRAWL itself struggling — arm the breaker.
      err.httpStatus=res.status;
      err.trawl4xx=res.status>=400&&res.status<500;
      return err;
    };
    if(res.status>=400&&res.status<500)throw httpError();
    const reader=res.body?.getReader();const chunks=[];let bytes=0;
    try{if(reader)while(true){const part=await wait(()=>reader.read());if(part.done)break;bytes+=part.value.byteLength;if(bytes>TRAWL_LIMITS.response_bytes)throw Error('trawl_response_limit');chunks.push(part.value);}}finally{cancelBestEffort(reader);}
    const joined=new Uint8Array(bytes);let offset=0;for(const c of chunks){joined.set(c,offset);offset+=c.byteLength;}
    const raw=new TextDecoder().decode(joined);
    if(raw.length>TRAWL_LIMITS.response_bytes)throw Error('trawl_response_limit');
    let envelope;try{envelope=JSON.parse(raw);}catch{if(!res.ok)throw httpError();throw Error('trawl_envelope_invalid');}
    if(!res.ok&&!targetFailure(envelope))throw httpError();
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||!['ok','error'].includes(envelope.status))throw Error('trawl_envelope_invalid');
    // Solve envelope: TRAWL is healthy. failures counter stays at 0 — otherwise
    // failures>0 seeds isCooldownActive after the probe TTL expires (ST-3).
    const responseHealthy=()=>{state={...state,available:true,checkedAt:Date.now(),lastLatency:Date.now()-started,failures:0,lastError:null};recordHealthy();};
    if(envelope.status!=='ok'){
      // TRAWL answered — the endpoint is healthy; the TARGET failed (bad domain,
      // blocked, etc.). Do not trip the availability cooldown: the next call to
      // a different URL should reach TRAWL normally.
      const code=targetFailure(envelope)||'target_solve_failed';
      responseHealthy();
      state={...state,lastError:code,lastLatency:Date.now()-started};
      return {ok:false,fallback:true,reason:'trawl_error:'+code,trawl_status:envelope.status,duration_ms:Date.now()-started};
    }
    const sol=envelope.solution||{};
    if(!Number.isInteger(sol.status)||sol.status<100||sol.status>599||typeof sol.response!=='string'&&args.returnOnlyCookies!==true)throw Error('trawl_envelope_invalid');
    responseHealthy();
    const html=typeof sol.response==='string'?sol.response:'';
    const htmlBytes=new TextEncoder().encode(html);
    // 40K text + links + headers can exceed the 32KB MCP envelope after JSON
    // serialization; cap text so the whole result fits (single-scrape reads of
    // huge pages should use browser_read_page for its 16K markdown path).
    const readable=extractReadable(html,{maxText:22000});
    const shellReasons=detectAppShell(html);
    return {
      ok:true,
      url:sol.url||targetUrl,
      status:sol.status??null,
      headers:publicHeaders(sol.headers),
      bytes:htmlBytes.byteLength,
      body_sha256:new Sha256().update(htmlBytes).hex(),
      hash_scope:'complete upstream solution HTML encoded as UTF8',
      // html omitted by default: text+links carry the content within the MCP
      // envelope; raw HTML is one browser_open_fetch call away when needed.
      html:html.slice(0,4000),
      html_truncated:html.length>4000,
      text:readable.text,
      title:readable.title,
      links:readable.links.slice(0,25),
      text_truncated:readable.text_truncated,
      ...(shellReasons.length?{app_shell_suspected:true,shell_reasons:shellReasons}:{}),
      cookies:Array.isArray(sol.cookies)?sol.cookies.length:0,
      ...(sol.userAgent?{user_agent:sol.userAgent}:{}),
      ...(envelope.startTimestamp?{solve_ms:(envelope.endTimestamp||Date.now())-envelope.startTimestamp}:{}),
      duration_ms:Date.now()-started,
      via:'trawl',
    };
  }catch(e){
    const msg=safeFailure(e,'trawl_transport_error');
    // Caller abort (client disconnect/tool deadline) is NOT a TRAWL health
    // signal: return without polluting availability/breaker state. Detect via
    // the explicit flag — undici loses the abort reason in the rejection.
    if(callerAborted){
      return {ok:false,fallback:true,reason:'caller_abort',duration_ms:Date.now()-started};
    }
    const is4xx=e?.trawl4xx===true;
    if(/trawl_deadline/i.test(msg))recordTimeout();
    // 4xx from TRAWL: request-level issue — record but keep endpoint available.
    // 5xx/transport/deadline: endpoint struggling — flip availability + breaker.
    if(is4xx){
      state={...state,lastError:msg,lastLatency:Date.now()-started};
    }else{
      state={...state,failures:state.failures+1,lastError:msg.slice(0,200),checkedAt:Date.now(),available:false};
      // recordTimeout already called above for deadlines; no second call (ST-4)
    }
    return {ok:false,fallback:true,reason:'trawl_request_failed:'+msg.slice(0,120),duration_ms:Date.now()-started};
  }finally{controller.abort('scrape_complete');cancelBestEffort(res?.body);signal?.removeEventListener('abort',abort);}
}
// Parallel batch: N URLs through TRAWL with bounded in-flight concurrency.
// Shares one availability probe; per-item failures isolated; whole-batch deadline.
export async function trawlScrapeBatch(urls,args,config,{fetchImpl=fetch,signal,cooldown}={}){
  // MCP layer passes [{url, session}] objects; normalize to targetUrl strings
  // and thread per-item session into the TRAWL body.
  if(!Array.isArray(urls)||!urls.length)return {ok:false,fallback:true,reason:'batch_empty'};
  const items=urls.map(u=>typeof u==='string'?{url:u,session:args.session}:typeof u==='object'&&u?{url:u.url,session:u.session??args.session}:null);
  if(items.some(it=>!it||typeof it.url!=='string'))return {ok:false,fallback:true,reason:'batch_invalid_item'};
  const plainUrls=items.map(it=>it.url);
  if(urls.length>TRAWL_LIMITS.batch_max_items)return {ok:false,fallback:true,reason:'batch_too_large:'+urls.length+'>'+TRAWL_LIMITS.batch_max_items};
  if(!config?.url)return {ok:false,fallback:true,reason:'trawl_not_configured',probe:null};
  const probe=await probeTrawl(config,{fetchImpl,signal,cooldown});
  if(!probe.available)return {ok:false,fallback:true,reason:'trawl_unavailable:'+String(probe.error||'health_false'),probe};
  const started=Date.now();
  const batchDeadline=Date.now()+TRAWL_LIMITS.batch_timeout_ms;
  const results=new Array(items.length);
  let next=0;
  const worker=async()=>{
    while(next<items.length){
      const idx=next++;
      const item=items[idx];
      if(Date.now()>=batchDeadline||signal?.aborted){results[idx]={url:item.url,ok:false,fallback:true,reason:'batch_deadline'};continue;}
      try{
        const single=await trawlScrape(item.url,{...args,session:item.session,timeout_ms:Math.min(Number(args.timeout_ms)||60000,Math.max(1000,batchDeadline-Date.now()))},config,{fetchImpl,signal,cooldown});
        // compact per-item result: full text/html excluded from batch responses
        // (10 × 40KB text + 256KB html would blow the 32KB MCP envelope). Full
        // bodies remain available via single browser_scrape calls.
        results[idx]=single.ok?{
          url:single.url,route:'trawl',ok:true,status:single.status,title:single.title,
          text:(single.text||'').slice(0,1200),text_truncated:(single.text||'').length>1200||single.text_truncated,
          bytes:single.bytes,body_sha256:single.body_sha256,hash_scope:single.hash_scope,cookies:single.cookies,duration_ms:single.duration_ms,via:single.via,
          ...(single.app_shell_suspected?{app_shell_suspected:true,shell_reasons:single.shell_reasons}:{}),
        }:{url:item.url,ok:false,route:'fallback',fallback:single.fallback,reason:single.reason,fallback_reason:single.reason,duration_ms:single.duration_ms};
      }catch(e){
        results[idx]={url:item.url,ok:false,fallback:true,reason:'item_error:'+safeFailure(e,'batch_item_error')};
      }
    }
  };
  const workers=Array.from({length:Math.min(TRAWL_LIMITS.batch_concurrency,items.length)},worker);
  await Promise.all(workers);
  const okCount=results.filter(r=>r&&r.ok).length;
  return {
    ok:okCount>0,
    batch:true,
    total:items.length,
    ok_count:okCount,
    fallback_count:items.length-okCount,
    results,
    via:'trawl',
    duration_ms:Date.now()-started,
  };
}
