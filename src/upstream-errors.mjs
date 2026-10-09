import {safeFailureEvidence,KNOWN_UPSTREAM_ERRORS} from './upstream-state.mjs';
const texts=envelope=>{
 const result=[];for(const root of [envelope,envelope?.error,envelope?.detail])if(root&&typeof root==='object')for(const key of ['message','error','detail','reason','code'])if(typeof root[key]==='string')result.push(root[key].slice(0,4096));
 for(const t of Array.isArray(envelope?.timings)?envelope.timings.slice(0,8):[])if(typeof t?.reason==='string')result.push(t.reason.slice(0,4096));return result.slice(0,16);
};
export function legacyTargetBound(envelope,targetUrl){
 if(envelope?.status!=='error'||envelope?.solution?.status!==0||typeof envelope?.solution?.url!=='string')return false;
 try{const actual=new URL(envelope.solution.url),requested=new URL(targetUrl);if(actual.username||actual.password||requested.username||requested.password)return false;actual.hash='';requested.hash='';return actual.href===requested.href;}catch{return false;}
}
export function failureEvidence(raw,envelope,targetUrl,httpStatus){
 const list=texts(envelope);if(!envelope)list.push(String(raw).slice(0,4096));const message=list.join('\n');
 const tokens=[...new Set((message.match(/\b(?:ERR_[A-Z_]+|ENOTFOUND|EAI_AGAIN|NS_ERROR_[A-Z_]+)\b/g)||[]).filter(x=>KNOWN_UPSTREAM_ERRORS.has(x)))];
 if(/proxy[-_ ]connection[-_ ]failed|ERR_PROXY|NS_ERROR_PROXY/i.test(message))tokens.push('proxy_connection_failed');
 if(/browser pool initializing/i.test(message))tokens.push('pool_initializing');
 if(/browser pool saturated/i.test(message))tokens.push('pool_saturated');
 if(/curl[^\n]{0,40}(?:\(6\)|error.?6)|Could not resolve host:/i.test(message))tokens.push('curl_dns_failure');
 let mentioned=false;try{const host=new URL(targetUrl).hostname.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');mentioned=new RegExp('(^|[^a-z0-9.-])'+host+'(?=$|[^a-z0-9.-])','i').test(message);}catch{}
 const family=/proxy/i.test(tokens.join(' '))?'proxy':/pool/i.test(tokens.join(' '))?'pool':/RESOLVED|ENOTFOUND|EAI_AGAIN|UNKNOWN_HOST|curl_dns/.test(tokens.join(' '))?'dns':/CERT_|SSL|TLS/.test(tokens.join(' '))?'tls':/CONNECTION|ADDRESS_UNREACHABLE/.test(tokens.join(' '))?'connection':/timeout|deadline|timed out/i.test(message)?'timeout':/validat|invalid request|unknown cmd/i.test(message)?'validation':'unknown';
 return safeFailureEvidence({format:envelope?'json':raw?'text':'empty',http_status:httpStatus,body_bytes:new TextEncoder().encode(String(raw)).length,message_class:family,known_errors:tokens,known_error_count:tokens.length,target_host_mentioned:mentioned,
  legacy_target_url_matches:legacyTargetBound(envelope,targetUrl),legacy_error_envelope:envelope?.status==='error',native_error_envelope:typeof envelope?.error==='string',has_message:typeof envelope?.message==='string',has_error:envelope?.error!==undefined,has_detail:envelope?.detail!==undefined,has_timings:Array.isArray(envelope?.timings)});
}
