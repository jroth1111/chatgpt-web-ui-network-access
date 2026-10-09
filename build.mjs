import {build} from 'esbuild';
import {mkdir,rm,copyFile,readFile,cp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {computeBuildId} from './scripts/build-input.mjs';
import {checkArtifact} from './scripts/check-artifact-runtime.mjs';
const buildId=await computeBuildId();
let sourceCommit='';
try{
 const dirty=execFileSync('git',['status','--porcelain','--','src','scripts','package.json','package-lock.json','build.mjs','drizzle','.openai/hosting.json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
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
await cp('drizzle','dist/.openai/drizzle',{recursive:true});
console.log('built dist/server/index.js');
console.log(JSON.stringify(await checkArtifact({write:true})));
