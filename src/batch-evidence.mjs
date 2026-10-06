import {publicURL} from './public-reader.mjs';
// Deterministic semantic projection. Source bodies and repeated receipts never
// compete with the evidence needed to assess each acquisition.
const encoder=new TextEncoder();
export const utf8Bytes=value=>encoder.encode(JSON.stringify(value)).length;
const number=x=>Number.isFinite(x)&&x>=0?Math.min(x,Number.MAX_SAFE_INTEGER):0;
const counters=x=>({get_requests:number(x?.get_requests),head_requests:number(x?.head_requests),dns_requests:number(x?.dns_requests)});
const fullHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)?x:null;
export function compactEvidence(item,{scaleOnly=1}={}){
 const scale=scaleOnly;
  const flags=[],clip=(value,cap,path)=>{if(typeof value!=='string')return typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean'?value:null;const bytes=encoder.encode(value);if(bytes.length<=cap)return value;flags.push(path);return new TextDecoder().decode(bytes.subarray(0,cap)).replace(/\ufffd$/,'');};
  const text=(v,n,p)=>clip(v,Math.max(16,Math.floor(n*scale)),p);
  const url=(obj,value,n,path)=>{obj.url=text(value,n,path+'.url');obj.url_complete=!flags.includes(path+'.url');};
  const sp=item.static_provenance,sourceComplete=sp?.source_complete??item.source_complete??false;
  const out={index:item.index,status:item.status,error:null,source_status:item.source_status||item.status,url:text(item.url,240,'url'),method:item.method||'GET',classification:clip(item.classification,64,'classification'),preset:clip(item.preset,16,'preset'),source_complete:sourceComplete,sha256:sourceComplete?fullHash(sp?.source_sha256||item.sha256):null,hash_scope:sourceComplete?clip(sp?.source_hash_scope||item.hash_scope,80,'hash_scope'):null,decoded_bytes:number(sp?.source_decoded_bytes??item.decoded_bytes),fetchedAt:clip(item.retrievedAt||item.cache?.fetchedAt,32,'fetchedAt'),cache:item.cache?{hit:!!item.cache.hit,coalesced:!!item.cache.coalesced,fetchedAt:clip(item.cache.fetchedAt,32,'cache.fetchedAt'),source_build:fullHash(item.cache.source_build),...(item.cache.age_ms!==undefined?{age_ms:number(item.cache.age_ms)}:{}),...(item.cache.ttl_ms!==undefined?{ttl_ms:number(item.cache.ttl_ms)}:{}),...(item.cache.stored!==undefined?{stored:!!item.cache.stored}:{})}:null,duration_ms:number(item.duration_ms),source_duration_ms:number(item.source_duration_ms),fresh_network:counters(item.fresh_network),source_network:counters(item.source_network_counts||item.source_network),source_decoded_bytes:number(item.source_decoded_bytes??item.source_resource_use?.decoded_bytes??sp?.source_decoded_bytes??item.decoded_bytes),fresh_decoded_bytes:number(item.fresh_decoded_bytes??item.resource_use?.decoded_bytes)};
  out.url_complete=!flags.includes('url');
  if(item.error){const error=typeof item.error==='object'?item.error:item.error_detail||{code:'acquisition_failed',message:item.error};out.error={code:text(error.code,80,'error.code'),message:text(error.message,120,'error.message')};}
  if(item.data_quality)out.data_quality={useful_data:!!item.data_quality.useful_data};
  const images=item.images||[];const verified=images.filter(x=>x.verification==='verified_media_bytes'&&x.media?.sha256);const relevant=verified.length?verified:item.post?images:[],selected=relevant.slice(0,scale===1?2:1);if(images.length>relevant.length)out.unverified_images_omitted=images.length-relevant.length;
  if(selected.length){out.images=selected.map((x,i)=>{const m=x.media,o={verification:x.verification,post_photo_verified:!!x.post_photo_verified};url(o,m?.url||x.url,m?4096:240,'images.'+i);if(m)Object.assign(o,{mime:clip(m.mime,48,'media.mime'),bytes:number(m.bytes),magic_hex:clip(m.magic_hex,64,'media.magic'),sha256:fullHash(m.sha256),hash_scope:clip(m.hash_scope,64,'media.hash_scope')});return o;});out.image_count=relevant.length;if(selected.length<relevant.length)flags.push('images.count');}
  if(item.post)out.post={platform:clip(item.post.platform,32,'post.platform'),canonical_url:text(item.post.canonical_url,120,'post.canonical_url'),caption:text(item.post.caption,80,'post.caption')};
  if(item.event){const e=item.event,all=e.sessions||[],matches=all.filter(x=>x.target_date_match===true),selected=(e.target_date?matches:all).slice(0,scale===1?2:1);out.event={title:text(e.event?.title,80,'event.title'),target_date:clip(e.target_date,10,'event.target_date'),timezone:clip(e.timezone,32,'event.timezone'),schedule_confirmed:!!e.schedule_confirmed,target_session_match:!!e.target_session_match,total_sessions:number(e.total_sessions??all.length),target_match_count:matches.length,inventory_count:null,inventory_basis:'Reported status; seat inventory unknown',sessions:selected.map((x,i)=>({id:clip(x.id,64,'session.id'),local_date:clip(x.local_date,10,'session.local_date'),local_time:clip(x.local_time,8,'session.local_time'),timezone:clip(x.timezone,32,'session.timezone'),raw_date:text(x.raw?.date,32,'sessions.'+i+'.raw_date'),raw_time:text(x.raw?.time,16,'sessions.'+i+'.raw_time'),venue:text(x.venue,64,'sessions.'+i+'.venue'),reported_availability:text(x.reported_availability,48,'sessions.'+i+'.status'),cancelled:typeof x.cancelled==='boolean'?x.cancelled:null,inventory_count:typeof x.inventory_count==='number'?number(x.inventory_count):null,ambiguity:text(x.ambiguity,64,'sessions.'+i+'.ambiguity')})),normalization_basis:'Local labels + event year; no Z shift',sources:(e.sources||[]).slice(0,2).map((x,i)=>{const o={method:clip(x.method,8,'source.method'),retrievedAt:clip(x.retrievedAt,32,'source.retrievedAt'),sha256:fullHash(x.sha256),hash_scope:clip(x.hash_scope,80,'source.hash_scope'),bytes:number(x.bytes)};url(o,x.url,4096,'event.sources.'+i);return o;}),failure:text(e.failure,100,'event.failure')};if(selected.length<(e.target_date?matches.length:all.length))flags.push('event.sessions.count');if(all.length>selected.length)out.event.non_target_sessions_omitted=all.length-selected.length;if(e.partial)flags.push('event.source_partial');if((e.sources||[]).length>2)flags.push('event.sources.count');}
  if(item.products){out.catalog={total_returned_rows:item.products.length,source_partial:!!item.partial,rows:item.products.slice(0,2).map((x,i)=>{const o={name:text(x.name,96,'catalog.'+i+'.name'),price:text(x.price,48,'catalog.'+i+'.price'),currency:x.price?.match(/\b(?:NZD|AUD|USD|EUR|GBP|CAD|JPY)\b/)?.[0]||null};url(o,x.url,2048,'catalog.'+i);return o;})};if(item.products.length>2)flags.push('catalog.rows.count');}
  if(item.article){const a=item.article;out.article={title:text(a.title,120,'article.title'),author:text(a.author,80,'article.author'),date:text(a.date,48,'article.date'),paragraph_count:number(a.paragraphs?.length??a.paragraph_count),body_omitted:true};}
  if(!item.article&&!item.products&&!item.event&&!item.post||item.requested_preset==='auto'&&item.article){const links=[...(item.links||[])];for(const match of (item.markdown||'').matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)){try{const href=publicURL(match[1]);if(!links.some(x=>x.url===href))links.push({url:href});}catch{}}out.document={text:text(item.markdown||item.text||item.notice||'',240,'document.text'),links:links.slice(0,2).map((x,i)=>{const o={};url(o,x.url,160,'document.links.'+i);return o;})};if(links.length>2)flags.push('document.links.count');}
  if(item.partial)flags.push('source.partial');out.semantic_truncation=[...new Set(flags)];out.semantic_partial=flags.length>0||!!item.partial;out.output_partial=out.semantic_partial;out.url_truncated=!out.url_complete;
  if(out.status==='PASS'&&(out.semantic_partial||item.data_quality?.useful_data===false))out.status='PARTIAL';
  return out;
}
const profiles=[1,0.7,0.45,0.25,0.1,0.03];
export function allocateEvidence(items,base={}, {limit=24000,measure=utf8Bytes}={}){
 const candidates=items.map(item=>profiles.map(scale=>{try{return compactEvidence(item,{scaleOnly:scale});}catch(e){return {index:item.index,status:'PARTIAL',source_status:item.status,error:{code:'evidence_projection',message:'Typed evidence projection failed for this item'},source_complete:false,sha256:null,hash_scope:null,fetchedAt:null,cache:null,fresh_network:counters(item.fresh_network),source_network:counters(item.source_network_counts),duration_ms:number(item.duration_ms),semantic_partial:true,output_partial:true,semantic_truncation:['projection_failure']};}}));const positions=items.map(()=>profiles.length-1);
 const assemble=()=>{const projected=candidates.map((xs,i)=>xs[positions[i]]);return {...base,status:projected.every(x=>x.status==='PASS'&&!x.semantic_partial)?'PASS':projected.some(x=>['PASS','PARTIAL'].includes(x.status))?'PARTIAL':'FAIL',items:projected};};
 let output=assemble();
 // Reserve every minimum typed ledger before distributing spare capacity.
 // Verified media / official target sessions get priority over boilerplate.
 const priority=items.map((x,i)=>({i,rank:x.event?0:Array.isArray(x.images)&&x.images.some(y=>y.verification==='verified_media_bytes')?1:x.products?2:x.article?3:4})).sort((a,b)=>a.rank-b.rank||a.i-b.i);
 for(const {i} of priority){for(let position=0;position<profiles.length-1;position++){const old=positions[i];positions[i]=position;const upgraded=assemble();if(measure(upgraded)<=limit){output=upgraded;break;}positions[i]=old;}}
 // Finite emergency ledgers: never raise a batch-wide allocation exception.
 for(let n=0;measure(output)>limit&&n<items.length;n++){
  let i=-1;for(let j=0;j<output.items.length;j++)if(output.items[j].error?.code!=='evidence_budget'&&(i<0||utf8Bytes(output.items[j])>utf8Bytes(output.items[i])))i=j;if(i<0)break;
  const x=output.items[i];output.items[i]={index:x.index,status:['FAIL','BLOCKED'].includes(x.status)?x.status:'PARTIAL',source_status:x.source_status,error:{code:'evidence_budget',message:'Requested proof cannot fit response budget; retained core only'},source_complete:x.source_complete,sha256:x.sha256,hash_scope:x.hash_scope,fetchedAt:x.fetchedAt,cache:x.cache,fresh_network:x.fresh_network,source_network:x.source_network,duration_ms:x.duration_ms,source_duration_ms:x.source_duration_ms,source_decoded_bytes:x.source_decoded_bytes,fresh_decoded_bytes:x.fresh_decoded_bytes,url:x.url,url_complete:x.url_complete,semantic_partial:true,output_partial:true,semantic_truncation:['response_budget'],...(x.event?{event:{target_date:x.event.target_date,timezone:x.event.timezone,sessions:x.event.sessions,sources:x.event.sources.map(y=>({sha256:y.sha256,retrievedAt:y.retrievedAt,method:y.method,url:y.url,url_complete:y.url_complete})),inventory_count:null}}:{}),...(x.images?{images:x.images.slice(0,1)}:{}),...(x.catalog?{catalog:x.catalog}:{}),...(x.article?{article:x.article}:{})};output.status='PARTIAL';
 }
 for(let i=0;measure(output)>limit&&i<output.items.length;i++){
  const x=output.items[i];output.items[i]={index:x.index,status:['FAIL','BLOCKED'].includes(x.status)?x.status:'PARTIAL',error:{code:'evidence_budget',message:'Requested evidence exceeds remaining envelope budget'},source_complete:x.source_complete,sha256:x.sha256,hash_scope:x.hash_scope,fetchedAt:x.fetchedAt,cache:x.cache,fresh_network:x.fresh_network,source_network:x.source_network,duration_ms:x.duration_ms,source_duration_ms:x.source_duration_ms,source_decoded_bytes:x.source_decoded_bytes,fresh_decoded_bytes:x.fresh_decoded_bytes,semantic_partial:true,output_partial:true,semantic_truncation:['core_proof_omitted_response_budget'],...(x.event?{event:{target_date:x.event.target_date,timezone:x.event.timezone,sessions:x.event.sessions,inventory_count:null}}:{}),...(x.images?{images:x.images.slice(0,1)}:{})};output.status='PARTIAL';
 }
 // Last finite ledger floor (e.g. huge legal JSON-RPC IDs). Requested core
 // omission is visible on that item; no false PASS and no batch exception.
 for(let i=0;measure(output)>limit&&i<output.items.length;i++){
  const x=output.items[i];output.items[i]={index:x.index,status:['FAIL','BLOCKED'].includes(x.status)?x.status:'PARTIAL',error:{code:'evidence_budget',message:'Core semantic proof omitted: response envelope budget'},source_complete:x.source_complete,sha256:x.sha256,hash_scope:x.hash_scope,fetchedAt:x.fetchedAt,cache:x.cache,fresh_network:x.fresh_network,source_network:x.source_network,duration_ms:x.duration_ms,source_duration_ms:x.source_duration_ms,source_decoded_bytes:x.source_decoded_bytes,fresh_decoded_bytes:x.fresh_decoded_bytes,semantic_partial:true,output_partial:true,semantic_truncation:['core_proof_omitted_response_budget']};output.status='PARTIAL';
 }
 for(let i=0;i<output.items.length;i++){
  const x=output.items[i],original=items[i]?.error;
  if(['FAIL','BLOCKED'].includes(x.status)&&x.error?.code==='evidence_budget'&&original){const e=typeof original==='object'?original:{code:'acquisition_failed'};x.error={code:String(e.code||'acquisition_failed').slice(0,40),message:'Error text budgeted'};}
 }
 // Larger supported batches may exhaust even the former ten-item floor.
 // Retain order, terminal error codes, source hashes/timestamps, cache and
 // fresh/source counters; shorten only the already-budgeted diagnostics.
 for(let i=0;measure(output)>limit&&i<output.items.length;i++){
  const x=output.items[i],original=items[i]?.error;
  if(['FAIL','BLOCKED'].includes(x.status)&&original){const e=typeof original==='object'?original:{code:'acquisition_failed'};x.error={code:e.code||'acquisition_failed',message:'Error text budgeted'};}
  else x.error={code:'evidence_budget',message:'Output budget'};
  x.semantic_partial=true;x.output_partial=true;output.status='PARTIAL';
 }
 for(let i=0;measure(output)>limit&&i<output.items.length;i++){
  const x=output.items[i];delete x.source_decoded_bytes;delete x.fresh_decoded_bytes;
  x.semantic_truncation=[...(x.semantic_truncation||[]),'byte_accounting'];
  x.semantic_partial=true;x.output_partial=true;output.status='PARTIAL';
 }
 for(let i=0;measure(output)>limit&&i<output.items.length;i++){
  const x=output.items[i];if(x.cache)x.cache={hit:!!x.cache.hit,coalesced:!!x.cache.coalesced,source_build:x.cache.source_build,...(x.cache.age_ms!==undefined?{age_ms:x.cache.age_ms}:{})};
  x.semantic_truncation=[...(x.semantic_truncation||[]),'cache_metadata'];
 }
 if(measure(output)>limit){const builds=output.items.map(x=>x.cache?.source_build).filter(Boolean);if(builds.length&&builds.every(x=>x===builds[0]))output.cache_source_build=builds[0];}
 // Bounded32-item last resort. Preserve basic proof/counters and error codes;
 // extended fields are explicitly omitted, never silently labeled PASS.
 for(let i=0;measure(output)>limit&&i<output.items.length;i++){
  const x=output.items[i];output.items[i]={index:x.index,status:['FAIL','BLOCKED'].includes(x.status)?x.status:'PARTIAL',error:{code:x.error?.code||'evidence_budget',message:'Output budget'},source_complete:x.source_complete,sha256:x.sha256,hash_scope:x.hash_scope,fetchedAt:x.fetchedAt,cache:x.cache&&output.cache_source_build===x.cache.source_build?{hit:x.cache.hit,coalesced:x.cache.coalesced,source_build_ref:'cache_source_build'}:x.cache,fresh_network:x.fresh_network,source_network:x.source_network,duration_ms:x.duration_ms,semantic_partial:true,output_partial:true,semantic_truncation:['extended_ledger_omitted']};output.status='PARTIAL';
 }
 return output;
}
