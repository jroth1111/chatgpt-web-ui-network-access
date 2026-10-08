import {build} from 'esbuild';
import {mkdir,rm,copyFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
const hash=createHash('sha256');
for(const file of (await readdir('src')).sort()){hash.update(file);hash.update(await readFile('src/'+file));}
for(const file of ['package.json','package-lock.json','build.mjs'])hash.update(await readFile(file));
const buildId=hash.digest('hex');
let sourceCommit='';
try{
 const dirty=execFileSync('git',['status','--porcelain','--','src','package.json','package-lock.json','build.mjs'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 if(!dirty&&/^[a-f0-9]{40}$/.test(head))sourceCommit=head;
}catch{}
await rm('dist',{recursive:true,force:true});
await mkdir('dist/server',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
let config=await readFile('src/config.mjs','utf8');
config=config.replaceAll('__BUILD_ID__',buildId).replace("export const SOURCE_COMMIT=globalThis.SOURCE_COMMIT??'';",`export const SOURCE_COMMIT=${JSON.stringify(sourceCommit)};`);
await build({
  entryPoints:['src/worker.mjs'],bundle:true,platform:'browser',preserveSymlinks:true,
  conditions:['workerd'],format:'esm',external:['./quickjs.wasm','cloudflare:sockets'],loader:{'.txt':'text'},
  plugins:[{name:'config',setup(b){b.onLoad({filter:/\/config\.mjs$/},()=>({contents:config,loader:'js'}));}}],
  outfile:'dist/server/index.js',logLevel:'warning'
});
await copyFile('src/quickjs.wasm','dist/server/quickjs.wasm');
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
console.log('built dist/server/index.js');
