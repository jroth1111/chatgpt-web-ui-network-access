import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
test('isolated workerd: two independent Workers share persistent D1 outage and incident data',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));
 const source=`import {trawlScrape} from './src/trawl-adapter.mjs';import {UpstreamStateStore} from './src/upstream-state.mjs';
 const endpoint='https://operator.example.invalid';
 export default {async fetch(request,env){const store=new UpstreamStateStore(env.UPSTREAM_STATE,endpoint);if(new URL(request.url).pathname==='/outage'){const r=await trawlScrape('https://public.example.invalid/',{},{url:endpoint,stateDb:env.UPSTREAM_STATE,requireDurable:true},{fetchImpl:async p=>String(p).endsWith('/health')?Response.json({status:'ok'}):new Response('Synthetic upstream outage',{status:503})});return Response.json(r);}return Response.json({state:await store.read(),incidents:await store.incidents()});}};`;
 const bundle=await build({stdin:{contents:source,resolveDir:root},bundle:true,platform:'browser',conditions:['workerd'],format:'esm',write:false,logLevel:'silent'}),contents=bundle.outputFiles[0].text;
 const worker=name=>({name,modules:[{type:'ESModule',path:'worker.mjs',contents}],compatibilityDate:'2026-07-30',d1Databases:{UPSTREAM_STATE:'synthetic-shared-upstream'}});
 const mf=new Miniflare({cf:false,workers:[worker('one'),worker('two')]});try{
  const db=await mf.getD1Database('UPSTREAM_STATE','one'),sql=(await readFile(new URL('../drizzle/0000_upstream_recovery.sql',import.meta.url),'utf8')).replace(/--[^\n]*/g,'').replace(/\n/g,' ');await db.exec(sql);
  const first=await (await (await mf.getWorker('one')).fetch('https://fixture.example/outage')).json();assert.equal(first.ok,false);assert.equal(first.upstream_state.durability,'D1');
  const second=await (await (await mf.getWorker('two')).fetch('https://fixture.example/state')).json();assert.equal(second.state.available,false);assert.equal(second.state.lifetimeFailures,1);assert.equal(second.incidents[0].occurrences,1);assert.equal(second.incidents[0].http_status,503);
  assert.doesNotMatch(JSON.stringify(second),/operator\.example|public\.example|probe_token/);
 }finally{await mf.dispose();}
});
