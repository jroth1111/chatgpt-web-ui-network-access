import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {trawlScrape} from '../src/trawl-adapter.mjs';
import {UpstreamStateStore} from '../src/upstream-state.mjs';
function database(){const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../drizzle/0000_upstream_recovery.sql',import.meta.url),'utf8'));function prepare(q,args=[]){return {q,args,bind(...v){return prepare(q,v);},async first(){return sql.prepare(q).get(...args)??null;},async all(){return {results:sql.prepare(q).all(...args)};},async run(){return {meta:{changes:sql.prepare(q).run(...args).changes}};}};}return {sql,prepare,async batch(stmts){sql.exec('BEGIN');try{const r=stmts.map(s=>({meta:{changes:sql.prepare(s.q).run(...s.args).changes}}));sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};}
const url='https://operator.example.invalid',healthy=()=>Response.json({status:'ok'}),page=()=>Response.json({status:'ok',solution:{status:200,response:'<title>Fixture</title><p>Actual fixture response</p>'}});
test('target failure survives a new facade without suppressing another valid target',async()=>{
 const db=database(),config={url,token:'synthetic',stateDb:db,requireDurable:true};try{
  const fail=await trawlScrape('https://missing.invalid/',{},config,{fetchImpl:async p=>String(p).endsWith('/health')?healthy():Response.json({status:'error',message:'net::ERR_NAME_NOT_RESOLVED at https://missing.invalid/?secret=fixture'},{status:500})});
  assert.equal(fail.failure_evidence.message_class,'dns');assert.equal(fail.upstream_state.durability,'D1');assert.equal(fail.upstream_state.available,true);
  const store=new UpstreamStateStore(db,url);assert.equal((await store.read()).targetFailures,1);assert.equal((await store.incidents())[0].scope,'target');
  const success=await trawlScrape('https://example.com/',{},config,{fetchImpl:async p=>String(p).endsWith('/health')?healthy():page()});assert.equal(success.ok,true);assert.doesNotMatch(JSON.stringify(await store.incidents()),/secret|missing\.invalid|operator\.example/);
 }finally{db.sql.close();}
});
test('live-shaped Firefox unknown-host envelope is target-scoped only with exact request binding',async()=>{
 const db=database(),config={url,stateDb:db,requireDurable:true},target='https://firefox-fixture.invalid/';try{
  const envelope={status:'error',message:'page.goto: NS_ERROR_UNKNOWN_HOST',solution:{url:target,status:0,response:'',headers:{},cookies:[],userAgent:''}};
  const failed=await trawlScrape(target,{},config,{fetchImpl:async p=>String(p).endsWith('/health')?healthy():Response.json(envelope,{status:500})});
  assert.equal(failed.reason,'trawl_error:target_name_not_resolved');assert.equal(failed.failure_evidence.legacy_target_url_matches,true);assert.equal(failed.upstream_state.available,true);assert.equal(failed.upstream_state.targetFailures,1);
  assert.equal((await trawlScrape('https://example.com/',{},config,{fetchImpl:async p=>String(p).endsWith('/health')?healthy():page()})).ok,true);
 }finally{db.sql.close();}
});
for(const [code,bound] of [['NS_ERROR_UNKNOWN_PROXY_HOST',true],['NS_ERROR_UNKNOWN_HOST',false]])test(`Firefox ${code} bound=${bound} cannot be guessed as a target DNS fault`,async()=>{
 const db=database(),config={url,stateDb:db,requireDurable:true};try{
  const target='https://firefox-fixture.invalid/',envelope={status:'error',message:'page.goto: '+code,solution:{url:bound?target:'https://different.example.invalid/',status:0,response:''}};
  const r=await trawlScrape(target,{},config,{fetchImpl:async p=>String(p).endsWith('/health')?healthy():Response.json(envelope,{status:500})});assert.equal(r.upstream_state.available,false);assert.equal(r.upstream_state.targetFailures,0);
 }finally{db.sql.close();}
});
test('opaque upstream failure persists an honest unknown class and cross-instance cooldown',async()=>{
 const db=database(),config={url,stateDb:db,requireDurable:true};try{
  const fail=await trawlScrape('https://example.com/',{},config,{fetchImpl:async p=>String(p).endsWith('/health')?healthy():new Response('Internal Server Error',{status:500})});
  assert.equal(fail.failure_evidence.message_class,'unknown');const fresh=new UpstreamStateStore(db,url);assert.equal((await fresh.read()).available,false);let fetches=0;
  const held=await trawlScrape('https://example.org/',{},config,{fetchImpl:async()=>{fetches++;return page();},stateStore:fresh});assert.equal(held.ok,false);assert.equal(fetches,0);assert.equal((await fresh.incidents())[0].scope,'unknown');
 }finally{db.sql.close();}
});
test('missing required durable binding never reaches upstream transport',async()=>{
 let fetches=0;const out=await trawlScrape('https://example.com/',{},{url,requireDurable:true},{fetchImpl:async()=>{fetches++;return page();}});assert.equal(out.reason,'UPSTREAM_STATE_UNAVAILABLE');assert.equal(fetches,0);
});
test('persisted operator denial prevents automatic future health/target requests',async()=>{
 const db=database(),config={url,stateDb:db,requireDurable:true};try{
  await trawlScrape('https://example.com/',{},config,{fetchImpl:async p=>String(p).endsWith('/health')?healthy():new Response('',{status:401})});
  let fetches=0;const out=await trawlScrape('https://example.org/',{},config,{fetchImpl:async()=>{fetches++;return page();}});assert.equal(fetches,0);assert.match(out.reason,/operator_auth_latched/);
 }finally{db.sql.close();}
});
