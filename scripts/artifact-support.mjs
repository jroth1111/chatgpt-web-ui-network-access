import {readdir,readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

export const MANIFEST='.openai/artifact-manifest.json';
export const sha256=data=>createHash('sha256').update(data).digest('hex');
const compare=(a,b)=>a<b?-1:a>b?1:0;
export function contained(root,file){
 const relative=path.relative(path.resolve(root),path.resolve(file));
 if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Artifact path escapes its declared root');
 return path.resolve(file);
}
export async function inventory(root,exclude=[]){
 root=path.resolve(root);
 const rootStat=await lstat(root);
 if(rootStat.isSymbolicLink())throw Error('Artifact/source root symlink is not self-contained');
 if(!rootStat.isDirectory())throw Error('Artifact/source root must be a directory');
 const files={};
 async function walk(directory){
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>compare(a.name,b.name))){
   const file=contained(root,path.join(directory,entry.name)),name=path.relative(root,file).split(path.sep).join('/');
   if((await lstat(file)).isSymbolicLink())throw Error('Artifact/source symlink is not self-contained: '+name);
   if(exclude.includes(name))continue;
   if(entry.isDirectory())await walk(file);
   else if(entry.isFile()){const data=await readFile(file);files[name]={bytes:data.length,sha256:sha256(data)};}
   else throw Error('Unsupported artifact/source entry: '+name);
  }
 }
 await walk(root);return Object.fromEntries(Object.entries(files).sort(([a],[b])=>compare(a,b)));
}
export async function sourceDigest(root,inputs){
 const files={};
 for(const input of inputs){
  const file=contained(root,path.resolve(root,input));let stat;
  try{stat=await lstat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(stat.isSymbolicLink())throw Error('Release input symlink is not supported: '+input);
  if(stat.isDirectory()){for(const [name,value] of Object.entries(await inventory(file)))files[input+'/'+name]=value;}
  else{const data=await readFile(file);files[input]={bytes:data.length,sha256:sha256(data)};}
 }
 return sha256(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a],[b])=>compare(a,b)))));
}
// The supported Sites packager reserializes generated hosting JSON this way.
// Finalize those bytes BEFORE hashing; verification itself never normalizes.
export async function normalizeHosting(artifact){
 artifact=path.resolve(artifact);await inventory(artifact);
 const file=contained(artifact,path.join(artifact,'.openai/hosting.json'));
 const before=await readFile(file,'utf8'),hosting=JSON.parse(before);
 assert(hosting&&typeof hosting==='object'&&!Array.isArray(hosting),'Hosting manifest must be an object');
 const after=JSON.stringify(hosting,null,2)+'\n';
 if(after!==before)await writeFile(file,after);
 return {hosting_serialization:'finalized',changed:after!==before};
}
export async function finalizeManifest(project,artifact,metadata,{write=false}={}){
 const files=await inventory(artifact,[MANIFEST]),expected={schema:1,...metadata,artifact_sha256:sha256(JSON.stringify(files)),files};
 const file=contained(artifact,path.join(artifact,MANIFEST));
 if(write){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(expected,null,2)+'\n');}
 else{let stored;try{stored=JSON.parse(await readFile(file,'utf8'));}catch(error){throw Error('Missing/invalid verified artifact manifest; run the build before packaging',{cause:error});}assert.deepEqual(stored,expected,'Artifact manifest, source inputs or packaged bytes changed');}
 return {artifact_runtime:'verified',software_version:metadata.software_version,entrypoint:metadata.entrypoint,files:Object.keys(files).length,artifact_sha256:expected.artifact_sha256,proof:'isolated packaged Worker; not hosted delivery'};
}
