import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const manifest=JSON.parse(await readFile('SOURCE-MANIFEST.json','utf8'));
const version=JSON.parse(await readFile('package.json','utf8')).version;
if(manifest.software_version!==version)throw Error('Source manifest software version mismatch');
const files=(await readdir('src')).sort().map(file=>'src/'+file);
if(JSON.stringify(Object.keys(manifest.files).sort())!==JSON.stringify(files))throw Error('Source manifest inventory mismatch');
for(const file of files){const data=await readFile(file),entry=manifest.files[file];if(entry.bytes!==data.byteLength||entry.sha256!==createHash('sha256').update(data).digest('hex'))throw Error('Source manifest mismatch: '+file);}
console.log(JSON.stringify({source_manifest:'verified',version,files:files.length}));
