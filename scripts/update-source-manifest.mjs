// Mechanical release inventory regeneration; no runtime/env values or Git history.
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(await readFile('SOURCE-MANIFEST.json','utf8'));
manifest.software_version=JSON.parse(await readFile('package.json','utf8')).version;
manifest.snapshot_utc=new Date().toISOString();manifest.files={};
for(const name of (await readdir('src')).sort()){const file='src/'+name,data=await readFile(file);manifest.files[file]={bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};}
await writeFile('SOURCE-MANIFEST.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({source_manifest:'updated',version:manifest.software_version,files:Object.keys(manifest.files).length}));
