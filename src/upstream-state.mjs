import {Sha256} from './sha256.mjs';
import {waitBounded} from './cleanup.mjs';

const utf8=new TextEncoder(),memories=new Map();
const digest=value=>new Sha256().update(utf8.encode(value)).hex();
export const KNOWN_UPSTREAM_ERRORS=new Set(['ERR_NAME_NOT_RESOLVED','ERR_CONNECTION_REFUSED','ERR_CONNECTION_RESET','ERR_ADDRESS_UNREACHABLE','ERR_CERT_COMMON_NAME_INVALID','ERR_CERT_AUTHORITY_INVALID','ERR_CERT_DATE_INVALID','ERR_CERT_INVALID','ERR_CERT_REVOKED','ERR_BLOCKED_BY_CLIENT','ERR_BLOCKED_BY_RESPONSE','ENOTFOUND','EAI_AGAIN','NS_ERROR_UNKNOWN_HOST','NS_ERROR_UNKNOWN_PROXY_HOST','NS_ERROR_PROXY_CONNECTION_REFUSED','NS_ERROR_CONNECTION_REFUSED','NS_ERROR_NET_TIMEOUT','NS_ERROR_NET_RESET','NS_ERROR_NET_INTERRUPT','proxy_connection_failed','pool_initializing','pool_saturated','curl_dns_failure']);
export const UPSTREAM_STATE_POLICY=Object.freeze({schema_version:1,probe_lease_ms:10000,storage_timeout_ms:2000,cooldown_ms:60000,max_cooldown_ms:240000,incident_read_limit:8});
const initial=()=>({sequence:0,outcome_sequence:0,revision:0,available:null,checked_at:0,failures:0,consecutive_timeouts:0,cooldown_until:0,auth_latched:0,last_error:null,last_latency:0,lifetime_failures:0,lifetime_successes:0,target_failures:0,probe_token:null,probe_until:0});
const view=(r,durable,now)=>({available:r.available===null?null:!!r.available,checkedAt:r.checked_at,failures:r.failures,lastError:r.last_error,lastLatency:r.last_latency,consecutiveTimeouts:r.consecutive_timeouts,circuitCooldownUntil:r.consecutive_timeouts>0?r.cooldown_until:0,cooldownUntil:r.cooldown_until,authLatched:!!r.auth_latched,revision:r.revision,lifetimeFailures:r.lifetime_failures,lifetimeSuccesses:r.lifetime_successes,targetFailures:r.target_failures,probeInProgress:r.probe_until>now,durability:durable?'D1':'ephemeral_unconfigured'});
export function resetEphemeralUpstreamState(){memories.clear();}
export function safeFailureEvidence(value={}){
 const out={};
 if(['json','text','empty','unread'].includes(value.format))out.format=value.format;
 if(['dns','tls','connection','proxy','pool','timeout','validation','service','unknown'].includes(value.message_class))out.message_class=value.message_class;
 for(const key of ['target_host_mentioned','legacy_error_envelope','native_error_envelope','has_message','has_error','has_detail','has_timings'])if(typeof value[key]==='boolean')out[key]=value[key];
 for(const key of ['http_status','body_bytes','known_error_count'])if(Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=8*1024*1024)out[key]=value[key];
 if(Array.isArray(value.known_errors))out.known_errors=value.known_errors.filter(x=>KNOWN_UPSTREAM_ERRORS.has(x)).slice(0,8);
 return out;
}
// Each instance is an invocation-local facade over one private endpoint row.
// The DB stores hashes and fixed classes only, never URLs, secrets or raw errors.
export class UpstreamStateStore {
 constructor(db,endpoint,{now=()=>Date.now()}={}){
  const u=new URL(endpoint);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('UPSTREAM_CONFIG_INVALID');
  this.db=db?.withSession?db.withSession('first-primary'):db??null;this.key=digest('upstream-v1:'+u.origin+u.pathname.replace(/\/+$/,''));this.now=now;this.ready=null;
 }
 async operation(fn){try{return await waitBounded(fn,{deadline:Date.now()+UPSTREAM_STATE_POLICY.storage_timeout_ms,error:()=>Error('UPSTREAM_STATE_UNAVAILABLE')});}catch{throw Error('UPSTREAM_STATE_UNAVAILABLE');}}
 async ensure(){
  if(!this.db){if(!memories.has(this.key))memories.set(this.key,{row:initial(),incidents:new Map()});return;}
  this.ready??=this.operation(()=>this.db.prepare('INSERT INTO upstream_health(endpoint_key) VALUES (?) ON CONFLICT(endpoint_key) DO NOTHING').bind(this.key).run());await this.ready;
 }
 async row(){await this.ensure();if(!this.db)return {...memories.get(this.key).row};const r=await this.operation(()=>this.db.prepare('SELECT * FROM upstream_health WHERE endpoint_key=?').bind(this.key).first());if(!r)throw Error('UPSTREAM_STATE_UNAVAILABLE');return r;}
 async read(){return view(await this.row(),!!this.db,this.now());}
 async begin(){await this.ensure();if(!this.db)return ++memories.get(this.key).row.sequence;const r=await this.operation(()=>this.db.prepare('UPDATE upstream_health SET sequence=sequence+1 WHERE endpoint_key=? RETURNING sequence').bind(this.key).first());if(!r)throw Error('UPSTREAM_STATE_UNAVAILABLE');return r.sequence;}
 async claimProbe({ignoreCooldown=false}={}){
  const r=await this.row(),now=this.now();if(r.auth_latched)return {allowed:false,reason:'operator_auth_latched'};
  if(!ignoreCooldown&&r.cooldown_until>now)return {allowed:false,reason:'cooldown',retry_after_ms:r.cooldown_until-now};
  if(r.probe_until>now)return {allowed:false,reason:'probe_in_progress',retry_after_ms:r.probe_until-now};
  const token=crypto.randomUUID(),until=now+UPSTREAM_STATE_POLICY.probe_lease_ms;
  let claimed;
  if(!this.db){const row=memories.get(this.key).row;if(row.probe_until<=now&&!row.auth_latched&&(ignoreCooldown||row.cooldown_until<=now)){row.probe_token=token;row.probe_until=until;row.sequence++;claimed=row;}}
  else claimed=await this.operation(()=>this.db.prepare('UPDATE upstream_health SET probe_token=?,probe_until=?,sequence=sequence+1 WHERE endpoint_key=? AND probe_until<=? AND auth_latched=0 AND (?=1 OR cooldown_until<=?) RETURNING sequence').bind(token,until,this.key,now,ignoreCooldown?1:0,now).first());
  return claimed?{allowed:true,token,sequence:claimed.sequence}:{allowed:false,reason:'probe_in_progress',retry_after_ms:UPSTREAM_STATE_POLICY.probe_lease_ms};
 }
 async releaseProbe(token){if(!token)return;await this.ensure();if(!this.db){const r=memories.get(this.key).row;if(r.probe_token===token){r.probe_token=null;r.probe_until=0;}return;}
  await this.operation(()=>this.db.prepare('UPDATE upstream_health SET probe_token=NULL,probe_until=0 WHERE endpoint_key=? AND probe_token=?').bind(this.key,token).run());
 }
 async healthy(sequence,latency=0){
  await this.ensure();const now=this.now();
  if(!this.db){const r=memories.get(this.key).row;r.lifetime_successes++;r.revision++;if(!r.auth_latched&&r.outcome_sequence<=sequence)Object.assign(r,{outcome_sequence:sequence,available:1,checked_at:now,failures:0,consecutive_timeouts:0,cooldown_until:0,last_error:null,last_latency:latency});return this.read();}
  const fresh='outcome_sequence<=?1 AND auth_latched=0';
  await this.operation(()=>this.db.prepare(`UPDATE upstream_health SET lifetime_successes=lifetime_successes+1,revision=revision+1,outcome_sequence=CASE WHEN ${fresh} THEN ?1 ELSE outcome_sequence END,available=CASE WHEN ${fresh} THEN 1 ELSE available END,checked_at=CASE WHEN ${fresh} THEN ?2 ELSE checked_at END,failures=CASE WHEN ${fresh} THEN 0 ELSE failures END,consecutive_timeouts=CASE WHEN ${fresh} THEN 0 ELSE consecutive_timeouts END,cooldown_until=CASE WHEN ${fresh} THEN 0 ELSE cooldown_until END,last_error=CASE WHEN ${fresh} THEN NULL ELSE last_error END,last_latency=CASE WHEN ${fresh} THEN ?3 ELSE last_latency END WHERE endpoint_key=?4`).bind(sequence,now,latency,this.key).run());return this.read();
 }
 async failure(sequence,category,{scope='service',http_status=null,target='',evidence={}}={}){
  if(!['service','target','unknown','auth'].includes(scope)||!/^[-a-zA-Z0-9_:]{1,96}$/.test(category))throw Error('UPSTREAM_FAILURE_CLASS_INVALID');
  await this.ensure();const now=this.now(),timeout=/deadline|timeout/i.test(category),targetKey=digest(String(target)),incidentKey=digest(this.key+'|'+scope+'|'+category+'|'+targetKey),safe=safeFailureEvidence(evidence),status=Number.isInteger(http_status)&&http_status>=100&&http_status<=599?http_status:null;
  if(!this.db){const m=memories.get(this.key),r=m.row,old=m.incidents.get(incidentKey);m.incidents.set(incidentKey,{scope,category,first_seen:old?.first_seen??now,last_seen:now,occurrences:(old?.occurrences??0)+1,http_status:status,evidence:safe});r.lifetime_failures++;r.revision++;if(scope==='target')r.target_failures++;
   else if(r.outcome_sequence<=sequence||scope==='auth'){if(timeout)r.consecutive_timeouts++;Object.assign(r,{outcome_sequence:Math.max(sequence,r.outcome_sequence),available:0,checked_at:now,failures:r.failures+1,last_error:category,cooldown_until:now+(r.consecutive_timeouts>=5?240000:r.consecutive_timeouts===4?120000:60000),auth_latched:scope==='auth'?1:r.auth_latched});}return this.read();}
  const fresh='?1=0 AND (outcome_sequence<=?2 OR ?3=1)',health=this.db.prepare(`UPDATE upstream_health SET lifetime_failures=lifetime_failures+1,target_failures=target_failures+?1,revision=revision+1,outcome_sequence=CASE WHEN ${fresh} THEN MAX(outcome_sequence,?2) ELSE outcome_sequence END,available=CASE WHEN ${fresh} THEN 0 ELSE available END,checked_at=CASE WHEN ${fresh} THEN ?4 ELSE checked_at END,failures=CASE WHEN ${fresh} THEN failures+1 ELSE failures END,consecutive_timeouts=CASE WHEN ${fresh} THEN consecutive_timeouts+?5 ELSE consecutive_timeouts END,cooldown_until=CASE WHEN ${fresh} THEN ?4+CASE WHEN consecutive_timeouts+?5>=5 THEN 240000 WHEN consecutive_timeouts+?5=4 THEN 120000 ELSE 60000 END ELSE cooldown_until END,auth_latched=CASE WHEN ?3=1 THEN 1 ELSE auth_latched END,last_error=CASE WHEN ${fresh} THEN ?6 ELSE last_error END WHERE endpoint_key=?7`).bind(scope==='target'?1:0,sequence,scope==='auth'?1:0,now,timeout?1:0,category,this.key);
  const incident=this.db.prepare('INSERT INTO upstream_failures(incident_key,endpoint_key,scope,category,first_seen,last_seen,http_status,evidence_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(incident_key) DO UPDATE SET last_seen=excluded.last_seen,occurrences=upstream_failures.occurrences+1,http_status=excluded.http_status,evidence_json=excluded.evidence_json').bind(incidentKey,this.key,scope,category,now,now,status,JSON.stringify(safe));
  await this.operation(()=>this.db.batch([health,incident]));return this.read();
 }
 async incidents(){await this.ensure();if(!this.db)return [...memories.get(this.key).incidents.values()].sort((a,b)=>b.last_seen-a.last_seen).slice(0,8);
  const r=await this.operation(()=>this.db.prepare('SELECT scope,category,first_seen,last_seen,occurrences,http_status,evidence_json FROM upstream_failures WHERE endpoint_key=? ORDER BY last_seen DESC LIMIT 8').bind(this.key).all());
  return r.results.map(({evidence_json,...row})=>({...row,evidence:safeFailureEvidence(JSON.parse(evidence_json))}));
 }
}
