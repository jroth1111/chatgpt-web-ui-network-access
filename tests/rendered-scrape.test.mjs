import test from 'node:test';
import assert from 'node:assert/strict';
import {trawlScrape,trawlState,resetTrawlState} from '../src/trawl-adapter.mjs';
const config={url:'https://scraper.example.invalid',token:'synthetic-token'};
const healthy=()=>Response.json({status:'ok'});
const html='<title>Rendered fixture</title>'+Array.from({length:10},(_,i)=>`<div class="quote"><span class="text">Rendered text ${i}</span></div>`).join('');
test('render-only uses native skipHttp and validates a selector in actual returned HTML',async()=>{
 resetTrawlState();let request;
 const result=await trawlScrape('https://example.com/js',{render:true,ready_selector:'.quote',session:'bounded-session'},config,{fetchImpl:async(url,init)=>{
  if(String(url).endsWith('/health'))return healthy();request={url:String(url),body:JSON.parse(init.body)};
  return Response.json({url:'https://example.com/js',html,statusCode:200,tier:2,sessionCached:false,timings:[{tier:1,status:'skipped',durationMs:0},{tier:2,status:'success',durationMs:10}],totalMs:10});
 }});
 assert.equal(request.url,config.url+'/scrape');assert.equal(request.body.skipHttp,true);assert.equal(request.body.contentWaitForSelector,'.quote');assert.equal(request.body.sessionId,'bounded-session');
 assert.equal(result.ok,true);assert.equal(result.render_evidence.browser_execution_reported,true);assert.equal(result.render_evidence.ready_selector_matches,10);assert(result.text.includes('Rendered text 9'));
});
for(const result of [{html,statusCode:200,tier:1},{html:'<title>Shell</title>',statusCode:200,tier:2},{statusCode:200,tier:2}])test('render-only cannot accept HTTP-tier, missing selector or missing HTML',async()=>{
 resetTrawlState();const out=await trawlScrape('https://example.com/js',{render:true,ready_selector:'.quote'},config,{fetchImpl:async url=>String(url).endsWith('/health')?healthy():Response.json(result)});
 assert.equal(out.ok,false);assert.match(out.reason,/render_|envelope_invalid/);assert.equal(trawlState().available,true,'a responding unsupported endpoint is not a transport outage');
});
test('legacy v1 remains compatible and does not claim browser execution from an HTTP-shaped response',async()=>{
 resetTrawlState();let path;
 const out=await trawlScrape('https://example.com/',{},config,{fetchImpl:async url=>{if(String(url).endsWith('/health'))return healthy();path=String(url);return Response.json({status:'ok',solution:{status:200,response:html,url:'https://example.com/'}});}});
 assert.equal(path,config.url+'/v1');assert.equal(out.ok,true);assert.equal(out.render_evidence.browser_execution_reported,null);
});
test('explicit curl target-resolution errors do not poison health; proxy-resolution errors remain service failures',async()=>{
 for(const host of ['missing.invalid','private-proxy.invalid']){
  resetTrawlState();const out=await trawlScrape('https://missing.invalid/',{},config,{fetchImpl:async url=>String(url).endsWith('/health')?healthy():Response.json({status:'error',message:`curl: (6) Could not resolve host: ${host}`},{status:500})});
  assert.equal(out.ok,false);assert.equal(trawlState().available,host==='missing.invalid');assert.doesNotMatch(JSON.stringify(out),/private-proxy/);
 }
});
