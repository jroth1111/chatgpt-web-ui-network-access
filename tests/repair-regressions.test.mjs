import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {accessSurface} from '../src/response-quality.mjs';
import {probeTrawl,trawlScrape,trawlScrapeBatch,trawlState,resetTrawlState} from '../src/trawl-adapter.mjs';

const config={url:'https://scraper.example.invalid',token:'synthetic-fixture'};
const healthy=()=>Response.json({status:'ok'});
const page=()=>Response.json({status:'ok',solution:{status:200,url:'https://example.com/',response:'<title>Public page</title><p>Observed content.</p>'}});

test('probe replacement retains every breaker-state field',async()=>{
  resetTrawlState();
  await probeTrawl(config,{fetchImpl:async()=>new Response('',{status:503})});
  assert.equal(trawlState().consecutiveTimeouts,0);
  assert.equal(trawlState().circuitCooldownUntil,0);
});

test('a request 4xx cannot poison availability after the healthy probe TTL expires',async()=>{
  resetTrawlState();const original=Date.now;let now=original(),bad=true;
  Date.now=()=>now;
  try{
    const fetchImpl=async url=>String(url).endsWith('/health')?healthy():bad?new Response('',{status:400}):page();
    assert.equal((await trawlScrape('https://example.com/bad',{},config,{fetchImpl})).ok,false);
    now+=31000;bad=false;
    assert.equal((await trawlScrape('https://example.com/good',{},config,{fetchImpl})).ok,true);
  }finally{Date.now=original;}
});

test('explicit target DNS failure in a 500 solve envelope is isolated from endpoint health',async()=>{
  resetTrawlState();let bad=true;
  const fetchImpl=async url=>String(url).endsWith('/health')?healthy():bad?Response.json({status:'error',message:'Error: net::ERR_NAME_NOT_RESOLVED at https://missing.invalid/'},{status:500}):page();
  const failed=await trawlScrape('https://missing.invalid/',{},config,{fetchImpl});
  assert.equal(failed.ok,false);assert.equal(trawlState().available,true);
  bad=false;assert.equal((await trawlScrape('https://example.com/',{},config,{fetchImpl})).ok,true);
});

test('an opaque endpoint 500 still degrades endpoint availability',async()=>{
  resetTrawlState();
  await trawlScrape('https://example.com/',{},config,{fetchImpl:async url=>String(url).endsWith('/health')?healthy():new Response('service unavailable',{status:500})});
  assert.equal(trawlState().available,false);
});

for(const phase of ['health','solve'])test(`caller abort bounds a stalled ${phase} body even when transport ignores the signal`,async()=>{
  resetTrawlState();const abort=new AbortController();let bodyController;
  const stalled=()=>new Response(new ReadableStream({start(c){bodyController=c;}}));
  const fetchImpl=async url=>abort.signal.aborted?page():String(url).endsWith('/health')?(phase==='health'?stalled():healthy()):stalled();
  const work=trawlScrape('https://example.com/',{},config,{fetchImpl,signal:abort.signal});
  const timer=setTimeout(()=>abort.abort('synthetic caller cancellation'),10);
  let bounded;
  try{bounded=await Promise.race([work,new Promise(resolve=>setTimeout(()=>resolve(null),200))]);}
  finally{clearTimeout(timer);try{bodyController?.close();}catch{};await work;}
  assert.ok(bounded,'operation must release JS ownership without waiting for an unread body');
  assert.match(bounded.reason,/caller_abort/);
  assert.equal(trawlState().failures,0);
});

test('pre-aborted caller never reaches endpoint transport',async()=>{
  resetTrawlState();let calls=0;
  const out=await trawlScrape('https://example.com/',{},config,{signal:AbortSignal.abort(),fetchImpl:async()=>{calls++;return healthy();}});
  assert.equal(calls,0);assert.match(out.reason,/caller_abort/);
});

test('diagnostics cannot echo private configured origins or raw transport exception text',async()=>{
  resetTrawlState();
  const out=await trawlScrape('https://example.com/',{},config,{fetchImpl:async()=>{throw Error('private.operator.invalid credential-value-from-exception');}});
  assert.doesNotMatch(JSON.stringify(out),/private\.operator|credential-value/);
});

test('empty and invalid scrape batches return typed failures',async()=>{
  for(const input of [[],null,{}])assert.equal((await trawlScrapeBatch(input,{},config)).reason,'batch_empty');
});

test('complete-body hash uses actual UTF8 bytes, not truncated excerpts or JS character counts',async()=>{
 resetTrawlState();const html='<title>Unicode</title><p>☕ 😀 '+ 'x'.repeat(25000)+'</p>';
 const out=await trawlScrape('https://example.com/',{},config,{fetchImpl:async url=>String(url).endsWith('/health')?healthy():Response.json({status:'ok',solution:{status:200,url:'https://example.com/',response:html,headers:{'set-cookie':'synthetic-private-cookie',authorization:'synthetic-private-auth','content-type':'text/html'}}})});
 assert.equal(out.bytes,Buffer.byteLength(html));
 assert.equal(out.body_sha256,createHash('sha256').update(html).digest('hex'));
 assert.equal(out.headers['set-cookie'],undefined);assert.equal(out.headers.authorization,undefined);
 assert.equal(out.headers['content-type'],'text/html');assert.equal(out.text_truncated,true);
});

test('ordinary registry JSON mentioning CAPTCHA is public data, not a challenge',()=>{
 assert.equal(accessSurface({mime:'application/json',json:{name:'captcha',description:'A CAPTCHA software package'},text:'',headers:new Headers()}).blocked,false);
 assert.equal(accessSurface({mime:'application/json',json:{captcha_required:true},text:'',headers:new Headers()}).blocked,true);
});

test('a login form wrapped in main is not substantive public article content',()=>{
 const text='<main><h1>Account</h1><form><p>Sign in to continue</p><input type="password"></form></main>';
 assert.equal(accessSurface({mime:'text/html',text,headers:new Headers()}).blocked,true);
});
