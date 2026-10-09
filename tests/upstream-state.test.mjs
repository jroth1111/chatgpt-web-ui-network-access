import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {UpstreamStateStore} from '../src/upstream-state.mjs';
const endpoint='https://operator.example.invalid/base',target='https://public.example.invalid/a';
function database(){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../drizzle/0000_upstream_recovery.sql',import.meta.url),'utf8'));
 function prepare(query,args=[]){return {query,args,bind(...values){return prepare(query,values);},async first(){return sql.prepare(query).get(...args)??null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){return {meta:{changes:sql.prepare(query).run(...args).changes}};}};}
 return {sql,prepare,async batch(statements){sql.exec('BEGIN');try{const results=statements.map(s=>({meta:{changes:sql.prepare(s.query).run(...s.args).changes}}));sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
}
test('durable state survives a new store instance and time-based cooldown recovery',async()=>{
 const db=database();let now=100000;try{
  const a=new UpstreamStateStore(db,endpoint,{now:()=>now}),attempt=await a.begin();
  await a.failure(attempt,'trawl_http_503',{scope:'service',http_status:503,target});
  const b=new UpstreamStateStore(db,endpoint,{now:()=>now});const s=await b.read();assert.equal(s.available,false);assert.equal(s.failures,1);assert.equal(s.lifetimeFailures,1);assert(s.cooldownUntil>now);
  assert.equal((await b.claimProbe()).allowed,false);now+=60001;const lease=await b.claimProbe();assert.equal(lease.allowed,true);
  await b.healthy(lease.sequence,10);await b.releaseProbe(lease.token);assert.equal((await a.read()).available,true);assert.equal((await a.incidents())[0].occurrences,1);
 }finally{db.sql.close();}
});
test('cross-instance probe lease admits only one probe and is recoverable after owner crash',async()=>{
 const db=database();let now=1000;try{
  const a=new UpstreamStateStore(db,endpoint,{now:()=>now}),b=new UpstreamStateStore(db,endpoint,{now:()=>now});
  const [one,two]=await Promise.all([a.claimProbe(),b.claimProbe()]);assert.equal([one,two].filter(x=>x.allowed).length,1);
  now+=10001;assert.equal((await b.claimProbe()).allowed,true);
 }finally{db.sql.close();}
});
test('older success cannot erase a newer outage, and older failure cannot poison newer success',async()=>{
 const db=database();try{
  const a=new UpstreamStateStore(db,endpoint),old=await a.begin(),fresh=await a.begin();
  await a.failure(fresh,'trawl_http_503',{scope:'service',target});await a.healthy(old,10);assert.equal((await a.read()).available,false);
  const newer=await a.begin();await a.healthy(newer,10);await a.failure(old,'trawl_http_503',{scope:'service',target});assert.equal((await a.read()).available,true);
 }finally{db.sql.close();}
});
test('target failures remain durable but do not close endpoint availability',async()=>{
 const db=database();try{
  const a=new UpstreamStateStore(db,endpoint),n=await a.begin();await a.healthy(n,10);
  await a.failure(await a.begin(),'target_name_not_resolved',{scope:'target',http_status:500,target,evidence:{format:'json',target_host_mentioned:true,secret:'must never persist'}});
  const b=new UpstreamStateStore(db,endpoint);assert.equal((await b.read()).available,true);assert.equal((await b.read()).targetFailures,1);
  assert.doesNotMatch(JSON.stringify(await b.incidents()),/must never|operator\.example|public\.example/);
 }finally{db.sql.close();}
});
test('operator auth denial persists and is never cleared by automatic health success',async()=>{
 const db=database();try{
  const a=new UpstreamStateStore(db,endpoint);await a.failure(await a.begin(),'trawl_http_401',{scope:'auth',http_status:401,target});
  const b=new UpstreamStateStore(db,endpoint);assert.equal((await b.claimProbe()).reason,'operator_auth_latched');await b.healthy(await b.begin(),10);assert.equal((await b.read()).authLatched,true);
 }finally{db.sql.close();}
});
test('even a late operator denial latches until explicit authorized remediation',async()=>{
 const db=database();try{
  const a=new UpstreamStateStore(db,endpoint),old=await a.begin(),newer=await a.begin();await a.healthy(newer,10);
  await a.failure(old,'trawl_http_403',{scope:'auth',http_status:403,target});assert.equal((await a.read()).authLatched,true);assert.equal((await a.claimProbe()).allowed,false);
 }finally{db.sql.close();}
});
test('incident and cooldown commit together; failed journal write rolls back health mutation',async()=>{
 const db=database();try{
  const a=new UpstreamStateStore(db,endpoint),sequence=await a.begin();db.sql.exec("CREATE TRIGGER reject_fixture_incident BEFORE INSERT ON upstream_failures BEGIN SELECT RAISE(ABORT,'synthetic incident fault'); END");
  await assert.rejects(a.failure(sequence,'trawl_http_503',{scope:'service',target}),/UPSTREAM_STATE_UNAVAILABLE/);const state=await a.read();assert.equal(state.lifetimeFailures,0);assert.equal(state.available,null);
 }finally{db.sql.close();}
});
