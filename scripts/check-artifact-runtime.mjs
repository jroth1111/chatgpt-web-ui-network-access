import {Miniflare} from 'miniflare';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {computeBuildId} from './build-input.mjs';
import {contained,inventory,sourceDigest,finalizeManifest} from './artifact-support.mjs';

export async function checkArtifact({project=process.cwd(),artifact=path.join(project,'dist'),write=false}={}){
 project=path.resolve(project);artifact=path.resolve(artifact);
 // Reject escaping links before reading or executing any packaged code.
 await inventory(artifact);
 const version=JSON.parse(await readFile(path.join(project,'package.json'),'utf8')).version;
 const sourceVersion=(await readFile(path.join(project,'src/config.mjs'),'utf8')).match(/SOFTWARE_VERSION\s*=\s*['"]([^'"]+)/)?.[1];assert.equal(sourceVersion,version,'Source/package versions differ');
 const main=contained(artifact,path.join(artifact,'server/index.js')),wasm=contained(artifact,path.join(artifact,'server/quickjs.wasm'));
 assert((await readFile(wasm)).equals(await readFile(path.join(project,'src/quickjs.wasm'))),'Packaged WASM differs from source');
 const buildId=await computeBuildId(project);let outbound=0;
 const mf=new Miniflare({cf:false,modulesRoot:path.join(artifact,'server'),modules:[{type:'ESModule',path:main,contents:await readFile(main,'utf8')},{type:'CompiledWasm',path:wasm,contents:await readFile(wasm)}],compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],bindings:{OWNER_EMAIL:'artifact-owner@example.invalid',ORIGIN:'https://artifact.example',PROJECT_ID:'artifact-fixture'},outboundService:()=>{outbound++;throw Error('Artifact checks must not contact external targets');}});
 try{
  const call=async(method,params)=>{const r=await mf.dispatchFetch('https://artifact.example/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','oai-authenticated-user-id':'artifact-fixture','oai-authenticated-user-email':'artifact-owner@example.invalid'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.equal(r.status,200);assert.equal(r.headers.get('x-runtime-lab-build'),buildId,'Compiled error/success response header has a stale build');return await r.json();};
  const init=await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'artifact-fixture',version:'1'}});assert(init?.result?.serverInfo,'Packaged initialization failed');
  const tools=await call('tools/list',{});assert.equal(tools?.result?.tools?.length,16,'Packaged tool inventory differs');
  const cap=(await call('tools/call',{name:'browser_capabilities',arguments:{}})).result,identity=cap?.structuredContent?.provenance??cap?.structuredContent;
  assert.equal(identity?.software_version,version,'Packaged Worker runs a stale/wrong version');assert.equal(identity.build_id,buildId,'Packaged Worker source/build fingerprint is stale');
  const denied=await call('tools/call',{name:'browser_open_fetch',arguments:{url:'not-a-url'}});
  assert.equal(denied?.error?.code,-32602,'Invalid URI must remain a schema error');assert.equal(outbound,0,'Artifact checks made an external request');
 }finally{await mf.dispose();}
 return finalizeManifest(project,artifact,{software_version:version,entrypoint:'server/index.js',build_id:buildId,source_sha256:await sourceDigest(project,['src','scripts','drizzle','.openai/hosting.json','package.json','package-lock.json','build.mjs']),runtime_checks:['compiled_initialize','compiled_sixteen_tool_inventory','compiled_version_and_build_id','compiled_invalid_url_error','zero_external_acquisition']},{write});
}
if(path.resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await checkArtifact({write:process.argv.includes('--write-manifest')})));}catch(error){console.error('Artifact runtime check failed:',error.message);process.exitCode=1;}
}
