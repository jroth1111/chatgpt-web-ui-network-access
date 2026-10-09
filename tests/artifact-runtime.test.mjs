import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {checkArtifact} from '../scripts/check-artifact-runtime.mjs';
import {computeBuildId} from '../scripts/build-input.mjs';
async function fixture({version='99.1.0',wrongBuild=false}={}){
 const project=await mkdtemp(path.join(tmpdir(),'network-artifact-regression-')),artifact=path.join(project,'dist');
 for(const dir of ['src','drizzle','.openai','dist/server'])await mkdir(path.join(project,dir),{recursive:true});
 await writeFile(path.join(project,'package.json'),JSON.stringify({version:'99.1.0'}));await writeFile(path.join(project,'package-lock.json'),'{}');await writeFile(path.join(project,'build.mjs'),'// fixture build');await writeFile(path.join(project,'.openai/hosting.json'),'{}');await writeFile(path.join(project,'src/config.mjs'),"export const SOFTWARE_VERSION='99.1.0';\n");
 const wasm=Buffer.from([0,97,115,109,1,0,0,0]);await writeFile(path.join(project,'src/quickjs.wasm'),wasm);await writeFile(path.join(artifact,'server/quickjs.wasm'),wasm);
 const build=wrongBuild?'f'.repeat(64):await computeBuildId(project);
 await writeFile(path.join(artifact,'server/index.js'),`const identity={software_version:${JSON.stringify(version)},build_id:${JSON.stringify(build)}};export default {async fetch(request){const rpc=await request.json();let result,error;if(rpc.method==='initialize')result={serverInfo:{version:identity.software_version}};else if(rpc.method==='tools/list')result={tools:Array.from({length:16},()=>({name:'fixture'}))};else if(rpc.params.name==='browser_capabilities')result={structuredContent:{provenance:identity}};else error={code:-32602,message:'Fixture invalid URI'};return Response.json({jsonrpc:'2.0',id:rpc.id,...(error?{error}:{result})},{headers:{'x-runtime-lab-build':identity.build_id}});}};`);
 return {project,artifact,dispose:()=>rm(project,{recursive:true,force:true})};
}
test('network artifact rejects a stale compiled version despite current source metadata',async()=>{const f=await fixture({version:'99.0.0'});try{await assert.rejects(checkArtifact({...f,write:true}),/stale\/wrong version/);}finally{await f.dispose();}});
test('network artifact rejects a stale build fingerprint',async()=>{const f=await fixture({wrongBuild:true});try{await assert.rejects(checkArtifact({...f,write:true}),/stale build/);}finally{await f.dispose();}});
test('network artifact requires and then verifies its exact manifest',async()=>{const f=await fixture();try{await assert.rejects(checkArtifact(f),/Missing\/invalid/);const first=await checkArtifact({...f,write:true});assert.equal((await checkArtifact(f)).artifact_sha256,first.artifact_sha256);}finally{await f.dispose();}});
test('network artifact rejects changed packaged bytes',async()=>{const f=await fixture();try{await checkArtifact({...f,write:true});const file=path.join(f.artifact,'server/index.js');await writeFile(file,(await readFile(file,'utf8'))+'\n// changed bytes');await assert.rejects(checkArtifact(f),/Artifact manifest/);}finally{await f.dispose();}});
test('network artifact rejects a substituted WASM payload',async()=>{const f=await fixture();try{await writeFile(path.join(f.artifact,'server/quickjs.wasm'),Buffer.from([0,97,115,109,1,0,0,0,0]));await assert.rejects(checkArtifact({...f,write:true}),/WASM differs/);}finally{await f.dispose();}});
test('network artifact rejects a symlinked manifest without overwriting its target',async()=>{const f=await fixture();try{await mkdir(path.join(f.artifact,'.openai'));const target=path.join(f.project,'retained.json');await writeFile(target,'retained');await symlink(target,path.join(f.artifact,'.openai/artifact-manifest.json'));await assert.rejects(checkArtifact({...f,write:true}),/symlink/);assert.equal(await readFile(target,'utf8'),'retained');}finally{await f.dispose();}});
test('network artifact rejects a symlinked artifact root',async()=>{const f=await fixture();try{const link=path.join(f.project,'linked-dist');await symlink(f.artifact,link);await assert.rejects(checkArtifact({...f,artifact:link,write:true}),/root symlink/);}finally{await f.dispose();}});
