import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
export async function computeBuildId(root=process.cwd()){
 const hash=createHash('sha256');
 for(const file of (await readdir(path.join(root,'src'))).sort()){hash.update(file);hash.update(await readFile(path.join(root,'src',file)));}
 for(const file of ['package.json','package-lock.json','build.mjs'])hash.update(await readFile(path.join(root,file)));
 for(const file of (await readdir(path.join(root,'drizzle'),{recursive:true})).filter(x=>/\.(?:sql|json)$/.test(x)).sort()){hash.update(file);hash.update(await readFile(path.join(root,'drizzle',file)));}
 hash.update(await readFile(path.join(root,'.openai/hosting.json')));
 // Build/verifier changes are release inputs too, not invisible provenance.
 let scripts=[];try{scripts=await readdir(path.join(root,'scripts'));}catch(error){if(error.code!=='ENOENT')throw error;}
 for(const file of scripts.filter(x=>/\.(?:mjs|js)$/.test(x)).sort()){hash.update('scripts/'+file);hash.update(await readFile(path.join(root,'scripts',file)));}
 return hash.digest('hex');
}
