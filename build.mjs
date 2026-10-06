import {build} from 'esbuild';
import {mkdir,rm,copyFile,writeFile,readFile} from 'node:fs/promises';
const buildId=process.env.BUILD_ID??'dev-build';
await rm('dist',{recursive:true,force:true});
await mkdir('dist/server',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
let config=await readFile('src/config.mjs','utf8');
config=config
  .replaceAll('__BUILD_ID__',buildId)
  .replace("export const OWNER_EMAIL=globalThis.OWNER_EMAIL??'owner@example.com';","export const OWNER_EMAIL=globalThis.OWNER_EMAIL??'owner@example.com';")
  ;
await build({
  entryPoints:['src/worker.mjs'],bundle:true,platform:'browser',preserveSymlinks:true,
  conditions:['workerd'],format:'esm',external:['./quickjs.wasm'],loader:{'.txt':'text'},
  plugins:[{name:'config',setup(b){b.onLoad({filter:/\/config\.mjs$/},()=>({contents:config,loader:'js'}));}}],
  outfile:'dist/server/index.js',logLevel:'warning'
});
await copyFile('src/quickjs.wasm','dist/server/quickjs.wasm');
await writeFile('dist/.openai/hosting.json',JSON.stringify({project_id:'ASSIGNED_BY_SITES',d1:null,r2:null,capabilities:['mcp']},null,2));
console.log('built dist/server/index.js');
