import {MERGE_LIMITS} from './merge-profile.mjs';
import {parseHTML} from 'linkedom';
// Inspect bounded access-control surfaces, never keywords anywhere or URL paths.
const gate=/^(?:robot or human\??|access denied|blocked request|just a moment(?:\.\.\.)?|verify (?:that )?you are (?:a )?human|(?:sign|log) in(?: (?:required|to continue))?|login|captcha(?: verification)? required|authentication required)$/i;
export function accessSurface({mime,text='',json,headers}){
 if(headers.get('cf-mitigated')?.toLowerCase()==='challenge'||headers.get('x-captcha-required')?.toLowerCase()==='true')return {blocked:true,basis:'explicit challenge response header'};
 if(mime.includes('json')&&json&&typeof json==='object'&&!Array.isArray(json)){
  const keys=['challenge_required','captcha_required','authentication_required','login_required','blocked','access_denied'];
  if(keys.some(k=>json[k]===true)||['challenge','captcha_required','access_denied','authentication_required','login_required','blocked'].includes(String(json.status||'').toLowerCase()))return {blocked:true,basis:'explicit structured access gate'};
  const err=json.error,code=typeof err==='string'?err:err&&typeof err==='object'?err.code:null;
  if(/^(captcha_required|challenge_required|access_denied|authentication_required|login_required|blocked)$/i.test(code||''))return {blocked:true,basis:'explicit structured gate error'};
  if(Object.hasOwn(json,'error')&&Object.keys(json).every(k=>['error','message','status','code','success'].includes(k)))return {partial:true,basis:'opaque structured error; useful public data unconfirmed'};
  return {blocked:false,basis:'JSON data; descriptive keywords and pathname are not gate evidence'};
 }
 const bounded=text.slice(0,65536);
 if(mime.includes('html')){
  const title=(bounded.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'').replace(/<[^>]*>/g,'').trim();
  const heading=(bounded.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]||'').replace(/<[^>]*>/g,'').trim();
  if(gate.test(title)||gate.test(heading))return {blocked:true,classification:/sign|log|authentication/i.test(title+' '+heading)?'auth_required':'challenge',basis:'primary title/heading access gate'};
  const {document}=parseHTML(bounded);
  const passwordForm=[...document.querySelectorAll('form')].some(f=>[...f.querySelectorAll('input')].some(i=>(i.getAttribute('type')||'').toLowerCase()==='password'));
  const challengeForm=[...document.querySelectorAll('form')].some(f=>/captcha|challenge/i.test((f.getAttribute('action')||'')+' '+(f.id||''))&&f.querySelector('input'));
  if(passwordForm||challengeForm){
   // Tags alone are not evidence. Only bounded visible-structural content outside forms/boilerplate qualifies.
   for(const e of document.querySelectorAll('form,header,nav,footer,script,style,noscript,template,[hidden],[aria-hidden="true"]'))e.remove();
   let chars=0,substantive=false,nodes=0;
   for(const e of document.querySelectorAll('p,[itemprop="description"]')){
    if(++nodes>128)break;const value=e.textContent.replace(/\s+/g,' ').trim().slice(0,2048);
    if(/^(?:please )?(?:sign|log) in\b|^enter (?:your )?password\b/i.test(value))continue;
    chars+=value.length;if(value.length>=120)substantive=true;
   }
   if(!substantive){const type=passwordForm?'auth_required':'challenge';return chars>0?{partial:true,classification:'unconfirmed_public_content',basis:'Control form present; outside-form public content is insufficient'}:{blocked:true,classification:type,basis:'Control form without substantive public content outside forms'};}
  }
  return {blocked:false,basis:'HTML public content; optional login and descriptive keywords are not gates'};
 }
 return {blocked:bounded.trim().length<=1024&&gate.test(bounded.trim()),basis:'short primary plain-text gate surface'};
}
export function remainingFreshness(headers,now=Date.now()){
 const cap=MERGE_LIMITS.cache_ttl_ms,raw=headers.get('cache-control')||'',directives=new Map();
 for(const part of (raw?raw.split(','):[])){const m=part.trim().match(/^([a-z][a-z-]*)(?:\s*=\s*(?:"([^"]*)"|([^\s,]+)))?$/i);if(!m)return {eligible:false,ttl:0,basis:'invalid cache directive'};const key=m[1].toLowerCase();if(directives.has(key))return {eligible:false,ttl:0,basis:'duplicate cache directive'};directives.set(key,m[2]??m[3]??null);}
 if(['private','no-store','no-cache'].some(k=>directives.has(k)))return {eligible:false,ttl:0,basis:'cache directive forbids reuse'};
 const seconds=x=>/^\d+$/.test(x||'')&&Number.isSafeInteger(Number(x))?Number(x):null;
 const ageHeader=headers.get('age'),age=ageHeader===null?0:seconds(ageHeader);if(age===null)return {eligible:false,ttl:0,basis:'invalid Age'};
 const dateHeader=headers.get('date'),date=dateHeader===null?null:Date.parse(dateHeader);
 if(dateHeader!==null&&(!Number.isFinite(date)||date>now))return {eligible:false,ttl:0,basis:'invalid or future Date; age uncertain'};
 for(const k of ['s-maxage','max-age'])if(directives.has(k)&&seconds(directives.get(k))===null)return {eligible:false,ttl:0,basis:'invalid freshness directive'};
 const lifetime=directives.has('s-maxage')?seconds(directives.get('s-maxage')):directives.has('max-age')?seconds(directives.get('max-age')):null;
 const currentAge=Math.max(age*1000,date===null?0:now-date);
 // Without HTTP lifetime, use only the existing short ephemeral policy, reduced by observed age.
 const ttl=Math.max(0,Math.min(cap,(lifetime===null?cap:lifetime*1000)-currentAge));
 return {eligible:ttl>0,ttl,basis:lifetime===null?'ephemeral 15s policy minus observed age':'HTTP remaining shared freshness capped at 15s',current_age_ms:currentAge};
}
