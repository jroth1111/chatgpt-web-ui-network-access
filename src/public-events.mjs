import {cancelBestEffort} from './cleanup.mjs';
import {acquirePublic,publicURL} from './public-reader.mjs';
import {Sha256} from './sha256.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const tidy=(s,n=512)=>typeof s==='string'?s.replace(/\s+/g,' ').trim().slice(0,n):null;
export const EVENT_LIMITS=Object.freeze({hydration_bytes:131072,json_bytes:262144,sessions:64,requests:2});
export function fringeEventURL(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='www.melbournefringe.com.au'&&!u.port&&!u.username&&!u.password&&/^\/whats-on\/events\/[a-z0-9-]+\/?$/.test(u.pathname)&&!u.search;}catch{return false;}}
export function publicEventMetadata(data){const p=data?.props?.pageProps?.page;if(!p||typeof p.id!=='string'||!UUID.test(p.id))return null;return {id:p.id,title:tidy(p.title||p.name,200)};}
const safeLink=value=>{try{if(typeof value!=='string'||!value)return null;return publicURL(new URL(value,'https://www.melbournefringe.com.au').href);}catch{return null;}};
export function validTargetDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;}
const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const weekdays=['sun','mon','tue','wed','thu','fri','sat'];
export function normalizeSession(session,detail,{target_date,timezone='Australia/Melbourne'}={}){
 const date=tidy(session?.date,100),time=tidy(session?.time,100),range=tidy(detail?.dateRange,160);
 // CMS ISO values remain raw. Their Z suffix does not override venue-local labels.
 const years=[...(range||'').matchAll(/\b(20\d{2})\b/g)].map(x=>Number(x[1]));
 const unique=[...new Set(years)];const year=unique.length===1?unique[0]:null;
 const match=date?.match(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),?\s*(\d{1,2})\s+([A-Za-z]+)(?:\s+(20\d{2}))?$/i);
 let local_date=null,local_time=null,ambiguity=null;
 const explicitYear=match?.[4]?Number(match[4]):year;
 if(match&&explicitYear){const month=months.indexOf(match[3].slice(0,3).toLowerCase());const candidate=explicitYear+'-'+String(month+1).padStart(2,'0')+'-'+match[2].padStart(2,'0');if(month>=0&&validTargetDate(candidate)&&weekdays[new Date(candidate+'T00:00:00Z').getUTCDay()]===match[1].slice(0,3).toLowerCase())local_date=candidate;else ambiguity='Invalid date or weekday mismatch';}else ambiguity='Session local date or unambiguous event year absent';
 const tm=time?.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);if(tm&&Number(tm[1])>=1&&Number(tm[1])<=12&&Number(tm[2])<60)local_time=String(Number(tm[1])%12+(tm[3].toLowerCase()==='pm'?12:0)).padStart(2,'0')+':'+tm[2];else ambiguity=ambiguity||'Local time not recognized';
 const cancelled=session?.cancelled===true,reported=tidy(session?.status,100);
 return {id:typeof session?.id==='string'&&UUID.test(session.id)?session.id:null,raw:{date,time,status:reported,cancelled:typeof session?.cancelled==='boolean'?session.cancelled:null,unticketed:typeof session?.unticketed==='boolean'?session.unticketed:null},local_date,local_time,timezone,normalization_basis:'Public session local date/time labels plus explicit event dateRange year; weekday validated; CMS Z timestamps never timezone-shifted',ambiguity,target_date_match:target_date&&local_date?local_date===target_date:null,venue:tidy(session?.venue,200),venue_url:safeLink(session?.venueUrl),town:tidy(session?.town,100),duration:tidy(session?.duration,100),reported_availability:cancelled?'Cancelled':reported||'unknown',cancelled,inventory_count:null,inventory_basis:'No explicit public seat-count evidence; status is not a checkout guarantee'};
}
export function eventEvidence({target_date,timezone='Australia/Melbourne',failure='Public sessions not acquired'}={}){return {target_date:target_date||null,timezone,schedule_confirmed:false,target_session_match:null,reported_availability:'unknown',inventory_count:null,description:null,sessions:[],sources:[],method:'bounded_public_GET_adapter; inert hydration JSON parsed, never executed',failure,partial:true,search_index_is_session_proof:false,workflow:{draft_only:true,send_authorized:false,send_requires:'Explicit latest user request to send; research or update-draft never authorizes sending',enforcement_scope:'Research guidance only; this GET-only Site cannot enforce unrelated Gmail connector actions'}};}
export async function acquireFringeEvent(pageURL,eventMetadata,{signal,deadline,transport,budget,receipts,target_date,timezone='Australia/Melbourne'}={}){
 const evidence=eventEvidence({target_date,timezone});
 if(!fringeEventURL(pageURL)||!UUID.test(eventMetadata?.id||'')){evidence.failure='Canonical provider URL or validated public hydration event ID absent';return evidence;}
 const id=eventMetadata.id,base='https://api.melbournefringe.com.au/api/Event/';
 const get=async url=>{
  const providerTransport={resolve(host,context){if(host!=='api.melbournefringe.com.au')throw Error('EVENT_POLICY: provider redirect host denied');return transport.resolve(host,context);},guardedFetch(value,context){if(value!==url)throw Error('EVENT_POLICY: only observed public endpoint permitted');return transport.guardedFetch(value,context);}};
  const result=await acquirePublic(url,{signal,deadline,transport:providerTransport,budget,receipts,media:'guest-fetch',corsOrigin:new URL(pageURL).origin,staticConsumer:async(response,{type,wait,signal:abort,deadline:at})=>{
   if(type!=='application/json')throw Error('EVENT_POLICY: public JSON MIME required');
   const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),hash=new Sha256();let bytes=0,text='';
   try{for(;;){const next=await wait('event public JSON',()=>reader.read());if(abort.aborted||Date.now()>=at)throw Error('DEADLINE: event JSON');if(next.done)break;bytes+=next.value.length;budget.bytes+=next.value.length;if(bytes>EVENT_LIMITS.json_bytes||budget.bytes>budget.max_bytes)throw Error('EVENT_POLICY: public JSON byte cap');hash.update(next.value);text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();const parsed=JSON.parse(text);if(parsed?.isError!==false||!parsed.result||typeof parsed.result!=='object')throw Error('EVENT_POLICY: public provider error or malformed result');return {data:parsed.result,source:{url,retrievedAt:new Date().toISOString(),method:'GET',mime:type,bytes,sha256:hash.hex(),hash_scope:'complete decoded public JSON body'}};}finally{cancelBestEffort(reader);}
  }});
  if(result.status!=='PASS')throw Error(result.error||'Public JSON acquisition failed');return result;
 };
 try{
  const detail=await get(base+'Detail?Id='+id);evidence.sources.push(detail.source);
  const sessions=await get(base+'Sessions?EventId='+id);evidence.sources.push(sessions.source);
  if(!Array.isArray(sessions.data.sessions)||sessions.data.sessions.length>EVENT_LIMITS.sessions)throw Error('EVENT_POLICY: sessions count/schema cap');
  evidence.description={text:tidy(detail.data.description||detail.data.shortDescription,1200),source_url:detail.source.url,kind:'live_official_description'};
  evidence.event={id,title:tidy(detail.data.title||detail.data.name,200)||eventMetadata.title,dateRange:tidy(detail.data.dateRange,160),venue:tidy(detail.data.venue,200),duration:tidy(detail.data.duration,100),raw_start:tidy(detail.data.start||detail.data.startDate,100),raw_end:tidy(detail.data.end||detail.data.endDate,100)};
  evidence.sessions=sessions.data.sessions.map(s=>normalizeSession(s,detail.data,{target_date,timezone}));
  const malformed=evidence.sessions.some(x=>x.ambiguity),matches=evidence.sessions.filter(x=>x.target_date_match===true);
  evidence.schedule_confirmed=!malformed;evidence.target_session_match=target_date?(malformed?null:matches.length>0):null;
  evidence.reported_availability=matches.length?matches.map(x=>({id:x.id,local_date:x.local_date,local_time:x.local_time,status:x.reported_availability})): 'unknown';
  evidence.total_sessions=evidence.sessions.length;evidence.partial=malformed;evidence.failure=malformed?'Some public session labels could not be normalized':null;
 }catch(error){evidence.failure=String(error.message).slice(0,512);}
 return evidence;
}
