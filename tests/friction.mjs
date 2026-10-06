import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {trawlScrape,trawlScrapeBatch,trawlState,resetTrawlState,TRAWL_LIMITS} from '../src/trawl-adapter.mjs';
import {extractReadable,detectAppShell} from '../src/readability.mjs';

let passed=0,failed=0;
const t=(name,fn)=>{try{fn();passed++;console.log('PASS',name)}catch(e){failed++;console.log('FAIL',name,String(e.message).slice(0,220))}};
const tasync=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name)}catch(e){failed++;console.log('FAIL',name,String(e.message).slice(0,220))}};

// ---------- readability extraction ----------
t('extractReadable strips scripts/styles and keeps text',()=>{
  const html='<html><head><title>Test Page</title><style>.x{color:red}</style></head><body><script>var a=1;</script><h1>Hello</h1><p>World of words here.</p><ul><li>one</li><li>two</li></ul><a href="https://ex.com/x">link text</a></body></html>';
  const r=extractReadable(html);
  assert.equal(r.title,'Test Page');
  assert.match(r.text,/Hello/);assert.match(r.text,/World of words here\./);
  assert.match(r.text,/^- one$/m);assert.match(r.text,/^\s*- two$/m);
  assert.doesNotMatch(r.text,/var a=1|color:red/);
  assert.equal(r.links.length,1);assert.equal(r.links[0].href,'https://ex.com/x');assert.equal(r.links[0].text,'link text');
  assert.equal(r.text_truncated,false);
});
t('extractReadable truncates at maxText',()=>{
  const html='<p>'+'word '.repeat(50000)+'</p>';
  const r=extractReadable(html,{maxText:1000});
  assert.equal(r.text.length,1000);assert.equal(r.text_truncated,true);
});
t('extractReadable decodes entities',()=>{
  const r=extractReadable('<p>A &amp; B &lt;tag&gt; &quot;q&quot;</p>');
  assert.match(r.text,/A & B <tag> "q"/);
});
t('detectAppShell flags SPA mounts and login screens',()=>{
  const shell='<html><body><app-root></app-root><script src="main.js"></script></body></html>';
  const r=detectAppShell(shell);
  assert(r.includes('spa_mount_node'),JSON.stringify(r));
  const login='<html><body><p>Login With Password</p><form></form></body></html>';
  assert(detectAppShell(login).includes('login_screen_text'));
  const real='<html><body><p>'+'Real substantial content here. '.repeat(50)+'</p></body></html>';
  assert.deepEqual(detectAppShell(real),[]);
});

// ---------- TRAWL fixture with timing/batch support ----------
const FIX={mode:'ok',delay:0,failIds:new Set(),lastPaths:[]};
const server=createServer((req,res)=>{
  FIX.lastPaths.push(req.url);
  if(req.url==='/health'){res.end(JSON.stringify({status:'ok'}));return;}
  if(req.url==='/v1'&&req.method==='POST'){
    let b='';req.on('data',d=>b+=d);req.on('end',()=>{
      const parsed=JSON.parse(b);
      const id=(typeof parsed.url==='string'?(parsed.url.match(/id(\d+)/)||[])[1]:undefined);
      setTimeout(()=>{
        if(FIX.mode==='error'||(id&&FIX.failIds.has(id))){
          res.end(JSON.stringify({status:'error',message:'simulated failure'}));return;
        }
        res.end(JSON.stringify({status:'ok',message:'',startTimestamp:Date.now()-10,endTimestamp:Date.now(),
          solution:{url:parsed.url,status:200,headers:{},response:(typeof parsed.url==='string'&&parsed.url.includes('/big'))?'<html><head><title>Big</title></head><body><p>'+'x'.repeat(60000)+'</p></body></html>':'<html><head><title>Doc '+id+'</title></head><body><p>content for '+parsed.url+'</p></body></html>',cookies:[]}}));
      },FIX.delay);
    });return;
  }
  res.statusCode=404;res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const cfg=()=>({url:'http://127.0.0.1:'+server.address().port,token:'tk'});

// ---------- readability through trawlScrape ----------
await tasync('trawlScrape returns extracted text/title/links',async()=>{
  resetTrawlState();FIX.mode='ok';
  const r=await trawlScrape('https://example.com/id42',{},cfg());
  assert.equal(r.ok,true);
  assert.equal(r.title,'Doc 42');
  assert.match(r.text,/content for https:\/\/example\.com\/id42/);
  assert.equal(r.via,'trawl');
});

// ---------- circuit breaker ----------
let hangServer;
{
  const {createServer}=await import('node:http');
  hangServer=createServer(()=>{}); // accepts, never responds → probe deadline
  await new Promise(r=>hangServer.listen(0,'127.0.0.1',r));
}
const hangCfg=()=>({url:'http://127.0.0.1:'+hangServer.address().port,token:null});
await tasync('circuit breaker: timeouts widen cooldown exponentially',async()=>{
  resetTrawlState();
  // three consecutive probe timeouts (deadline aborts) — each ~8s probe deadline
  // cooldown:0 disables the cached-cooldown short-circuit so each iteration
  // actually probes (and times out) — counting consecutive real timeouts.
  for(let i=0;i<3;i++){await trawlScrape('https://example.com',{},hangCfg(),{cooldown:0}).catch(()=>{});}
  const s=trawlState();
  assert.equal(s.consecutiveTimeouts,3,'expected 3 recorded timeouts, got '+JSON.stringify(s));
  // 4th timeout → cooldown widens: circuitCooldownUntil - checkedAt >= 120s
  await trawlScrape('https://example.com',{},hangCfg(),{cooldown:0}).catch(()=>{});
  const s4=trawlState();
  assert.equal(s4.consecutiveTimeouts,4);
  const widened=s4.circuitCooldownUntil-s4.checkedAt;
  assert(widened>=119000,'cooldown should widen to ~120s, got '+widened);
});
await tasync('circuit breaker: healthy response clears timeout streak',async()=>{
  const ok=await trawlScrape('https://example.com/id7',{},cfg(),{cooldown:0});

  assert.equal(ok.ok,true);
  const after=trawlState();
  assert.equal(after.consecutiveTimeouts,0);
  assert.equal(after.circuitCooldownUntil,0);
});


await tasync('solve error does NOT trip availability cooldown (target failure != endpoint failure)',async()=>{
  resetTrawlState();FIX.mode='error';
  const r1=await trawlScrape('https://example.com/bad1',{},cfg());
  assert.equal(r1.ok,false);assert.match(r1.reason,/trawl_error/);
  const st=trawlState();
  assert.equal(st.available,true,'probe marked endpoint healthy; solve error must not flip availability');
  assert.equal(st.circuitCooldownUntil,0,'solve error must not arm the circuit breaker');
  // next call to a good URL should reach TRAWL normally (no cooldown)
  FIX.mode='ok';
  const r2=await trawlScrape('https://example.com/good',{},cfg(),{cooldown:0});
  assert.equal(r2.ok,true,'healthy endpoint must serve immediately after a solve error');
});

// ---------- parallel batch ----------
await tasync('batch: 5 urls scraped concurrently with isolated results',async()=>{
  resetTrawlState();FIX.mode='ok';FIX.delay=30;
  const urls=[1,2,3,4,5].map(n=>'https://example.com/page?id'+n);
  const r=await trawlScrapeBatch(urls,{},cfg());
  assert.equal(r.batch,true);assert.equal(r.total,5);assert.equal(r.ok_count,5);
  assert.equal(r.results.length,5);
  assert.match(r.results[2].text,/content for https:\/\/example\.com\/page\?id3/);assert.equal(r.results[2].text.length<=1500,true);
  assert.equal(r.via,'trawl');
  FIX.delay=0;
});
await tasync('batch: per-item failure isolated (others succeed)',async()=>{
  resetTrawlState();FIX.mode='ok';FIX.failIds=new Set(['2','4']);
  const urls=[1,2,3,4,5].map(n=>'https://example.com/page?id'+n);
  const r=await trawlScrapeBatch(urls,{},cfg());
  assert.equal(r.ok_count,3);assert.equal(r.fallback_count,2);
  assert.equal(r.results[1].ok,false);assert.match(r.results[1].reason,/trawl_error/);
  assert.equal(r.results[0].ok,true);
  FIX.failIds=new Set();
});
await tasync('batch: rejects >10 urls and <2 urls',async()=>{
  const r1=await trawlScrapeBatch(Array.from({length:11},(_,i)=>'https://example.com/'+i),{},cfg());
  assert.match(r1.reason,/batch_too_large/);
  const r2=await trawlScrapeBatch(['https://example.com/one'],{},cfg());
  assert.equal(r2.total,1); // single url allowed through (schema enforces 2-10 at MCP layer)
});
await tasync('batch: unconfigured endpoint falls back cleanly',async()=>{
  resetTrawlState();
  const r=await trawlScrapeBatch(['https://a.com/','https://b.com/'],{},{url:null,token:null});
  assert.equal(r.fallback,true);assert.equal(r.reason,'trawl_not_configured');
});
await tasync('batch: dead endpoint returns fallback with probe',async()=>{
  resetTrawlState();
  const r=await trawlScrapeBatch(['https://a.com/','https://b.com/'],{},{url:'http://127.0.0.1:1',token:null},{cooldown:1});
  assert.equal(r.fallback,true);assert.match(r.reason,/trawl_unavailable/);
});
await tasync('batch concurrency bounded (4 in flight, not 10)',async()=>{
  resetTrawlState();FIX.delay=80;
  let inFlight=0,peak=0;
  // wrap fetch to count
  const wrapped=async(url,init)=>{
    inFlight++;peak=Math.max(peak,inFlight);
    try{return await fetch(url,init);}finally{inFlight--;}
  };
  const urls=Array.from({length:8},(_,i)=>'https://example.com/b'+i);
  await trawlScrapeBatch(urls,{},cfg(),{fetchImpl:wrapped});
  assert(peak<=TRAWL_LIMITS.batch_concurrency+1,'peak '+peak+' should be ~'+TRAWL_LIMITS.batch_concurrency);
  FIX.delay=0;
});


await tasync('HTTP 4xx from TRAWL does not arm breaker; next URL reaches TRAWL',async()=>{
  resetTrawlState();
  // fixture: /v1 returns 500 for url containing bad5xx, 200 otherwise; simulate 4xx by custom fetch wrapper
  let mode4xx=false;
  const wrapped=async(url,init)=>{
    if(mode4xx&&String(url).endsWith('/v1'))return new Response('server rejected', {status:400});
    return fetch(url,init);
  };
  mode4xx=true;
  const r1=await trawlScrape('https://example.com/x',{},cfg(),{fetchImpl:wrapped,cooldown:0});
  assert.equal(r1.ok,false);assert.match(r1.reason,/trawl_request_failed:trawl_http_400/);
  const st=trawlState();
  assert.equal(st.available,true,'4xx must not flip availability');
  mode4xx=false;
  const r2=await trawlScrape('https://example.com/next',{},cfg(),{fetchImpl:wrapped,cooldown:0});
  assert.equal(r2.ok,true,'next scrape must reach TRAWL after a 4xx');
});


await tasync('plain-HTTP targets route to fallback immediately (no TRAWL hang)',async()=>{
  resetTrawlState();
  const started=Date.now();
  const r=await trawlScrape('http://neverssl.com/',{},cfg());
  const elapsed=Date.now()-started;
  assert.equal(r.ok,false);assert.equal(r.fallback,true);
  assert.match(r.reason,/plain_http_target/);
  assert(elapsed<2000,'plain-http fallback must be instant, took '+elapsed+'ms');
});
await tasync('scrape text capped at 22000 (envelope-safe)',async()=>{
  resetTrawlState();
  // fixture returns a big page
  const orig=FIX.mode;FIX.mode='ok';
  const r=await trawlScrape('https://example.com/big',{},cfg());
  assert.equal(r.ok,true);
  assert(r.text.length<=22000,'text length '+r.text.length+' exceeds 22000 cap');
  assert.equal(r.text_truncated,true);
});

// ---------- MCP-level ----------
import {build} from 'esbuild';
await build({entryPoints:[new URL('./friction-mcp-entry.mjs',import.meta.url).pathname],bundle:true,platform:'browser',format:'esm',loader:{'.txt':'text','.wasm':'file'},outfile:'tests/.friction-mcp-bundle.mjs',logLevel:'silent'});
const {mcp,TOOLS}=await import('./.friction-mcp-bundle.mjs');
const {OWNER_EMAIL,ORIGIN}=await import('../src/config.mjs');
const call=async(name,arguments_,env={})=>{
  const request=new Request(ORIGIN+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','oai-authenticated-user-id':'t','oai-authenticated-user-email':OWNER_EMAIL},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:arguments_}}),signal:AbortSignal.timeout(280000)});
  const res=await mcp(request,env);return {status:res.status,data:await res.json()};
};
await tasync('tools/list has 16 tools incl browser_scrape_batch',async()=>{
  const request=new Request(ORIGIN+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','oai-authenticated-user-id':'t','oai-authenticated-user-email':OWNER_EMAIL},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
  const res=await mcp(request,{});const data=await res.json();
  const names=data.result.tools.map(x=>x.name);
  assert.equal(names.length,16);
  assert(names.includes('browser_scrape_batch'));
});
await tasync('MCP batch scrape end-to-end via fixture',async()=>{
  resetTrawlState();FIX.mode='ok';
  const r=await call('browser_scrape_batch',{urls:[{url:'https://example.com/a'},{url:'https://example.com/b'}]},{TRAWL_URL:'http://127.0.0.1:'+server.address().port,TRAWL_TOKEN:'tk'});
  const out=r.data.result.structuredContent;
  assert.equal(out.route,'trawl',JSON.stringify(out).slice(0,200));
  assert.equal(out.ok_count,2);
  assert(out.results.every(x=>x.text&&x.text.includes('content for')));
});
await tasync('MCP batch validation rejects 1 url',async()=>{
  const r=await call('browser_scrape_batch',{urls:[{url:'https://example.com/'}]});
  assert.equal(r.data.error.code,-32602);
});
await tasync('MCP batch fallback without TRAWL_URL',async()=>{
  const r=await call('browser_scrape_batch',{urls:[{url:'https://a.com/'},{url:'https://b.com/'}]});
  const out=r.data.result.structuredContent;
  assert.equal(out.route,'fallback');assert.equal(out.fallback_reason,'trawl_not_configured');
});

server.close();
console.log(JSON.stringify({passed,failed}));
process.exit(failed?1:0);
